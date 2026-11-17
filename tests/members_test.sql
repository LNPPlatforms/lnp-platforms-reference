-- 070: members of more than one account. Run with tests/run_db.sh tests/members_test.sql
-- Home = an agency (like GELP). Client sits under another agency (like Demo Home Service under GCC). Other is unrelated.
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug, is_agency, agency_tenant_id) values
  ('a1000000-0000-0000-0000-000000000001', 'Home Agency', 'home', true, null),
  ('a1000000-0000-0000-0000-000000000003', 'Coast Agency', 'coast', true, null),
  ('a1000000-0000-0000-0000-000000000002', 'Client Co', 'client', false, 'a1000000-0000-0000-0000-000000000003'),
  ('a1000000-0000-0000-0000-000000000004', 'Other Co', 'other', false, null);
insert into white_labels (agency_tenant_id, name, short_name) values ('a1000000-0000-0000-0000-000000000001', 'Home Agency Brand', 'HA');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b1000000-0000-0000-0000-000000000001', 'Owen Owner', 'o@x.com', 'a1000000-0000-0000-0000-000000000001', true),
  ('b1000000-0000-0000-0000-000000000002', 'Jul Assistant', 'j@x.com', 'a1000000-0000-0000-0000-000000000001', true),
  ('b1000000-0000-0000-0000-000000000003', 'Cal Client', 'c@x.com', 'a1000000-0000-0000-0000-000000000002', true),
  ('b1000000-0000-0000-0000-000000000004', 'Rae Clientrep', 'r@x.com', 'a1000000-0000-0000-0000-000000000002', false),
  ('b1000000-0000-0000-0000-000000000005', 'Xan Other', 'x@x.com', 'a1000000-0000-0000-0000-000000000004', true),
  ('b1000000-0000-0000-0000-000000000006', 'Kit Homestaff', 'k@x.com', 'a1000000-0000-0000-0000-000000000001', false);
insert into private.platform_owners (user_id) values ('b1000000-0000-0000-0000-000000000001');
insert into divisions (id, tenant_id, name) values ('d1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'North'),
  ('d1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 'South');
insert into companies (id, tenant_id, name, divisions) values
  ('e1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Home Lead', '{}'),
  ('e1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 'Client North', '{d1000000-0000-0000-0000-000000000001}'),
  ('e1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000002', 'Client South', '{d1000000-0000-0000-0000-000000000002}'),
  ('e1000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000004', 'Other Lead', '{}');
insert into roles (id, tenant_id, name, preset_key, perms) values
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'Sales rep', 'sales_rep', public.role_presets()->'sales_rep'->'perms'),
  ('c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000004', 'Other role', 'sales_rep', public.role_presets()->'sales_rep'->'perms');
-- row security like the live tables
alter policy "co" on companies using (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions))
  with check (private.is_internal() and tenant_id = private.current_tenant() and private.div_ok(divisions));
alter table tasks enable row level security;
create policy "internal all tasks" on tasks for all using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
create policy "admin manage users" on app_users for all using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
grant select on tenants to authenticated;
grant execute on all functions in schema private, public to authenticated;
set role authenticated;

-- before: Jul can't get into Client, and can't add herself (Client isn't under her agency)
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin perform public.set_acting_tenant('a1000000-0000-0000-0000-000000000002'); raise exception 'switched'; exception when others then if sqlerrm = 'switched' then raise; end if; end $$;
do $$ begin perform public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', true); raise exception 'self added'; exception when others then if sqlerrm = 'self added' then raise; end if; end $$;
select jsonb_array_length(public.my_accounts()) = 1 as one_account_before;
-- the client's own admin can't pull people in either
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
do $$ begin perform public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', true); raise exception 'client added'; exception when others then if sqlerrm = 'client added' then raise; end if; end $$;

-- the platform owner adds Jul as an admin member. People from an unrelated account can't be added.
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select (select count(*) from jsonb_array_elements(public.account_member_candidates('a1000000-0000-0000-0000-000000000002'))) = 3 as candidates_home_team;
select public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', true)->>'ok' = 'true' as owner_added;
do $$ begin perform public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000005', false); raise exception 'other added'; exception when others then if sqlerrm = 'other added' then raise; end if; end $$;
do $$ begin perform public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000003', false); raise exception 'home added'; exception when others then if sqlerrm = 'home added' then raise; end if; end $$;

-- Jul at home: home data only, home admin
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select (select string_agg(x->>'kind', ',') from jsonb_array_elements(public.my_accounts()) x) = 'home,member' as switcher_lists_both;
select array_agg(name order by name) = '{Home Lead}' and private.is_admin() as home_view from companies;
select count(*) = 0 as no_client_tasks_at_home from tasks;
select public.current_account()->'member' = 'null'::jsonb as not_member_at_home;

-- Jul switches in: Client data only, admin there because the client row says so
select public.set_acting_tenant('a1000000-0000-0000-0000-000000000002')->>'tenant' = 'a1000000-0000-0000-0000-000000000002' as switched_in;
select array_agg(name order by name) = '{Client North,Client South}' as sees_client_only from companies;
select private.is_admin() and (private.perm('team')->>'level')::int = 4 and (public.current_account()->'member'->>'is_admin')::boolean as admin_there;
select array_agg(full_name order by full_name) = '{Cal Client,Jul Assistant,Rae Clientrep}' as client_team_only from app_users;
select (select count(*) from divisions) = 2 as client_divisions;

-- the client sees her on Team with the badge, and can't touch her home login
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
select array_agg(full_name order by full_name) = '{Cal Client,Jul Assistant,Rae Clientrep}' as client_sees_her from app_users;
select public.account_members_list()->0->>'from' = 'HA' and public.account_members_list()->0->>'full_name' = 'Jul Assistant' as badge_from;
update app_users set full_name = 'Hacked', is_admin = false where id = 'b1000000-0000-0000-0000-000000000002';
-- a to-do for her in the client account
insert into tasks (tenant_id, title, assigned_to) values ('a1000000-0000-0000-0000-000000000002', 'Call the Smiths', 'b1000000-0000-0000-0000-000000000002');
select private.on_team('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002') and not private.on_team('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000004') as on_team;
-- the client turns admin off, gives her a role and the North company only
select public.account_member_set('b1000000-0000-0000-0000-000000000002', '{"is_admin":false,"divisions":["d1000000-0000-0000-0000-000000000001","d1000000-0000-0000-0000-000000000099"]}')->>'ok' = 'true' as set_ok;
select public.user_role_set('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001');
do $$ begin perform public.user_role_set('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002'); raise exception 'foreign role'; exception when others then if sqlerrm = 'foreign role' then raise; end if; end $$;
select public.user_customer_facing_set('b1000000-0000-0000-0000-000000000002', true);
select private.cf_in('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002') and not private.cf_in('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001') as cf_per_account;
-- the rep (not a team manager) can't change her
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000004', false);
do $$ begin perform public.account_member_set('b1000000-0000-0000-0000-000000000002', '{"is_admin":true}'); raise exception 'rep changed'; exception when others then if sqlerrm = 'rep changed' then raise; end if; end $$;

-- Jul (still switched in) now has the role and only North
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select not private.is_admin() and private.perm('team')->>'level' = '0' and private.perm('contacts') = public.role_presets()->'sales_rep'->'perms'->'contacts' as role_applies;
select array_agg(name) = '{Client North}' as division_limit from companies;
select count(*) = 1 as sees_her_todo from tasks;
-- her home login is untouched
reset role;
select full_name = 'Jul Assistant' and is_admin and role_id is null and divisions = '{}' and customer_facing is null as home_row_untouched from app_users where id = 'b1000000-0000-0000-0000-000000000002';
set role authenticated;
-- back home: home admin again
select public.set_acting_tenant(null)->>'tenant' = 'a1000000-0000-0000-0000-000000000001' as back_home;
select private.is_admin() and array_agg(name) = '{Home Lead}' as home_admin_again from companies;

-- the platform owner manages the client: switching in that way stays full admin and isn't a member
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select public.set_acting_tenant('a1000000-0000-0000-0000-000000000002') is not null and private.is_admin() and public.current_account()->'member' = 'null'::jsonb as manager_path;
select public.set_acting_tenant(null) is not null;

-- someone unrelated sees none of it
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000005', false);
select array_agg(name) = '{Other Lead}' as other_isolated from companies;
select count(*) = 0 as other_no_members from account_members;
select array_agg(full_name) = '{Xan Other}' as other_team from app_users;
do $$ begin perform public.account_member_remove('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002'); raise exception 'other removed'; exception when others then if sqlerrm = 'other removed' then raise; end if; end $$;

-- Jul goes back in, then the client removes her: she's dropped home and can't get back
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select public.set_acting_tenant('a1000000-0000-0000-0000-000000000002') is not null;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
select public.account_member_remove('b1000000-0000-0000-0000-000000000002')->>'ok' = 'true' as removed;
select array_agg(full_name order by full_name) = '{Cal Client,Rae Clientrep}' as gone_from_team from app_users;
select jsonb_array_length(public.account_members_list()) = 0 as gone_from_list;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select private.current_tenant() = 'a1000000-0000-0000-0000-000000000001' as dropped_home;
do $$ begin perform public.set_acting_tenant('a1000000-0000-0000-0000-000000000002'); raise exception 'got back in'; exception when others then if sqlerrm = 'got back in' then raise; end if; end $$;
reset role;
update app_users set acting_tenant_id = 'a1000000-0000-0000-0000-000000000002' where id = 'b1000000-0000-0000-0000-000000000002';
set role authenticated;
select private.current_tenant() = 'a1000000-0000-0000-0000-000000000001' and array_agg(name) = '{Home Lead}' as stale_switch_ignored from companies;
select count(*) = 0 as no_client_todo_after from tasks;
select not private.on_team('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002') as off_team;
select jsonb_array_length(public.my_accounts()) = 1 as switcher_back_to_one;
-- adding her again brings the access back (fresh, as a non admin)
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select public.account_member_add('a1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', false) is not null;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select private.current_tenant() = 'a1000000-0000-0000-0000-000000000002' and not private.is_admin() as re_added;
-- a member can't be pointed at their own home account
reset role;
do $$ begin insert into account_members (tenant_id, user_id) values ('a1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000006'); raise exception 'home row'; exception when others then if sqlerrm = 'home row' then raise; end if; end $$;
select 'members done' as done;
