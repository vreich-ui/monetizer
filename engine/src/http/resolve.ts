import { Hono } from 'hono'
import { z } from 'zod'
import { surfaceDeclarationSchema, TAXONOMY_VERSION } from '@monetizer/context-taxonomy'
import type { Db } from '../db/client.ts'
import { authTenant } from '../core/tenants.ts'
import { resolveSurfaceDecl, DEFAULT_PAGE_DISCLOSURE, type ResolvedSurface } from '../decision/service.ts'
import type { DecisionPolicy } from '../decision/policy.ts'

const resolveBody = z.object({
  build_id: z.string().max(200).optional(),
  surfaces: z.array(surfaceDeclarationSchema).min(1).max(500),
})

interface ResolveDeps {
  db: Db
  policy: DecisionPolicy
  redirectBase: string
}

export function resolveRoutes(deps: ResolveDeps): Hono {
  const app = new Hono()

  app.post('/v1/resolve', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return c.json({ error: 'missing tenant token' }, 401)
    const tenant = await authTenant(deps.db, token)
    if (!tenant) return c.json({ error: 'invalid tenant token' }, 401)

    const parsed = resolveBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400)

    const decisions: ResolvedSurface[] = []
    const unresolved: string[] = []
    for (const decl of parsed.data.surfaces) {
      try {
        const resolved = await resolveSurfaceDecl(deps.db, {
          tenant,
          decl,
          buildId: parsed.data.build_id,
          policy: deps.policy,
          redirectBase: deps.redirectBase,
        })
        decisions.push(resolved)
        if (resolved.offers.length === 0) unresolved.push(resolved.surface_id)
      } catch (err) {
        console.error('resolve failed for surface', decl.content_id, decl.slot_key, err)
        unresolved.push(`${decl.content_id}:${decl.slot_key}`)
      }
    }

    return c.json({
      decisions,
      page_disclosures: [DEFAULT_PAGE_DISCLOSURE],
      coverage: {
        resolved: decisions.filter((d) => d.offers.length > 0).length,
        unresolved,
      },
      taxonomy_version_expected: TAXONOMY_VERSION,
    })
  })

  return app
}
