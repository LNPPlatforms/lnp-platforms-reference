-- 028: Directories, phase 1. One neutral engine: each account (when GELP turns the feature on) can run any number of
-- directories. Every listing is a CRM organization (no separate list), so name, address, phone and website stay in sync.
-- Almost everything is a per-directory setting with defaults. Archive, never delete. Every change is in History.

-- per-account switch, controlled by GELP platform admins for now (paywalled later)
create table if not exists private.feature_flags (
  tenant_id uuid primary key references public.tenants(id),
  directories boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id)
);
alter table private.feature_flags enable row level security;
create trigger audit_feature_flags after insert or update on private.feature_flags for each row execute function private.audit();

create or replace function private.directories_on(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select directories from private.feature_flags where tenant_id = p_tenant), false)
$$;
grant execute on function private.directories_on(uuid) to authenticated, anon;

create or replace function public.set_directories_enabled(p_tenant uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_admin() then raise exception 'Only GELP can turn directories on or off for an account'; end if;
  if not exists (select 1 from tenants where id = p_tenant) then raise exception 'Account not found'; end if;
  insert into private.feature_flags (tenant_id, directories, updated_at, updated_by) values (p_tenant, coalesce(p_on, false), now(), auth.uid())
  on conflict (tenant_id) do update set directories = excluded.directories, updated_at = now(), updated_by = auth.uid()
   where private.feature_flags.directories is distinct from excluded.directories;
  return private.directories_on(p_tenant);
end $$;
create or replace function public.directories_flags() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_platform_admin() then
    coalesce((select jsonb_object_agg(tenant_id, directories) from private.feature_flags), '{}'::jsonb)
  else jsonb_build_object(private.current_tenant(), private.directories_on(private.current_tenant())) end
$$;
revoke execute on function public.set_directories_enabled(uuid, boolean), public.directories_flags() from public, anon;
grant execute on function public.set_directories_enabled(uuid, boolean), public.directories_flags() to authenticated;

-- directories
create table if not exists public.directories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$'),
  tagline text,
  visibility text not null default 'public' check (visibility in ('public', 'members')),
  status text not null default 'draft' check (status in ('draft', 'live')),
  logo_media_id uuid references public.media(id),
  custom_domain text,
  settings jsonb not null default jsonb_build_object(
    'edits_need_approval', true,
    'access', jsonb_build_object('invite', true, 'checkout', false, 'claim', false),
    'reviews', false,
    'grace_days', 30,
    'unpaid_level', 'free',
    'repay_review', true,
    'show_map', true,
    'colors', jsonb_build_object('primary', '#1A2A52', 'accent', '#C9A04A')),
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- categories and subcategories (any depth). A folder can carry a place, for "near this stop" sorting.
create table if not exists public.directory_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  parent_id uuid references public.directory_categories(id),
  name text not null check (length(trim(name)) > 0),
  sort int not null default 100,
  place_label text,
  lat double precision, lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists directory_categories_dir_idx on public.directory_categories (directory_id, parent_id, sort);

-- tiers: each directory defines its own levels and which features each gets
create table if not exists public.directory_tiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  name text not null check (length(trim(name)) > 0),
  sort int not null default 100,
  price_monthly numeric check (price_monthly is null or price_monthly >= 0),
  price_yearly numeric check (price_yearly is null or price_yearly >= 0),
  is_free boolean not null default false,
  features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists directory_tiers_dir_idx on public.directory_tiers (directory_id, sort);

-- listings: a CRM organization placed in a directory
create table if not exists public.directory_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  company_id uuid not null references public.companies(id),
  tier_id uuid references public.directory_tiers(id),
  status text not null default 'live' check (status in ('live', 'hidden', 'pending')),
  featured boolean not null default false,
  profile jsonb not null default '{}'::jsonb,   -- tagline, description, hours, services, social, photos
  lat double precision, lng double precision,
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists directory_listings_one_per_org on public.directory_listings (directory_id, company_id) where archived_at is null;
create index if not exists directory_listings_company_idx on public.directory_listings (company_id);

create table if not exists public.directory_listing_categories (
  listing_id uuid not null references public.directory_listings(id),
  category_id uuid not null references public.directory_categories(id),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  created_at timestamptz not null default now(),
  primary key (listing_id, category_id)
);

-- views and clicks on public listings. No raw IP: a salted hash, plus a rough place filled in later by the geo lookup.
create table if not exists public.directory_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants(id),
  directory_id uuid not null references public.directories(id),
  listing_id uuid references public.directory_listings(id),
  kind text not null check (kind in ('directory_view', 'view', 'call', 'directions', 'website', 'message')),
  ip_hash text,
  city text, region text, country text,
  at timestamptz not null default now()
);
create index if not exists directory_events_listing_idx on public.directory_events (listing_id, at desc);
create index if not exists directory_events_dir_idx on public.directory_events (directory_id, at desc);

create table if not exists private.directory_secret (id int primary key default 1 check (id = 1), salt text not null);
insert into private.directory_secret (salt) values (encode(extensions.gen_random_bytes(32), 'hex')) on conflict do nothing;
alter table private.directory_secret enable row level security;

-- keep tenant and directory consistent, stamp updates
create or replace function private.guard_directory_row() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare d public.directories;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.tenant_id := private.current_tenant();
    if not private.directories_on(new.tenant_id) then raise exception 'Directories are not turned on for this account'; end if;
  elsif new.tenant_id <> old.tenant_id then raise exception 'That cannot be changed';
  end if;
  if tg_table_name <> 'directories' then
    select * into d from directories where id = new.directory_id;
    if d.tenant_id is distinct from new.tenant_id then raise exception 'That directory belongs to another account'; end if;
    if tg_op = 'UPDATE' and new.directory_id <> old.directory_id then raise exception 'That cannot be moved to another directory'; end if;
  else
    new.slug := lower(trim(new.slug));
  end if;
  if tg_table_name = 'directory_listings' then
    if not exists (select 1 from companies where id = new.company_id and tenant_id = new.tenant_id) then raise exception 'Organization not found'; end if;
    if tg_op = 'UPDATE' and new.company_id <> old.company_id then raise exception 'A listing stays with its organization'; end if;
    if new.tier_id is not null and not exists (select 1 from directory_tiers where id = new.tier_id and directory_id = new.directory_id) then raise exception 'That tier belongs to another directory'; end if;
  end if;
  if tg_table_name = 'directory_categories' then
    if new.parent_id is not null then
      if not exists (select 1 from directory_categories where id = new.parent_id and directory_id = new.directory_id) then raise exception 'That parent belongs to another directory'; end if;
      if tg_op = 'UPDATE' and exists (
        with recursive up(id, parent_id) as (select c0.id, c0.parent_id from directory_categories c0 where c0.id = new.parent_id
          union all select c.id, c.parent_id from directory_categories c join up on c.id = up.parent_id)
        select 1 from up where up.id = new.id) then raise exception 'A category can''t sit inside itself'; end if;
    end if;
  end if;
  return new;
end $$;
create or replace function private.guard_listing_category() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  new.tenant_id := private.current_tenant();
  if not exists (select 1 from directory_listings l join directory_categories c on c.directory_id = l.directory_id
                  where l.id = new.listing_id and c.id = new.category_id and l.tenant_id = new.tenant_id) then
    raise exception 'That category belongs to another directory';
  end if;
  return new;
end $$;

create trigger guard_directories before insert or update on public.directories for each row execute function private.guard_directory_row();
create trigger guard_directory_categories before insert or update on public.directory_categories for each row execute function private.guard_directory_row();
create trigger guard_directory_tiers before insert or update on public.directory_tiers for each row execute function private.guard_directory_row();
create trigger guard_directory_listings before insert or update on public.directory_listings for each row execute function private.guard_directory_row();
create trigger guard_directory_listing_categories before insert on public.directory_listing_categories for each row execute function private.guard_listing_category();
create trigger audit_directories after insert or update on public.directories for each row execute function private.audit();
create trigger audit_directory_categories after insert or update on public.directory_categories for each row execute function private.audit();
create trigger audit_directory_tiers after insert or update on public.directory_tiers for each row execute function private.audit();
create trigger audit_directory_listings after insert or update on public.directory_listings for each row execute function private.audit();
create trigger audit_directory_listing_categories after insert or delete on public.directory_listing_categories for each row execute function private.audit();
revoke execute on function private.guard_directory_row(), private.guard_listing_category() from public, anon, authenticated;

-- security: the account's team reads; the account's admins manage. Removing a category from a listing is the only delete.
alter table public.directories enable row level security;
alter table public.directory_categories enable row level security;
alter table public.directory_tiers enable row level security;
alter table public.directory_listings enable row level security;
alter table public.directory_listing_categories enable row level security;
alter table public.directory_events enable row level security;
do $p$
declare t text;
begin
  foreach t in array array['directories','directory_categories','directory_tiers','directory_listings','directory_listing_categories'] loop
    execute format('create policy "account reads its directories" on public.%I for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant())', t);
    execute format('create policy "account admins add" on public.%I for insert to authenticated with check (private.is_admin() and tenant_id = private.current_tenant())', t);
    if t <> 'directory_listing_categories' then
      execute format('create policy "account admins change" on public.%I for update to authenticated using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant())', t);
    end if;
  end loop;
end $p$;
create policy "account admins untag" on public.directory_listing_categories for delete to authenticated using (private.is_admin() and tenant_id = private.current_tenant());
create policy "account reads its directory stats" on public.directory_events for select to authenticated using (private.is_internal() and tenant_id = private.current_tenant());
grant select, insert, update on public.directories, public.directory_categories, public.directory_tiers, public.directory_listings to authenticated;
grant select, insert, delete on public.directory_listing_categories to authenticated;
grant select on public.directory_events to authenticated;
revoke delete, truncate on public.directories, public.directory_categories, public.directory_tiers, public.directory_listings, public.directory_events from anon, authenticated;

-- default tiers for a new directory: Free and Featured (our suggestion; the owner changes anything)
create or replace function private.seed_directory() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  insert into directory_tiers (tenant_id, directory_id, name, sort, is_free, features) values
    (new.tenant_id, new.id, 'Free listing', 10, true, jsonb_build_object('logo', false, 'description', false, 'website', false, 'hours', true,
       'services', false, 'social', false, 'photos', false, 'featured', false, 'stats', false, 'messages', false, 'map', true)),
    (new.tenant_id, new.id, 'Featured listing', 20, false, jsonb_build_object('logo', true, 'description', true, 'website', true, 'hours', true,
       'services', true, 'social', true, 'photos', true, 'featured', true, 'stats', true, 'messages', true, 'map', true));
  return null;
end $$;
create trigger seed_directory after insert on public.directories for each row execute function private.seed_directory();
revoke execute on function private.seed_directory() from public, anon, authenticated;

-- PUBLIC: everything the directory page needs, only live listings, fields filtered by each listing's tier
create or replace function public.directory_public(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare d public.directories; preview boolean; logo text;
begin
  select * into d from directories where (slug = lower(trim(p_slug)) or lower(custom_domain) = lower(trim(p_slug))) and archived_at is null;
  if not found or not private.directories_on(d.tenant_id) then return null; end if;
  -- the account's own team can preview drafts and members-only directories
  preview := private.is_internal() and private.current_tenant() = d.tenant_id;
  if d.status <> 'live' and not preview then return null; end if;
  select url into logo from media where id = d.logo_media_id and archived_at is null;
  if d.visibility = 'members' and not preview then
    return jsonb_build_object('name', d.name, 'tagline', d.tagline, 'logo', logo, 'colors', d.settings->'colors', 'members_only', true);
  end if;
  return jsonb_build_object(
    'id', d.id, 'name', d.name, 'tagline', d.tagline, 'logo', logo, 'colors', d.settings->'colors', 'preview', preview, 'status', d.status,
    'show_map', coalesce((d.settings->>'show_map')::boolean, true),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'parent', c.parent_id, 'name', c.name, 'place', c.place_label, 'lat', c.lat, 'lng', c.lng) order by c.sort, c.name)
                              from directory_categories c where c.directory_id = d.id and c.archived_at is null), '[]'::jsonb),
    'listings', coalesce((select jsonb_agg(x order by (x->>'featured')::boolean desc, x->>'name') from (
       select jsonb_strip_nulls(jsonb_build_object(
         'id', l.id, 'name', co.name, 'tier', t.name,
         'featured', l.featured and coalesce((f->>'featured')::boolean, false),
         'address', co.address, 'city', co.city, 'state', co.state, 'zip', co.zip,
         'phone', co.main_phone,
         'lat', case when coalesce((f->>'map')::boolean, true) then l.lat end, 'lng', case when coalesce((f->>'map')::boolean, true) then l.lng end,
         'website', case when (f->>'website')::boolean then co.website end,
         'logo', case when (f->>'logo')::boolean then (select url from media where id = co.logo_media_id and archived_at is null) end,
         'tagline', nullif(l.profile->>'tagline', ''),
         'description', case when (f->>'description')::boolean then nullif(l.profile->>'description', '') end,
         'hours', case when (f->>'hours')::boolean then nullif(l.profile->>'hours', '') end,
         'services', case when (f->>'services')::boolean then l.profile->'services' end,
         'social', case when (f->>'social')::boolean then l.profile->'social' end,
         'messages', coalesce((f->>'messages')::boolean, false),
         'cats', (select jsonb_agg(lc.category_id) from directory_listing_categories lc where lc.listing_id = l.id))) x
       from directory_listings l
       join companies co on co.id = l.company_id and co.archived_at is null
       left join directory_tiers t on t.id = l.tier_id
       cross join lateral (select coalesce(t.features, '{}'::jsonb) f) ff
      where l.directory_id = d.id and l.archived_at is null and l.status = 'live') s), '[]'::jsonb));
end $$;

-- PUBLIC: count a view or click. One per visitor, listing and kind every 10 minutes.
create or replace function public.directory_track(p_directory uuid, p_listing uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, private as $$
declare d public.directories; ip text; h text;
begin
  if p_kind not in ('directory_view', 'view', 'call', 'directions', 'website') then return; end if;
  select * into d from directories where id = p_directory and archived_at is null and status = 'live';
  if not found or not private.directories_on(d.tenant_id) then return; end if;
  if p_listing is not null and not exists (select 1 from directory_listings where id = p_listing and directory_id = d.id and status = 'live' and archived_at is null) then return; end if;
  if p_kind <> 'directory_view' and p_listing is null then return; end if;
  ip := nullif(trim(split_part(coalesce((current_setting('request.headers', true))::json->>'x-forwarded-for', ''), ',', 1)), '');
  if ip is not null then
    h := encode(extensions.digest((select salt from private.directory_secret) || ip, 'sha256'), 'hex');
  end if;
  if h is not null and exists (select 1 from directory_events where ip_hash = h and directory_id = d.id and listing_id is not distinct from p_listing
                                and kind = p_kind and at > now() - interval '10 minutes') then return; end if;
  insert into directory_events (tenant_id, directory_id, listing_id, kind, ip_hash) values (d.tenant_id, d.id, p_listing, p_kind, h);
end $$;

-- stats for the CRM: counts per listing over a window
create or replace function public.directory_stats(p_directory uuid, p_days int default 30) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() and exists (select 1 from directories where id = p_directory and tenant_id = private.current_tenant()) then
    jsonb_build_object(
      'directory_views', (select count(*) from directory_events where directory_id = p_directory and kind = 'directory_view' and at > now() - make_interval(days => greatest(1, least(p_days, 3650)))),
      'listings', coalesce((select jsonb_object_agg(listing_id, k) from (
         select listing_id, jsonb_object_agg(kind, n) k from (
           select listing_id, kind, count(*) n from directory_events
            where directory_id = p_directory and listing_id is not null and at > now() - make_interval(days => greatest(1, least(p_days, 3650)))
            group by 1, 2) a group by 1) b), '{}'::jsonb)) end
$$;

revoke execute on function public.directory_public(text), public.directory_track(uuid, uuid, text), public.directory_stats(uuid, int) from public;
grant execute on function public.directory_public(text), public.directory_track(uuid, uuid, text) to anon, authenticated;
grant execute on function public.directory_stats(uuid, int) to authenticated;
