import { surfaceDeclarationSchema, type SurfaceDeclaration } from '@monetizer/context-taxonomy'
import type { Db } from '../db/client.ts'
import type { Surface } from '../domain/types.ts'
import { surfaceId } from '../ids.ts'

export async function upsertSurface(
  db: Db,
  tenantId: string,
  decl: SurfaceDeclaration,
): Promise<Surface> {
  const parsed = surfaceDeclarationSchema.parse(decl)
  const id = surfaceId(tenantId, parsed.content_id, parsed.slot_key)
  await db.query(
    `insert into surfaces (id, tenant_id, content_id, slot_key, url_path, slot_type, context, context_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (tenant_id, content_id, slot_key) do update set
       url_path = excluded.url_path,
       slot_type = excluded.slot_type,
       context = excluded.context,
       context_version = excluded.context_version,
       status = 'active',
       updated_at = now()`,
    [
      id,
      tenantId,
      parsed.content_id,
      parsed.slot_key,
      parsed.url_path,
      parsed.slot_type,
      JSON.stringify(parsed.context),
      parsed.context_version,
    ],
  )
  const { rows } = await db.query<Surface>(`select * from surfaces where id = $1`, [id])
  return rows[0]!
}

export async function getSurface(db: Db, id: string): Promise<Surface | null> {
  const { rows } = await db.query<Surface>(`select * from surfaces where id = $1`, [id])
  return rows[0] ?? null
}
