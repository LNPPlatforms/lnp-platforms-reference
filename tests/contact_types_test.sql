-- 087: contact types on people and team presence. Run with tests/run_db.sh tests/contact_types_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a7000000-0000-0000-0000-000000000001', 'Acct', 'acct'), ('a7000000-0000-0000-0000-000000000002', 'Other', 'other');
insert into app_users (id, full_name, email, tenant_id, is_admin, last_seen_at) values
  ('b7000000-0000-0000-0000-000000000001', 'Ada Admin', 'a@x.com', 'a7000000-0000-0000-0000-000000000001', true, now()),
  ('b7000000-0000-0000-0000-000000000002', 'Ben Away', 'b@x.com', 'a7000000-0000-0000-0000-000000000001', false, now() - interval '1 hour'),
  ('b7000000-0000-0000-0000-000000000003', 'Oz Other', 'o@x.com', 'a7000000-0000-0000-0000-000000000002', true, now());
-- the seed in 087 runs per account; run it again now that accounts exist
\i schema/087_contact_types_presence.sql
do $$ begin
  if (select count(*) from lookup_values where list_name = 'person_type' and tenant_id::text like 'a7%') <> 6 then raise exception 'person types not seeded for each account'; end if;
  if (select count(*) from lookup_values where list_name = 'org_type' and label = 'Client' and tenant_id::text like 'a7%') <> 2 then raise exception 'Client org type missing'; end if;
end $$;
-- running it twice adds nothing
\i schema/087_contact_types_presence.sql
do $$ begin if (select count(*) from lookup_values where list_name = 'person_type' and tenant_id::text like 'a7%') <> 6 then raise exception 'seed not idempotent'; end if; end $$;
insert into people (id, tenant_id, first_name) values ('c7000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'Pat'),
  ('c7000000-0000-0000-0000-000000000002', 'a7000000-0000-0000-0000-000000000002', 'Pip');
do $$ begin if (select person_types from people where first_name = 'Pat') <> '{Contact}' then raise exception 'new people should start as Contact'; end if; end $$;
update people set person_types = '{Client,Vendor}' where first_name in ('Pat', 'Pip');
grant execute on all functions in schema private, public to authenticated;
set role authenticated;
select set_config('test.uid', 'b7000000-0000-0000-0000-000000000001', false);
select public.rename_lookup('person_type', 'Vendor', 'Supplier');
reset role;
do $$ begin
  if (select person_types from people where first_name = 'Pat') <> '{Client,Supplier}' then raise exception 'rename did not carry to people'; end if;
  if (select person_types from people where first_name = 'Pip') <> '{Client,Vendor}' then raise exception 'rename leaked into another account'; end if;
end $$;
set role authenticated;
select set_config('test.uid', 'b7000000-0000-0000-0000-000000000001', false);
do $$ declare j jsonb := public.team_presence(); begin
  if jsonb_array_length(j) <> 2 then raise exception 'presence should list only this account, got %', j; end if;
  if not (select (x->>'online')::boolean from jsonb_array_elements(j) x where x->>'id' = 'b7000000-0000-0000-0000-000000000001') then raise exception 'Ada should be online'; end if;
  if (select (x->>'online')::boolean from jsonb_array_elements(j) x where x->>'id' = 'b7000000-0000-0000-0000-000000000002') then raise exception 'Ben should be away'; end if;
end $$;
select 'contact types and presence: all good';
