import type { Db } from '../db/client.ts'
import { newId } from '../ids.ts'

export type EventType =
  | 'pageview'
  | 'impression'
  | 'viewable'
  | 'click'
  | 'checkout_started'
  | 'redirect_failover'
  | 'redirect_failed'
  | 'system'

export interface EventInput {
  type: EventType
  occurred_at?: Date
  tenant_id?: string | null
  surface_id?: string | null
  decision_id?: string | null
  offer_id?: string | null
  source_id?: string | null
  visitor_hash?: string | null
  click_id?: string | null
  ivt_score?: number | null
  ivt_reasons?: string[] | null
  payload?: Record<string, unknown>
}

export const EVENT_SCHEMA_VERSION = 1

export async function appendEvent(db: Db, e: EventInput): Promise<string> {
  const id = newId()
  await db.query(
    `insert into events (id, schema_version, type, occurred_at, tenant_id, surface_id,
       decision_id, offer_id, source_id, visitor_hash, click_id, ivt_score, ivt_reasons, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      EVENT_SCHEMA_VERSION,
      e.type,
      e.occurred_at ?? new Date(),
      e.tenant_id ?? null,
      e.surface_id ?? null,
      e.decision_id ?? null,
      e.offer_id ?? null,
      e.source_id ?? null,
      e.visitor_hash ?? null,
      e.click_id ?? null,
      e.ivt_score ?? null,
      e.ivt_reasons ?? null,
      JSON.stringify(e.payload ?? {}),
    ],
  )
  return id
}
