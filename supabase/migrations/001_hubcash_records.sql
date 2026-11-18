-- HubCash: uma tabela genérica de registros (contas, apps, cobranças, eventos).
-- Acesso só pelo servidor com a service role key: RLS ligado e nenhuma policy pública.
create table if not exists public.hubcash_records (
  kind text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);

create index if not exists hubcash_records_kind_created on public.hubcash_records (kind, created_at desc);
create index if not exists hubcash_records_app on public.hubcash_records ((data->>'appId')) where kind = 'charge';
create index if not exists hubcash_records_mp on public.hubcash_records ((data->>'mpId')) where kind = 'charge';
create index if not exists hubcash_records_key on public.hubcash_records ((data->>'keyHash')) where kind = 'app';

alter table public.hubcash_records enable row level security;
