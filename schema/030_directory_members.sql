-- 030: Directories phase 2. Business logins (role 'member'), listing edits with the approval toggle, photos,
-- messages between visitors and businesses (business email never shown), stats for businesses by tier,
-- and members-only directories. A business login never sees CRM data: every staff check now excludes 'member',
-- and the business portal reads and writes only through the functions below.
-- (029 added the 'member' value to user_role.)

-- 1. Keep business logins out of everything staff can do
create or replace function private.is_internal() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select role not in ('vendor', 'member') from app_users where id = auth.uid() and active), false)
$$;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select is_admin from app_users where id = auth.uid() and active and role not in ('vendor', 'member')), false)
$$;
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select is_admin and tenant_id = private.default_tenant() from app_users where id = auth.uid() and active and role not in ('vendor', 'member')), false)
$$;
create or replace function private.chat_online(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from app_users where tenant_id = p_tenant and active and role not in ('vendor', 'member') and last_seen_at > now() - interval '2 minutes')
$$;
create or replace function private.is_member() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select role = 'member' from app_users where id = auth.uid() and active), false)
$$;

-- 2. Which business logins can manage which listings
create table if not exists public.directory_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  listing_id uuid not null references public.directory_listings(id),
  email text not null,
  full_name text,
  user_id uuid references public.app_users(id),
  invited_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists directory_members_one on public.directory_members (listing_id, lower(email)) where revoked_at is null;
create index if not exists directory_members_user on public.directory_members (user_id) where revoked_at is null;
alter table public.directory_members enable row level security;
create policy "account reads its business logins" on public.directory_members for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant());
grant select on public.directory_members to authenticated;
revoke insert, update, delete, truncate on public.directory_members from anon, authenticated;
create trigger audit_directory_members after insert or update on public.directory_members for each row execute function private.audit();

create or replace function private.my_listing_ids() returns setof uuid
language sql stable security definer set search_path = public, private as $$
  select m.listing_id from directory_members m join directory_listings l on l.id = m.listing_id and l.archived_at is null
   where m.user_id = auth.uid() and m.revoked_at is null and m.accepted_at is not null and private.is_member()
$$;
create or replace function private.is_listing_member(p_listing uuid) returns boolean
language sql stable security definer set search_path = public, private as $$ select p_listing in (select private.my_listing_ids()) $$;

-- link a new business login to the listings it was invited to
create or replace function private.link_member_logins() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.role = 'member' then
    update directory_members set user_id = new.id, accepted_at = coalesce(accepted_at, now())
     where lower(email) = lower(new.email) and tenant_id = new.tenant_id and user_id is null and revoked_at is null;
  end if;
  return null;
end $$;
create trigger link_member_logins after insert on public.app_users for each row execute function private.link_member_logins();

-- invite a business to manage a listing (admins of the account)
create or replace function public.directory_invite_member(p_listing uuid, p_email text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; em text := lower(trim(coalesce(p_email, ''))); u app_users; m uuid; st text;
begin
  if not private.is_admin() then raise exception 'Only an admin can invite a business'; end if;
  select * into l from directory_listings where id = p_listing and tenant_id = private.current_tenant() and archived_at is null;
  if not found then raise exception 'Listing not found'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  if exists (select 1 from directory_members where listing_id = l.id and lower(email) = em and revoked_at is null) then raise exception 'That email already has access to this listing'; end if;
  select * into u from app_users where lower(email) = em;
  if found and u.role <> 'member' then raise exception 'That email is a team login. Use a different email for the business.'; end if;
  if found and u.tenant_id <> l.tenant_id then raise exception 'That email is a business login on another account. Use a different email.'; end if;
  insert into directory_members (tenant_id, listing_id, email, full_name, user_id, invited_by, accepted_at)
  values (l.tenant_id, l.id, em, nullif(trim(coalesce(p_name, '')), ''), u.id, auth.uid(), case when u.id is not null then now() end)
  returning id into m;
  if u.id is null and not exists (select 1 from invites where lower(email) = em and accepted_at is null and revoked_at is null) then
    insert into invites (tenant_id, email, full_name, role, is_admin, invited_by) values (l.tenant_id, em, nullif(trim(coalesce(p_name, '')), ''), 'member', false, auth.uid());
  end if;
  st := case when u.id is not null then 'linked' else 'invited' end;
  return jsonb_build_object('id', m, 'status', st, 'email', em);
end $$;
create or replace function public.directory_revoke_member(p_member uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare m directory_members;
begin
  if not private.is_admin() then raise exception 'Only an admin can change business access'; end if;
  select * into m from directory_members where id = p_member and tenant_id = private.current_tenant() and revoked_at is null;
  if not found then raise exception 'Not found'; end if;
  update directory_members set revoked_at = now() where id = m.id;
  -- an unused open invite goes with it
  if m.user_id is null and not exists (select 1 from directory_members where lower(email) = lower(m.email) and revoked_at is null) then
    update invites set revoked_at = now() where lower(email) = lower(m.email) and role = 'member' and accepted_at is null and revoked_at is null;
  end if;
end $$;

-- 3. Listing edits. Business edits wait for approval unless the directory turns approval off.
create table if not exists public.directory_listing_edits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  listing_id uuid not null references public.directory_listings(id),
  submitted_by uuid references public.app_users(id),
  changes jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'applied')),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists directory_listing_edits_one_pending on public.directory_listing_edits (listing_id) where status = 'pending';
alter table public.directory_listing_edits enable row level security;
create policy "account reads listing edits" on public.directory_listing_edits for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant());
grant select on public.directory_listing_edits to authenticated;
revoke insert, update, delete, truncate on public.directory_listing_edits from anon, authenticated;
create trigger audit_directory_listing_edits after insert or update on public.directory_listing_edits for each row execute function private.audit();

-- keep only fields a business may change, cleaned up
create or replace function private.clean_listing_changes(p_listing uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare l directory_listings; out jsonb := '{}'::jsonb; k text; v jsonb; prefix text;
begin
  select * into l from directory_listings where id = p_listing;
  prefix := '/storage/v1/object/public/media/' || l.tenant_id || '/listings/' || l.id || '/';
  foreach k in array array['name', 'address', 'city', 'state', 'zip', 'main_phone', 'website', 'tagline', 'description', 'hours'] loop
    if p ? k then
      if jsonb_typeof(p->k) not in ('string', 'null') then raise exception 'Bad value for %', k; end if;
      out := out || jsonb_build_object(k, left(trim(coalesce(p->>k, '')), case when k = 'description' then 4000 when k = 'hours' then 800 else 200 end));
    end if;
  end loop;
  if out ? 'name' and out->>'name' = '' then raise exception 'The business name can''t be blank'; end if;
  if out ? 'state' then out := jsonb_set(out, '{state}', to_jsonb(upper(left(out->>'state', 2)))); end if;
  if p ? 'services' then
    if jsonb_typeof(p->'services') <> 'array' then raise exception 'Bad services'; end if;
    out := out || jsonb_build_object('services', coalesce((select jsonb_agg(left(trim(x), 60)) from (select jsonb_array_elements_text(p->'services') x limit 40) s where trim(x) <> ''), '[]'::jsonb));
  end if;
  if p ? 'social' then
    if jsonb_typeof(p->'social') <> 'object' then raise exception 'Bad social links'; end if;
    out := out || jsonb_build_object('social', coalesce((select jsonb_object_agg(key, left(trim(value), 300)) from jsonb_each_text(p->'social')
      where key in ('facebook', 'instagram', 'linkedin', 'youtube', 'tiktok', 'x') and trim(value) <> ''), '{}'::jsonb));
  end if;
  if p ? 'photos' then
    if jsonb_typeof(p->'photos') <> 'array' then raise exception 'Bad photos'; end if;
    for v in select value from jsonb_array_elements(p->'photos') loop
      if position(prefix in coalesce(v->>'url', '')) = 0 then raise exception 'Photos must be uploaded from this page'; end if;
    end loop;
    out := out || jsonb_build_object('photos', coalesce((select jsonb_agg(jsonb_build_object('url', x->>'url', 'caption', left(trim(coalesce(x->>'caption', '')), 140)))
      from (select value x from jsonb_array_elements(p->'photos') limit 12) s), '[]'::jsonb));
  end if;
  if p ? 'categories' then
    if jsonb_typeof(p->'categories') <> 'array' then raise exception 'Bad categories'; end if;
    out := out || jsonb_build_object('categories', coalesce((select jsonb_agg(c.id) from directory_categories c
      where c.directory_id = l.directory_id and c.archived_at is null and c.id::text in (select jsonb_array_elements_text(p->'categories'))), '[]'::jsonb));
  end if;
  return out;
end $$;

create or replace function private.apply_listing_edit(p_listing uuid, c jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; prof jsonb;
begin
  select * into l from directory_listings where id = p_listing;
  update companies co set
    name = coalesce(nullif(c->>'name', ''), co.name),
    address = case when c ? 'address' then nullif(c->>'address', '') else co.address end,
    city = case when c ? 'city' then nullif(c->>'city', '') else co.city end,
    state = case when c ? 'state' then nullif(c->>'state', '') else co.state end,
    zip = case when c ? 'zip' then nullif(c->>'zip', '') else co.zip end,
    main_phone = case when c ? 'main_phone' then nullif(c->>'main_phone', '') else co.main_phone end,
    website = case when c ? 'website' then nullif(c->>'website', '') else co.website end
   where co.id = l.company_id and (c ?| array['name', 'address', 'city', 'state', 'zip', 'main_phone', 'website']);
  prof := l.profile || (c - array['name', 'address', 'city', 'state', 'zip', 'main_phone', 'website', 'categories']);
  update directory_listings set profile = prof,
    -- a new address loses its old map pin; the CRM finds the new one
    lat = case when c ?| array['address', 'city', 'state', 'zip'] then null else lat end,
    lng = case when c ?| array['address', 'city', 'state', 'zip'] then null else lng end
   where id = l.id;
  if c ? 'categories' then
    delete from directory_listing_categories where listing_id = l.id and category_id::text not in (select jsonb_array_elements_text(c->'categories'));
    insert into directory_listing_categories (listing_id, category_id, tenant_id)
      select l.id, x::uuid, l.tenant_id from jsonb_array_elements_text(c->'categories') x on conflict do nothing;
  end if;
end $$;

-- business: send changes (merged into any edit already waiting)
create or replace function public.member_submit_edit(p_listing uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; d directories; c jsonb; e directory_listing_edits; need boolean;
begin
  if not private.is_listing_member(p_listing) then raise exception 'You can''t edit that listing'; end if;
  select * into l from directory_listings where id = p_listing;
  select * into d from directories where id = l.directory_id;
  c := private.clean_listing_changes(p_listing, coalesce(p_changes, '{}'::jsonb));
  if c = '{}'::jsonb then raise exception 'Nothing changed'; end if;
  need := coalesce((d.settings->>'edits_need_approval')::boolean, true);
  if not need then
    perform private.apply_listing_edit(l.id, c);
    insert into directory_listing_edits (tenant_id, directory_id, listing_id, submitted_by, changes, status, reviewed_at)
    values (l.tenant_id, l.directory_id, l.id, auth.uid(), c, 'applied', now());
    return jsonb_build_object('status', 'applied');
  end if;
  select * into e from directory_listing_edits where listing_id = l.id and status = 'pending';
  if found then
    update directory_listing_edits set changes = e.changes || c, submitted_by = auth.uid(), updated_at = now() where id = e.id;
  else
    insert into directory_listing_edits (tenant_id, directory_id, listing_id, submitted_by, changes) values (l.tenant_id, l.directory_id, l.id, auth.uid(), c) returning * into e;
  end if;
  return jsonb_build_object('status', 'pending', 'id', e.id);
end $$;
create or replace function public.member_cancel_edit(p_listing uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_listing_member(p_listing) then raise exception 'You can''t edit that listing'; end if;
  update directory_listing_edits set status = 'rejected', note = 'Withdrawn by the business', reviewed_at = now(), updated_at = now()
   where listing_id = p_listing and status = 'pending';
end $$;

-- admins: approve or turn down a waiting edit
create or replace function public.directory_review_edit(p_edit uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e directory_listing_edits;
begin
  if not private.is_admin() then raise exception 'Only an admin can review listing edits'; end if;
  select * into e from directory_listing_edits where id = p_edit and tenant_id = private.current_tenant() and status = 'pending' for update;
  if not found then raise exception 'That edit was already handled'; end if;
  if p_approve then perform private.apply_listing_edit(e.listing_id, e.changes); end if;
  update directory_listing_edits set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = auth.uid(), reviewed_at = now(),
    note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now() where id = e.id;
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'submitted_by', e.submitted_by);
end $$;

-- 4. Photos: businesses upload into their listing's folder only
create policy "businesses upload listing photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and private.is_member() and (storage.foldername(name))[1] = private.current_tenant()::text
    and (storage.foldername(name))[2] = 'listings' and (storage.foldername(name))[3] in (select private.my_listing_ids()::text));

-- 5. Messages between visitors and businesses. The business's email is never shown; replies go out from the CRM.
create table if not exists public.directory_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  listing_id uuid not null references public.directory_listings(id),
  visitor_name text not null,
  visitor_email text not null,
  visitor_phone text,
  visitor_key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  ip_hash text,
  status text not null default 'open' check (status in ('open', 'closed')),
  unread_business boolean not null default true,
  last_message_at timestamptz not null default now(),
  business_notified_at timestamptz,
  visitor_notified_at timestamptz,
  visitor_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists directory_threads_listing on public.directory_threads (listing_id, last_message_at desc);
create table if not exists public.directory_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  thread_id uuid not null references public.directory_threads(id),
  sender text not null check (sender in ('visitor', 'business')),
  user_id uuid references public.app_users(id),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create index if not exists directory_messages_thread on public.directory_messages (thread_id, created_at);
alter table public.directory_threads enable row level security;
alter table public.directory_messages enable row level security;
create policy "account reads directory threads" on public.directory_threads for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant());
create policy "account reads directory messages" on public.directory_messages for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant());
grant select on public.directory_threads, public.directory_messages to authenticated;
revoke insert, update, delete, truncate on public.directory_threads, public.directory_messages from anon, authenticated;

create or replace function private.request_ip_hash() returns text
language sql stable security definer set search_path = public, private as $$
  select case when ip is null then null else encode(extensions.digest((select salt from private.directory_secret) || ip, 'sha256'), 'hex') end
    from (select nullif(trim(split_part(coalesce((current_setting('request.headers', true))::json->>'x-forwarded-for', ''), ',', 1)), '') ip) s
$$;

-- visitor: start a conversation with a business (only when the listing's tier includes messages)
create or replace function public.directory_message_start(p_listing uuid, p_name text, p_email text, p_phone text, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare l directory_listings; d directories; t directory_threads; h text := private.request_ip_hash(); em text := lower(trim(coalesce(p_email, '')));
begin
  select * into l from directory_listings where id = p_listing and archived_at is null and status = 'live';
  if not found then raise exception 'That business isn''t taking messages'; end if;
  select * into d from directories where id = l.directory_id and archived_at is null and status = 'live';
  if not found or not private.directories_on(d.tenant_id) then raise exception 'That business isn''t taking messages'; end if;
  if not coalesce((select (features->>'messages')::boolean from directory_tiers where id = l.tier_id), false) then raise exception 'That business isn''t taking messages'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Add your name'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Add a valid email so they can reply'; end if;
  if length(trim(coalesce(p_body, ''))) < 2 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  if h is not null and (select count(*) from directory_threads where ip_hash = h and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You''ve sent several messages already. Try again a little later.';
  end if;
  insert into directory_threads (tenant_id, directory_id, listing_id, visitor_name, visitor_email, visitor_phone, ip_hash)
  values (l.tenant_id, d.id, l.id, left(trim(p_name), 120), em, nullif(left(trim(coalesce(p_phone, '')), 40), ''), h) returning * into t;
  insert into directory_messages (tenant_id, thread_id, sender, body) values (l.tenant_id, t.id, 'visitor', trim(p_body));
  insert into directory_events (tenant_id, directory_id, listing_id, kind, ip_hash) values (l.tenant_id, d.id, l.id, 'message', h);
  return jsonb_build_object('thread', t.id, 'key', t.visitor_key);
end $$;
create or replace function public.directory_thread_fetch(p_thread uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t directory_threads;
begin
  select * into t from directory_threads where id = p_thread and visitor_key = p_key;
  if not found then return null; end if;
  update directory_threads set visitor_seen_at = now() where id = t.id;
  return jsonb_build_object('business', (select co.name from directory_listings l join companies co on co.id = l.company_id where l.id = t.listing_id),
    'directory', (select slug from directories where id = t.directory_id), 'name', t.visitor_name, 'status', t.status,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('from', m.sender, 'body', m.body, 'at', m.created_at) order by m.created_at)
      from directory_messages m where m.thread_id = t.id), '[]'::jsonb));
end $$;
create or replace function public.directory_thread_send(p_thread uuid, p_key text, p_body text) returns void
language plpgsql security definer set search_path = public, private as $$
declare t directory_threads;
begin
  select * into t from directory_threads where id = p_thread and visitor_key = p_key;
  if not found then raise exception 'Conversation not found'; end if;
  if length(trim(coalesce(p_body, ''))) < 1 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  if (select count(*) from directory_messages where thread_id = t.id and sender = 'visitor' and created_at > now() - interval '1 minute') >= 6 then
    raise exception 'Slow down a little and try again in a minute.';
  end if;
  insert into directory_messages (tenant_id, thread_id, sender, body) values (t.tenant_id, t.id, 'visitor', trim(p_body));
  update directory_threads set last_message_at = now(), unread_business = true, status = 'open', visitor_seen_at = now() where id = t.id;
end $$;

-- 6. Business portal: everything a business login needs, nothing more
create or replace function public.member_home() returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not private.is_member() then return null; end if;
  return jsonb_build_object('listings', coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'status', l.status, 'profile', l.profile, 'lat', l.lat, 'lng', l.lng,
      'org', jsonb_build_object('name', co.name, 'address', co.address, 'city', co.city, 'state', co.state, 'zip', co.zip, 'main_phone', co.main_phone, 'website', co.website),
      'directory', jsonb_build_object('id', d.id, 'name', d.name, 'slug', d.slug, 'status', d.status, 'approval', coalesce((d.settings->>'edits_need_approval')::boolean, true)),
      'tier', jsonb_build_object('name', t.name, 'features', coalesce(t.features, '{}'::jsonb)),
      'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'parent', c.parent_id, 'name', c.name) order by c.sort, c.name)
         from directory_categories c where c.directory_id = d.id and c.archived_at is null), '[]'::jsonb),
      'chosen', coalesce((select jsonb_agg(category_id) from directory_listing_categories where listing_id = l.id), '[]'::jsonb),
      'pending', (select jsonb_build_object('id', e.id, 'changes', e.changes, 'at', e.updated_at) from directory_listing_edits e where e.listing_id = l.id and e.status = 'pending'),
      'last_review', (select jsonb_build_object('status', e.status, 'note', e.note, 'at', e.reviewed_at) from directory_listing_edits e
         where e.listing_id = l.id and e.status in ('approved', 'rejected') and e.reviewed_by is not null order by e.reviewed_at desc limit 1),
      'stats', case when coalesce((t.features->>'stats')::boolean, false) then (select jsonb_build_object(
          'd30', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from directory_events where listing_id = l.id and at > now() - interval '30 days' group by 1) a),
          'd90', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from directory_events where listing_id = l.id and at > now() - interval '90 days' group by 1) a),
          'places', (select coalesce(jsonb_agg(jsonb_build_object('place', p, 'n', n) order by n desc), '[]'::jsonb) from (
             select concat_ws(', ', city, region) p, count(*) n from directory_events where listing_id = l.id and at > now() - interval '90 days' and city is not null group by 1 order by 2 desc limit 8) b))) end,
      'messages', coalesce((t.features->>'messages')::boolean, false),
      'threads', case when coalesce((t.features->>'messages')::boolean, false) then coalesce((select jsonb_agg(jsonb_build_object('id', th.id, 'name', th.visitor_name,
          'unread', th.unread_business, 'at', th.last_message_at,
          'preview', (select left(m.body, 120) from directory_messages m where m.thread_id = th.id order by m.created_at desc limit 1)) order by th.last_message_at desc)
        from directory_threads th where th.listing_id = l.id), '[]'::jsonb) end
    ) order by co.name)
    from directory_listings l join companies co on co.id = l.company_id join directories d on d.id = l.directory_id left join directory_tiers t on t.id = l.tier_id
   where l.id in (select private.my_listing_ids()) and d.archived_at is null), '[]'::jsonb));
end $$;

-- business or account team: open a conversation (the business sees the visitor's email; the visitor never sees theirs)
create or replace function public.directory_thread_open(p_thread uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t directory_threads; mine boolean;
begin
  select * into t from directory_threads where id = p_thread;
  if not found then return null; end if;
  mine := private.is_listing_member(t.listing_id);
  if not mine and not (private.is_internal() and t.tenant_id = private.current_tenant()) then return null; end if;
  if mine then update directory_threads set unread_business = false where id = t.id; end if;
  return jsonb_build_object('id', t.id, 'name', t.visitor_name, 'email', t.visitor_email, 'phone', t.visitor_phone, 'at', t.created_at, 'can_reply', mine,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('from', m.sender, 'body', m.body, 'at', m.created_at,
       'who', case when m.sender = 'business' then (select split_part(full_name, ' ', 1) from app_users where id = m.user_id) end) order by m.created_at)
      from directory_messages m where m.thread_id = t.id), '[]'::jsonb));
end $$;
create or replace function public.member_reply(p_thread uuid, p_body text) returns void
language plpgsql security definer set search_path = public, private as $$
declare t directory_threads;
begin
  select * into t from directory_threads where id = p_thread;
  if not found or not private.is_listing_member(t.listing_id) then raise exception 'Conversation not found'; end if;
  if length(trim(coalesce(p_body, ''))) < 1 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  insert into directory_messages (tenant_id, thread_id, sender, user_id, body) values (t.tenant_id, t.id, 'business', auth.uid(), trim(p_body));
  update directory_threads set last_message_at = now(), unread_business = false where id = t.id;
end $$;

-- 7. Members-only directories open to their own businesses
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.directory_public(text)'::regprocedure);
  if position('my_listing_ids' in d) = 0 then
    if position($s$  if d.visibility = 'members' and not preview then$s$ in d) = 0 then raise exception 'directory_public changed, patch by hand'; end if;
    d := replace(d, $s$  if d.visibility = 'members' and not preview then$s$,
      $s$  if d.visibility = 'members' and not preview and exists (select 1 from directory_listings ml where ml.directory_id = d.id and ml.id in (select private.my_listing_ids())) then
    preview := false;
  elsif d.visibility = 'members' and not preview then$s$);
    -- photos for tiers that include them
    d := replace(d, $s$         'messages', coalesce((f->>'messages')::boolean, false),$s$,
      $s$         'messages', coalesce((f->>'messages')::boolean, false),
         'photos', case when (f->>'photos')::boolean then l.profile->'photos' end,$s$);
    d := replace(d, $s$'show_map', coalesce((d.settings->>'show_map')::boolean, true),$s$,
      $s$'show_map', coalesce((d.settings->>'show_map')::boolean, true), 'member_view', d.visibility = 'members' and not preview,$s$);
    if position('my_listing_ids' in d) = 0 or position($s$'photos', case$s$ in d) = 0 then raise exception 'directory_public patch failed'; end if;
    execute d;
  end if;
end $m$;

-- 8. Approvals waiting, for the Review badge
create or replace function public.directory_pending_count() returns int
language sql stable security definer set search_path = public, private as $$
  select case when private.is_admin() then (select count(*)::int from directory_listing_edits where tenant_id = private.current_tenant() and status = 'pending') else 0 end
$$;

-- permissions
revoke execute on function private.is_member(), private.my_listing_ids(), private.is_listing_member(uuid), private.link_member_logins(),
  private.clean_listing_changes(uuid, jsonb), private.apply_listing_edit(uuid, jsonb), private.request_ip_hash() from public, anon;
grant execute on function private.is_member(), private.my_listing_ids(), private.is_listing_member(uuid) to authenticated;
revoke execute on function private.link_member_logins() from authenticated;
revoke execute on function public.directory_invite_member(uuid, text, text), public.directory_revoke_member(uuid), public.member_submit_edit(uuid, jsonb),
  public.member_cancel_edit(uuid), public.directory_review_edit(uuid, boolean, text), public.member_home(), public.directory_thread_open(uuid),
  public.member_reply(uuid, text), public.directory_pending_count() from public, anon;
grant execute on function public.directory_invite_member(uuid, text, text), public.directory_revoke_member(uuid), public.member_submit_edit(uuid, jsonb),
  public.member_cancel_edit(uuid), public.directory_review_edit(uuid, boolean, text), public.member_home(), public.directory_thread_open(uuid),
  public.member_reply(uuid, text), public.directory_pending_count() to authenticated;
revoke execute on function public.directory_message_start(uuid, text, text, text, text), public.directory_thread_fetch(uuid, text), public.directory_thread_send(uuid, text, text) from public;
grant execute on function public.directory_message_start(uuid, text, text, text, text), public.directory_thread_fetch(uuid, text), public.directory_thread_send(uuid, text, text) to anon, authenticated;

-- 030b: invites can be for business logins
alter table public.invites drop constraint invites_role_check;
alter table public.invites add constraint invites_role_check check (role = any (array['staff', 'vendor', 'member']));
