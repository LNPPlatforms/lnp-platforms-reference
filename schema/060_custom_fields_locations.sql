-- 060: custom fields and parent locations (Oct 29, 2026).
-- Custom fields: an account adds its own fields to organizations (locations), people and jobs. Values live in a
--   `custom` jsonb column on each record, keyed by the field's key. Removing a field archives it; the values stay.
-- Parent locations: companies.parent_company_id already existed. An account can turn on "parent locations"
--   (one level) and "nesting" (any depth) in Settings > Features. Each location picks who gets the bill.
-- Check-in pins: a location can have more than one GPS pin (front office, dumpster in the back). Each pin has its
--   own check-in distance; blank uses the account's (500 feet by default).

create table if not exists public.custom_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  entity text not null check (entity in ('companies', 'people', 'jobs')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (length(trim(label)) between 1 and 60),
  type text not null default 'text' check (type in ('text', 'long_text', 'number', 'money', 'date', 'select', 'multi_select', 'checkbox', 'phone', 'email', 'url')),
  options text[] not null default '{}',
  required boolean not null default false,
  sort int not null default 0,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, entity, key)
);
alter table public.custom_fields enable row level security;
create policy "read custom fields" on public.custom_fields for select using (private.is_internal() and tenant_id = private.current_tenant());
create policy "settings manage custom fields" on public.custom_fields for all
  using (private.can('settings', 4) and tenant_id = private.current_tenant())
  with check (private.can('settings', 4) and tenant_id = private.current_tenant());
revoke all on public.custom_fields from anon, authenticated;
grant select, insert, update on public.custom_fields to authenticated;
create trigger audit_custom_fields after insert or update on public.custom_fields for each row execute function private.audit();

alter table public.companies add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.people add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.companies add column if not exists bill_to text not null default 'self' check (bill_to in ('self', 'parent'));

-- a parent can't be the location itself or one of its own children (no loops), and without nesting a parent
-- can't have a parent of its own
create or replace function private.check_parent() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare cur uuid := new.parent_company_id; n int := 0;
begin
  if new.parent_company_id is null or new.parent_company_id is not distinct from old.parent_company_id then return new; end if;
  if new.parent_company_id = new.id then raise exception 'A location can''t belong to itself'; end if;
  if not exists (select 1 from companies where id = new.parent_company_id and tenant_id = new.tenant_id) then raise exception 'Parent not found'; end if;
  while cur is not null and n < 50 loop
    if cur = new.id then raise exception 'That would make a loop: the parent already belongs to this location'; end if;
    select parent_company_id into cur from companies where id = cur; n := n + 1;
  end loop;
  if not coalesce((select (settings->'features'->>'location_nesting')::boolean from account_settings where tenant_id = new.tenant_id), false) then
    if (select parent_company_id from companies where id = new.parent_company_id) is not null then
      raise exception 'Nesting is off, so a parent can''t belong to another parent. Turn on nesting in Settings > Features.';
    end if;
    if exists (select 1 from companies where parent_company_id = new.id and archived_at is null) then
      raise exception 'Nesting is off, and this location already has locations under it';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists check_parent on public.companies;
create trigger check_parent before insert or update of parent_company_id on public.companies for each row execute function private.check_parent();

-- everything under a location, any depth (itself included)
create or replace function public.location_tree(p_root uuid) returns setof uuid
language sql stable security invoker set search_path = public, private as $$
  with recursive t(id, d) as (select id, 0 from companies where id = p_root
    union all select c.id, t.d + 1 from companies c join t on c.parent_company_id = t.id where c.archived_at is null and t.d < 20)
  select id from t
$$;
grant execute on function public.location_tree(uuid) to authenticated;

create table if not exists public.location_pins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  company_id uuid not null references public.companies(id),
  label text not null default 'Main' check (length(trim(label)) between 1 and 60),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_ft int check (radius_ft between 50 and 10000),
  is_primary boolean not null default false,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists location_pins_company on public.location_pins (company_id) where archived_at is null;
alter table public.location_pins enable row level security;
create policy "read pins" on public.location_pins for select using (private.is_internal() and tenant_id = private.current_tenant());
-- pins are set by managers (directly, or by approving a worker's "wrong spot" report)
create policy "managers manage pins" on public.location_pins for all
  using (private.can('dispatch', 3) and tenant_id = private.current_tenant())
  with check (private.can('dispatch', 3) and tenant_id = private.current_tenant()
              and exists (select 1 from companies c where c.id = company_id and c.tenant_id = private.current_tenant()));
revoke all on public.location_pins from anon, authenticated;
grant select, insert, update on public.location_pins to authenticated;
create trigger audit_location_pins after insert or update on public.location_pins for each row execute function private.audit();

-- distance in feet between two points (haversine)
create or replace function private.feet_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 20902231.0 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;
