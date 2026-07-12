-- Analytics views (docs/plan/01 §Money model rule): every revenue figure
-- carries state + attribution resolution. Point any BI tool (or psql) here;
-- never build dashboards on raw tables without these qualifiers.

create view v_attributed_revenue as
select
  c.source_id,
  s.network,
  c.network_txn_id,
  c.network_txn_time,
  c.status,
  c.currency,
  ae.resolution,
  ae.tenant_id,
  t.slug as tenant_slug,
  ae.decision_id,
  (c.commission_amount * ae.weight)::numeric(14,4) as commission_attributed,
  c.commission_amount as commission_total,
  ae.resolver_version
from conversions c
join attribution_edges ae
  on ae.source_id = c.source_id and ae.network_txn_id = c.network_txn_id
join sources s on s.id = c.source_id
left join tenants t on t.id = ae.tenant_id;

create view v_revenue_daily as
select
  date_trunc('day', network_txn_time)::date as day,
  tenant_slug,
  network,
  status,
  resolution,
  currency,
  sum(commission_attributed)::numeric(14,2) as commission,
  count(distinct source_id || ':' || network_txn_id)::int as txns
from v_attributed_revenue
group by 1,2,3,4,5,6;

create view v_offer_performance as
select
  o.id as offer_id,
  o.title,
  o.merchant->>'name' as merchant,
  o.kind,
  o.lifecycle,
  count(*) filter (where e.type = 'click' and coalesce(e.ivt_score,0) < 1)::int as clicks,
  count(*) filter (where e.type = 'impression')::int as impressions,
  count(*) filter (where e.type = 'viewable')::int as viewables,
  count(*) filter (where e.type = 'click' and coalesce(e.ivt_score,0) >= 1)::int as ivt_clicks,
  coalesce(rev.commission_approved, 0) as commission_approved,
  coalesce(rev.commission_pending, 0) as commission_pending,
  case when count(*) filter (where e.type = 'click' and coalesce(e.ivt_score,0) < 1) > 0
    then (coalesce(rev.commission_approved, 0)
          / count(*) filter (where e.type = 'click' and coalesce(e.ivt_score,0) < 1))::numeric(14,4)
    else null end as epc_approved
from offers o
left join events e on e.offer_id = o.id
left join lateral (
  select
    sum(var.commission_attributed) filter (where var.status in ('approved','paid'))::numeric(14,2) as commission_approved,
    sum(var.commission_attributed) filter (where var.status = 'pending')::numeric(14,2) as commission_pending
  from v_attributed_revenue var
  join events ce on ce.click_id is not null and ce.type = 'click' and ce.offer_id = o.id
    and var.decision_id = ce.decision_id
) rev on true
group by o.id, o.title, o.merchant->>'name', o.kind, o.lifecycle, rev.commission_approved, rev.commission_pending;

create view v_surface_performance as
select
  sf.id as surface_id,
  t.slug as tenant_slug,
  sf.url_path,
  sf.slot_type,
  sf.context->>'intent_class' as intent_class,
  sf.context->>'topic' as topic,
  count(*) filter (where e.type = 'impression')::int as impressions,
  count(*) filter (where e.type = 'viewable')::int as viewables,
  count(*) filter (where e.type = 'click' and coalesce(e.ivt_score,0) < 1)::int as clicks,
  coalesce(sum(var.commission_attributed) filter (where var.status in ('approved','paid')), 0)::numeric(14,2)
    as commission_approved
from surfaces sf
join tenants t on t.id = sf.tenant_id
left join events e on e.surface_id = sf.id
left join v_attributed_revenue var on var.decision_id = e.decision_id and e.type = 'click'
group by sf.id, t.slug, sf.url_path, sf.slot_type, sf.context->>'intent_class', sf.context->>'topic';
