-- 107: Microsoft connection storage. Run with tests/run_db.sh tests/ms_connect_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a4000000-0000-0000-0000-000000000001', 'Acme', 'acme4');
insert into app_users (id, full_name, email, tenant_id) values ('b4000000-0000-0000-0000-000000000001', 'Ann', 'ann4@x.com', 'a4000000-0000-0000-0000-000000000001');
insert into ms_connections (user_id, email) values ('b4000000-0000-0000-0000-000000000001', 'ann@acme.com');
select public.ms_token_save('b4000000-0000-0000-0000-000000000001', 'rt-one');
select public.ms_token_read('b4000000-0000-0000-0000-000000000001') = 'rt-one' as saved;
select public.ms_token_save('b4000000-0000-0000-0000-000000000001', 'rt-two');
select public.ms_token_read('b4000000-0000-0000-0000-000000000001') = 'rt-two' and (select count(*) from vault.secrets) = 1 as rotated_in_place;
insert into cal_busy (user_id, starts_at, ends_at, source, external_id) values ('b4000000-0000-0000-0000-000000000001', now(), now() + interval '1 hour', 'outlook', 'ms:1');
select public.ms_token_drop('b4000000-0000-0000-0000-000000000001');
select not exists (select 1 from ms_connections) and not exists (select 1 from vault.secrets) and not exists (select 1 from cal_busy where source = 'outlook') as disconnect_clears_all;
select not has_function_privilege('authenticated', 'public.ms_token_read(uuid)', 'execute') and not has_function_privilege('anon', 'public.ms_token_read(uuid)', 'execute') as app_cant_read_tokens;
select not has_column_privilege('authenticated', 'public.ms_connections', 'token_secret', 'select') and not has_table_privilege('authenticated', 'public.ms_oauth_states', 'select') as secrets_hidden;
