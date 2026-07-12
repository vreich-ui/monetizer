# monetizer

Standalone, multi-tenant monetization engine for a network of agent-operated content properties. Projects are dumb renderers; the engine owns offer supply, decisioning, the click path, and measurement.

## Layout

- `engine/` — the service: resolve API, redirect/click path, beacon, webhooks, job workers, attribution resolver, MCP control server. TypeScript + Hono + Postgres.
- `packages/context-taxonomy/` — the versioned context contract content agents author surfaces against.
- `packages/astro-kit/` — build-time resolve client + dumb Astro components + beacon snippet for projects.
- `docs/OPERATIONS.md` — **accounts to create, env vars to set, credential handoff, runbook.**
- `deploy/gcp.md` — Cloud Run + Cloud SQL deployment (the target hosting).
- `docs/plan/` — the design documents (the code follows them).

## Quickstart

```bash
pnpm install
cp .env.example .env        # fill DATABASE_URL, CRED_MASTER_KEY, ADMIN_TOKEN
pnpm migrate
pnpm dev                    # engine on :8787
pnpm mcp                    # stdio MCP control server (credential handoff etc.)
pnpm test                   # vitest against a local monetizer_test db
```

## Design docs

| Doc | Contents |
|---|---|
| [00-overview](docs/plan/00-overview.md) | Thesis, framing corrections, system shape, glossary |
| [01-domain-model](docs/plan/01-domain-model.md) | Source → Offer → Surface → **Decision** → Outcome |
| [02-engine-project-contract](docs/plan/02-engine-project-contract.md) | Build-time resolve, request-time redirect, beacon, Astro kit |
| [03-network-adapters](docs/plan/03-network-adapters.md) | Capability-declared adapters, credential broker, network dossiers |
| [04-events-attribution](docs/plan/04-events-attribution.md) | Event envelope, bitemporal conversions, attribution resolver, ledger |
| [05-hard-problems](docs/plan/05-hard-problems.md) | Risk register, including non-engineering risks |
| [06-oss-and-buy](docs/plan/06-oss-and-buy.md) | Integrate / buy / build verdicts |
| [07-roadmap](docs/plan/07-roadmap.md) | Critical path, phases, human-action checklist |
