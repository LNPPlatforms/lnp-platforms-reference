-- 034: team profiles and internal team chat.
-- Profiles: title, phone, birthday (month and day only), time zone and a short about line on each team login. The
-- whole team can see them; each person edits their own and admins can edit anyone's (team_profile_save).
-- Chat: one all-team room per account (everyone on the team is in it), direct messages between two people, and
-- groups anyone can start. Nothing is erased: people leave groups, messages stay. Members and vendors never see it.

alter table public.app_users add column if not exists title text;
alter table public.app_users add column if not exists phone text;
alter table public.app_users add column if not exists birthday_month smallint check (birthday_month between 1 and 12);
alter table public.app_users add column if not exists birthday_day smallint check (birthday_day between 1 and 31);
alter table public.app_users add column if not exists timezone text;
alter table public.app_users add column if not exists about text;

create or replace function public.team_profile_save(p_user uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare u app_users%rowtype; nm text; bm int; bd int;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into u from app_users where id = p_user and tenant_id = private.current_tenant() and role not in ('vendor', 'member');
  if not found then raise exception 'Team member not found'; end if;
  if p_user <> auth.uid() and not private.is_admin() then raise exception 'You can only edit your own profile'; end if;
  nm := regexp_replace(trim(coalesce(p->>'full_name', u.full_name)), '\s+', ' ', 'g');
  if nm = '' then raise exception 'Name can''t be blank'; end if;
  bm := nullif(p->>'birthday_month', '')::int; bd := nullif(p->>'birthday_day', '')::int;
  if (bm is null) <> (bd is null) then raise exception 'Pick both the month and the day for the birthday'; end if;
  if bm is not null and (bm not between 1 and 12 or bd < 1 or bd > extract(day from make_date(2000, bm, 1) + interval '1 month' - interval '1 day')) then
    raise exception 'That birthday isn''t a real date';
  end if;
  update app_users set
    full_name = left(nm, 120),
    title = left(nullif(trim(p->>'title'), ''), 120),
    phone = left(nullif(trim(p->>'phone'), ''), 40),
    birthday_month = bm, birthday_day = bd,
    timezone = left(nullif(trim(p->>'timezone'), ''), 60),
    about = left(nullif(trim(p->>'about'), ''), 500)
  where id = p_user;
end $$;
revoke execute on function public.team_profile_save(uuid, jsonb) from public, anon;
grant execute on function public.team_profile_save(uuid, jsonb) to authenticated;

-- ============================================================ chat
create table if not exists public.team_rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  kind text not null check (kind in ('team', 'dm', 'group')),
  name text,
  dm_key text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  last_message_at timestamptz
);
create unique index if not exists team_rooms_one_team on public.team_rooms (tenant_id) where kind = 'team';
create unique index if not exists team_rooms_dm on public.team_rooms (tenant_id, dm_key) where kind = 'dm';

create table if not exists public.team_room_members (
  room_id uuid not null references public.team_rooms(id),
  user_id uuid not null references public.app_users(id),
  added_by uuid references public.app_users(id),
  added_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_at timestamptz,
  notified_at timestamptz,
  primary key (room_id, user_id)
);
create index if not exists team_room_members_user on public.team_room_members (user_id);

create table if not exists public.team_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  room_id uuid not null references public.team_rooms(id),
  sender_id uuid not null references public.app_users(id),
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists team_messages_room on public.team_messages (room_id, created_at);

-- can the signed-in person see this room? Team room: anyone on the account's team. Direct and group: current members.
create or replace function private.team_can_see(p_room uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and exists (
    select 1 from team_rooms r where r.id = p_room and r.tenant_id = private.current_tenant()
      and (r.kind = 'team' or exists (select 1 from team_room_members m where m.room_id = r.id and m.user_id = auth.uid() and m.left_at is null)))
$$;
grant execute on function private.team_can_see(uuid) to authenticated;

alter table public.team_rooms enable row level security;
alter table public.team_room_members enable row level security;
alter table public.team_messages enable row level security;
create policy "team sees its rooms" on public.team_rooms for select using (private.team_can_see(id));
create policy "team sees room members" on public.team_room_members for select using (private.team_can_see(room_id));
create policy "team sees room messages" on public.team_messages for select using (private.team_can_see(room_id));
revoke all on public.team_rooms, public.team_room_members, public.team_messages from anon, authenticated;
grant select on public.team_rooms, public.team_room_members, public.team_messages to authenticated;
grant select, update on public.team_rooms, public.team_room_members, public.team_messages to service_role;
create trigger audit_team_rooms after insert or update of name on public.team_rooms for each row execute function private.audit();

create or replace function private.team_room_for_account() returns uuid
language plpgsql security definer set search_path = public, private as $$
declare r uuid; t uuid := private.current_tenant();
begin
  select id into r from team_rooms where tenant_id = t and kind = 'team';
  if r is null then
    insert into team_rooms (tenant_id, kind, name) values (t, 'team', 'Whole team') on conflict do nothing;
    select id into r from team_rooms where tenant_id = t and kind = 'team';
  end if;
  return r;
end $$;
revoke execute on function private.team_room_for_account() from public, anon, authenticated;

create or replace function private.team_check_people(p_users uuid[]) returns void
language plpgsql stable security definer set search_path = public, private as $$
begin
  if exists (select 1 from unnest(coalesce(p_users, '{}')) x where not exists (
      select 1 from app_users u where u.id = x and u.tenant_id = private.current_tenant() and u.active and u.role not in ('vendor', 'member'))) then
    raise exception 'Everyone in a chat has to be on this account''s team';
  end if;
end $$;
revoke execute on function private.team_check_people(uuid[]) from public, anon, authenticated;

-- the chat list: rooms you're in, newest first, with unread counts and a preview
create or replace function public.team_rooms_list() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); t uuid := private.current_tenant(); out jsonb;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  perform private.team_room_for_account();
  select coalesce(jsonb_agg(x order by (x->>'kind') = 'team' desc, x->>'last_message_at' desc nulls last), '[]'::jsonb) into out from (
    select jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'created_by', r.created_by, 'last_message_at', r.last_message_at,
      'name', case when r.kind = 'dm' then (select u.full_name from team_room_members m join app_users u on u.id = m.user_id where m.room_id = r.id and m.user_id <> me limit 1) else r.name end,
      'other_id', case when r.kind = 'dm' then (select m.user_id from team_room_members m where m.room_id = r.id and m.user_id <> me limit 1) end,
      'members', case when r.kind = 'team' then (select jsonb_agg(u.id) from app_users u where u.tenant_id = t and u.active and u.role not in ('vendor', 'member'))
                      else (select jsonb_agg(m.user_id) from team_room_members m where m.room_id = r.id and m.left_at is null) end,
      'preview', (select jsonb_build_object('body', left(tm.body, 120), 'sender_id', tm.sender_id) from team_messages tm where tm.room_id = r.id order by tm.created_at desc limit 1),
      'unread', (select count(*) from team_messages tm where tm.room_id = r.id and tm.sender_id <> me
                   and tm.created_at > coalesce((select m.last_read_at from team_room_members m where m.room_id = r.id and m.user_id = me),
                                                (select u.created_at from app_users u where u.id = me)))
    ) x
    from team_rooms r where r.tenant_id = t and private.team_can_see(r.id)) s;
  return out;
end $$;

create or replace function public.team_unread() returns int
language sql stable security definer set search_path = public, private as $$
  select case when not private.is_internal() then 0 else (
    select count(*)::int from team_messages tm join team_rooms r on r.id = tm.room_id
     where r.tenant_id = private.current_tenant() and private.team_can_see(r.id) and tm.sender_id <> auth.uid()
       and tm.created_at > coalesce((select m.last_read_at from team_room_members m where m.room_id = r.id and m.user_id = auth.uid()),
                                    (select u.created_at from app_users u where u.id = auth.uid()))) end
$$;

create or replace function public.team_dm_open(p_user uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); t uuid := private.current_tenant(); k text; r uuid;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_user = me then raise exception 'Pick someone else to message'; end if;
  perform private.team_check_people(array[p_user]);
  k := least(me::text, p_user::text) || ':' || greatest(me::text, p_user::text);
  select id into r from team_rooms where tenant_id = t and kind = 'dm' and dm_key = k;
  if r is null then
    insert into team_rooms (tenant_id, kind, dm_key, created_by) values (t, 'dm', k, me) on conflict do nothing;
    select id into r from team_rooms where tenant_id = t and kind = 'dm' and dm_key = k;
    insert into team_room_members (room_id, user_id, added_by) values (r, me, me), (r, p_user, me) on conflict do nothing;
  end if;
  return r;
end $$;

create or replace function public.team_group_create(p_name text, p_members uuid[]) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); r uuid; nm text := left(nullif(trim(p_name), ''), 80);
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if nm is null then raise exception 'Give the group a name'; end if;
  perform private.team_check_people(p_members);
  insert into team_rooms (tenant_id, kind, name, created_by) values (private.current_tenant(), 'group', nm, me) returning id into r;
  insert into team_room_members (room_id, user_id, added_by)
  select r, x, me from (select me x union select unnest(coalesce(p_members, '{}'))) s on conflict do nothing;
  return r;
end $$;

-- add people (any member), remove people (whoever started the group, or an admin), leave (yourself), rename (starter or admin)
create or replace function public.team_group_edit(p_room uuid, p_name text default null, p_add uuid[] default null, p_remove uuid[] default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); g team_rooms%rowtype; boss boolean;
begin
  select * into g from team_rooms where id = p_room and kind = 'group' and tenant_id = private.current_tenant();
  if not found or not private.team_can_see(p_room) then raise exception 'Group not found'; end if;
  boss := g.created_by = me or private.is_admin();
  if nullif(trim(p_name), '') is not null and trim(p_name) is distinct from g.name then
    if not boss then raise exception 'Only whoever started the group, or an admin, can rename it'; end if;
    update team_rooms set name = left(trim(p_name), 80) where id = p_room;
  end if;
  if p_add is not null then
    perform private.team_check_people(p_add);
    insert into team_room_members (room_id, user_id, added_by) select p_room, x, me from unnest(p_add) x
    on conflict (room_id, user_id) do update set left_at = null, added_by = excluded.added_by, added_at = now()
      where team_room_members.left_at is not null;
  end if;
  if p_remove is not null then
    if not boss and exists (select 1 from unnest(p_remove) x where x <> me) then raise exception 'Only whoever started the group, or an admin, can remove other people'; end if;
    update team_room_members set left_at = now() where room_id = p_room and user_id = any (p_remove) and left_at is null;
  end if;
end $$;

create or replace function public.team_send(p_room uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); b text := trim(coalesce(p_body, '')); m team_messages%rowtype; t uuid;
begin
  if not private.team_can_see(p_room) then raise exception 'Conversation not found'; end if;
  if b = '' then raise exception 'Type a message first'; end if;
  if length(b) > 4000 then raise exception 'That message is too long'; end if;
  select tenant_id into t from team_rooms where id = p_room;
  insert into team_messages (tenant_id, room_id, sender_id, body) values (t, p_room, me, b) returning * into m;
  update team_rooms set last_message_at = m.created_at where id = p_room;
  insert into team_room_members (room_id, user_id, added_by, last_read_at) values (p_room, me, me, m.created_at)
  on conflict (room_id, user_id) do update set last_read_at = excluded.last_read_at;
  return to_jsonb(m);
end $$;

create or replace function public.team_mark_read(p_room uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.team_can_see(p_room) then return; end if;
  insert into team_room_members (room_id, user_id, added_by, last_read_at) values (p_room, auth.uid(), auth.uid(), now())
  on conflict (room_id, user_id) do update set last_read_at = now();
end $$;

revoke execute on function public.team_rooms_list(), public.team_unread(), public.team_dm_open(uuid), public.team_group_create(text, uuid[]),
  public.team_group_edit(uuid, text, uuid[], uuid[]), public.team_send(uuid, text), public.team_mark_read(uuid) from public, anon;
grant execute on function public.team_rooms_list(), public.team_unread(), public.team_dm_open(uuid), public.team_group_create(text, uuid[]),
  public.team_group_edit(uuid, text, uuid[], uuid[]), public.team_send(uuid, text), public.team_mark_read(uuid) to authenticated;
grant insert on public.team_room_members to service_role;
