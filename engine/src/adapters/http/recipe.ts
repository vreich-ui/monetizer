import type { Db } from '../../db/client.ts'
import type { CredentialBroker } from '../../core/credentials.ts'
import type { Recipe, ConnectionConfig } from './config.ts'
import type { NormalizedStatus, OfferKind } from '../../domain/types.ts'
import { recordObservation } from '../types.ts'
import { upsertOffer } from '../../core/offers.ts'
import { applyAuth, fillTemplate, getPath, httpCall, type FetchImpl } from './client.ts'

/**
 * Deterministic collection recipe runner. Agents author a recipe once (using
 * AI, iterating with test_request); the engine executes it on a schedule with
 * NO AI in the loop — the whole point of lowering monitoring cost.
 */

export interface RunResult {
  records: number
  pages: number
}

function runVars(recipe: Recipe): Record<string, string> {
  const since = new Date(Date.now() - recipe.since_days * 86_400_000)
  return {
    since_iso: since.toISOString(),
    since_date: since.toISOString().slice(0, 10),
    now_iso: new Date().toISOString(),
    now_date: new Date().toISOString().slice(0, 10),
  }
}

function mapRecord(record: any, map: Record<string, string>, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults }
  for (const [ourField, spec] of Object.entries(map)) {
    out[ourField] = spec.startsWith('=') ? spec.slice(1) : getPath(record, spec)
  }
  return out
}

function normStatus(s: unknown): NormalizedStatus {
  const v = String(s ?? '').toLowerCase()
  if (/(approv|lock|confirm|valid|payable|closed)/.test(v)) return 'approved'
  if (/(revers|declin|reject|cancel|delete|refund)/.test(v)) return 'reversed'
  if (/paid/.test(v)) return 'paid'
  if (/(correct|adjust)/.test(v)) return 'adjusted'
  return 'pending'
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

async function writeTransaction(db: Db, sourceId: string, m: Record<string, unknown>): Promise<boolean> {
  const txnId = m.network_txn_id
  if (txnId == null || m.commission_amount == null) return false
  await recordObservation(db, {
    source_id: sourceId,
    network_txn_id: String(txnId),
    network_click_time: m.click_time ? String(m.click_time) : null,
    network_txn_time: m.txn_time ? String(m.txn_time) : new Date().toISOString(),
    subid_echo: m.subid != null ? String(m.subid) : null,
    tracking_key: m.tracking_key != null ? String(m.tracking_key) : null,
    program_ref: m.program_ref != null ? String(m.program_ref) : null,
    order_amount: num(m.order_amount),
    commission_amount: num(m.commission_amount) ?? 0,
    currency: String(m.currency ?? 'USD'),
    network_status: String(m.status ?? 'unknown'),
    status_norm: normStatus(m.status),
    raw: m.__raw ?? m,
  })
  return true
}

async function writeOffer(db: Db, sourceId: string, m: Record<string, unknown>): Promise<boolean> {
  const title = m.title
  const url = m.url ?? m.destination_url
  if (!title || !url) return false
  const linkTemplate = String(m.link_template ?? url)
  await upsertOffer(db, {
    source_id: sourceId,
    network_offer_id: String(m.id ?? url),
    kind: (String(m.kind ?? 'affiliate_product') as OfferKind),
    merchant: { name: String(m.merchant ?? 'merchant'), slug: slugify(String(m.merchant ?? 'merchant')) },
    title: String(title),
    brand: m.brand != null ? String(m.brand) : null,
    description: m.description != null ? String(m.description).slice(0, 2000) : null,
    image_url: m.image_url != null ? String(m.image_url) : null,
    taxonomy: {
      category_path: m.category ? [String(m.category)] : [],
      keywords: m.keywords ? String(m.keywords).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [],
    },
    economics: {
      type: 'commission_pct',
      rate: num(m.commission_rate) ?? 0.05,
      currency: String(m.currency ?? 'USD'),
      cookie_window_days: 30,
    },
    price: num(m.price) != null ? { amount: num(m.price)!, currency: String(m.currency ?? 'USD'), as_of: new Date().toISOString() } : null,
    constraints: {},
    tracking: {
      link_template: linkTemplate,
      subid_fidelity: linkTemplate.includes('{click_id}') ? 'click' : linkTemplate.includes('{tenant_ns}') ? 'property' : 'none',
      destination_url: String(url),
    },
  })
  return true
}

export async function runRecipe(
  ctx: { db: Db; broker: CredentialBroker; fetchImpl?: FetchImpl },
  source: { id: string; config: ConnectionConfig },
  recipe: Recipe,
): Promise<RunResult> {
  const { db, broker } = ctx
  const config = source.config
  if (!config.base_url) throw new Error('connection has no base_url')
  const secrets = ((await broker.get(source.id)) ?? {}) as Record<string, string>
  const vars = runVars(recipe)

  let page = 1
  let offset = 0
  let cursor = ''
  let records = 0
  let pages = 0
  const maxPages = recipe.paginate?.max_pages ?? 1

  for (; pages < maxPages; pages++) {
    const pageVars = { ...vars, page: String(page), offset: String(offset), cursor }
    const url = new URL(config.base_url.replace(/\/$/, '') + '/' + fillTemplate(recipe.path, pageVars).replace(/^\//, ''))
    for (const [k, v] of Object.entries(recipe.query ?? {})) url.searchParams.set(k, fillTemplate(v, pageVars))
    // pagination params
    const pg = recipe.paginate
    if (pg?.type === 'page' && pg.param) url.searchParams.set(pg.param, String(page))
    if (pg?.type === 'offset' && pg.param) url.searchParams.set(pg.param, String(offset))
    if (pg?.type === 'cursor' && pg.param && cursor) url.searchParams.set(pg.param, cursor)
    if (pg?.size_param) url.searchParams.set(pg.size_param, String(pg.size))

    const headers: Record<string, string> = { accept: 'application/json', ...config.headers, ...(recipe.headers ?? {}) }
    await applyAuth(db, source.id, config.auth, secrets, { url, headers }, ctx.fetchImpl)

    const body = recipe.method === 'POST' && recipe.body != null ? JSON.stringify(recipe.body) : undefined
    if (body) headers['content-type'] = headers['content-type'] ?? 'application/json'

    const res = await httpCall(url, { method: recipe.method, headers, body, fetchImpl: ctx.fetchImpl })
    if (res.status >= 400) throw new Error(`${recipe.name}: HTTP ${res.status} ${res.text.slice(0, 200)}`)

    const arr = getPath(res.json, recipe.records_path)
    const list: any[] = Array.isArray(arr) ? arr : []
    for (const rec of list) {
      const m = mapRecord(rec, recipe.map, recipe.defaults)
      const ok =
        recipe.sink === 'transactions'
          ? await writeTransaction(db, source.id, m)
          : recipe.sink === 'offers'
            ? await writeOffer(db, source.id, m)
            : false
      if (ok) records++
    }

    // advance pagination
    if (!pg || list.length === 0) break
    if (pg.type === 'page') page++
    else if (pg.type === 'offset') offset += pg.size
    else if (pg.type === 'cursor' || pg.type === 'link') {
      const next = pg.next_path ? getPath(res.json, pg.next_path) : undefined
      if (!next) break
      cursor = String(next)
    }
    if (list.length < pg.size && pg.type !== 'cursor' && pg.type !== 'link') break
  }

  return { records, pages: pages + 1 }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'merchant'
}
