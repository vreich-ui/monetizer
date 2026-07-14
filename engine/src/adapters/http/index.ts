import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { connectionConfigSchema, type ConnectionConfig } from './config.ts'
import { applyAuth, httpCall } from './client.ts'
import { runRecipe } from './recipe.ts'

/**
 * Generic HTTP connection adapter (network `conn:<slug>`). Behavior is entirely
 * data-driven from the source's `config` (auth model, base_url, verify probe,
 * recipes) — agents author connections without new compiled code.
 */

export function loadConfig(source: SourceRow): ConnectionConfig {
  return connectionConfigSchema.parse((source as any).config ?? {})
}

async function collectAll(
  ctx: AdapterContext,
  source: SourceRow,
  sink: 'transactions' | 'offers',
): Promise<number> {
  const config = loadConfig(source)
  let total = 0
  for (const recipe of config.recipes) {
    if (recipe.sink !== sink) continue
    const runId = await startRun(ctx, source.id, recipe.name)
    try {
      const res = await runRecipe({ db: ctx.db, broker: ctx.broker }, { id: source.id, config }, recipe)
      total += res.records
      await finishRun(ctx, runId, 'ok', res.records, res.pages)
    } catch (err) {
      await finishRun(ctx, runId, 'error', 0, 0, String(err))
      console.error(`recipe ${source.network}/${recipe.name} failed:`, err)
    }
  }
  return total
}

export const httpAdapter: NetworkAdapter = {
  network: 'http',
  kind: 'affiliate_network',
  displayName: 'Generic HTTP connection',

  capabilities(): Capabilities {
    // Declared per-connection; a superset advertised here.
    return {
      catalog: { search: false, feed: true },
      links: { build: true, subid: 'none' },
      reporting: { transactions: 'api', itemized: true },
    }
  },

  async verify(ctx, source) {
    let config: ConnectionConfig
    try {
      config = loadConfig(source)
    } catch (err) {
      return { ok: false, detail: `invalid connection config: ${err}` }
    }
    if (!config.verify || !config.base_url) {
      return { ok: true, detail: 'stored (no verify probe declared)' }
    }
    try {
      const secrets = ((await ctx.broker.get(source.id)) ?? {}) as Record<string, string>
      const url = new URL(config.base_url.replace(/\/$/, '') + '/' + config.verify.path.replace(/^\//, ''))
      const headers: Record<string, string> = { accept: 'application/json', ...config.headers }
      await applyAuth(ctx.db, source.id, config.auth, secrets, { url, headers }, undefined)
      const res = await httpCall(url, { method: config.verify.method, headers })
      const ok = res.status < config.verify.expect_status_below
      return { ok, detail: `probe ${config.verify.method} → HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async syncCatalog(ctx, source) {
    return { upserted: await collectAll(ctx, source, 'offers') }
  },

  async pollReports(ctx, source) {
    return { observations: await collectAll(ctx, source, 'transactions') }
  },
}

async function startRun(ctx: AdapterContext, sourceId: string, recipe: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `insert into collection_runs (source_id, recipe_name) values ($1,$2) returning id`,
    [sourceId, recipe],
  )
  return rows[0]!.id
}
async function finishRun(
  ctx: AdapterContext,
  id: number,
  status: string,
  records: number,
  pages: number,
  error?: string,
): Promise<void> {
  await ctx.db.query(
    `update collection_runs set finished_at = now(), status = $2, records = $3, pages = $4, error = $5 where id = $1`,
    [id, status, records, pages, error ?? null],
  )
}
