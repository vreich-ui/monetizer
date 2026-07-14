import { describe, expect, it } from 'vitest'
import { assertPublicUrl, _isPrivateIp } from '../src/adapters/http/ssrf.ts'

describe('SSRF guard', () => {
  it('classifies private/reserved IPs', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1'])
      expect(_isPrivateIp(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])
      expect(_isPrivateIp(ip), ip).toBe(false)
  })

  it('blocks the cloud metadata endpoint and localhost', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/computeMetadata/v1/')).rejects.toThrow()
    await expect(assertPublicUrl('http://metadata.google.internal/')).rejects.toThrow()
    await expect(assertPublicUrl('http://localhost:8080/')).rejects.toThrow()
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow()
    await expect(assertPublicUrl('http://10.1.2.3/')).rejects.toThrow()
  })

  it('blocks non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow()
    await expect(assertPublicUrl('gopher://x/')).rejects.toThrow()
  })

  it('allows a public IP literal', async () => {
    const u = await assertPublicUrl('https://8.8.8.8/v1/data')
    expect(u.hostname).toBe('8.8.8.8')
  })
})
