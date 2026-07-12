# Operations — Accounts, Env Vars, Runbook

The single human touchpoint is credential handoff (docs/plan/00). This page is the complete shopping list: what to create, what to hand back, and how the engine receives it.

## 1. Infrastructure accounts (needed first)

| What | Where | Hand back |
|---|---|---|
| Postgres | [Neon](https://neon.tech) or [Supabase](https://supabase.com) (free tiers fine) | `DATABASE_URL` connection string |
| Engine hosting | [Fly.io](https://fly.io) or [Railway](https://railway.app) (needs long-running process, not serverless) | account access or just deploy + set env vars |
| Redirect domain | DNS: create `go.<your-network-domain>` pointing at the engine deployment | the hostname you chose |

## 2. Environment variables (set on the engine host)

```
DATABASE_URL=postgres://...                  # from Neon/Supabase
CRED_MASTER_KEY=<openssl rand -base64 32>    # generate ONCE, back it up; losing it = re-registering all credentials
ADMIN_TOKEN=<openssl rand -hex 32>           # control-surface auth
PUBLIC_BASE_URL=https://engine.<domain>      # the engine's own public URL
REDIRECT_BASE_URL=https://go.<domain>        # the click domain (may equal PUBLIC_BASE_URL)
PORT=8787                                    # optional
POLICY_EPSILON=0.1                           # optional, exploration rate
```

Per content project (Netlify site env):
```
MONETIZER_ENGINE_URL=https://engine.<domain>
MONETIZER_TENANT_TOKEN=<returned by register_tenant>
```

## 3. Network accounts (apply now — approval takes days to weeks)

Priority order. Each row ends with a `register_credential` MCP call.

| # | Network | Sign up | What to hand back (exact secrets) |
|---|---|---|---|
| 1 | **Impact** | impact.com → publisher/partner account | `{ account_sid, auth_token }` (Settings → API) |
| 2 | **Awin** | awin.com publisher signup (~$5 refundable deposit) | API token — *adapter pending; register as `csv:awin` and feed datafeed CSVs meanwhile* |
| 3 | **CJ** | cj.com publisher signup | Personal Access Token — *adapter pending; same CSV path meanwhile* |
| 4 | **Stripe** | stripe.com → create products with prices for digital goods | `{ api_key (restricted: products/prices/payment_links read+write, checkout read), webhook_secret }` — point a webhook at the URL `register_credential` returns, events: `checkout.session.completed`, `charge.refunded` |
| 5 | **Amazon Associates** | affiliate-program.amazon.com | *No API yet (deferred).* Create one **tracking ID per property** (e.g. `mysite-20`) and run `set_tenant_tracking` with them. Offers via `ingest_csv`; earnings reports via CSV drop. Creators API creds later, once qualifying sales exist. |
| 6 | Strackr *(after ≥2 networks live)* | strackr.com, API plan | API credentials — collapses CJ/Awin/long-tail report polling |
| 7 | Buy Me a Coffee / Patreon *(when a quiz/tool surface exists)* | — | API tokens |

Direct merchant programs: no signup dance — `register_credential` with network `direct:<merchant-slug>`, then `ingest_csv` their offer/report files.

## 4. Credential handoff flow

```
pnpm mcp        # stdio MCP server (env: DATABASE_URL, CRED_MASTER_KEY, PUBLIC_BASE_URL)
```
Then, via MCP tools:
1. `register_tenant {slug, name, domains, netlify_build_hook_url}` → returns the tenant token (store it in the project's Netlify env).
2. `set_tenant_tracking {slug, namespaces: {amazon: "mysite-20", impact: "mysite"}}`
3. `register_credential {network, secrets}` → verifies immediately, queues catalog sync, returns the webhook URL where relevant.
4. `list_sources` / `performance` / `demand_signals` to watch it run.

## 5. Runbook

- **Run engine**: `pnpm migrate && pnpm dev` (dev) / `pnpm start` (prod). Health: `GET /healthz`.
- **Tests**: `pnpm test` (needs local Postgres with `monetizer_test` db); `pnpm typecheck`.
- **Jobs**: recurring schedules are seeded automatically (attribution hourly, CSV drops 5min, liveness 6h, report polls 6h, catalog syncs daily). Inspect: `select * from jobs order by id desc limit 20`.
- **A property goes rogue / network complains**: `pause_source` or `pause_offer` via MCP — existing links fail over instantly, no rebuild needed.
- **Dead links**: liveness checker marks offers dead → redirect fails over → queue `trigger_rebuild` refreshes rendered cards.
- **Dashboards**: point Metabase at the Postgres replica; every revenue view must keep the `status` + `resolution` columns (docs/plan/01 §Money model rule).
