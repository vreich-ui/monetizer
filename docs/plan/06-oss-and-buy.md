# 06 — OSS Map: Integrate, Buy, or Build

Honest verdicts. The one-line summary: **OSS is excellent for the substrate (database, jobs, dashboards, analytics-adjacent) and nearly nonexistent for the affiliate-specific middle** — there is no "Plaid for affiliate networks" in open source, only abandoned per-network SDK wrappers. The affiliate-specific layer is where this project's proprietary value lives anyway; building it is the point, not a failure of research.

## Verdict table

| Concern | Verdict | Choice | Notes |
|---|---|---|---|
| Database / source of truth | **OSS** | Postgres (Neon, Supabase, or Fly PG) | The whole system is a small-Postgres problem. |
| Job queue / schedulers | **OSS** | pg-boss (or graphile-worker) | Pollers, feed ingests, resolvers, liveness checks. No Redis, no Temporal — wrong weight class. |
| API framework | **OSS** | Hono or Fastify (TS/Node) | Matches the org's stack; Hono ports to edge workers if the redirect splits out later. |
| Feed/CSV crunching | **OSS** | DuckDB | Awin datafeeds, CJ exports, CSV inboxes → normalize → upsert. Absurdly good fit. |
| Dashboards / BI | **OSS** | Metabase (or Evidence.dev) | Point at Postgres views (with fidelity qualifiers baked into the views). Zero custom dashboard code in v1. |
| Traffic analytics (human-facing) | **OSS, optional** | Umami / Plausible | Nice-to-have; the engine's beacon remains source of truth for per-decision data (04). |
| Event capture / beacon | **Build** (~200 lines) | — | PostHog OSS was considered: capable, but ClickHouse-heavy to self-host and its event model would sit *beside* the decision-keyed log, not replace it. Revisit as an analysis layer later, not as substrate. |
| Redirect / link service | **Build** (small) | — | Shlink/Kutt et al. don't know about decisions, adapters, subid injection, or failover — and the redirect IS the product's control point. ~500 lines including failover. |
| Affiliate network clients | **Build** on raw HTTP | — | Existing OSS SDKs (paapi5 wrappers, impact clients) are stale/abandoned; the APIs are plain REST/GraphQL. Write thin typed clients inside each adapter. |
| Reporting aggregation | **Buy (cheap)** | **Strackr** (€10–50/mo, API plan) | One API for transactions across ~280 networks replaces N pollers — the single best build-vs-integrate trade in the project (03). Keep direct Impact (webhooks) and Amazon (unsupported anyway) adapters. |
| Full-outsource monetization | **Reject** | Sovrn / Skimlinks | ~25% commission cut, fidelity loss, dependency; defeats the purpose of owning the engine. Long-tail-merchant fallback at most. |
| Secrets | **OSS-lite** | libsodium-encrypted PG table behind `CredentialBroker`; SOPS/age for repo config | Vault/Infisical are team-scale tools; the broker seam makes them drop-in later (03). |
| Payments / digital products | **Buy (free tier)** | Stripe Payment Links + webhooks | Consider Lemon Squeezy (now Stripe-owned) if merchant-of-record/VAT handling for digital goods becomes painful. |
| Experimentation / future learning | **OSS, later** | GrowthBook | Fits behind the `DecisionPolicy` interface (01) when the time comes. Do not integrate now; do keep the interface honest (propensity logging). |
| Embeddings for relevance | **Buy (API)** | Any embedding API; pgvector (**OSS**) for storage/query | v1 relevance = cosine(offer text, surface context) + rule boosts. pgvector keeps it in Postgres. |
| MCP server | **OSS** | official TypeScript MCP SDK | The control plane (02). |
| Deploy | — | Fly.io / Railway | Long-running workers + PG proximity. Netlify stays the *project* platform; the engine doesn't fit Functions. |

## Where the ecosystem is thin (build, and budget for it)

1. **Adapter layer** (03) — the heart of the build. Per-network: client, capability declarations, offer/report normalizers, `verify()` probe, quota manager. Impact ≈ a session; Amazon ≈ two-plus (OAuth, quota budgeting, ToS constraints); Awin feeds ≈ one plus DuckDB pipeline; Strackr ≈ one for many networks' reporting.
2. **Decision engine + policy bookkeeping** (01) — the scoring itself is deliberately simple; the candidate/propensity/version logging is bespoke by nature.
3. **Attribution resolver** (04) — nothing off-the-shelf handles subid-echo joins + tracking-key allocation + bitemporal observations. This is proprietary-value code.
4. **Astro integration kit** (02) — thin but yours: components, resolve hook, beacon, disclosure rendering.
