import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { config } from '../config.ts'
import { createDb } from '../db/client.ts'
import { migrate } from '../db/migrate.ts'
import { CredentialBroker } from '../core/credentials.ts'
import { createMcpServer } from './tools.ts'

/**
 * Local stdio MCP entrypoint (`pnpm mcp`) for operator use over cloud-sql-proxy.
 * The same tools are served on the web at POST /mcp (auth) — see http/mcp.ts.
 */
const db = createDb(config.DATABASE_URL)
await migrate(db)
const broker = new CredentialBroker(db, config.CRED_MASTER_KEY)

const server = createMcpServer({ db, broker, publicBaseUrl: config.PUBLIC_BASE_URL })
await server.connect(new StdioServerTransport())
