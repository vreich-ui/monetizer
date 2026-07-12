import { randomBytes } from 'node:crypto'
import { createDb, type Db } from '../src/db/client.ts'
import { migrate } from '../src/db/migrate.ts'
import { CredentialBroker } from '../src/core/credentials.ts'
import { createTenant } from '../src/core/tenants.ts'
import { upsertOffer, type OfferUpsert } from '../src/core/offers.ts'
import { ensureSource } from '../src/adapters/registry.ts'
import type { SourceRow } from '../src/adapters/types.ts'
import type { Tenant } from '../src/domain/types.ts'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://monetizer:monetizer@localhost:5432/monetizer_test'

export const TEST_MASTER_KEY = randomBytes(32).toString('base64')

export async function freshDb(): Promise<Db> {
  const db = createDb(TEST_DB_URL)
  await db.query('drop schema public cascade')
  await db.query('create schema public')
  await migrate(db)
  return db
}

export function testBroker(db: Db): CredentialBroker {
  return new CredentialBroker(db, TEST_MASTER_KEY)
}

export async function seedTenant(db: Db, slug = 'testsite'): Promise<{ tenant: Tenant; token: string }> {
  return createTenant(db, {
    slug,
    name: 'Test Site',
    domains: [`${slug}.example.com`],
    tracking_namespaces: { impact: `${slug}-ns`, amazon: `${slug}-20`, csv: `${slug}-ns` },
  })
}

export async function seedSource(db: Db, network = 'csv:test'): Promise<SourceRow> {
  const source = await ensureSource(db, network)
  await db.query(`update sources set status = 'active' where id = $1`, [source.id])
  return source
}

let offerSeq = 0
export async function seedOffer(db: Db, sourceId: string, over: Partial<OfferUpsert> = {}): Promise<string> {
  offerSeq++
  return upsertOffer(db, {
    source_id: sourceId,
    network_offer_id: over.network_offer_id ?? `offer-${offerSeq}`,
    kind: 'affiliate_product',
    merchant: { name: 'Acme Store', slug: 'acme-store' },
    title: `Travel Tripod Deluxe ${offerSeq}`,
    brand: 'Acme',
    description: 'A lightweight carbon travel tripod for cameras',
    taxonomy: { category_path: ['photography'], keywords: ['tripod', 'travel', 'camera'] },
    economics: { type: 'commission_pct', rate: 0.08, currency: 'USD', cookie_window_days: 30 },
    price: { amount: 129.99, currency: 'USD', as_of: new Date().toISOString() },
    constraints: {},
    tracking: {
      link_template: 'https://track.example.com/c/123?u={url_enc}&subId1={click_id}&subId2={tenant_ns}',
      subid_fidelity: 'click',
      destination_url: 'https://acme.example.com/tripod',
    },
    ...over,
  })
}

export const surfaceDecl = (over: Partial<Record<string, unknown>> = {}) => ({
  content_id: 'article-1',
  url_path: '/best-travel-tripods',
  slot_key: 'top-pick',
  slot_type: 'product_box' as const,
  context: {
    intent_class: 'commercial_investigation' as const,
    topic: 'best travel tripod',
    entities: ['tripod'],
    keywords: ['travel', 'camera'],
    locale: 'en-US',
  },
  context_version: '1.0.0',
  ...over,
})

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
