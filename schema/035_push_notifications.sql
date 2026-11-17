-- 035: push notifications for team chat.
-- Each browser or installed app that turns on notifications saves a push subscription here. When a team chat message
-- comes in and the person isn't in the CRM, the chat-email function sends a push to their devices; people with no
-- working push get the email instead. Turning notifications off marks the subscription off (nothing is erased).
-- The push signing key (VAPID) lives in private.push_keys, readable only by the server. The private key is loaded
-- separately and never stored in this repository.

create table if not exists private.push_keys (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  subject text not null default 'mailto:chris@gelpstrategies.com',
  created_at timestamptz not null default now()
);
alter table private.push_keys enable row level security;
revoke all on private.push_keys from public, anon, authenticated;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id),
  tenant_id uuid not null references public.tenants(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  off_at timestamptz,
  off_reason text
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id) where off_at is null;
alter table public.push_subscriptions enable row level security;
create policy "own push subscriptions" on public.push_subscriptions for select using (user_id = auth.uid());
revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant select, update on public.push_subscriptions to service_role;

create or replace function public.push_public_key() returns text
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then (select public_key from private.push_keys where id = 1) end
$$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare u app_users%rowtype;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_endpoint !~ '^https://' or length(p_endpoint) > 1000 or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'That notification setup didn''t work'; end if;
  select * into u from app_users where id = auth.uid();
  insert into push_subscriptions (user_id, tenant_id, endpoint, p256dh, auth, user_agent)
  values (u.id, u.tenant_id, p_endpoint, p_p256dh, p_auth, left(p_ua, 300))
  on conflict (endpoint) do update set user_id = excluded.user_id, tenant_id = excluded.tenant_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, off_at = null, off_reason = null;
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language sql security definer set search_path = public, private as $$
  update push_subscriptions set off_at = now(), off_reason = 'turned off' where endpoint = p_endpoint and user_id = auth.uid() and off_at is null
$$;

-- server only: the signing key
create or replace function public.push_vapid() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('public_key', public_key, 'private_key', private_key, 'subject', subject) from private.push_keys where id = 1
$$;

revoke execute on function public.push_public_key(), public.push_subscribe(text, text, text, text), public.push_unsubscribe(text), public.push_vapid() from public, anon;
grant execute on function public.push_public_key(), public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) to authenticated;
revoke execute on function public.push_vapid() from authenticated;
grant execute on function public.push_vapid() to service_role;
