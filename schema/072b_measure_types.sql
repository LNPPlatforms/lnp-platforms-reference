-- 072b: the measuring tool, part 2. Item types people measure with, and their tap states and add-ons.
-- what people measure: an area (square feet), a length (linear feet) or a count (tap to count).
-- Counts have tap states: the first tap is states[0], each tap after moves to the next state.
-- states: [{key, name, short, color, base, addons: [price item ids]}]. base: charge the type's price item for things in that state.
create table if not exists public.measure_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 60),
  kind text not null check (kind in ('area', 'length', 'count')),
  color text not null default '#2563EB' check (color ~* '^#[0-9a-f]{6}$'),
  price_item_id uuid references public.price_items(id),
  states jsonb not null default '[]'::jsonb,
  sort int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists measure_types_tenant on public.measure_types (tenant_id, sort);

create or replace function private.measure_type_check() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare s jsonb; keys text[] := '{}'; a jsonb;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.tenant_id := old.tenant_id; new.created_at := old.created_at;
  elsif auth.uid() is not null then new.tenant_id := private.current_tenant(); end if;
  new.name := trim(new.name);
  if new.price_item_id is not null and not exists (select 1 from price_items where id = new.price_item_id and tenant_id = new.tenant_id) then
    raise exception 'Pick a price from your own price book';
  end if;
  if new.kind <> 'count' then new.states := '[]'::jsonb; return new; end if;
  if jsonb_typeof(new.states) <> 'array' or jsonb_array_length(new.states) = 0 then
    new.states := jsonb_build_array(jsonb_build_object('key', 'count', 'name', 'Counted', 'short', '', 'color', new.color, 'base', true, 'addons', '[]'::jsonb));
  end if;
  if jsonb_array_length(new.states) > 6 then raise exception 'A count can have up to 6 tap states'; end if;
  for s in select value from jsonb_array_elements(new.states) loop
    if jsonb_typeof(s) <> 'object' or coalesce(s->>'key', '') !~ '^[a-z0-9_]{1,20}$' then raise exception 'Each tap state needs a short key'; end if;
    if s->>'key' = any(keys) then raise exception 'Two tap states have the same key'; end if;
    keys := keys || (s->>'key');
    if length(trim(coalesce(s->>'name', ''))) not between 1 and 40 then raise exception 'Each tap state needs a name up to 40 letters'; end if;
    if length(coalesce(s->>'short', '')) > 20 then raise exception 'Keep the short word to 20 letters'; end if;
    if coalesce(s->>'color', '') !~* '^#[0-9a-f]{6}$' then raise exception 'Each tap state needs a color like #2563EB'; end if;
    if jsonb_typeof(coalesce(s->'addons', '[]'::jsonb)) <> 'array' then raise exception 'Add-ons are a list'; end if;
    for a in select value from jsonb_array_elements(coalesce(s->'addons', '[]'::jsonb)) loop
      if jsonb_typeof(a) <> 'string' or (a #>> '{}') !~ '^[0-9a-f-]{36}$'
         or not exists (select 1 from price_items where id = (a #>> '{}')::uuid and tenant_id = new.tenant_id) then
        raise exception 'Add-ons come from your own price book';
      end if;
    end loop;
  end loop;
  new.color := new.states->0->>'color';
  return new;
end $$;
create trigger measure_type_check before insert or update on public.measure_types for each row execute function private.measure_type_check();

alter table public.measure_types enable row level security;
create policy "see measure types" on public.measure_types for select using (tenant_id = private.current_tenant() and private.measure_see());
create policy "add measure types" on public.measure_types for insert with check (tenant_id = private.current_tenant() and private.measure_setup());
create policy "edit measure types" on public.measure_types for update using (tenant_id = private.current_tenant() and private.measure_setup())
  with check (tenant_id = private.current_tenant() and private.measure_setup());
revoke all on public.measure_types from anon, authenticated;
grant select, insert, update on public.measure_types to authenticated;
create trigger audit_measure_types after insert or update on public.measure_types for each row execute function private.audit();
