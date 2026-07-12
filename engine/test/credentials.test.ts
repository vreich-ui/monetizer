import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { Db } from '../src/db/client.ts'
import { freshDb, seedSource } from './helpers.ts'
import { CredentialBroker } from '../src/core/credentials.ts'

let db: Db

beforeAll(async () => {
  db = await freshDb()
})

afterAll(async () => {
  await db.close()
})

describe('CredentialBroker', () => {
  it('round-trips secrets through encrypted storage', async () => {
    const key = randomBytes(32).toString('base64')
    const broker = new CredentialBroker(db, key)
    const source = await seedSource(db, 'csv:cred-test')
    await broker.store(source.id, 'api_key', { account_sid: 'SID123', auth_token: 't0ken' })

    const { rows } = await db.query(`select enc_payload from credentials where source_id = $1`, [source.id])
    const stored = rows[0].enc_payload as Buffer
    expect(stored.toString('utf8')).not.toContain('SID123') // ciphertext at rest

    const secrets = await broker.get(source.id)
    expect(secrets).toEqual({ account_sid: 'SID123', auth_token: 't0ken' })
  })

  it('refuses to decrypt with the wrong master key', async () => {
    const source = await seedSource(db, 'csv:cred-test2')
    const brokerA = new CredentialBroker(db, randomBytes(32).toString('base64'))
    await brokerA.store(source.id, 'api_key', { secret: 'x' })
    const brokerB = new CredentialBroker(db, randomBytes(32).toString('base64'))
    await expect(brokerB.get(source.id)).rejects.toThrow()
  })

  it('rejects malformed master keys', () => {
    expect(() => new CredentialBroker(db, 'short')).toThrow()
    expect(() => new CredentialBroker(db, '')).toThrow()
  })
})

describe('csv ingestion', () => {
  it('parses offers from a mapped CSV drop', async () => {
    const { csvInboxAdapter } = await import('../src/adapters/csv-inbox/index.ts')
    const source = await seedSource(db, 'direct:acme')
    const csv = [
      'Product Name,Deep Link,Price,SKU',
      '"Tripod, Carbon","https://acme.example.com/p/1","129.99",SKU1',
      'Ball Head,https://acme.example.com/p/2,49.50,SKU2',
    ].join('\n')
    const res = await csvInboxAdapter.ingestCsv!({ db, broker: null as any }, source, {
      id: 'drop1',
      source_id: source.id,
      drop_kind: 'offers',
      content: csv,
      mapping: {
        title: 'Product Name',
        url: 'Deep Link',
        price: 'Price',
        id: 'SKU',
        _defaults: '{"merchant":"Acme Direct","commission_rate":0.1,"link_template":"https://acme.example.com/aff?u={url_enc}&ref={tenant_ns}"}',
      },
    })
    expect(res.processed).toBe(2)
    const { rows } = await db.query(`select * from offers where source_id = $1 order by title`, [source.id])
    expect(rows).toHaveLength(2)
    expect(rows[1].title).toBe('Tripod, Carbon') // quoted comma survived
    expect(Number(rows[1].price.amount)).toBe(129.99)
    expect(rows[1].tracking.subid_fidelity).toBe('property') // {tenant_ns} but no {click_id}
  })
})
