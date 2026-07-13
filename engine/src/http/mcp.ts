import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import { createMcpServer } from '../mcp/tools.ts'

/**
 * Authenticated web MCP endpoint (POST /mcp) — the agentic control surface.
 * Bearer-token auth against ADMIN_TOKEN; stateless (a fresh server + transport
 * per request, JSON responses), which suits Cloud Run's request model and
 * multiple concurrent agent callers. The identical tool set is available on
 * stdio for local operator use (mcp/server.ts).
 */

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function mcpRoutes(deps: {
  db: Db
  broker: CredentialBroker
  publicBaseUrl: string
  adminToken: string
}): Hono {
  const app = new Hono()

  app.all('/mcp', async (c) => {
    if (!deps.adminToken) {
      // Refuse to expose the control plane without a configured secret.
      return c.json({ error: 'mcp endpoint disabled: ADMIN_TOKEN not set' }, 503)
    }
    const provided = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!tokenMatches(provided, deps.adminToken)) {
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' })
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
    return transport.handleRequest(c.req.raw)
  })

  return app
}
