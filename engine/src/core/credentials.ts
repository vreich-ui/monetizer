import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { newId } from '../ids.ts'

/**
 * CredentialBroker (docs/plan/03): adapters obtain secrets ONLY through this
 * seam. Backing store is an AES-256-GCM-encrypted Postgres column; the seam is
 * what lets Vault/KMS replace it later with zero adapter changes.
 *
 * enc_payload layout: iv(12) || authTag(16) || ciphertext
 */
export class CredentialBroker {
  #key: Buffer

  constructor(
    private db: Db,
    masterKeyB64: string,
  ) {
    if (!masterKeyB64) throw new Error('CRED_MASTER_KEY is required (openssl rand -base64 32)')
    this.#key = Buffer.from(masterKeyB64, 'base64')
    if (this.#key.length !== 32) throw new Error('CRED_MASTER_KEY must decode to 32 bytes')
  }

  encrypt(payload: Record<string, unknown>): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  }

  decrypt(blob: Buffer): Record<string, unknown> {
    const iv = blob.subarray(0, 12)
    const tag = blob.subarray(12, 28)
    const ct = blob.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return JSON.parse(pt.toString('utf8'))
  }

  async store(sourceId: string, kind: string, secrets: Record<string, unknown>): Promise<string> {
    const id = newId()
    await this.db.query(
      `insert into credentials (id, source_id, kind, enc_payload) values ($1,$2,$3,$4)`,
      [id, sourceId, kind, this.encrypt(secrets)],
    )
    return id
  }

  async get(sourceId: string, kind?: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.db.query<{ enc_payload: Buffer }>(
      `select enc_payload from credentials
        where source_id = $1 and ($2::text is null or kind = $2)
        order by created_at desc limit 1`,
      [sourceId, kind ?? null],
    )
    const row = rows[0]
    return row ? this.decrypt(row.enc_payload) : null
  }

  async markVerified(sourceId: string, ok: boolean): Promise<void> {
    await this.db.query(
      `update credentials set status = $2, last_verified_at = now()
        where source_id = $1`,
      [sourceId, ok ? 'verified' : 'failed'],
    )
  }
}
