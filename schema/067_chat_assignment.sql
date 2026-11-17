-- 067: live chat assignment (decided Oct 29 night).
-- Each chat widget has its own assignment: one person, or round robin (even distribution or first available) over the people and
-- departments dragged onto it. Only customer facing people can be on a widget. Returning visitors go back to the same person when online.
-- No pickup within the wait (2 minutes default): the blast goes to the widget's departments (managers included), or the direct managers
-- of the widget's people; first to reply takes it. The visitor sees the "sorry for the wait" note. Escalate hands a chat off.

create table if not exists public.chat_widgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_-]{1,40}$'),
  name text not null check (length(trim(name)) between 1 and 80),
  is_default boolean not null default false,
  mode text not null default 'round_robin' check (mode in ('single', 'round_robin', 'none')),
  style text not null default 'even' check (style in ('even', 'first_available')),
  user_ids uuid[] not null default '{}',
  department_ids uuid[] not null default '{}',
  wait_seconds int not null default 120 check (wait_seconds between 15 and 3600),
  waiting_text text not null default 'Sorry for the wait, we''re having trouble reaching someone. Would you like to leave a message? We''ll get back to you by email.',
  offline_text text not null default 'Sorry, nobody''s here right now. Please leave a message and we''ll get back to you by email.',
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, key)
);
create unique index if not exists chat_widgets_one_default on public.chat_widgets (tenant_id) where is_default and archived_at is null;
alter table public.chat_widgets enable row level security;
create policy "see widgets" on public.chat_widgets for select using (tenant_id = private.current_tenant() and private.is_internal());
create policy "manage widgets" on public.chat_widgets for all using (tenant_id = private.current_tenant() and (private.is_admin() or private.can('inbox', 4)))
  with check (tenant_id = private.current_tenant() and (private.is_admin() or private.can('inbox', 4)));
revoke all on public.chat_widgets from anon, authenticated;
grant select, insert, update on public.chat_widgets to authenticated;
create trigger audit_chat_widgets after insert or update on public.chat_widgets for each row execute function private.audit();

alter table public.chat_threads add column if not exists widget_id uuid references public.chat_widgets(id);
alter table public.chat_threads add column if not exists assigned_to uuid references public.app_users(id);
alter table public.chat_threads add column if not exists assigned_at timestamptz;
alter table public.chat_threads add column if not exists blast_at timestamptz;
alter table public.chat_threads add column if not exists picked_up_at timestamptz;
alter table public.chat_threads add column if not exists person_id uuid references public.people(id) on delete set null;
create index if not exists chat_threads_waiting on public.chat_threads (assigned_at) where picked_up_at is null and status = 'open';

create or replace function private.online(p_user uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select active and last_seen_at > now() - interval '2 minutes' from app_users where id = p_user), false)
$$;

-- everyone who can take this widget's chats (customer facing, on the widget directly or through a department)
create or replace function private.widget_people(w chat_widgets) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce(array_agg(distinct u.id), '{}') from app_users u
   where u.tenant_id = w.tenant_id and u.active and private.is_customer_facing(u.id)
     and (u.id = any(w.user_ids) or u.id in (select user_id from department_members where department_id = any(w.department_ids)))
$$;

-- pick who gets a new chat
create or replace function private.chat_pick(th chat_threads, w chat_widgets) returns uuid
language plpgsql stable security definer set search_path = public, private as $$
declare pool uuid[]; v uuid;
begin
  -- returning visitor: same person as last time, if they're online and still customer facing
  select t.assigned_to into v from chat_threads t
   where t.tenant_id = th.tenant_id and t.id <> th.id and t.assigned_to is not null and lower(t.visitor_email) = lower(th.visitor_email)
   order by t.created_at desc limit 1;
  if v is not null and private.online(v) and private.is_customer_facing(v) then return v; end if;
  if w.id is null or w.mode = 'none' then return null; end if;
  pool := private.widget_people(w);
  if w.mode = 'single' then
    select x into v from unnest(w.user_ids) x where x = any(pool) and private.online(x) limit 1;
    return v;
  end if;
  -- round robin over who's online. Even: fewest open chats, then longest since their last one. First available: anyone with no open chat first.
  select u into v from unnest(pool) u
   where private.online(u)
   order by case when w.style = 'first_available' then (select count(*) > 0 from chat_threads t where t.assigned_to = u and t.status = 'open' and t.kind is distinct from 'team')::int else 0 end,
            (select count(*) from chat_threads t where t.assigned_to = u and t.status = 'open' and t.last_message_at > now() - interval '1 day'),
            (select max(assigned_at) from chat_threads t where t.assigned_to = u) nulls first
   limit 1;
  return v;
end $$;

create or replace function private.chat_assign(p_thread uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; w chat_widgets; v uuid;
begin
  select * into th from chat_threads where id = p_thread;
  if th.id is null or th.picked_up_at is not null then return; end if;
  if th.widget_id is not null then select * into w from chat_widgets where id = th.widget_id;
  else select * into w from chat_widgets where tenant_id = th.tenant_id and is_default and archived_at is null; end if;
  v := private.chat_pick(th, w);
  update chat_threads set widget_id = w.id, assigned_to = v, assigned_at = now() where id = th.id;
  if v is not null then
    insert into notifications (user_id, kind, title, body, link) values (v, 'chat', 'New chat for you: ' || coalesce(th.visitor_name, 'visitor'),
      coalesce(w.name, 'Website chat'), '#inbox/' || th.id);
  end if;
end $$;
revoke execute on function private.online(uuid), private.widget_people(chat_widgets), private.chat_pick(chat_threads, chat_widgets), private.chat_assign(uuid) from public, anon, authenticated;

-- new chats: link the contact, log it on the timeline, assign
create or replace function private.chat_new() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_person uuid;
begin
  if new.kind is not distinct from 'team' then return null; end if;
  select id into v_person from people where tenant_id = new.tenant_id and lower(personal_email) = lower(new.visitor_email) limit 1;
  if v_person is not null then update chat_threads set person_id = v_person where id = new.id; end if;
  perform private.emit(new.tenant_id, 'chat_started', 'Started a live chat', v_person, new.company_id, jsonb_build_object('thread_id', new.id, 'page', new.page_url));
  perform private.chat_assign(new.id);
  return null;
exception when others then return null;   -- assignment trouble never loses a chat
end $$;
revoke execute on function private.chat_new() from public, anon, authenticated;
create or replace trigger chat_new after insert on public.chat_threads for each row execute function private.chat_new();

-- first staff reply picks it up (after a blast, whoever answers first takes it)
create or replace function private.chat_pickup() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.sender = 'staff' and new.staff_id is not null then
    update chat_threads set assigned_to = case when blast_at is not null or assigned_to is null then new.staff_id else assigned_to end,
      picked_up_at = now()
     where id = new.thread_id and picked_up_at is null;
  end if;
  return null;
end $$;
revoke execute on function private.chat_pickup() from public, anon, authenticated;
create or replace trigger chat_pickup after insert on public.chat_messages for each row execute function private.chat_pickup();

-- the widget tells us which widget it is (data-widget="support"); reassigns if it differs from the default
create or replace function public.chat_widget_attach(p_thread uuid, p_key text, p_widget text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; w chat_widgets;
begin
  select * into th from chat_threads where id = p_thread and visitor_key = p_key;
  if not found then return null; end if;
  select * into w from chat_widgets where tenant_id = th.tenant_id and key = lower(trim(p_widget)) and archived_at is null;
  if found and th.widget_id is distinct from w.id and th.picked_up_at is null then
    update chat_threads set widget_id = w.id where id = th.id;
    perform private.chat_assign(th.id);
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.chat_widget_attach(uuid, text, text) from public;
grant execute on function public.chat_widget_attach(uuid, text, text) to anon, authenticated;

-- the visitor's side: still waiting after the blast? nobody here at all? which note to show
create or replace function public.chat_wait_state(p_thread uuid, p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare th chat_threads; w chat_widgets;
begin
  select * into th from chat_threads where id = p_thread and visitor_key = p_key;
  if not found then return null; end if;
  select * into w from chat_widgets where id = th.widget_id;
  return jsonb_build_object('waiting', th.blast_at is not null and th.picked_up_at is null, 'picked_up', th.picked_up_at is not null,
    'nobody', not exists (select 1 from app_users u where u.tenant_id = th.tenant_id and private.is_customer_facing(u.id) and private.online(u.id)),
    'waiting_text', coalesce(w.waiting_text, 'Sorry for the wait, we''re having trouble reaching someone. Would you like to leave a message? We''ll get back to you by email.'),
    'offline_text', coalesce(w.offline_text, 'Sorry, nobody''s here right now. Please leave a message and we''ll get back to you by email.'));
end $$;
revoke execute on function public.chat_wait_state(uuid, text) from public;
grant execute on function public.chat_wait_state(uuid, text) to anon, authenticated;

-- who gets the blast for a chat nobody picked up
create or replace function private.blast_people(th chat_threads, w chat_widgets) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  with grp as (
    -- the widget's departments: everyone customer facing in them, plus each department's manager
    select dm.user_id as uid from department_members dm where w.id is not null and dm.department_id = any(w.department_ids) and private.is_customer_facing(dm.user_id)
    union select d.manager_id from departments d where w.id is not null and d.id = any(w.department_ids) and d.manager_id is not null
    -- people put on the widget one by one: their direct managers
    union select au.manager_id from app_users au where w.id is not null and au.id = any(w.user_ids) and au.manager_id is not null
  ), grp2 as (select g.uid from grp g where g.uid is not null and g.uid is distinct from th.assigned_to),
  pick as (
    select g.uid from grp2 g
    union
    -- no widget setup, or nobody above: everyone customer facing on the account
    select cf.id from app_users cf where cf.tenant_id = th.tenant_id and private.is_customer_facing(cf.id) and cf.id is distinct from th.assigned_to
      and not exists (select 1 from grp2)
  )
  select coalesce(array_agg(distinct p.uid), '{}') from pick p join app_users a on a.id = p.uid and a.active and a.tenant_id = th.tenant_id and private.online(a.id)
$$;
revoke execute on function private.blast_people(chat_threads, chat_widgets) from public, anon, authenticated;

create or replace function private.chat_tick() returns int
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; w chat_widgets; who uuid[]; x uuid; n int := 0;
begin
  for th in select * from chat_threads where status = 'open' and picked_up_at is null and blast_at is null and kind is distinct from 'team'
             and assigned_at is not null and created_at > now() - interval '1 day' for update skip locked loop
    select * into w from chat_widgets where id = th.widget_id;
    if th.assigned_at > now() - make_interval(secs => coalesce(w.wait_seconds, 120)) then continue; end if;
    who := private.blast_people(th, w);
    foreach x in array who loop
      insert into notifications (user_id, kind, title, body, link) values (x, 'chat', 'Chat waiting: ' || coalesce(th.visitor_name, 'visitor') || ' needs someone',
        'Nobody has picked this up yet. First to reply takes it.', '#inbox/' || th.id);
    end loop;
    update chat_threads set blast_at = now() where id = th.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function private.chat_tick() from public, anon, authenticated;
do $$ begin perform cron.unschedule('chat-tick'); exception when others then null; end $$;
select cron.schedule('chat-tick', '30 seconds', $$select private.chat_tick()$$);

-- staff: take a chat, or hand it off (Escalate). Default target is my manager; anyone customer facing on the account works.
create or replace function public.chat_handoff(p_thread uuid, p_to uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; v uuid;
begin
  if not private.can('inbox', 2) then raise exception 'Not allowed'; end if;
  select * into th from chat_threads where id = p_thread and tenant_id = private.current_tenant();
  if not found then raise exception 'Chat not found'; end if;
  v := coalesce(p_to, (select manager_id from app_users where id = auth.uid()));
  if v is null then raise exception 'You don''t have a manager set. Pick who to hand it to.'; end if;
  if not exists (select 1 from app_users where id = v and tenant_id = th.tenant_id and active) or not (private.is_customer_facing(v) or exists (select 1 from app_users where id = v and is_admin))
    then raise exception 'They aren''t set up to take customer chats'; end if;
  update chat_threads set assigned_to = v, assigned_at = now(), picked_up_at = coalesce(picked_up_at, now()), blast_at = null where id = th.id;
  insert into notifications (user_id, kind, title, body, link) values (v, 'chat', 'Chat handed to you: ' || coalesce(th.visitor_name, 'visitor'),
    'From ' || (select full_name from app_users where id = auth.uid()), '#inbox/' || th.id);
  if th.person_id is not null or th.company_id is not null then
    perform private.emit(th.tenant_id, 'chat_handoff', 'Chat handed to ' || (select full_name from app_users where id = v), th.person_id, th.company_id, jsonb_build_object('thread_id', th.id));
  end if;
  return jsonb_build_object('ok', true, 'to', v, 'name', (select full_name from app_users where id = v));
end $$;
create or replace function public.chat_take(p_thread uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('inbox', 2) then raise exception 'Not allowed'; end if;
  update chat_threads set assigned_to = auth.uid(), assigned_at = now(), picked_up_at = coalesce(picked_up_at, now())
   where id = p_thread and tenant_id = private.current_tenant();
end $$;
revoke execute on function public.chat_handoff(uuid, uuid), public.chat_take(uuid) from public, anon;
grant execute on function public.chat_handoff(uuid, uuid), public.chat_take(uuid) to authenticated;

-- who can be put on widgets / handed chats (for the pickers)
create or replace function public.customer_facing_people() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'online', private.online(u.id), 'manager_id', u.manager_id) order by u.full_name), '[]'::jsonb)
  from app_users u where u.tenant_id = private.current_tenant() and u.active and private.is_internal() and (private.is_customer_facing(u.id) or u.is_admin)
$$;
revoke execute on function public.customer_facing_people() from public, anon;
grant execute on function public.customer_facing_people() to authenticated;
