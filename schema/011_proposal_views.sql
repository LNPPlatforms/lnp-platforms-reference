-- 011: proposal view tracking (Oct 16, 2026).
-- Each time the client opens their proposal link, the proposal-view edge function records the version they saw,
-- the time, their IP and an approximate city, state and country from that IP. Views from a browser that is
-- signed in to the CRM (the builder preview, or the team checking the link) are not recorded.

create table if not exists public.proposal_views (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  proposal_id uuid not null references public.proposals(id) on delete cascade,
  version int not null,
  viewed_at timestamptz not null default now(),
  ip text,
  city text,
  region text,
  country text,
  device text
);
create index if not exists proposal_views_proposal on public.proposal_views (proposal_id, viewed_at desc);
alter table public.proposal_views enable row level security;

-- anyone who can see the proposal can see its views
drop policy if exists "read proposal views" on public.proposal_views;
create policy "read proposal views" on public.proposal_views for select
  using (exists (select 1 from public.proposals p where p.id = proposal_views.proposal_id));

revoke all on public.proposal_views from anon, authenticated;
grant select on public.proposal_views to authenticated;
grant select, insert on public.proposal_views to service_role;
