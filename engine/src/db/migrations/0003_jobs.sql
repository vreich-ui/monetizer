-- Minimal Postgres job queue (FOR UPDATE SKIP LOCKED) + recurring schedules.
-- Deliberately not pg-boss: ~150 lines buys zero-dependency portability and
-- the scale ceiling is far away (docs/plan/06).

create table jobs (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index jobs_claim_idx on jobs (run_at) where status = 'queued';

create table schedules (
  kind text primary key,
  interval_s int not null,
  payload jsonb not null default '{}',
  next_at timestamptz not null default now(),
  enabled boolean not null default true
);

-- Raw CSV drops for no-API sources (docs/plan/03 §Direct merchant programs).
create table csv_drops (
  id text primary key,
  source_id text not null references sources(id),
  drop_kind text not null check (drop_kind in ('offers','transactions')),
  filename text,
  content text not null,
  mapping jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','processed','failed')),
  error text,
  created_at timestamptz not null default now()
);
