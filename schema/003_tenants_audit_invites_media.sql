-- 003: tenant foundation (inactive), audit log, delete lockdown, invite-only signup, media (logos)
-- Written without DROP or DELETE so it applies cleanly. The lookup unique key change lives in 004.

-- ============================================================
-- TENANTS (foundation only; isolation is not enforced yet)
-- ============================================================
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);
insert into public.tenants (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'GELP Strategies', 'gelp')
on conflict (id) do nothing;

create or replace function private.default_tenant() returns uuid
language sql immutable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;

-- who is acting: the signed-in user, or the person Claude is acting for (set per transaction)
create or replace function private.actor() returns uuid
language sql stable set search_path = pg_catalog, public as $$
  select coalesce(auth.uid(), nullif(current_setting('app.actor', true), '')::uuid)
$$;

alter table public.app_users add column if not exists tenant_id uuid not null default private.default_tenant() references public.tenants(id);

create or replace function private.current_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce((select tenant_id from app_users where id = private.actor()), private.default_tenant())
$$;
alter table public.vendors          add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.lookup_values    add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.companies        add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.people           add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.company_people   add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.opportunities    add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.activities       add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.tasks            add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.vendor_companies add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.review_items     add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
alter table public.escalations      add column if not exists tenant_id uuid not null default private.current_tenant() references public.tenants(id);
create index if not exists companies_tenant_idx on public.companies (tenant_id);
create index if not exists people_tenant_idx on public.people (tenant_id);

alter table public.tenants enable row level security;
create policy "read own tenant" on public.tenants for select using (id = private.current_tenant());
grant select on public.tenants to authenticated;

-- duplicate checks: same tenant only, and one review item per pair
create or replace function private.flag_company_dupes() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare m record;
begin
  if 'Referral Partner' = any(new.org_types) and array_length(new.org_types,1) = 1 then return new; end if;
  for m in
    select c.id, c.name from companies c
    where c.id <> new.id and c.archived_at is null and c.tenant_id = new.tenant_id
      and (
        (private.norm(c.name) = private.norm(new.name)
          and (c.city is null or new.city is null or private.norm(c.city) = private.norm(new.city)))
        or (private.street_key(new.address, new.city) is not null
          and private.street_key(c.address, c.city) = private.street_key(new.address, new.city)
          and private.norm(c.name) = private.norm(new.name))
      )
      and not exists (select 1 from review_items ri where ri.kind = 'possible_duplicate' and ri.entity = 'companies'
        and ((ri.entity_id = c.id and ri.related_id = new.id) or (ri.entity_id = new.id and ri.related_id = c.id)))
    limit 5
  loop
    insert into review_items (kind, entity, entity_id, related_id, reason, created_by, tenant_id)
    values ('possible_duplicate', 'companies', new.id, m.id,
            'Same name' || case when new.city is not null then ' and city' else '' end || ' as an existing organization',
            auth.uid(), new.tenant_id);
  end loop;
  return new;
end $$;

create or replace function private.flag_people_dupes() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare m record; cell text := right(regexp_replace(coalesce(new.personal_cell,''), '\D', '', 'g'), 10);
begin
  for m in
    select p.id from people p
    where p.id <> new.id and p.archived_at is null and p.tenant_id = new.tenant_id
      and ((length(cell) = 10 and right(regexp_replace(coalesce(p.personal_cell,''), '\D', '', 'g'), 10) = cell)
        or (new.personal_email is not null and lower(p.personal_email) = lower(new.personal_email)))
      and not exists (select 1 from review_items ri where ri.kind = 'possible_duplicate' and ri.entity = 'people'
        and ((ri.entity_id = p.id and ri.related_id = new.id) or (ri.entity_id = new.id and ri.related_id = p.id)))
    limit 5
  loop
    insert into review_items (kind, entity, entity_id, related_id, reason, created_by, tenant_id)
    values ('possible_duplicate', 'people', new.id, m.id, 'Same cell phone or email as an existing person', auth.uid(), new.tenant_id);
  end loop;
  return new;
end $$;

-- ============================================================
-- AUDIT LOG (append only, kept forever)
-- ============================================================
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null default private.default_tenant(),
  at timestamptz not null default now(),
  actor uuid,
  actor_name text,
  via text not null default 'app' check (via in ('app','claude','system')),
  table_name text not null,
  record_id uuid,
  org_id uuid,
  action text not null check (action in ('insert','update','delete')),
  label text,
  changes jsonb
);
create index if not exists audit_at_idx on public.audit_log (at desc);
create index if not exists audit_org_idx on public.audit_log (org_id, at desc);
create index if not exists audit_record_idx on public.audit_log (record_id, at desc);
alter table public.audit_log enable row level security;
create policy "admin read audit" on public.audit_log for select using (private.is_admin());
grant select on public.audit_log to authenticated;

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  diff jsonb;
  who uuid := private.actor();
  how text := case when auth.uid() is not null then 'app'
                   when nullif(current_setting('app.actor', true), '') is not null
                     then coalesce(nullif(current_setting('app.via', true), ''), 'claude')
                   else 'system' end;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_array(o->k, n->k)) into diff
    from jsonb_object_keys(n) k
    where k <> 'updated_at' and (o->k) is distinct from (n->k);
    if diff is null then return null; end if;
  elsif tg_op = 'INSERT' then diff := n - 'updated_at';
  else diff := o;
  end if;
  insert into audit_log (tenant_id, actor, actor_name, via, table_name, record_id, org_id, action, label, changes)
  values (
    coalesce(nullif(r->>'tenant_id','')::uuid, private.default_tenant()),
    who, (select full_name from app_users where id = who), how,
    tg_table_name, nullif(r->>'id','')::uuid,
    case when tg_table_name = 'companies' then nullif(r->>'id','')::uuid
         when tg_table_name = 'media' and r->>'entity' = 'companies' then nullif(r->>'entity_id','')::uuid
         when tg_table_name = 'review_items' and r->>'entity' = 'companies' then nullif(r->>'entity_id','')::uuid
         else nullif(r->>'company_id','')::uuid end,
    lower(tg_op),
    coalesce(r->>'name', nullif(concat_ws(' ', r->>'first_name', r->>'last_name'), ''), r->>'label',
             r->>'service', r->>'title', r->>'email', r->>'reason', left(r->>'body', 80)),
    diff);
  return null;
end $$;

create or replace function private.audit_is_permanent() returns trigger
language plpgsql as $$ begin raise exception 'The audit log cannot be changed or erased'; end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function private.audit_is_permanent();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.audit_is_permanent();

create trigger audit_companies after insert or update or delete on public.companies for each row execute function private.audit();
create trigger audit_people after insert or update or delete on public.people for each row execute function private.audit();
create trigger audit_company_people after insert or update or delete on public.company_people for each row execute function private.audit();
create trigger audit_opportunities after insert or update or delete on public.opportunities for each row execute function private.audit();
create trigger audit_activities after insert or update or delete on public.activities for each row execute function private.audit();
create trigger audit_tasks after insert or update or delete on public.tasks for each row execute function private.audit();
create trigger audit_vendor_companies after insert or update or delete on public.vendor_companies for each row execute function private.audit();
create trigger audit_escalations after insert or update or delete on public.escalations for each row execute function private.audit();
create trigger audit_review_items after insert or update or delete on public.review_items for each row execute function private.audit();
create trigger audit_app_users after insert or update or delete on public.app_users for each row execute function private.audit();
create trigger audit_lookup_values after insert or update or delete on public.lookup_values for each row execute function private.audit();
create trigger audit_vendors after insert or update or delete on public.vendors for each row execute function private.audit();
create trigger audit_tenants after insert or update or delete on public.tenants for each row execute function private.audit();

-- ============================================================
-- INVITE-ONLY SIGNUP
-- ============================================================
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  email text not null,
  full_name text,
  role text not null default 'staff' check (role in ('staff','vendor')),
  is_admin boolean not null default false,
  manager_id uuid references public.app_users(id),
  vendor_id uuid references public.vendors(id),
  invited_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_user uuid references public.app_users(id),
  revoked_at timestamptz
);
create unique index if not exists invites_open_email on public.invites (lower(email)) where accepted_at is null and revoked_at is null;
alter table public.invites enable row level security;
create policy "admin manage invites" on public.invites for all using (private.is_admin()) with check (private.is_admin());
grant select, insert, update on public.invites to authenticated;
create trigger audit_invites after insert or update or delete on public.invites for each row execute function private.audit();

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare inv invites%rowtype;
begin
  if exists (select 1 from app_users where id = new.id) then return new; end if;
  select * into inv from invites
   where lower(email) = lower(new.email) and accepted_at is null and revoked_at is null
   order by created_at desc limit 1;
  if not found then
    raise exception 'NOT_INVITED: This email has not been invited yet.';
  end if;
  insert into app_users (id, full_name, email, role, active, is_admin, manager_id, vendor_id, tenant_id)
  values (new.id, coalesce(nullif(trim(inv.full_name),''), new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          lower(new.email), inv.role::user_role, true, inv.is_admin and inv.role = 'staff', inv.manager_id, inv.vendor_id, inv.tenant_id);
  update invites set accepted_at = now(), accepted_user = new.id where id = inv.id;
  return new;
end $$;

-- ============================================================
-- MEDIA (org logos and photos; files are kept, never erased)
-- ============================================================
create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  bucket text not null default 'media',
  path text not null,
  url text,
  kind text not null default 'logo' check (kind in ('logo','photo','file')),
  entity text check (entity in ('companies','people')),
  entity_id uuid,
  title text,
  mime text,
  bytes bigint,
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists media_entity_idx on public.media (entity, entity_id, created_at desc);
alter table public.media enable row level security;
create policy "internal all media" on public.media for all using (private.is_internal()) with check (private.is_internal());
create policy "vendor read media" on public.media for select
  using (archived_at is null and entity = 'companies' and private.vendor_can_see_company(entity_id));
grant select, insert, update on public.media to authenticated;
create trigger audit_media after insert or update or delete on public.media for each row execute function private.audit();

alter table public.companies add column if not exists logo_media_id uuid references public.media(id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;
create policy "staff upload media" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and private.is_internal());
create policy "staff read media" on storage.objects for select to authenticated
  using (bucket_id = 'media' and private.is_internal());

-- ============================================================
-- LOCKDOWN: nothing is hard deleted through the API. Archive goes through request_delete.
-- ============================================================
revoke delete, truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke delete, truncate on tables from anon, authenticated;

revoke execute on function private.audit(), private.audit_is_permanent(), private.handle_new_auth_user(),
  private.flag_company_dupes(), private.flag_people_dupes() from public, anon, authenticated;
grant execute on function private.current_tenant(), private.default_tenant(), private.actor() to authenticated;

alter function private.audit_is_permanent() set search_path = pg_catalog;
alter function private.default_tenant() set search_path = pg_catalog;
