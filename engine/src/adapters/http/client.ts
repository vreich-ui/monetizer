import type { Db } from '../../db/client.ts'
import type { AuthConfig } from './config.ts'
import { assertPublicUrl } from './ssrf.ts'

/** Injectable fetch so tests can drive the recipe runner without real network. */
export type FetchImpl = typeof fetch

export interface HttpCallOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  fetchImpl?: FetchImpl
}

const DEFAULT_TIMEOUT = 15000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** Fill {key} placeholders from a values map (missing -> empty string). */
export function fillTemplate(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '')
}

/** Dot-path getter: 'a.b.0.c' into nested objects/arrays. '' returns the root. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

/**
 * Apply the declared auth model to an outgoing request. OAuth2 client-credentials
 * tokens are cached in oauth_tokens (kind='access') keyed by the source so we
 * don't mint one per request.
 */
export async function applyAuth(
  db: Db,
  sourceId: string,
  auth: AuthConfig,
  secrets: Record<string, string>,
  req: { url: URL; headers: Record<string, string> },
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  const val = (tpl: string | undefined, fallback: string) => (tpl ? fillTemplate(tpl, secrets) : fallback)
  const firstSecret = Object.values(secrets)[0] ?? ''

  switch (auth.type) {
    case 'none':
      return
    case 'bearer':
      req.headers['Authorization'] = `Bearer ${val(auth.value_template, secrets.token ?? firstSecret)}`
      return
    case 'api_key_header':
      req.headers[auth.header_name || 'Authorization'] = val(auth.value_template, secrets.api_key ?? firstSecret)
      return
    case 'basic': {
      const u = secrets[auth.username_key ?? 'username'] ?? ''
      const p = secrets[auth.password_key ?? 'password'] ?? ''
      req.headers['Authorization'] = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`
      return
    }
    case 'query_param':
      req.url.searchParams.set(auth.query_param || 'api_key', val(auth.value_template, firstSecret))
      return
    case 'oauth2_client_credentials': {
      const token = await getClientCredentialsToken(db, sourceId, auth, secrets, fetchImpl)
      req.headers['Authorization'] = `Bearer ${token}`
      return
    }
  }
}

async function getClientCredentialsToken(
  db: Db,
  sourceId: string,
  auth: AuthConfig,
  secrets: Record<string, string>,
  fetchImpl: FetchImpl,
): Promise<string> {
  const key = `cc:${sourceId}`
  const { rows } = await db.query<{ token: string; expires_at: string | null }>(
    `select token, expires_at from oauth_tokens where kind = 'access' and client_id = $1
      order by created_at desc limit 1`,
    [key],
  )
  const cached = rows[0]
  if (cached && (!cached.expires_at || new Date(cached.expires_at).getTime() > Date.now() + 30_000)) {
    return cached.token
  }
  if (!auth.token_url) throw new Error('oauth2_client_credentials: token_url missing')
  await assertPublicUrl(auth.token_url)
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: secrets[auth.client_id_key ?? 'client_id'] ?? '',
    client_secret: secrets[auth.client_secret_key ?? 'client_secret'] ?? '',
  })
  if (auth.scope) form.set('scope', auth.scope)
  const res = await fetchImpl(auth.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
  })
  if (!res.ok) throw new Error(`token endpoint ${auth.token_url}: HTTP ${res.status}`)
  const data: any = await res.json()
  const token = data.access_token
  if (!token) throw new Error('token endpoint returned no access_token')
  const expiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null
  await db.query(`delete from oauth_tokens where kind = 'access' and client_id = $1`, [key])
  await db.query(
    `insert into oauth_tokens (token, kind, client_id, expires_at) values ($1,'access',$2,$3)`,
    [token, key, expiresAt],
  )
  return token
}

/** One HTTP call with SSRF guard, timeout, and a response-size cap. */
export async function httpCall(
  url: URL,
  opts: HttpCallOptions,
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  await assertPublicUrl(url.toString())
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(url.toString(), {
    method: opts.method ?? 'GET',
    headers: opts.headers,
    body: opts.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
  })
  const reader = res.body?.getReader()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  let text = ''
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`response exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
  } else {
    text = await res.text()
  }
  let json: unknown = undefined
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON is fine for verify probes */
  }
  return { status: res.status, json, text, headers: res.headers }
}
