-- 073e: bids, part 3b. Every save of a bid fixes its account, dates and history, then figures distance and score.
create or replace function private.bid_check() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare s private.bid_settings; r jsonb; who uuid := auth.uid();
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.tenant_id := old.tenant_id; new.created_by := old.created_by; new.created_at := old.created_at; new.source := old.source;
    if who is not null and new.owner_id is distinct from old.owner_id and not (private.is_admin() or private.can('bids', 3)) then
      raise exception 'Only someone who can approve bids can hand one to someone else';
    end if;
  elsif who is not null then
    new.tenant_id := private.current_tenant(); new.created_by := who;
    if new.source not in ('manual', 'upload') then new.source := 'manual'; end if;
  end if;
  new.title := trim(new.title);
  if new.company_id is not null and not exists (select 1 from companies where id = new.company_id and tenant_id = new.tenant_id) then
    raise exception 'Organization not found';
  end if;
  if jsonb_typeof(new.answers) <> 'object' then new.answers := '{}'::jsonb; end if;
  if jsonb_typeof(new.price_lines) <> 'array' then new.price_lines := '[]'::jsonb; end if;
  if new.window_start is not null and new.window_end is not null and new.window_end < new.window_start then raise exception 'The work window ends before it starts'; end if;
  if new.site_address is distinct from (case when tg_op = 'UPDATE' then old.site_address end) and new.site_lat is not distinct from (case when tg_op = 'UPDATE' then old.site_lat end) then
    new.site_lat := null; new.site_lng := null;      -- a new address with no new pin: the old pin no longer applies
  end if;
  -- status dates and history
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'submitted' and new.submitted_at is null then new.submitted_at := now(); end if;
    new.closed_at := case when new.status in ('won', 'lost', 'withdrawn') then coalesce(new.closed_at, now()) end;
    if tg_op = 'UPDATE' then
      new.history := coalesce(new.history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'by', who, 'what', 'status', 'from', old.status, 'to', new.status));
    end if;
  end if;
  select * into s from private.bid_settings where tenant_id = new.tenant_id;
  new.distance_mi := private.bid_miles(s.base_lat, s.base_lng, new.site_lat, new.site_lng);
  r := private.bid_score(s, new);
  new.score := (r->>'score')::numeric; new.result := r->>'result'; new.score_parts := r->'parts';
  return new;
end $$;
create trigger bid_check before insert or update on public.bids for each row execute function private.bid_check();

create or replace function private.bid_file_check() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'UPDATE' then new.tenant_id := old.tenant_id; new.bid_id := old.bid_id; new.path := old.path; new.created_at := old.created_at;
  else
    if auth.uid() is not null then new.tenant_id := private.current_tenant(); new.created_by := auth.uid(); new.source := 'upload'; end if;
    if not exists (select 1 from bids where id = new.bid_id and tenant_id = new.tenant_id) then raise exception 'Bid not found'; end if;
    if split_part(new.path, '/', 1) <> new.tenant_id::text then raise exception 'That file is in the wrong folder'; end if;
  end if;
  new.name := left(trim(new.name), 255);
  return new;
end $$;
create trigger bid_file_check before insert or update on public.bid_files for each row execute function private.bid_file_check();
