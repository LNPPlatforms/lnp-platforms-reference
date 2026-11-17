-- 100: notify people about a note. A note can @mention teammates or pick them from a Notify list; each of them gets a
-- notification in the CRM (Review / My Day) and, right away, by the way they chose in their profile:
--   push  = a notification on their devices, or an email if no device has them turned on (the default)
--   email = always an email
--   both  = push and email
--   app   = only inside the CRM
-- The same choice is what urgent alerts (routes, phone usage) use later.
alter table public.app_users add column if not exists notify_via text not null default 'push';
do $$ begin
  alter table public.app_users add constraint app_users_notify_via check (notify_via in ('push', 'email', 'both', 'app'));
exception when duplicate_object then null; end $$;

-- a notification marked deliver = true also goes out right away (push and/or email) through the chat-email function
alter table public.notifications add column if not exists deliver boolean not null default false;
alter table public.notifications add column if not exists from_user uuid references public.app_users(id) on delete set null;
alter table public.notifications add column if not exists tenant_id uuid references public.tenants(id) on delete cascade;
alter table public.notifications add column if not exists delivered_at timestamptz;

-- people on this account who can be notified: active staff of the account, plus members added from other accounts
create or replace function private.notifiable(p_tenant uuid) returns setof uuid
language sql stable security definer set search_path = public, private as $$
  select id from app_users where tenant_id = p_tenant and active and (role is null or role not in ('vendor', 'member')) and forward_to is null
  union
  select m.user_id from account_members m join app_users u on u.id = m.user_id and u.active where m.tenant_id = p_tenant and m.active
$$;
revoke execute on function private.notifiable(uuid) from public, anon, authenticated;

-- the note box: same as before, plus the people to notify (from @mentions and the Notify list together)
drop function if exists public.timeline_note(uuid, uuid, text);
create or replace function public.timeline_note(p_person uuid, p_company uuid, p_body text, p_notify uuid[] default null) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); v_id uuid; who uuid[]; nm text; me text; lnk text;
begin
  if not private.can('contacts', 2) then raise exception 'Not allowed'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a note'; end if;
  if p_person is not null and not exists (select 1 from people where id = p_person and tenant_id = t) then raise exception 'Not found'; end if;
  if p_company is not null and not exists (select 1 from companies where id = p_company and tenant_id = t) then raise exception 'Not found'; end if;
  -- only teammates on this account, never yourself, each once
  select coalesce(array_agg(distinct x), '{}') into who from unnest(coalesce(p_notify, '{}')) x
   where x <> auth.uid() and x in (select private.notifiable(t));
  v_id := private.emit(t, 'note', left(trim(p_body), 300), p_person, p_company,
    jsonb_build_object('body', trim(p_body)) || case when cardinality(who) > 0 then jsonb_build_object('notified', to_jsonb(who)) else '{}'::jsonb end);
  if cardinality(who) > 0 then
    select full_name into me from app_users where id = auth.uid();
    if p_company is not null then
      select name, '#org/' || id into nm, lnk from companies where id = p_company;
    else
      select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '#people/' || id into nm, lnk from people where id = p_person;
    end if;
    insert into notifications (user_id, kind, title, body, link, deliver, from_user, tenant_id)
    select x, 'note', coalesce(me, 'Someone') || ' notified you on ' || coalesce(nullif(nm, ''), 'a record'), left(trim(p_body), 500), lnk, true, auth.uid(), t
      from unnest(who) x;
  end if;
  return v_id;
end $$;
revoke execute on function public.timeline_note(uuid, uuid, text, uuid[]) from public, anon;
grant execute on function public.timeline_note(uuid, uuid, text, uuid[]) to authenticated;

-- each person picks how notifications reach them
create or replace function public.my_notify_via_set(p_via text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if p_via not in ('push', 'email', 'both', 'app') then raise exception 'Pick push, email, both or app'; end if;
  update app_users set notify_via = p_via where id = auth.uid();
end $$;
revoke execute on function public.my_notify_via_set(text) from public, anon;
grant execute on function public.my_notify_via_set(text) to authenticated;

-- a notification to deliver tells chat-email right away (same secret hook as team chat)
create or replace function private.notification_hook() returns trigger
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  if not new.deliver then return null; end if;
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return null; end if;
  perform net.http_post(
    url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/chat-email',
    body := jsonb_build_object('kind', 'notify_hook', 'notification_id', new.id, 'secret', s),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000);
  return null;
exception when others then return null;   -- a delivery problem never blocks saving the note
end $$;
revoke execute on function private.notification_hook() from public, anon, authenticated;
create or replace trigger notification_hook after insert on public.notifications for each row execute function private.notification_hook();
