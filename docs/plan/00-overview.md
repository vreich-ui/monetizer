# Monetizer — System Overview and Design Thesis

**Status:** Design complete, pre-implementation.
**Audience:** This document set is written as a spec for implementation sessions (Claude Code). Each document is self-contained enough to drive a work phase; this one holds the thesis and the corrections to the original framing.

## What this is

A standalone, multi-tenant **monetization engine** serving a network of AI-agent-operated content properties (Astro/Netlify, Netlify Blobs, MCP-controlled, `vreich-ui` org). Projects are dumb renderers. The engine owns:

- **Offer supply**: discovering and normalizing monetizable things (affiliate products across networks, own digital products via Stripe, engagement/tip-jar assets).
- **Decisioning**: matching offers to monetizable surfaces in content, and recording *why* (candidates, scores, policy version, propensity) so a learning layer can be added later without re-architecture.
- **The click path**: every monetized click routes through the engine's redirect service — the permanent runtime control point and the primary event source.
- **Measurement**: a bitemporal event/attribution pipeline that joins first-party clicks to network-reported conversions at whatever fidelity each network permits, and never pretends to more fidelity than it has.

The only human touchpoint is credential handoff (create accounts, hand keys to the engine's credential broker). Everything downstream is automated.

## Document map

| Doc | Contents |
|---|---|
| [01-domain-model.md](01-domain-model.md) | Core abstraction: Source → Offer → Surface → **Decision** → Outcome. Tenancy. Money model. |
| [02-engine-project-contract.md](02-engine-project-contract.md) | The boundary: build-time resolve, request-time redirect, beacon, rebuild hooks, Astro kit. |
| [03-network-adapters.md](03-network-adapters.md) | Capability-declared adapters, per-network dossiers, credential broker, Strackr shortcut. |
| [04-events-attribution.md](04-events-attribution.md) | Event envelope, click capture, conversion observations, attribution resolver, ledger, denominators. |
| [05-hard-problems.md](05-hard-problems.md) | Honest risk register — including the ones with no engineering mitigation. |
| [06-oss-and-buy.md](06-oss-and-buy.md) | Where OSS genuinely fits, where it's thin, where a small commercial API beats building. |
| [07-roadmap.md](07-roadmap.md) | Critical path, parallel tracks, session-sized tasks, and the human-action checklist (account signups). |

## Corrections to the original framing

These were requested ("push back where my framing is wrong") and they materially change the plan.

### 1. ShareASale no longer exists
ShareASale closed on **October 6, 2025**; all programs migrated to **Awin**. The adapter list is: Amazon, Impact, CJ, Awin, direct merchant programs. Do not build a ShareASale adapter.

### 2. Amazon PA-API is dead; the constraint set changed
PA-API v5 retired **May 15, 2026**. Its replacement, the **Creators API** (OAuth2, REST), is the only sanctioned catalog source. It is sales-gated: access and rate limits scale with qualified referred sales, and lapse without them. Amazon is simultaneously the highest-revenue network, the worst-instrumented (no per-click subid — tracking-ID granularity only), and the highest-risk (ToS on redirects, price display, and content quality). The architecture treats Amazon as the *fidelity-degraded stress case*, not the reference case — the reference adapter is an API-complete network (Impact or Awin). See 03 and 05.

### 3. "Attention as a given input" is the framing's biggest hole
Monetization quality is not separable from **intent quality**. RPM across intent classes varies by ~100x ("best travel tripod" vs. "history of tripods"). The engine can match offers to context, but it cannot conjure commercial intent, and it cannot invent placement inventory in content it doesn't control. Two consequences baked into the design:

- The engine **defines the context taxonomy** (intent class, topic, entities) and the content-generation agents must emit it when declaring surfaces. This is a cross-system contract, specified in 02.
- The engine emits **demand signals** upstream ("high-commission offer inventory in category X has no matching surfaces") — v1 is just a table and an MCP tool, but the channel exists from day one. Monetization data should eventually steer content generation; the engine is where that data lives.

### 4. "Optimization deferred" is right, but one piece cannot be deferred
Model training can wait. **Decision logging discipline cannot.** If decisions are logged without the candidate set considered, the policy version, and the propensity (probability of the chosen action under the policy), the future learning layer is limited to crude A/B experiments instead of off-policy learning over all historical traffic. Logging these three fields costs almost nothing now and is impossible to retrofit. The v1 "policy" is a transparent heuristic score — but it is versioned, seeded-random where it explores, and logged like a real policy from the first decision. See 01 §Decision.

### 5. The engagement/tip-jar surface is a different animal — admit it
Quizzes/tools → Patreon/BMC fits the Offer abstraction fine (a `donation`-economics offer, conversions via webhook/poll). But its direct EPC will be negligible. Its real value is engagement, return visits, and email capture — assets, not revenue. The plan includes it (it's cheap, and it proves the abstraction's third economics type) but ranks it last and does not distort the design for it.

### 6. Underspecified: what is a "tenant"?
Property? Brand? Legal entity? This matters because affiliate accounts are per-legal-entity, while tracking IDs/subids are per-property. Decision (changeable): **tenant = property**, sharing network accounts by default, isolated by tracking-ID/subid namespace. Shared account = shared ban blast radius; the credential model supports account-per-tenant scoping for later isolation of risky properties. See 03 §Tenancy.

## System shape

One deployable **modular monolith** (TypeScript/Node) + Postgres. Services within it are modules with clean interfaces, split-out-able later; none of them justify separate deployment at content-network scale (10³–10⁵ clicks/day is a small-Postgres problem, not a Kafka problem).

```
                    ┌─────────────────────────────────────────────┐
                    │                MONETIZER                     │
   Netlify build ──▶│ resolve API ──▶ Decision Engine              │
   (per project)    │                    │    ▲                    │
                    │                    ▼    │ scores             │
   MCP clients  ──▶ │ MCP surface     Offer Store ◀── Adapters ────┼──▶ Amazon / Impact /
   (you + agents)   │                    ▲          (catalog,      │    CJ / Awin / Stripe /
                    │                    │           links,        │    BMC / CSV inbox /
   Visitor click ──▶│ Redirect svc ──▶ Event Log    reporting)     │    Strackr
                    │ Beacon       ──▶     │                       │
                    │                      ▼                       │
                    │            Attribution Resolver ──▶ Ledger   │
                    │                      │                       │
                    │                      ▼                       │
                    │            (future: learning layer reads     │
                    │             decisions + outcomes, swaps in   │
                    │             as a new DecisionPolicy)         │
                    └─────────────────────────────────────────────┘
```

Hosting: engine on Fly.io/Railway (needs long-running workers + Postgres proximity; Netlify Functions is the wrong shape for the pollers). Redirect service runs inside the monolith v1 (a 302 with an async write is fast enough); it's the first candidate to split out to an edge worker if latency ever matters.

## Glossary

- **Source** — anything that supplies offers: a network adapter, the Stripe catalog, tip-jar config.
- **Offer** — a normalized monetizable proposition with economics, constraints, and tracking-fidelity metadata.
- **Surface** — a declared monetizable location in a project's content, with context metadata. The inventory.
- **Decision** — the engine's immutable, logged assignment of offer(s) to a surface. The unit everything joins on.
- **Fidelity** — how precisely a conversion can be attributed (click / surface / property / account level). A first-class property of every source and every attributed edge.
- **Observation** — one poll/webhook sighting of a network-side fact (a conversion, a payout). Immutable; current state is derived.
