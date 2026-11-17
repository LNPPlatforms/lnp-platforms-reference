-- more stand-ins for 065 and later (run after db_stub.sql and 059 to 063)
alter table storage.buckets add column if not exists allowed_mime_types text[], add column if not exists file_size_limit bigint;
alter table tenants add column if not exists slug text, add column if not exists agency_tenant_id uuid, add column if not exists is_agency boolean default false, add column if not exists plan text,
  add column if not exists created_at timestamptz default now();
alter table app_users add column if not exists manager_id uuid, add column if not exists last_seen_at timestamptz;
alter table people add column if not exists last_name text, add column if not exists personal_email text, add column if not exists personal_cell text,
  add column if not exists preferred_contact_method text, add column if not exists archive_status text, add column if not exists created_at timestamptz default now();
alter table companies add column if not exists stage text, add column if not exists pipeline_stage_id uuid, add column if not exists owner_id uuid,
  add column if not exists interest_level text, add column if not exists follow_up_date date, add column if not exists main_email text, add column if not exists main_phone text,
  add column if not exists lead_source_channel text, add column if not exists archive_status text, add column if not exists created_at timestamptz default now(),
  add column if not exists city text, add column if not exists state text;
create table if not exists company_people (id uuid primary key default gen_random_uuid(), company_id uuid references companies(id) on delete cascade, person_id uuid references people(id) on delete cascade, tenant_id uuid);
create table if not exists tasks (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant(), company_id uuid, person_id uuid, title text,
  due_date date, assigned_to uuid, done boolean default false, created_by uuid default auth.uid(), created_at timestamptz default now(), notes text, done_at timestamptz, done_by uuid);
create table if not exists site_forms (id uuid primary key default gen_random_uuid(), tenant_id uuid, name text);
create table if not exists form_submissions (id uuid primary key default gen_random_uuid(), form_id uuid, tenant_id uuid, company_id uuid, person_id uuid, data jsonb, page_url text, created_at timestamptz default now());
create table if not exists media (id uuid primary key default gen_random_uuid(), tenant_id uuid not null default private.current_tenant(), bucket text default 'media', path text, url text,
  kind text default 'logo', entity text, entity_id uuid, title text, mime text, bytes bigint, created_by uuid default auth.uid(), created_at timestamptz default now(), archived_at timestamptz);
alter table media enable row level security;
create policy "internal all media" on media for all using (private.is_internal());
create table if not exists opportunities (id uuid primary key default gen_random_uuid(), tenant_id uuid, company_id uuid, status text, estimated_value numeric, owner_id uuid, created_at timestamptz default now());
create table if not exists notifications (id uuid primary key default gen_random_uuid(), user_id uuid, kind text, title text, body text, link text, created_at timestamptz default now(), done_at timestamptz);
create table if not exists chat_threads (id uuid primary key default gen_random_uuid(), tenant_id uuid, visitor_key text, visitor_name text, visitor_email text, company_id uuid,
  source text, source_ref text, page_url text, ip text, status text default 'open', unread_staff boolean default true, visitor_seen_at timestamptz, last_message_at timestamptz default now(),
  created_at timestamptz default now(), kind text default 'visitor', divisions uuid[] default '{}');
create table if not exists chat_messages (id uuid primary key default gen_random_uuid(), tenant_id uuid, thread_id uuid, sender text, staff_id uuid, body text, created_at timestamptz default now());
create or replace function private.chat_online(p_tenant uuid) returns boolean language sql stable as $$
  select exists (select 1 from app_users where tenant_id = p_tenant and active and last_seen_at > now() - interval '2 minutes') $$;
create table if not exists private.push_keys (id int primary key, hook_secret text);
insert into private.push_keys values (1, 'testsecret') on conflict do nothing;
create schema if not exists net;
create table if not exists net.calls (url text, body jsonb, headers jsonb, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers); select 1::bigint $$;
create schema if not exists cron;
create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ select 1::bigint $$;
create or replace function cron.unschedule(n text) returns boolean language sql as $$ select true $$;
create schema if not exists extensions;
grant usage on schema net, extensions to authenticated;
grant select, insert, update on all tables in schema public to authenticated;
-- the blanket grant above is for the older stub tables; put back the narrow grants 061 and 062 set on field tables
revoke insert, update on public.jobs, public.job_events, public.job_costs, public.work_reviews, public.time_entries, public.pay_rates, public.pay_batches,
  public.pay_lines, public.acct_sync_queue, public.acct_connections from authenticated;
grant insert (company_id, person_id, divisions, proposal_id, source, title, service_type, scope, scheduled_start, scheduled_end, price, pay_amount, assigned_to, notes, custom)
  on public.jobs to authenticated;
grant update (company_id, person_id, divisions, title, service_type, scope, scheduled_start, scheduled_end, price, pay_amount, assigned_to, notes, custom, archived_at)
  on public.jobs to authenticated;
grant update (settings) on public.acct_connections to authenticated;
alter table people add column if not exists updated_at timestamptz;
alter table companies add column if not exists next_step text, add column if not exists notes text, add column if not exists updated_at timestamptz;
create or replace function extensions.digest(t text, a text) returns bytea language sql as $$ select public.digest(t, a) $$;
create table if not exists white_labels (agency_tenant_id uuid, email_from_name text);
do $$ begin create role service_role nologin; exception when others then null; end $$;
-- for 069 (invoices)
alter table proposals add column if not exists status text default 'draft', add column if not exists owner_id uuid, add column if not exists contact_person_id uuid,
  add column if not exists contact_name text, add column if not exists contact_email text, add column if not exists accepted_name text, add column if not exists accepted_email text,
  add column if not exists pay_status text, add column if not exists pay_version int, add column if not exists paid_amount numeric, add column if not exists accepted_at timestamptz,
  add column if not exists share_token text default md5(random()::text) || md5(random()::text), add column if not exists expires_at timestamptz, add column if not exists sent_at timestamptz,
  add column if not exists created_at timestamptz default now();
alter table proposal_versions add column if not exists quote jsonb, add column if not exists monthly_total numeric;
alter table companies add column if not exists address text, add column if not exists zip text, add column if not exists bill_to text default 'self';
create or replace function private.default_tenant() returns uuid language sql stable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create or replace function private.pay_on(p_tenant uuid) returns boolean language sql stable as $$ select coalesce(current_setting('test.pay_on', true), '') = '1' and p_tenant = private.default_tenant() $$;
create or replace function public.proposal_view(p_token text, p_plan jsonb) returns jsonb language sql stable as $$ select '{"quote":{"lines":[]}}'::jsonb $$;
-- for 070 (members of more than one account): the 057 pieces it builds on
create or replace function private.actor() returns uuid language sql stable as $$ select coalesce(auth.uid(), nullif(current_setting('app.actor', true), '')::uuid) $$;
create table if not exists private.platform_owners (user_id uuid primary key references app_users(id) on delete cascade, added_at timestamptz not null default now());
create or replace function private.home_tenant() returns uuid language sql stable security definer set search_path = public, private as $$ select tenant_id from app_users where id = auth.uid() $$;
create or replace function private.is_platform_owner() returns boolean language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.platform_owners o join app_users u on u.id = o.user_id where o.user_id = auth.uid() and u.active) $$;
create or replace function private.is_platform_admin() returns boolean language sql stable security definer set search_path = public, private as $$
  select private.is_platform_owner() or coalesce((select u.is_admin and t.is_agency from app_users u join tenants t on t.id = u.tenant_id
    where u.id = auth.uid() and u.active and u.role not in ('vendor', 'member')), false) $$;
create or replace function private.manages(p_tenant uuid) returns boolean language sql stable security definer set search_path = public, private as $$
  select private.is_platform_owner() or (private.is_platform_admin() and (p_tenant = private.home_tenant()
    or exists (select 1 from tenants where id = p_tenant and agency_tenant_id = private.home_tenant()))) $$;
alter table white_labels add column if not exists name text, add column if not exists short_name text;
-- for 076 (LNP root): the rest of the white label columns and its one-per-agency key
alter table white_labels add column if not exists domain text, add column if not exists logo_url text, add column if not exists primary_color text default '#1A2A52',
  add column if not exists support_email text;
create unique index if not exists white_labels_agency on white_labels (agency_tenant_id);
create or replace function private.brand_of(p_tenant uuid) returns jsonb language sql stable security definer set search_path = public, private as $$
  select to_jsonb(w) from white_labels w where w.agency_tenant_id = (select case when t.is_agency then t.id else t.agency_tenant_id end from tenants t where t.id = p_tenant) $$;
drop policy if exists "u" on app_users;
create policy "self read" on app_users for select using (id = auth.uid() or (private.is_internal() and tenant_id = private.current_tenant()));
alter table tenants enable row level security;
create policy "read own tenant" on tenants for select using (id = private.current_tenant());
create policy "platform admins read accounts" on tenants for select using (private.manages(id));
-- for 074 (client portal): sign up, staff invites and organization assets
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
alter table app_users add column if not exists vendor_id uuid, add column if not exists role_id uuid;
create table if not exists invites (id uuid primary key default gen_random_uuid(), tenant_id uuid references tenants(id), email text, full_name text, role text default 'staff',
  is_admin boolean default false, manager_id uuid, vendor_id uuid, invited_by uuid, created_at timestamptz default now(), accepted_at timestamptz, accepted_user uuid, revoked_at timestamptz);
create table if not exists company_assets (id uuid primary key default gen_random_uuid(), tenant_id uuid, company_id uuid references companies(id), kind text, title text, url text,
  media_id uuid, note text, created_by uuid, created_at timestamptz default now(), archived_at timestamptz, archived_by uuid);
create or replace function private.handle_new_auth_user() returns trigger language plpgsql security definer set search_path = public, private as $$
declare inv invites%rowtype;
begin
  if exists (select 1 from app_users where id = new.id) then return new; end if;
  select * into inv from invites where lower(email) = lower(new.email) and accepted_at is null and revoked_at is null order by created_at desc limit 1;
  if not found then raise exception 'NOT_INVITED: This email has not been invited yet.'; end if;
  insert into app_users (id, full_name, email, role, active, is_admin, manager_id, vendor_id, tenant_id)
  values (new.id, coalesce(nullif(trim(inv.full_name),''), new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          lower(new.email), inv.role::user_role, true, inv.is_admin and inv.role = 'staff', inv.manager_id, inv.vendor_id, inv.tenant_id);
  update invites set accepted_at = now(), accepted_user = new.id where id = inv.id;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_auth_user();
-- the Inbox rules from 012, so portal tests can show clients never read the chat tables directly
alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
create policy "team reads own chats" on public.chat_threads for select using (private.is_internal() and tenant_id = private.current_tenant());
create policy "team updates own chats" on public.chat_threads for update using (private.is_internal() and tenant_id = private.current_tenant());
create policy "team reads own chat messages" on public.chat_messages for select using (private.is_internal() and tenant_id = private.current_tenant());
-- for 076 (LNP Platforms at the top): the white label columns and key it writes
alter table white_labels add column if not exists domain text, add column if not exists support_email text, add column if not exists logo_url text,
  add column if not exists primary_color text, add column if not exists accent_color text;
create unique index if not exists white_labels_agency_key on white_labels (agency_tenant_id);
alter table tenants add column if not exists created_at timestamptz default now();
-- for 078 (calendars): contact columns that matching and adding a booked contact use
alter table people add column if not exists archived_at timestamptz, add column if not exists created_by uuid;
alter table companies add column if not exists lead_source_kind text, add column if not exists created_by uuid;
alter table company_people add column if not exists work_email text, add column if not exists work_phone text, add column if not exists is_primary_contact boolean default false;
alter table white_labels add column if not exists updated_at timestamptz default now();
-- 087 (contact types, presence)
create table if not exists lookup_values (id uuid primary key default gen_random_uuid(), tenant_id uuid default private.current_tenant(), list_name text not null, label text not null, sort_order int not null default 0, active boolean not null default true, unique (tenant_id, list_name, label));
create table if not exists escalations (id uuid primary key default gen_random_uuid(), tenant_id uuid, reason text);
alter table companies add column if not exists org_types text[] not null default '{}';
alter table public.app_users add column if not exists forward_to uuid; alter table public.app_users add column if not exists hidden_in_team boolean not null default false;
create table if not exists public.activities (id uuid primary key default gen_random_uuid(), company_id uuid references public.companies(id) on delete cascade, person_id uuid, type text not null default 'note', body text, created_by uuid default auth.uid(), created_at timestamptz not null default now());
alter table company_people add column if not exists is_decision_maker boolean not null default false;
alter table people add column if not exists last_name text, add column if not exists personal_email text, add column if not exists email_opt_out boolean not null default false, add column if not exists archived_at timestamptz;
alter table companies add column if not exists address text, add column if not exists city text, add column if not exists state text;
alter table company_people add column if not exists active boolean not null default true, add column if not exists created_at timestamptz not null default now(), add column if not exists work_phone text; alter table companies add column if not exists main_phone text, add column if not exists main_email text, add column if not exists divisions uuid[] not null default '{}'; alter table people add column if not exists personal_cell text;
-- a stand-in for Supabase Vault (107)
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), secret text, name text, description text);
create or replace view vault.decrypted_secrets as select id, secret as decrypted_secret, name from vault.secrets;
create or replace function vault.create_secret(s text, n text default null, d text default null) returns uuid language sql as $$ insert into vault.secrets (secret, name, description) values (s, n, d) returning id $$;
create or replace function vault.update_secret(i uuid, s text) returns void language sql as $$ update vault.secrets set secret = s where id = i $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
-- 112: review items and a bare merge (the real one lives in 002, which the stubs skip)
create table if not exists public.review_items (id uuid primary key default gen_random_uuid(), kind text not null, entity text not null, entity_id uuid not null, related_id uuid,
  reason text, details jsonb, status text not null default 'open', created_by uuid, created_at timestamptz not null default now(), resolved_by uuid, resolved_at timestamptz, resolution text,
  tenant_id uuid default private.current_tenant());
alter table public.activities add column if not exists tenant_id uuid default private.current_tenant();
create or replace function public.merge_records(p_entity text, p_keep uuid, p_drop uuid) returns void language plpgsql security definer set search_path = public, private as $$
begin execute format('update %I set archived_at = now() where id = $1', p_entity) using p_drop; end $$;
grant execute on function public.merge_records(text, uuid, uuid) to authenticated;
-- 115 support
create table if not exists public.suggestions (id uuid primary key default gen_random_uuid(), body text, view text, status text, account_name text, user_name text, created_at timestamptz default now());
alter table public.chat_threads add column if not exists client_tenant_id uuid;
alter table public.chat_threads add column if not exists requested_by uuid;
