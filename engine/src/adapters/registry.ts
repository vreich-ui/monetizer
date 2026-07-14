import type { Db } from '../db/client.ts'
import type { NetworkAdapter, SourceRow, Capabilities } from './types.ts'
import { impactAdapter } from './impact/index.ts'
import { stripeAdapter } from './stripe/index.ts'
import { csvInboxAdapter } from './csv-inbox/index.ts'
import { amazonAdapter } from './amazon/index.ts'
import { awinAdapter } from './awin/index.ts'
import { cjAdapter } from './cj/index.ts'
import { strackrAdapter } from './strackr/index.ts'
import { httpAdapter } from './http/index.ts'
import { newId } from '../ids.ts'

const ADAPTERS: NetworkAdapter[] = [
  impactAdapter,
  awinAdapter,
  cjAdapter,
  stripeAdapter,
  csvInboxAdapter,
  amazonAdapter,
  strackrAdapter,
  httpAdapter,
]

/**
 * Routing: `direct:`/`csv:` → CSV inbox; `conn:<slug>` → generic HTTP
 * connection (agent-authored, config-driven); otherwise a named adapter.
 */
export function adapterFor(network: string): NetworkAdapter | null {
  if (network.startsWith('direct:') || network.startsWith('csv:')) return csvInboxAdapter
  if (network.startsWith('conn:') || network === 'http') return httpAdapter
  return ADAPTERS.find((a) => a.network === network) ?? null
}

export function knownNetworks(): string[] {
  return [...ADAPTERS.map((a) => a.network), 'direct:<slug>', 'csv:<slug>', 'conn:<slug>']
}

function fidelityFromCaps(caps: Capabilities): 'click' | 'surface' | 'property' | 'account' {
  const subid = caps.links?.subid
  if (subid === 'click') return 'click'
  if (subid === 'surface') return 'surface'
  if (subid === 'property') return 'property'
  return 'account'
}

export async function ensureSource(
  db: Db,
  network: string,
  opts: {
    displayName?: string
    tenantScope?: string | null
    config?: Record<string, unknown>
    kind?: string
  } = {},
): Promise<SourceRow> {
  const adapter = adapterFor(network)
  if (!adapter) throw new Error(`unknown network '${network}' (known: ${knownNetworks().join(', ')})`)
  const caps = adapter.capabilities()
  const { rows } = await db.query<SourceRow>(
    `insert into sources (id, network, kind, display_name, tenant_scope, capabilities, attribution_fidelity, reporting, config)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (network, tenant_scope) do update set
       capabilities = excluded.capabilities,
       attribution_fidelity = excluded.attribution_fidelity,
       display_name = excluded.display_name,
       config = case when $9::jsonb = '{}'::jsonb then sources.config else $9::jsonb end
     returning *`,
    [
      newId(),
      network,
      opts.kind ?? adapter.kind,
      opts.displayName ?? adapter.displayName,
      opts.tenantScope ?? null,
      JSON.stringify(caps),
      fidelityFromCaps(caps),
      JSON.stringify(caps.reporting ?? {}),
      JSON.stringify(opts.config ?? {}),
    ],
  )
  return rows[0]!
}

export async function getSource(db: Db, id: string): Promise<SourceRow | null> {
  const { rows } = await db.query<SourceRow>(`select * from sources where id = $1`, [id])
  return rows[0] ?? null
}

export async function listSources(db: Db): Promise<SourceRow[]> {
  const { rows } = await db.query<SourceRow>(`select * from sources order by created_at`)
  return rows
}
