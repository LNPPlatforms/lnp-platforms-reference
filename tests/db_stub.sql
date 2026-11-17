-- minimal stand-ins for the Supabase pieces and existing CRM tables the new migrations touch
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when others then null; end $$; do $$ begin create role authenticated nologin; exception when others then null; end $$;
create schema auth; create schema storage; create schema private;
grant usage on schema public, private, auth, storage to authenticated, anon;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('aal', coalesce(nullif(current_setting('test.aal', true), ''), 'aal1')) $$;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;

create type user_role as enum ('admin', 'salesperson', 'contractor', 'staff', 'vendor', 'member');
create table tenants (id uuid primary key default gen_random_uuid(), name text);
create table app_users (id uuid primary key, full_name text, email text, role user_role default 'staff', active boolean default true, is_admin boolean default false,
  tenant_id uuid references tenants(id), divisions uuid[] not null default '{}', acting_tenant_id uuid);
create function private.current_tenant() returns uuid language sql stable security definer as $$ select tenant_id from app_users where id = auth.uid() $$;
create function private.is_internal() returns boolean language sql stable security definer as $$ select coalesce((select role not in ('vendor','member') and active from app_users where id = auth.uid()), false) $$;
create function private.is_admin() returns boolean language sql stable security definer as $$ select coalesce((select is_admin and active from app_users where id = auth.uid()), false) $$;
create function private.my_divisions() returns uuid[] language sql stable security definer as $$
  select coalesce((select case when u.is_admin then '{}'::uuid[] else u.divisions end from app_users u where u.id = auth.uid()), '{}') $$;
create function private.div_ok(d uuid[]) returns boolean language sql stable as $$
  select coalesce(cardinality(d), 0) = 0 or cardinality(private.my_divisions()) = 0 or d && private.my_divisions() $$;
create function private.stamp_divisions() returns trigger language plpgsql as $$
begin if coalesce(cardinality(new.divisions), 0) = 0 then new.divisions := private.my_divisions(); end if; return new; end $$;
create function private.audit() returns trigger language plpgsql as $$ begin return null; end $$;
create table divisions (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant() references tenants(id), name text);
create table account_settings (tenant_id uuid primary key, settings jsonb not null default '{}', updated_at timestamptz, updated_by uuid);
create table companies (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant() references tenants(id), name text, parent_company_id uuid references companies(id),
  divisions uuid[] not null default '{}', archived_at timestamptz);
create table people (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant(), first_name text);
create table proposals (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant(), company_id uuid references companies(id), version int default 1, accepted_version int);
create table proposal_versions (proposal_id uuid, version int, setup_total numeric);
alter table companies enable row level security; alter table app_users enable row level security;
grant select, insert, update on all tables in schema public to authenticated;
create policy "co" on companies for all using (tenant_id = private.current_tenant()) with check (tenant_id = private.current_tenant());
create policy "u" on app_users for select using (tenant_id = private.current_tenant());
