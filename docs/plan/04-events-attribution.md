# 04 — Events, Attribution, and the Money Ledger

This is the part that must be right now: the substrate the future learning layer eats. The design rules are (1) append-only everywhere, (2) bitemporal for anything network-reported, (3) fidelity recorded on every attributed edge, (4) denominators are first-class.

## Event envelope

One `events` table (Postgres, partitioned by month). Envelope columns typed; payload JSONB; **`schema_version` on every row from day one**.

```
event:
  id             ULID (time-ordered)
  schema_version
  type           impression | viewable | click | checkout_started | conversion_observed | payout_observed | system
  occurred_at    # event time
  recorded_at    # ingestion time
  tenant_id, surface_id?, decision_id?, offer_id?, source_id?
  visitor_hash?  # see Identity
  click_id?      # for click and anything joined to one
  payload        JSONB
```

Scale honesty: a content network produces 10³–10⁵ clicks/day and maybe 10⁶ impressions/day. Postgres with monthly partitions handles this for years on a small instance. **No Kafka, no ClickHouse, no streaming framework.** The extensibility valve is a nightly export of event partitions to Parquet (object storage) — that's the future training-data feed, queryable ad hoc with DuckDB, and the migration path if volume ever demands a real OLAP store.

## Click capture (the redirect service)

`GET /r/{merchant-slug}/{decision_id}[/{rank}]`:
1. Look up decision → chosen offer (or failover to next live candidate if dead — log `system` event when failing over).
2. Mint `click_id` (ULID). Write click event **async** (queue, not in the request path); the 302 must not wait on the DB.
3. Ask the adapter for the final URL: `links.build(offer, tenant, click_id)` — injects `click_id` into SubId1/SID/clickref where fidelity=click; applies tenant tracking-ID where fidelity=property (Amazon).
4. 302. Single hop, honest referrer, merchant slug visible in path (Amazon ToS).

Click event payload: decision_id, offer_id, rank, url_path, referrer, UA class (parsed, not raw), coarse geo (country from IP, then discard IP), visitor_hash, bot signals (see IVT).

Also log `redirect_failed` (dead decision id, no live candidate) — these are monetization bugs surfacing.

## Identity (deliberately minimal)

`visitor_hash = hash(salt_daily, site, IP, UA)` — same-day dedup and session-ish grouping, no cross-day, no cross-site tracking, no cookies, no consent-banner burden. Sufficient for CTR/CVR denominators and frequency features later. **Do not build cross-site identity.** It's a compliance tarpit and the learning layer doesn't need it (it optimizes offer×context, not user profiles).

## Impressions / denominators

The beacon posts `impression` (component mounted, decision_id) and `viewable` (50% visible ≥1s, IntersectionObserver) to `POST /v1/beacon` (batched, sendBeacon API). Also one `pageview` event per page with the surface-bearing page's path — the engine then has every denominator it needs: revenue/click (EPC), clicks/viewable (CTR), revenue/pageview (RPM) per offer, surface, context, tenant. Without viewability, "offer A outperforms B" is unanswerable — placement position confounds everything. This is why the beacon is Phase-2, not deferred (07).

## Conversion observations (bitemporal)

Every adapter poll or webhook produces immutable **observations**:

```
conversion_observation:
  id, source_id, observed_at
  network_txn_id, network_click_time?, network_txn_time
  subid_echo?            # our click_id, if the network echoes it
  tracking_key?          # tracking-ID / SID-prefix / clickref-prefix actually reported
  merchant/program, items?         # itemized where available
  order_amount, commission_amount, currency
  network_status         # raw: pending/locked/approved/reversed/adjusted/paid (per network vocab)
  raw ext JSONB
```

The same network transaction observed five times over 60 days = five rows. A `conversions` current-state table is **derived** (latest observation per `(source, network_txn_id)`, normalized status). This is what makes commission mutability (reversals, adjustments, 30–90-day locking) representable instead of destructive, and it hands the learning layer honest delayed-reward data: for any past date you can reconstruct *what was known then* vs. *what turned out to be true*.

## Attribution resolver

A batch job (idempotent, re-runnable) that joins conversions to decisions:

1. **Click-level**: `subid_echo` present → exact join to click → decision. `resolution = click`.
2. **Surface/property-level**: no subid (Amazon) → join via `tracking_key` (which maps to tenant or surface-group per 03 §Tenancy) + time window vs. click log; allocate proportionally to that key's clicks on that merchant in the window. `resolution = surface | property`, allocation weights recorded.
3. **Account-level**: aggregate-only CSV sources → smear across the account's clicks for the period. `resolution = account`.

Attribution edges are their own append-only table (`conversion_id, decision_id, weight, resolution, resolver_version`) — re-running a smarter resolver later writes new edges under a new version; nothing is destroyed. Every revenue number downstream carries its resolution label (01 §Money model rule). The learning layer will weight click-resolution data heavily and account-resolution data barely — but only if the labels exist.

**Known impossibility, accepted:** cross-network dedup (user clicks an Impact link, then an Amazon link, buys on both/either; networks apply their own last-click within their own cookie windows). Do not try to arbitrate truth across networks. Record what each network claims, reconcile totals against payout reports, and treat overlap as noise the learning layer tolerates.

## Ledger

`ledger_entries` (append-only, double-entry-lite): commission recognized / adjusted / reversed / paid, keyed to conversion + tenant. Feeds: revenue dashboards with the three qualifiers (state, resolution, as-of), payout reconciliation (network payout reports vs. sum of approved), and per-tenant P&L. Not a general accounting system — resist the urge.

## Invalid traffic (IVT)

Agent-operated properties attract scrapers and bots, and **networks judge publishers on traffic quality** — garbage clicks are an account-risk vector, not just noise. v1 is heuristic flagging, not blocking: known-bot UAs, datacenter ASNs, headless signals, click-without-impression, sub-second click-after-load. Flags land on the click event (`ivt_score`, `ivt_reasons`); attribution and dashboards can filter; nothing is deleted. Real IVT vendors exist but are ad-tech-priced; heuristics + monitoring are proportionate here.

## Traffic analytics (adjacent, not core)

Umami or Plausible (OSS, self-hosted) can serve human-facing traffic dashboards, but the engine's beacon is the source of truth for anything monetization-adjacent because per-decision impression/viewability granularity doesn't exist in page-analytics products. Don't double-instrument pages beyond beacon + (optionally) one analytics script.

## Retention & export

Raw events: keep hot 13 months, then Parquet archive. Observations & ledger: keep forever (small). Nightly Parquet export from day one — it costs an afternoon and quietly becomes the training corpus.
