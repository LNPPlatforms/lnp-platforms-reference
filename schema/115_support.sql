-- 115: Support in the chat box, and alerts for every ticket, suggestion and error report (Nov 16, 2026).
-- Support: someone in an account asks for help from the chat box's Support tab (help search first, then a chat they
--   mark Urgent or Routine). A client account's request goes to its agency's Inbox; an agency's own people go to the
--   platform (LNP). It's a chat thread like a dev request (kind 'support'), so the support team answers from Inbox and
--   the person sees the replies in their Support tab (and by email when they've left).
-- Alerts: the platform's alert person (a platform setting, Chris by default) gets an urgent notification by push and
--   email for every support request, suggestion and automatic error report. The same error from the same place within
--   a day is counted on the first report ("20 times") instead of making a new one.

-- ---------- the alert person ----------
create table if not exists private.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now(), updated_by uuid);
revoke all on private.platform_settings from public, anon, authenticated;

create or replace function private.alert_user() returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (value #>> '{}')::uuid from private.platform_settings where key = 'alert_user'), 'a4643b4e-012b-4b1a-9aac-ac35002048b2'::uuid)
$$;

create or replace function public.platform_alert_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_platform_admin() then jsonb_build_object('user_id', private.alert_user(), 'name', (select full_name from app_users where id = private.alert_user())) end
$$;
create or replace function public.platform_alert_set(p_user uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_admin() then raise exception 'Platform admins only'; end if;
  if not exists (select 1 from app_users where id = p_user and active) then raise exception 'Pick someone with an active login'; end if;
  insert into private.platform_settings (key, value, updated_at, updated_by) values ('alert_user', to_jsonb(p_user::text), now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
end $$;

-- how one notification goes out can be fixed by what it is (alerts go by push AND email whatever the person picked)
alter table public.notifications add column if not exists via_override text check (via_override is null or via_override in ('push', 'email', 'both'));

create or replace function private.alert(p_kind text, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = public, private as $$
  insert into notifications (user_id, kind, title, body, link, deliver, tenant_id, via_override)
  select private.alert_user(), p_kind, left(p_title, 200), left(p_body, 500), p_link, true, private.platform_tenant(), 'both'
$$;
revoke execute on function private.alert_user(), private.alert(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.platform_alert_get(), public.platform_alert_set(uuid) from public, anon;
grant execute on function public.platform_alert_get(), public.platform_alert_set(uuid) to authenticated;

-- ---------- suggestions and error reports: group repeats, alert ----------
alter table public.suggestions add column if not exists times int not null default 1;
alter table public.suggestions add column if not exists last_at timestamptz;

create or replace function private.suggestion_group() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare k text; hit uuid;
begin
  if new.body not like '⚠ Automatic problem report%' then return new; end if;
  k := split_part(new.body, E'\n', 2);   -- They saw: "..."
  select id into hit from suggestions
   where body like '⚠ Automatic problem report%' and split_part(body, E'\n', 2) = k and coalesce(view, '') = coalesce(new.view, '')
     and created_at > now() - interval '1 day' and status is distinct from 'resolved'
   order by created_at limit 1;
  if hit is null then return new; end if;
  update suggestions set times = times + 1, last_at = now() where id = hit;
  return null;   -- counted on the first one
end $$;
drop trigger if exists zz_group_errors on public.suggestions;
create trigger zz_group_errors before insert on public.suggestions for each row execute function private.suggestion_group();

create or replace function private.suggestion_alert() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare err boolean := new.body like '⚠ Automatic problem report%';
begin
  perform private.alert(case when err then 'error_report' else 'suggestion' end,
    case when err then 'Error report: ' else 'Suggestion: ' end || coalesce(new.account_name, 'an account') || coalesce(' · ' || new.user_name, ''),
    case when err then split_part(new.body, E'\n', 2) else new.body end, '#review');
  return null;
end $$;
drop trigger if exists zz_alert_suggestion on public.suggestions;
create trigger zz_alert_suggestion after insert on public.suggestions for each row execute function private.suggestion_alert();
revoke execute on function private.suggestion_group(), private.suggestion_alert() from public, anon, authenticated;

-- ---------- support requests ----------
alter table public.chat_threads drop constraint if exists chat_threads_kind_check;
alter table public.chat_threads add constraint chat_threads_kind_check check (kind in ('chat', 'dev_request', 'support'));
alter table public.chat_threads add column if not exists priority text check (priority is null or priority in ('urgent', 'routine'));

-- where this account's support requests go: a client account to its agency, an agency (or the platform) to the platform
create or replace function private.support_home(t uuid) returns uuid
language sql stable security definer set search_path = public, private as $$
  select case when x.is_agency or x.agency_tenant_id is null or x.id = private.platform_tenant() then private.platform_tenant() else x.agency_tenant_id end
    from tenants x where x.id = t
$$;
revoke execute on function private.support_home(uuid) from public, anon, authenticated;

create or replace function public.support_open(p_body text, p_priority text default 'routine', p_search text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); home uuid; me app_users; acct text; th uuid; b text := trim(coalesce(p_body, '')); pr text := case when p_priority = 'urgent' then 'urgent' else 'routine' end;
  a record;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if length(b) < 3 then raise exception 'Tell us what you need help with'; end if;
  home := private.support_home(t);
  select * into me from app_users where id = auth.uid();
  select name into acct from tenants where id = t;
  insert into chat_threads (tenant_id, visitor_key, visitor_name, visitor_email, source, source_ref, kind, client_tenant_id, requested_by, priority, visitor_seen_at, unread_staff, status, last_message_at)
  values (home, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), me.full_name || ' (' || acct || ')', me.email, 'other',
          left(nullif(trim(coalesce(p_search, '')), ''), 200), 'support', t, me.id, pr, null, true, 'open', now())
  returning id into th;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (home, th, 'visitor', left(b, 4000));
  -- the support team in the Inbox it landed in (admins there), plus the platform's alert person by push and email
  for a in select u.id from app_users u where u.active and u.is_admin and private.on_team(u.id, home) and u.id <> private.alert_user() loop
    perform private.notify(a.id, 'support', (case when pr = 'urgent' then 'URGENT support: ' else 'Support: ' end) || acct, b, '#inbox/' || th);
  end loop;
  perform private.alert('support', (case when pr = 'urgent' then 'URGENT support: ' else 'Support: ' end) || acct || ' · ' || coalesce(me.full_name, ''), b, '#inbox/' || th);
  return jsonb_build_object('ok', true, 'thread', th);
end $$;

-- this account's support requests with the conversation (newest first), and whether support is online now
create or replace function public.support_mine() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then jsonb_build_object(
    'online', exists (select 1 from app_users u where u.active and u.is_admin and private.on_team(u.id, private.support_home(private.current_tenant()))
                        and u.last_seen_at > now() - interval '5 minutes' and u.id <> auth.uid()),
    'threads', coalesce((select jsonb_agg(jsonb_build_object(
      'id', th.id, 'status', th.status, 'priority', th.priority, 'at', th.created_at, 'last', th.last_message_at,
      'by', (select full_name from app_users where id = th.requested_by),
      'messages', (select jsonb_agg(jsonb_build_object('from', m.sender, 'body', m.body, 'at', m.created_at,
          'name', case when m.sender = 'staff' then (select split_part(full_name, ' ', 1) from app_users where id = m.staff_id) end) order by m.created_at)
        from chat_messages m where m.thread_id = th.id)) order by th.last_message_at desc)
    from chat_threads th where th.kind = 'support' and th.client_tenant_id = private.current_tenant() and th.created_at > now() - interval '90 days'), '[]'::jsonb)) end
$$;

create or replace function public.support_reply(p_thread uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; acct text;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into th from chat_threads where id = p_thread and kind = 'support' and client_tenant_id = private.current_tenant();
  if not found then raise exception 'Request not found'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (th.tenant_id, th.id, 'visitor', left(trim(p_body), 4000));
  update chat_threads set last_message_at = now(), unread_staff = true, status = 'open' where id = th.id;
  select name into acct from tenants where id = th.client_tenant_id;
  perform private.alert('support', 'Support reply: ' || coalesce(acct, ''), trim(p_body), '#inbox/' || th.id);
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.support_open(text, text, text), public.support_mine(), public.support_reply(uuid, text) from public, anon;
grant execute on function public.support_open(text, text, text), public.support_mine(), public.support_reply(uuid, text) to authenticated;
