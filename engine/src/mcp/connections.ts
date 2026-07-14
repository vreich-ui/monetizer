import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Db } from '../db/client.ts'
import type { CredentialBroker } from '../core/credentials.ts'
import { adapterFor, ensureSource, getSource, listSources } from '../adapters/registry.ts'
import { enqueue } from '../jobs/queue.ts'
import { connectionConfigSchema, secretsSchema } from '../adapters/http/config.ts'
import { loadConfig } from '../adapters/http/index.ts'
import { runRecipe } from '../adapters/http/recipe.ts'
import { applyAuth, httpCall, getPath } from '../adapters/http/client.ts'

/**
 * Agent-facing generic connection tools (docs/plan/03). Agents register an
 * arbitrary supplier connection (bounded auth model + free-form secrets +
 * declarative collection recipes); the engine then runs the recipes on a
 * schedule deterministically — no AI per cycle. This is the AI-cost lever:
 * author once, execute forever.
 */

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })

// Liberal auth block — accepts the common supplier auth shapes.
const authArg = z
  .object({
    type: z.enum(['none', 'bearer', 'api_key_header', 'basic', 'query_param', 'oauth2_client_credentials']),
    header_name: z.string().optional(),
    query_param: z.string().optional(),
    value_template: z.string().optional(),
    username_key: z.string().optional(),
    password_key: z.string().optional(),
    token_url: z.string().optional(),
    client_id_key: z.string().optional(),
    client_secret_key: z.string().optional(),
    scope: z.string().optional(),
  })
  .optional()

export function registerConnectionTools(
  server: McpServer,
  deps: { db: Db; broker: CredentialBroker; publicBaseUrl: string },
): void {
  const { db, broker } = deps

  server.tool(
    'register_connection',
    'Register/replace a generic supplier connection an agent can fully configure. ' +
      'Bounded but liberal: any supplier via base_url + an auth model + free-form secrets, ' +
      'plus optional collection recipes the engine then runs deterministically (no AI per run). ' +
      'auth.type: none|bearer|api_key_header|basic|query_param|oauth2_client_credentials. ' +
      'secrets are an arbitrary {key:value} map, encrypted at rest; reference them in ' +
      'auth.value_template as {key}. recipes[].sink: transactions|offers; recipes[].map is ' +
      "{our_field: 'response.dot.path'} (prefix '=' for a literal). Use test_request first to " +
      'discover the response shape cheaply, then author recipes.',
    {
      slug: z.string().min(2).max(60).describe('supplier id; stored as network conn:<slug>'),
      display_name: z.string().max(200).optional(),
      base_url: z.string().url().optional(),
      auth: authArg,
      secrets: z.record(z.string()).default({}),
      headers: z.record(z.string()).optional(),
      verify: z
        .object({ method: z.enum(['GET', 'POST']).optional(), path: z.string().optional(), expect_status_below: z.number().optional() })
        .optional(),
      recipes: z.array(z.any()).optional(),
      instructions: z.string().max(8000).optional(),
      kind: z.enum(['affiliate_network', 'payment_provider', 'donation_platform', 'csv_inbox']).optional(),
    },
    async (args) => {
      const parsedSecrets = secretsSchema.safeParse(args.secrets)
      if (!parsedSecrets.success) return text({ error: 'invalid secrets', issues: parsedSecrets.error.issues })
      const cfg = connectionConfigSchema.safeParse({
        base_url: args.base_url,
        auth: args.auth ?? { type: 'none' },
        headers: args.headers ?? {},
        verify: args.verify,
        recipes: args.recipes ?? [],
        instructions: args.instructions,
      })
      if (!cfg.success) return text({ error: 'invalid connection config', issues: cfg.error.issues })

      const network = `conn:${args.slug}`
      const source = await ensureSource(db, network, {
        displayName: args.display_name ?? args.slug,
        config: cfg.data,
        kind: args.kind,
      })
      if (Object.keys(parsedSecrets.data).length > 0) {
        await broker.store(source.id, 'connection', parsedSecrets.data)
      }
      const adapter = adapterFor(network)!
      const result = await adapter.verify({ db, broker }, source)
      await broker.markVerified(source.id, result.ok).catch(() => {})
      await db.query(
        `update sources set status = $2, health = health || jsonb_build_object('last_verify', now()::text, 'verify_detail', $3::text) where id = $1`,
        [source.id, result.ok ? 'active' : 'error', result.detail],
      )
      // Kick off collection immediately if verified and recipes are present.
      const hasOffers = cfg.data.recipes.some((r) => r.sink === 'offers')
      const hasTxns = cfg.data.recipes.some((r) => r.sink === 'transactions')
      if (result.ok && hasOffers) await enqueue(db, 'catalog_sync', { source_id: source.id }, { dedupe: true })
      if (result.ok && hasTxns) await enqueue(db, 'poll_reports', { source_id: source.id }, { dedupe: true })

      return text({
        source_id: source.id,
        network,
        verified: result.ok,
        detail: result.detail,
        recipes: cfg.data.recipes.map((r) => ({ name: r.name, sink: r.sink })),
        collection: result.ok && (hasOffers || hasTxns) ? 'queued (runs on schedule too)' : 'none',
        note: 'secrets stored encrypted; never returned by any tool',
      })
    },
  )

  server.tool(
    'list_connections',
    'List generic connections with auth type, recipes, and last collection run (no secrets).',
    {},
    async () => {
      const sources = (await listSources(db)).filter((s) => s.network.startsWith('conn:'))
      const out = []
      for (const s of sources) {
        let cfg
        try {
          cfg = loadConfig(s)
        } catch {
          cfg = null
        }
        const { rows: runs } = await db.query(
          `select recipe_name, status, records, finished_at from collection_runs where source_id = $1 order by started_at desc limit 5`,
          [s.id],
        )
        out.push({
          source_id: s.id,
          network: s.network,
          status: s.status,
          base_url: cfg?.base_url,
          auth_type: cfg?.auth.type,
          recipes: cfg?.recipes.map((r) => ({ name: r.name, sink: r.sink, schedule_s: r.schedule_s })) ?? [],
          instructions: cfg?.instructions,
          health: s.health,
          recent_runs: runs,
        })
      }
      return text(out)
    },
  )

  server.tool(
    'test_request',
    'Author aid: make one authenticated request through a connection and return the ' +
      'status + a response sample + detected array paths, so an agent can build a recipe ' +
      'cheaply (one look instead of guessing). SSRF-guarded; does not write anything.',
    {
      source_id: z.string(),
      method: z.enum(['GET', 'POST']).default('GET'),
      path: z.string().default(''),
      query: z.record(z.string()).optional(),
    },
    async (args) => {
      const source = await getSource(db, args.source_id)
      if (!source || !source.network.startsWith('conn:')) return text({ error: 'unknown connection' })
      const cfg = loadConfig(source)
      if (!cfg.base_url) return text({ error: 'connection has no base_url' })
      const secrets = ((await broker.get(source.id)) ?? {}) as Record<string, string>
      const url = new URL(cfg.base_url.replace(/\/$/, '') + '/' + args.path.replace(/^\//, ''))
      for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, v)
      const headers: Record<string, string> = { accept: 'application/json', ...cfg.headers }
      try {
        await applyAuth(db, source.id, cfg.auth, secrets, { url, headers })
        const res = await httpCall(url, { method: args.method, headers })
        return text({
          status: res.status,
          array_paths: res.json ? findArrayPaths(res.json) : [],
          sample: res.json ? truncate(res.json) : res.text.slice(0, 1500),
        })
      } catch (err) {
        return text({ error: String(err) })
      }
    },
  )

  server.tool(
    'run_collection',
    'Run a connection’s collection recipe(s) now (on-demand), in addition to the schedule.',
    { source_id: z.string(), recipe_name: z.string().optional() },
    async (args) => {
      const source = await getSource(db, args.source_id)
      if (!source || !source.network.startsWith('conn:')) return text({ error: 'unknown connection' })
      const cfg = loadConfig(source)
      const recipes = cfg.recipes.filter((r) => !args.recipe_name || r.name === args.recipe_name)
      if (recipes.length === 0) return text({ error: 'no matching recipe' })
      const results = []
      for (const r of recipes) {
        try {
          const res = await runRecipe({ db, broker }, { id: source.id, config: cfg }, r)
          results.push({ recipe: r.name, sink: r.sink, records: res.records, pages: res.pages })
        } catch (err) {
          results.push({ recipe: r.name, error: String(err) })
        }
      }
      return text({ ran: results })
    },
  )

  server.tool(
    'delete_connection',
    'Remove a connection and its collected data (offers, observations, credentials).',
    { source_id: z.string() },
    async (args) => {
      const source = await getSource(db, args.source_id)
      if (!source || !source.network.startsWith('conn:')) return text({ error: 'unknown connection' })
      await db.tx(async (q) => {
        await q.query(`delete from conversion_observations where source_id = $1`, [source.id])
        await q.query(`delete from offers where source_id = $1`, [source.id])
        await q.query(`delete from collection_runs where source_id = $1`, [source.id])
        await q.query(`delete from sources where id = $1`, [source.id]) // credentials cascade
      })
      return text({ ok: true, deleted: source.network })
    },
  )
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v)
  if (s.length <= 1500) return v
  return JSON.parse(s.slice(0, 1500).replace(/,[^,]*$/, '') + (Array.isArray(v) ? ']' : '}'))
}

/** Find dot-paths to array fields (candidates for records_path). */
function findArrayPaths(obj: unknown, prefix = '', depth = 0): string[] {
  if (depth > 4 || obj == null || typeof obj !== 'object') return []
  const out: string[] = []
  if (Array.isArray(obj)) return [prefix || '(root)']
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (Array.isArray(v)) out.push(p)
    else if (v && typeof v === 'object') out.push(...findArrayPaths(v, p, depth + 1))
  }
  return out
}
