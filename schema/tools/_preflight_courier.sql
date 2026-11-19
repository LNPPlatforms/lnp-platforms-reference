-- _preflight_courier.sql  (READ-ONLY; safe to run on production)
-- Run this BEFORE the 200-series files. It lists everything the courier module
-- assumes about your schema and every name it is about to create, and fails
-- with ONE message listing what to fix. Nothing is modified.
do $$
declare
  missing text[] := '{}';
  r record;
begin
  -- Functions the module calls (from your description of 070b / 074b / 117)
  for r in select unnest(array[
      'private.current_tenant()',
      'private.is_internal()',
      'private.feature_on(text)',
      'private.is_admin()',
      'public.set_acting_tenant(uuid)'
  ]) as sig loop
    if to_regprocedure(r.sig) is null then
      missing := missing || ('missing function ' || r.sig ||
        case r.sig when 'private.is_admin()'
          then '  (if your admin check has another name, edit private.dh_is_admin() in 200 and remove this entry)'
          else '' end);
    end if;
  end loop;

  -- Tables
  for r in select unnest(array['public.tenants','public.app_users','public.account_members','public.roles']) as t loop
    if to_regclass(r.t) is null then missing := missing || ('missing table ' || r.t); end if;
  end loop;

  -- Columns
  for r in select * from (values
      ('tenants','id'),('tenants','agency_tenant_id'),
      ('app_users','id'),('app_users','tenant_id'),('app_users','acting_tenant_id'),
      ('app_users','role_id'),('app_users','is_admin'),
      ('account_members','tenant_id'),('account_members','user_id')
  ) as v(t,c) loop
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name=r.t and column_name=r.c) then
      missing := missing || ('missing column public.' || r.t || '.' || r.c);
    end if;
  end loop;

  -- Name collisions with objects this module will create
  for r in select unnest(array[
      'courier_profiles','dh_campaigns','dh_listings','dh_zones','dh_addresses',
      'dh_drops','dh_ledger','tenant_shares','network_jobs']) as t loop
    if to_regclass('public.' || r.t) is not null then
      missing := missing || ('NAME COLLISION: public.' || r.t || ' already exists');
    end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception E'Preflight found issues:\n  - %', array_to_string(missing, E'\n  - ');
  end if;

  -- Informational
  if not exists (select 1 from pg_extension where extname = 'postgis') then
    raise notice 'postgis is not installed; 201 will create it in schema "extensions".';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise notice 'role "authenticated" not found - is this a Supabase database?';
  end if;
  raise notice 'Preflight OK: all assumed objects exist and no names collide.';
end $$;
