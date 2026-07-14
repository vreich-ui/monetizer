import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import { createMcpServer } from '../mcp/tools.ts'
import { isAuthorized, baseUrlOf } from './oauth.ts'

/**
 * Web MCP endpoint (POST/GET/DELETE /mcp) — the agentic control surface.
 * Two auth paths, both landing on the same tools:
 *   - Static bearer = ADMIN_TOKEN — for agents / Claude Code / curl (simple).
 *   - OAuth access token — for the Claude connector UI (see oauth.ts).
 * On a missing/invalid token it returns 401 with a WWW-Authenticate pointer to
 * the OAuth resource metadata, which is what triggers a connector's OAuth flow.
 * Stateless Streamable HTTP with JSON responses (scale-safe on Cloud Run);
 * CORS + OPTIONS so browser-based connectors can call it.
 */

const CORS_HEADERS = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
})

export function mcpRoutes(deps: {
  db: Db
  broker: CredentialBroker
  publicBaseUrl: string
  adminToken: string
}): Hono {
  const app = new Hono()

  app.options('/mcp', (c) => {
    const origin = c.req.header('origin') ?? '*'
    return c.body(null, 204, CORS_HEADERS(origin))
  })

  const handle = async (c: any) => {
    const origin = c.req.header('origin') ?? '*'
    const cors = CORS_HEADERS(origin)

    if (!deps.adminToken) {
      return c.json({ error: 'mcp endpoint disabled: ADMIN_TOKEN not set' }, 503, cors)
    }

    const provided = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!(await isAuthorized(deps.db, deps.adminToken, provided))) {
      const b = baseUrlOf(c.req.url, c.req.header('host'), c.req.header('x-forwarded-proto'))
      return c.json({ error: 'unauthorized' }, 401, {
        ...cors,
        'WWW-Authenticate': `Bearer resource_metadata="${b}/.well-known/oauth-protected-resource"`,
      })
    }

    const server = createMcpServer({ db: deps.db, broker: deps.broker, publicBaseUrl: deps.publicBaseUrl })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    })
    c.req.raw.signal.addEventListener('abort', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    const res = await transport.handleRequest(c.req.raw)
    // Attach CORS to the transport's Response.
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  }

  app.post('/mcp', handle)
  app.get('/mcp', handle)
  app.delete('/mcp', handle)

  return app
}
