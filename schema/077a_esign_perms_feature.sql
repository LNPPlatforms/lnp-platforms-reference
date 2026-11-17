-- 077a: e-sign, part 1. The E-sign role area (manager 4 all, division manager 3 their company, sales rep 2 own,
-- accounting 1 all, field worker off) and the E-sign feature switch (off until an account turns it on, like Bids).
-- Decisions: BACKLOG.md "Oct 30 morning voice decisions", E-sign bullet (built in, uploaded PDFs and templates only).

create or replace function private.perm_areas() returns text[] language sql immutable set search_path = pg_catalog as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team',
               'automations', 'marketing', 'templates', 'media', 'invoices', 'bids', 'esign']
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
  end, '{"level":0,"scope":"own"}')::jsonb
$$;
revoke execute on function private.area_default(text, text) from public, anon;
grant execute on function private.area_default(text, text) to authenticated;

-- E-sign is off by default like bids and the client portal
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign'))
$$;
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign'))
$$;
revoke execute on function private.feature_on_for(uuid, text) from public, anon, authenticated;

-- see envelopes and templates (level 1), make and send them (2), void anyone's in scope (3), settings (4)
create or replace function private.esign_see() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('esign') and private.can('esign', 1)
$$;
create or replace function private.esign_setup() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('esign') and (private.is_admin() or private.can('esign', 4))
$$;
revoke execute on function private.esign_see(), private.esign_setup() from public, anon;
grant execute on function private.esign_see(), private.esign_setup() to authenticated;
