-- 014: hosted sites, change requests, account manager / developer, My Day notifications (Oct 16, 2026).
-- Every client account (tenant) sees the sites and funnels GELP hosts for it under Sites: link, status, domain.
-- "Request a change" opens a development request: a conversation in the agency's (GELP's) Inbox, tagged with the site
-- and the client account. The client's assigned account manager and developer get a My Day notification. If the
-- assigned developer hasn't replied within one business day, every developer is notified and the account manager
-- gets a heads up. Clients follow the request and reply from their Sites page; replies also reach them by email.
-- Only platform admins (admins of the GELP account) add sites, set their status and assign account managers and developers.

alter table public.app_users add column if not exists is_developer boolean not null default false;
alter table public.tenants add column if not exists agency_tenant_id uuid references public.tenants(id) default private.default_tenant();
alter table public.tenants add column if not exists account_manager_id uuid references public.app_users(id);
alter table public.tenants add column if not exists developer_id uuid references public.app_users(id);

create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select is_admin and tenant_id = private.default_tenant() from app_users where id = auth.uid() and active and role <> 'vendor'), false)
$$;

create policy "platform admins read accounts" on public.tenants for select using (private.is_platform_admin());
create policy "platform admins assign accounts" on public.tenants for update using (private.is_platform_admin()) with check (private.is_platform_admin());
grant update (account_manager_id, developer_id) on public.tenants to authenticated;

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 120),
  kind text not null default 'site' check (kind in ('site','funnel')),
  url text,
  domain text,
  status text not null default 'in_build' check (status in ('planned','in_build','review','live','paused')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sites_tenant on public.sites (tenant_id);
alter table public.sites enable row level security;
create policy "account reads own sites" on public.sites for select using ((private.is_internal() and tenant_id = private.current_tenant()) or private.is_platform_admin());
create policy "platform admins manage sites" on public.sites for all using (private.is_platform_admin()) with check (private.is_platform_admin());
grant select, insert, update on public.sites to authenticated;

alter table public.chat_threads add column if not exists kind text not null default 'chat' check (kind in ('chat','dev_request'));
alter table public.chat_threads add column if not exists site_id uuid references public.sites(id) on delete set null;
alter table public.chat_threads add column if not exists client_tenant_id uuid references public.tenants(id);
alter table public.chat_threads add column if not exists requested_by uuid references public.app_users(id);
alter table public.chat_threads add column if not exists dev_responded_at timestamptz;
alter table public.chat_threads add column if not exists escalated_at timestamptz;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists notifications_user on public.notifications (user_id, done_at, created_at desc);
alter table public.notifications enable row level security;
create policy "own notifications" on public.notifications for select using (user_id = auth.uid());
create policy "clear own notifications" on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, update (done_at) on public.notifications to authenticated;

create or replace function private.notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = public, private as $$
  insert into notifications (user_id, kind, title, body, link) select p_user, p_kind, p_title, left(p_body, 500), p_link where p_user is not null
$$;

-- one business day later (Central time; Saturday and Sunday don't count)
create or replace function private.plus_business_day(p_ts timestamptz) returns timestamptz
language plpgsql immutable set search_path = pg_catalog as $$
declare t timestamp := (p_ts at time zone 'America/Chicago') + interval '1 day';
begin
  while extract(isodow from t) in (6, 7) loop t := t + interval '1 day'; end loop;
  return t at time zone 'America/Chicago';
end $$;

-- client: request a change to one of their sites
create or replace function public.site_request(p_site uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare s sites; t tenants; me app_users; th uuid; title text; d record;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into s from sites where id = p_site;
  if not found or (s.tenant_id <> private.current_tenant() and not private.is_platform_admin()) then raise exception 'Site not found'; end if;
  if length(coalesce(trim(p_body), '')) < 3 then raise exception 'Describe the change you need'; end if;
  select * into t from tenants where id = s.tenant_id;
  select * into me from app_users where id = auth.uid();
  insert into chat_threads (tenant_id, visitor_key, visitor_name, visitor_email, source, source_ref, kind, site_id, client_tenant_id, requested_by, visitor_seen_at)
  values (coalesce(t.agency_tenant_id, private.default_tenant()), replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          me.full_name || ' (' || t.name || ')', me.email, 'other', s.id::text, 'dev_request', s.id, t.id, me.id, null)
  returning id into th;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (coalesce(t.agency_tenant_id, private.default_tenant()), th, 'visitor', trim(p_body));
  title := 'Dev request: ' || s.name || ' (' || t.name || ')';
  perform private.notify(t.developer_id, 'dev_request', title, trim(p_body), '#inbox/' || th);
  if t.account_manager_id is distinct from t.developer_id then perform private.notify(t.account_manager_id, 'dev_request', title, trim(p_body), '#inbox/' || th); end if;
  if t.developer_id is null then   -- nobody assigned yet: every developer hears about it
    for d in select id from app_users where is_developer and active and tenant_id = coalesce(t.agency_tenant_id, private.default_tenant()) loop
      perform private.notify(d.id, 'dev_request', title, trim(p_body), '#inbox/' || th);
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'thread', th);
end $$;

-- client: their account's requests with the conversation
create or replace function public.site_requests() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then coalesce((select jsonb_agg(jsonb_build_object(
      'id', th.id, 'site', s.name, 'site_id', th.site_id, 'status', th.status, 'at', th.created_at, 'last', th.last_message_at,
      'by', (select full_name from app_users where id = th.requested_by),
      'messages', (select jsonb_agg(jsonb_build_object('from', m.sender, 'body', m.body, 'at', m.created_at,
          'name', case when m.sender = 'staff' then (select split_part(full_name, ' ', 1) from app_users where id = m.staff_id) end) order by m.created_at)
        from chat_messages m where m.thread_id = th.id)) order by th.last_message_at desc)
    from chat_threads th left join sites s on s.id = th.site_id
   where th.kind = 'dev_request' and th.client_tenant_id = private.current_tenant()), '[]'::jsonb) end
$$;

-- client: reply on one of their requests
create or replace function public.site_request_reply(p_thread uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into th from chat_threads where id = p_thread and kind = 'dev_request' and client_tenant_id = private.current_tenant();
  if not found then raise exception 'Request not found'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;
  insert into chat_messages (tenant_id, thread_id, sender, body) values (th.tenant_id, th.id, 'visitor', trim(p_body));
  update chat_threads set last_message_at = now(), unread_staff = true, status = 'open' where id = th.id;
  return jsonb_build_object('ok', true);
end $$;

-- one business day without a reply from the assigned developer: tell every developer and the account manager
create or replace function private.escalate_dev_requests() returns void
language plpgsql security definer set search_path = public, private as $$
declare r record; d record; title text;
begin
  for r in select th.id, th.tenant_id, s.name site, t.name client, t.developer_id, t.account_manager_id
             from chat_threads th join tenants t on t.id = th.client_tenant_id left join sites s on s.id = th.site_id
            where th.kind = 'dev_request' and th.status = 'open' and th.dev_responded_at is null and th.escalated_at is null
              and t.developer_id is not null and private.plus_business_day(th.created_at) <= now()
            for update of th skip locked loop
    title := 'Escalated dev request: ' || coalesce(r.site, 'site') || ' (' || r.client || ')';
    for d in select id from app_users where is_developer and active and tenant_id = r.tenant_id and id <> r.developer_id loop
      perform private.notify(d.id, 'dev_escalated', title, 'The assigned developer hasn''t replied in one business day. Can you pick it up?', '#inbox/' || r.id);
    end loop;
    perform private.notify(r.account_manager_id, 'dev_escalated', title, 'No reply from the assigned developer in one business day, so it went to every developer. You may want to update the client.', '#inbox/' || r.id);
    update chat_threads set escalated_at = now() where id = r.id;
  end loop;
end $$;

revoke execute on function private.notify(uuid, text, text, text, text), private.escalate_dev_requests(), private.is_platform_admin() from public, anon;
grant execute on function private.is_platform_admin() to authenticated;
revoke execute on function public.site_request(uuid, text), public.site_requests(), public.site_request_reply(uuid, text) from public, anon;
grant execute on function public.site_request(uuid, text), public.site_requests(), public.site_request_reply(uuid, text) to authenticated;

-- a developer replying counts as the response; the heartbeat runs the escalation check and counts My Day notifications
do $$
declare d text; b text;
begin
  d := replace(pg_get_functiondef('public.chat_reply(uuid,text)'::regprocedure), E'\r\n', E'\n');
  if position('dev_responded_at' in d) = 0 then
    b := d;
    d := replace(d, $q$  update chat_threads set last_message_at = now(), unread_staff = false, status = 'open' where id = th.id;$q$,
      $q$  update chat_threads set last_message_at = now(), unread_staff = false, status = 'open',
    dev_responded_at = case when th.kind = 'dev_request' and th.dev_responded_at is null
      and (auth.uid() = (select developer_id from tenants where id = th.client_tenant_id) or (select is_developer from app_users where id = auth.uid()))
      then now() else th.dev_responded_at end
   where id = th.id;$q$);
    if d = b then raise exception 'chat_reply patch did not match'; end if;
    execute d;
  end if;
  d := replace(pg_get_functiondef('public.chat_heartbeat()'::regprocedure), E'\r\n', E'\n');
  if position('escalate_dev_requests' in d) = 0 then
    b := d;
    d := replace(d, $q$  update app_users set last_seen_at = now() where id = auth.uid();
  return jsonb_build_object('ok', true, 'unread', (select count(*) from chat_threads where tenant_id = private.current_tenant() and unread_staff and status = 'open'));$q$,
      $q$  update app_users set last_seen_at = now() where id = auth.uid();
  perform private.escalate_dev_requests();
  return jsonb_build_object('ok', true, 'unread', (select count(*) from chat_threads where tenant_id = private.current_tenant() and unread_staff and status = 'open'),
    'notes', (select count(*) from notifications where user_id = auth.uid() and done_at is null));$q$);
    if d = b then raise exception 'chat_heartbeat patch did not match'; end if;
    execute d;
  end if;
end $$;
