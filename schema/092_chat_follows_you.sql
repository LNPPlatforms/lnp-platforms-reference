-- 092: Internal chat follows you across accounts (Chris, Nov 11, 2026). Agency people spend most of their time inside client
-- accounts, so a message in their home account (or any account they're on the team of) still shows, with its unread count,
-- wherever they're working. Rooms from another account are labeled with it: "Whole team: GELP", "Julie Olivari (GELP)".
-- Seeing a room = it's in the account you're in (as before) or you're on that account's team (home or added as a member).
set check_function_bodies = off;  -- test databases without the chat tables

create or replace function private.team_can_see(p_room uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and exists (
    select 1 from team_rooms r where r.id = p_room
      and (r.tenant_id = private.current_tenant() or private.on_team(auth.uid(), r.tenant_id))
      and ((r.kind = 'team' and not coalesce((select hidden_in_team from app_users where id = auth.uid()), false))
        or (r.kind <> 'team' and exists (select 1 from team_room_members m where m.room_id = r.id and m.user_id = auth.uid() and m.left_at is null))))
$$;

-- what to call an account in a chat label: its brand's short name for an agency (GELP), otherwise the account name
create or replace function private.chat_account_label(t uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select coalesce(case when x.is_agency then nullif(trim(private.brand_of(x.id)->>'short_name'), '') end, x.name) from tenants x where x.id = t
$$;

create or replace function public.team_rooms_list() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); t uuid := private.current_tenant(); out jsonb;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  perform private.team_room_for_account();
  select coalesce(jsonb_agg(x order by (x->>'here')::boolean and (x->>'kind') = 'team' desc, x->>'last_message_at' desc nulls last), '[]'::jsonb) into out from (
    select jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'created_by', r.created_by, 'last_message_at', r.last_message_at, 'tenant_id', r.tenant_id,
      'here', r.tenant_id = t, 'account', case when r.tenant_id <> t then private.chat_account_label(r.tenant_id) end,
      'name', case when r.kind = 'dm' then (select u.full_name from team_room_members m join app_users u on u.id = m.user_id where m.room_id = r.id and m.user_id <> me limit 1) else r.name end,
      'people', (select jsonb_object_agg(u.id, u.full_name) from app_users u where u.id in (select m.user_id from team_room_members m where m.room_id = r.id)
                   or (r.kind = 'team' and r.tenant_id <> t and private.on_team(u.id, r.tenant_id))),
      'other_id', case when r.kind = 'dm' then (select m.user_id from team_room_members m where m.room_id = r.id and m.user_id <> me limit 1) end,
      'members', case when r.kind = 'team' then (select jsonb_agg(u.id) from app_users u where private.on_team(u.id, r.tenant_id) and not u.hidden_in_team)
                      else (select jsonb_agg(m.user_id) from team_room_members m where m.room_id = r.id and m.left_at is null) end,
      'preview', (select jsonb_build_object('body', left(tm.body, 120), 'sender_id', tm.sender_id) from team_messages tm where tm.room_id = r.id order by tm.created_at desc limit 1),
      'unread', (select count(*) from team_messages tm where tm.room_id = r.id and tm.sender_id <> me and tm.recalled_at is null
                   and tm.created_at > coalesce((select m.last_read_at from team_room_members m where m.room_id = r.id and m.user_id = me),
                                                (select u.created_at from app_users u where u.id = me)))
    ) x
    from team_rooms r
   where (r.tenant_id = t or private.on_team(me, r.tenant_id)) and private.team_can_see(r.id)
     -- another account's whole-team room only once it has something in it
     and (r.tenant_id = t or r.kind <> 'team' or r.last_message_at is not null)) s;
  return out;
end $$;

create or replace function public.team_unread() returns integer
language sql stable security definer set search_path = public, private as $$
  select case when not private.is_internal() then 0 else (
    select count(*)::int from team_messages tm join team_rooms r on r.id = tm.room_id
     where (r.tenant_id = private.current_tenant() or private.on_team(auth.uid(), r.tenant_id)) and private.team_can_see(r.id)
       and tm.sender_id <> auth.uid() and tm.recalled_at is null
       and tm.created_at > coalesce((select m.last_read_at from team_room_members m where m.room_id = r.id and m.user_id = auth.uid()),
                                    (select u.created_at from app_users u where u.id = auth.uid()))) end
$$;

-- online dots for everyone you can chat with: this account's people plus the teams you're on
create or replace function public.team_presence() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'last_seen_at', u.last_seen_at, 'online', private.online(u.id))), '[]'::jsonb)
    from app_users u
   where private.is_internal() and u.active
     and (u.tenant_id = private.current_tenant()
       or u.id in (select m.user_id from account_members m where m.active and m.tenant_id = private.current_tenant())
       or exists (select 1 from tenants x where private.on_team(auth.uid(), x.id) and private.on_team(u.id, x.id)))
$$;

-- pictures go in the folder of the room's own account, not the account you happen to be in
do $$ begin
  if to_regclass('storage.objects') is null or to_regclass('public.team_rooms') is null then return; end if;
  execute $p$drop policy if exists "team chat pictures upload" on storage.objects$p$;
  execute $p$create policy "team chat pictures upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-chat'
    and (storage.foldername(name))[3] = auth.uid()::text
    and private.team_can_see(nullif((storage.foldername(name))[2], '')::uuid)
    and (storage.foldername(name))[1] = (select r.tenant_id::text from public.team_rooms r where r.id = nullif((storage.foldername(name))[2], '')::uuid))$p$;
end $$;
