# 03 — Network Adapters and the Credential Broker

## Design principle: normalize the data, not the API

Affiliate networks range from "decent REST API" to "monthly CSV attachment." A uniform adapter interface would be lowest-common-denominator mush (everything degrades to the CSV case) or a lie (pretending Amazon has per-click subids). Instead:

**Adapters declare capabilities; the core plans around declared capabilities; normalization happens at the data layer** (canonical Offer / ConversionObservation schemas with `ext` bags), never at the API-shape layer. Core code never imports an adapter's types; adapters never write to core tables except through the ingestion interfaces.

## Capability menu

Each adapter implements a subset and declares it in the Source record:

| Capability | Meaning | Declared metadata |
|---|---|---|
| `catalog.search` | On-demand product/offer query | rate limits, quota model |
| `catalog.feed` | Bulk feed ingest (CSV/XML datafeeds) | cadence, format, delta-vs-full |
| `links.build` | Construct a tracking link for an offer/URL | deeplink support (arbitrary URL vs. product-only) |
| `links.subid` | Per-click ID passthrough | **fidelity**: `click` / `surface` / `property` / `none`; field name; length limit |
| `reporting.transactions` | Pull conversions/commissions | granularity (itemized?), subid echoed?, lag, mutation window |
| `reporting.clicks` | Network-side click counts | used only for reconciliation against first-party log |
| `compliance` | ToS constraints as data | price-staleness limits, disclosure text, redirect rules |

The decision engine reads fidelity declarations when scoring (a click-fidelity network is worth more than its raw commission rate suggests, because its data compounds), and the attribution resolver reads them to pick a join strategy (04).

## Per-network dossiers (verified July 2026)

### Amazon — Creators API (PA-API v5 retired May 15, 2026)
- **Catalog**: Creators API, OAuth2 client-credentials, REST. Search + ASIN lookup, price/image/availability. Starts ~1 rps; limits scale with referred sales and **lapse without qualifying sales** — a hard chicken-and-egg (see 05). Adapter must treat quota as a managed budget (cache aggressively into OfferSnapshots; the API is for refresh, not per-build lookup).
- **Links**: tag-based (`?tag=trackingid-20`). Up to ~100 tracking IDs per account → **fidelity = property or surface-group level, never click**. No subid.
- **Reporting**: earnings reports by tracking ID; no per-click join. Itemized but coarse-keyed.
- **Compliance (data-driven in `constraints.tos`)**: redirects must not obscure that the destination is Amazon (merchant slug in redirect path, single 302, honest referrer); price display must be fresh/timestamped; mandated disclosure wording; no link decoration beyond documented params.
- **Verdict**: build second, not first. Highest revenue ceiling, worst instrumentation, most ways to get banned.

### Impact
- Full REST API: catalog, deeplinks, and itemized transaction reporting with **SubId1–3 echoed back** → click fidelity. Webhooks available for conversion events.
- **Verdict: reference adapter.** Build first; it exercises every capability at the highest fidelity, which validates the whole pipeline before degrading gracefully for others.

### CJ (Commission Junction)
- GraphQL product feed API; REST Commission Detail API with `SID` (subid) echoed → click fidelity. Itemized, includes correction/reversal records.
- Verdict: second or third API adapter; similar shape to Impact.

### Awin (absorbed ShareASale, Oct 2025)
- Publisher API (transactions, itemized, `clickref` echoed → click fidelity), Link Builder API, product **datafeeds as CSV** (per-advertiser subscription). Transaction API has strict rate limits; feeds do the catalog heavy lifting (`catalog.feed` + DuckDB, see 06).
- Verdict: build alongside/after Impact; first exercise of the feed-ingest path. Many ex-ShareASale long-tail merchants live here.

### Direct merchant programs
- Often no API: a dashboard, a monthly CSV, an email. Model as `csv_inbox` sources: a normalized drop point (email-forward or upload via MCP tool) + per-program column-mapping config. Reporting is batch, aggregate, laggy — declared as such (`fidelity: property|account`, `completeness: aggregate`).
- Scraping their dashboards: possible via the org's agent/browser tooling, but treat as per-program opt-in with explicit ToS review, isolated from core (it's an implementation of `reporting.transactions`, nothing more). Don't build generic scraping infrastructure in v1.

### Stripe (digital products)
- Products/Prices as `catalog.search`; Payment Links / Checkout Sessions as `links.build` (with `client_reference_id` = click_id → **click fidelity, instant, immutable-ish**); webhooks as `reporting.transactions`. The best-instrumented source in the system; proves the top of the fidelity spectrum. Shopify: same shape, later, only if Shopify stores actually materialize.

### Buy Me a Coffee / Patreon (tip-jar)
- BMC: simple API + webhooks. Patreon: OAuth API + webhooks. Attribution beyond property level is weak (support pages don't echo subids reliably) — declared honestly. Trivial adapters; build last.

### Strackr (aggregator — the reporting shortcut)
- Commercial (€10–50/mo tiers; API on custom plan), one REST API for transactions/clicks across ~280 networks. **Recommended as the default implementation of `reporting.transactions` for CJ/Awin/long-tail** — it collapses the worst part of the adapter matrix (N report pollers, N pagination dialects, N breakage modes) for trivial money. Architecturally it is *just another adapter* filling that capability for many networks; keep direct reporting adapters possible (Impact direct is worth it for webhooks + richest subid echo; Amazon isn't supported by anyone properly). Do **not** use full-outsource monetizers (Sovrn/Skimlinks — ~25% revenue cut, fidelity loss, dependency) except possibly for unmanaged long-tail merchants.

## Ingestion architecture

Adapters run as **jobs** (pg-boss queues on Postgres — see 06): catalog syncs and feed ingests write Offers/OfferSnapshots; report pollers write ConversionObservations; all upserts go through core-owned ingestion functions that enforce schema, stamp `source_id`/fidelity, and version rows. A broken adapter can never corrupt core data — worst case is staleness, which the lifecycle checker surfaces.

Offer liveness: a `liveness` job pings a sample of active offers' destination URLs (HEAD/GET, rate-limited) and marks `stale`/`dead`; dead offers trigger redirect failover + rebuild scheduling (02).

## Credential broker

Single-operator system: **do not build or deploy a vault product in v1.** Build a small `CredentialBroker` interface with a boring first implementation:

- `credentials` table in Postgres, secrets encrypted with libsodium sealed-box; master key lives only in the engine host's env (Fly/Railway secret). Rows: `network, tenant_scope (global|tenant_id), kind (api_key|oauth_client|oauth_tokens|csv_inbox_address), encrypted_payload, status, last_verified_at`.
- Adapters obtain credentials only via `broker.get(source)` — never from env directly. This one seam is what lets Vault/Infisical/KMS replace the backing store later with zero adapter changes.
- OAuth sources (Amazon Creators API, Patreon): broker owns token refresh state.
- **The human handoff is an MCP tool**: `register_credential(network, scope, secrets…)` → broker encrypts, stores, immediately runs the adapter's `verify()` probe (a cheap authenticated call), records capability probe results and quota state, and returns pass/fail. Handoff ends with a verified, capability-mapped source — not a key in a file.

Non-secret account state lives beside, not inside, the credential: per-merchant program approval status, quota/rate budgets, health checks, ban-risk notes. Adapters update it; the dashboard reads it.

## Tenancy mapping

- Network **accounts** are per-legal-entity → shared across tenants by default (`tenant_scope: global`).
- Per-tenant separation happens at the tracking layer: Amazon tracking-ID per tenant, Impact SubId1 = tenant slug, CJ SID prefix, Awin clickref prefix. The adapter's `links.build` receives `(offer, decision, tenant)` and applies the tenant's namespace — so network-side reports are always at least tenant-attributable even at the lowest fidelity.
- `tenant_scope: tenant` credentials are supported from day one (schema-level) so a risky property can be moved to its own network account without redesign. Shared account = shared ban blast radius; this is the containment mechanism.
