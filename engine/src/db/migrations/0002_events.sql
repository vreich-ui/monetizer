-- Event pipeline per docs/plan/04. Append-only; envelope typed, payload JSONB.
-- Partitioning deliberately deferred: at content-network volume plain indexes
-- hold for years; revisit at ~100x (04 §Event envelope).

create table events (
  id text primary key,
  schema_version int not null default 1,
  type text not null check (type in
    ('pageview','impression','viewable','click','checkout_started',
     'redirect_failover','redirect_failed','system')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  tenant_id text,
  surface_id text,
  decision_id text,
  offer_id text,
  source_id text,
  visitor_hash text,
  click_id text,
  ivt_score real,
  ivt_reasons text[],
  payload jsonb not null default '{}'
);
create index events_type_time_idx on events (type, occurred_at);
create index events_decision_idx on events (decision_id) where decision_id is not null;
create unique index events_click_id_idx on events (click_id) where type = 'click';
create index events_tenant_time_idx on events (tenant_id, occurred_at);

-- Every sighting of a network-side transaction is an immutable observation.
create table conversion_observations (
  id text primary key,
  source_id text not null references sources(id),
  observed_at timestamptz not null default now(),
  network_txn_id text not null,
  network_click_time timestamptz,
  network_txn_time timestamptz not null,
  subid_echo text,
  tracking_key text,
  program_ref text,
  items jsonb,
  order_amount numeric(14,2),
  commission_amount numeric(14,2) not null,
  currency text not null,
  network_status text not null,
  status_norm text not null check (status_norm in ('pending','approved','reversed','adjusted','paid')),
  raw jsonb not null default '{}'
);
create index convobs_txn_idx on conversion_observations (source_id, network_txn_id, observed_at desc);

-- Derived current state (rebuilt by the attribution job; never hand-edited).
create table conversions (
  source_id text not null,
  network_txn_id text not null,
  latest_observation_id text not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  network_txn_time timestamptz not null,
  order_amount numeric(14,2),
  commission_amount numeric(14,2) not null,
  currency text not null,
  status text not null,
  subid_echo text,
  tracking_key text,
  program_ref text,
  primary key (source_id, network_txn_id)
);

create table attribution_edges (
  id bigint generated always as identity primary key,
  source_id text not null,
  network_txn_id text not null,
  decision_id text,
  tenant_id text,
  click_id text,
  weight double precision not null,
  resolution text not null check (resolution in ('click','surface','property','account')),
  resolver_version int not null,
  created_at timestamptz not null default now(),
  unique nulls not distinct (source_id, network_txn_id, decision_id, resolver_version)
);
create index attredges_txn_idx on attribution_edges (source_id, network_txn_id);
create index attredges_decision_idx on attribution_edges (decision_id) where decision_id is not null;

create table ledger_entries (
  id bigint generated always as identity primary key,
  source_id text not null,
  network_txn_id text not null,
  tenant_id text,
  entry_type text not null check (entry_type in ('accrual','adjustment','reversal','payout')),
  amount numeric(14,2) not null,
  currency text not null,
  occurred_at timestamptz not null,
  observed_at timestamptz not null default now(),
  meta jsonb not null default '{}'
);
create index ledger_txn_idx on ledger_entries (source_id, network_txn_id);
create index ledger_tenant_idx on ledger_entries (tenant_id, occurred_at);
