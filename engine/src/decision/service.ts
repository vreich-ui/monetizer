import type { SurfaceDeclaration } from '@monetizer/context-taxonomy'
import type { Db } from '../db/client.ts'
import type { Decision, Offer, Tenant } from '../domain/types.ts'
import { newId } from '../ids.ts'
import { findCandidates, getOffer } from '../core/offers.ts'
import { upsertSurface } from '../core/surfaces.ts'
import { surfaceTerms } from './relevance.ts'
import type { DecisionPolicy } from './policy.ts'

export interface ResolvedOfferPayload {
  rank: number
  offer_id: string
  title: string
  brand?: string | null
  image_url?: string | null
  price?: { amount: number; currency: string; as_of: string } | null
  cta_text: string
  href: string
  merchant: string
  disclosure?: string
}

export interface ResolvedSurface {
  surface_id: string
  decision_id: string
  offers: ResolvedOfferPayload[]
  ttl_s: number
}

export const DEFAULT_PAGE_DISCLOSURE =
  'Some links on this page are affiliate links: if you buy through them we may earn a commission at no extra cost to you.'

const CTA_BY_KIND: Record<string, string> = {
  affiliate_product: 'Check price',
  affiliate_program_cta: 'Learn more',
  digital_product: 'Get it now',
  donation: 'Support us',
}

export function redirectHref(base: string, merchantSlug: string, decisionId: string, rank: number): string {
  // Merchant slug in the path keeps the redirect transparent (Amazon ToS,
  // docs/plan/02): a reader can see where the click goes before clicking.
  return `${base}/r/${encodeURIComponent(merchantSlug)}/${decisionId}/${rank}`
}

async function offerPayload(
  db: Db,
  redirectBase: string,
  decisionId: string,
  rank: number,
  offer: Offer,
): Promise<ResolvedOfferPayload> {
  return {
    rank,
    offer_id: offer.id,
    title: offer.title,
    brand: offer.brand,
    image_url: offer.image_url,
    price: offer.price ?? null,
    cta_text: CTA_BY_KIND[offer.kind] ?? 'View offer',
    href: redirectHref(redirectBase, offer.merchant.slug, decisionId, rank),
    merchant: offer.merchant.name,
    disclosure: offer.constraints.tos?.disclosure_text,
  }
}

export async function resolveSurfaceDecl(
  db: Db,
  opts: {
    tenant: Tenant
    decl: SurfaceDeclaration
    buildId?: string
    policy: DecisionPolicy
    redirectBase: string
  },
): Promise<ResolvedSurface> {
  const { tenant, decl, buildId, policy, redirectBase } = opts
  const surface = await upsertSurface(db, tenant.id, decl)

  // Idempotency: same (surface, build) returns the existing decision.
  if (buildId) {
    const { rows } = await db.query<Decision>(
      `select * from decisions where surface_id = $1 and build_id = $2`,
      [surface.id, buildId],
    )
    const existing = rows[0]
    if (existing) return decisionToResolved(db, existing, redirectBase)
  }

  const candidates = await findCandidates(db, {
    terms: surfaceTerms(surface.context),
    geo: surface.context.audience_geo?.[0],
    limit: 50,
  })

  const selection = policy.select({
    surfaceId: surface.id,
    slotType: surface.slot_type,
    context: surface.context,
    offers: candidates,
    seed: buildId ? `${surface.id}:${buildId}` : undefined,
  })

  const decisionId = newId()
  await db.tx(async (q) => {
    await q.query(
      `update decisions set status = 'superseded' where surface_id = $1 and status = 'live'`,
      [surface.id],
    )
    await q.query(
      `insert into decisions (id, surface_id, tenant_id, build_id, policy, candidates, chosen,
         propensity, explore, seed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        decisionId,
        surface.id,
        tenant.id,
        buildId ?? null,
        JSON.stringify({ name: policy.name, version: policy.version, params_hash: policy.paramsHash }),
        JSON.stringify(selection.candidates),
        JSON.stringify(selection.chosen),
        selection.propensity,
        selection.explore,
        selection.seed,
      ],
    )
  })

  // Nothing cleared the floor → demand signal for the content side (00 §3).
  if (selection.chosen.length === 0) {
    await db.query(
      `insert into demand_signals (category, entities, reason, evidence)
       values ($1,$2,$3,$4)`,
      [
        surface.context.topic,
        surface.context.entities ?? [],
        'no_offer_cleared_floor',
        JSON.stringify({ surface_id: surface.id, candidate_count: candidates.length }),
      ],
    )
  }

  const offers: ResolvedOfferPayload[] = []
  for (const ch of selection.chosen) {
    const offer = await getOffer(db, ch.offer_id)
    if (offer) offers.push(await offerPayload(db, redirectBase, decisionId, ch.rank, offer))
  }
  return { surface_id: surface.id, decision_id: decisionId, offers, ttl_s: 7 * 86400 }
}

async function decisionToResolved(db: Db, decision: Decision, redirectBase: string): Promise<ResolvedSurface> {
  const offers: ResolvedOfferPayload[] = []
  for (const ch of decision.chosen) {
    const offer = await getOffer(db, ch.offer_id)
    if (offer) offers.push(await offerPayload(db, redirectBase, decision.id, ch.rank, offer))
  }
  return { surface_id: decision.surface_id, decision_id: decision.id, offers, ttl_s: 7 * 86400 }
}

export async function explainDecision(db: Db, decisionId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query<Decision>(`select * from decisions where id = $1`, [decisionId])
  const d = rows[0]
  if (!d) return null
  const enriched = []
  for (const c of d.candidates) {
    const o = await getOffer(db, c.offer_id)
    enriched.push({ ...c, title: o?.title, merchant: o?.merchant?.name, lifecycle: o?.lifecycle })
  }
  return { ...d, candidates: enriched }
}
