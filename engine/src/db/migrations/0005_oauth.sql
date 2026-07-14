-- OAuth 2.1 authorization-server state for the MCP control plane.
-- Persisted (not in-memory) so tokens survive Cloud Run restarts/scaling.

create table oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table oauth_codes (
  code text primary key,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scope text,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create table oauth_tokens (
  token text primary key,
  kind text not null check (kind in ('access','refresh')),
  client_id text not null,
  scope text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_tokens_kind_idx on oauth_tokens (kind);
