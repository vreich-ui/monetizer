import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Db } from '../db/client.ts'
import { CredentialBroker } from '../core/credentials.ts'
import { createTenant, getTenantBySlug, updateTenantNamespaces } from '../core/tenants.ts'
import { searchOffers, setLifecycle } from '../core/offers.ts'
import { explainDecision } from '../decision/service.ts'
import { performanceReport } from '../core/performance.ts'
import { adapterFor, ensureSource, getSource, listSources } from '../adapters/registry.ts'
import { enqueue } from '../jobs/queue.ts'
import { newId } from '../ids.ts'

/**
 * MCP control plane (docs/plan/02 §MCP surface), as a factory so the SAME tool
 * set is served over stdio (local operator) and over authenticated Streamable
 * HTTP (agentic remote control — see http/mcp.ts). This is the surface agents
 * use to administer network adapters, credentials, tenants and offers.
 */
export interface McpDeps {
  db: Db
  broker: CredentialBroker
  publicBaseUrl: string
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })

export function createMcpServer({ db, broker, publicBaseUrl }: McpDeps): McpServer {
  const server = new McpServer({ name: 'monetizer', version: '0.1.0' })

  server.tool(
    'register_tenant',
    'Register a content property. Returns the tenant API token (shown once) for its resolve calls.',
    {
      slug: z.string().min(2).max(60),
      name: z.string().min(1).max(200),
      domains: z.array(z.string()).default([]),
      netlify_build_hook_url: z.string().url().optional(),
      tracking_namespaces: z.record(z.string()).default({}),
    },
    async (args) => {
      const existing = await getTenantBySlug(db, args.slug)
      if (existing) return text({ error: `tenant '${args.slug}' already exists` })
      const { tenant, token } = await createTenant(db, args)
      return text({ tenant_id: tenant.id, slug: tenant.slug, token, note: 'store this token; it is not retrievable' })
    },
  )

  server.tool(
    'set_tenant_tracking',
    'Set per-network tracking namespaces for a tenant (e.g. amazon tracking ID "mysite-20", impact subid prefix).',
    { slug: z.string(), namespaces: z.record(z.string()) },
    async (args) => {
      const tenant = await getTenantBySlug(db, args.slug)
      if (!tenant) return text({ error: 'unknown tenant' })
      await updateTenantNamespaces(db, tenant.id, args.namespaces)
      return text({ ok: true })
    },
  )

  server.tool(
    'register_credential',
    'The credential handoff: store network credentials and immediately verify them. ' +
      'Secrets by network — impact: {account_sid, auth_token}; awin: {api_token, publisher_id}; ' +
      'cj: {personal_access_token, company_id}; stripe: {api_key, webhook_secret}; ' +
      'strackr: {api_id, api_key}; amazon (tag-link mode): none needed; csv/direct sources: none needed.',
    {
      network: z.string().describe('impact | awin | cj | stripe | strackr | amazon | csv:<slug> | direct:<slug>'),
      secrets: z.record(z.unknown()).default({}),
      display_name: z.string().optional(),
    },
    async (args) => {
      const source = await ensureSource(db, args.network, { displayName: args.display_name })
      if (Object.keys(args.secrets).length > 0) {
        await broker.store(source.id, 'api_key', args.secrets as Record<string, unknown>)
      }
      const adapter = adapterFor(args.network)!
      const result = await adapter.verify({ db, broker }, source)
      await broker.markVerified(source.id, result.ok).catch(() => {})
      await db.query(
        `update sources set status = $2, health = health || jsonb_build_object('last_verify', now()::text, 'verify_detail', $3::text) where id = $1`,
        [source.id, result.ok ? 'active' : 'error', result.detail],
      )
      if (result.ok && adapter.syncCatalog) {
        await enqueue(db, 'catalog_sync', { source_id: source.id }, { dedupe: true })
      }
      return text({
        source_id: source.id,
        network: source.network,
        verified: result.ok,
        detail: result.detail,
        webhook_url: adapter.handleWebhook ? `${publicBaseUrl}/v1/webhooks/${source.id}` : undefined,
        catalog_sync: result.ok && adapter.syncCatalog ? 'queued' : 'n/a',
      })
    },
  )

  server.tool('list_sources', 'List all sources with capabilities and health.', {}, async () => {
    const sources = await listSources(db)
    return text(
      sources.map((s) => ({
        id: s.id,
        network: s.network,
        status: s.status,
        fidelity: s.attribution_fidelity,
        capabilities: s.capabilities,
        health: s.health,
      })),
    )
  })

  server.tool(
    'ingest_csv',
    'Drop a CSV for a feed/no-API source. drop_kind offers columns map via mapping ' +
      '(our-field -> CSV column): title,url,price,id,brand,description,image_url,category,keywords,' +
      'commission_rate,currency,merchant,link_template. drop_kind transactions: network_txn_id,' +
      'commission_amount,txn_time,subid,tracking_key,program_ref,order_amount,currency,status. ' +
      'mapping._defaults is a JSON string of constant fields.',
    {
      source_id: z.string(),
      drop_kind: z.enum(['offers', 'transactions']),
      csv: z.string().max(5_000_000),
      mapping: z.record(z.string()),
      filename: z.string().optional(),
    },
    async (args) => {
      const source = await getSource(db, args.source_id)
      if (!source) return text({ error: 'unknown source' })
      const id = newId()
      await db.query(
        `insert into csv_drops (id, source_id, drop_kind, filename, content, mapping) values ($1,$2,$3,$4,$5,$6)`,
        [id, args.source_id, args.drop_kind, args.filename ?? null, args.csv, JSON.stringify(args.mapping)],
      )
      await enqueue(db, 'process_csv_drops', {}, { dedupe: true })
      return text({ drop_id: id, status: 'queued' })
    },
  )

  server.tool(
    'search_offers',
    'Search the normalized offer store.',
    { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    async (args) => {
      const offers = await searchOffers(db, args.query, args.limit)
      return text(
        offers.map((o) => ({
          id: o.id,
          title: o.title,
          merchant: o.merchant.name,
          kind: o.kind,
          price: o.price,
          economics: o.economics,
          lifecycle: o.lifecycle,
          subid_fidelity: o.tracking.subid_fidelity,
        })),
      )
    },
  )

  server.tool(
    'explain_decision',
    'Full candidate set, scores, policy version and propensity for a decision — the audit tool.',
    { decision_id: z.string() },
    async (args) => text((await explainDecision(db, args.decision_id)) ?? { error: 'unknown decision' }),
  )

  server.tool(
    'performance',
    'Traffic and revenue rollups with state + attribution-resolution qualifiers.',
    { tenant_slug: z.string().optional(), days: z.number().int().min(1).max(365).default(30) },
    async (args) => text(await performanceReport(db, { tenantSlug: args.tenant_slug, days: args.days })),
  )

  server.tool(
    'demand_signals',
    'Unmatched monetization demand (surfaces no offer could serve) for the content side.',
    { limit: z.number().int().min(1).max(200).default(50) },
    async (args) => {
      const { rows } = await db.query(
        `select category, entities, reason, count(*)::int as occurrences, max(created_at) as latest
           from demand_signals group by 1,2,3 order by occurrences desc limit $1`,
        [args.limit],
      )
      return text(rows)
    },
  )

  server.tool(
    'trigger_rebuild',
    'Trigger a Netlify rebuild for a tenant (debounced).',
    { tenant_slug: z.string() },
    async (args) => {
      const tenant = await getTenantBySlug(db, args.tenant_slug)
      if (!tenant) return text({ error: 'unknown tenant' })
      await enqueue(db, 'rebuild_tenant', { tenant_id: tenant.id }, { dedupe: true, runAt: new Date(Date.now() + 60_000) })
      return text({ ok: true, note: 'rebuild queued (60s debounce)' })
    },
  )

  server.tool(
    'pause_offer',
    'Pause or reactivate an offer.',
    { offer_id: z.string(), action: z.enum(['pause', 'activate']) },
    async (args) => {
      await setLifecycle(db, args.offer_id, args.action === 'pause' ? 'paused' : 'active', 'mcp')
      return text({ ok: true })
    },
  )

  server.tool(
    'pause_source',
    'Pause or reactivate a source (all its offers stop being chosen; existing links failover).',
    { source_id: z.string(), action: z.enum(['pause', 'activate']) },
    async (args) => {
      await db.query(`update sources set status = $2 where id = $1`, [
        args.source_id,
        args.action === 'pause' ? 'paused' : 'active',
      ])
      if (args.action === 'pause') {
        await db.query(`update offers set lifecycle = 'paused' where source_id = $1 and lifecycle = 'active'`, [args.source_id])
      }
      return text({ ok: true })
    },
  )

  return server
}
