import type { AdapterContext, Capabilities, CsvDrop, NetworkAdapter, SourceRow } from '../types.ts'
import { parseCsv, recordObservation } from '../types.ts'
import { upsertOffer } from '../../core/offers.ts'
import type { NormalizedStatus, OfferKind } from '../../domain/types.ts'

/**
 * CSV inbox — the adapter for no-API sources (docs/plan/03 §Direct merchant
 * programs): direct programs, Awin datafeeds before the API adapter lands,
 * Amazon earnings reports, anything that arrives as a file.
 *
 * `mapping` on the drop maps our field names to CSV column names, plus
 * optional `_defaults` (JSON) for constant fields, e.g.:
 *   offers drop:       { title: "Product Name", url: "Deep Link", price: "Price", ... }
 *   transactions drop: { network_txn_id: "Order ID", commission_amount: "Commission", ... }
 */

const col = (row: Record<string, string>, mapping: Record<string, string>, field: string): string | undefined => {
  const c = mapping[field]
  return c ? row[c]?.trim() || undefined : undefined
}

export const csvInboxAdapter: NetworkAdapter = {
  network: 'csv',
  kind: 'csv_inbox',
  displayName: 'CSV inbox',

  capabilities(): Capabilities {
    return {
      catalog: { feed: true },
      links: { build: true, subid: 'none' },
      reporting: { transactions: 'csv', itemized: false, lag_days_estimate: 30, mutation_window_days: 90 },
    }
  },

  async verify() {
    return { ok: true, detail: 'csv inbox requires no credentials' }
  },

  async ingestCsv(ctx: AdapterContext, source: SourceRow, drop: CsvDrop) {
    const rows = parseCsv(drop.content)
    const mapping = drop.mapping ?? {}
    const defaults = safeJson(mapping['_defaults'])
    let processed = 0

    if (drop.drop_kind === 'offers') {
      for (const row of rows) {
        const title = col(row, mapping, 'title')
        const url = col(row, mapping, 'url')
        if (!title || !url) continue
        const priceStr = col(row, mapping, 'price')
        const merchantName = col(row, mapping, 'merchant') ?? (defaults['merchant'] as string) ?? source.display_name
        const linkTemplate = col(row, mapping, 'link_template') ?? (defaults['link_template'] as string) ?? url
        await upsertOffer(ctx.db, {
          source_id: source.id,
          network_offer_id: col(row, mapping, 'id') ?? url,
          kind: ((defaults['kind'] as OfferKind) ?? 'affiliate_product'),
          merchant: { name: merchantName, slug: slugify(merchantName) },
          title,
          brand: col(row, mapping, 'brand') ?? null,
          description: col(row, mapping, 'description')?.slice(0, 2000) ?? null,
          image_url: col(row, mapping, 'image_url') ?? null,
          taxonomy: {
            category_path: col(row, mapping, 'category') ? [col(row, mapping, 'category')!] : [],
            keywords: (col(row, mapping, 'keywords') ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean),
          },
          economics: {
            type: 'commission_pct',
            rate: Number(col(row, mapping, 'commission_rate') ?? defaults['commission_rate'] ?? 0.05),
            currency: col(row, mapping, 'currency') ?? (defaults['currency'] as string) ?? 'USD',
            cookie_window_days: Number(defaults['cookie_window_days'] ?? 30),
          },
          price: priceStr
            ? { amount: Number(priceStr.replace(/[^0-9.]/g, '')), currency: col(row, mapping, 'currency') ?? 'USD', as_of: new Date().toISOString() }
            : null,
          constraints: (defaults['constraints'] as any) ?? {},
          tracking: {
            link_template: linkTemplate,
            subid_fidelity: linkTemplate.includes('{click_id}') ? 'click' : linkTemplate.includes('{tenant_ns}') ? 'property' : 'none',
            destination_url: url,
          },
        })
        processed++
      }
    } else {
      for (const row of rows) {
        const txnId = col(row, mapping, 'network_txn_id')
        const commission = col(row, mapping, 'commission_amount')
        if (!txnId || commission == null) continue
        await recordObservation(ctx.db, {
          source_id: source.id,
          network_txn_id: txnId,
          network_txn_time: parseDate(col(row, mapping, 'txn_time')) ?? new Date().toISOString(),
          subid_echo: col(row, mapping, 'subid'),
          tracking_key: col(row, mapping, 'tracking_key'),
          program_ref: col(row, mapping, 'program_ref'),
          order_amount: numOrNull(col(row, mapping, 'order_amount')),
          commission_amount: Number(commission.replace(/[^0-9.-]/g, '')),
          currency: col(row, mapping, 'currency') ?? (defaults['currency'] as string) ?? 'USD',
          network_status: col(row, mapping, 'status') ?? 'unknown',
          status_norm: normStatus(col(row, mapping, 'status')),
          raw: row,
        })
        processed++
      }
    }
    return { processed }
  },
}

function safeJson(s: string | undefined): Record<string, unknown> {
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function numOrNull(s: string | undefined): number | null {
  if (s == null || s === '') return null
  const n = Number(s.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function parseDate(s: string | undefined): string | null {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function normStatus(s: string | undefined): NormalizedStatus {
  const v = (s ?? '').toLowerCase()
  if (/(approved|locked|confirmed|payable)/.test(v)) return 'approved'
  if (/(reversed|declined|rejected|cancel)/.test(v)) return 'reversed'
  if (/paid/.test(v)) return 'paid'
  return 'pending'
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'merchant'
}
