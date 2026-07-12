import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '../src/db/client.ts'
import { freshDb, seedOffer, seedSource, seedTenant, surfaceDecl } from './helpers.ts'
import { appendEvent } from '../src/core/events.ts'
import { recordObservation } from '../src/adapters/types.ts'
import { runAttribution } from '../src/attribution/resolver.ts'
import { upsertSurface } from '../src/core/surfaces.ts'
import { newId } from '../src/ids.ts'
import type { Tenant } from '../src/domain/types.ts'
import type { SourceRow } from '../src/adapters/types.ts'

let db: Db
let tenant: Tenant
let source: SourceRow
let decisionId: string

async function seedDecisionWithClick(clickId: string, tenantId: string, occurredAt = new Date()) {
  const surface = await upsertSurface(db, tenantId, surfaceDecl({ content_id: `a-${clickId}` }) as any)
  const offerId = await seedOffer(db, source.id)
  const dId = newId()
  await db.query(
    `insert into decisions (id, surface_id, tenant_id, policy, candidates, chosen, propensity)
     values ($1,$2,$3,'{"name":"h","version":"1","params_hash":"x"}','[]','[]',1)`,
    [dId, surface.id, tenantId],
  )
  await appendEvent(db, {
    type: 'click',
    occurred_at: occurredAt,
    tenant_id: tenantId,
    surface_id: surface.id,
    decision_id: dId,
    offer_id: offerId,
    source_id: source.id,
    click_id: clickId,
  })
  return dId
}

beforeAll(async () => {
  db = await freshDb()
  ;({ tenant } = await seedTenant(db))
  source = await seedSource(db)
})

afterAll(async () => {
  await db.close()
})

describe('attribution resolver', () => {
  it('joins at click level via subid echo, writes accrual ledger entry', async () => {
    decisionId = await seedDecisionWithClick('CLICK111', tenant.id)
    await recordObservation(db, {
      source_id: source.id,
      network_txn_id: 'TXN-1',
      network_txn_time: new Date().toISOString(),
      subid_echo: 'CLICK111',
      commission_amount: 12.5,
      currency: 'USD',
      network_status: 'PENDING',
      status_norm: 'pending',
    })
    const stats = await runAttribution(db)
    expect(stats.conversions_updated).toBeGreaterThanOrEqual(1)

    const { rows: edges } = await db.query(
      `select * from attribution_edges where network_txn_id = 'TXN-1'`,
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].resolution).toBe('click')
    expect(Number(edges[0].weight)).toBe(1)
    expect(edges[0].decision_id).toBe(decisionId)
    expect(edges[0].tenant_id).toBe(tenant.id)

    const { rows: ledger } = await db.query(
      `select * from ledger_entries where network_txn_id = 'TXN-1'`,
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0].entry_type).toBe('accrual')
    expect(Number(ledger[0].amount)).toBe(12.5)
  })

  it('writes reversal ledger entry when a conversion reverses, keeping observations immutable', async () => {
    await recordObservation(db, {
      source_id: source.id,
      network_txn_id: 'TXN-1',
      network_txn_time: new Date().toISOString(),
      subid_echo: 'CLICK111',
      commission_amount: 12.5,
      currency: 'USD',
      network_status: 'REVERSED',
      status_norm: 'reversed',
    })
    await runAttribution(db)

    const { rows: obs } = await db.query(
      `select count(*)::int as n from conversion_observations where network_txn_id = 'TXN-1'`,
    )
    expect(obs[0].n).toBe(2) // both observations retained

    const { rows: conv } = await db.query(
      `select status from conversions where network_txn_id = 'TXN-1'`,
    )
    expect(conv[0].status).toBe('reversed')

    const { rows: ledger } = await db.query(
      `select entry_type, amount from ledger_entries where network_txn_id = 'TXN-1' order by id`,
    )
    expect(ledger.map((l: any) => l.entry_type)).toEqual(['accrual', 'reversal'])
    expect(Number(ledger[1].amount)).toBe(-12.5)
  })

  it('allocates across tenant clicks at property level via tracking key', async () => {
    await seedDecisionWithClick('CLICK-P1', tenant.id)
    await seedDecisionWithClick('CLICK-P2', tenant.id)
    await recordObservation(db, {
      source_id: source.id,
      network_txn_id: 'TXN-2',
      network_txn_time: new Date().toISOString(),
      tracking_key: 'testsite-ns', // matches tenant tracking_namespaces value
      commission_amount: 10,
      currency: 'USD',
      network_status: 'APPROVED',
      status_norm: 'approved',
    })
    await runAttribution(db)

    const { rows: edges } = await db.query(
      `select * from attribution_edges where network_txn_id = 'TXN-2' order by id`,
    )
    // CLICK111 + the two new ones are all this tenant's clicks on this source
    expect(edges.length).toBeGreaterThanOrEqual(3)
    for (const e of edges) {
      expect(e.resolution).toBe('property')
      expect(e.tenant_id).toBe(tenant.id)
    }
    const totalWeight = edges.reduce((s: number, e: any) => s + Number(e.weight), 0)
    expect(totalWeight).toBeCloseTo(1)
  })

  it('falls back to account-level smear with explicit label', async () => {
    await recordObservation(db, {
      source_id: source.id,
      network_txn_id: 'TXN-3',
      network_txn_time: new Date().toISOString(),
      commission_amount: 5,
      currency: 'USD',
      network_status: 'PENDING',
      status_norm: 'pending',
    })
    await runAttribution(db)
    const { rows: edges } = await db.query(
      `select distinct resolution from attribution_edges where network_txn_id = 'TXN-3'`,
    )
    expect(edges.map((e: any) => e.resolution)).toEqual(['account'])
  })

  it('is idempotent: re-running writes no duplicate edges or ledger entries', async () => {
    const before = await db.query(`select count(*)::int as n from attribution_edges`)
    const beforeLedger = await db.query(`select count(*)::int as n from ledger_entries`)
    await runAttribution(db)
    const after = await db.query(`select count(*)::int as n from attribution_edges`)
    const afterLedger = await db.query(`select count(*)::int as n from ledger_entries`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
    expect(afterLedger.rows[0].n).toBe(beforeLedger.rows[0].n)
  })
})
