-- 041: logins that stay out of the team (like System Admin, Claude's login). A hidden login isn't in the whole-team
-- chat room and doesn't show in the team list or group pickers. Anything sent to it in chat notifies its forward_to
-- person instead (Chris), so nobody gets the same message twice.
alter table public.app_users add column if not exists hidden_in_team boolean not null default false;
alter table public.app_users add column if not exists forward_to uuid references public.app_users(id);
update public.app_users set hidden_in_team = true, forward_to = 'a4643b4e-012b-4b1a-9aac-ac35002048b2'
 where id = '365e73a5-434c-4719-9b68-23ea43de7a37';

create or replace function private.team_can_see(p_room uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and exists (
    select 1 from team_rooms r where r.id = p_room and r.tenant_id = private.current_tenant()
      and ((r.kind = 'team' and not coalesce((select hidden_in_team from app_users where id = auth.uid()), false))
        or (r.kind <> 'team' and exists (select 1 from team_room_members m where m.room_id = r.id and m.user_id = auth.uid() and m.left_at is null))))
$$;

-- the whole-team member list leaves hidden logins out
do $$ declare d text := pg_get_functiondef('public.team_rooms_list()'::regprocedure); n text;
begin
  n := replace(d, $q$(select jsonb_agg(u.id) from app_users u where u.tenant_id = t and u.active and u.role not in ('vendor', 'member'))$q$,
                  $q$(select jsonb_agg(u.id) from app_users u where u.tenant_id = t and u.active and u.role not in ('vendor', 'member') and not u.hidden_in_team)$q$);
  if n = d then raise exception 'team_rooms_list did not match'; end if;
  execute n;
end $$;
