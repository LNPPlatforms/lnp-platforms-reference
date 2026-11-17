-- 074a: client portal, part 1. Who can sign in to an organization's portal, the internal flags on what the portal
-- can show, the approvals list the change order build fills, and the Client portal feature switch (off by default).
-- Decisions: BACKLOG.md "Oct 30 morning voice decisions", Client portal bullet.
-- No foreign keys to tenants or organizations on purpose, so merging or cleaning up organizations never trips on them.
-- Portal users have NO app_users row, so every CRM rule (is_internal, perm, can, current_tenant) treats them as
-- nobody. Everything they see comes from the portal_* functions (074d to 074m), which check the portal user first.

create table if not exists private.portal_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  company_id uuid not null,
  user_id uuid,                                  -- auth.users id, filled when they create their login
  email text not null check (email ~ '^\S+@\S+\.\S+$'),
  full_name text,
  is_admin boolean not null default false,       -- the client's admin: invites their own people and sets what they see
  perms jsonb not null default '{}'::jsonb,      -- area -> 0 off, 1 view, 2 act; missing means the most that area allows
  invited_by uuid,                               -- a CRM team member
  invited_by_portal uuid,                        -- or the client's admin
  invited_at timestamptz not null default now(),
  invite_sent_at timestamptz,
  accepted_at timestamptz,
  last_seen_at timestamptz,
  removed_at timestamptz,
  removed_by uuid
);
create unique index if not exists portal_users_one on private.portal_users (company_id, lower(email)) where removed_at is null;
create index if not exists portal_users_user on private.portal_users (user_id) where removed_at is null;
create index if not exists portal_users_email on private.portal_users (lower(email)) where removed_at is null;
revoke all on private.portal_users from public, anon, authenticated;

-- what the team can keep out of the portal. Jobs, sent invoices and sent estimates show unless hidden;
-- files and photos follow the account's default (hidden unless shared) unless set one way or the other.
alter table public.jobs add column if not exists portal_hidden boolean not null default false,
  add column if not exists client_note text check (length(client_note) <= 2000);
alter table public.invoices add column if not exists portal_hidden boolean not null default false;
alter table public.proposals add column if not exists portal_hidden boolean not null default false;
alter table public.company_assets add column if not exists portal_share text check (portal_share in ('shared', 'internal'));
alter table public.job_events add column if not exists portal_share text check (portal_share in ('shared', 'internal'));

-- portal messages use the Inbox's chat tables: one conversation per organization, source_ref 'portal'
alter table public.chat_threads add column if not exists portal_company_id uuid;
alter table public.chat_messages add column if not exists portal_user_id uuid;
create unique index if not exists chat_threads_portal_one on public.chat_threads (portal_company_id) where portal_company_id is not null;

-- "Needs your approval": the change order and e-sign build puts rows here (private.portal_approval_add).
-- link: where the client reviews and signs; with no link the portal shows approve and decline buttons.
create table if not exists public.portal_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  company_id uuid not null,
  kind text not null default 'change_order',
  ref_id uuid,
  title text not null check (length(title) between 1 and 200),
  summary text,
  amount numeric,
  link text,
  due_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  portal_hidden boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_portal uuid,
  decided_name text,
  decision_note text
);
create index if not exists portal_approvals_org on public.portal_approvals (company_id, status);
alter table public.portal_approvals enable row level security;
create policy "team sees portal approvals" on public.portal_approvals for select using (private.is_internal() and tenant_id = private.current_tenant());
revoke all on public.portal_approvals from anon, authenticated;
grant select on public.portal_approvals to authenticated;

-- the Client portal switch is off until an account turns it on
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal'))
$$;
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal'))
$$;
revoke execute on function private.feature_on_for(uuid, text) from public, anon, authenticated;
