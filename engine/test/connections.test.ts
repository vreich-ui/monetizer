import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client.ts'
import { freshDb, testBroker } from './helpers.ts'
import { ensureSource } from '../src/adapters/registry.ts'
import { connectionConfigSchema } from '../src/adapters/http/config.ts'
import { applyAuth } from '../src/adapters/http/client.ts'
import { runRecipe } from '../src/adapters/http/recipe.ts'
import { CredentialBroker } from '../src/core/credentials.ts'

let db: Db
let broker: CredentialBroker

beforeAll(async () => {
  db = await freshDb()
  broker = testBroker(db)
})
afterAll(async () => {
  await db.close()
})

/** Mock upstream that records requests and returns queued JSON responses. */
function mockFetch(pages: unknown[]) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  let i = 0
  const impl = (async (url: string, init: any) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v)
    seen.push({ url: String(url), headers })
    const body = pages[Math.min(i, pages.length - 1)]
    i++
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, seen }
}

describe('applyAuth', () => {
  it('bearer / api_key_header / basic / query_param', async () => {
    const src = await ensureSource(db, 'conn:auth1')
    await broker.store(src.id, 'connection', { token: 'T0K', api_key: 'AK', username: 'u', password: 'p' })
    const secrets = { token: 'T0K', api_key: 'AK', username: 'u', password: 'p' }

    let r = { url: new URL('https://8.8.8.8/'), headers: {} as Record<string, string> }
    await applyAuth(db, src.id, { type: 'bearer' }, secrets, r)
    expect(r.headers['Authorization']).toBe('Bearer T0K')

    r = { url: new URL('https://8.8.8.8/'), headers: {} }
    await applyAuth(db, src.id, { type: 'api_key_header', header_name: 'X-Api-Key' }, secrets, r)
    expect(r.headers['X-Api-Key']).toBe('AK')

    r = { url: new URL('https://8.8.8.8/'), headers: {} }
    await applyAuth(db, src.id, { type: 'basic' }, secrets, r)
    expect(r.headers['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)

    r = { url: new URL('https://8.8.8.8/'), headers: {} }
    await applyAuth(db, src.id, { type: 'query_param', query_param: 'key', value_template: '{api_key}' }, secrets, r)
    expect(r.url.searchParams.get('key')).toBe('AK')
  })

  it('value_template composes multiple secret fields', async () => {
    const src = await ensureSource(db, 'conn:auth2')
    const secrets = { app_id: 'A', app_secret: 'S' }
    const r = { url: new URL('https://8.8.8.8/'), headers: {} as Record<string, string> }
    await applyAuth(db, src.id, { type: 'api_key_header', header_name: 'Authorization', value_template: '{app_id}:{app_secret}' }, secrets, r)
    expect(r.headers['Authorization']).toBe('A:S')
  })

  it('oauth2_client_credentials fetches + caches the token', async () => {
    const src = await ensureSource(db, 'conn:oauth')
    const secrets = { client_id: 'cid', client_secret: 'sec' }
    const { impl, seen } = mockFetch([{ access_token: 'ACCESS1', expires_in: 3600 }])
    const auth = { type: 'oauth2_client_credentials' as const, token_url: 'https://8.8.8.8/token' }

    const r1 = { url: new URL('https://8.8.8.8/'), headers: {} as Record<string, string> }
    await applyAuth(db, src.id, auth, secrets, r1, impl)
    expect(r1.headers['Authorization']).toBe('Bearer ACCESS1')

    const r2 = { url: new URL('https://8.8.8.8/'), headers: {} as Record<string, string> }
    await applyAuth(db, src.id, auth, secrets, r2, impl)
    expect(r2.headers['Authorization']).toBe('Bearer ACCESS1')
    expect(seen.length).toBe(1) // second call served from cache
  })
})

describe('runRecipe (deterministic collection)', () => {
  it('collects transactions, applies auth, maps fields, writes observations', async () => {
    const src = await ensureSource(db, 'conn:txns')
    await broker.store(src.id, 'connection', { token: 'SECRET' })
    const config = connectionConfigSchema.parse({
      base_url: 'https://8.8.8.8/api',
      auth: { type: 'bearer' },
    })
    const recipe = {
      name: 'pull-txns',
      sink: 'transactions' as const,
      path: 'transactions',
      records_path: 'data',
      map: {
        network_txn_id: 'orderId',
        commission_amount: 'commission',
        order_amount: 'sale',
        currency: 'cur',
        status: 'state',
        txn_time: 'date',
      },
    }
    const { impl, seen } = mockFetch([
      { data: [
        { orderId: 'A1', commission: '2.50', sale: '50', cur: 'USD', state: 'approved', date: '2026-07-01T00:00:00Z' },
        { orderId: 'A2', commission: '1.00', sale: '20', cur: 'USD', state: 'pending', date: '2026-07-02T00:00:00Z' },
      ] },
    ])
    const res = await runRecipe({ db, broker, fetchImpl: impl }, { id: src.id, config }, connectionConfigSchema.parse({ recipes: [recipe] }).recipes[0]!)
    expect(res.records).toBe(2)
    expect(seen[0]!.headers['authorization']).toBe('Bearer SECRET')

    const { rows } = await db.query(`select network_txn_id, commission_amount, status_norm from conversion_observations where source_id=$1 order by network_txn_id`, [src.id])
    expect(rows.map((r: any) => r.network_txn_id)).toEqual(['A1', 'A2'])
    expect(Number(rows[0].commission_amount)).toBe(2.5)
    expect(rows[0].status_norm).toBe('approved')
  })

  it('paginates until a short page', async () => {
    const src = await ensureSource(db, 'conn:paged')
    const config = connectionConfigSchema.parse({ base_url: 'https://8.8.8.8/api', auth: { type: 'none' } })
    const recipe = connectionConfigSchema.parse({
      recipes: [{
        name: 'p', sink: 'transactions', path: 'txns', records_path: 'items',
        map: { network_txn_id: 'id', commission_amount: 'c', currency: '=USD' },
        paginate: { type: 'page', param: 'page', size: 2, max_pages: 10 },
      }],
    }).recipes[0]!
    const { impl, seen } = mockFetch([
      { items: [{ id: 'p1', c: 1 }, { id: 'p2', c: 1 }] },
      { items: [{ id: 'p3', c: 1 }] }, // short page → stop
    ])
    const res = await runRecipe({ db, broker, fetchImpl: impl }, { id: src.id, config }, recipe)
    expect(res.records).toBe(3)
    expect(seen.length).toBe(2)
    expect(seen[0]!.url).toContain('page=1')
    expect(seen[1]!.url).toContain('page=2')
  })

  it('collects offers into the offer store', async () => {
    const src = await ensureSource(db, 'conn:offers')
    const config = connectionConfigSchema.parse({ base_url: 'https://8.8.8.8/api', auth: { type: 'none' } })
    const recipe = connectionConfigSchema.parse({
      recipes: [{
        name: 'o', sink: 'offers', path: 'products', records_path: 'products',
        map: { id: 'sku', title: 'name', url: 'link', price: 'price', merchant: '=Acme', currency: '=USD' },
      }],
    }).recipes[0]!
    const { impl } = mockFetch([{ products: [{ sku: 'X1', name: 'Widget', link: 'https://acme.test/x1', price: '9.99' }] }])
    const res = await runRecipe({ db, broker, fetchImpl: impl }, { id: src.id, config }, recipe)
    expect(res.records).toBe(1)
    const { rows } = await db.query(`select title, price from offers where source_id=$1`, [src.id])
    expect(rows[0].title).toBe('Widget')
    expect(Number(rows[0].price.amount)).toBe(9.99)
  })
})
