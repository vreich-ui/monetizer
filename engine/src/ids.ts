import { ulid } from 'ulid'
import { createHash } from 'node:crypto'

export const newId = (): string => ulid()

/** Deterministic surface id: stable across builds for the same logical slot. */
export function surfaceId(tenantId: string, contentId: string, slotKey: string): string {
  return createHash('sha256').update(`${tenantId}|${contentId}|${slotKey}`).digest('hex').slice(0, 40)
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
