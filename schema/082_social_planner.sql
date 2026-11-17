-- 082: social planner (Tools > Marketing > Social planner). Connected pages and profiles, posts with pictures or video from
-- the media library, scheduling, batches, an optional approval step and the publishing queue.
-- Facebook Pages and Instagram business accounts publish through Meta's Graph API (edge functions social-connect and
-- social-publish). LinkedIn and Google Business Profile have room in the tables and get added when their apps are approved.
-- Permissions ride the existing Marketing area: 1 sees the planner, 2 makes and schedules their own posts,
-- 3 changes anyone's posts and approves, 4 (or admin) connects and removes accounts and changes the planner settings.
-- Switch: Settings > Features > Social planner (on by default). Runner: pg_cron every minute.

-- ---------- who can do what ----------
create or replace function private.social_lvl(l int) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('social') and (private.is_admin() or private.can('marketing', l))
$$;
revoke execute on function private.social_lvl(int) from public, anon;
grant execute on function private.social_lvl(int) to authenticated;

-- ---------- connected accounts ----------
create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  network text not null check (network in ('facebook', 'instagram', 'linkedin', 'google', 'tiktok', 'x')),
  external_id text not null,                 -- the page, profile or location id on that network
  name text not null check (length(name) between 1 and 200),
  handle text,                               -- @username where the network has one
  picture_url text,
  parent_external_id text,                   -- Instagram: the Facebook Page it hangs off
  status text not null default 'ok' check (status in ('ok', 'reconnect')),
  status_note text,
  meta_user_id text,                         -- the Facebook person who connected it (for Meta's deauthorize and deletion callbacks)
  connected_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
create unique index if not exists social_accounts_one on public.social_accounts (tenant_id, network, external_id) where removed_at is null;
alter table public.social_accounts enable row level security;
drop policy if exists "team sees social accounts" on public.social_accounts;
create policy "team sees social accounts" on public.social_accounts for select
  using (tenant_id = private.current_tenant() and removed_at is null and private.social_lvl(1));
revoke all on public.social_accounts from anon, authenticated;
grant select (id, tenant_id, network, external_id, name, handle, picture_url, parent_external_id, status, status_note, connected_by, created_at, updated_at, removed_at)
  on public.social_accounts to authenticated;

-- tokens never leave the database except to the publishing function
create table if not exists private.social_tokens (
  account_id uuid primary key references public.social_accounts(id) on delete cascade,
  access_token text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
revoke all on private.social_tokens from public, anon, authenticated;

-- a connect in progress (15 minutes)
create table if not exists private.social_oauth (
  state text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  network text not null,
  return_to text not null,
  created_at timestamptz not null default now()
);
revoke all on private.social_oauth from public, anon, authenticated;

-- ---------- posts ----------
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  body text not null default '' check (length(body) <= 63206),
  media jsonb not null default '[]'::jsonb,  -- [{url, kind: image|video, title, mime}]
  link text check (link is null or link ~* '^https?://'),
  account_ids uuid[] not null default '{}',
  scheduled_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'pending', 'scheduled', 'publishing', 'posted', 'partial', 'failed')),
  batch_id uuid,
  batch_name text,
  note text check (note is null or length(note) <= 2000),   -- team only
  created_by uuid default auth.uid(),
  approved_by uuid,
  approved_at timestamptz,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists social_posts_when on public.social_posts (tenant_id, scheduled_at) where deleted_at is null;
alter table public.social_posts enable row level security;
drop policy if exists "team sees social posts" on public.social_posts;
create policy "team sees social posts" on public.social_posts for select
  using (tenant_id = private.current_tenant() and deleted_at is null and private.social_lvl(1));
revoke all on public.social_posts from anon, authenticated;
grant select on public.social_posts to authenticated;

-- one row per post per account: where each copy stands
create table if not exists public.social_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  post_id uuid not null references public.social_posts(id) on delete cascade,
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'sending', 'processing', 'posted', 'failed', 'cancelled')),
  container_id text,                          -- Instagram: the media container while video finishes processing
  external_id text,
  permalink text,
  error text,
  attempts int not null default 0,
  next_try_at timestamptz,
  posted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (post_id, account_id)
);
create index if not exists social_targets_due on public.social_targets (status, next_try_at) where status in ('waiting', 'processing', 'sending');
alter table public.social_targets enable row level security;
drop policy if exists "team sees social targets" on public.social_targets;
create policy "team sees social targets" on public.social_targets for select
  using (tenant_id = private.current_tenant() and private.social_lvl(1));
revoke all on public.social_targets from anon, authenticated;
grant select on public.social_targets to authenticated;

-- ---------- settings ----------
create or replace function public.social_settings() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.social_lvl(1) then
    jsonb_build_object('require_approval', false, 'default_time', '10:00')
      || coalesce((select settings->'social' from account_settings where tenant_id = private.current_tenant()), '{}'::jsonb)
      || jsonb_build_object('can_post', private.social_lvl(2), 'can_manage', private.social_lvl(3), 'can_connect', private.social_lvl(4))
  end
$$;
create or replace function public.social_settings_save(p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare v jsonb;
begin
  if not private.social_lvl(4) then raise exception 'Your role can''t change the social planner settings'; end if;
  if coalesce(p->>'default_time', '10:00') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Pick a default time like 10:00'; end if;
  v := jsonb_build_object('require_approval', coalesce((p->>'require_approval')::boolean, false), 'default_time', coalesce(p->>'default_time', '10:00'));
  insert into account_settings (tenant_id, settings, updated_at, updated_by) values (private.current_tenant(), jsonb_build_object('social', v), now(), auth.uid())
  on conflict (tenant_id) do update set settings = jsonb_set(coalesce(account_settings.settings, '{}'::jsonb), '{social}', v), updated_at = now(), updated_by = auth.uid();
end $$;

-- ---------- a post's overall status from its copies ----------
create or replace function private.social_roll(p_post uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare n int; posted int; failed int; open_ int;
begin
  select count(*) filter (where status <> 'cancelled'), count(*) filter (where status = 'posted'), count(*) filter (where status = 'failed'),
         count(*) filter (where status in ('waiting', 'sending', 'processing'))
    into n, posted, failed, open_ from social_targets where post_id = p_post;
  if open_ > 0 or n = 0 then return; end if;
  update social_posts set status = case when posted = n then 'posted' when posted > 0 then 'partial' else 'failed' end,
         posted_at = case when posted > 0 then coalesce(posted_at, now()) end, updated_at = now()
   where id = p_post and status in ('scheduled', 'publishing');
end $$;
revoke execute on function private.social_roll(uuid) from public, anon, authenticated;

-- ---------- save a post (new or edit) ----------
-- p: {id?, body, media[], link, account_ids[], mode: draft|schedule|now, scheduled_at, note, batch_id, batch_name}
create or replace function public.social_post_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid; old social_posts; v_mode text := coalesce(p->>'mode', 'draft');
  v_accts uuid[]; v_media jsonb := coalesce(p->'media', '[]'::jsonb); v_when timestamptz; v_status text;
  v_body text := coalesce(p->>'body', ''); v_imgs int; v_vids int; v_link text := nullif(trim(coalesce(p->>'link', '')), '');
  a record; approve boolean;
begin
  if not private.social_lvl(2) then raise exception 'Your role can''t make social posts'; end if;
  if v_mode not in ('draft', 'schedule', 'now') then raise exception 'Unknown save mode'; end if;
  if v_id is not null then
    select * into old from social_posts where id = v_id and tenant_id = private.current_tenant() and deleted_at is null for update;
    if old.id is null then raise exception 'That post is gone'; end if;
    if old.created_by is distinct from auth.uid() and not private.social_lvl(3) then raise exception 'You can only change your own posts'; end if;
    if old.status in ('publishing', 'posted', 'partial') then raise exception 'This post already went out. Duplicate it to post again.'; end if;
  end if;
  if jsonb_typeof(v_media) <> 'array' or jsonb_array_length(v_media) > 10 then raise exception 'Up to 10 pictures or videos per post'; end if;
  if exists (select 1 from jsonb_array_elements(v_media) m where coalesce(m->>'url', '') !~* '^https://' or coalesce(m->>'kind', '') not in ('image', 'video')) then
    raise exception 'Each picture or video needs a link from the media library'; end if;
  select count(*) filter (where m->>'kind' = 'image'), count(*) filter (where m->>'kind' = 'video') into v_imgs, v_vids from jsonb_array_elements(v_media) m;
  if v_vids > 1 or (v_vids = 1 and v_imgs > 0) then raise exception 'A post can have one video, or pictures, not both'; end if;
  if v_link is not null and v_link !~* '^https?://' then raise exception 'The link has to start with http:// or https://'; end if;

  select coalesce(array_agg(distinct x::uuid), '{}') into v_accts from jsonb_array_elements_text(coalesce(p->'account_ids', '[]'::jsonb)) x;
  if exists (select 1 from unnest(v_accts) x where not exists (select 1 from social_accounts s where s.id = x and s.tenant_id = private.current_tenant() and s.removed_at is null)) then
    raise exception 'One of those accounts isn''t connected anymore'; end if;

  if v_mode <> 'draft' then
    if cardinality(v_accts) = 0 then raise exception 'Pick at least one account to post to'; end if;
    if trim(v_body) = '' and jsonb_array_length(v_media) = 0 then raise exception 'Write something or add a picture'; end if;
    for a in select network, name from social_accounts where id = any(v_accts) loop
      if a.network = 'instagram' then
        if jsonb_array_length(v_media) = 0 then raise exception 'Instagram needs a picture or video (%)', a.name; end if;
        if length(v_body) > 2200 then raise exception 'Instagram captions top out at 2,200 characters (%)', a.name; end if;
        if (select count(*) from regexp_matches(v_body, '#[[:alnum:]_]+', 'g')) > 30 then raise exception 'Instagram allows up to 30 hashtags (%)', a.name; end if;
      elsif a.network not in ('facebook') then raise exception '% posting isn''t switched on yet', initcap(a.network);
      end if;
    end loop;
    v_when := case when v_mode = 'now' then now() else nullif(p->>'scheduled_at', '')::timestamptz end;
    if v_when is null then raise exception 'Pick a date and time'; end if;
    if v_mode = 'schedule' and v_when < now() - interval '5 minutes' then raise exception 'That time already passed'; end if;
    if v_when > now() + interval '400 days' then raise exception 'Schedule within about a year'; end if;
    approve := coalesce((select (settings->'social'->>'require_approval')::boolean from account_settings where tenant_id = private.current_tenant()), false)
               and not private.social_lvl(3);
    v_status := case when approve then 'pending' else 'scheduled' end;
  else
    v_when := nullif(p->>'scheduled_at', '')::timestamptz; v_status := 'draft';
  end if;

  if v_id is null then
    insert into social_posts (tenant_id, body, media, link, account_ids, scheduled_at, status, note, batch_id, batch_name, approved_by, approved_at)
    values (private.current_tenant(), v_body, v_media, v_link, v_accts, v_when, v_status, nullif(trim(coalesce(p->>'note', '')), ''),
            nullif(p->>'batch_id', '')::uuid, nullif(trim(coalesce(p->>'batch_name', '')), ''),
            case when v_status = 'scheduled' then auth.uid() end, case when v_status = 'scheduled' then now() end)
    returning id into v_id;
  else
    update social_posts set body = v_body, media = v_media, link = v_link, account_ids = v_accts, scheduled_at = v_when, status = v_status,
           note = nullif(trim(coalesce(p->>'note', '')), ''), updated_at = now(),
           approved_by = case when v_status = 'scheduled' then auth.uid() end, approved_at = case when v_status = 'scheduled' then now() end
     where id = v_id;
    delete from social_targets where post_id = v_id;
  end if;
  if v_status = 'scheduled' then
    insert into social_targets (tenant_id, post_id, account_id) select private.current_tenant(), v_id, x from unnest(v_accts) x;
  end if;
  return v_id;
end $$;

-- many posts at once. p: {name, posts: [{body, media, link, account_ids, scheduled_at}], mode: schedule|draft}
create or replace function public.social_batch_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_batch uuid := gen_random_uuid(); r jsonb; i int := 0; v_mode text := coalesce(p->>'mode', 'schedule');
begin
  if not private.social_lvl(2) then raise exception 'Your role can''t make social posts'; end if;
  if jsonb_typeof(p->'posts') <> 'array' or jsonb_array_length(p->'posts') = 0 then raise exception 'Nothing to add'; end if;
  if jsonb_array_length(p->'posts') > 200 then raise exception 'Up to 200 posts per batch'; end if;
  for r in select * from jsonb_array_elements(p->'posts') loop
    i := i + 1;
    begin
      perform public.social_post_save((r - 'id') || jsonb_build_object('mode', v_mode, 'batch_id', v_batch, 'batch_name', coalesce(nullif(trim(p->>'name'), ''), 'Batch ' || to_char(now(), 'Mon DD'))));
    exception when others then raise exception 'Row %: %', i, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('batch_id', v_batch, 'count', i);
end $$;

create or replace function public.social_post_approve(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare o social_posts;
begin
  if not private.social_lvl(3) then raise exception 'Your role can''t approve posts'; end if;
  select * into o from social_posts where id = p_id and tenant_id = private.current_tenant() and deleted_at is null and status = 'pending' for update;
  if o.id is null then raise exception 'That post isn''t waiting for approval'; end if;
  update social_posts set status = 'scheduled', approved_by = auth.uid(), approved_at = now(), updated_at = now(),
         scheduled_at = greatest(scheduled_at, now()) where id = p_id;
  insert into social_targets (tenant_id, post_id, account_id) select o.tenant_id, o.id, x from unnest(o.account_ids) x
    where exists (select 1 from social_accounts s where s.id = x and s.removed_at is null) on conflict do nothing;
end $$;

-- back to a draft (unschedule, or send back from approval)
create or replace function public.social_post_unschedule(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare o social_posts;
begin
  select * into o from social_posts where id = p_id and tenant_id = private.current_tenant() and deleted_at is null for update;
  if o.id is null or not private.social_lvl(2) or (o.created_by is distinct from auth.uid() and not private.social_lvl(3)) then raise exception 'Not allowed'; end if;
  if o.status not in ('scheduled', 'pending', 'failed') then raise exception 'Only scheduled, waiting or failed posts go back to drafts'; end if;
  delete from social_targets where post_id = p_id and status in ('waiting', 'failed', 'cancelled');
  if exists (select 1 from social_targets where post_id = p_id) then raise exception 'Part of this post is going out right now'; end if;
  update social_posts set status = 'draft', approved_by = null, approved_at = null, updated_at = now() where id = p_id;
end $$;

-- out of the planner (doesn't delete anything already on Facebook or Instagram)
create or replace function public.social_post_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare o social_posts;
begin
  select * into o from social_posts where id = p_id and tenant_id = private.current_tenant() and deleted_at is null for update;
  if o.id is null or not private.social_lvl(2) or (o.created_by is distinct from auth.uid() and not private.social_lvl(3)) then raise exception 'Not allowed'; end if;
  if o.status = 'publishing' then raise exception 'This post is going out right now. Try again in a minute.'; end if;
  update social_targets set status = 'cancelled', updated_at = now() where post_id = p_id and status = 'waiting';
  update social_posts set deleted_at = now(), updated_at = now() where id = p_id;
end $$;

-- try the failed copies again
create or replace function public.social_post_retry(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare o social_posts;
begin
  select * into o from social_posts where id = p_id and tenant_id = private.current_tenant() and deleted_at is null for update;
  if o.id is null or not private.social_lvl(2) or (o.created_by is distinct from auth.uid() and not private.social_lvl(3)) then raise exception 'Not allowed'; end if;
  if o.status not in ('failed', 'partial') then raise exception 'Nothing failed on this post'; end if;
  update social_targets t set status = 'waiting', error = null, attempts = 0, next_try_at = null, container_id = null, updated_at = now()
   where t.post_id = p_id and t.status = 'failed' and exists (select 1 from social_accounts s where s.id = t.account_id and s.removed_at is null);
  update social_posts set status = 'scheduled', scheduled_at = least(scheduled_at, now()), updated_at = now() where id = p_id;
end $$;

-- the planner's list: posts in a date range (drafts with no date come along) with their copies
create or replace function public.social_posts_list(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.social_lvl(1) then coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'body', p.body, 'media', p.media, 'link', p.link, 'account_ids', p.account_ids, 'scheduled_at', p.scheduled_at,
      'status', p.status, 'batch_id', p.batch_id, 'batch_name', p.batch_name, 'note', p.note, 'created_by', p.created_by,
      'by', (select full_name from app_users where id = p.created_by), 'mine', p.created_by = auth.uid(), 'posted_at', p.posted_at,
      'approved_by', (select full_name from app_users where id = p.approved_by), 'created_at', p.created_at,
      'targets', coalesce((select jsonb_agg(jsonb_build_object('account_id', t.account_id, 'status', t.status, 'permalink', t.permalink, 'error', t.error,
          'posted_at', t.posted_at, 'attempts', t.attempts)) from social_targets t where t.post_id = p.id), '[]'::jsonb))
      order by p.scheduled_at nulls first, p.created_at), '[]'::jsonb) end
  from social_posts p
  where p.tenant_id = private.current_tenant() and p.deleted_at is null
    and (p.scheduled_at is null or p.scheduled_at between p_from and p_to or p.status in ('pending', 'failed'))
$$;

-- remove a connected account
create or replace function public.social_account_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.social_lvl(4) then raise exception 'Your role can''t remove connected accounts'; end if;
  update social_accounts set removed_at = now(), updated_at = now() where id = p_id and tenant_id = private.current_tenant() and removed_at is null;
  if not found then raise exception 'That account isn''t connected'; end if;
  delete from private.social_tokens where account_id = p_id;
  update social_targets set status = 'cancelled', error = 'The account was removed', updated_at = now() where account_id = p_id and status = 'waiting';
end $$;

-- ---------- connecting (called by social-connect) ----------
-- the signed in person starts a connect; returns the state for the OAuth link. return_to has to be one of the platform's own app addresses.
create or replace function public.social_oauth_begin(p_network text, p_return text) returns text
language plpgsql security definer set search_path = public, private as $$
declare v_state text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); host text := substring(coalesce(p_return, '') from '^https://([a-z0-9.-]+)(?::\d+)?(?:/|$)');
begin
  if not private.social_lvl(4) then raise exception 'Your role can''t connect accounts'; end if;
  if p_network not in ('meta') then raise exception 'That network isn''t available yet'; end if;
  if host is null or not (host in (select domain from white_labels where domain is not null) or host in ('app.lnpplatforms.com', 'lnp-platforms.pages.dev') or host like '%.lnp-platforms.pages.dev') then
    raise exception 'Connect from the app''s own address'; end if;
  delete from private.social_oauth where created_at < now() - interval '15 minutes';
  insert into private.social_oauth (state, tenant_id, user_id, network, return_to) values (v_state, private.current_tenant(), auth.uid(), p_network, p_return);
  return v_state;
end $$;
revoke execute on function public.social_oauth_begin(text, text) from public, anon;
grant execute on function public.social_oauth_begin(text, text) to authenticated;

create or replace function public.social_oauth_take(p_state text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare o private.social_oauth;
begin
  delete from private.social_oauth where state = p_state returning * into o;
  if o.state is null or o.created_at < now() - interval '15 minutes' then return null; end if;
  return jsonb_build_object('tenant_id', o.tenant_id, 'user_id', o.user_id, 'network', o.network, 'return_to', o.return_to);
end $$;

-- store what came back: items [{network, external_id, name, handle, picture_url, parent_external_id, token, expires_at}]
create or replace function public.social_accounts_store(p_tenant uuid, p_user uuid, p_meta_user text, p_items jsonb) returns int
language plpgsql security definer set search_path = public, private as $$
declare it jsonb; v_id uuid; n int := 0;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce(it->>'network', '') not in ('facebook', 'instagram') or coalesce(it->>'external_id', '') = '' or coalesce(it->>'token', '') = '' then continue; end if;
    select id into v_id from social_accounts where tenant_id = p_tenant and network = it->>'network' and external_id = it->>'external_id' and removed_at is null;
    if v_id is null then
      insert into social_accounts (tenant_id, network, external_id, name, handle, picture_url, parent_external_id, meta_user_id, connected_by)
      values (p_tenant, it->>'network', it->>'external_id', left(coalesce(nullif(it->>'name', ''), it->>'handle', 'Account'), 200), it->>'handle', it->>'picture_url',
              it->>'parent_external_id', p_meta_user, p_user)
      returning id into v_id;
    else
      update social_accounts set name = left(coalesce(nullif(it->>'name', ''), it->>'handle', name), 200), handle = it->>'handle', picture_url = it->>'picture_url',
             parent_external_id = it->>'parent_external_id', meta_user_id = p_meta_user, status = 'ok', status_note = null, updated_at = now() where id = v_id;
    end if;
    insert into private.social_tokens (account_id, access_token, expires_at, updated_at) values (v_id, it->>'token', nullif(it->>'expires_at', '')::timestamptz, now())
    on conflict (account_id) do update set access_token = excluded.access_token, expires_at = excluded.expires_at, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- Meta says a person removed the app or asked for their data to be deleted: forget their tokens everywhere
create or replace function public.social_meta_forget(p_meta_user text, p_delete boolean) returns int
language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  update social_targets set status = 'cancelled', error = 'The account lost its connection', updated_at = now()
   where status = 'waiting' and account_id in (select id from social_accounts where meta_user_id = p_meta_user);
  delete from private.social_tokens where account_id in (select id from social_accounts where meta_user_id = p_meta_user);
  if p_delete then
    update social_accounts set removed_at = now(), updated_at = now(), meta_user_id = null where meta_user_id = p_meta_user and removed_at is null;
  else
    update social_accounts set status = 'reconnect', status_note = 'The app was removed on Facebook. Connect again to keep posting.', updated_at = now()
     where meta_user_id = p_meta_user and removed_at is null;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.social_oauth_take(text), public.social_accounts_store(uuid, uuid, text, jsonb), public.social_meta_forget(text, boolean) from public, anon, authenticated;
grant execute on function public.social_oauth_take(text), public.social_accounts_store(uuid, uuid, text, jsonb), public.social_meta_forget(text, boolean) to service_role;

-- ---------- publishing (called by social-publish, which the tick starts) ----------
create or replace function public.social_take(p_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t social_targets; p social_posts; a social_accounts; tok text;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  select * into t from social_targets where id = p_id and status = 'sending' for update;
  if not found then return null; end if;
  select * into p from social_posts where id = t.post_id;
  select * into a from social_accounts where id = t.account_id;
  select access_token into tok from private.social_tokens where account_id = a.id;
  if p.deleted_at is not null or a.removed_at is not null then
    update social_targets set status = 'cancelled', updated_at = now() where id = p_id; perform private.social_roll(p.id); return null;
  end if;
  return jsonb_build_object('id', t.id, 'container_id', t.container_id, 'attempts', t.attempts,
    'post', jsonb_build_object('id', p.id, 'body', p.body, 'media', p.media, 'link', p.link),
    'account', jsonb_build_object('network', a.network, 'external_id', a.external_id, 'name', a.name), 'token', tok);
end $$;

-- p: {ok, external_id, permalink, error, processing, container_id, retry, reconnect}
create or replace function public.social_done(p_id uuid, p_secret text, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare t social_targets;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  select * into t from social_targets where id = p_id for update;
  if not found then return; end if;
  if coalesce((p->>'ok')::boolean, false) then
    update social_targets set status = 'posted', external_id = p->>'external_id', permalink = p->>'permalink', error = null, posted_at = now(), updated_at = now() where id = p_id;
  elsif coalesce((p->>'processing')::boolean, false) then
    update social_targets set status = 'processing', container_id = coalesce(p->>'container_id', container_id), next_try_at = now() + interval '1 minute', updated_at = now()
     where id = p_id;
  elsif coalesce((p->>'retry')::boolean, false) and t.attempts < 3 then
    update social_targets set status = 'waiting', error = left(p->>'error', 500), next_try_at = now() + (t.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  else
    update social_targets set status = 'failed', error = left(coalesce(p->>'error', 'It didn''t go through'), 500), updated_at = now() where id = p_id;
    if coalesce((p->>'reconnect')::boolean, false) then
      update social_accounts set status = 'reconnect', status_note = left(p->>'error', 300), updated_at = now() where id = t.account_id;
    end if;
  end if;
  perform private.social_roll(t.post_id);
end $$;
revoke execute on function public.social_take(uuid, text), public.social_done(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.social_take(uuid, text), public.social_done(uuid, text, jsonb) to service_role;

-- every minute: start the copies that are due, pick up processing Instagram videos, and unstick anything stuck sending
create or replace function private.social_tick() returns int
language plpgsql security definer set search_path = public, private as $$
declare t record; s text; n int := 0;
begin
  update social_targets set status = case when attempts < 3 then 'waiting' else 'failed' end, error = 'Timed out waiting on the network', next_try_at = now(), updated_at = now()
   where status = 'sending' and updated_at < now() - interval '10 minutes';
  select hook_secret into s from private.push_keys where id = 1;
  for t in select st.id, st.post_id from social_targets st join social_posts p on p.id = st.post_id
           where p.deleted_at is null and p.status in ('scheduled', 'publishing') and p.scheduled_at <= now()
             and ((st.status = 'waiting' and (st.next_try_at is null or st.next_try_at <= now())) or (st.status = 'processing' and st.next_try_at <= now()))
           order by p.scheduled_at limit 50 for update of st skip locked loop
    update social_targets set status = 'sending', attempts = attempts + 1, updated_at = now() where id = t.id;
    update social_posts set status = 'publishing', updated_at = now() where id = t.post_id and status = 'scheduled';
    perform net.http_post(url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/social-publish',
      body := jsonb_build_object('id', t.id, 'secret', s), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 120000);
    n := n + 1;
  end loop;
  -- posts left with nothing to send (every account removed) settle down
  for t in select p.id from social_posts p where p.status = 'publishing' and p.deleted_at is null
           and not exists (select 1 from social_targets x where x.post_id = p.id and x.status in ('waiting', 'sending', 'processing')) loop
    perform private.social_roll(t.id);
  end loop;
  return n;
end $$;
revoke execute on function private.social_tick() from public, anon, authenticated;
do $$ begin perform cron.unschedule('social-tick'); exception when others then null; end $$;
select cron.schedule('social-tick', '* * * * *', $$select private.social_tick()$$);

revoke execute on function public.social_settings(), public.social_settings_save(jsonb), public.social_post_save(jsonb), public.social_batch_save(jsonb),
  public.social_post_approve(uuid), public.social_post_unschedule(uuid), public.social_post_delete(uuid), public.social_post_retry(uuid),
  public.social_posts_list(timestamptz, timestamptz), public.social_account_remove(uuid) from public, anon;
grant execute on function public.social_settings(), public.social_settings_save(jsonb), public.social_post_save(jsonb), public.social_batch_save(jsonb),
  public.social_post_approve(uuid), public.social_post_unschedule(uuid), public.social_post_delete(uuid), public.social_post_retry(uuid),
  public.social_posts_list(timestamptz, timestamptz), public.social_account_remove(uuid) to authenticated;
