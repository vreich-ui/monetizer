# 05 — Hard Problems, Stated Plainly

Ranked by expected damage. The first two are existential and mostly non-engineering; pretending otherwise would be the biggest planning error.

## 1. Network acceptance of AI-operated properties (existential, non-engineering)
Affiliate networks' fraud/quality teams actively hunt thin, mass-produced, AI-generated content sites — this network is, structurally, exactly what they screen for. Amazon closes accounts for content-quality reasons; Impact/CJ/Awin merchants approve publishers individually and can terminate at will. **No architecture fixes this.** What the engine can do: per-tenant tracking namespaces + `tenant_scope` credentials (03) contain blast radius; the compliance metadata system (disclosures, price freshness) removes the *mechanical* ban reasons; the score floor (02: empty slot over bad offer) protects conversion quality; IVT flagging (04) protects traffic-quality metrics. What only the content side can do: be genuinely useful. Plan for account loss as an operational event (source `paused`, offers failover, re-application runbook), not an exception.

## 2. Amazon's chicken-and-egg, and Amazon generally
Creators API access requires qualifying sales and lapses without them; the Associates account itself needs early sales to survive; rate limits scale with revenue. You cannot bootstrap a catalog-driven Amazon strategy from zero via the API. **Sequencing consequence (07): Amazon is the *second* adapter.** Bootstrap path: earn first Amazon sales with manually-ish curated offers (SiteStripe links registered as `csv_inbox`-style offers with property-level fidelity), unlock the API, then automate. Also: Amazon fidelity is permanently capped at tracking-ID granularity — the learning layer will always see Amazon rewards fuzzier than everyone else's. Priced in via fidelity labels; not fixable.

## 3. Delayed, mutable, censored rewards
Commissions lock 30–90 days out; reversals are routine; some sources report only aggregates. Any dashboard or model reading "revenue" as a scalar will be wrong. The bitemporal observation model + ledger + resolution labels (04) make this representable — but nothing makes the latency disappear: **the optimization loop's feedback period is months for affiliate, minutes for Stripe.** Expect the learning layer to lean on click-through and Stripe conversions as fast proxies with affiliate lock as slow ground truth. That proxy structure should be validated early with dashboards (Phase 2), long before any model.

## 4. Matching quality depends on a taxonomy that doesn't exist yet
Offer↔surface matching is only as good as (a) offer taxonomy normalization across networks that disagree about categories, and (b) intent metadata emitted by content agents. Both are ongoing curation, not one-time builds. Mitigations: engine-owned versioned context taxonomy (01), embedding-based relevance as the v1 workhorse (robust to vocabulary drift), `explain_decision` MCP tool for auditing mismatches. Underspecified in the original framing and now specified: **the content agents must adopt the taxonomy contract** — this is a cross-repo dependency to schedule (07 Phase 1).

## 5. Link rot and offer death at agentic scale
Thousands of offers × merchant churn = dead links weekly. Redirect-level failover (02) makes it a rendering-staleness problem instead of a broken-link problem, liveness checking (03) bounds detection lag, rebuild triggers repair the rendering. Residual risk: rendered price/title wrong between death and rebuild — bounded, monitored via `redirect_failed`/failover events.

## 6. Compliance automation
FTC disclosure on every affiliate surface; Amazon's specific wording and price-display rules; GDPR/PECR for EU visitors (mitigated by the cookieless identity design, 04); merchant-specific ToS oddities (some ban email use, paid-traffic, coupon framing). Modeled as data (`constraints.tos`, disclosure blocks in resolve payloads) with rendering pushed to the Astro kit so projects can't silently drop it. Residual risk: ToS are prose, adapters encode an interpretation; periodic human/agent review of `constraints.tos` per program is an operational task.

## 7. Cross-network attribution overlap
Unsolvable in general (each network last-click-attributes within its own cookie window; users touch multiple links). Accepted: record per-network claims, reconcile against payouts, label resolution. Do not build a "true attribution" arbiter — it would be fiction with extra steps.

## 8. The redirect service is a single point of failure for revenue
If `go.<domain>` is down, every monetized link on every property 404s — content still renders, money stops. Mitigations: it's the simplest component in the system (lookup + log-async + 302), so keep it dependency-light (reads from a warm cache of decisions; queue writes), monitor it first, and it's the designated first candidate to split to an edge worker with replicated decision data. Accept the SPOF in v1; do not accept it silently.

## 9. Underspecified in the original framing (now decided, revisit if wrong)
- **Tenant = property**, shared network accounts, tracking-namespace isolation (00 §6).
- **Revenue routing**: single operator, single payout destination per network; the ledger tracks per-tenant P&L but no money movement between entities. If properties ever have distinct owners, that's a different (much heavier) system.
- **"Ads" appear in the prompt's data list but not in scope.** Display ads (AdSense etc.) are a different mechanic (page-level scripts, not offers). The Offer abstraction could stretch to "ad slot enablement" decisions later; explicitly out of v1.
- **Quizzes/tools** are engagement assets whose monetization is indirect (00 §5). In scope as `donation` offers + as *context signals* (quiz answers are high-grade intent metadata for the surface's context — plumb them into `surface.context`, that's the real value).
