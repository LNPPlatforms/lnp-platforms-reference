-- 073h: bids, part 6. Intake from outside: RFPs emailed to the account's bid address, and the public upload page.
-- The bid-intake edge function (service key) calls these; nobody signed in can. Files are added after the bid exists.

-- which account an email address belongs to: bids+slug@, bids-slug@, bids.slug@ or slug@ (any +tag after it is ignored)
create or replace function private.bid_tenant_for(p_addr text) returns uuid
language sql stable security definer set search_path = public, private as $$
  with l as (select lower(trim(split_part(regexp_replace(coalesce(p_addr, ''), '^.*<([^>]+)>.*$', '\1'), '@', 1))) a),
  s as (select split_part(case when a ~ '^bids[+.-].+' then substr(a, 6) else a end, '+', 1) slug from l)
  select t.id from tenants t, s where t.slug = s.slug and s.slug <> '' limit 1
$$;
revoke execute on function private.bid_tenant_for(text) from public, anon, authenticated;

create or replace function private.bid_intake_make(t uuid, p_source text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare id uuid; subj text := left(trim(coalesce(p->>'subject', p->>'title', '')), 200); owner uuid;
begin
  if (select count(*) from bids where tenant_id = t and source = p_source and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many bids came in this hour. Try again later.';
  end if;
  -- new bids from outside go to the account's first admin until someone hands them out
  select u.id into owner from app_users u where u.tenant_id = t and u.active and u.is_admin and u.role not in ('vendor', 'member') order by u.id limit 1;
  insert into bids (tenant_id, title, client_name, owner_id, source, from_email, from_name, email_subject, email_body, notes, due_at, created_by)
  values (t, coalesce(nullif(subj, ''), case when p_source = 'email' then 'Emailed bid' else 'Uploaded bid' end),
    nullif(left(trim(coalesce(p->>'company', p->>'from_name', '')), 200), ''), owner, p_source,
    nullif(left(trim(coalesce(p->>'from_email', p->>'email', '')), 320), ''), nullif(left(trim(coalesce(p->>'from_name', p->>'name', '')), 200), ''),
    case when p_source = 'email' then nullif(left(coalesce(p->>'subject', ''), 500), '') end,
    nullif(left(coalesce(p->>'text', ''), 100000), ''),
    nullif(left(trim(concat_ws(E'\n', nullif(p->>'notes', ''), case when nullif(p->>'phone', '') is not null then 'Phone: ' || (p->>'phone') end)), 10000), ''),
    case when coalesce(p->>'due', '') ~ '^\d{4}-\d{2}-\d{2}' then (p->>'due')::date + time '17:00' end, null)
  returning bids.id into id;
  return jsonb_build_object('bid_id', id, 'tenant_id', t);
end $$;
revoke execute on function private.bid_intake_make(uuid, text, jsonb) from public, anon, authenticated;

-- an email came in. p: {to: [addresses], from_email, from_name, subject, text}. Null when no account takes it.
create or replace function public.bid_intake_email(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare a text; t uuid;
begin
  for a in select jsonb_array_elements_text(case when jsonb_typeof(p->'to') = 'array' then p->'to' else jsonb_build_array(p->>'to') end) loop
    t := private.bid_tenant_for(a);
    exit when t is not null;
  end loop;
  if t is null or not private.feature_on_for(t, 'bids') or not coalesce((select email_on from private.bid_settings where tenant_id = t), true) then return null; end if;
  return private.bid_intake_make(t, 'email', p);
end $$;

-- the public upload page. p: {title, name, email, phone, company, due, notes}
create or replace function public.bid_intake_public(p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid;
begin
  select tenant_id into t from private.bid_settings where upload_token = p_token and upload_on and length(p_token) = 64;
  if t is null or not private.feature_on_for(t, 'bids') then raise exception 'This upload page isn''t open'; end if;
  if length(trim(coalesce(p->>'name', ''))) < 1 or coalesce(p->>'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Add your name and email'; end if;
  return private.bid_intake_make(t, 'public', p);
end $$;

-- a file that came with it, already stored in bid-files/<tenant>/<bid>/...
create or replace function public.bid_intake_file(p_bid uuid, p_path text, p_name text, p_size bigint, p_mime text, p_source text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid; id uuid;
begin
  select tenant_id into t from bids where bids.id = p_bid;
  if t is null then raise exception 'Bid not found'; end if;
  insert into bid_files (tenant_id, bid_id, path, name, size, mime, source, created_by)
  values (t, p_bid, p_path, coalesce(nullif(trim(p_name), ''), 'file'), p_size, left(p_mime, 200), case when p_source in ('email', 'public') then p_source else 'email' end, null)
  returning bid_files.id into id;
  return id;
end $$;

-- what the public upload page shows (nothing private)
create or replace function public.bid_upload_info(p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', coalesce((select d.company->>'name' from private.doc_settings d where d.tenant_id = s.tenant_id), t.name), 'intro', s.upload_intro)
  from private.bid_settings s join tenants t on t.id = s.tenant_id
  where s.upload_token = p_token and s.upload_on and length(coalesce(p_token, '')) = 64 and private.feature_on_for(s.tenant_id, 'bids')
$$;

revoke execute on function public.bid_intake_email(jsonb), public.bid_intake_public(text, jsonb), public.bid_intake_file(uuid, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.bid_intake_email(jsonb), public.bid_intake_public(text, jsonb), public.bid_intake_file(uuid, text, text, bigint, text, text) to service_role;
revoke execute on function public.bid_upload_info(text) from public;
grant execute on function public.bid_upload_info(text) to anon, authenticated;
