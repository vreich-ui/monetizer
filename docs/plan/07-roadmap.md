# 07 — Build Sequence

## Critical path (cannot be parallelized)

```
schema & event envelope → redirect + click log → first adapter (Impact) → resolve API → first live commission
```

Everything else hangs off the schema; it gets designed once, reviewed hard, and migrated carefully thereafter. The redirect and click log precede any adapter because they're what every adapter's links point at. The **first-dollar milestone** (a real commission attributed at click fidelity, end to end) is the system's integration test — drive toward it directly and let dashboards, second adapters, and polish follow it.

## Human-action checklist — start these NOW (they gate everything and have lead times)

The one human touchpoint is credential handoff; here is the complete v1 shopping list. Network/program approvals take days-to-weeks and require live, presentable properties — apply early, expect some rejections (05 §1).

1. **Impact** publisher account → API credentials (Account SID + Auth Token). First target.
2. **Awin** publisher account (~$5 refundable deposit) → API token; subscribe to datafeeds for approved advertisers.
3. **CJ** publisher account → Personal Access Token.
4. **Amazon Associates** → do NOT expect API access at signup; needs qualifying sales first (05 §2). Create account, note tracking-ID scheme (one per tenant).
5. **Strackr** subscription (API plan) once ≥2 networks are live.
6. **Stripe** account (products/prices for digital goods) → restricted API key + webhook secret.
7. **Buy Me a Coffee / Patreon** → API tokens (last priority).
8. Redirect domain (e.g. `go.<network-domain>`) + engine hosting account (Fly.io/Railway) + Postgres (Neon/Supabase).

Each handoff terminates in `register_credential` via MCP → automatic `verify()` probe (03).

## Phases

### Phase 0 — Substrate (the non-negotiable foundation)
Repo scaffold (TS monorepo: `engine/`, `packages/astro-kit/`, `packages/context-taxonomy/`), Postgres migrations for the full domain model (01), event envelope with `schema_version`, pg-boss wiring, `CredentialBroker` + `register_credential` MCP tool, `DecisionPolicy` interface with the heuristic v1 policy **including candidate/propensity/version logging**, decision + redirect service skeleton with async click writes and failover, nightly Parquet export stub.
**Done when:** a fake-source offer can be resolved onto a fake surface, the rendered redirect URL 302s, and the click appears in the event log with a decision join.

### Phase 1 — First money loop
Impact adapter (full capability set: catalog, deeplinks, subid links, `verify()`); embedding relevance (pgvector) + policy config; `POST /v1/resolve` + Blobs manifest write; Astro kit v0 (`<OfferBox>`, `<InlineOffer>`, resolve hook, disclosure rendering, beacon snippet); context-taxonomy package v1 **and its adoption by one real content project** (cross-repo task — schedule it, it's the contract from 00 §3).
**Done when:** one live property renders Impact offers through the redirect domain and first clicks are logged. (First *commission* arrives on the network's schedule — instrument the wait, don't block on it.)

### Phase 2 — Measurement (starts as soon as Phase 1 is code-complete; parallelizable with Phase 3)
Impact reporting (webhooks + poller) → ConversionObservations; attribution resolver v1 (subid join + windowed allocation); ledger + derived `conversions`; beacon ingestion live (impressions/viewability/pageviews); Metabase over qualified views (EPC/RPM/CTR by offer/surface/context/tenant, always with state+resolution labels); liveness checker + rebuild triggers; IVT heuristic flags.
**Done when:** a dashboard shows revenue-per-surface with honest qualifiers, and a dead offer heals itself (failover → rebuild) without a human.

### Phase 3 — Source breadth (each item independent; parallelize freely)
- **Stripe digital products**: catalog + Payment Links with `client_reference_id=click_id` + webhook conversions — proves the high-fidelity end and the second economics type.
- **Awin adapter**: datafeed ingest via DuckDB (first `catalog.feed` exercise), link builder, clickref.
- **Strackr** as `reporting.transactions` for Awin/CJ/long-tail.
- **CJ adapter** (catalog via GraphQL; reporting via Strackr unless direct proves necessary).
- **Amazon bootstrap**: curated offers at property fidelity to earn qualifying sales → Creators API adapter (OAuth, quota budget, ToS constraints in `constraints.tos`) once unlocked. Calendar-gated; start the sales clock early.
- **Tip-jar adapters** (BMC/Patreon): trivial; do them when a quiz/tool surface actually ships.

### Phase 4 — Hardening & optionality (pull forward only on evidence)
Demand-signals feed + MCP tool (00 §3); `explain_decision`; payout reconciliation; redirect split to edge worker if latency/SPOF warrants (05 §8); ε-exploration tuning; GrowthBook behind `DecisionPolicy` **only when** Phase-2 dashboards show enough click volume for experiments to conclude; request-time `decide` endpoint **only when** a concrete personalization hypothesis exists.

### Explicitly deferred, by design
Learning/bandit models (substrate is ready; volume isn't). Cross-network product identity. Cross-site visitor identity (rejected outright, 04). Shopify (until a store exists). Display ads (out of scope, 05 §9). Scraping adapters (per-program opt-in only). ClickHouse/queues/microservices (revisit at ~100× current volume).

## What fits this planning-session model class vs. implementation sessions

Design-heavy, judgment-heavy work worth doing with the strongest available model: this document set (done); schema review before Phase-0 migration freeze; the attribution resolver's allocation logic (04); adapter normalization decisions when a network's data is ambiguous; `constraints.tos` interpretation per program. Mechanical work any competent session handles: adapter HTTP clients against docs, Astro components, Metabase views, beacon script, CSV mappers — these are well-specified by docs 01–04 and can run as parallel implementation sessions.
