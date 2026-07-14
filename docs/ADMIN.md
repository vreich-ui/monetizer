# Administration & Business Overview

## Part 1 — What this system is, in business terms

**Monetizer is an automated revenue layer for a network of content properties.** The content properties attract attention (traffic); Monetizer turns that attention into money without a human deciding what to sell on any given page.

Think of it as an **in-house affiliate/commerce ad server** run by agents instead of a sales team:

- A traditional publisher hires people to sign affiliate deals, hand-pick which products to feature on which articles, paste tracking links, read each network's dashboard, and reconcile payments. That labor is the bottleneck and the cost.
- Monetizer replaces that labor with software. A human does one thing per network — creates an account and hands over the API keys. From there the system discovers what can be sold, decides what to place on each page, generates the tracking links, routes the clicks, and reconciles the money across every network into one honest ledger.

**What it is capable of when agents run it:**

1. **Zero-touch monetization of new content.** When the content agents publish a page and declare its "surfaces" (monetizable slots) with topic/intent metadata, Monetizer automatically matches the best-paying relevant offer and renders it. A thousand new pages need no human merchandising.
2. **One brain across many sites and many networks.** It is multi-tenant: N properties share the machinery but keep isolated tracking and reporting. Add a property, it inherits the whole offer supply immediately.
3. **A single source of financial truth.** Amazon, Impact, CJ, Awin, Stripe, direct merchants — each reports differently, on different schedules, with different reliability. Monetizer normalizes all of it into per-property, per-page revenue with honest quality labels (was this dollar tracked precisely to a click, or only estimated to an account?). This is the number you actually run the business on.
4. **Self-healing inventory.** Dead links, out-of-stock products, terminated programs — detected automatically; clicks fail over to the next-best offer instantly; pages refresh on the next rebuild. No revenue silently leaks.
5. **A feedback loop back into content.** It emits "demand signals" — categories where high-paying offers exist but no content surfaces them. That tells the content agents what to write next to earn more. Monetization data steering content generation is the long-term compounding advantage.
6. **A learning substrate already accumulating.** Every placement decision is logged with the alternatives it considered and the probability it was chosen. Today a transparent rule picks offers; because of that logging, a future optimizer can learn from all historical traffic what actually earns — without re-instrumenting anything.

**The business model it serves:** content is cheap to produce agentically; the scarce, defensible asset becomes *the monetization engine that squeezes the most revenue per visitor across the whole network and gets smarter over time.* Monetizer is that asset.

**What it is not:** it is not an ad network, not a shopping cart, and not a tool for running *your own* affiliate program (recruiting affiliates to sell your product). It sits on the **publisher** side — you have the audience, it earns money from that audience. That distinction matters when evaluating off-the-shelf tools (Part 3).

---

## Part 2 — The agentic control plane (how adapters are administered)

Administration = registering accounts, dropping in feeds, watching health, pausing things, reading revenue. All of it is the **MCP control plane**: 12 tools, served over an authenticated web endpoint agents connect to.

### Endpoint

```
POST  https://<service-url>/mcp
Authorization: Bearer <ADMIN_TOKEN>
```

Streamable HTTP (JSON-RPC), stateless, bearer-authenticated. `401` without a valid token, `503` if `ADMIN_TOKEN` is unset. The same tools also run locally over stdio (`pnpm mcp`) for hands-on setup.

### The 12 tools

| Tool | What it administers |
|---|---|
| `register_tenant` | Onboard a content property; returns its resolve token |
| `set_tenant_tracking` | Per-network tracking IDs/subid prefixes for a property |
| `register_credential` | **The account handoff.** Store + verify a network's API keys; auto-starts catalog sync |
| `list_sources` | Every network adapter: status, declared capabilities, health, last sync |
| `ingest_csv` | Feed offers or transaction reports for no-API sources (Amazon, direct merchants, datafeeds) |
| `search_offers` | Inspect the normalized offer catalog |
| `explain_decision` | Why an offer was chosen: full candidate set, scores, policy version, propensity |
| `performance` | Traffic + revenue rollups with state & attribution-fidelity qualifiers |
| `demand_signals` | Unmet demand → what content to make next |
| `trigger_rebuild` | Refresh a property's rendered offers |
| `pause_offer` / `pause_source` | Kill-switches; existing links fail over instantly |
| `register_connection` | **Generic supplier onboarding** — arbitrary supplier via base_url + auth model + secrets + collection recipes |
| `list_connections` / `delete_connection` | Manage generic connections (secrets never returned) |
| `test_request` | Author aid — one guarded request + detected array paths, so an agent builds a recipe cheaply |
| `run_collection` | Run a connection's recipes on demand (they also run on schedule) |

### Generic connections — agent-authored, engine-executed (the AI-cost lever)

Beyond the seven built-in networks, an agent can register **any** HTTP supplier and describe how to collect from it, once. The engine then runs that collection deterministically on a schedule — **no AI in the loop per cycle**, which is the point: author once (a little AI), monitor forever (no AI).

`register_connection` accepts a bounded-but-liberal shape:
- **`auth`** — one of `none | bearer | api_key_header | basic | query_param | oauth2_client_credentials`. A `value_template` composes secret fields, e.g. `"{app_id}:{app_secret}"` or `"Bearer {token}"`.
- **`secrets`** — an arbitrary `{key: value}` map (≤50 keys), encrypted at rest, referenced by `{key}` in the template. Never returned by any tool.
- **`recipes[]`** — declarative collection jobs. Each has a `sink` (`transactions` | `offers`), a request (`path`, `query`, pagination), a `records_path` (dot-path to the array), and a `map` of `our_field → 'response.dot.path'` (prefix `=` for a literal). The engine fetches, paginates, maps, and writes to the offer store / conversion pipeline.

Authoring loop for an agent: `register_connection` (auth only) → `test_request` to see the response shape → add `recipes` → `run_collection` to confirm → done; it now runs on the report/catalog schedule.

**Safety:** every outbound request is **SSRF-guarded** — private/loopback/link-local ranges and the cloud metadata endpoint are refused (an agent can't point the engine at internal infrastructure), only `http(s)`, with per-request timeouts and a response-size cap.

### Connecting

The endpoint supports **two auth paths to the same tools**, so every Claude surface can attach:

**A. Claude connector UI (claude.ai / Claude Desktop) — OAuth.** These do a discovery + OAuth flow, not a static header. The server ships a full OAuth 2.1 Authorization Server (metadata, dynamic client registration, PKCE). To connect:
1. Settings → Connectors → **Add custom connector** → URL = `https://<service-url>/mcp`.
2. Claude discovers the OAuth endpoints and opens a **consent page**. Enter your **`ADMIN_TOKEN`** there (it's the login secret) and click Authorize.
3. Claude receives an access token and attaches. Done — no header configuration.

**B. Claude Code / Agent SDK / scripts — static bearer.** Simpler for headless agents:
```jsonc
// .mcp.json  (or the SDK's mcpServers config)
{
  "mcpServers": {
    "monetizer": {
      "type": "http",
      "url": "https://<service-url>/mcp",
      "headers": { "Authorization": "Bearer ${MONETIZER_ADMIN_TOKEN}" }
    }
  }
}
```
Or: `claude mcp add --transport http monetizer https://<service-url>/mcp --header "Authorization: Bearer $MONETIZER_ADMIN_TOKEN"`.

Both land on the same 12 tools. The OAuth path mints per-connection tokens gated by the admin token at consent; the bearer path uses the admin token directly. CORS + preflight are handled so browser-based connectors work.

The agent then calls `register_credential`, `list_sources`, `performance`, etc. as normal tools. An "operations agent" on a schedule (check health, react to `demand_signals`, pause misbehaving sources) is the intended end state.

### Security notes

- `ADMIN_TOKEN` is the whole key to the control plane — treat it like a root password; store it in Secret Manager, rotate by updating the secret + the service env var. Consider a distinct token per agent later (the auth seam is one function, `tokenMatches`, easy to extend to a token table).
- Network **secrets** (the affiliate API keys) are never returned by any tool — they go in encrypted, `register_credential` reports only pass/fail. The control plane administers accounts without ever re-exposing them.

---

## Part 3 — Admin UI: what to reuse, not build

You asked whether an existing tool covers this "income management" administration rather than building bespoke screens. Findings from surveying the ecosystem:

### The direct-analog products are commercial SaaS, and they are the publisher-side "income management" category

The recognizable names that do exactly what Monetizer's reporting does — **aggregate affiliate income across many networks into one dashboard with page-level attribution** — are **Affilimate, Strackr, Trackonomics, and AffJet**. That category *is* "affiliate revenue / income management." They are hosted SaaS, not self-hostable, and using one instead of Monetizer would mean giving up the decisioning/placement engine and per-click first-party data that are the point here. **Strackr specifically is still worth paying for as a data source** (already wired as a reporting adapter) — but as an ingest, not as your admin surface.

Beware the false match: searches for "open source affiliate software" surface **PostAffiliatePro, Scaleo, Reflio, Tapfiliate**. These are **merchant-side** — for running your *own* affiliate program. Wrong side of the market; do not adopt one.

Verdict: **there is no open-source, publisher-side, multi-network income-management admin tool to drop in.** That gap is exactly why Monetizer exists.

### For the human oversight UI, use a generic admin panel over Postgres — don't build one

Everything a human admin needs to see or edit is already in Postgres (sources, credentials [masked], offers, decisions, ledger, the `v_*` views). Point a mature, self-hostable admin panel at it:

| Tool | Fit | Notes |
|---|---|---|
| **Metabase** (recommended for the money view) | Dashboards/BI over the `v_*` revenue views | Already the recommendation in the plan; zero code, self-hostable, the right tool for "income management" reporting. |
| **NocoDB** or **Directus** (recommended for record admin) | Airtable-/CMS-style CRUD over the tables | Self-hostable, recognizable, no code. Good for browsing offers, flipping an offer/source status, reviewing tenants. Point read-mostly; keep writes that have side-effects (credential verify, catalog sync) in the MCP tools, not raw table edits. |
| **AdminJS** | Code-defined admin embedded in the Node app | Only if you want the admin panel to live *inside* the engine and reuse its logic; more work than NocoDB/Directus for the same result. |
| Appsmith / Kottster / Retool | Internal-tool builders | Fine alternatives to NocoDB/Directus; pick by familiarity. |

**Recommended split:**
- **Agents administer through the `/mcp` web endpoint** (this is the operational control plane — verify, ingest, pause, react).
- **Humans watch through Metabase** (revenue, EPC/RPM, attribution quality) and optionally **NocoDB/Directus** for read-mostly record inspection.
- **Do not** let a generic panel write to `credentials`, `sources`, or `decisions` directly — those mutations have side-effects (encryption, verification probes, catalog jobs, supersede semantics) that only the MCP tools/engine perform correctly. Generic panels are for *seeing*, the MCP plane is for *doing*.

### Sources
- Admin panels over Postgres: [Kottster](https://kottster.app/admin-panel-for-postgresql), [Appsmith](https://www.appsmith.com/blog/one-open-source-project-for-admin-panels-crud-apps-internal-tools), [best-of lists 2026](https://www.weweb.io/blog/best-admin-panel-builder-tools).
- Affiliate income aggregation (the direct SaaS analog): [Affilimate alternatives](https://startupstash.com/afffilimate-alternatives/), [Trackonomics](https://trackonomics.net/affiliate-dashboard/), [Strackr](https://strackr.com/).
- Why OSS is thin / merchant-vs-publisher trap: [open-source affiliate software overview](https://refgrow.com/open-source-affiliate-software), [Scaleo list](https://www.scaleo.io/blog/affiliate-program-software-open-source-solutions/).
