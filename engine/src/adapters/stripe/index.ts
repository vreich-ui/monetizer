import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AdapterContext, Capabilities, NetworkAdapter, SourceRow } from '../types.ts'
import { recordObservation } from '../types.ts'
import { upsertOffer } from '../../core/offers.ts'

/**
 * Stripe — digital products (docs/plan/03). The best-instrumented source:
 * click-fidelity via Payment Link `client_reference_id`, instant webhook
 * conversions, near-zero mutation window (refunds only).
 *
 * Credentials: { api_key, webhook_secret }.
 */

const BASE = 'https://api.stripe.com/v1'

async function stripeReq(
  ctx: AdapterContext,
  source: SourceRow,
  method: 'GET' | 'POST',
  path: string,
  body?: URLSearchParams,
): Promise<any> {
  const creds = await ctx.broker.get(source.id)
  if (!creds?.api_key) throw new Error(`stripe: no credentials for source ${source.id}`)
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  })
  if (!res.ok) throw new Error(`stripe ${path}: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`)
  return res.json()
}

export function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string, toleranceS = 300): boolean {
  const parts = Object.fromEntries(
    sigHeader.split(',').map((kv) => kv.split('=', 2) as [string, string]),
  )
  const t = Number(parts['t'])
  const v1 = parts['v1']
  if (!t || !v1) return false
  if (Math.abs(Date.now() / 1000 - t) > toleranceS) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(v1)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const stripeAdapter: NetworkAdapter = {
  network: 'stripe',
  kind: 'payment_provider',
  displayName: 'Stripe',

  capabilities(): Capabilities {
    return {
      catalog: { search: true },
      links: { build: true, subid: 'click' },
      reporting: { transactions: 'webhook', itemized: true, lag_days_estimate: 0, mutation_window_days: 90 },
    }
  },

  async verify(ctx, source) {
    try {
      await stripeReq(ctx, source, 'GET', '/products?limit=1')
      return { ok: true, detail: 'authenticated' }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async syncCatalog(ctx, source) {
    let upserted = 0
    const products = await stripeReq(ctx, source, 'GET', '/products?active=true&limit=100&expand[]=data.default_price')
    // Existing payment links, mapped by price id, so we only create when missing.
    const links = await stripeReq(ctx, source, 'GET', '/payment_links?active=true&limit=100')
    const linkByPrice = new Map<string, string>()
    for (const pl of links?.data ?? []) {
      const items = await stripeReq(ctx, source, 'GET', `/payment_links/${pl.id}/line_items?limit=10`)
      for (const li of items?.data ?? []) {
        if (li.price?.id) linkByPrice.set(li.price.id, pl.url)
      }
    }
    for (const p of products?.data ?? []) {
      const price = p.default_price
      if (!price?.id || price.unit_amount == null) continue
      let linkUrl = linkByPrice.get(price.id)
      if (!linkUrl) {
        const body = new URLSearchParams()
        body.set('line_items[0][price]', price.id)
        body.set('line_items[0][quantity]', '1')
        body.set('metadata[monetizer]', '1')
        const created = await stripeReq(ctx, source, 'POST', '/payment_links', body)
        linkUrl = created.url as string
      }
      await upsertOffer(ctx.db, {
        source_id: source.id,
        network_offer_id: p.id,
        kind: 'digital_product',
        merchant: { name: 'Direct', slug: 'shop', domain: undefined },
        title: String(p.name),
        description: p.description ? String(p.description) : null,
        image_url: p.images?.[0] ?? null,
        taxonomy: { keywords: p.metadata?.keywords ? String(p.metadata.keywords).split(',') : [] },
        economics: {
          type: 'sale_margin',
          amount: price.unit_amount / 100, // digital goods: margin ≈ price
          currency: String(price.currency ?? 'usd').toUpperCase(),
        },
        price: {
          amount: price.unit_amount / 100,
          currency: String(price.currency ?? 'usd').toUpperCase(),
          as_of: new Date().toISOString(),
        },
        constraints: {},
        tracking: {
          link_template: `${linkUrl}?client_reference_id={click_id}`,
          subid_fidelity: 'click',
        },
      })
      upserted++
    }
    return { upserted }
  },

  async handleWebhook(ctx, source, req) {
    const creds = await ctx.broker.get(source.id)
    const secret = creds?.webhook_secret as string | undefined
    const sig = req.headers['stripe-signature']
    if (!secret || !sig || !verifyStripeSignature(req.rawBody, sig, secret)) {
      throw new Error('stripe webhook: signature verification failed')
    }
    const event = JSON.parse(req.rawBody)
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object
      await recordObservation(ctx.db, {
        source_id: source.id,
        network_txn_id: String(s.id),
        network_txn_time: new Date((s.created ?? Date.now() / 1000) * 1000).toISOString(),
        subid_echo: s.client_reference_id ? String(s.client_reference_id) : null,
        order_amount: s.amount_total != null ? s.amount_total / 100 : null,
        commission_amount: s.amount_total != null ? s.amount_total / 100 : 0,
        currency: String(s.currency ?? 'usd').toUpperCase(),
        network_status: 'completed',
        status_norm: 'approved',
        raw: { id: s.id, payment_intent: s.payment_intent },
      })
      return { observations: 1 }
    }
    if (event.type === 'charge.refunded') {
      const c = event.data.object
      // Reversal keyed to the originating checkout session when recoverable.
      const sessionId = c.metadata?.checkout_session_id ?? c.payment_intent ?? c.id
      await recordObservation(ctx.db, {
        source_id: source.id,
        network_txn_id: String(sessionId),
        network_txn_time: new Date((c.created ?? Date.now() / 1000) * 1000).toISOString(),
        order_amount: c.amount_refunded != null ? c.amount_refunded / 100 : null,
        commission_amount: 0,
        currency: String(c.currency ?? 'usd').toUpperCase(),
        network_status: 'refunded',
        status_norm: 'reversed',
        raw: { id: c.id, payment_intent: c.payment_intent },
      })
      return { observations: 1 }
    }
    return { observations: 0 }
  },
}
