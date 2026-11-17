-- 073a: bids, part 1. The Bids role area (manager 4 all, division manager 3 their company, sales rep 2 own,
-- accounting 1 all, field worker off) and the Bids feature switch (off until an account turns it on).
-- Decisions: BACKLOG.md "Oct 30 morning voice decisions", Bids bullet.

create or replace function private.perm_areas() returns text[] language sql immutable set search_path = pg_catalog as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team',
               'automations', 'marketing', 'templates', 'media', 'invoices', 'bids']
$$;

create or replace function private.area_default(p_preset text, area text) returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(case area
    when 'automations' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' end
    when 'marketing' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' when 'sales_rep' then '{"level":2,"scope":"own"}' end
    when 'templates' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":2,"scope":"all"}' else '{"level":2,"scope":"own"}' end
    when 'media' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":1,"scope":"all"}' else '{"level":2,"scope":"own"}' end
    when 'invoices' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}'
      when 'accounting' then '{"level":4,"scope":"all"}' when 'sales_rep' then '{"level":2,"scope":"own"}' end
    when 'bids' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}'
      when 'sales_rep' then '{"level":2,"scope":"own"}' when 'accounting' then '{"level":1,"scope":"all"}' end
  end, '{"level":0,"scope":"own"}')::jsonb
$$;
revoke execute on function private.area_default(text, text) from public, anon;
grant execute on function private.area_default(text, text) to authenticated;

-- Bids is off by default like jobs, pay and measuring
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids'))
$$;
-- the same switch for a given account (intake by email or the public upload page has nobody signed in)
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids'))
$$;
revoke execute on function private.feature_on_for(uuid, text) from public, anon, authenticated;

create or replace function private.bids_see() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('bids') and private.can('bids', 1)
$$;
create or replace function private.bids_setup() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('bids') and (private.is_admin() or private.can('bids', 4))
$$;
revoke execute on function private.bids_see(), private.bids_setup() from public, anon;
grant execute on function private.bids_see(), private.bids_setup() to authenticated;

-- the ready-made roles fill in every area added after 059 (invoices, automations, bids...) from area_default,
-- so a role started from a preset gets the same defaults a preset-made role would get anyway
do $$ begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'role_presets_base') then
    alter function public.role_presets() rename to role_presets_base;
    alter function public.role_presets_base() set schema private;
  end if;
end $$;
create or replace function public.role_presets() returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select jsonb_object_agg(k, v || jsonb_build_object('perms', coalesce(v->'perms', '{}'::jsonb)
           || coalesce((select jsonb_object_agg(a, private.area_default(k, a)) from unnest(private.perm_areas()) a where not (coalesce(v->'perms', '{}'::jsonb) ? a)), '{}'::jsonb)))
  from jsonb_each(private.role_presets_base()) x(k, v)
$$;
revoke execute on function private.role_presets_base() from public, anon, authenticated;
grant execute on function public.role_presets() to authenticated;
