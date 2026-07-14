import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import type { Db } from '../src/db/client.ts'
import { freshDb, testBroker, TEST_MASTER_KEY } from './helpers.ts'
import { createApp } from '../src/http/app.ts'
import { HeuristicPolicy, DEFAULT_PARAMS } from '../src/decision/policy.ts'

let db: Db
let app: Hono
const TOKEN = 'test-admin-token'

beforeAll(async () => {
  db = await freshDb()
  app = createApp({
    db,
    broker: testBroker(db),
    policy: new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0 }),
    redirectBase: 'http://go.test',
    publicBaseUrl: 'http://engine.test',
    adminToken: TOKEN,
    hashSalt: TEST_MASTER_KEY.slice(0, 16),
  })
})

afterAll(async () => {
  await db.close()
})

const rpc = (body: unknown, token?: string) =>
  app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

const init = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
}

describe('web MCP endpoint', () => {
  it('rejects requests with no token', async () => {
    const res = await rpc(init)
    expect(res.status).toBe(401)
  })

  it('rejects requests with a wrong token', async () => {
    const res = await rpc(init, 'not-the-token')
    expect(res.status).toBe(401)
  })

  it('lists the control-plane tools when authenticated', async () => {
    // Initialize (stateless), then list tools.
    const initRes = await rpc(init, TOKEN)
    expect(initRes.status).toBe(200)

    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, TOKEN)
    expect(res.status).toBe(200)
    const body = await parseRpc(res)
    const names = new Set(body.result.tools.map((t: any) => t.name))
    for (const t of [
      // control plane
      'demand_signals', 'explain_decision', 'ingest_csv', 'list_sources', 'pause_offer',
      'pause_source', 'performance', 'register_credential', 'register_tenant', 'search_offers',
      'set_tenant_tracking', 'trigger_rebuild',
      // generic agentic connections
      'register_connection', 'list_connections', 'test_request', 'run_collection', 'delete_connection',
    ]) {
      expect(names.has(t), t).toBe(true)
    }
  })

  it('executes a tool call end-to-end (register_tenant → token issued)', async () => {
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'register_tenant', arguments: { slug: 'via-mcp', name: 'Via MCP' } },
      },
      TOKEN,
    )
    expect(res.status).toBe(200)
    const body = await parseRpc(res)
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.slug).toBe('via-mcp')
    expect(payload.token).toMatch(/^mzt_/)

    const { rows } = await db.query(`select slug from tenants where slug = 'via-mcp'`)
    expect(rows).toHaveLength(1)
  })

  it('returns 503 when the endpoint is unconfigured', async () => {
    const bare = createApp({
      db,
      broker: testBroker(db),
      policy: new HeuristicPolicy(DEFAULT_PARAMS),
      redirectBase: 'http://go.test',
      publicBaseUrl: 'http://engine.test',
      adminToken: '',
      hashSalt: 'x',
    })
    const res = await bare.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(init),
    })
    expect(res.status).toBe(503)
  })
})

/** Streamable-HTTP may answer as JSON or as a single SSE event; handle both. */
async function parseRpc(res: Response): Promise<any> {
  const ct = res.headers.get('content-type') ?? ''
  const raw = await res.text()
  if (ct.includes('text/event-stream')) {
    const line = raw.split('\n').find((l) => l.startsWith('data:'))
    return JSON.parse(line!.slice(5).trim())
  }
  return JSON.parse(raw)
}
