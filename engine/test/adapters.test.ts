import { describe, expect, it } from 'vitest'
import { awinNormStatus, awinDeeplinkTemplate } from '../src/adapters/awin/index.ts'
import { cjNormStatus } from '../src/adapters/cj/index.ts'
import { strackrNormStatus, strackrExtractRows } from '../src/adapters/strackr/index.ts'
import { fillLinkTemplate } from '../src/adapters/types.ts'
import { loadConfig } from '../src/config.ts'

describe('status normalization', () => {
  it('awin', () => {
    expect(awinNormStatus('approved')).toBe('approved')
    expect(awinNormStatus('declined')).toBe('reversed')
    expect(awinNormStatus('deleted')).toBe('reversed')
    expect(awinNormStatus('pending')).toBe('pending')
    expect(awinNormStatus('')).toBe('pending')
  })
  it('cj', () => {
    expect(cjNormStatus('locked')).toBe('approved')
    expect(cjNormStatus('closed')).toBe('paid')
    expect(cjNormStatus('corrected')).toBe('adjusted')
    expect(cjNormStatus('new')).toBe('pending')
  })
  it('strackr (defensive across network vocabularies)', () => {
    expect(strackrNormStatus('confirmed')).toBe('approved')
    expect(strackrNormStatus('Validated')).toBe('approved')
    expect(strackrNormStatus('declined')).toBe('reversed')
    expect(strackrNormStatus('cancelled')).toBe('reversed')
    expect(strackrNormStatus('paid')).toBe('paid')
    expect(strackrNormStatus('waiting')).toBe('pending')
  })
})

describe('strackr row extraction', () => {
  it('handles flat arrays, results, and grouped shapes', () => {
    expect(strackrExtractRows([{ id: 1 }])).toEqual([{ id: 1 }])
    expect(strackrExtractRows({ results: [{ id: 2 }] })).toEqual([{ id: 2 }])
    expect(strackrExtractRows({ results: [{ transactions: [{ id: 3 }, { id: 4 }] }] })).toEqual([
      { id: 3 },
      { id: 4 },
    ])
    expect(strackrExtractRows({ transactions: [{ id: 5 }] })).toEqual([{ id: 5 }])
    expect(strackrExtractRows({})).toEqual([])
  })
})

describe('awin link template', () => {
  it('builds a click-fidelity deeplink template', () => {
    const tpl = awinDeeplinkTemplate(12345, 67890)
    expect(tpl).toContain('awinmid=12345')
    expect(tpl).toContain('{click_id}')
    const filled = fillLinkTemplate(tpl, {
      click_id: 'CLK1',
      url_enc: encodeURIComponent('https://shop.example.com/p?x=1'),
    })
    expect(filled).toContain('clickref=CLK1')
    expect(filled).toContain('ued=https%3A%2F%2Fshop.example.com%2Fp%3Fx%3D1')
  })
})

describe('config', () => {
  it('REDIRECT_BASE_URL falls back to PUBLIC_BASE_URL', () => {
    const cfg = loadConfig({ PUBLIC_BASE_URL: 'https://monetizer-abc-uc.a.run.app' } as any)
    expect(cfg.REDIRECT_BASE_URL).toBe('https://monetizer-abc-uc.a.run.app')
    const cfg2 = loadConfig({
      PUBLIC_BASE_URL: 'https://engine.example.com',
      REDIRECT_BASE_URL: 'https://go.example.com',
    } as any)
    expect(cfg2.REDIRECT_BASE_URL).toBe('https://go.example.com')
  })
})
