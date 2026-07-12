import type { Db } from '../db/client.ts'

/**
 * Attribution resolver (docs/plan/04): joins network conversions to first-party
 * clicks/decisions at whatever fidelity the source permits, labels every edge,
 * derives current conversion state, and writes ledger entries on transitions.
 * Idempotent and re-runnable; a smarter resolver later writes new edges under
 * a higher resolver_version without destroying anything.
 */

export const RESOLVER_VERSION = 1
const DEFAULT_COOKIE_WINDOW_DAYS = 30

interface ObsRow {
  id: string
  source_id: string
  network_txn_id: string
  observed_at: string
  network_txn_time: string
  subid_echo: string | null
  tracking_key: string | null
  program_ref: string | null
  order_amount: string | null
  commission_amount: string
  currency: string
  status_norm: string
}

export interface ResolverStats {
  conversions_updated: number
  edges_written: number
  ledger_entries: number
}

export async function runAttribution(db: Db, opts: { lookbackDays?: number } = {}): Promise<ResolverStats> {
  const lookback = opts.lookbackDays ?? 90
  const stats: ResolverStats = { conversions_updated: 0, edges_written: 0, ledger_entries: 0 }

  // 1. Latest observation per (source, txn) inside the lookback window.
  const { rows: latest } = await db.query<ObsRow>(
    `select distinct on (source_id, network_txn_id) *
       from conversion_observations
      where observed_at > now() - ($1 || ' days')::interval
      order by source_id, network_txn_id, observed_at desc`,
    [String(lookback)],
  )

  for (const obs of latest) {
    // 2. Derive current state + ledger diffs.
    const { rows: prevRows } = await db.query<{ status: string; commission_amount: string }>(
      `select status, commission_amount from conversions where source_id = $1 and network_txn_id = $2`,
      [obs.source_id, obs.network_txn_id],
    )
    const prev = prevRows[0]
    const commission = Number(obs.commission_amount)

    await db.query(
      `insert into conversions (source_id, network_txn_id, latest_observation_id, first_observed_at,
         last_observed_at, network_txn_time, order_amount, commission_amount, currency, status,
         subid_echo, tracking_key, program_ref)
       values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (source_id, network_txn_id) do update set
         latest_observation_id = excluded.latest_observation_id,
         last_observed_at = excluded.last_observed_at,
         order_amount = excluded.order_amount,
         commission_amount = excluded.commission_amount,
         currency = excluded.currency,
         status = excluded.status,
         subid_echo = coalesce(conversions.subid_echo, excluded.subid_echo),
         tracking_key = coalesce(conversions.tracking_key, excluded.tracking_key)`,
      [
        obs.source_id,
        obs.network_txn_id,
        obs.id,
        obs.observed_at,
        obs.network_txn_time,
        obs.order_amount,
        commission,
        obs.currency,
        obs.status_norm,
        obs.subid_echo,
        obs.tracking_key,
        obs.program_ref,
      ],
    )
    stats.conversions_updated++

    // Ledger transitions (docs/plan/04 §Ledger).
    const entries: Array<{ type: string; amount: number }> = []
    if (!prev) {
      entries.push({ type: 'accrual', amount: commission })
    } else {
      const prevAmt = Number(prev.commission_amount)
      if (prev.status !== 'reversed' && obs.status_norm === 'reversed') {
        entries.push({ type: 'reversal', amount: -prevAmt })
      } else if (obs.status_norm !== 'reversed' && commission !== prevAmt) {
        entries.push({ type: 'adjustment', amount: commission - prevAmt })
      }
      if (prev.status !== 'paid' && obs.status_norm === 'paid') {
        entries.push({ type: 'payout', amount: commission })
      }
    }
    for (const e of entries) {
      await db.query(
        `insert into ledger_entries (source_id, network_txn_id, tenant_id, entry_type, amount, currency, occurred_at)
         select $1, $2,
                (select ae.tenant_id from attribution_edges ae
                  where ae.source_id = $1 and ae.network_txn_id = $2
                  order by ae.weight desc limit 1),
                $3, $4, $5, $6`,
        [obs.source_id, obs.network_txn_id, e.type, e.amount, obs.currency, obs.network_txn_time],
      )
      stats.ledger_entries++
    }

    // 3. Attribution edges (skip if this txn already has edges at this version).
    const { rows: existing } = await db.query(
      `select 1 from attribution_edges
        where source_id = $1 and network_txn_id = $2 and resolver_version = $3 limit 1`,
      [obs.source_id, obs.network_txn_id, RESOLVER_VERSION],
    )
    if (existing.length > 0) continue

    stats.edges_written += await writeEdges(db, obs)
  }

  // Backfill tenant ids on ledger entries written before edges existed.
  await db.query(
    `update ledger_entries le set tenant_id = ae.tenant_id
       from (select distinct on (source_id, network_txn_id) source_id, network_txn_id, tenant_id
               from attribution_edges where tenant_id is not null
               order by source_id, network_txn_id, weight desc) ae
      where le.tenant_id is null
        and le.source_id = ae.source_id and le.network_txn_id = ae.network_txn_id`,
  )

  return stats
}

async function writeEdges(db: Db, obs: ObsRow): Promise<number> {
  const insertEdge = (
    decisionId: string | null,
    tenantId: string | null,
    clickId: string | null,
    weight: number,
    resolution: string,
  ) =>
    db.query(
      `insert into attribution_edges (source_id, network_txn_id, decision_id, tenant_id, click_id,
         weight, resolution, resolver_version)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict do nothing`,
      [obs.source_id, obs.network_txn_id, decisionId, tenantId, clickId, weight, resolution, RESOLVER_VERSION],
    )

  // (a) click-level: exact subid echo.
  if (obs.subid_echo) {
    const { rows } = await db.query<{ decision_id: string; tenant_id: string; click_id: string }>(
      `select decision_id, tenant_id, click_id from events where type = 'click' and click_id = $1`,
      [obs.subid_echo],
    )
    const click = rows[0]
    if (click) {
      await insertEdge(click.decision_id, click.tenant_id, click.click_id, 1, 'click')
      return 1
    }
  }

  const windowClause = `occurred_at between $2::timestamptz - ($3 || ' days')::interval and $2::timestamptz`

  // (b) property-level: tracking key → tenant namespace match; allocate across
  // that tenant's clicks on this source in the cookie window.
  if (obs.tracking_key) {
    const { rows: tenants } = await db.query<{ id: string }>(
      `select id from tenants
        where slug = $1 or exists (
          select 1 from jsonb_each_text(tracking_namespaces) kv where kv.value = $1)`,
      [obs.tracking_key],
    )
    const tenant = tenants[0]
    if (tenant) {
      const { rows: clicks } = await db.query<{ decision_id: string; click_id: string }>(
        `select decision_id, click_id from events
          where type = 'click' and tenant_id = $1 and source_id = $4
            and coalesce(ivt_score, 0) < 1 and ${windowClause}`,
        [tenant.id, obs.network_txn_time, String(DEFAULT_COOKIE_WINDOW_DAYS), obs.source_id],
      )
      if (clicks.length > 0) {
        const w = 1 / clicks.length
        for (const cl of clicks) await insertEdge(cl.decision_id, tenant.id, cl.click_id, w, 'property')
        return clicks.length
      }
      // No clicks in window: still tie revenue to the tenant.
      await insertEdge(null, tenant.id, null, 1, 'property')
      return 1
    }
  }

  // (c) account-level smear across all of this source's clicks in the window.
  const { rows: clicks } = await db.query<{ decision_id: string; tenant_id: string; click_id: string }>(
    `select decision_id, tenant_id, click_id from events
      where type = 'click' and source_id = $1
        and coalesce(ivt_score, 0) < 1
        and occurred_at between $2::timestamptz - ($3 || ' days')::interval and $2::timestamptz`,
    [obs.source_id, obs.network_txn_time, String(DEFAULT_COOKIE_WINDOW_DAYS)],
  )
  if (clicks.length > 0) {
    const w = 1 / clicks.length
    for (const cl of clicks) await insertEdge(cl.decision_id, cl.tenant_id, cl.click_id, w, 'account')
    return clicks.length
  }
  await insertEdge(null, null, null, 1, 'account')
  return 1
}
