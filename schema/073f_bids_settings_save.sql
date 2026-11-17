-- 073f: bids, part 4b. Saving the scorecard and settings, a new upload link and the platform's email domain.
create or replace function public.bid_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); m jsonb; clean jsonb := '[]'::jsonb; keys text[] := '{}'; k text; kind text; n int := 0;
  go numeric := coalesce((p->>'go_at')::numeric, 70); maybe numeric := coalesce((p->>'maybe_at')::numeric, 45);
begin
  if not private.bids_setup() then raise exception 'Only someone who manages bids can change the scorecard'; end if;
  if jsonb_typeof(coalesce(p->'metrics', '[]'::jsonb)) <> 'array' then raise exception 'The scorecard needs a list'; end if;
  for m in select e from jsonb_array_elements(coalesce(p->'metrics', '[]'::jsonb)) e loop
    n := n + 1; if n > 20 then raise exception 'Keep the scorecard to 20 things or fewer'; end if;
    kind := m->>'kind';
    if kind not in ('value', 'distance', 'margin', 'lead_time', 'crew', 'yesno', 'scale') then raise exception 'Unknown scorecard item %', coalesce(kind, ''); end if;
    k := case when kind in ('value', 'distance', 'margin', 'lead_time', 'crew') then kind else coalesce(nullif(m->>'key', ''), 'q' || substr(md5(random()::text), 1, 8)) end;
    if k !~ '^[a-z][a-z0-9_]{0,30}$' then raise exception 'Bad scorecard key'; end if;
    if k = any(keys) then raise exception 'Each thing can only be on the scorecard once'; end if;
    keys := keys || k;
    if length(trim(coalesce(m->>'label', ''))) not between 1 and 120 then raise exception 'Every scorecard item needs a name (up to 120 characters)'; end if;
    if coalesce((m->>'rank')::int, 0) not between 1 and 3 then raise exception 'Rank each scorecard item 1, 2 or 3'; end if;
    if kind in ('value', 'distance', 'margin', 'lead_time') and (m->>'good' is null or m->>'poor' is null) then raise exception 'Set good and poor for %', m->>'label'; end if;
    clean := clean || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('key', k, 'kind', kind, 'label', trim(m->>'label'), 'rank', (m->>'rank')::int,
      'good', case when kind in ('value', 'distance', 'margin', 'lead_time') then (m->>'good')::numeric end,
      'poor', case when kind in ('value', 'distance', 'margin', 'lead_time') then (m->>'poor')::numeric end,
      'yes_good', case when kind = 'yesno' then coalesce((m->>'yes_good')::boolean, true) end,
      'off', case when coalesce((m->>'off')::boolean, false) then true end)));
  end loop;
  if go not between 0 and 100 or maybe not between 0 and 100 or maybe > go then raise exception 'Go needs a score from 0 to 100, and maybe can''t be higher than go'; end if;
  if p ? 'base_lat' and p->>'base_lat' is not null and ((p->>'base_lat')::float8 not between -90 and 90 or (p->>'base_lng')::float8 not between -180 and 180) then
    raise exception 'That base location is off the map';
  end if;
  insert into private.bid_settings as s (tenant_id, base_address, base_lat, base_lng, geocoded_at, metrics, go_at, maybe_at, override_review, email_on, upload_on, upload_intro, updated_at, updated_by)
  values (t, nullif(trim(coalesce(p->>'base_address', '')), ''), (p->>'base_lat')::float8, (p->>'base_lng')::float8, case when p->>'base_lat' is not null then now() end,
    clean, go, maybe, coalesce((p->>'override_review')::boolean, true), coalesce((p->>'email_on')::boolean, true), coalesce((p->>'upload_on')::boolean, false),
    nullif(trim(coalesce(p->>'upload_intro', '')), ''), now(), auth.uid())
  on conflict (tenant_id) do update set base_address = excluded.base_address, base_lat = excluded.base_lat, base_lng = excluded.base_lng,
    geocoded_at = case when excluded.base_lat is distinct from s.base_lat or excluded.base_lng is distinct from s.base_lng then excluded.geocoded_at else s.geocoded_at end,
    metrics = excluded.metrics, go_at = excluded.go_at, maybe_at = excluded.maybe_at, override_review = excluded.override_review, email_on = excluded.email_on,
    upload_on = excluded.upload_on, upload_intro = excluded.upload_intro, updated_at = now(), updated_by = auth.uid();
  -- rescore what's still open (the bid trigger figures distance and score again)
  update bids set updated_at = now() where tenant_id = t and archived_at is null and status not in ('won', 'lost', 'withdrawn');
  return public.bid_settings_get();
end $$;

-- a new public upload link (the old one stops working)
create or replace function public.bid_upload_link_new() returns text
language plpgsql security definer set search_path = public, private as $$
declare tok text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not private.bids_setup() then raise exception 'Only someone who manages bids can change the upload link'; end if;
  insert into private.bid_settings (tenant_id, upload_token) values (private.current_tenant(), tok)
  on conflict (tenant_id) do update set upload_token = tok, updated_at = now(), updated_by = auth.uid();
  return tok;
end $$;

-- the platform owner sets the email domain once the mail provider is set up (BACKLOG.md, Bids setup)
create or replace function public.bid_intake_domain_set(p_domain text, p_style text default 'plus') returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_owner() then raise exception 'Only the platform owner can set the bid email domain'; end if;
  update private.bid_intake_config set domain = nullif(lower(trim(coalesce(p_domain, ''))), ''), style = coalesce(nullif(p_style, ''), 'plus'), updated_at = now() where id = 1;
  return public.bid_settings_get();
end $$;

revoke execute on function public.bid_settings_get(), public.bid_settings_save(jsonb), public.bid_upload_link_new(), public.bid_intake_domain_set(text, text) from public, anon;
grant execute on function public.bid_settings_get(), public.bid_settings_save(jsonb), public.bid_upload_link_new(), public.bid_intake_domain_set(text, text) to authenticated;
