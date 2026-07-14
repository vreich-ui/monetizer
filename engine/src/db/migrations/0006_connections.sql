-- Generic agentic connections: a declarative HTTP connector config lives on
-- the source. Non-secret config (auth model, base_url, headers, recipes,
-- instructions) here; secrets stay encrypted in the credentials table.
alter table sources add column config jsonb not null default '{}';

-- Cursor/state for incremental collection recipes (last successful run marker).
create table collection_runs (
  id bigint generated always as identity primary key,
  source_id text not null references sources(id) on delete cascade,
  recipe_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','ok','error')),
  records int not null default 0,
  pages int not null default 0,
  error text,
  meta jsonb not null default '{}'
);
create index collection_runs_src_idx on collection_runs (source_id, started_at desc);
