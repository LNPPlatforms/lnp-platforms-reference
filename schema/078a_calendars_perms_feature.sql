-- 078a: booking calendars, part 1. The Calendars role area and the Calendars feature switch (off until an account
-- turns it on). Keeps the E-sign area and switch from 077a (this redefines the same three functions). Levels: 1 see appointments (own, company or all by scope), 2 book, move and cancel them and keep your
-- own hours, 3 change other people's hours and days off, 4 set up calendars.
-- Manager 4 all, division manager 3 their company, sales rep 2 own, field worker 1 own, accounting 1 all.

create or replace function private.perm_areas() returns text[] language sql immutable set search_path = pg_catalog as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team',
               'automations', 'marketing', 'templates', 'media', 'invoices', 'bids', 'esign', 'calendars']
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
    when 'esign' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}'
      when 'sales_rep' then '{"level":2,"scope":"own"}' when 'accounting' then '{"level":1,"scope":"all"}' end
    when 'calendars' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}'
      when 'sales_rep' then '{"level":2,"scope":"own"}' when 'field_worker' then '{"level":1,"scope":"own"}' when 'accounting' then '{"level":1,"scope":"all"}' end
  end, '{"level":0,"scope":"own"}')::jsonb
$$;
revoke execute on function private.area_default(text, text) from public, anon;
grant execute on function private.area_default(text, text) to authenticated;

-- Calendars is off by default like jobs, bids and the client portal
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars'))
$$;
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars'))
$$;
revoke execute on function private.feature_on_for(uuid, text) from public, anon, authenticated;

create or replace function private.cal_see() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('calendars') and private.can('calendars', 1)
$$;
create or replace function private.cal_setup() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('calendars') and (private.is_admin() or private.can('calendars', 4))
$$;
revoke execute on function private.cal_see(), private.cal_setup() from public, anon;
grant execute on function private.cal_see(), private.cal_setup() to authenticated;
