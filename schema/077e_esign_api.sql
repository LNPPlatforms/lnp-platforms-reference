-- 077e: e-sign, part 5. The envelope API and the team's actions.
--   private.esign_make(account, by, p)   the one generic way to make an envelope. Upload, template and later callers
--                                        (change orders, proposals) all come through it. public.esign_envelope_create
--                                        is the same thing for a signed-in person with E-sign level 2.
--   draft edits, delete, send (prepare as the person, commit from the edge function with the file's SHA-256),
--   remind, void, templates and the account's e-sign settings.

-- ---------- small helpers ----------
create or replace function private.esign_event(p_env uuid, p_signer uuid, p_kind text, p_meta jsonb default '{}'::jsonb, p_by uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public, private as $$
  insert into esign_events (tenant_id, envelope_id, signer_id, kind, name, email, ip, user_agent, device, browser, by_user, detail)
  select e.tenant_id, e.id, s.id, p_kind,
         coalesce(s.name, (select full_name from app_users where id = p_by)), coalesce(s.email, (select email from app_users where id = p_by)),
         left(nullif(p_meta->>'ip', ''), 100), left(nullif(p_meta->>'ua', ''), 1000), left(nullif(p_meta->>'device', ''), 100), left(nullif(p_meta->>'browser', ''), 100),
         p_by, coalesce(p_detail, '{}'::jsonb)
    from esign_envelopes e left join esign_signers s on s.id = p_signer and s.envelope_id = e.id
   where e.id = p_env
$$;

create or replace function private.esign_settings(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'default_message', coalesce((select settings->'esign'->>'default_message' from account_settings where tenant_id = p_tenant), 'Please review and sign this document.'),
    'expires_days', coalesce((select (settings->'esign'->>'expires_days')::int from account_settings where tenant_id = p_tenant), 30))
$$;

-- pages: [{w, h}] in points, at most 300 pages
create or replace function private.esign_clean_pages(p jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare r jsonb := '[]'::jsonb; x jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'::jsonb; end if;
  if jsonb_array_length(p) > 300 then raise exception 'That PDF has too many pages (300 is the most)'; end if;
  for x in select e from jsonb_array_elements(p) e loop
    r := r || jsonb_build_array(jsonb_build_object('w', greatest(1, least(20000, coalesce((x->>'w')::numeric, 612))), 'h', greatest(1, least(20000, coalesce((x->>'h')::numeric, 792)))));
  end loop;
  return r;
end $$;

-- fields: checked against the signer (or role) keys and the page count; numbers kept inside the page
create or replace function private.esign_clean_fields(p jsonb, p_keys text[], p_pages int) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare r jsonb := '[]'::jsonb; f jsonb; t text; k text; pg int; x numeric; y numeric; w numeric; h numeric; ids text[] := '{}'; fid text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'::jsonb; end if;
  if jsonb_array_length(p) > 500 then raise exception 'That''s too many fields (500 is the most)'; end if;
  for f in select e from jsonb_array_elements(p) e loop
    t := f->>'type'; k := f->>'signer';
    if t not in ('signature', 'initials', 'date', 'text', 'checkbox', 'name') then raise exception 'Unknown field type: %', coalesce(t, 'none'); end if;
    if k is null or not (k = any(p_keys)) then raise exception 'A field points at a signer that isn''t on this document'; end if;
    pg := coalesce((f->>'page')::int, 1);
    if pg < 1 or pg > greatest(p_pages, 1) then raise exception 'A field is on a page this PDF doesn''t have'; end if;
    w := greatest(0.005, least(1, coalesce((f->>'w')::numeric, 0.2))); h := greatest(0.005, least(1, coalesce((f->>'h')::numeric, 0.05)));
    x := greatest(0, least(1 - w, coalesce((f->>'x')::numeric, 0))); y := greatest(0, least(1 - h, coalesce((f->>'y')::numeric, 0)));
    fid := coalesce(nullif(left(regexp_replace(coalesce(f->>'id', ''), '[^A-Za-z0-9_-]', '', 'g'), 40), ''), replace(gen_random_uuid()::text, '-', ''));
    if fid = any(ids) then fid := replace(gen_random_uuid()::text, '-', ''); end if;
    ids := ids || fid;
    r := r || jsonb_build_array(jsonb_build_object('id', fid, 'signer', k, 'type', t, 'page', pg,
      'x', round(x, 5), 'y', round(y, 5), 'w', round(w, 5), 'h', round(h, 5),
      'required', case when t in ('date', 'name') then true else coalesce((f->>'required')::boolean, t in ('signature', 'initials')) end,
      'label', left(nullif(trim(coalesce(f->>'label', '')), ''), 100)));
  end loop;
  return r;
end $$;

-- a file in this account's folder of the e-sign bucket
create or replace function private.esign_path_ok(p_tenant uuid, p_path text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(split_part(p_path, '/', 1) = p_tenant::text and p_path !~ '\.\.' and p_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_. /-]+$', false)
$$;

-- whose turn it is: everyone who hasn't signed, or with a signing order the lowest order still waiting
create or replace function private.esign_turn(p_env uuid) returns setof public.esign_signers
language sql stable security definer set search_path = public, private as $$
  select s.* from esign_signers s join esign_envelopes e on e.id = s.envelope_id
   where s.envelope_id = p_env and s.signed_at is null and s.declined_at is null
     and (not e.ordered or s.sign_order = (select min(sign_order) from esign_signers x where x.envelope_id = p_env and x.signed_at is null))
$$;

-- the CRM record behind it, for the timeline: the organization and person, through a job or deal when that's what it's on
create or replace function private.esign_emit(p_env uuid, p_kind text, p_title text) returns void
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes; co uuid; pe uuid;
begin
  select * into e from esign_envelopes where id = p_env;
  co := coalesce(e.company_id, (select company_id from jobs where id = e.job_id), (select company_id from opportunities where id = e.opportunity_id));
  pe := coalesce(e.person_id, (select person_id from jobs where id = e.job_id));
  if co is null and pe is null then return; end if;
  perform private.emit(e.tenant_id, p_kind, p_title, pe, co, jsonb_build_object('envelope_id', e.id, 'job_id', e.job_id, 'deal_id', e.opportunity_id));
exception when others then return;   -- the timeline never blocks e-sign
end $$;

-- who an email comes from and how it looks (the edge functions read this)
create or replace function private.esign_mail(p_env uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'message', e.message, 'status', e.status, 'tenant_id', e.tenant_id,
    'account', t.name, 'brand', private.doc_brand(e.tenant_id), 'from_name', coalesce(private.doc_brand(e.tenant_id)->>'name', t.name),
    'domain', private.brand_of(e.tenant_id)->>'domain', 'support_email', private.brand_of(e.tenant_id)->>'support_email',
    'sender', (select jsonb_build_object('name', u.full_name, 'email', u.email) from app_users u where u.id = e.owner_id),
    'expires_at', e.expires_at, 'completed_at', e.completed_at, 'final_path', e.final_path, 'final_sha256', e.final_sha256)
  from esign_envelopes e join tenants t on t.id = e.tenant_id where e.id = p_env
$$;

-- an envelope this person can work on
create or replace function private.esign_mine(p_id uuid) returns public.esign_envelopes
language sql stable security definer set search_path = public, private as $$
  select e.* from esign_envelopes e where e.id = p_id and e.tenant_id = private.current_tenant() and private.esign_see()
     and private.in_scope('esign', e.owner_id, e.divisions) and e.archived_at is null
$$;
revoke execute on function private.esign_event(uuid, uuid, text, jsonb, uuid, jsonb), private.esign_settings(uuid), private.esign_turn(uuid), private.esign_emit(uuid, text, text),
  private.esign_mail(uuid), private.esign_mine(uuid) from public, anon, authenticated;

-- ---------- signers: replace a draft's signers, keeping rows (and their links) for keys that stay ----------
create or replace function private.esign_put_signers(p_env uuid, p jsonb) returns text[]
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes; s jsonb; n int := 0; k text; keys text[] := '{}'; em text; nm text;
begin
  select * into e from esign_envelopes where id = p_env;
  if p is null or jsonb_typeof(p) <> 'array' then p := '[]'::jsonb; end if;
  if jsonb_array_length(p) > 20 then raise exception 'Twenty signers is the most on one document'; end if;
  for s in select x from jsonb_array_elements(p) x loop
    n := n + 1;
    k := lower(coalesce(nullif(regexp_replace(coalesce(s->>'key', ''), '[^A-Za-z0-9_]', '', 'g'), ''), 's' || n));
    if k = any(keys) then raise exception 'Two signers have the same spot'; end if;
    nm := trim(coalesce(s->>'name', '')); em := lower(trim(coalesce(s->>'email', '')));
    if nm = '' then raise exception 'Add a name for signer %', n; end if;
    if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Add a good email for %', nm; end if;
    keys := keys || k;
    insert into esign_signers (tenant_id, envelope_id, key, role_label, name, email, phone, sign_order)
    values (e.tenant_id, e.id, k, left(nullif(trim(coalesce(s->>'role_label', '')), ''), 100), left(nm, 200), em,
            left(nullif(trim(coalesce(s->>'phone', '')), ''), 40), greatest(1, least(50, coalesce((s->>'order')::int, n))))
    on conflict (envelope_id, key) do update set role_label = excluded.role_label, name = excluded.name, email = excluded.email,
      phone = excluded.phone, sign_order = excluded.sign_order;
  end loop;
  delete from esign_signers where envelope_id = e.id and not (key = any(keys));
  return keys;
end $$;
revoke execute on function private.esign_put_signers(uuid, jsonb) from public, anon, authenticated;

-- the CRM links have to be in the same account
create or replace function private.esign_links_ok(p_tenant uuid, p jsonb) returns void
language plpgsql stable security definer set search_path = public, private as $$
begin
  if nullif(p->>'company_id', '') is not null and not exists (select 1 from companies where id = (p->>'company_id')::uuid and tenant_id = p_tenant) then raise exception 'That organization isn''t in this account'; end if;
  if nullif(p->>'person_id', '') is not null and not exists (select 1 from people where id = (p->>'person_id')::uuid and tenant_id = p_tenant) then raise exception 'That person isn''t in this account'; end if;
  if nullif(p->>'job_id', '') is not null and not exists (select 1 from jobs where id = (p->>'job_id')::uuid and tenant_id = p_tenant) then raise exception 'That job isn''t in this account'; end if;
  if nullif(p->>'opportunity_id', '') is not null and not exists (select 1 from opportunities where id = (p->>'opportunity_id')::uuid and tenant_id = p_tenant) then raise exception 'That deal isn''t in this account'; end if;
end $$;
revoke execute on function private.esign_links_ok(uuid, jsonb) from public, anon, authenticated;

-- ---------- the generic envelope API ----------
-- p: {title, message, file_path, file_name, file_size, pages, fields, ordered, signers: [{key, name, email, phone, order, role_label}],
--     template_id, company_id, person_id, job_id, opportunity_id, ref_kind, ref_id, source}
-- From a template: the file, pages, fields, order and message come from the template and each signer's key is a role key.
create or replace function private.esign_make(p_tenant uuid, p_by uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare tp esign_templates; v_id uuid; keys text[]; fp text; fname text; fsize bigint; v_pages jsonb; v_fields jsonb; ord boolean; msg text; src text; r jsonb; sg jsonb := coalesce(p->'signers', '[]'::jsonb);
begin
  if p_tenant is null then raise exception 'No account'; end if;
  if nullif(p->>'template_id', '') is not null then
    select * into tp from esign_templates where esign_templates.id = (p->>'template_id')::uuid and tenant_id = p_tenant and archived_at is null;
    if not found then raise exception 'That template isn''t here anymore'; end if;
    fp := tp.file_path; fname := tp.file_name; fsize := tp.file_size; v_pages := tp.pages; v_fields := tp.fields; ord := coalesce((p->>'ordered')::boolean, tp.ordered);
    msg := coalesce(nullif(p->>'message', ''), tp.message); src := 'template';
    -- each role on the template needs a person; the role's label and order come along
    for r in select x from jsonb_array_elements(tp.roles) x loop
      if not exists (select 1 from jsonb_array_elements(sg) s where s->>'key' = r->>'key') then raise exception 'Fill in who signs as %', r->>'label'; end if;
    end loop;
    select coalesce(jsonb_agg(sx.v || jsonb_build_object('role_label', coalesce(nullif(sx.v->>'role_label', ''), rx.v->>'label'), 'order', coalesce((sx.v->>'order')::int, (rx.v->>'order')::int))), '[]'::jsonb)
      into sg from jsonb_array_elements(sg) sx(v) left join jsonb_array_elements(tp.roles) rx(v) on rx.v->>'key' = sx.v->>'key';
  else
    fp := p->>'file_path'; fname := left(coalesce(nullif(trim(p->>'file_name'), ''), 'document.pdf'), 255); fsize := nullif(p->>'file_size', '')::bigint;
    v_pages := private.esign_clean_pages(p->'pages'); v_fields := coalesce(p->'fields', '[]'::jsonb); ord := coalesce((p->>'ordered')::boolean, false);
    msg := p->>'message'; src := case when p->>'source' in ('upload', 'api') then p->>'source' else 'upload' end;
    if not private.esign_path_ok(p_tenant, fp) then raise exception 'Upload the PDF first'; end if;
  end if;
  perform private.esign_links_ok(p_tenant, p);
  insert into esign_envelopes (tenant_id, title, message, source, template_id, ref_kind, ref_id, company_id, person_id, job_id, opportunity_id, ordered,
    file_path, file_name, file_size, pages, owner_id, created_by, divisions)
  values (p_tenant, left(coalesce(nullif(trim(p->>'title'), ''), tp.name, regexp_replace(fname, '\.pdf$', '', 'i'), 'Document'), 200),
    left(coalesce(nullif(trim(msg), ''), private.esign_settings(p_tenant)->>'default_message'), 5000), src, tp.id,
    nullif(p->>'ref_kind', ''), nullif(p->>'ref_id', '')::uuid, nullif(p->>'company_id', '')::uuid, nullif(p->>'person_id', '')::uuid,
    nullif(p->>'job_id', '')::uuid, nullif(p->>'opportunity_id', '')::uuid, ord, fp, fname, fsize, v_pages, p_by, p_by,
    coalesce((select divisions from companies where companies.id = nullif(p->>'company_id', '')::uuid), '{}'))
  returning esign_envelopes.id into v_id;
  keys := private.esign_put_signers(v_id, sg);
  update esign_envelopes set fields = private.esign_clean_fields(v_fields, keys, jsonb_array_length(v_pages)) where esign_envelopes.id = v_id;
  perform private.esign_event(v_id, null, 'created', '{}'::jsonb, p_by, jsonb_build_object('source', src, 'template', tp.name, 'ref_kind', nullif(p->>'ref_kind', '')));
  return v_id;
end $$;
revoke execute on function private.esign_make(uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.esign_envelope_create(p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.esign_see() and private.can('esign', 2)) then raise exception 'Your role can''t send documents to sign'; end if;
  return private.esign_make(private.current_tenant(), auth.uid(), p);
end $$;

-- change a draft. Any key left out stays as it was.
create or replace function public.esign_envelope_update(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id); keys text[];
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) then raise exception 'Your role can''t change documents to sign'; end if;
  if e.status <> 'draft' then raise exception 'It''s already been sent. Void it and send a new one to change it.'; end if;
  perform private.esign_links_ok(e.tenant_id, p);
  if p ? 'signers' then keys := private.esign_put_signers(e.id, p->'signers'); else select array_agg(key) into keys from esign_signers where envelope_id = e.id; end if;
  update esign_envelopes set
    title = case when p ? 'title' then left(coalesce(nullif(trim(p->>'title'), ''), title), 200) else title end,
    message = case when p ? 'message' then left(nullif(trim(p->>'message'), ''), 5000) else message end,
    ordered = coalesce((p->>'ordered')::boolean, ordered),
    company_id = case when p ? 'company_id' then nullif(p->>'company_id', '')::uuid else company_id end,
    person_id = case when p ? 'person_id' then nullif(p->>'person_id', '')::uuid else person_id end,
    job_id = case when p ? 'job_id' then nullif(p->>'job_id', '')::uuid else job_id end,
    opportunity_id = case when p ? 'opportunity_id' then nullif(p->>'opportunity_id', '')::uuid else opportunity_id end,
    pages = case when p ? 'pages' and jsonb_array_length(coalesce(p->'pages', '[]')) > 0 then private.esign_clean_pages(p->'pages') else pages end,
    updated_at = now()
  where id = e.id;
  select * into e from esign_envelopes where id = p_id;
  update esign_envelopes set fields = private.esign_clean_fields(case when p ? 'fields' then p->'fields' else
      (select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(e.fields) f where f->>'signer' = any(coalesce(keys, '{}'))) end,
      coalesce(keys, '{}'), jsonb_array_length(e.pages)) where id = e.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.esign_envelope_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id);
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) then raise exception 'Your role can''t change documents to sign'; end if;
  if e.status <> 'draft' then raise exception 'Only drafts can be deleted. Void it instead.'; end if;
  update esign_envelopes set archived_at = now() where id = e.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- send ----------
-- 1. as the person: is it ready, and where's the file (the edge function reads it and takes its SHA-256)
create or replace function public.esign_send_prepare(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id); s esign_signers;
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) then raise exception 'Your role can''t send documents to sign'; end if;
  if e.status <> 'draft' then raise exception 'It''s already been sent'; end if;
  if not exists (select 1 from esign_signers where envelope_id = e.id) then raise exception 'Add who signs first'; end if;
  for s in select * from esign_signers where envelope_id = e.id order by sign_order, created_at loop
    if not exists (select 1 from jsonb_array_elements(e.fields) f where f->>'signer' = s.key and f->>'type' = 'signature') then
      raise exception '% needs a place to sign. Add a signature field for them.', s.name;
    end if;
  end loop;
  if not private.esign_path_ok(e.tenant_id, e.file_path) then raise exception 'The PDF is missing'; end if;
  return jsonb_build_object('id', e.id, 'tenant_id', e.tenant_id, 'file_path', e.file_path, 'by', auth.uid());
end $$;

-- 2. from the edge function (service key) with the file's fingerprint: lock it, mark it sent and say who to email now
create or replace function public.esign_send_commit(p_id uuid, p_sha text, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes; days int; ap uuid; tok text; who uuid;
begin
  select * into e from esign_envelopes where id = p_id for update;
  if not found or e.archived_at is not null then raise exception 'Document not found'; end if;
  if e.status <> 'draft' then raise exception 'It''s already been sent'; end if;
  if coalesce(p_sha, '') !~ '^[a-f0-9]{64}$' then raise exception 'Bad fingerprint'; end if;
  days := greatest(1, least(365, (private.esign_settings(e.tenant_id)->>'expires_days')::int));
  update esign_envelopes set status = 'sent', original_sha256 = p_sha, sent_at = now(), expires_at = now() + make_interval(days => days), updated_at = now() where id = e.id;
  update esign_signers set status = 'sent', invited_at = now(), last_sent_at = now() where id in (select id from private.esign_turn(e.id));
  perform private.esign_event(e.id, null, 'sent', '{}'::jsonb, p_by, jsonb_build_object('original_sha256', p_sha, 'file', e.file_name));
  perform private.esign_emit(e.id, 'esign_sent', 'Sent to sign: ' || e.title);
  -- client portal: a "Needs your approval" row that opens the signing page (the signer who has a portal login, else the first one)
  if e.company_id is not null and private.feature_on_for(e.tenant_id, 'portal') then
    select s.token, pu.id into tok, who from esign_signers s left join private.portal_users pu on pu.company_id = e.company_id and pu.removed_at is null and lower(pu.email) = s.email
     where s.envelope_id = e.id order by (pu.id is not null) desc, s.sign_order, s.created_at limit 1;
    if exists (select 1 from private.portal_users where company_id = e.company_id and tenant_id = e.tenant_id and removed_at is null) then
      ap := private.portal_approval_add(e.tenant_id, e.company_id, 'esign', e.id, left('Sign: ' || e.title, 200), e.message, null, '/sign/?t=' || tok, e.sent_at + make_interval(days => days), p_by);
      update esign_envelopes set portal_approval_id = ap where id = e.id;
    end if;
  end if;
  return jsonb_build_object('mail', private.esign_mail(e.id),
    'to', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'email', s.email, 'token', s.token) order by s.sign_order), '[]'::jsonb)
             from esign_signers s where s.envelope_id = e.id and s.status = 'sent'));
end $$;

-- ---------- remind (or send again) the people whose turn it is, or one of them ----------
create or replace function public.esign_remind(p_id uuid, p_signer uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id); ids uuid[];
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) then raise exception 'Your role can''t send documents to sign'; end if;
  if e.status not in ('sent', 'viewed', 'partly_signed') then raise exception 'Nobody''s waiting on this one'; end if;
  if e.expires_at < now() then raise exception 'This one expired. Void it and send a new one.'; end if;
  select array_agg(t.id) into ids from private.esign_turn(e.id) t
   where (p_signer is null or t.id = p_signer) and (t.last_sent_at is null or t.last_sent_at < now() - interval '1 minute');
  if ids is null then
    if p_signer is not null and not exists (select 1 from private.esign_turn(e.id) t where t.id = p_signer) then raise exception 'It isn''t their turn yet, or they already signed'; end if;
    raise exception 'That just went out. Give it a minute.';
  end if;
  update esign_signers set status = case when status = 'waiting' then 'sent' else status end, invited_at = coalesce(invited_at, now()),
    last_sent_at = now(), reminders = reminders + 1 where id = any(ids);
  perform private.esign_event(e.id, x, 'reminded', '{}'::jsonb, auth.uid()) from unnest(ids) x;
  return jsonb_build_object('mail', private.esign_mail(e.id), 'reminder', true,
    'to', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'email', s.email, 'token', s.token)), '[]'::jsonb) from esign_signers s where s.id = any(ids)));
end $$;

-- ---------- void ----------
create or replace function public.esign_void(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id); why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) or not (e.owner_id = auth.uid() or private.is_admin() or private.can('esign', 3)) then raise exception 'Your role can''t void this one'; end if;
  if e.status in ('draft') then raise exception 'It hasn''t been sent. Delete the draft instead.'; end if;
  if e.status in ('completed', 'voided') then raise exception 'It''s already %', case e.status when 'completed' then 'signed by everyone' else 'void' end; end if;
  if why is null then raise exception 'Say why you''re voiding it'; end if;
  update esign_envelopes set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = left(why, 1000), updated_at = now() where id = e.id;
  update portal_approvals set status = 'withdrawn' where id = e.portal_approval_id and status = 'pending';
  perform private.esign_event(e.id, null, 'voided', '{}'::jsonb, auth.uid(), jsonb_build_object('reason', why));
  perform private.esign_emit(e.id, 'esign_voided', 'Voided: ' || e.title);
  return jsonb_build_object('ok', true);
end $$;

-- everyone signed but the signed copy didn't get made (the edge function retries with the service key)
create or replace function public.esign_finish_check(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes := private.esign_mine(p_id);
begin
  if e.id is null then raise exception 'Document not found'; end if;
  if not private.can('esign', 2) then raise exception 'Your role can''t do that'; end if;
  if e.status = 'completed' then raise exception 'It''s already done'; end if;
  if e.status in ('draft', 'voided', 'declined') or exists (select 1 from esign_signers where envelope_id = e.id and signed_at is null) then raise exception 'Not everyone has signed yet'; end if;
  return jsonb_build_object('id', e.id, 'ok', true);
end $$;

-- ---------- templates ----------
-- p: {id?, name, description, message, file_path, file_name, file_size, pages, roles: [{key, label, order}], fields, ordered}
create or replace function public.esign_template_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); tp esign_templates; v_id uuid := nullif(p->>'id', '')::uuid; v_roles jsonb := '[]'::jsonb; r jsonb; k text; keys text[] := '{}'; n int := 0; v_pages jsonb;
begin
  if not (private.esign_see() and private.can('esign', 2)) then raise exception 'Your role can''t make templates'; end if;
  if v_id is not null then
    select * into tp from esign_templates where esign_templates.id = v_id and tenant_id = t and archived_at is null;
    if not found then raise exception 'Template not found'; end if;
    if not (tp.owner_id = auth.uid() or private.is_admin() or private.can('esign', 3)) then raise exception 'Only whoever made it (or a manager) can change this template'; end if;
  elsif not private.esign_path_ok(t, p->>'file_path') then raise exception 'Upload the PDF first';
  end if;
  for r in select x from jsonb_array_elements(coalesce(case when p ? 'roles' then p->'roles' end, tp.roles, '[{"key":"client","label":"Client"}]'::jsonb)) x loop
    n := n + 1;
    k := lower(coalesce(nullif(regexp_replace(coalesce(r->>'key', ''), '[^A-Za-z0-9_]', '', 'g'), ''), 'r' || n));
    if k = any(keys) then raise exception 'Two roles have the same name'; end if;
    if length(trim(coalesce(r->>'label', ''))) < 1 then raise exception 'Name each role (like Client or Company rep)'; end if;
    keys := keys || k;
    v_roles := v_roles || jsonb_build_array(jsonb_build_object('key', k, 'label', left(trim(r->>'label'), 100), 'order', greatest(1, least(50, coalesce((r->>'order')::int, n)))));
  end loop;
  if n = 0 then raise exception 'Add at least one role'; end if;
  if n > 20 then raise exception 'Twenty roles is the most'; end if;
  v_pages := case when v_id is null or (p ? 'pages' and jsonb_array_length(coalesce(p->'pages', '[]')) > 0) then private.esign_clean_pages(p->'pages') else tp.pages end;
  if v_id is null then
    insert into esign_templates (tenant_id, name, description, message, file_path, file_name, file_size, pages, roles, fields, ordered)
    values (t, left(coalesce(nullif(trim(p->>'name'), ''), regexp_replace(coalesce(p->>'file_name', 'Template'), '\.pdf$', '', 'i')), 200),
      left(nullif(trim(p->>'description'), ''), 2000), left(nullif(trim(p->>'message'), ''), 5000), p->>'file_path',
      left(coalesce(nullif(trim(p->>'file_name'), ''), 'document.pdf'), 255), nullif(p->>'file_size', '')::bigint, v_pages, v_roles,
      private.esign_clean_fields(coalesce(p->'fields', '[]'::jsonb), keys, jsonb_array_length(v_pages)), coalesce((p->>'ordered')::boolean, false))
    returning esign_templates.id into v_id;
  else
    update esign_templates set name = case when p ? 'name' then left(coalesce(nullif(trim(p->>'name'), ''), name), 200) else name end,
      description = case when p ? 'description' then left(nullif(trim(p->>'description'), ''), 2000) else description end,
      message = case when p ? 'message' then left(nullif(trim(p->>'message'), ''), 5000) else message end,
      pages = v_pages, roles = v_roles, ordered = coalesce((p->>'ordered')::boolean, ordered),
      fields = private.esign_clean_fields(case when p ? 'fields' then p->'fields' else
        (select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(tp.fields) f where f->>'signer' = any(keys)) end, keys, jsonb_array_length(v_pages)),
      updated_at = now()
    where esign_templates.id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.esign_template_archive(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare tp esign_templates;
begin
  select * into tp from esign_templates where id = p_id and tenant_id = private.current_tenant() and archived_at is null;
  if not found or not private.esign_see() then raise exception 'Template not found'; end if;
  if not (private.can('esign', 2) and (tp.owner_id = auth.uid() or private.is_admin() or private.can('esign', 3))) then raise exception 'Only whoever made it (or a manager) can remove this template'; end if;
  update esign_templates set archived_at = now() where id = tp.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- account settings (Tools, Admin, E-sign) ----------
create or replace function public.esign_settings_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then private.esign_settings(private.current_tenant())
    || jsonb_build_object('can_edit', private.esign_setup(), 'on', private.feature_on('esign')) end
$$;
create or replace function public.esign_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant();
begin
  if not private.esign_setup() then raise exception 'Only an admin can change e-sign settings'; end if;
  insert into account_settings (tenant_id, settings) values (t, '{}'::jsonb) on conflict (tenant_id) do nothing;
  update account_settings set settings = settings || jsonb_build_object('esign', jsonb_build_object(
      'default_message', left(coalesce(nullif(trim(p->>'default_message'), ''), 'Please review and sign this document.'), 2000),
      'expires_days', greatest(1, least(365, coalesce(nullif(p->>'expires_days', '')::int, 30))))),
    updated_at = now(), updated_by = auth.uid() where tenant_id = t;
  return public.esign_settings_get();
end $$;

revoke execute on function public.esign_envelope_create(jsonb), public.esign_envelope_update(uuid, jsonb), public.esign_envelope_delete(uuid),
  public.esign_send_prepare(uuid), public.esign_remind(uuid, uuid), public.esign_void(uuid, text), public.esign_finish_check(uuid),
  public.esign_template_save(jsonb), public.esign_template_archive(uuid), public.esign_settings_get(), public.esign_settings_save(jsonb) from public, anon;
grant execute on function public.esign_envelope_create(jsonb), public.esign_envelope_update(uuid, jsonb), public.esign_envelope_delete(uuid),
  public.esign_send_prepare(uuid), public.esign_remind(uuid, uuid), public.esign_void(uuid, text), public.esign_finish_check(uuid),
  public.esign_template_save(jsonb), public.esign_template_archive(uuid), public.esign_settings_get(), public.esign_settings_save(jsonb) to authenticated;
revoke execute on function public.esign_send_commit(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.esign_send_commit(uuid, text, uuid) to service_role;
