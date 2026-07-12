# 01 — Domain Model: The Core Abstraction

## The unit the engine traffics in is the **Decision**

Three candidate abstractions were considered:

- **"Offer"-centric** — the engine is a catalog with a matching function. Fails because a catalog can't be optimized: you can't compute counterfactuals from "these offers existed."
- **"Placement"-centric** — the engine manages slots. Fails because it couples the engine to project internals and makes cross-project learning awkward.
- **"Decision"-centric** — the engine's atomic act is *assigning offers to a surface in a context, under a policy, with a recorded probability*. Offers are the supply catalog; surfaces are the demand inventory; **decisions are the transactions**, and outcomes attach to decisions.

Decision-centric wins because it is exactly the shape a learning layer consumes: `(context, action, propensity) → delayed reward`. It also solves a practical problem no other framing solves: content pages are cached/static and outlive the decisions that rendered them, so the join key threaded through links must identify *the decision that produced the link*, not the surface or the offer in the abstract.

This mirrors ad-tech deliberately: catalog / inventory / auction-result / impression-click-conversion. Affiliate monetization *is* self-hosted ad serving; borrow the industry's hard-won data model.

## Entity graph

```
Tenant (property)
  └─ Surface ──(context)──┐
                          ▼
Source ──▶ Offer ──▶  DECISION ──▶ Event (impression, click)
 (adapter)   ▲            │              │
             │            │              ▼
        OfferSnapshot     └────▶ Attribution ◀── ConversionObservation ◀── Source (reporting)
        (price/stock                │
         history)                   ▼
                                 Ledger (commission state machine)
```

## Entities

### Tenant
A content property. `id`, `name`, `domains[]`, `netlify_site_id`, `build_hook_url`, `blob_store_ref`, tracking-namespace assignments per network (e.g. its Amazon tracking-ID, its Impact SubId1 prefix). Every other entity is tenant-scoped or global-with-tenant-visibility (offers are global; surfaces, decisions, events are tenant-scoped).

### Source
A supplier of offers and/or conversion reports. `kind: affiliate_network | payment_provider | donation_platform | csv_inbox`, `network: amazon|impact|cj|awin|stripe|bmc|patreon|direct:<slug>`, capability declarations (see 03), credential reference, health/quota state. Sources are where **fidelity** is declared: `attribution_fidelity: click | surface | property | account`, `reporting_lag_estimate`, `reporting_completeness: itemized | aggregate`.

### Offer
A normalized monetizable proposition. Canonical schema — everything the decision engine needs to score and everything the renderer needs to draw — plus an `ext` JSONB bag for network-specific payload (adapter-private, never read by core).

```
offer:
  id                (ULID)
  source_id
  merchant          { name, program_id, domain }
  kind              affiliate_product | affiliate_program_cta | digital_product | donation
  title, brand, image_url, description
  taxonomy          { category_path[], entities[], keywords[] }   # engine-assigned, versioned
  economics:
    type            commission_pct | commission_fixed | sale_margin | donation
    rate / amount
    currency
    cookie_window_days
    avg_order_value_estimate?      # from network data where available
  price             { amount, currency, as_of }    # snapshot; history in offer_snapshots
  constraints:
    geo[]           # eligible countries
    tos             { max_price_age_h?, disclosure_text_id?, redirect_transparency_required?, no_email_use?, ... }
  tracking:
    link_template   # adapter-owned recipe; core never builds links
    subid_fidelity  click | surface | property | none
  lifecycle         active | stale | dead | paused    # + checked_at, dead_reason
  ext               JSONB
```

Notes:
- **Digital products and tip-jars are just offers** with `economics.type = sale_margin | donation` and a payment-provider source. Their conversions arrive by webhook (click-level fidelity, near-zero lag) — the *best* case on the same fidelity spectrum where Amazon is the worst case. The abstraction is proven by the spectrum, not by special-casing.
- **OfferSnapshot** (separate append-only table): price/availability observations over time. Needed for Amazon price-display compliance (price must be fresh) and later for "price drop" style decisioning.
- Offer identity: `(source, network_native_id)` unique; a canonical product identity across networks (same physical product on Amazon and via Impact) is a **deliberate non-goal for v1** — cross-network product dedup is hard and low-value until the learning layer wants it. Leave a nullable `canonical_product_id` for later.

### Surface
A declared monetizable location. Registered by projects at build time (upsert on every build).

```
surface:
  id            (stable: hash of tenant + content_id + slot_key)
  tenant_id
  content_id    # page/article identity in the project
  url_path
  slot_type     inline_link | product_box | comparison_table | end_cta | quiz_result | download_offer | tip_jar
  context:
    intent_class     commercial_investigation | transactional | informational | engagement   # taxonomy v1
    topic, entities[], keywords[]
    locale, audience_geo?
  status        active | retired
  context_version    # taxonomy version the metadata was authored against
```

The **context taxonomy is a versioned artifact owned by the engine** (a JSON schema + controlled vocabulary published as a package). Content agents must author against it. This is the contract that makes matching possible; see 00 §Correction 3.

### Decision — the core record
Immutable once issued. A new resolve for the same surface produces a *new* decision that supersedes the old one (superseded decisions remain valid attribution targets — cached pages still reference them).

```
decision:
  id              (ULID — appears in every rendered link and beacon event)
  surface_id, tenant_id
  policy          { name, version, params_hash }
  candidates      [ { offer_id, score, score_components: {relevance, econ_value, freshness, ...} } ]  # top-N considered
  chosen          [ { offer_id, rank, presentation_hints } ]     # 1..k offers (comparison tables choose k)
  propensity      # P(chosen | policy, context); 1.0 for pure-greedy, <1 when exploring
  explore         bool, seed
  issued_at, supersedes_decision_id?
```

**Non-negotiable from day one:** `policy.version`, `candidates` with scores, and `propensity` are logged on every decision, even while the policy is a hand-written heuristic. The v1 policy is:

```
score(offer, surface) =
    w_r · relevance(offer.taxonomy, surface.context)      # v1: embedding cosine + rule boosts
  × w_e · expected_value(economics)                       # rate × price × crude CVR prior by network/kind
  × w_f · freshness/liveness penalty
```
with ε-greedy exploration (ε configurable per tenant, seeded, propensity recorded). All weights and priors live in a versioned policy config, not in code. This is deliberately dumb math with honest bookkeeping — the bookkeeping is the point. The `DecisionPolicy` interface (`score+select(surface, candidates) → decision`) is the future learning layer's plug-in point; GrowthBook or a bandit service slots in behind it without touching anything else.

### Events, ConversionObservations, Ledger
Specified fully in [04-events-attribution.md](04-events-attribution.md). Summary: append-only event log (impression / viewable / click / checkout_started); conversions stored as immutable **observations** (each poll or webhook sighting is a row) with current state derived; a commission **ledger** with the state machine `pending → approved → paid` plus `reversed`/`adjusted`, because affiliate revenue is mutable for 30–90 days and any design that updates conversions in place will lie on dashboards and poison training data.

## Money model rule

All revenue figures carry three qualifiers everywhere they appear — in tables, APIs, and dashboards:
1. **State**: pending / approved / paid / reversed.
2. **Attribution resolution**: click / surface / property / account (how the money was joined to a decision).
3. **Observation time vs. event time** (bitemporal): when the network says it happened vs. when we learned of it.

This is the substrate rule the future learning layer depends on: delayed, censored, mutable rewards with per-edge fidelity labels.
