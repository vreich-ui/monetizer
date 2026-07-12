# Operations — Accounts, Env Vars, Runbook

The single human touchpoint is credential handoff (docs/plan/00). This page is the complete shopping list: what to create, what to hand back, and how the engine receives it.

## 1. Infrastructure (Google Cloud)

One GCP project covers all three infrastructure needs — full commands in [`deploy/gcp.md`](../deploy/gcp.md):

| What | GCP service | Notes |
|---|---|---|
| Postgres | **Cloud SQL** (Postgres 16, smallest tier) | engine connects over the Cloud SQL unix socket |
| Engine hosting | **Cloud Run** | must run with `--min-instances=1 --no-cpu-throttling` (the job worker lives in-process) |
| Redirect/engine URL | the default `https://….run.app` URL | no custom domain needed; `REDIRECT_BASE_URL` defaults to `PUBLIC_BASE_URL` |
| Secrets | **Secret Manager** | `CRED_MASTER_KEY`, `ADMIN_TOKEN` |

## 2. Environment variables (set on the engine host)

```
DATABASE_URL=postgres://monetizer:<pw>@/monetizer?host=/cloudsql/<PROJECT>:<REGION>:monetizer-pg
CRED_MASTER_KEY=<openssl rand -base64 32>    # generate ONCE, back it up; losing it = re-registering all credentials
ADMIN_TOKEN=<openssl rand -hex 32>           # control-surface auth
PUBLIC_BASE_URL=https://monetizer-<hash>-uc.a.run.app   # the Cloud Run URL (set after first deploy)
# REDIRECT_BASE_URL is optional — defaults to PUBLIC_BASE_URL
# PORT is injected by Cloud Run; POLICY_EPSILON=0.1 optional
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
| 2 | **Awin** | awin.com publisher signup (~$5 refundable deposit) | `{ api_token, publisher_id }` — transactions API wired; catalog via datafeed CSV drops (link template helper: `awinDeeplinkTemplate`) |
| 3 | **CJ** | cj.com publisher signup | `{ personal_access_token, company_id }` — commissions API wired; catalog via feed CSV drops |
| 4 | **Stripe** | stripe.com → create products with prices for digital goods | `{ api_key (restricted: products/prices/payment_links read+write, checkout read), webhook_secret }` — point a webhook at the URL `register_credential` returns, events: `checkout.session.completed`, `charge.refunded` |
| 5 | **Amazon Associates** | affiliate-program.amazon.com | *No API yet (deferred).* Create one **tracking ID per property** (e.g. `mysite-20`) and run `set_tenant_tracking` with them. Offers via `ingest_csv`; earnings reports via CSV drop. Creators API creds later, once qualifying sales exist. |
| 6 | Strackr *(optional, after ≥2 networks live)* | strackr.com, API plan | `{ api_id, api_key }` — aggregated reporting wired; observations re-home to the matching direct source. Use EITHER Strackr OR a network's direct poller per network, not both |
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
