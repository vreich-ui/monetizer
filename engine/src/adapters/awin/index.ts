import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { recordObservation } from '../types.ts'
import { csvInboxAdapter } from '../csv-inbox/index.ts'
import { syncAwinFeeds } from './feeds.ts'
import type { NormalizedStatus } from '../../domain/types.ts'

/**
 * Awin (absorbed ShareASale, Oct 2025 — docs/plan/03).
 *
 * Credentials: { api_token, publisher_id }.
 * - Reporting: Publisher API transactions endpoint, `clickref` echoed → click
 *   fidelity. Windows are capped at 31 days per request; we page by window.
 * - Links: standard cread.php deeplink. Offers arrive via datafeed CSV drops
 *   (the CSV inbox implementation is reused); give drops a link template like
 *     https://www.awin1.com/cread.php?awinmid=<MID>&awinaffid=<AFFID>&clickref={click_id}&ued={url_enc}
 *   `awinDeeplinkTemplate()` builds it.
 * - Catalog API: Awin product feeds are per-advertiser CSV subscriptions, not
 *   a query API — feed ingest stays the CSV path by design, not as a stopgap.
 */

const BASE = 'https://api.awin.com'

async function awinGet(ctx: AdapterContext, source: SourceRow, path: string): Promise<any> {
  const creds = await ctx.broker.get(source.id)
  if (!creds?.api_token) throw new Error(`awin: no credentials for source ${source.id}`)
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.api_token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`awin ${path}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`)
  return res.json()
}

export function awinNormStatus(status: string): NormalizedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'approved':
      return 'approved'
    case 'declined':
    case 'deleted':
      return 'reversed'
    case 'paid':
      return 'paid'
    default:
      return 'pending'
  }
}

export function awinDeeplinkTemplate(advertiserMid: string | number, affiliateId: string | number): string {
  return `https://www.awin1.com/cread.php?awinmid=${advertiserMid}&awinaffid=${affiliateId}&clickref={click_id}&ued={url_enc}`
}

export const awinAdapter: NetworkAdapter = {
  network: 'awin',
  kind: 'affiliate_network',
  displayName: 'Awin',

  capabilities(): Capabilities {
    return {
      catalog: { feed: true }, // datafeed CSVs via the inbox
      links: { build: true, subid: 'click', deeplink: true },
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
      const accounts = await awinGet(ctx, source, '/accounts?type=publisher')
      const n = accounts?.accounts?.length ?? 0
      const creds = await ctx.broker.get(source.id)
      const feeds = creds?.feed_api_key
        ? 'product feeds enabled'
        : 'add feed_api_key to auto-import product catalog'
      return { ok: n > 0, detail: `authenticated; ${n} publisher account(s); ${feeds}` }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async pollReports(ctx, source, sinceDays) {
    const creds = await ctx.broker.get(source.id)
    const publisherId = creds?.publisher_id
    if (!publisherId) throw new Error('awin: publisher_id missing from credentials')

    let observations = 0
    const end = new Date()
    let windowStart = new Date(end.getTime() - sinceDays * 86_400_000)
    const fmt = (d: Date) => d.toISOString().slice(0, 19)

    while (windowStart < end) {
      const windowEnd = new Date(Math.min(windowStart.getTime() + 30 * 86_400_000, end.getTime()))
      const txns = await awinGet(
        ctx,
        source,
        `/publishers/${publisherId}/transactions/?startDate=${encodeURIComponent(fmt(windowStart))}` +
          `&endDate=${encodeURIComponent(fmt(windowEnd))}&timezone=UTC`,
      )
      for (const t of Array.isArray(txns) ? txns : []) {
        await recordObservation(ctx.db, {
          source_id: source.id,
          network_txn_id: String(t.id),
          network_click_time: t.clickDate ?? null,
          network_txn_time: String(t.transactionDate ?? new Date().toISOString()),
          subid_echo: t.clickRefs?.clickRef ? String(t.clickRefs.clickRef) : null,
          tracking_key: t.clickRefs?.clickRef2 ? String(t.clickRefs.clickRef2) : null,
          program_ref: t.advertiserId != null ? String(t.advertiserId) : null,
          order_amount: t.saleAmount?.amount != null ? Number(t.saleAmount.amount) : null,
          commission_amount: Number(t.commissionAmount?.amount ?? 0),
          currency: String(t.commissionAmount?.currency ?? 'USD'),
          network_status: String(t.commissionStatus ?? 'pending'),
          status_norm: awinNormStatus(String(t.commissionStatus ?? '')),
          raw: t,
        })
        observations++
      }
      windowStart = windowEnd
    }
    return { observations }
  },

  // Automated product-feed catalog import (no human CSV handling) — needs a
  // feed_api_key credential. Falls back to a no-op (with a health note) when
  // that key is absent, so it's safe to schedule unconditionally.
  async syncCatalog(ctx, source) {
    const res = await syncAwinFeeds(ctx, source)
    return { upserted: res.upserted }
  },

  // Manual CSV drops remain available as a fallback.
  ingestCsv: csvInboxAdapter.ingestCsv,
}
