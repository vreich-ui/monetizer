-- Domain model per docs/plan/01. IDs are ULIDs (text) minted in the app.

create table tenants (
  id text primary key,
  slug text not null unique,
  name text not null,
  domains text[] not null default '{}',
  netlify_build_hook_url text,
  blob_store_ref text,
  token_hash text not null,
  -- per-network tracking namespace, e.g. {"impact":"mysite","amazon":"mysite-20"}
  tracking_namespaces jsonb not null default '{}',
  status text not null default 'active' check (status in ('active','paused')),
  created_at timestamptz not null default now()
);

create table sources (
  id text primary key,
  network text not null,
  kind text not null check (kind in ('affiliate_network','payment_provider','donation_platform','csv_inbox')),
  display_name text not null,
  tenant_scope text references tenants(id),
  capabilities jsonb not null default '{}',
  attribution_fidelity text not null default 'account'
    check (attribution_fidelity in ('click','surface','property','account')),
  reporting jsonb not null default '{}',
  status text not null default 'not_configured'
    check (status in ('active','paused','not_configured','error')),
  health jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique nulls not distinct (network, tenant_scope)
);

create table credentials (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  kind text not null,
  enc_payload bytea not null,
  status text not null default 'unverified' check (status in ('unverified','verified','failed')),
  last_verified_at timestamptz,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table programs (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  network_program_id text not null,
  merchant_name text not null,
  merchant_domain text,
  merchant_slug text not null,
  approval_status text not null default 'approved'
    check (approval_status in ('applied','approved','rejected','terminated')),
  tos jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (source_id, network_program_id)
);

create table offers (
  id text primary key,
  source_id text not null references sources(id),
  network_offer_id text not null,
  program_id text references programs(id),
  kind text not null check (kind in ('affiliate_product','affiliate_program_cta','digital_product','donation')),
  merchant jsonb not null,
  title text not null,
  brand text,
  description text,
  image_url text,
  taxonomy jsonb not null default '{}',
  economics jsonb not null,
  price jsonb,
  constraints jsonb not null default '{}',
  -- {link_template, subid_fidelity: click|surface|property|none}
  -- link_template placeholders: {click_id} {tenant_ns} {url_enc}
  tracking jsonb not null,
  lifecycle text not null default 'active' check (lifecycle in ('active','stale','dead','paused')),
  lifecycle_meta jsonb not null default '{}',
  search_text tsvector generated always as (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(description,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, network_offer_id)
);
create index offers_search_idx on offers using gin (search_text);
create index offers_lifecycle_idx on offers (lifecycle);

create table offer_snapshots (
  id bigint generated always as identity primary key,
  offer_id text not null references offers(id) on delete cascade,
  observed_at timestamptz not null default now(),
  price jsonb,
  availability text,
  raw jsonb not null default '{}'
);
create index offer_snapshots_offer_idx on offer_snapshots (offer_id, observed_at desc);

create table surfaces (
  id text primary key, -- deterministic sha256(tenant|content_id|slot_key), hex-40
  tenant_id text not null references tenants(id),
  content_id text not null,
  slot_key text not null,
  url_path text not null,
  slot_type text not null,
  context jsonb not null,
  context_version text not null,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, content_id, slot_key)
);

create table decisions (
  id text primary key,
  surface_id text not null references surfaces(id),
  tenant_id text not null references tenants(id),
  build_id text,
  policy jsonb not null,
  candidates jsonb not null,
  chosen jsonb not null,
  propensity double precision not null,
  explore boolean not null default false,
  seed text,
  status text not null default 'live' check (status in ('live','superseded')),
  supersedes text,
  issued_at timestamptz not null default now()
);
create unique index decisions_idempotency on decisions (surface_id, build_id) where build_id is not null;
create index decisions_surface_live on decisions (surface_id) where status = 'live';

create table demand_signals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  category text not null,
  entities text[] not null default '{}',
  reason text not null,
  evidence jsonb not null default '{}'
);
