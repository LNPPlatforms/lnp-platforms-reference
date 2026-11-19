-- isolation_sweep.sql: run against your REAL database with a throwaway test user.
-- Replace <TEST_USER_UUID>. Lists every public table with a tenant_id where this user can see
-- rows belonging to a different tenant. Tables legitimately shared (e.g. through an active
-- share) will appear once sharing is on: whitelist those and test them with explicit assertions.
begin;
select set_config('request.jwt.claims', json_build_object('sub','<TEST_USER_UUID>','role','authenticated')::text, true);
set local role authenticated;
do $$
declare r record; n bigint; bad text := '';
begin
  for r in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
           where ns.nspname = 'public' and c.relkind = 'r' loop
    execute format('select count(*) from public.%I where tenant_id <> private.current_tenant()', r.relname) into n;
    if n > 0 then bad := bad || r.relname || '(' || n || ') '; end if;
  end loop;
  if bad <> '' then raise exception 'Cross-tenant rows visible in: %', bad; end if;
  raise notice 'PASS: no foreign-tenant rows visible in any table with a tenant_id';
end $$;
rollback;
