-- 045: free starter accounts for directory businesses (Oct 19, 2026).
-- Every business that accepts a listing invite gets its own free GELP account. Their login becomes the admin of that
-- account and signs in to the regular CRM: My listing (the portal), Organizations and People, and the Inbox work;
-- everything else shows locked. The listing's chat is the standard GELP chat widget pointed at their account, so
-- conversations land in their Inbox (sound, phone notifications, email when away). The website chat widget for their
-- own site stays locked on the free plan. Old directory messages stay where they are and still show in My listing.
-- A login that already belongs to a full account (a paying client) keeps it, and the listing's chats go there.

alter table public.tenants add column if not exists plan text not null default 'full';
alter table public.tenants add column if not exists from_directory_id uuid references public.directories(id);
alter table public.directory_listings add column if not exists chat_tenant_id uuid references public.tenants(id);

-- a free account named for the listing's business
create or replace function private.new_starter_account(p_listing uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; nm text; base text; s text; i int := 1; tid uuid;
begin
  select * into l from directory_listings where id = p_listing;
  select name into nm from companies where id = l.company_id;
  base := left(trim(both '-' from lower(regexp_replace(coalesce(nm, 'business'), '[^a-zA-Z0-9]+', '-', 'g'))), 40);
  if length(base) < 3 then base := 'business-' || base; end if;
  s := base;
  while exists (select 1 from tenants where slug = s) loop i := i + 1; s := base || '-' || i; end loop;
  insert into tenants (name, slug, agency_tenant_id, plan, from_directory_id)
  values (coalesce(nm, 'My business'), s, private.default_tenant(), 'starter', l.directory_id) returning id into tid;
  return tid;
end $$;

-- where a listing's chats go: the account of the first login that manages it (a new free account for a business-only login)
create or replace function private.listing_chat_account(p_listing uuid, p_user uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; u app_users; tid uuid;
begin
  select * into l from directory_listings where id = p_listing;
  if not found then return null; end if;
  if l.chat_tenant_id is not null then return l.chat_tenant_id; end if;
  select * into u from app_users where id = p_user;
  tid := case when found and u.role <> 'member' then u.tenant_id else private.new_starter_account(l.id) end;
  update directory_listings set chat_tenant_id = tid where id = l.id;
  return tid;
end $$;

-- after a business login is linked to its listings: give each listing a chat account, and move a business-only
-- login into its own free account as the admin (it joins a coworker's free account if the business already has one;
-- if the listing's chats already go to a full account, the business still gets a free account of its own)
create or replace function private.member_setup(p_user uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare u app_users; m record; tid uuid;
begin
  select * into u from app_users where id = p_user;
  if not found then return; end if;
  for m in select dm.listing_id, l.chat_tenant_id from directory_members dm join directory_listings l on l.id = dm.listing_id and l.archived_at is null
            where dm.user_id = p_user and dm.revoked_at is null and dm.accepted_at is not null order by dm.created_at loop
    if u.role = 'member' then
      if m.chat_tenant_id is null then tid := private.listing_chat_account(m.listing_id, p_user);
      elsif (select plan from tenants where id = m.chat_tenant_id) = 'starter' then tid := m.chat_tenant_id;
      else tid := private.new_starter_account(m.listing_id);
      end if;
      update app_users set tenant_id = tid, role = 'staff', is_admin = true, acting_tenant_id = null where id = u.id;
      select * into u from app_users where id = p_user;
    else
      perform private.listing_chat_account(m.listing_id, p_user);
    end if;
  end loop;
end $$;

-- link new business logins by email (any directory's invite), then set up their account
create or replace function private.link_member_logins() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.role = 'member' then
    update directory_members set user_id = new.id, accepted_at = coalesce(accepted_at, now())
     where lower(email) = lower(new.email) and user_id is null and revoked_at is null;
    perform private.member_setup(new.id);
  end if;
  return null;
end $$;

-- business access follows the invite, whatever account the login is in
create or replace function private.my_listing_ids() returns setof uuid
language sql stable security definer set search_path = public, private as $$
  select m.listing_id from directory_members m join directory_listings l on l.id = m.listing_id and l.archived_at is null
   where m.user_id = auth.uid() and m.revoked_at is null and m.accepted_at is not null
     and exists (select 1 from app_users u where u.id = auth.uid() and u.active and u.role <> 'vendor')
$$;

create or replace function public.member_heartbeat() returns void
language sql security definer set search_path = public, private as $$
  update app_users set last_seen_at = now() where id = auth.uid() and active
$$;

-- photos: the folder is the listing's own account (the directory's), not the business's free account
alter policy "businesses upload listing photos" on storage.objects
  with check (bucket_id = 'media' and (storage.foldername(name))[2] = 'listings'
    and (storage.foldername(name))[3] in (select private.my_listing_ids()::text)
    and (storage.foldername(name))[1] = (select l.tenant_id::text from directory_listings l where l.id::text = (storage.foldername(name))[3]));

do $$
declare d text; b text;
begin
  -- the portal works for any login with listings, and tells the app which account owns each listing's photos
  d := pg_get_functiondef('public.member_home()'::regprocedure); b := d;
  d := replace(d, $q$  if not private.is_member() then return null; end if;$q$, $q$  if not exists (select 1 from private.my_listing_ids()) then return jsonb_build_object('listings', '[]'::jsonb); end if;$q$);
  d := replace(d, $q$'id', l.id, 'status', l.status,$q$, $q$'id', l.id, 'tenant_id', l.tenant_id, 'status', l.status,$q$);
  if d = b or position('''tenant_id'', l.tenant_id' in d) = 0 then raise exception 'member_home: no match'; end if;
  execute d;

  -- the plan comes along with the account
  d := pg_get_functiondef('public.current_account()'::regprocedure); b := d;
  d := replace(d, $q$'is_gelp', t.id = private.default_tenant())$q$, $q$'is_gelp', t.id = private.default_tenant(), 'plan', t.plan)$q$);
  if d = b then raise exception 'current_account: no match'; end if;
  execute d;

  -- the listing page gets the business's chat account
  d := pg_get_functiondef('public.directory_public(text)'::regprocedure); b := d;
  d := replace(d, $q$'messages', coalesce((f->>'messages')::boolean, false),$q$,
    $q$'messages', coalesce((f->>'messages')::boolean, false),
         'chat', case when coalesce((f->>'messages')::boolean, false) then (select slug from tenants where id = l.chat_tenant_id) end,$q$);
  if d = b then raise exception 'directory_public: no match'; end if;
  execute d;

  -- widget: free accounts only chat from their directory listing; listing chats count as a message on the listing
  d := pg_get_functiondef('public.chat_start(text,text,text,text,text,text,text)'::regprocedure); b := d;
  d := replace(d, $q$  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;$q$,
    $q$  if p_source = 'directory' then
    select * into dl from directory_listings where id::text = p_ref and chat_tenant_id = t.id and archived_at is null and status = 'live';
    if not found or not coalesce((select (features->>'messages')::boolean from directory_tiers where id = dl.tier_id), false) then raise exception 'That business isn''t taking messages'; end if;
  elsif t.plan = 'starter' then raise exception 'Chat is not set up for this site';
  end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;$q$);
  d := replace(d, $q$declare t tenants; th chat_threads;$q$, $q$declare dl directory_listings; t tenants; th chat_threads;$q$);
  d := replace(d, $q$case when p_source in ('website','proposal','invoice') then p_source else 'other' end$q$, $q$case when p_source in ('website','proposal','invoice','directory') then p_source else 'other' end$q$);
  d := replace(d, $q$  insert into chat_messages (tenant_id, thread_id, sender, body) values (t.id, th.id, 'visitor', trim(p_body));
  return$q$, $q$  insert into chat_messages (tenant_id, thread_id, sender, body) values (t.id, th.id, 'visitor', trim(p_body));
  if dl.id is not null then
    insert into directory_events (tenant_id, directory_id, listing_id, kind, ip_hash) values (dl.tenant_id, dl.directory_id, dl.id, 'message', private.request_ip_hash());
  end if;
  return$q$);
  if position('declare dl directory_listings' in d) = 0 or position('''directory'') then p_source' in d) = 0 or position('if dl.id is not null' in d) = 0 or position('elsif t.plan' in d) = 0 then raise exception 'chat_start: no match'; end if;
  execute d;
end $$;

-- widget: free accounts show a small "free live chat by GELP" link
create or replace function public.chat_status(p_tenant text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', t.name, 'online', private.chat_online(t.id), 'free', t.plan = 'starter') from tenants t where t.slug = lower(trim(p_tenant))
$$;

-- invites: any login can be invited to manage a listing; it's set up right away when it already exists
do $$
declare d text; b text;
begin
  d := pg_get_functiondef('public.directory_invite_member(uuid,text,text)'::regprocedure); b := d;
  d := replace(d, $q$  if found and u.role <> 'member' then raise exception 'That email is a team login. Use a different email for the business.'; end if;
  if found and u.tenant_id <> l.tenant_id then raise exception 'That email is a business login on another account. Use a different email.'; end if;
$q$, '');
  d := replace(d, $q$  st := case when u.id is not null then 'linked' else 'invited' end;$q$, $q$  if u.id is not null then perform private.member_setup(u.id); end if;
  st := case when u.id is not null then 'linked' else 'invited' end;$q$);
  if position('member_setup' in d) = 0 or position('team login' in d) > 0 then raise exception 'directory_invite_member: no match'; end if;
  execute d;
end $$;

revoke execute on function private.listing_chat_account(uuid, uuid), private.member_setup(uuid), private.new_starter_account(uuid) from public, anon, authenticated;

-- the business logins that exist today
do $$ declare r record; begin
  for r in select id from app_users where role = 'member' loop perform private.member_setup(r.id); end loop;
end $$;
