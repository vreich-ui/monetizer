import { describe, expect, it } from 'vitest'
import { HeuristicPolicy, DEFAULT_PARAMS, seededRandom } from '../src/decision/policy.ts'
import type { Offer } from '../src/domain/types.ts'

const ctx = {
  intent_class: 'commercial_investigation' as const,
  topic: 'best travel tripod',
  entities: ['tripod'],
  keywords: ['travel'],
  locale: 'en-US',
}

let n = 0
const offer = (over: Partial<Offer> = {}): Offer => ({
  id: `o${++n}`,
  source_id: 's1',
  network_offer_id: `n${n}`,
  kind: 'affiliate_product',
  merchant: { name: 'M', slug: 'm' },
  title: 'Travel tripod for cameras',
  taxonomy: { keywords: ['tripod', 'travel'] },
  economics: { type: 'commission_pct', rate: 0.08, currency: 'USD' },
  price: { amount: 100, currency: 'USD', as_of: new Date().toISOString() },
  constraints: {},
  tracking: { link_template: 'https://x/{click_id}', subid_fidelity: 'click' },
  lifecycle: 'active',
  ...over,
})

describe('HeuristicPolicy', () => {
  it('logs candidates, policy identity and propensity on every selection', () => {
    const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0 })
    const sel = policy.select({
      surfaceId: 'sfc',
      slotType: 'product_box',
      context: ctx,
      offers: [offer(), offer(), offer()],
      seed: 'fixed',
    })
    expect(sel.candidates.length).toBe(3)
    expect(sel.candidates[0]!.components).toHaveProperty('relevance')
    expect(sel.chosen.length).toBe(1)
    expect(sel.propensity).toBe(1 - 0 + 0 / 3) // greedy with ε=0 → 1
    expect(policy.name).toBe('heuristic')
    expect(policy.paramsHash).toHaveLength(12)
  })

  it('is deterministic for a fixed seed', () => {
    const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0.5 })
    const offers = [offer(), offer(), offer(), offer()]
    const a = policy.select({ surfaceId: 's', slotType: 'product_box', context: ctx, offers, seed: 'seed-1' })
    const b = policy.select({ surfaceId: 's', slotType: 'product_box', context: ctx, offers, seed: 'seed-1' })
    expect(a.chosen).toEqual(b.chosen)
    expect(a.propensity).toBe(b.propensity)
  })

  it('assigns ε-greedy propensities correctly', () => {
    // With ε=1 every selection is an explore draw from the pool.
    const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 1, explorePool: 4 })
    const offers = [offer(), offer(), offer(), offer()]
    const seen = new Set<number>()
    for (let i = 0; i < 40; i++) {
      const sel = policy.select({ surfaceId: 's', slotType: 'product_box', context: ctx, offers, seed: `s${i}` })
      expect(sel.explore).toBe(true)
      seen.add(sel.propensity)
      // explored non-head: ε/N = 1/4; greedy head redrawn: 1-ε+ε/N = 1/4 too when ε=1
      expect(sel.propensity).toBeCloseTo(0.25)
    }
    expect(seen.size).toBe(1)
  })

  it('chooses nothing when no offer clears the floor (empty slot beats bad offer)', () => {
    const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0 })
    const irrelevant = offer({ title: 'Industrial paint thinner', taxonomy: { keywords: ['paint'] }, description: null })
    const sel = policy.select({ surfaceId: 's', slotType: 'product_box', context: ctx, offers: [irrelevant] })
    expect(sel.chosen).toEqual([])
    expect(sel.propensity).toBe(1)
  })

  it('picks k offers for comparison tables', () => {
    const policy = new HeuristicPolicy({ ...DEFAULT_PARAMS, epsilon: 0 })
    const sel = policy.select({
      surfaceId: 's',
      slotType: 'comparison_table',
      context: ctx,
      offers: [offer(), offer(), offer(), offer(), offer()],
    })
    expect(sel.chosen.length).toBe(3)
    expect(sel.chosen.map((c) => c.rank)).toEqual([1, 2, 3])
  })

  it('seededRandom is stable', () => {
    const a = seededRandom('x')
    const b = seededRandom('x')
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})
