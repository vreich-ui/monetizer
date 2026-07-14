import { Hono } from 'hono'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client.ts'

/**
 * Minimal, spec-correct OAuth 2.1 Authorization Server for the MCP control
 * plane (docs/plan/02). Purpose: let the Claude connector UI (and any
 * spec-compliant MCP client) attach to /mcp, which requires the OAuth
 * discovery + authorization-code + PKCE flow rather than a static header.
 *
 * Single-owner model: the ADMIN_TOKEN is the login secret. The /authorize
 * consent page asks for it; only someone holding it can complete the flow and
 * mint an access token. Access tokens are opaque, persisted, and independent
 * of the ADMIN_TOKEN (so the token can rotate without breaking connectors...
 * they just re-consent).
 *
 * Endpoints (mounted at root):
 *   GET  /.well-known/oauth-protected-resource[/mcp]  resource metadata
 *   GET  /.well-known/oauth-authorization-server      AS metadata
 *   POST /oauth/register                              dynamic client registration
 *   GET  /oauth/authorize                             consent page
 *   POST /oauth/authorize                             consent submit -> code
 *   POST /oauth/token                                 code|refresh -> access token
 */

const ACCESS_TTL_S = 30 * 24 * 3600
const CODE_TTL_S = 300

function rand(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Absolute base URL from the incoming request (correct on Cloud Run). */
export function baseUrlOf(reqUrl: string, host: string | undefined, proto: string | undefined): string {
  if (host) return `${proto ?? 'https'}://${host}`
  const u = new URL(reqUrl)
  return `${u.protocol}//${u.host}`
}

/** Validate a presented bearer token: the static ADMIN_TOKEN or a live OAuth access token. */
export async function isAuthorized(db: Db, adminToken: string, presented: string): Promise<boolean> {
  if (!presented) return false
  if (adminToken && safeEq(presented, adminToken)) return true
  const { rows } = await db.query<{ expires_at: string | null }>(
    `select expires_at from oauth_tokens where token = $1 and kind = 'access'`,
    [presented],
  )
  const row = rows[0]
  if (!row) return false
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return false
  return true
}

export function oauthRoutes(deps: { db: Db; adminToken: string }): Hono {
  const app = new Hono()
  const base = (c: any) =>
    baseUrlOf(c.req.url, c.req.header('host'), c.req.header('x-forwarded-proto'))

  // --- Discovery metadata ---
  const protectedResource = (c: any) =>
    c.json({
      resource: `${base(c)}/mcp`,
      authorization_servers: [base(c)],
      bearer_methods_supported: ['header'],
    })
  app.get('/.well-known/oauth-protected-resource', protectedResource)
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource)

  const asMetadata = (c: any) => {
    const b = base(c)
    return c.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    })
  }
  // RFC 8414 root, the resource-suffixed variant some clients probe, and an
  // OIDC-discovery alias — all return the same authorization-server metadata.
  app.get('/.well-known/oauth-authorization-server', asMetadata)
  app.get('/.well-known/oauth-authorization-server/mcp', asMetadata)
  app.get('/.well-known/openid-configuration', asMetadata)

  // --- Dynamic Client Registration (RFC 7591) ---
  app.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => ({}) as any)
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
    const clientId = `mcpc_${rand(16)}`
    await deps.db.query(
      `insert into oauth_clients (client_id, client_name, redirect_uris) values ($1,$2,$3)`,
      [clientId, String(body.client_name ?? 'mcp-client').slice(0, 200), redirectUris],
    )
    return c.json(
      {
        client_id: clientId,
        client_name: body.client_name ?? 'mcp-client',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    )
  })

  // --- Authorization endpoint: consent page gated by ADMIN_TOKEN ---
  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query()
    const err = validateAuthzParams(q)
    if (err) return c.text(`invalid_request: ${err}`, 400)
    // Lazily accept the presented client (resilient to clients that skip DCR
    // or reuse a cached client_id from an earlier attempt). Security is the
    // admin-token consent + PKCE, not client-id validation.
    await ensureClient(deps.db, q.client_id, q.redirect_uri)
    return c.html(consentPage(q))
  })

  app.post('/oauth/authorize', async (c) => {
    const form = await c.req.parseBody()
    const q = form as Record<string, string>
    const err = validateAuthzParams(q)
    if (err) return c.text(`invalid_request: ${err}`, 400)
    if (!deps.adminToken || !safeEq(String(q.admin_token ?? ''), deps.adminToken)) {
      return c.html(consentPage(q, 'Incorrect admin token — try again.'), 401)
    }
    await ensureClient(deps.db, q.client_id, q.redirect_uri)
    const code = rand(24)
    await deps.db.query(
      `insert into oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
       values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
      [code, q.client_id, q.redirect_uri, q.code_challenge, q.code_challenge_method ?? 'S256', q.scope ?? 'mcp', String(CODE_TTL_S)],
    )
    const redirect = new URL(String(q.redirect_uri))
    redirect.searchParams.set('code', code)
    if (q.state) redirect.searchParams.set('state', q.state)
    return c.redirect(redirect.toString(), 302)
  })

  // --- Token endpoint ---
  app.post('/oauth/token', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>
    const grant = form.grant_type

    if (grant === 'authorization_code') {
      const { code, code_verifier, redirect_uri, client_id } = form
      if (!code || !code_verifier) return c.json({ error: 'invalid_request' }, 400)
      const { rows } = await deps.db.query<any>(
        `select * from oauth_codes where code = $1`,
        [code],
      )
      const row = rows[0]
      if (!row || row.used || new Date(row.expires_at).getTime() < Date.now())
        return c.json({ error: 'invalid_grant' }, 400)
      if (row.redirect_uri !== redirect_uri || (client_id && row.client_id !== client_id))
        return c.json({ error: 'invalid_grant', error_description: 'redirect_uri/client mismatch' }, 400)
      if (row.code_challenge !== s256(code_verifier))
        return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400)
      await deps.db.query(`update oauth_codes set used = true where code = $1`, [code])
      return c.json(await issueTokens(deps.db, row.client_id, row.scope))
    }

    if (grant === 'refresh_token') {
      const { refresh_token } = form
      const { rows } = await deps.db.query<any>(
        `select * from oauth_tokens where token = $1 and kind = 'refresh'`,
        [refresh_token],
      )
      const row = rows[0]
      if (!row) return c.json({ error: 'invalid_grant' }, 400)
      return c.json(await issueTokens(deps.db, row.client_id, row.scope))
    }

    return c.json({ error: 'unsupported_grant_type' }, 400)
  })

  return app
}

/** Ensure a client row exists (idempotent) — lazy/dynamic registration. */
async function ensureClient(db: Db, clientId: string | undefined, redirectUri: string | undefined): Promise<void> {
  if (!clientId) return
  await db.query(
    `insert into oauth_clients (client_id, client_name, redirect_uris)
     values ($1, 'auto', case when $2::text is null then '{}'::text[] else array[$2::text] end)
     on conflict (client_id) do update set
       redirect_uris = (
         select array(select distinct unnest(oauth_clients.redirect_uris || excluded.redirect_uris))
       )`,
    [clientId, redirectUri ?? null],
  )
}

function validateAuthzParams(q: Record<string, string>): string | null {
  if (q.response_type !== 'code') return 'response_type must be code'
  if (!q.client_id) return 'missing client_id'
  if (!q.redirect_uri) return 'missing redirect_uri'
  if (!q.code_challenge) return 'missing code_challenge (PKCE required)'
  if (q.code_challenge_method && q.code_challenge_method !== 'S256') return 'only S256 PKCE supported'
  return null
}

async function issueTokens(db: Db, clientId: string, scope: string | null) {
  const access = rand(32)
  const refresh = rand(32)
  await db.query(
    `insert into oauth_tokens (token, kind, client_id, scope, expires_at)
     values ($1,'access',$2,$3, now() + ($4 || ' seconds')::interval),
            ($5,'refresh',$2,$3, null)`,
    [access, clientId, scope, String(ACCESS_TTL_S), refresh],
  )
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: scope ?? 'mcp',
  }
}

function esc(s: string | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function consentPage(q: Record<string, string>, error?: string): string {
  const hidden = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`)
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Monetizer</title><style>
body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0e1319;color:#e7edf3;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#161e28;border:1px solid #28323d;border-radius:14px;padding:28px;max-width:380px;width:90%}
h1{font-size:19px;margin:0 0 6px}p{color:#8b98a7;margin:0 0 18px;font-size:13.5px}
label{display:block;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#8b98a7;margin:0 0 6px}
input[type=password]{width:100%;box-sizing:border-box;padding:11px;border-radius:9px;border:1px solid #39454f;background:#0e1319;color:#e7edf3;font-size:15px}
button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:9px;background:#d68a1e;color:#1b1206;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff8a8a;font-size:13px;margin:10px 0 0}</style></head>
<body><form class="card" method="post" action="/oauth/authorize">
<h1>Connect to Monetizer</h1>
<p>Authorize this client to control your monetization engine. Enter your admin token to approve.</p>
<label for="t">Admin token</label>
<input id="t" type="password" name="admin_token" autocomplete="off" autofocus>
${error ? `<div class="err">${esc(error)}</div>` : ''}
${hidden}
<button type="submit">Authorize</button>
</form></body></html>`
}
