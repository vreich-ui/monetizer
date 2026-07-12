import type { SurfaceContext } from '@monetizer/context-taxonomy'
import type { Offer } from '../domain/types.ts'

/**
 * v1 relevance: lexical overlap between surface context and offer text/taxonomy.
 * Deliberately simple and dependency-free; the upgrade path is an embedding
 * scorer (pgvector) behind this same signature (docs/plan/06).
 */

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'best'])

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  )
}

export function surfaceTerms(ctx: SurfaceContext): string[] {
  return [ctx.topic, ...(ctx.entities ?? []), ...(ctx.keywords ?? [])]
}

export function relevanceScore(offer: Offer, ctx: SurfaceContext): number {
  const surfaceTokens = tokenize(surfaceTerms(ctx).join(' '))
  const offerTokens = tokenize(
    [
      offer.title,
      offer.brand ?? '',
      offer.description ?? '',
      ...(offer.taxonomy.category_path ?? []),
      ...(offer.taxonomy.entities ?? []),
      ...(offer.taxonomy.keywords ?? []),
    ].join(' '),
  )
  if (surfaceTokens.size === 0 || offerTokens.size === 0) return 0
  let hits = 0
  for (const t of surfaceTokens) if (offerTokens.has(t)) hits++
  // Overlap relative to the surface's vocabulary (the query side), softened.
  const overlap = hits / Math.min(surfaceTokens.size, 8)
  return Math.min(1, overlap)
}
