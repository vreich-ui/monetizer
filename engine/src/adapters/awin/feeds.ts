import { gunzipSync } from 'node:zlib'
import type { AdapterContext, SourceRow } from '../types.ts'
import { parseCsv } from '../types.ts'
import { upsertOffer } from '../../core/offers.ts'

/**
 * Automated Awin product-feed ingestion — no human CSV handling.
 * Discovers every advertiser feed the publisher can access (feed-list API),
 * downloads each (gzipped CSV), parses, maps and upserts offers. Runs on the
 * catalog schedule. Requires a `feed_api_key` in the connection secrets (the
 * Awin "data-feed API key" — distinct from the Publisher API token).
 *
 * URL formats (productdata.awin.com):
 *   list:     /datafeed/list/apikey/{key}
 *   download: /datafeed/download/apikey/{key}/language/{lang}/fid/{fid}/columns/{cols}/format/csv/delimiter/,/compression/gzip/
 */

const HOST = 'https://productdata.awin.com'
const COLUMNS = [
  'aw_deep_link', 'product_name', 'aw_product_id', 'merchant_product_id', 'merchant_name',
  'merchant_category', 'category_name', 'search_price', 'store_price', 'currency',
  'aw_image_url', 'merchant_image_url', 'description', 'brand_name', 'commission_group',
]

// Bounds: catalogs can be millions of SKUs; we only need matchable inventory.
const MAX_FEEDS = 25
const MAX_DECOMPRESSED_CHARS = 40 * 1024 * 1024
const MAX_OFFERS_PER_FEED = 1000

export interface AwinFeed {
  fid: string
  advertiser: string
  status: string
  products: number
  language: string
}

/** Case-insensitive column lookup: exact match first, then substring. */
function col(row: Record<string, string>, ...names: string[]): string | undefined {
  const entries = Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v] as const)
  for (const n of names) {
    const hit = entries.find(([k]) => k === n)
    if (hit && hit[1] !== '') return hit[1]
  }
  for (const n of names) {
    const hit = entries.find(([k]) => k.includes(n))
    if (hit && hit[1] !== '') return hit[1]
  }
  return undefined
}

export function parseFeedList(csv: string): AwinFeed[] {
  return parseCsv(csv)
    .map((r) => ({
      fid: String(col(r, 'feed id', 'advertiser feed id', 'feedid') ?? '').trim(),
      advertiser: String(col(r, 'advertiser name', 'advertiser') ?? '').trim(),
      status: String(col(r, 'membership status', 'status') ?? '').trim().toLowerCase(),
      products: Number(String(col(r, 'no of products', 'number of products', 'products') ?? '0').replace(/[^0-9]/g, '')) || 0,
      language: String(col(r, 'language', 'primary region') ?? 'en').trim().toLowerCase().slice(0, 2) || 'en',
    }))
    .filter((f) => f.fid)
}

export function downloadUrl(apikey: string, fid: string, language: string): string {
  return (
    `${HOST}/datafeed/download/apikey/${encodeURIComponent(apikey)}/language/${language || 'en'}` +
    `/fid/${fid}/columns/${COLUMNS.join(',')}/format/csv/delimiter/,/compression/gzip/`
  )
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'merchant'
}

function mapFeedRowToOffer(r: Record<string, string>, sourceId: string, advertiserFallback: string) {
  const deep = col(r, 'aw_deep_link', 'deep_link')
  const name = col(r, 'product_name')
  if (!deep || !name) return null
  const link = deep.includes('clickref=')
    ? deep
    : `${deep}${deep.includes('?') ? '&' : '?'}clickref={click_id}`
  const merchant = col(r, 'merchant_name') ?? advertiserFallback ?? 'merchant'
  const priceStr = col(r, 'search_price', 'store_price')
  const currency = col(r, 'currency') ?? 'USD'
  const image = col(r, 'aw_image_url', 'merchant_image_url')
  const category = col(r, 'category_name', 'merchant_category')
  return {
    source_id: sourceId,
    network_offer_id: String(col(r, 'aw_product_id', 'merchant_product_id') ?? deep),
    kind: 'affiliate_product' as const,
    merchant: { name: merchant, slug: slugify(merchant) },
    title: name,
    brand: col(r, 'brand_name') ?? null,
    description: col(r, 'description')?.slice(0, 2000) ?? null,
    image_url: image ?? null,
    taxonomy: { category_path: category ? [category] : [], keywords: [] },
    economics: { type: 'commission_pct' as const, rate: 0.05, currency, cookie_window_days: 30 },
    price: priceStr
      ? { amount: Number(priceStr.replace(/[^0-9.]/g, '')), currency, as_of: new Date().toISOString() }
      : null,
    constraints: {},
    tracking: { link_template: link, subid_fidelity: 'click' as const, destination_url: deep },
  }
}

type FetchImpl = typeof fetch

export async function syncAwinFeeds(
  ctx: AdapterContext,
  source: SourceRow,
  fetchImpl: FetchImpl = fetch,
): Promise<{ upserted: number; feeds: number }> {
  const creds = await ctx.broker.get(source.id)
  const apikey = creds?.feed_api_key
  if (!apikey) {
    await ctx.db.query(
      `update sources set health = health || jsonb_build_object('catalog', 'no feed_api_key set — add it to enable product feeds') where id = $1`,
      [source.id],
    )
    return { upserted: 0, feeds: 0 }
  }

  const listRes = await fetchImpl(`${HOST}/datafeed/list/apikey/${encodeURIComponent(String(apikey))}`)
  if (!listRes.ok) throw new Error(`awin feed list: HTTP ${listRes.status}`)
  let feeds = parseFeedList(await listRes.text())
    .filter((f) => !f.status || /(active|joined|yes|1)/.test(f.status))
    .filter((f) => f.products !== 0)
    .sort((a, b) => (a.products || 1e12) - (b.products || 1e12)) // breadth first: smaller feeds first
    .slice(0, MAX_FEEDS)

  let upserted = 0
  for (const feed of feeds) {
    try {
      upserted += await ingestOneFeed(ctx, source, String(apikey), feed, fetchImpl)
    } catch (err) {
      console.error('awin feed', feed.fid, feed.advertiser, err)
    }
  }
  await ctx.db.query(
    `update sources set health = health || jsonb_build_object('last_catalog_sync', now()::text, 'catalog_feeds', $2::int, 'catalog_offers', $3::int) where id = $1`,
    [source.id, feeds.length, upserted],
  )
  return { upserted, feeds: feeds.length }
}

async function ingestOneFeed(
  ctx: AdapterContext,
  source: SourceRow,
  apikey: string,
  feed: AwinFeed,
  fetchImpl: FetchImpl,
): Promise<number> {
  const res = await fetchImpl(downloadUrl(apikey, feed.fid, feed.language))
  if (!res.ok) throw new Error(`download ${feed.fid}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  let text: string
  try {
    text = gunzipSync(buf).toString('utf8')
  } catch {
    text = buf.toString('utf8') // tolerate uncompressed
  }
  if (text.length > MAX_DECOMPRESSED_CHARS) text = text.slice(0, MAX_DECOMPRESSED_CHARS)
  const rows = parseCsv(text).slice(0, MAX_OFFERS_PER_FEED)
  let n = 0
  for (const r of rows) {
    const offer = mapFeedRowToOffer(r, source.id, feed.advertiser)
    if (!offer) continue
    await upsertOffer(ctx.db, offer)
    n++
  }
  return n
}
