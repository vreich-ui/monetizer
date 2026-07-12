# 02 — Engine ↔ Project Boundary

## The verdict: build-time resolve + request-time redirect + async beacon

Two pure models were considered and both rejected:

- **Pure request-time** (edge function calls engine per pageview): fresh decisions and personalization, but adds latency to every pageview, defeats CDN caching, makes the engine a runtime dependency of N sites (blast radius: engine down → sites degraded), and buys nothing today because personalization is explicitly deferred.
- **Pure build-time** (decisions baked into HTML, links point at final affiliate URLs): fast and decoupled, but freezes link destinations between builds (dead offers stay dead until rebuild), loses first-party click capture entirely, and makes per-click subid injection impossible.

The hybrid keeps each model's strength by splitting the decision from the click:

1. **Decisions are made at build time** via a resolve API. Content is static, CDN-cached, zero runtime coupling for rendering.
2. **Every monetized click routes through the engine's redirect service.** The href baked into the page is `https://go.<redirect-domain>/r/{merchant-slug}/{decision_id}[/{offer_rank}]` — *never* a raw affiliate URL. At click time the engine: logs the click (assigns `click_id`), builds the final network link via the adapter (injecting `click_id` as subid where the network supports it), and 302s. This is the permanent runtime control point: dead-offer failover, link re-pointing, subid strategy changes, and geo-routing all happen here **without rebuilds**.
3. **A tiny self-hosted beacon** (<2KB, no third-party) fires `impression` and `viewable` events carrying decision IDs — the denominators for EPC/RPM. Async, non-blocking, loses nothing if it fails.

Redirect transparency requirement (Amazon ToS, see 05): the merchant slug appears in the redirect path (`/r/amazon/...`), exactly one 302 hop, correct `Referer` semantics preserved, no meta-refresh or JS interstitials. This is data-driven per offer (`constraints.tos.redirect_transparency_required`), not hardcoded for Amazon.

## What a project MUST implement (the minimum monetizable contract)

1. **Declare surfaces** with context metadata authored against the engine's published context taxonomy (version-pinned package). Declaration lives where the content lives — frontmatter for whole-page surfaces, component props for inline ones.
2. **Resolve at build**: one batched `POST /v1/resolve` call during the Astro build; render the returned payloads with dumb components. Fail-open: on engine unreachable, render from the last cached manifest (see below), else render nothing — a build must never hard-fail on the engine.
3. **Route every monetized href through the redirect domain.** Projects never construct affiliate links, never see network credentials, never append tags.
4. **Render required disclosures.** Resolve payloads include `disclosure` blocks (offer-level, e.g. Amazon's mandated wording; page-level FTC affiliate disclosure). Rendering them is a contract obligation, not a suggestion — compliance metadata is engine-owned, compliance rendering is project-owned.
5. **Include the beacon** snippet.

Everything above ships as an **`@vreich-ui/monetizer-astro` integration package** (components: `<OfferBox>`, `<ComparisonTable>`, `<InlineOffer>`, `<TipJar>`; a build hook that collects surface declarations, calls resolve, injects the beacon). A project's real integration cost should be: install package, set two env vars (engine URL, tenant token), add components to templates.

## The resolve API

```
POST /v1/resolve            (auth: per-tenant token)
{
  tenant: "property-slug",
  build_id: "...",
  surfaces: [ { surface },  ... ]          # full surface declarations; engine upserts them
}
→
{
  decisions: [ {
      surface_id, decision_id,
      offers: [ { rank, title, brand, image_url, price: {amount, currency, as_of},
                  badge?, cta_text, href,                     # href = redirect URL, pre-built
                  disclosure? } ],
      presentation_hints, ttl_s
  } ],
  page_disclosures: [ ... ],
  coverage: { resolved, unresolved: [surface_id...], reasons: {...} },
  taxonomy_version_expected
}
```

Notes:
- `unresolved` is a legitimate outcome (no offer clears the score floor) — the component renders nothing. An empty slot beats a bad offer; bad offers burn trust and network approval.
- Prices in payloads carry `as_of`; components must render staleness-compliant formats where `constraints.tos.max_price_age_h` applies (the Astro kit handles this).
- Idempotent per `(surface, build_id)` so build retries don't mint duplicate decisions.

## Netlify Blobs manifest (cache, not source of truth)

After each resolve, the engine writes the decision manifest to the tenant's Netlify Blob store. Purpose: (a) build-time fail-open cache, (b) fits the existing "Blobs as source of truth" idiom for *projects* — but for monetization data the engine's Postgres is the source of truth and the blob is a projection. Do not let this invert: decisions, events, and money live in the engine.

## Rebuild control (engine → project)

The engine holds each tenant's Netlify build hook and triggers rebuilds on its own judgment:
- **Urgent**: chosen offer died (link rot, out of stock, program terminated) and redirect-level failover to the runner-up candidate is already live → rebuild to fix rendered price/title/image.
- **Routine**: a materially better decision exists (score delta above threshold), staleness TTLs expired. Batched/debounced per tenant.

Redirect-level failover is what makes rebuilds non-urgent: the *link* is never broken, only the rendered card can be stale. This asymmetry is the main payoff of the hybrid model.

## Request-time upgrade path (deferred, not precluded)

Because a Decision is the same object regardless of when it's made, request-time decisioning later is additive: an edge middleware asks `GET /v1/decide?surface=...&ctx=...` and swaps innerHTML for designated "live" slots. Nothing in the schema or contract changes; only a new latency-sensitive endpoint plus per-request context. Do not build this until a concrete personalization hypothesis exists.

## MCP surface (control plane)

The engine exposes an MCP server — the network's existing idiom for agent control:
- `register_tenant`, `register_credential` (the human handoff tool — see 03)
- `search_offers`, `explain_decision(decision_id)` (full candidate set + scores — the debugging tool)
- `performance(tenant?, surface?, offer?, period)` — EPC/RPM/revenue with fidelity qualifiers
- `demand_signals()` — unmatched offer inventory by category, for content agents (see 00 §Correction 3)
- `trigger_resolve(tenant)`, `pause_offer/source/tenant`
