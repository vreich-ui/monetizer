import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { recordObservation } from '../types.ts'
import type { NormalizedStatus } from '../../domain/types.ts'

/**
 * Strackr — the reporting aggregator (docs/plan/03, 06): one API for
 * transactions across ~280 networks, replacing N direct report pollers.
 *
 * Credentials: { api_id, api_key }.
 *
 * Two deliberate behaviors:
 * 1. Transactions are re-homed to the DIRECT source when one exists for the
 *    same network (e.g. an `awin` source) so attribution can match that
 *    source's clicks; otherwise they land on the strackr source itself.
 *    Direct pollers + Strackr can coexist: observations dedupe through the
 *    derived-conversions layer by (source, txn), so prefer ONE of the two per
 *    network to avoid split txn identities (docs/plan/04 caveat applies).
 * 2. Field mapping is defensive: Strackr normalizes ~280 networks and shapes
 *    drift; everything lands in `raw` so a mapping fix can re-derive.
 */

const BASE = 'https://api.strackr.com/v3'

async function strackrGet(
  ctx: AdapterContext,
  source: SourceRow,
  path: string,
  params: Record<string, string> = {},
): Promise<any> {
  const creds = await ctx.broker.get(source.id)
  if (!creds?.api_id || !creds?.api_key) throw new Error(`strackr: no credentials for source ${source.id}`)
  const url = new URL(`${BASE}${path}`)
  url.searchParams.set('api_id', String(creds.api_id))
  url.searchParams.set('api_key', String(creds.api_key))
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`strackr ${path}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`)
  return res.json()
}

export function strackrNormStatus(status: string): NormalizedStatus {
  const v = (status ?? '').toLowerCase()
  if (/(confirm|approv|valid)/.test(v)) return 'approved'
  if (/(declin|refus|cancel|revers)/.test(v)) return 'reversed'
  if (/paid/.test(v)) return 'paid'
  return 'pending'
}

/** Best-effort extraction across Strackr response shape variants. */
export function strackrExtractRows(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.results)) {
    // results may be flat rows or grouped {transactions: [...]}
    return data.results.flatMap((r: any) => (Array.isArray(r?.transactions) ? r.transactions : [r]))
  }
  if (Array.isArray(data?.transactions)) return data.transactions
  return []
}

export const strackrAdapter: NetworkAdapter = {
  network: 'strackr',
  kind: 'affiliate_network',
  displayName: 'Strackr (reporting aggregator)',

  capabilities(): Capabilities {
    return {
      reporting: {
        transactions: 'api',
        itemized: true,
        lag_days_estimate: 1,
        mutation_window_days: 90,
      },
    }
  },

  async verify(ctx, source) {
    try {
      const data = await strackrGet(ctx, source, '/connections')
      const n = Array.isArray(data?.results) ? data.results.length : Array.isArray(data) ? data.length : 0
      return { ok: true, detail: `authenticated; ${n} network connection(s)` }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async pollReports(ctx, source, sinceDays) {
    const start = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
    const end = new Date().toISOString().slice(0, 10)
    const data = await strackrGet(ctx, source, '/transactions', {
      time_start: start,
      time_end: end,
      time_type: 'transaction',
    })

    // Map network slugs to our direct sources so attribution can see their clicks.
    const { rows: sources } = await ctx.db.query<{ id: string; network: string }>(
      `select id, network from sources where tenant_scope is null`,
    )
    const sourceByNetwork = new Map(sources.map((s) => [s.network, s.id]))

    let observations = 0
    for (const t of strackrExtractRows(data)) {
      const networkSlug = String(t.connection?.network_slug ?? t.network?.slug ?? t.network_name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
      const homeSourceId =
        sourceByNetwork.get(networkSlug) ??
        [...sourceByNetwork.entries()].find(([n]) => networkSlug && n.replace(/[^a-z0-9]+/g, '') === networkSlug)?.[1] ??
        source.id
      const subid = t.custom ?? t.custom1 ?? t.subid ?? t.sub_id ?? (Array.isArray(t.customs) ? t.customs[0] : null)
      await recordObservation(ctx.db, {
        source_id: homeSourceId,
        network_txn_id: String(t.id ?? t.transaction_id ?? `${networkSlug}:${t.order_id ?? Math.random()}`),
        network_click_time: t.click_date ?? t.time_click ?? null,
        network_txn_time: String(t.transaction_date ?? t.time_transaction ?? t.date ?? new Date().toISOString()),
        subid_echo: subid ? String(subid) : null,
        program_ref: t.advertiser?.id != null ? String(t.advertiser.id) : (t.advertiser_name ?? null),
        order_amount: numOrNull(t.price ?? t.order_amount ?? t.sale_amount),
        commission_amount: numOrNull(t.revenue ?? t.commission ?? t.commission_amount) ?? 0,
        currency: String(t.currency ?? 'USD').toUpperCase(),
        network_status: String(t.status ?? t.state ?? 'pending'),
        status_norm: strackrNormStatus(String(t.status ?? t.state ?? '')),
        raw: t,
      })
      observations++
    }
    return { observations }
  },
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
