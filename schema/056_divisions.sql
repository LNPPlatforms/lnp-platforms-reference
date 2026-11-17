-- 056: divisions inside one account (Oct 26, 2026).
-- An account can run more than one company (Company A and Company B). Organizations, people, deals and website chats
-- are tagged with the divisions they belong to; a record tagged with both, or with none, is shared and everyone sees it.
-- Each team member is assigned to one or more divisions (none = everything). Admins always see everything.
-- New records made by someone assigned to divisions are tagged with their divisions automatically.

create table if not exists public.divisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  color text not null default '#3A4E72',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists divisions_tenant on public.divisions (tenant_id, sort_order);
alter table public.divisions enable row level security;
drop policy if exists "read divisions" on public.divisions;
create policy "read divisions" on public.divisions for select using (private.is_internal() and tenant_id = private.current_tenant());
drop policy if exists "admin manage divisions" on public.divisions;
create policy "admin manage divisions" on public.divisions for all
  using (private.is_admin() and tenant_id = private.current_tenant())
  with check (private.is_admin() and tenant_id = private.current_tenant());
grant select, insert, update, delete on public.divisions to authenticated;

alter table public.app_users add column if not exists divisions uuid[] not null default '{}';
alter table public.companies add column if not exists divisions uuid[] not null default '{}';
alter table public.people add column if not exists divisions uuid[] not null default '{}';
alter table public.opportunities add column if not exists divisions uuid[] not null default '{}';
alter table public.chat_threads add column if not exists divisions uuid[] not null default '{}';
create index if not exists companies_divisions on public.companies using gin (divisions);
create index if not exists people_divisions on public.people using gin (divisions);

-- the divisions the signed-in person is limited to ('{}' = not limited)
create or replace function private.my_divisions() returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.is_admin or u.tenant_id <> private.current_tenant() then '{}'::uuid[] else u.divisions end
                     from app_users u where u.id = auth.uid()), '{}'::uuid[])
$$;
-- can the signed-in person see a record with these divisions
create or replace function private.div_ok(d uuid[]) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce(cardinality(d), 0) = 0 or cardinality(private.my_divisions()) = 0 or d && private.my_divisions()
$$;
revoke execute on function private.my_divisions(), private.div_ok(uuid[]) from public, anon;
grant execute on function private.my_divisions(), private.div_ok(uuid[]) to authenticated;

-- new records from someone limited to divisions get their divisions
create or replace function private.stamp_divisions() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if coalesce(cardinality(new.divisions), 0) = 0 then new.divisions := private.my_divisions(); end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['companies', 'people', 'opportunities'] loop
    execute format('drop trigger if exists stamp_divisions on public.%I', t);
    execute format('create trigger stamp_divisions before insert on public.%I for each row execute function private.stamp_divisions()', t);
  end loop;
end $$;

-- row security: same account, and a division you can see
alter policy "internal all companies" on public.companies
  using (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()) and private.div_ok(divisions))
  with check (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()) and private.div_ok(divisions));
alter policy "internal all people" on public.people
  using (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()) and private.div_ok(divisions))
  with check (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()) and private.div_ok(divisions));
alter policy "internal all opps" on public.opportunities
  using (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions))
  with check (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions));
alter policy "team reads own chats" on public.chat_threads using (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions));
alter policy "team updates own chats" on public.chat_threads
  using (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions))
  with check (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions));

-- only admins change who is in which division (the "admin manage users" policy already limits app_users writes to admins)
