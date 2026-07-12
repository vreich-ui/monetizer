import { serve } from '@hono/node-server'
import { config } from './config.ts'
import { createDb } from './db/client.ts'
import { migrate } from './db/migrate.ts'
import { CredentialBroker } from './core/credentials.ts'
import { HeuristicPolicy, DEFAULT_PARAMS } from './decision/policy.ts'
import { createApp } from './http/app.ts'
import { buildHandlers, addFanoutHandlers, seedSchedules } from './jobs/workers.ts'
import { startWorker } from './jobs/queue.ts'

const db = createDb(config.DATABASE_URL)
await migrate(db)

const broker = new CredentialBroker(db, config.CRED_MASTER_KEY)
const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: config.POLICY_EPSILON })

const app = createApp({
  db,
  broker,
  policy,
  redirectBase: config.REDIRECT_BASE_URL,
  hashSalt: config.CRED_MASTER_KEY.slice(0, 16) || 'dev-salt',
})

await seedSchedules(db)
const handlers = buildHandlers(broker)
addFanoutHandlers(handlers)
const stopWorker = startWorker(db, handlers)

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`monetizer engine listening on :${info.port}`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopWorker()
    server.close()
    void db.close().then(() => process.exit(0))
  })
}
