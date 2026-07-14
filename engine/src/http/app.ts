import { Hono } from 'hono'
import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import type { DecisionPolicy } from '../decision/policy.ts'
import { redirectRoutes } from './redirect.ts'
import { resolveRoutes } from './resolve.ts'
import { beaconRoutes } from './beacon.ts'
import { webhookRoutes } from './webhooks.ts'
import { mcpRoutes } from './mcp.ts'
import { oauthRoutes } from './oauth.ts'

export interface AppDeps {
  db: Db
  broker: CredentialBroker
  policy: DecisionPolicy
  redirectBase: string
  publicBaseUrl: string
  adminToken: string
  hashSalt: string
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  app.get('/healthz', async (c) => {
    await deps.db.query('select 1')
    return c.json({ ok: true })
  })
  app.route('/', redirectRoutes({ db: deps.db, hashSalt: deps.hashSalt }))
  app.route('/', resolveRoutes({ db: deps.db, policy: deps.policy, redirectBase: deps.redirectBase }))
  app.route('/', beaconRoutes({ db: deps.db, hashSalt: deps.hashSalt }))
  app.route('/', webhookRoutes({ db: deps.db, broker: deps.broker }))
  app.route('/', oauthRoutes({ db: deps.db, adminToken: deps.adminToken }))
  app.route(
    '/',
    mcpRoutes({
      db: deps.db,
      broker: deps.broker,
      publicBaseUrl: deps.publicBaseUrl,
      adminToken: deps.adminToken,
    }),
  )
  return app
}
