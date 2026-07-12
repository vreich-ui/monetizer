# monetizer

Standalone, multi-tenant monetization engine for a network of agent-operated content properties. Projects are dumb renderers; the engine owns offer supply, decisioning, the click path, and measurement.

**Status: design phase.** The full development plan lives in [`docs/plan/`](docs/plan/00-overview.md):

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
