import type { Db } from '../db/client.ts'

/**
 * Revenue/engagement rollups with the mandatory qualifiers (docs/plan/01
 * §Money model rule): every revenue figure is broken out by ledger state and
 * attribution resolution. No unqualified totals.
 */
export async function performanceReport(
  db: Db,
  opts: { tenantSlug?: string; days?: number } = {},
): Promise<Record<string, unknown>> {
  const days = opts.days ?? 30
  const params: unknown[] = [String(days)]
  let tenantFilter = ''
  if (opts.tenantSlug) {
    params.push(opts.tenantSlug)
    tenantFilter = `and t.slug = $${params.length}`
  }

  const { rows: traffic } = await db.query(
    `select e.type, count(*)::int as n
       from events e left join tenants t on t.id = e.tenant_id
      where e.occurred_at > now() - ($1 || ' days')::interval
        and coalesce(e.ivt_score, 0) < 1 ${tenantFilter}
      group by e.type`,
    params,
  )

  const { rows: revenue } = await db.query(
    `select c.status, coalesce(ae.resolution, 'unattributed') as resolution,
            c.currency, sum(c.commission_amount * coalesce(ae.weight, 1))::numeric(14,2) as amount,
            count(distinct c.source_id || ':' || c.network_txn_id)::int as txns
       from conversions c
       left join attribution_edges ae
         on ae.source_id = c.source_id and ae.network_txn_id = c.network_txn_id
       left join tenants t on t.id = ae.tenant_id
      where c.network_txn_time > now() - ($1 || ' days')::interval ${tenantFilter}
      group by 1, 2, 3
      order by 1, 2`,
    params,
  )

  const { rows: topOffers } = await db.query(
    `select o.title, o.id as offer_id, count(*)::int as clicks
       from events e
       join offers o on o.id = e.offer_id
       left join tenants t on t.id = e.tenant_id
      where e.type = 'click' and e.occurred_at > now() - ($1 || ' days')::interval
        and coalesce(e.ivt_score, 0) < 1 ${tenantFilter}
      group by 1, 2 order by clicks desc limit 10`,
    params,
  )

  return {
    window_days: days,
    tenant: opts.tenantSlug ?? 'all',
    traffic: Object.fromEntries(traffic.map((r: any) => [r.type, r.n])),
    revenue_by_status_and_resolution: revenue,
    top_offers_by_clicks: topOffers,
    caveats: [
      'pending commissions are mutable for 30-90 days',
      'resolution=property/account rows are allocated, not exact',
    ],
  }
}
