import type { Db } from '../db/client.ts'
import type { Offer } from '../domain/types.ts'
import { newId } from '../ids.ts'

export type OfferUpsert = Omit<Offer, 'id' | 'lifecycle'> & { lifecycle?: Offer['lifecycle'] }

/** Adapter-facing ingestion: upsert by (source_id, network_offer_id). */
export async function upsertOffer(db: Db, o: OfferUpsert): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into offers (id, source_id, network_offer_id, program_id, kind, merchant, title,
        brand, description, image_url, taxonomy, economics, price, constraints, tracking, lifecycle)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (source_id, network_offer_id) do update set
        program_id = excluded.program_id,
        kind = excluded.kind,
        merchant = excluded.merchant,
        title = excluded.title,
        brand = excluded.brand,
        description = excluded.description,
        image_url = excluded.image_url,
        taxonomy = excluded.taxonomy,
        economics = excluded.economics,
        price = excluded.price,
        constraints = excluded.constraints,
        tracking = excluded.tracking,
        lifecycle = excluded.lifecycle,
        updated_at = now()
     returning id`,
    [
      newId(),
      o.source_id,
      o.network_offer_id,
      o.program_id ?? null,
      o.kind,
      JSON.stringify(o.merchant),
      o.title,
      o.brand ?? null,
      o.description ?? null,
      o.image_url ?? null,
      JSON.stringify(o.taxonomy ?? {}),
      JSON.stringify(o.economics),
      o.price ? JSON.stringify(o.price) : null,
      JSON.stringify(o.constraints ?? {}),
      JSON.stringify(o.tracking),
      o.lifecycle ?? 'active',
    ],
  )
  const id = rows[0]!.id
  if (o.price) {
    await db.query(
      `insert into offer_snapshots (offer_id, price, availability) values ($1,$2,$3)`,
      [id, JSON.stringify(o.price), 'in_stock'],
    )
  }
  return id
}

export async function getOffer(db: Db, id: string): Promise<Offer | null> {
  const { rows } = await db.query<Offer>(`select * from offers where id = $1`, [id])
  return rows[0] ?? null
}

export async function setLifecycle(
  db: Db,
  offerId: string,
  lifecycle: Offer['lifecycle'],
  reason?: string,
): Promise<void> {
  await db.query(
    `update offers set lifecycle = $2,
       lifecycle_meta = lifecycle_meta || jsonb_build_object('reason', $3::text, 'at', now()::text),
       updated_at = now()
     where id = $1`,
    [offerId, lifecycle, reason ?? null],
  )
}

/**
 * Candidate retrieval for decisioning: active offers, geo-eligible, ranked by
 * lexical match against the surface context. Deliberately recall-oriented —
 * precision is the policy's job (docs/plan/01).
 */
export async function findCandidates(
  db: Db,
  opts: { terms: string[]; geo?: string; limit?: number },
): Promise<Offer[]> {
  const q = opts.terms
    .map((t) => t.replace(/[^\p{L}\p{N} ]/gu, '').trim())
    .filter(Boolean)
    .flatMap((t) => t.split(/\s+/))
    .join(' | ')
  const { rows } = await db.query<Offer>(
    `select o.* from offers o
      where o.lifecycle = 'active'
        and ($2::text is null
             or o.constraints->'geo' is null
             or o.constraints->'geo' @> to_jsonb($2::text))
        and ($1 = '' or o.search_text @@ to_tsquery('english', $1))
      order by case when $1 = '' then 0 else ts_rank(o.search_text, to_tsquery('english', $1)) end desc
      limit $3`,
    [q, opts.geo ?? null, opts.limit ?? 50],
  )
  return rows
}

/** Search across offers (MCP surface). */
export async function searchOffers(db: Db, text: string, limit = 20): Promise<Offer[]> {
  return findCandidates(db, { terms: [text], limit })
}
