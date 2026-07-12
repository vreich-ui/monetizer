import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import type { Db } from '../src/db/client.ts'
import { freshDb, seedOffer, seedSource, seedTenant, sleep, surfaceDecl, testBroker, TEST_MASTER_KEY } from './helpers.ts'
import { createApp } from '../src/http/app.ts'
import { HeuristicPolicy, DEFAULT_PARAMS } from '../src/decision/policy.ts'
import { setLifecycle } from '../src/core/offers.ts'
import type { Tenant } from '../src/domain/types.ts'
import type { SourceRow } from '../src/adapters/types.ts'

let db: Db
let app: Hono
let tenant: Tenant
let token: string
let source: SourceRow

const REDIRECT_BASE = 'http://go.test'

beforeAll(async () => {
  db = await freshDb()
  ;({ tenant, token } = await seedTenant(db))
  source = await seedSource(db)
  app = createApp({
    db,
    broker: testBroker(db),
    policy: new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0 }),
    redirectBase: REDIRECT_BASE,
    hashSalt: TEST_MASTER_KEY.slice(0, 16),
  })
})

afterAll(async () => {
  await db.close()
})

const resolveReq = (body: unknown) =>
  app.request('/v1/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

describe('resolve API', () => {
  it('rejects bad tokens', async () => {
    const res = await app.request('/v1/resolve', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: JSON.stringify({ surfaces: [surfaceDecl()] }),
    })
    expect(res.status).toBe(401)
  })

  it('resolves a surface to an offer with a redirect href and logs the decision', async () => {
    await seedOffer(db, source.id)
    const res = await resolveReq({ build_id: 'build-1', surfaces: [surfaceDecl()] })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.decisions).toHaveLength(1)
    const d = data.decisions[0]
    expect(d.offers.length).toBeGreaterThanOrEqual(1)
    expect(d.offers[0].href).toMatch(new RegExp(`^${REDIRECT_BASE}/r/acme-store/${d.decision_id}/1$`))
    expect(data.page_disclosures.length).toBeGreaterThan(0)

    const { rows } = await db.query(`select * from decisions where id = $1`, [d.decision_id])
    expect(rows).toHaveLength(1)
    expect(rows[0].propensity).toBe(1)
    expect(rows[0].policy.name).toBe('heuristic')
    expect(rows[0].candidates.length).toBeGreaterThan(0)
  })

  it('is idempotent per (surface, build_id) and supersedes on new builds', async () => {
    const a = await (await resolveReq({ build_id: 'build-2', surfaces: [surfaceDecl()] })).json()
    const b = await (await resolveReq({ build_id: 'build-2', surfaces: [surfaceDecl()] })).json()
    expect(a.decisions[0].decision_id).toBe(b.decisions[0].decision_id)

    const c = await (await resolveReq({ build_id: 'build-3', surfaces: [surfaceDecl()] })).json()
    expect(c.decisions[0].decision_id).not.toBe(a.decisions[0].decision_id)
    const { rows } = await db.query(
      `select status from decisions where id = $1`,
      [a.decisions[0].decision_id],
    )
    expect(rows[0].status).toBe('superseded')
  })

  it('returns empty offers and records a demand signal when nothing matches', async () => {
    const res = await resolveReq({
      build_id: 'build-4',
      surfaces: [
        surfaceDecl({
          content_id: 'article-nomatch',
          context: {
            intent_class: 'commercial_investigation',
            topic: 'quantum flux capacitors',
            entities: ['flux capacitor'],
            keywords: ['quantum'],
            locale: 'en-US',
          },
        }),
      ],
    })
    const data = await res.json()
    expect(data.decisions[0].offers).toHaveLength(0)
    expect(data.coverage.unresolved).toContain(data.decisions[0].surface_id)
    const { rows } = await db.query(`select * from demand_signals where category = 'quantum flux capacitors'`)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

describe('redirect service', () => {
  it('302s through the offer link template with click_id + tenant namespace and logs the click', async () => {
    const data = await (await resolveReq({ build_id: 'build-r1', surfaces: [surfaceDecl({ content_id: 'r-article' })] })).json()
    const d = data.decisions[0]
    const path = new URL(d.offers[0].href).pathname

    const res = await app.request(path, {
      headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '203.0.113.9' },
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc).toContain('https://track.example.com/c/123')
    expect(loc).toContain('subId2=testsite-ns')
    const clickId = new URL(loc).searchParams.get('subId1')
    expect(clickId).toBeTruthy()

    await sleep(150) // click write is async by design
    const { rows } = await db.query(`select * from events where type = 'click' and click_id = $1`, [clickId])
    expect(rows).toHaveLength(1)
    expect(rows[0].decision_id).toBe(d.decision_id)
    expect(rows[0].tenant_id).toBe(tenant.id)
    expect(rows[0].visitor_hash).toBeTruthy()
    expect(Number(rows[0].ivt_score ?? 0)).toBe(0)
  })

  it('flags bot user agents as IVT', async () => {
    const data = await (await resolveReq({ build_id: 'build-r2', surfaces: [surfaceDecl({ content_id: 'r-article2' })] })).json()
    const path = new URL(data.decisions[0].offers[0].href).pathname
    await app.request(path, { headers: { 'user-agent': 'python-requests/2.31' } })
    await sleep(150)
    const { rows } = await db.query(
      `select ivt_score, ivt_reasons from events where type = 'click' and decision_id = $1`,
      [data.decisions[0].decision_id],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].ivt_score)).toBe(1)
    expect(rows[0].ivt_reasons).toContain('bot_ua')
  })

  it('fails over to the next live candidate when the chosen offer dies', async () => {
    const backupTemplate = 'https://backup.example.com/go?subId1={click_id}'
    await seedOffer(db, source.id, {
      title: 'Travel Tripod Backup Special',
      tracking: { link_template: backupTemplate, subid_fidelity: 'click', destination_url: 'https://acme.example.com/backup' },
    })
    const data = await (await resolveReq({ build_id: 'build-r3', surfaces: [surfaceDecl({ content_id: 'r-article3' })] })).json()
    const d = data.decisions[0]
    const chosenOfferId = d.offers[0].offer_id
    await setLifecycle(db, chosenOfferId, 'dead', 'test kill')

    const res = await app.request(new URL(d.offers[0].href).pathname)
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc).not.toContain('acme.example.com/tripod-dead')
    expect(loc).toMatch(/track\.example\.com|backup\.example\.com/)

    await sleep(150)
    const { rows } = await db.query(
      `select * from events where type = 'redirect_failover' and decision_id = $1`,
      [d.decision_id],
    )
    expect(rows).toHaveLength(1)
    await setLifecycle(db, chosenOfferId, 'active')
  })

  it('404s unknown decisions and logs redirect_failed', async () => {
    const res = await app.request('/r/acme-store/01UNKNOWNDECISION0000000000/1')
    expect(res.status).toBe(404)
  })
})

describe('beacon', () => {
  it('serves the beacon script and accepts events', async () => {
    const js = await app.request('/beacon.js')
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('sendBeacon')

    const data = await (await resolveReq({ build_id: 'build-b1', surfaces: [surfaceDecl({ content_id: 'b-article' })] })).json()
    const decisionId = data.decisions[0].decision_id
    const res = await app.request('/v1/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify({
        page: '/best-travel-tripods',
        events: [
          { type: 'pageview' },
          { type: 'impression', decision_id: decisionId },
          { type: 'viewable', decision_id: decisionId },
        ],
      }),
    })
    expect(res.status).toBe(204)
    await sleep(150)
    const { rows } = await db.query(
      `select type from events where decision_id = $1 and type in ('impression','viewable') order by type`,
      [decisionId],
    )
    expect(rows.map((r: any) => r.type)).toEqual(['impression', 'viewable'])
  })
})
