import { randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'
import type { Tenant } from '../domain/types.ts'
import { newId, sha256hex } from '../ids.ts'

export async function createTenant(
  db: Db,
  input: {
    slug: string
    name: string
    domains?: string[]
    netlify_build_hook_url?: string
    tracking_namespaces?: Record<string, string>
  },
): Promise<{ tenant: Tenant; token: string }> {
  const id = newId()
  const token = `mzt_${randomBytes(24).toString('hex')}`
  await db.query(
    `insert into tenants (id, slug, name, domains, netlify_build_hook_url, tracking_namespaces, token_hash)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.slug,
      input.name,
      input.domains ?? [],
      input.netlify_build_hook_url ?? null,
      JSON.stringify(input.tracking_namespaces ?? {}),
      sha256hex(token),
    ],
  )
  const tenant = await getTenantBySlug(db, input.slug)
  if (!tenant) throw new Error('tenant creation failed')
  return { tenant, token }
}

export async function getTenantBySlug(db: Db, slug: string): Promise<Tenant | null> {
  const { rows } = await db.query<Tenant>(`select * from tenants where slug = $1`, [slug])
  return rows[0] ?? null
}

export async function getTenantById(db: Db, id: string): Promise<Tenant | null> {
  const { rows } = await db.query<Tenant>(`select * from tenants where id = $1`, [id])
  return rows[0] ?? null
}

export async function authTenant(db: Db, token: string): Promise<Tenant | null> {
  const { rows } = await db.query<Tenant>(
    `select * from tenants where token_hash = $1 and status = 'active'`,
    [sha256hex(token)],
  )
  return rows[0] ?? null
}

export async function updateTenantNamespaces(
  db: Db,
  tenantId: string,
  namespaces: Record<string, string>,
): Promise<void> {
  await db.query(
    `update tenants set tracking_namespaces = tracking_namespaces || $2::jsonb where id = $1`,
    [tenantId, JSON.stringify(namespaces)],
  )
}
