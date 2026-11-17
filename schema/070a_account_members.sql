-- 070: real membership in more than one account (Oct 30, 2026).
-- Before: a login had one home account. Agency and platform admins could only switch in to look at the accounts they manage.
-- Now: someone can also be a real team member of other accounts (say Julie at GELP joins Demo Home Service Company).
--   * account_members holds the per-account settings for a non-home account: admin, role, divisions, customer facing.
--   * Their home account is untouched. They switch into the other account with the account switcher.
--   * While switched in, is_admin, perm, my_divisions and customer facing read the member row, not the home row.
--   * The client account controls the row: it sees them on Team, changes their role or removes them.
--   * Agency admins (and the platform owner) add people from their own account to an account they manage.
-- If someone both manages an account and is a member of it, managing wins (admin, same as before).

create table if not exists public.account_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  is_admin boolean not null default false,
  role_id uuid references public.roles(id),
  divisions uuid[] not null default '{}',
  customer_facing boolean,
  active boolean not null default true,
  added_by uuid references public.app_users(id),
  added_at timestamptz not null default now(),
  removed_by uuid references public.app_users(id),
  removed_at timestamptz,
  unique (tenant_id, user_id)
);
create index if not exists account_members_user on public.account_members (user_id) where active;
alter table public.account_members enable row level security;
-- read: the account's own team while working in it, and your own memberships. Writes go through the functions in 070c.
create policy "read account members" on public.account_members for select
  using (user_id = auth.uid() or (private.is_internal() and tenant_id = private.current_tenant()));
grant select on public.account_members to authenticated;
revoke insert, update, delete on public.account_members from authenticated, anon;

-- a member row can't point at the person's own home account
create or replace function private.guard_account_member() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if exists (select 1 from app_users where id = new.user_id and tenant_id = new.tenant_id) then
    raise exception 'That is already their home account';
  end if;
  return new;
end $$;
create trigger guard_account_member before insert or update on public.account_members for each row execute function private.guard_account_member();

-- does this person get into this account by managing it (agency admin or platform owner). Same rule current_tenant used before.
create or replace function private.switch_managed(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select u.is_admin and u.active and (
           exists (select 1 from private.platform_owners o where o.user_id = u.id)
           or (exists (select 1 from tenants h where h.id = u.tenant_id and h.is_agency)
               and exists (select 1 from tenants a where a.id = p_tenant and a.agency_tenant_id = u.tenant_id)))
         from app_users u where u.id = p_user), false)
$$;

-- the signed-in person's member row for the account they're working in (no row when home or switched in as a manager)
create or replace function private.ctx_member() returns setof public.account_members
language sql stable security definer set search_path = public, private as $$
  select m.* from app_users u
    join account_members m on m.user_id = u.id and m.tenant_id = u.acting_tenant_id and m.active
   where u.id = auth.uid() and u.active and u.role not in ('vendor', 'member')
     and u.acting_tenant_id is distinct from u.tenant_id
     and not private.switch_managed(u.id, u.acting_tenant_id)
$$;

-- is this person on this account's team: home team or an active member
create or replace function private.on_team(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from app_users u where u.id = p_user and u.active and u.role not in ('vendor', 'member')
    and (u.tenant_id = p_tenant or exists (select 1 from account_members m where m.user_id = u.id and m.tenant_id = p_tenant and m.active)))
$$;

-- admin of this account: the home flag for the home account, the member flag for others
create or replace function private.admin_in(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.tenant_id = p_tenant then u.is_admin
                               else (select m.is_admin from account_members m where m.user_id = u.id and m.tenant_id = p_tenant and m.active) end
                     from app_users u where u.id = p_user and u.active and u.role not in ('vendor', 'member')), false)
$$;

-- customer facing in this account (the per-person switch, else their role there)
create or replace function private.cf_in(p_user uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.tenant_id = p_tenant then private.is_customer_facing(u.id)
                               else (select coalesce(m.customer_facing, r.customer_facing, false) from account_members m
                                       left join roles r on r.id = m.role_id and r.archived_at is null and r.tenant_id = m.tenant_id
                                      where m.user_id = u.id and m.tenant_id = p_tenant and m.active) end
                     from app_users u where u.id = p_user and u.active), false)
$$;

revoke execute on function private.switch_managed(uuid, uuid), private.ctx_member(), private.on_team(uuid, uuid), private.admin_in(uuid, uuid), private.cf_in(uuid, uuid)
  from public, anon;
grant execute on function private.switch_managed(uuid, uuid), private.ctx_member(), private.on_team(uuid, uuid), private.admin_in(uuid, uuid), private.cf_in(uuid, uuid)
  to authenticated;
revoke execute on function private.guard_account_member() from public, anon, authenticated;
