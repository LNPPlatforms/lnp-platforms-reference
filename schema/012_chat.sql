-- 012: chat (Oct 16, 2026).
-- A chat widget for websites, proposal pages and invoices. Conversations land in the CRM Inbox for the account
-- (tenant) the widget belongs to. "Agent online" when anyone on that account has the CRM open (heartbeat in the
-- last 2 minutes); otherwise "Agent offline" and the message goes to the team by email. Staff replies show live in
-- the widget if the visitor is still there, or go to their email if not (chat-email edge function).
-- Visitors never sign in: each conversation has a secret key kept in the visitor's browser.

alter table public.app_users add column if not exists last_seen_at timestamptz;

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  visitor_key text not null,
  visitor_name text,
  visitor_email text,
  company_id uuid references public.companies(id) on delete set null,
  source text not null default 'website' check (source in ('website','proposal','invoice','other')),
  source_ref text,                 -- proposal share token, invoice number, etc.
  page_url text,
  ip text,
  status text not null default 'open' check (status in ('open','closed')),
  unread_staff boolean not null default true,
  visitor_seen_at timestamptz,
  last_message_at timestamptz not null default now(),
  team_notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists chat_threads_tenant on public.chat_threads (tenant_id, last_message_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender text not null check (sender in ('visitor','staff','system')),
  staff_id uuid references public.app_users(id),
  body text not null check (length(body) between 1 and 4000),
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_thread on public.chat_messages (thread_id, created_at);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
drop policy if exists "team reads own chats" on public.chat_threads;
create policy "team reads own chats" on public.chat_threads for select using (private.is_internal() and tenant_id = private.current_tenant());
drop policy if exists "team updates own chats" on public.chat_threads;
create policy "team updates own chats" on public.chat_threads for update using (private.is_internal() and tenant_id = private.current_tenant())
  with check (private.is_internal() and tenant_id = private.current_tenant());
drop policy if exists "team reads own chat messages" on public.chat_messages;
create policy "team reads own chat messages" on public.chat_messages for select using (private.is_internal() and tenant_id = private.current_tenant());
revoke all on public.chat_threads, public.chat_messages from anon, authenticated;
grant select, update (status, unread_staff, company_id) on public.chat_threads to authenticated;
grant select on public.chat_messages to authenticated;
grant select, update on public.chat_threads to service_role;
grant select, update on public.chat_messages to service_role;
grant select on public.tenants to service_role;

-- is anyone on this account in the CRM right now?
create or replace function private.chat_online(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from app_users where tenant_id = p_tenant and active and role <> 'vendor' and last_seen_at > now() - interval '2 minutes')
$$;

-- CRM heartbeat (every minute while the CRM is open)
create or replace function public.chat_heartbeat() returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_internal() then return jsonb_build_object('ok', false); end if;
  update app_users set last_seen_at = now() where id = auth.uid();
  return jsonb_build_object('ok', true, 'unread', (select count(*) from chat_threads where tenant_id = private.current_tenant() and unread_staff and status = 'open'));
end $$;

-- widget: online status and the account's display name
create or replace function public.chat_status(p_tenant text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', t.name, 'online', private.chat_online(t.id)) from tenants t where t.slug = lower(trim(p_tenant))
$$;

-- widget: start a conversation
create or replace function public.chat_start(p_tenant text, p_name text, p_email text, p_body text, p_source text, p_ref text, p_page text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t tenants; th chat_threads; hdr json; v_ip text; co uuid; key text;
begin
  select * into t from tenants where slug = lower(trim(p_tenant));
  if not found then raise exception 'Chat is not set up for this site'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  if length(coalesce(trim(p_name), '')) < 2 then raise exception 'Add your name'; end if;
  if coalesce(trim(p_email), '') !~ '^\S+@\S+\.\S+$' then raise exception 'Add an email so we can reply'; end if;
  hdr := nullif(current_setting('request.headers', true), '')::json;
  v_ip := nullif(trim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'x-real-ip', ''), ',', 1)), '');
  if v_ip is not null and (select count(*) from chat_threads c where c.ip = v_ip and c.created_at > now() - interval '1 hour') >= 5
    then raise exception 'Too many new conversations. Please try again later.'; end if;
  -- a proposal chat belongs to that proposal's organization
  if p_source = 'proposal' and length(coalesce(p_ref, '')) >= 32 then
    select company_id into co from proposals where share_token = p_ref and tenant_id = t.id;
  end if;
  key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into chat_threads (tenant_id, visitor_key, visitor_name, visitor_email, company_id, source, source_ref, page_url, ip, visitor_seen_at)
  values (t.id, key, left(trim(p_name), 120), lower(left(trim(p_email), 200)), co,
          case when p_source in ('website','proposal','invoice') then p_source else 'other' end,
          left(p_ref, 200), left(p_page, 500), v_ip, now())
  returning * into th;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (t.id, th.id, 'visitor', trim(p_body));
  return jsonb_build_object('thread', th.id, 'key', key, 'online', private.chat_online(t.id));
end $$;

-- widget: send another message
create or replace function public.chat_send(p_thread uuid, p_key text, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads;
begin
  select * into th from chat_threads where id = p_thread and visitor_key = p_key;
  if not found then raise exception 'Conversation not found'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  if (select count(*) from chat_messages where thread_id = th.id and sender = 'visitor' and created_at > now() - interval '1 minute') >= 10
    then raise exception 'Slow down a little and try again in a minute.'; end if;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (th.tenant_id, th.id, 'visitor', trim(p_body));
  update chat_threads set last_message_at = now(), unread_staff = true, status = 'open', visitor_seen_at = now() where id = th.id;
  return jsonb_build_object('ok', true, 'online', private.chat_online(th.tenant_id));
end $$;

-- widget: read the conversation (also marks the visitor as still here)
create or replace function public.chat_fetch(p_thread uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads;
begin
  select * into th from chat_threads where id = p_thread and visitor_key = p_key;
  if not found then return null; end if;
  update chat_threads set visitor_seen_at = now() where id = th.id;
  return jsonb_build_object('online', private.chat_online(th.tenant_id), 'status', th.status,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'from', m.sender, 'body', m.body, 'at', m.created_at,
        'name', case when m.sender = 'staff' then split_part(coalesce(u.full_name, ''), ' ', 1) end) order by m.created_at)
      from chat_messages m left join app_users u on u.id = m.staff_id where m.thread_id = th.id), '[]'::jsonb));
end $$;

-- CRM: reply to a conversation
create or replace function public.chat_reply(p_thread uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; mid uuid;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into th from chat_threads where id = p_thread and tenant_id = private.current_tenant();
  if not found then raise exception 'Conversation not found'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a reply'; end if;
  insert into chat_messages (tenant_id, thread_id, sender, staff_id, body) values (th.tenant_id, th.id, 'staff', auth.uid(), trim(p_body)) returning id into mid;
  update chat_threads set last_message_at = now(), unread_staff = false, status = 'open' where id = th.id;
  update app_users set last_seen_at = now() where id = auth.uid();
  return jsonb_build_object('ok', true, 'message', mid, 'visitor_here', th.visitor_seen_at > now() - interval '45 seconds');
end $$;

revoke execute on function private.chat_online(uuid) from public, anon, authenticated;
revoke execute on function public.chat_heartbeat(), public.chat_reply(uuid, text) from public, anon;
grant execute on function public.chat_heartbeat(), public.chat_reply(uuid, text) to authenticated;
revoke execute on function public.chat_status(text), public.chat_start(text, text, text, text, text, text, text),
  public.chat_send(uuid, text, text), public.chat_fetch(uuid, text) from public;
grant execute on function public.chat_status(text), public.chat_start(text, text, text, text, text, text, text),
  public.chat_send(uuid, text, text), public.chat_fetch(uuid, text) to anon, authenticated;

-- (Oct 16) proposal_view also returns 'account' (the tenant slug) so the proposal page loads that account's chat.
do $$
declare d text := replace(pg_get_functiondef('public.proposal_view(text,jsonb)'::regprocedure), E'\r\n', E'\n'); b text;
begin
  if position('''account''' in d) > 0 then return; end if;
  b := d;
  d := replace(d, $q$'org', c.name, 'logo', logo,$q$, $q$'org', c.name, 'account', (select slug from tenants where id = p.tenant_id), 'logo', logo,$q$);
  if d = b then raise exception 'no match'; end if;
  execute d;
end $$;
