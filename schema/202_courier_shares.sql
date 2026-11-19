-- 202_courier_shares.sql
-- Explicit, directional, two-sided-approved sharing between accounts.
-- Default is NO sharing: until a share is active, accounts cannot see each other at all.
--
-- Only scope 'job_board' is enforced by this bundle (grantor's network-visible
-- campaigns can be seen and claimed by the grantee's couriers). 'courier_pool',
-- 'ratings' and 'reports_rollup' are reserved names, not wired up yet.
-- Agency access (GI Promotion managing an account) is NOT modelled here: your
-- current_tenant() already handles it via tenants.agency_tenant_id.
--
-- revenue_share_bps = basis points of gross drop value paid to the GRANTEE account
-- (the courier's home account) as a placement fee when its courier works the
-- grantor's job. It is stored now and applied in the payments phase.

create table public.tenant_shares (
  tenant_id           uuid not null default private.current_tenant() references public.tenants(id), -- grantor
  grantee             uuid not null references public.tenants(id),
  scope               text not null check (scope in ('job_board','courier_pool','ratings','reports_rollup')),
  revenue_share_bps   int  not null default 0 check (revenue_share_bps between 0 and 5000),
  status              text not null default 'pending' check (status in ('pending','active','revoked')),
  approved_by_grantor uuid,
  approved_by_grantee uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, grantee, scope),
  check (tenant_id <> grantee)
);

alter table public.tenant_shares enable row level security;
alter table public.tenant_shares force row level security;
revoke all on public.tenant_shares from anon, authenticated;
grant select on public.tenant_shares to authenticated;

create policy "see shares" on public.tenant_shares for select to authenticated
  using ( (select private.dh_enabled())
          and ( tenant_id = (select private.current_tenant())
                or grantee = (select private.current_tenant()) ) );

-- Grantor proposes (or changes) a share. Any change resets the grantee's approval.
create or replace function public.dh_share_grant(p_grantee uuid, p_scope text, p_revenue_share_bps int default 0)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid := private.current_tenant();
begin
  perform private.dh_require_admin();
  if p_grantee is null or p_grantee = v_t then raise exception 'invalid grantee'; end if;
  if not exists (select 1 from public.tenants where id = p_grantee) then raise exception 'unknown account'; end if;
  if p_scope not in ('job_board','courier_pool','ratings','reports_rollup') then raise exception 'unknown scope'; end if;

  insert into public.tenant_shares (tenant_id, grantee, scope, revenue_share_bps, status, approved_by_grantor)
  values (v_t, p_grantee, p_scope, coalesce(p_revenue_share_bps, 0), 'pending', private.dh_me())
  on conflict (tenant_id, grantee, scope) do update
    set revenue_share_bps   = excluded.revenue_share_bps,
        status              = 'pending',
        approved_by_grantor = excluded.approved_by_grantor,
        approved_by_grantee = null,
        updated_at          = now();
end $$;

-- Grantee accepts. Caller's ACTING account must be the grantee.
create or replace function public.dh_share_accept(p_grantor uuid, p_scope text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid := private.current_tenant();
begin
  perform private.dh_require_admin();
  update public.tenant_shares
     set approved_by_grantee = private.dh_me(), status = 'active', updated_at = now()
   where tenant_id = p_grantor and grantee = v_t and scope = p_scope
     and status = 'pending' and approved_by_grantor is not null;
  if not found then raise exception 'no pending share to accept'; end if;
end $$;

-- Either side can revoke at any time. Takes effect immediately for new claims/visibility;
-- a courier who already holds a zone may finish it (assignment-based access is unaffected).
create or replace function public.dh_share_revoke(p_grantor uuid, p_grantee uuid, p_scope text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t uuid := private.current_tenant();
begin
  perform private.dh_require_admin();
  if v_t not in (p_grantor, p_grantee) then raise exception 'not a party to this share' using errcode = '42501'; end if;
  update public.tenant_shares set status = 'revoked', updated_at = now()
   where tenant_id = p_grantor and grantee = p_grantee and scope = p_scope and status <> 'revoked';
  if not found then raise exception 'share not found'; end if;
end $$;

-- Is this campaign shared to my acting account right now?
create or replace function private.dh_job_shared_to_me(p_campaign uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
    from public.dh_campaigns c
    join public.dh_listings  l on l.campaign_id = c.id and l.tenant_id = c.tenant_id
    join public.tenant_shares s on s.tenant_id = c.tenant_id
                               and s.grantee   = private.current_tenant()
                               and s.scope     = 'job_board' and s.status = 'active'
    where c.id = p_campaign
      and c.status in ('open','in_progress')
      and l.visibility = 'network'
      and (l.claim_deadline is null or l.claim_deadline > now())) $$;
revoke execute on function private.dh_job_shared_to_me(uuid) from public, anon;
grant  execute on function private.dh_job_shared_to_me(uuid) to authenticated;

-- Curated, column-limited board of OTHER accounts' shared jobs. Couriers never read
-- another account's dh_campaigns directly. This view intentionally runs as its owner
-- (bypassing RLS) and filters in SQL; security_barrier stops caller predicates leaking rows.
-- Whitelist it in audit query C.
create view public.network_jobs with (security_barrier = true) as
  select c.id as campaign_id, c.tenant_id as owner_tenant_id, c.title, c.trade,
         c.pay_per_drop_cents, c.target_area, l.min_rating, l.claim_deadline,
         (select count(*) from public.dh_zones z
           where z.campaign_id = c.id and z.tenant_id = c.tenant_id and z.status = 'open') as open_zones,
         (select coalesce(sum(z.door_count), 0) from public.dh_zones z
           where z.campaign_id = c.id and z.tenant_id = c.tenant_id and z.status = 'open') as open_doors
  from public.dh_campaigns c
  join public.dh_listings l on l.campaign_id = c.id and l.tenant_id = c.tenant_id
  where private.dh_enabled()
    and c.tenant_id <> private.current_tenant()
    and private.dh_job_shared_to_me(c.id)
    and exists (select 1 from public.dh_zones z
                where z.campaign_id = c.id and z.tenant_id = c.tenant_id and z.status = 'open');

revoke all on public.network_jobs from anon, authenticated;
grant select on public.network_jobs to authenticated;

revoke execute on function public.dh_share_grant(uuid,text,int), public.dh_share_accept(uuid,text),
                           public.dh_share_revoke(uuid,uuid,text) from public, anon;
grant  execute on function public.dh_share_grant(uuid,text,int), public.dh_share_accept(uuid,text),
                           public.dh_share_revoke(uuid,uuid,text) to authenticated;

select private.install_tenant_immutable(array['app_users']) as tables_protected;
