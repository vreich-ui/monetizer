import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { csvInboxAdapter } from '../csv-inbox/index.ts'

/**
 * Amazon — tag-link mode (docs/plan/05 §2, deferred by decision).
 *
 * What works TODAY without any API:
 *  - Offers ingested by CSV drop (drop_kind='offers'); link templates built as
 *    `https://www.amazon.com/dp/ASIN?tag={tenant_ns}` — the tenant's Amazon
 *    tracking ID is injected at click time, giving property-level fidelity.
 *  - Earnings reports ingested by CSV drop (drop_kind='transactions') with
 *    tracking_key = the tracking ID column, which the attribution resolver
 *    maps back to tenants.
 *
 * What is deliberately NOT wired (Creators API, sales-gated as of 2026):
 *  - syncCatalog via Creators API (OAuth2 client credentials). Wiring point:
 *    implement `syncCatalog` here; credentials {client_id, client_secret}
 *    are already representable in the broker; quota must be treated as a
 *    managed budget (cache into offer_snapshots; never per-build lookups).
 *  - Reporting API pulls. Until then: earnings CSV drops.
 *
 * ToS constraints are data (constraints.tos): offers ingested for Amazon
 * should carry { redirect_transparency_required: true, max_price_age_h: 24,
 * disclosure_text: <Associates wording> } — enforced by the resolve payload
 * and the Astro kit, not by code that knows about Amazon.
 */
export const amazonAdapter: NetworkAdapter = {
  network: 'amazon',
  kind: 'affiliate_network',
  displayName: 'Amazon Associates (tag-link mode)',

  capabilities(): Capabilities {
    return {
      catalog: { feed: true }, // via CSV drops until Creators API is unlocked
      links: { build: true, subid: 'property' }, // tracking-ID granularity, never click
      reporting: { transactions: 'csv', itemized: true, lag_days_estimate: 2, mutation_window_days: 90 },
      compliance: {
        redirect_transparency_required: true,
        max_price_age_h: 24,
        disclosure_text:
          'As an Amazon Associate we earn from qualifying purchases.',
      },
    }
  },

  async verify(_ctx: AdapterContext, _source: SourceRow) {
    return {
      ok: true,
      detail:
        'tag-link mode: no API credentials required. Set each tenant tracking_namespaces.amazon ' +
        'to its Amazon tracking ID (e.g. "mysite-20"). Creators API wiring is a deliberate TODO.',
    }
  },

  // CSV drops reuse the generic inbox implementation.
  ingestCsv: csvInboxAdapter.ingestCsv,
}
