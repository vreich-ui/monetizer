import type { SurfaceContext, SlotType } from '@monetizer/context-taxonomy'
import type { Candidate, Chosen, Offer, ScoreComponents } from '../domain/types.ts'
import { sha256hex } from '../ids.ts'
import { relevanceScore } from './relevance.ts'

/**
 * DecisionPolicy (docs/plan/01 §Decision): the future learning layer replaces
 * the implementation behind this interface. The contract that CANNOT change:
 * every selection returns the considered candidates with scores, the policy
 * identity, and the propensity of the chosen head.
 */
export interface PolicySelection {
  candidates: Candidate[]
  chosen: Chosen[]
  propensity: number
  explore: boolean
  seed: string
}

export interface DecisionPolicy {
  readonly name: string
  readonly version: string
  readonly paramsHash: string
  select(input: {
    surfaceId: string
    slotType: SlotType
    context: SurfaceContext
    offers: Offer[]
    seed?: string
  }): PolicySelection
}

export interface HeuristicParams {
  epsilon: number // exploration rate
  relevanceFloor: number // mismatch gate: below this, an empty slot beats the offer
  scoreFloor: number // total-score gate (post cvr_prior, hence small)
  explorePool: number // top-N pool eligible for exploration
  weights: { relevance: number; econ: number; freshness: number }
  econSquashUsd: number // k in v/(v+k)
  cvrPriors: Record<string, number> // by offer kind
}

export const DEFAULT_PARAMS: HeuristicParams = {
  epsilon: 0.1,
  relevanceFloor: 0.1,
  scoreFloor: 0.0002,
  explorePool: 5,
  weights: { relevance: 1, econ: 1, freshness: 1 },
  econSquashUsd: 20,
  cvrPriors: {
    affiliate_product: 0.03,
    affiliate_program_cta: 0.01,
    digital_product: 0.01,
    donation: 0.002,
  },
}

const K_BY_SLOT: Partial<Record<SlotType, number>> = { comparison_table: 3 }

/** Deterministic PRNG (mulberry32) from a string seed — reproducible explores. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = h >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function expectedCommissionUsd(offer: Offer): number {
  const e = offer.economics
  const priceOrAov = offer.price?.amount ?? e.aov_estimate ?? 50
  switch (e.type) {
    case 'commission_pct':
      return (e.rate ?? 0) * priceOrAov
    case 'commission_fixed':
      return e.amount ?? 0
    case 'sale_margin':
      return e.amount ?? offer.price?.amount ?? 0
    case 'donation':
      return e.amount ?? 3
  }
}

export function scoreOffer(offer: Offer, ctx: SurfaceContext, p: HeuristicParams): ScoreComponents & { total: number } {
  const relevance = relevanceScore(offer, ctx)
  const ecUsd = expectedCommissionUsd(offer)
  const econ_value = ecUsd / (ecUsd + p.econSquashUsd)
  let freshness = 1
  if (offer.price?.as_of) {
    const ageDays = (Date.now() - new Date(offer.price.as_of).getTime()) / 86_400_000
    freshness = Math.exp(-Math.max(0, ageDays) / 30)
  } else if (offer.kind === 'affiliate_product') {
    freshness = 0.7 // product without a price snapshot: usable but penalized
  }
  const cvr_prior = p.cvrPriors[offer.kind] ?? 0.01
  const total =
    Math.pow(relevance, p.weights.relevance) *
    Math.pow(econ_value, p.weights.econ) *
    Math.pow(freshness, p.weights.freshness) *
    cvr_prior
  return { relevance, econ_value, freshness, cvr_prior, total }
}

export class HeuristicPolicy implements DecisionPolicy {
  readonly name = 'heuristic'
  readonly version = '1.0.0'
  readonly paramsHash: string

  constructor(private params: HeuristicParams = DEFAULT_PARAMS) {
    this.paramsHash = sha256hex(JSON.stringify(params)).slice(0, 12)
  }

  select({
    surfaceId,
    slotType,
    context,
    offers,
    seed,
  }: Parameters<DecisionPolicy['select']>[0]): PolicySelection {
    const p = this.params
    const theSeed = seed ?? `${surfaceId}:${Date.now()}`
    const rand = seededRandom(theSeed)

    const scored = offers
      .map((o) => {
        const s = scoreOffer(o, context, p)
        const { total, ...components } = s
        return { offer_id: o.id, score: total, components } satisfies Candidate
      })
      .sort((a, b) => b.score - a.score)

    const eligible = scored.filter(
      (c) => c.components['relevance']! >= p.relevanceFloor && c.score >= p.scoreFloor,
    )
    const candidates = scored.slice(0, 20) // logged consideration set

    if (eligible.length === 0) {
      // An empty slot beats a bad offer (docs/plan/02). Propensity 1: the
      // policy chooses "nothing" deterministically.
      return { candidates, chosen: [], propensity: 1, explore: false, seed: theSeed }
    }

    const k = K_BY_SLOT[slotType] ?? 1
    const pool = eligible.slice(0, Math.max(p.explorePool, k))
    const n = pool.length

    let explore = false
    let head = pool[0]!
    if (n > 1 && rand() < p.epsilon) {
      explore = true
      head = pool[Math.floor(rand() * n)]!
    }
    // ε-greedy propensity of the head slot:
    //   greedy head:      (1 - ε) + ε/N   (kept, or re-drawn by exploration)
    //   explored member:  ε/N
    const isGreedyHead = head.offer_id === pool[0]!.offer_id
    const propensity = n <= 1 ? 1 : isGreedyHead ? 1 - p.epsilon + p.epsilon / n : p.epsilon / n

    const rest = eligible.filter((c) => c.offer_id !== head.offer_id)
    const chosen: Chosen[] = [head, ...rest]
      .slice(0, k)
      .map((c, i) => ({ offer_id: c.offer_id, rank: i + 1 }))

    return { candidates, chosen, propensity, explore, seed: theSeed }
  }
}
