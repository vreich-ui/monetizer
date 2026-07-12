import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import type { ConversionObservationInput, SubidFidelity, Fidelity } from '../domain/types.ts'

export interface SourceRow {
  id: string
  network: string
  kind: string
  display_name: string
  tenant_scope: string | null
  capabilities: Capabilities
  attribution_fidelity: Fidelity
  status: string
  health: Record<string, unknown>
}

/**
 * Capability declarations (docs/plan/03): the core plans around what an
 * adapter DECLARES, never around a uniform interface. Absent key = absent
 * capability.
 */
export interface Capabilities {
  catalog?: { search?: boolean; feed?: boolean }
  links?: { build: boolean; subid: SubidFidelity; deeplink?: boolean }
  reporting?: {
    transactions?: 'api' | 'webhook' | 'csv'
    clicks?: boolean
    itemized?: boolean
    lag_days_estimate?: number
    mutation_window_days?: number
  }
  compliance?: Record<string, unknown>
}

export interface AdapterContext {
  db: Db
  broker: CredentialBroker
}

export interface CsvDrop {
  id: string
  source_id: string
  drop_kind: 'offers' | 'transactions'
  content: string
  mapping: Record<string, string>
}

export interface NetworkAdapter {
  readonly network: string
  readonly kind: 'affiliate_network' | 'payment_provider' | 'donation_platform' | 'csv_inbox'
  readonly displayName: string
  capabilities(): Capabilities
  /** Cheap authenticated probe run at credential registration. */
  verify(ctx: AdapterContext, source: SourceRow): Promise<{ ok: boolean; detail: string }>
  /** Pull offers into the store (catalog.search / catalog.feed). */
  syncCatalog?(ctx: AdapterContext, source: SourceRow): Promise<{ upserted: number }>
  /** Poll network transaction reports into conversion_observations. */
  pollReports?(ctx: AdapterContext, source: SourceRow, sinceDays: number): Promise<{ observations: number }>
  /** Handle an inbound webhook (returns observations recorded). */
  handleWebhook?(
    ctx: AdapterContext,
    source: SourceRow,
    req: { headers: Record<string, string | undefined>; rawBody: string },
  ): Promise<{ observations: number }>
  /** Ingest a CSV drop (offers or transactions) for feed/no-API sources. */
  ingestCsv?(ctx: AdapterContext, source: SourceRow, drop: CsvDrop): Promise<{ processed: number }>
}

/** Fill a tracking link template at click time (docs/plan/02, 03). */
export function fillLinkTemplate(
  template: string,
  vars: { click_id?: string; tenant_ns?: string; url_enc?: string },
): string {
  return template
    .replaceAll('{click_id}', encodeURIComponent(vars.click_id ?? ''))
    .replaceAll('{tenant_ns}', encodeURIComponent(vars.tenant_ns ?? ''))
    .replaceAll('{url_enc}', vars.url_enc ?? '')
}

export async function recordObservation(db: Db, obs: ConversionObservationInput): Promise<void> {
  const { newId } = await import('../ids.ts')
  await db.query(
    `insert into conversion_observations (id, source_id, network_txn_id, network_click_time,
       network_txn_time, subid_echo, tracking_key, program_ref, items, order_amount,
       commission_amount, currency, network_status, status_norm, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      newId(),
      obs.source_id,
      obs.network_txn_id,
      obs.network_click_time ?? null,
      obs.network_txn_time,
      obs.subid_echo ?? null,
      obs.tracking_key ?? null,
      obs.program_ref ?? null,
      obs.items ? JSON.stringify(obs.items) : null,
      obs.order_amount ?? null,
      obs.commission_amount,
      obs.currency,
      obs.network_status,
      obs.status_norm,
      JSON.stringify(obs.raw ?? {}),
    ],
  )
}

/** Minimal CSV parser (quoted fields, commas, newlines). Header row required. */
export function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = '',
    row: string[] = [],
    inQuotes = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!
    if (inQuotes) {
      if (c === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.some((f) => f !== '')) rows.push(row)
  }
  const header = rows.shift() ?? []
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])))
}
