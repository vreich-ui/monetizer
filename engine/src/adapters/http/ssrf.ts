import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * SSRF guard for agent-supplied URLs. The engine makes server-side requests to
 * connection URLs authored by agents, so it must refuse anything that could
 * reach internal infrastructure — above all the cloud metadata endpoint
 * (169.254.169.254 / metadata.google.internal), which on Cloud Run would leak
 * the service account. Only public http(s) hosts are allowed.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
])

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    if (a === 10) return true
    if (a === 127) return true // loopback
    if (a === 0) return true
    if (a === 169 && b === 254) return true // link-local incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    return false
  }
  // IPv6
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true // link-local / ULA
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7)) // IPv4-mapped
  return false
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`blocked scheme: ${url.protocol} (only http/https)`)
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error(`blocked host: ${host}`)

  // If the host is a literal IP, check it directly; otherwise resolve and check
  // every resolved address (defends against DNS-rebinding to a private IP).
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`blocked private address: ${host}`)
    return url
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new Error(`cannot resolve host: ${host}`)
  }
  if (addrs.length === 0) throw new Error(`cannot resolve host: ${host}`)
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`host ${host} resolves to a private address (${a.address})`)
  }
  return url
}

// Exposed for unit testing the classifier without DNS.
export const _isPrivateIp = isPrivateIp
