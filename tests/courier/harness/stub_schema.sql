-- ============================================================================
-- DEV-ONLY STAND-IN for the LNP Platforms schema. DO NOT RUN ON SUPABASE.
-- It mimics the behaviours you described so the courier migrations can be
-- exercised in a throwaway local Postgres (with PostGIS):
--   tenants / app_users / account_members / roles
--   private.current_tenant()  home tenant, or acting tenant if the user is an
--                             active member there or their agency manages it;
--                             portal users get a dead tenant id
--   private.is_internal(), private.feature_on(text), private.is_admin()
--   public.set_acting_tenant(uuid)
-- In your real project these objects already exist; nothing here replaces them.
-- ============================================================================
create schema if not exists auth;
create schema if not exists private;
create schema if not exists extensions;
create schema if not exists storage;

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;
alter database lnp_test set search_path = "$user", public, extensions;
set search_path = "$user", public, extensions;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb)->>'sub', '')::uuid $$;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agency_tenant_id uuid references public.tenants(id)
);
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null, level int not null default 1
);
create table public.app_users (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id),
  acting_tenant_id uuid references public.tenants(id),
  role_id uuid references public.roles(id),
  is_admin boolean not null default false,
  is_portal boolean not null default false
);
create table public.account_members (
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.app_users(id),
  status text not null default 'active',
  is_admin boolean not null default false,
  role_id uuid references public.roles(id),
  primary key (tenant_id, user_id)
);
create table public.tenant_features (
  tenant_id uuid not null references public.tenants(id),
  feature text not null, primary key (tenant_id, feature)
);

create function private.current_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select case
    when u.is_portal then '00000000-0000-0000-0000-000000000000'::uuid
    when u.acting_tenant_id is null or u.acting_tenant_id = u.tenant_id then u.tenant_id
    when exists (select 1 from public.account_members m
                 where m.user_id = u.id and m.tenant_id = u.acting_tenant_id and m.status='active')
      then u.acting_tenant_id
    when exists (select 1 from public.tenants t
                 where t.id = u.acting_tenant_id and t.agency_tenant_id = u.tenant_id)
      then u.acting_tenant_id
    else u.tenant_id end
  from public.app_users u where u.id = auth.uid() $$;

create function private.is_internal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select not u.is_portal from public.app_users u where u.id = auth.uid()), false) $$;

create function private.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when private.current_tenant() = u.tenant_id then u.is_admin
                else coalesce((select m.is_admin from public.account_members m
                               where m.user_id = u.id and m.tenant_id = private.current_tenant()), false)
           end
    from public.app_users u where u.id = auth.uid()), false) $$;

create function private.feature_on(p_feature text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tenant_features f
                 where f.tenant_id = private.current_tenant() and f.feature = p_feature) $$;

create function public.set_acting_tenant(p_tenant uuid) returns void
language sql security definer set search_path = public as $$
  update public.app_users set acting_tenant_id = p_tenant where id = auth.uid() $$;

-- Supabase-like grants (anon/authenticated get everything on tables; RLS is the gate)
grant usage on schema auth, private, extensions, public, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth, private, extensions to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to public, anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;

-- Storage stand-in
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text not null, owner uuid default auth.uid());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select _parts[1:array_length(_parts,1)-1] from (select string_to_array(name,'/') as _parts) s $$;
grant all on all tables in schema storage to anon, authenticated, service_role;
