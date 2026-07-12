import { Hono } from 'hono'
import type { Db } from '../db/client.ts'
import type { Decision, Offer, Tenant } from '../domain/types.ts'
import { appendEvent } from '../core/events.ts'
import { newId, sha256hex } from '../ids.ts'
import { fillLinkTemplate } from '../adapters/types.ts'

/**
 * The click path (docs/plan/02, 04): the engine's permanent runtime control
 * point. Must stay dependency-light and fast — one decision lookup, an async
 * click write, a 302. Single hop, merchant slug visible in the path.
 */

const BOT_UA = /bot|crawler|spider|headless|python-requests|curl\/|wget\/|scrapy|phantomjs/i

export function ivtSignals(ua: string | undefined): { score: number; reasons: string[] } {
  const reasons: string[] = []
  if (!ua) reasons.push('no_ua')
  else if (BOT_UA.test(ua)) reasons.push('bot_ua')
  return { score: reasons.length ? 1 : 0, reasons }
}

export function visitorHash(salt: string, ip: string, ua: string): string {
  const day = new Date().toISOString().slice(0, 10)
  return sha256hex(`vh|${salt}|${day}|${ip}|${ua}`).slice(0, 32)
}

interface RedirectDeps {
  db: Db
  hashSalt: string
}

async function pickLiveOffer(
  db: Db,
  decision: Decision,
  requestedRank: number,
): Promise<{ offer: Offer; failover: boolean } | null> {
  // Preference order: requested rank, remaining chosen by rank, then
  // candidates by score. First live offer wins.
  const chosenSorted = [...decision.chosen].sort(
    (a, b) => (a.rank === requestedRank ? -1 : b.rank === requestedRank ? 1 : a.rank - b.rank),
  )
  const orderedIds = [
    ...chosenSorted.map((c) => c.offer_id),
    ...decision.candidates.map((c) => c.offer_id),
  ]
  const seen = new Set<string>()
  let first = true
  for (const id of orderedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const { rows } = await db.query<Offer>(`select * from offers where id = $1`, [id])
    const offer = rows[0]
    if (offer && offer.lifecycle === 'active') {
      return { offer, failover: !first || offer.id !== chosenSorted[0]?.offer_id }
    }
    first = false
  }
  return null
}

export function redirectRoutes(deps: RedirectDeps): Hono {
  const app = new Hono()

  app.get('/r/:merchant/:decisionId/:rank?', async (c) => {
    const { db } = deps
    const decisionId = c.req.param('decisionId')
    const rank = Number(c.req.param('rank') ?? '1') || 1
    const ua = c.req.header('user-agent')
    const referer = c.req.header('referer')
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0'

    const { rows } = await db.query<Decision>(`select * from decisions where id = $1`, [decisionId])
    const decision = rows[0]
    if (!decision) {
      void appendEvent(db, { type: 'redirect_failed', payload: { decision_id: decisionId, reason: 'unknown_decision' } })
        .catch(() => {})
      return c.text('unknown link', 404)
    }

    const picked = await pickLiveOffer(db, decision, rank)
    const { rows: trows } = await db.query<Tenant>(`select * from tenants where id = $1`, [decision.tenant_id])
    const tenant = trows[0]

    if (!picked || !tenant) {
      void appendEvent(db, {
        type: 'redirect_failed',
        tenant_id: decision.tenant_id,
        decision_id: decision.id,
        surface_id: decision.surface_id,
        payload: { reason: picked ? 'no_tenant' : 'no_live_offer' },
      }).catch(() => {})
      // Degrade to something useful rather than a dead end.
      const fallback = tenant?.domains?.[0] ? `https://${tenant.domains[0]}` : '/'
      return c.redirect(fallback, 302)
    }

    const { offer, failover } = picked
    const clickId = newId()
    const ivt = ivtSignals(ua)

    const { rows: srows } = await db.query<{ network: string }>(
      `select network from sources where id = $1`,
      [offer.source_id],
    )
    const network = srows[0]?.network ?? ''
    const nsKey = network.split(':')[0]!
    const tenantNs = tenant.tracking_namespaces?.[nsKey] ?? tenant.slug

    // Async click write — the 302 never waits on the database.
    void appendEvent(db, {
      type: 'click',
      tenant_id: tenant.id,
      surface_id: decision.surface_id,
      decision_id: decision.id,
      offer_id: offer.id,
      source_id: offer.source_id,
      click_id: clickId,
      visitor_hash: visitorHash(deps.hashSalt, ip, ua ?? ''),
      ivt_score: ivt.score,
      ivt_reasons: ivt.reasons.length ? ivt.reasons : null,
      payload: { referer, ua_class: ua?.slice(0, 200), rank, failover },
    }).catch((err) => console.error('click log failed', err))

    if (failover) {
      void appendEvent(db, {
        type: 'redirect_failover',
        tenant_id: tenant.id,
        decision_id: decision.id,
        offer_id: offer.id,
        payload: { requested_rank: rank },
      }).catch(() => {})
    }

    const url = fillLinkTemplate(offer.tracking.link_template, {
      click_id: clickId,
      tenant_ns: tenantNs,
      url_enc: offer.tracking.destination_url ? encodeURIComponent(offer.tracking.destination_url) : undefined,
    })
    return c.redirect(url, 302)
  })

  return app
}
