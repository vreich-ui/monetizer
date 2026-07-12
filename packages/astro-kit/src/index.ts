import type { SurfaceDeclaration } from '@monetizer/context-taxonomy'

/**
 * Build-time resolve client (docs/plan/02). Fail-open by design: a build must
 * never hard-fail because the engine is unreachable — monetization degrades,
 * content ships.
 *
 * Usage in an Astro page/component:
 *   const res = await resolveSurfaces({ surfaces: [...] })
 *   const box = res.bySlot('article-123', 'top-pick')
 */

export interface ResolvedOffer {
  rank: number
  offer_id: string
  title: string
  brand?: string | null
  image_url?: string | null
  price?: { amount: number; currency: string; as_of: string } | null
  cta_text: string
  href: string
  merchant: string
  disclosure?: string
}

export interface ResolvedSurface {
  surface_id: string
  decision_id: string
  offers: ResolvedOffer[]
  ttl_s: number
}

export interface ResolveResult {
  decisions: ResolvedSurface[]
  page_disclosures: string[]
  bySlot(contentId: string, slotKey: string): ResolvedSurface | undefined
}

export interface MonetizerConfig {
  engineUrl?: string // MONETIZER_ENGINE_URL
  tenantToken?: string // MONETIZER_TENANT_TOKEN
  buildId?: string // MONETIZER_BUILD_ID (defaults to Netlify BUILD_ID)
  timeoutMs?: number
}

const surfaceIdOf = new Map<string, string>() // `${content_id}|${slot_key}` -> surface_id

export async function resolveSurfaces(
  opts: MonetizerConfig & { surfaces: SurfaceDeclaration[] },
): Promise<ResolveResult> {
  const engineUrl = opts.engineUrl ?? process.env.MONETIZER_ENGINE_URL
  const token = opts.tenantToken ?? process.env.MONETIZER_TENANT_TOKEN
  const buildId = opts.buildId ?? process.env.MONETIZER_BUILD_ID ?? process.env.BUILD_ID

  const empty: ResolveResult = { decisions: [], page_disclosures: [], bySlot: () => undefined }
  if (!engineUrl || !token) {
    console.warn('[monetizer] MONETIZER_ENGINE_URL / MONETIZER_TENANT_TOKEN not set; rendering without offers')
    return empty
  }

  try {
    const res = await fetch(`${engineUrl.replace(/\/$/, '')}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ build_id: buildId, surfaces: opts.surfaces }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { decisions: ResolvedSurface[]; page_disclosures: string[] }

    // Deterministic surface ids come back from the engine; index by declaration.
    const byKey = new Map<string, ResolvedSurface>()
    for (let i = 0; i < opts.surfaces.length && i < data.decisions.length; i++) {
      const decl = opts.surfaces[i]!
      const d = data.decisions[i]!
      const key = `${decl.content_id}|${decl.slot_key}`
      surfaceIdOf.set(key, d.surface_id)
      byKey.set(key, d)
    }
    return {
      decisions: data.decisions,
      page_disclosures: data.page_disclosures ?? [],
      bySlot: (contentId, slotKey) => byKey.get(`${contentId}|${slotKey}`),
    }
  } catch (err) {
    console.warn('[monetizer] resolve failed, rendering without offers:', err)
    return empty
  }
}

/** Script tag to inject once per layout; serves the engine-hosted beacon. */
export function beaconSnippet(engineUrl: string): string {
  const base = engineUrl.replace(/\/$/, '')
  return `<script defer src="${base}/beacon.js" data-engine="${base}"></script>`
}
