-- 072c: saved measurements. The shapes drawn on the map (GeoJSON), the totals they add up to, the picture saved
-- for the customer and where the map was. Linked to an organization (location) so the team can reopen and reuse it.
create table if not exists public.measurements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  company_id uuid references public.companies(id),
  name text not null default 'Measurement' check (length(trim(name)) between 1 and 120),
  address text check (address is null or length(address) <= 300),
  shapes jsonb not null default '{"type":"FeatureCollection","features":[]}'::jsonb,
  totals jsonb not null default '{}'::jsonb,
  summary text not null default '' check (length(summary) <= 1000),
  picture_url text check (picture_url is null or length(picture_url) <= 1000),
  view jsonb not null default '{}'::jsonb,          -- {lat, lng, zoom} where the map was left
  used_on jsonb not null default '[]'::jsonb,       -- [{kind: invoice|proposal, id, at}] where its prices went
  created_by uuid default auth.uid() references public.app_users(id),
  updated_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists measurements_company on public.measurements (company_id, updated_at desc);
create index if not exists measurements_tenant on public.measurements (tenant_id, updated_at desc);

create or replace function private.measurement_check() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  new.updated_at := now(); new.updated_by := coalesce(auth.uid(), new.updated_by);
  if tg_op = 'UPDATE' then new.tenant_id := old.tenant_id; new.created_by := old.created_by; new.created_at := old.created_at;
  elsif auth.uid() is not null then new.tenant_id := private.current_tenant(); new.created_by := auth.uid(); end if;
  if new.company_id is not null and not exists (select 1 from companies where id = new.company_id and tenant_id = new.tenant_id) then
    raise exception 'Organization not found';
  end if;
  if jsonb_typeof(new.shapes) <> 'object' or new.shapes->>'type' <> 'FeatureCollection' or jsonb_typeof(new.shapes->'features') <> 'array' then
    raise exception 'The shapes need to be a map drawing';
  end if;
  if jsonb_array_length(new.shapes->'features') > 2000 then raise exception 'That''s more than 2,000 shapes. Split it into two measurements.'; end if;
  if length(new.shapes::text) > 2000000 then raise exception 'That drawing is too big to save'; end if;
  if jsonb_typeof(new.totals) <> 'object' then new.totals := '{}'::jsonb; end if;
  if jsonb_typeof(new.view) <> 'object' then new.view := '{}'::jsonb; end if;
  if jsonb_typeof(new.used_on) <> 'array' then new.used_on := '[]'::jsonb; end if;
  new.name := trim(new.name);
  return new;
end $$;
create trigger measurement_check before insert or update on public.measurements for each row execute function private.measurement_check();

alter table public.measurements enable row level security;
create policy "see measurements" on public.measurements for select using (tenant_id = private.current_tenant() and private.measure_see());
create policy "add measurements" on public.measurements for insert with check (tenant_id = private.current_tenant() and private.measure_see() and private.can('proposals', 2));
create policy "edit measurements" on public.measurements for update using (tenant_id = private.current_tenant() and private.measure_see() and private.can('proposals', 2))
  with check (tenant_id = private.current_tenant() and private.can('proposals', 2));
revoke all on public.measurements from anon, authenticated;
grant select, insert, update on public.measurements to authenticated;
create trigger audit_measurements after insert or update on public.measurements for each row execute function private.audit();

-- pictures on invoices (the measured map, so the customer sees what they're paying for): [{url, title, measurement_id}]
alter table public.invoices add column if not exists pictures jsonb not null default '[]'::jsonb;
alter table public.invoices add constraint invoices_pictures_shape check (jsonb_typeof(pictures) = 'array' and jsonb_array_length(pictures) <= 12);
