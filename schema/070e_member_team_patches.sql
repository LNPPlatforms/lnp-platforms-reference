-- 070e: chats, chat widgets, team chat and automations count members as part of the account's team.
-- Each fix swaps one piece of the live function; it stops if the piece isn't there (so nothing changes silently).
-- Functions from before 059 aren't in the local test database; those are skipped there only.

create or replace function private.chat_online(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from app_users u where u.active and u.role not in ('vendor', 'member') and u.last_seen_at > now() - interval '2 minutes'
    and (u.tenant_id = p_tenant or exists (select 1 from account_members m where m.user_id = u.id and m.tenant_id = p_tenant and m.active)))
$$;

create or replace function private.team_check_people(p_users uuid[]) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if exists (select 1 from unnest(coalesce(p_users, '{}')) x where not private.on_team(x, private.current_tenant())) then
    raise exception 'Everyone in a chat has to be on this account''s team';
  end if;
end $$;

do $$
declare d text; b text; i int; old_only text[] := array['public.team_rooms_list()', 'public.team_profile_save(uuid,jsonb)'];
  fixes text[][] := array[
    array['private.widget_people(chat_widgets)',
      $q$where u.tenant_id = w.tenant_id and u.active and private.is_customer_facing(u.id)$q$,
      $q$where private.on_team(u.id, w.tenant_id) and private.cf_in(u.id, w.tenant_id)$q$],
    array['private.blast_people(chat_threads,chat_widgets)',
      $q$dm.department_id = any(w.department_ids) and private.is_customer_facing(dm.user_id)$q$,
      $q$dm.department_id = any(w.department_ids) and private.cf_in(dm.user_id, th.tenant_id)$q$],
    array['private.blast_people(chat_threads,chat_widgets)',
      $q$cf.tenant_id = th.tenant_id and private.is_customer_facing(cf.id)$q$,
      $q$private.on_team(cf.id, th.tenant_id) and private.cf_in(cf.id, th.tenant_id)$q$],
    array['private.blast_people(chat_threads,chat_widgets)',
      $q$a.active and a.tenant_id = th.tenant_id and private.online(a.id)$q$,
      $q$private.on_team(a.id, th.tenant_id) and private.online(a.id)$q$],
    array['private.chat_pick(chat_threads,chat_widgets)',
      $q$private.online(v) and private.is_customer_facing(v)$q$,
      $q$private.online(v) and private.cf_in(v, th.tenant_id)$q$],
    array['public.chat_wait_state(uuid,text)',
      $q$u.tenant_id = th.tenant_id and private.is_customer_facing(u.id)$q$,
      $q$private.on_team(u.id, th.tenant_id) and private.cf_in(u.id, th.tenant_id)$q$],
    array['public.customer_facing_people()',
      $q$u.tenant_id = private.current_tenant() and u.active and private.is_internal() and (private.is_customer_facing(u.id) or u.is_admin)$q$,
      $q$private.on_team(u.id, private.current_tenant()) and private.is_internal() and (private.cf_in(u.id, private.current_tenant()) or private.admin_in(u.id, private.current_tenant()))$q$],
    array['public.chat_handoff(uuid,uuid)',
      $q$not exists (select 1 from app_users where id = v and tenant_id = th.tenant_id and active) or not (private.is_customer_facing(v) or exists (select 1 from app_users where id = v and is_admin))$q$,
      $q$not private.on_team(v, th.tenant_id) or not (private.cf_in(v, th.tenant_id) or private.admin_in(v, th.tenant_id))$q$],
    array['private.run_step(automation_runs,jsonb,jsonb)',
      $q$select 1 from app_users where id = v_user and tenant_id = r.tenant_id and active$q$,
      $q$select 1 where private.on_team(v_user, r.tenant_id)$q$],
    array['public.team_rooms_list()',
      $q$from app_users u where u.tenant_id = t and u.active and u.role not in ('vendor', 'member') and not u.hidden_in_team$q$,
      $q$from app_users u where private.on_team(u.id, t) and not u.hidden_in_team$q$],
    -- your own profile is yours to edit from any account you're in
    array['public.team_profile_save(uuid,jsonb)',
      $q$where id = p_user and tenant_id = private.current_tenant() and role not in$q$,
      $q$where id = p_user and (tenant_id = private.current_tenant() or id = auth.uid()) and role not in$q$]];
begin
  for i in 1 .. array_length(fixes, 1) loop
    if to_regprocedure(fixes[i][1]) is null then
      if fixes[i][1] = any(old_only) and to_regclass('public.team_rooms') is null then continue; end if;
      raise exception 'member patch % (%) function missing', i, fixes[i][1];
    end if;
    d := replace(pg_get_functiondef(fixes[i][1]::regprocedure), E'\r\n', E'\n');
    if position(fixes[i][3] in d) > 0 then continue; end if;
    b := d; d := replace(d, fixes[i][2], fixes[i][3]);
    if d = b then raise exception 'member patch % (%) did not match', i, fixes[i][1]; end if;
    execute d;
  end loop;
end $$;
