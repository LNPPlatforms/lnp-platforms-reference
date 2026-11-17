-- 073c: bids, part 2b. Files that came with a bid, and who can see and change bids and their files.
create table if not exists public.bid_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  bid_id uuid not null references public.bids(id),
  path text not null check (length(path) between 3 and 500),
  name text not null check (length(name) between 1 and 255),
  size bigint check (size is null or size >= 0),
  mime text check (mime is null or length(mime) <= 200),
  source text not null default 'upload' check (source in ('upload', 'public', 'email')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists bid_files_bid on public.bid_files (bid_id);

alter table public.bids enable row level security;
alter table public.bid_files enable row level security;
create policy "see bids" on public.bids for select using (
  tenant_id = private.current_tenant() and private.bids_see() and private.in_scope('bids', owner_id, divisions));
create policy "add bids" on public.bids for insert with check (
  tenant_id = private.current_tenant() and private.bids_see() and private.can('bids', 2));
create policy "edit bids" on public.bids for update using (
  tenant_id = private.current_tenant() and private.bids_see() and private.can('bids', 2) and private.in_scope('bids', owner_id, divisions))
  with check (tenant_id = private.current_tenant() and private.can('bids', 2));
create policy "see bid files" on public.bid_files for select using (
  tenant_id = private.current_tenant() and exists (select 1 from public.bids b where b.id = bid_id));
create policy "add bid files" on public.bid_files for insert with check (
  tenant_id = private.current_tenant() and private.can('bids', 2) and exists (select 1 from public.bids b where b.id = bid_id)
  and split_part(path, '/', 1) = private.current_tenant()::text);
create policy "edit bid files" on public.bid_files for update using (
  tenant_id = private.current_tenant() and private.can('bids', 2) and exists (select 1 from public.bids b where b.id = bid_id))
  with check (tenant_id = private.current_tenant());

-- people change the plain fields; scores, overrides, Review and history only change through the database
revoke all on public.bids, public.bid_files from anon, authenticated;
grant select on public.bids, public.bid_files to authenticated;
grant insert (title, client_name, company_id, owner_id, divisions, status, source, due_at, window_start, window_end, est_value, est_margin, submitted_amount,
  competitor_notes, notes, site_address, site_lat, site_lng, answers, measurement_id, price_lines) on public.bids to authenticated;
grant update (title, client_name, company_id, owner_id, divisions, status, due_at, window_start, window_end, est_value, est_margin, submitted_amount, submitted_at,
  competitor_notes, notes, outcome_note, site_address, site_lat, site_lng, answers, measurement_id, price_lines, proposal_id, job_id, invoice_id, archived_at) on public.bids to authenticated;
grant insert (bid_id, path, name, size, mime) on public.bid_files to authenticated;
grant update (name, archived_at) on public.bid_files to authenticated;
create trigger audit_bids after insert or update on public.bids for each row execute function private.audit();
create trigger stamp_divisions before insert on public.bids for each row execute function private.stamp_divisions();
