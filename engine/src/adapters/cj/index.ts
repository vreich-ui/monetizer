import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { recordObservation } from '../types.ts'
import { csvInboxAdapter } from '../csv-inbox/index.ts'
import type { NormalizedStatus } from '../../domain/types.ts'

/**
 * CJ (Commission Junction) — docs/plan/03.
 *
 * Credentials: { personal_access_token, company_id } (publisher CID).
 * - Reporting: Commissions GraphQL API; `sid` echoed → click fidelity.
 *   Correction records arrive as additional rows on the same commissionId
 *   with adjusted amounts — the observation model absorbs them natively.
 * - Links: cread-style deeplinks; offers via feed CSV drops (Product Feed
 *   GraphQL API is a later enrichment; the CSV path covers catalog now).
 */

const COMMISSIONS_URL = 'https://commissions.api.cj.com/query'

async function cjQuery(ctx: AdapterContext, source: SourceRow, query: string): Promise<any> {
  const creds = await ctx.broker.get(source.id)
  if (!creds?.personal_access_token) throw new Error(`cj: no credentials for source ${source.id}`)
  const res = await fetch(COMMISSIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.personal_access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`cj: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`)
  const data = await res.json()
  if (data.errors?.length) throw new Error(`cj: ${JSON.stringify(data.errors).slice(0, 300)}`)
  return data.data
}

export function cjNormStatus(status: string): NormalizedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'locked':
      return 'approved'
    case 'closed':
      return 'paid'
    case 'corrected':
      return 'adjusted'
    default:
      return 'pending' // 'new' and unknowns
  }
}

export const cjAdapter: NetworkAdapter = {
  network: 'cj',
  kind: 'affiliate_network',
  displayName: 'CJ Affiliate',

  capabilities(): Capabilities {
    return {
      catalog: { feed: true },
      links: { build: true, subid: 'click', deeplink: true },
      reporting: {
        transactions: 'api',
        itemized: true,
        lag_days_estimate: 1,
        mutation_window_days: 60,
      },
    }
  },

  async verify(ctx, source) {
    try {
      const creds = await ctx.broker.get(source.id)
      const cid = creds?.company_id
      if (!cid) return { ok: false, detail: 'company_id missing from credentials' }
      const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      const before = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
      await cjQuery(
        ctx,
        source,
        `{ publisherCommissions(forPublishers: ["${cid}"], sincePostingDate: "${since}T00:00:00Z", beforePostingDate: "${before}T00:00:00Z") { count } }`,
      )
      return { ok: true, detail: 'authenticated' }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async pollReports(ctx, source, sinceDays) {
    const creds = await ctx.broker.get(source.id)
    const cid = creds?.company_id
    if (!cid) throw new Error('cj: company_id missing from credentials')

    let observations = 0
    const end = new Date()
    let windowStart = new Date(end.getTime() - sinceDays * 86_400_000)

    while (windowStart < end) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + 30 * 86_400_000, end.getTime()))
      const data = await cjQuery(
        ctx,
        source,
        `{ publisherCommissions(forPublishers: ["${cid}"],
             sincePostingDate: "${windowStart.toISOString()}",
             beforePostingDate: "${windowEnd.toISOString()}") {
           records {
             commissionId orderId actionStatus actionType postingDate eventDate
             pubCommissionAmountUsd saleAmountUsd advertiserId advertiserName
             shopperId sid clickDate
           } } }`,
      )
      for (const r of data?.publisherCommissions?.records ?? []) {
        await recordObservation(ctx.db, {
          source_id: source.id,
          network_txn_id: String(r.commissionId ?? r.orderId),
          network_click_time: r.clickDate ?? null,
          network_txn_time: String(r.eventDate ?? r.postingDate ?? new Date().toISOString()),
          subid_echo: r.sid ? String(r.sid) : null,
          program_ref: r.advertiserId != null ? String(r.advertiserId) : null,
          order_amount: r.saleAmountUsd != null ? Number(r.saleAmountUsd) : null,
          commission_amount: Number(r.pubCommissionAmountUsd ?? 0),
          currency: 'USD',
          network_status: String(r.actionStatus ?? 'new'),
          status_norm: cjNormStatus(String(r.actionStatus ?? '')),
          raw: r,
        })
        observations++
      }
      windowStart = windowEnd
    }
    return { observations }
  },

  ingestCsv: csvInboxAdapter.ingestCsv,
}
