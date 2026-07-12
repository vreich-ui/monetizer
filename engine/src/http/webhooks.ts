import { Hono } from 'hono'
import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import { adapterFor, getSource } from '../adapters/registry.ts'

export function webhookRoutes(deps: { db: Db; broker: CredentialBroker }): Hono {
  const app = new Hono()

  app.post('/v1/webhooks/:sourceId', async (c) => {
    const source = await getSource(deps.db, c.req.param('sourceId'))
    if (!source) return c.json({ error: 'unknown source' }, 404)
    const adapter = adapterFor(source.network)
    if (!adapter?.handleWebhook) return c.json({ error: 'source has no webhook capability' }, 400)
    const rawBody = await c.req.text()
    const headers: Record<string, string | undefined> = {}
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    try {
      const result = await adapter.handleWebhook({ db: deps.db, broker: deps.broker }, source, { headers, rawBody })
      return c.json({ ok: true, ...result })
    } catch (err) {
      console.error('webhook rejected', source.network, err)
      return c.json({ error: 'webhook rejected' }, 400)
    }
  })

  return app
}
