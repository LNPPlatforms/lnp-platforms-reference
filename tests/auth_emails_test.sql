-- 090: invite tokens and password reset targets, only for the service role
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a9000000-0000-0000-0000-000000000001', 'Acct', 'acct9');
insert into app_users (id, full_name, email, tenant_id, is_admin, active) values ('b9000000-0000-0000-0000-000000000001', 'Ada Admin', 'ada9@x.com', 'a9000000-0000-0000-0000-000000000001', true, true);
insert into invites (id, tenant_id, email, full_name, role) values ('e9000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 'new9@x.com', 'New Nan', 'staff'),
  ('e9000000-0000-0000-0000-000000000002', 'a9000000-0000-0000-0000-000000000001', 'two9@x.com', 'Two', 'staff');
do $$ declare t1 text; t2 text; begin
  select token into t1 from invites where id = 'e9000000-0000-0000-0000-000000000001';
  select token into t2 from invites where id = 'e9000000-0000-0000-0000-000000000002';
  if length(t1) < 40 or t1 = t2 then raise exception 'tokens should be long and different'; end if;
  if private.invite_by_token('NEW9@x.com', t1) is null then raise exception 'token should find its invite'; end if;
  if private.invite_by_token('two9@x.com', t1) is not null then raise exception 'token worked for the wrong email'; end if;
  if private.reset_target('ada9@x.com') is null then raise exception 'reset should find Ada'; end if;
  if private.reset_target('ada9@x.com') is not null then raise exception 'second reset within a minute should be skipped'; end if;
  if private.reset_target('nobody9@x.com') is not null then raise exception 'unknown email should get nothing'; end if;
end $$;
grant execute on all functions in schema private, public to authenticated;
set role authenticated;
select set_config('test.uid', 'b9000000-0000-0000-0000-000000000001', false);
do $$ begin
  if public.svc_invite_by_token('new9@x.com', (select token from invites limit 1)) is not null then raise exception 'a signed in user got an invite by token'; end if;
exception when insufficient_privilege then null; end $$;
select 'auth emails: all good';
