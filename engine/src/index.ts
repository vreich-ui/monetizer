import { serve } from '@hono/node-server'
import { config } from './config.ts'
import { createDb } from './db/client.ts'
import { migrate } from './db/migrate.ts'
import { CredentialBroker } from './core/credentials.ts'
import { HeuristicPolicy, DEFAULT_PARAMS } from './decision/policy.ts'
import { createApp } from './http/app.ts'
import { buildHandlers, addFanoutHandlers, seedSchedules } from './jobs/workers.ts'
import { startWorker } from './jobs/queue.ts'

function fatal(msg: string, err?: unknown): never {
  console.error(`FATAL: ${msg}`)
  if (err) console.error(err)
  process.exit(1)
}

function maskedDbTarget(url: string): string {
  // Cloud SQL socket URLs (postgres://user:pw@/db?host=/cloudsql/…) have an
  // empty authority host and are not WHATWG-parseable; read the param directly.
  const socket = url.match(/[?&]host=([^&]+)/)?.[1]
  if (socket) return `unix socket ${decodeURIComponent(socket)}`
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '5432'}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

if (!process.env.DATABASE_URL) {
  fatal(
    'DATABASE_URL is not set (falling back to localhost would be pointless on Cloud Run).\n' +
      '  Set it on the service, e.g.:\n' +
      '  gcloud run services update <service> --region <region> \\\n' +
      "    --add-cloudsql-instances <project>:<region>:<instance> \\\n" +
      "    --set-env-vars 'DATABASE_URL=postgres://user:pw@/monetizer?host=/cloudsql/<project>:<region>:<instance>'",
  )
}
if (!config.CRED_MASTER_KEY) {
  fatal(
    'CRED_MASTER_KEY is not set. Generate once with `openssl rand -base64 32`, store it in Secret Manager,\n' +
      '  and attach it: gcloud run services update <service> --set-secrets CRED_MASTER_KEY=cred-master-key:latest',
  )
}

const db = createDb(config.DATABASE_URL)
try {
  await migrate(db)
} catch (err) {
  fatal(
    `cannot reach the database or run migrations (target: ${maskedDbTarget(config.DATABASE_URL)}).\n` +
      '  On Cloud Run: check the Cloud SQL attachment (--add-cloudsql-instances), the DATABASE_URL\n' +
      '  unix-socket host (?host=/cloudsql/<connection-name>), and the db user/password.',
    err,
  )
}

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
