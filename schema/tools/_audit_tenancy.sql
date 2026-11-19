-- _audit_tenancy.sql  (READ-ONLY; safe on production. Run each query separately.)
-- Tuned to your conventions: tenant_id column, RLS, private.current_tenant(),
-- SECURITY DEFINER functions that check tenant and role themselves.

-- A. Tables in public without RLS (expected: none, apart from deliberate exceptions)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1;

-- B. Tables without a tenant_id (each should be a deliberate exception, e.g. tenants itself)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and not exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) order by 1;

-- C. Views that bypass RLS (they run as their owner unless security_invoker is on).
--    Expected exception after 202: network_jobs (deliberate, column-limited, security_barrier).
select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v','m')
  and not coalesce((select option_value = 'true' from pg_options_to_table(c.reloptions)
                    where option_name = 'security_invoker'), false) order by 1;

-- D. SECURITY DEFINER functions without a pinned search_path
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname in ('public','private')
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') order by 1,2;

-- E. SECURITY DEFINER functions in public that anonymous users can execute
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 2;

-- F. Policies to review by hand: wide open, granted to anon/public, or never mentioning the tenant
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
where schemaname = 'public'
  and ( qual = 'true' or with_check = 'true'
        or roles && array['anon','public']::name[]
        or (coalesce(qual,'') not ilike '%current_tenant%' and coalesce(with_check,'') not ilike '%current_tenant%') )
order by tablename, policyname;

-- G. SECURITY DEFINER functions whose body never mentions current_tenant() / a tenant helper.
--    These are the ones to read first: each must either be tenant-agnostic by design or check
--    tenant some other way. (Heuristic: text match, expect some false positives.)
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname in ('public','private')
  and p.prosrc !~* '(current_tenant|acting_tenant|tenant_id)' order by 1,2;

-- H. Generate REVOKE statements for definer functions that anon can currently execute
--    (review the list, drop any that are meant to be public, then run the rest)
select format('revoke execute on function %s from public, anon;', p.oid::regprocedure) as stmt
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 1;

-- I. tenant_id columns that allow NULL (a NULL tenant row is invisible to tenant policies
--    but may be visible to other code paths)
select c.relname, a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and a.attname = 'tenant_id' and not a.attnotnull and not a.attisdropped;

-- J. RLS enabled but not FORCED (the table owner is exempt unless FORCE is on)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not c.relforcerowsecurity order by 1;

-- K. Tables where anon/authenticated hold write privileges (relevant if you moved to
--    "writes only via definer functions"; informational for older tables)
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
  and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
group by table_name, grantee order by 1,2;
