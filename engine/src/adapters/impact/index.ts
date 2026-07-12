import type {
  AdapterContext,
  Capabilities,
  NetworkAdapter,
  SourceRow,
} from '../types.ts'
import { recordObservation } from '../types.ts'
import { upsertOffer } from '../../core/offers.ts'
import type { NormalizedStatus } from '../../domain/types.ts'

/**
 * Impact (impact.com) — the reference adapter (docs/plan/03): full REST API,
 * per-click SubId1 echo, itemized actions reporting.
 *
 * Credentials: { account_sid, auth_token } (Basic auth).
 * Endpoints are the Mediapartners (publisher) API, JSON representation.
 */

const BASE = 'https://api.impact.com'

async function impactGet(
  ctx: AdapterContext,
  source: SourceRow,
  path: string,
  params: Record<string, string> = {},
): Promise<any> {
  const creds = await ctx.broker.get(source.id)
  if (!creds?.account_sid || !creds?.auth_token) throw new Error(`impact: no credentials for source ${source.id}`)
  const url = new URL(`${BASE}/Mediapartners/${creds.account_sid}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.account_sid}:${creds.auth_token}`).toString('base64')}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`impact ${path}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`)
  return res.json()
}

function normStatus(state: string): NormalizedStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED':
    case 'LOCKED':
      return 'approved'
    case 'REVERSED':
      return 'reversed'
    case 'PAID':
      return 'paid'
    default:
      return 'pending'
  }
}

export const impactAdapter: NetworkAdapter = {
  network: 'impact',
  kind: 'affiliate_network',
  displayName: 'Impact',

  capabilities(): Capabilities {
    return {
      catalog: { search: true, feed: false },
      links: { build: true, subid: 'click', deeplink: true },
      reporting: {
        transactions: 'api',
        clicks: true,
        itemized: true,
        lag_days_estimate: 1,
        mutation_window_days: 60,
      },
    }
  },

  async verify(ctx, source) {
    try {
      const data = await impactGet(ctx, source, '/Campaigns', { PageSize: '1' })
      const n = data?.['@total'] ?? data?.Campaigns?.length ?? 0
      return { ok: true, detail: `authenticated; ${n} campaign(s) visible` }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async syncCatalog(ctx, source) {
    let upserted = 0
    const catalogs = await impactGet(ctx, source, '/Catalogs', { PageSize: '100' })
    for (const cat of catalogs?.Catalogs ?? []) {
      let page = 1
      for (;;) {
        const items = await impactGet(ctx, source, `/Catalogs/${cat.Id}/Items`, {
          PageSize: '100',
          Page: String(page),
        })
        const list = items?.Items ?? []
        for (const it of list) {
          const trackingUrl: string | undefined = it.Url // catalog item tracking URL
          if (!trackingUrl || !it.Name) continue
          const sep = trackingUrl.includes('?') ? '&' : '?'
          await upsertOffer(ctx.db, {
            source_id: source.id,
            network_offer_id: String(it.CatalogItemId ?? it.Id ?? `${cat.Id}:${it.Name}`),
            kind: 'affiliate_product',
            merchant: {
              name: String(it.CampaignName ?? cat.CampaignName ?? 'merchant'),
              slug: slugify(String(it.CampaignName ?? cat.CampaignName ?? 'merchant')),
              program_id: String(it.CampaignId ?? cat.CampaignId ?? ''),
            },
            title: String(it.Name),
            brand: it.Manufacturer ? String(it.Manufacturer) : null,
            description: it.Description ? String(it.Description).slice(0, 2000) : null,
            image_url: it.ImageUrl ? String(it.ImageUrl) : null,
            taxonomy: {
              category_path: it.Category ? [String(it.Category)] : [],
              keywords: it.Labels ? String(it.Labels).split(',').map((s: string) => s.trim()) : [],
            },
            economics: {
              type: 'commission_pct',
              // Real rate comes from campaign terms; conservative default until
              // campaign-terms sync enriches it.
              rate: 0.05,
              currency: String(it.Currency ?? 'USD'),
              cookie_window_days: 30,
            },
            price:
              it.CurrentPrice != null
                ? { amount: Number(it.CurrentPrice), currency: String(it.Currency ?? 'USD'), as_of: new Date().toISOString() }
                : null,
            constraints: {},
            tracking: {
              link_template: `${trackingUrl}${sep}subId1={click_id}&subId2={tenant_ns}`,
              subid_fidelity: 'click',
              destination_url: it.TargetUrl ? String(it.TargetUrl) : undefined,
            },
          })
          upserted++
        }
        if (!items?.['@nextpageuri'] || list.length === 0) break
        page++
      }
    }
    return { upserted }
  },

  async pollReports(ctx, source, sinceDays) {
    const start = new Date(Date.now() - sinceDays * 86_400_000)
    let observations = 0
    let page = 1
    for (;;) {
      const data = await impactGet(ctx, source, '/Actions', {
        StartDate: start.toISOString(),
        PageSize: '100',
        Page: String(page),
      })
      const actions = data?.Actions ?? []
      for (const a of actions) {
        await recordObservation(ctx.db, {
          source_id: source.id,
          network_txn_id: String(a.Id),
          network_click_time: a.ReferringDate ?? null,
          network_txn_time: String(a.EventDate ?? a.CreationDate ?? new Date().toISOString()),
          subid_echo: a.SubId1 ? String(a.SubId1) : null,
          tracking_key: a.SubId2 ? String(a.SubId2) : null,
          program_ref: a.CampaignId ? String(a.CampaignId) : null,
          order_amount: a.Amount != null ? Number(a.Amount) : null,
          commission_amount: Number(a.Payout ?? 0),
          currency: String(a.Currency ?? 'USD'),
          network_status: String(a.State ?? 'PENDING'),
          status_norm: normStatus(String(a.State ?? '')),
          raw: a,
        })
        observations++
      }
      if (!data?.['@nextpageuri'] || actions.length === 0) break
      page++
    }
    return { observations }
  },
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'merchant'
}
