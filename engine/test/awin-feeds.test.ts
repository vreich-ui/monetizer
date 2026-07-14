import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { gzipSync } from 'node:zlib'
import type { Db } from '../src/db/client.ts'
import { freshDb, testBroker } from './helpers.ts'
import { ensureSource } from '../src/adapters/registry.ts'
import { parseFeedList, downloadUrl, syncAwinFeeds } from '../src/adapters/awin/feeds.ts'

let db: Db

beforeAll(async () => {
  db = await freshDb()
})
afterAll(async () => {
  await db.close()
})

const FEED_LIST_CSV = [
  'Feed ID,Advertiser ID,Advertiser Name,Membership Status,No of products,Language',
  '111,900,Acme Outdoors,active,2,en',
  '222,901,Empty Store,active,0,en',
  '333,902,Pending Store,pending,50,en',
].join('\n')

const PRODUCT_CSV = [
  'aw_deep_link,product_name,aw_product_id,merchant_name,category_name,search_price,currency,aw_image_url,description,brand_name',
  'https://www.awin1.com/cread.php?awinmid=900&awinaffid=2590733&ued=https%3A%2F%2Facme.com%2Ftripod,Carbon Travel Tripod,SKU1,Acme Outdoors,Photography,129.99,GBP,https://img/1.jpg,Lightweight tripod,Acme',
  'https://www.awin1.com/cread.php?awinmid=900&awinaffid=2590733&ued=https%3A%2F%2Facme.com%2Fbag,Camera Backpack,SKU2,Acme Outdoors,Bags,79.00,GBP,https://img/2.jpg,Weatherproof bag,Acme',
].join('\n')

describe('awin feed helpers', () => {
  it('parses the feed list and filters by membership + products', () => {
    const feeds = parseFeedList(FEED_LIST_CSV)
    expect(feeds).toHaveLength(3)
    expect(feeds[0]).toMatchObject({ fid: '111', advertiser: 'Acme Outdoors', status: 'active', products: 2 })
  })
  it('builds a download URL with columns + gzip', () => {
    const u = downloadUrl('KEY', '111', 'en')
    expect(u).toContain('/datafeed/download/apikey/KEY/language/en/fid/111/columns/')
    expect(u).toContain('aw_deep_link')
    expect(u).toContain('/compression/gzip/')
  })
})

describe('syncAwinFeeds end-to-end (stubbed fetch)', () => {
  it('discovers feeds, downloads gzipped CSV, maps + upserts offers with clickref', async () => {
    const broker = testBroker(db)
    const source = await ensureSource(db, 'awin')
    await broker.store(source.id, 'connection', { api_token: 't', publisher_id: '2590733', feed_api_key: 'FEEDKEY' })

    const fetchStub = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/datafeed/list/')) {
        return new Response(FEED_LIST_CSV, { status: 200 })
      }
      if (u.includes('/datafeed/download/') && u.includes('/fid/111/')) {
        return new Response(gzipSync(Buffer.from(PRODUCT_CSV)) as any, { status: 200 })
      }
      // fid 222 (empty) and 333 (pending) are filtered out and never fetched
      throw new Error(`unexpected fetch: ${u}`)
    }) as any

    const res = await syncAwinFeeds({ db, broker }, source, fetchStub)
    expect(res.feeds).toBe(1) // only the active, non-empty feed
    expect(res.upserted).toBe(2)

    const { rows } = await db.query(
      `select title, merchant->>'name' as merchant, price, tracking from offers where source_id = $1 order by title`,
      [source.id],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].title).toBe('Camera Backpack')
    expect(rows[1].title).toBe('Carbon Travel Tripod')
    expect(Number(rows[1].price.amount)).toBe(129.99)
    expect(rows[1].tracking.link_template).toContain('clickref={click_id}') // click-fidelity injected
    expect(rows[1].tracking.subid_fidelity).toBe('click')
  })

  it('no-ops (with health note) when feed_api_key is absent', async () => {
    const broker = testBroker(db)
    const source = await ensureSource(db, 'awin', { displayName: 'awin2', tenantScope: null })
    // overwrite creds without a feed key
    await db.query(`delete from credentials where source_id = $1`, [source.id])
    await broker.store(source.id, 'connection', { api_token: 't', publisher_id: '1' })
    const res = await syncAwinFeeds({ db, broker }, source, (async () => {
      throw new Error('should not fetch')
    }) as any)
    expect(res).toEqual({ upserted: 0, feeds: 0 })
  })
})
