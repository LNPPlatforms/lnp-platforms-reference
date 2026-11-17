-- 077f: e-sign, part 6. The signing page. Every call comes through the esign-sign edge function (service key), which
-- adds who's calling (IP, user agent, device and browser) as p_meta. A signer's link code (token) opens only that
-- signer's place on that one envelope. Steps: view, agree to sign electronically, get a 6 digit code by email
-- (10 minutes, 5 tries, 5 codes an hour), check it (gives a signing session), sign or decline.
-- When the last person signs, the edge function builds the signed PDF and calls esign_finish.
-- The public check (/sign/?verify=1) looks a SHA-256 up with esign_verify; nothing else is open to anon.

create or replace function private.esign_by_token(p_token text) returns public.esign_signers
language sql stable security definer set search_path = public, private as $$
  select s.* from esign_signers s join esign_envelopes e on e.id = s.envelope_id
   where length(coalesce(p_token, '')) = 64 and s.token = p_token and e.status <> 'draft' and e.archived_at is null
$$;

-- what this signer can do right now
create or replace function private.esign_state(e public.esign_envelopes, s public.esign_signers) returns text
language sql stable security definer set search_path = public, private as $$
  select case
    when e.status = 'voided' then 'voided'
    when e.status = 'completed' then 'completed'
    when e.status = 'declined' then 'declined'
    when s.signed_at is not null then 'signed'
    when e.expires_at < now() then 'expired'
    when not exists (select 1 from private.esign_turn(e.id) t where t.id = s.id) then 'waiting'
    else 'open' end
$$;

create or replace function private.esign_need_open(p_token text, out e public.esign_envelopes, out s public.esign_signers)
language plpgsql security definer set search_path = public, private as $$
declare st text;
begin
  s := private.esign_by_token(p_token);
  if s.id is null then raise exception 'This signing link isn''t right. Check the email you were sent.'; end if;
  select * into e from esign_envelopes where id = s.envelope_id for update;
  st := private.esign_state(e, s);
  if st <> 'open' then raise exception '%', case st when 'voided' then 'The sender voided this document.' when 'completed' then 'Everyone has signed this one.'
    when 'declined' then 'This document was declined.' when 'signed' then 'You already signed this.' when 'expired' then 'This signing link expired. Ask the sender for a new one.'
    else 'It isn''t your turn yet. We''ll email you when it is.' end;
  end if;
end $$;
revoke execute on function private.esign_by_token(text), private.esign_state(public.esign_envelopes, public.esign_signers), private.esign_need_open(text) from public, anon, authenticated;

-- ---------- view ----------
create or replace function public.esign_sign_view(p_token text, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare s esign_signers := private.esign_by_token(p_token); e esign_envelopes; st text;
begin
  if s.id is null then return null; end if;
  select * into e from esign_envelopes where id = s.envelope_id;
  st := private.esign_state(e, s);
  if st = 'open' then
    if s.viewed_at is null then
      update esign_signers set viewed_at = clock_timestamp(), status = 'viewed' where id = s.id;
      update esign_envelopes set status = 'viewed', updated_at = now() where id = e.id and status = 'sent';
    end if;
    -- one viewed line per signer per 10 minutes is plenty
    if not exists (select 1 from esign_events where signer_id = s.id and kind = 'viewed' and at > now() - interval '10 minutes') then
      perform private.esign_event(e.id, s.id, 'viewed', p_meta);
    end if;
    select * into s from esign_signers where id = s.id;
  end if;
  return jsonb_build_object('state', st, 'envelope_id', e.id, 'title', e.title, 'message', e.message, 'file_name', e.file_name,
    'file_path', case when st in ('open', 'signed', 'waiting') then e.file_path end,
    'final_path', case when st = 'completed' then e.final_path end, 'final_sha256', case when st = 'completed' then e.final_sha256 end,
    'pages', e.pages, 'void_reason', case when st = 'voided' then e.void_reason end, 'expires_at', e.expires_at, 'completed_at', e.completed_at,
    'fields', case when st = 'open' then (select coalesce(jsonb_agg(f), '[]'::jsonb) from jsonb_array_elements(e.fields) f where f->>'signer' = s.key) else '[]'::jsonb end,
    'signer', jsonb_build_object('name', s.name, 'email', s.email, 'has_phone', s.phone is not null, 'consent_at', s.consent_at, 'signed_at', s.signed_at, 'declined', s.declined_at is not null),
    'others', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'signed', x.signed_at is not null) order by x.sign_order, x.created_at), '[]'::jsonb)
                 from esign_signers x where x.envelope_id = e.id and x.id <> s.id),
    'mail', private.esign_mail(e.id) - 'final_path' - 'tenant_id');
end $$;

-- ---------- agree to do business electronically ----------
create or replace function public.esign_sign_consent(p_token text, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x record;
begin
  select * into x from private.esign_need_open(p_token);
  update esign_signers set consent_at = coalesce(consent_at, clock_timestamp()) where id = (x.s).id;
  perform private.esign_event((x.e).id, (x.s).id, 'consented', p_meta, null, jsonb_build_object('wording', 'esign_consent_v1'));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- the one-time code ----------
-- channel: email today. 'sms' is the seam for texting codes once a texting provider is set up.
create or replace function public.esign_sign_code(p_token text, p_meta jsonb default '{}'::jsonb, p_channel text default 'email') returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x record; code text; last timestamptz;
begin
  select * into x from private.esign_need_open(p_token);
  if (x.s).consent_at is null then raise exception 'Agree to sign electronically first'; end if;
  if coalesce(p_channel, 'email') <> 'email' then raise exception 'Codes by text aren''t set up yet. We''ll email it.'; end if;
  select max(created_at) into last from private.esign_codes where signer_id = (x.s).id;
  if last > clock_timestamp() - interval '30 seconds' then raise exception 'We just sent a code. Give it a few seconds, then check your spam folder too.'; end if;
  if (select count(*) from private.esign_codes where signer_id = (x.s).id and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'That''s a lot of codes. Wait a bit and try again.';
  end if;
  -- six digits from a random uuid (the server's strong random source)
  code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update private.esign_codes set used_at = clock_timestamp() where signer_id = (x.s).id and used_at is null;   -- only the newest code works
  insert into private.esign_codes (signer_id, code_hash, channel, sent_to, expires_at)
  values ((x.s).id, encode(extensions.digest(code || ':' || (x.s).id::text, 'sha256'), 'hex'), 'email', (x.s).email, clock_timestamp() + interval '10 minutes');
  perform private.esign_event((x.e).id, (x.s).id, 'code_sent', p_meta, null, jsonb_build_object('channel', 'email', 'to', (x.s).email));
  return jsonb_build_object('code', code, 'email', (x.s).email, 'name', (x.s).name, 'minutes', 10, 'mail', private.esign_mail((x.e).id));
end $$;

-- wrong codes don't raise (that would undo the try count); they come back ok false
create or replace function public.esign_sign_check(p_token text, p_code text, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x record; c private.esign_codes; sess text;
begin
  select * into x from private.esign_need_open(p_token);
  select * into c from private.esign_codes where signer_id = (x.s).id and used_at is null order by created_at desc limit 1 for update;
  if c.id is null or c.expires_at < clock_timestamp() then
    perform private.esign_event((x.e).id, (x.s).id, 'code_failed', p_meta, null, jsonb_build_object('why', 'expired'));
    return jsonb_build_object('ok', false, 'expired', true, 'error', 'That code expired. Send a new one.');
  end if;
  if c.tries >= 5 then
    return jsonb_build_object('ok', false, 'expired', true, 'error', 'Too many tries. Send a new code.');
  end if;
  if encode(extensions.digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || (x.s).id::text, 'sha256'), 'hex') <> c.code_hash then
    update private.esign_codes set tries = tries + 1 where id = c.id;
    perform private.esign_event((x.e).id, (x.s).id, 'code_failed', p_meta, null, jsonb_build_object('why', 'wrong', 'tries', c.tries + 1));
    return jsonb_build_object('ok', false, 'tries_left', greatest(0, 4 - c.tries),
      'error', case when c.tries + 1 >= 5 then 'Too many tries. Send a new code.' else 'That code doesn''t match. Try again.' end, 'expired', c.tries + 1 >= 5);
  end if;
  sess := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update private.esign_codes set used_at = clock_timestamp() where id = c.id;
  update esign_signers set otp_verified_at = clock_timestamp(), session_hash = encode(extensions.digest(sess, 'sha256'), 'hex'),
    session_until = clock_timestamp() + interval '2 hours' where id = (x.s).id;
  perform private.esign_event((x.e).id, (x.s).id, 'code_verified', p_meta, null, jsonb_build_object('channel', c.channel));
  return jsonb_build_object('ok', true, 'session', sess);
end $$;

-- ---------- sign ----------
-- p_vals: {field id: text or true/false}. Dates and names are filled in here, not by the browser.
create or replace function public.esign_sign_submit(p_token text, p_session text, p_vals jsonb, p_signature text, p_initials text, p_sig_kind text, p_meta jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare x record; f jsonb; v jsonb := '{}'::jsonb; t text; val text; today text; done boolean; nxt jsonb := '[]'::jsonb; e esign_envelopes; s esign_signers;
begin
  select * into x from private.esign_need_open(p_token);
  e := x.e; s := x.s;
  if s.consent_at is null then raise exception 'Agree to sign electronically first'; end if;
  if s.session_hash is null or s.session_until < clock_timestamp() or encode(extensions.digest(coalesce(p_session, ''), 'sha256'), 'hex') <> s.session_hash then
    raise exception 'Check the code we emailed you first';
  end if;
  if p_signature is not null and (p_signature !~ '^data:image/png;base64,' or length(p_signature) > 400000) then raise exception 'That signature didn''t come through. Try again.'; end if;
  if p_initials is not null and (p_initials !~ '^data:image/png;base64,' or length(p_initials) > 200000) then raise exception 'Those initials didn''t come through. Try again.'; end if;
  today := to_char(now() at time zone 'America/Chicago', 'MM/DD/YYYY');
  for f in select y from jsonb_array_elements(e.fields) y where y->>'signer' = s.key loop
    t := f->>'type'; val := p_vals->>(f->>'id');
    if t = 'signature' then
      if p_signature is null then raise exception 'Add your signature'; end if;
    elsif t = 'initials' then
      if p_initials is null and coalesce((f->>'required')::boolean, true) then raise exception 'Add your initials'; end if;
    elsif t = 'date' then v := v || jsonb_build_object(f->>'id', today);
    elsif t = 'name' then v := v || jsonb_build_object(f->>'id', s.name);
    elsif t = 'checkbox' then
      if coalesce((f->>'required')::boolean, false) and coalesce(val, 'false') <> 'true' then raise exception 'Check the box%', coalesce(': ' || (f->>'label'), ''); end if;
      v := v || jsonb_build_object(f->>'id', coalesce(val, 'false') = 'true');
    elsif t = 'text' then
      val := left(trim(coalesce(val, '')), 1000);
      if coalesce((f->>'required')::boolean, false) and val = '' then raise exception 'Fill in %', coalesce(f->>'label', 'every required box'); end if;
      if val <> '' then v := v || jsonb_build_object(f->>'id', val); end if;
    end if;
  end loop;
  update esign_signers set signed_at = clock_timestamp(), status = 'signed', vals = v,
    signature_png = p_signature, initials_png = case when exists (select 1 from jsonb_array_elements(e.fields) y where y->>'signer' = s.key and y->>'type' = 'initials') then p_initials end,
    signature_kind = case when p_sig_kind in ('drawn', 'typed') then p_sig_kind end,
    sign_ip = left(nullif(p_meta->>'ip', ''), 100), sign_user_agent = left(nullif(p_meta->>'ua', ''), 1000),
    sign_device = left(nullif(p_meta->>'device', ''), 100), sign_browser = left(nullif(p_meta->>'browser', ''), 100),
    session_hash = null, session_until = null
  where id = s.id;
  perform private.esign_event(e.id, s.id, 'signed', p_meta, null, jsonb_build_object('fields', (select count(*) from jsonb_array_elements(e.fields) y where y->>'signer' = s.key),
    'signature', coalesce(p_sig_kind, 'drawn')));
  done := not exists (select 1 from esign_signers where envelope_id = e.id and signed_at is null);
  update esign_envelopes set status = 'partly_signed', updated_at = now() where id = e.id;
  perform private.esign_emit(e.id, 'esign_signed', s.name || ' signed ' || e.title);
  if e.owner_id is not null then
    insert into notifications (user_id, kind, title, body, link) values (e.owner_id, 'esign', s.name || ' signed ' || e.title,
      case when done then 'Everyone has signed. The signed copy is on its way.' end, '#esigndoc/' || e.id);
  end if;
  if not done then
    -- with a signing order, the next group gets their email now
    with u as (update esign_signers set status = 'sent', invited_at = clock_timestamp(), last_sent_at = clock_timestamp()
                where id in (select id from private.esign_turn(e.id)) and status = 'waiting' returning id, name, email, token)
    select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'token', u.token)), '[]'::jsonb) into nxt from u;
  end if;
  return jsonb_build_object('ok', true, 'all_signed', done, 'envelope_id', e.id, 'next', nxt, 'mail', private.esign_mail(e.id));
end $$;

-- ---------- decline ----------
create or replace function public.esign_sign_decline(p_token text, p_reason text, p_meta jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x record; why text := left(nullif(trim(coalesce(p_reason, '')), ''), 2000);
begin
  select * into x from private.esign_need_open(p_token);
  if why is null then raise exception 'Say why you''re declining'; end if;
  update esign_signers set status = 'declined', declined_at = clock_timestamp(), decline_reason = why, session_hash = null where id = (x.s).id;
  update esign_envelopes set status = 'declined', declined_at = now(), updated_at = now() where id = (x.e).id;
  update portal_approvals set status = 'declined', decided_at = now(), decided_name = (x.s).name, decision_note = why where id = (x.e).portal_approval_id and status = 'pending';
  perform private.esign_event((x.e).id, (x.s).id, 'declined', p_meta, null, jsonb_build_object('reason', why));
  perform private.esign_emit((x.e).id, 'esign_declined', (x.s).name || ' declined ' || (x.e).title);
  if (x.e).owner_id is not null then
    insert into notifications (user_id, kind, title, body, link) values ((x.e).owner_id, 'esign', (x.s).name || ' declined ' || (x.e).title, why, '#esigndoc/' || (x.e).id);
  end if;
  return jsonb_build_object('ok', true, 'name', (x.s).name, 'reason', why, 'mail', private.esign_mail((x.e).id));
end $$;

-- ---------- completion (edge function) ----------
-- everything the signed copy and its certificate need
create or replace function public.esign_complete_data(p_env uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes;
begin
  select * into e from esign_envelopes where id = p_env;
  if not found or e.status in ('draft', 'voided', 'declined', 'completed') then raise exception 'Not ready to finish'; end if;
  if exists (select 1 from esign_signers where envelope_id = e.id and signed_at is null) then raise exception 'Not everyone has signed yet'; end if;
  return jsonb_build_object('id', e.id, 'tenant_id', e.tenant_id, 'title', e.title, 'file_name', e.file_name, 'file_path', e.file_path,
    'original_sha256', e.original_sha256, 'fields', e.fields, 'sent_at', e.sent_at, 'account', (select name from tenants where id = e.tenant_id),
    'sender', (select jsonb_build_object('name', u.full_name, 'email', u.email) from app_users u where u.id = e.owner_id),
    'signers', (select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'name', s.name, 'email', s.email, 'role', s.role_label, 'order', s.sign_order,
        'ip', s.sign_ip, 'device', s.sign_device, 'browser', s.sign_browser, 'ua', s.sign_user_agent,
        'viewed_at', s.viewed_at, 'consent_at', s.consent_at, 'verified_at', s.otp_verified_at, 'signed_at', s.signed_at,
        'signature', s.signature_png, 'initials', s.initials_png, 'signature_kind', s.signature_kind, 'vals', s.vals) order by s.sign_order, s.signed_at)
      from esign_signers s where s.envelope_id = e.id),
    'events', (select jsonb_agg(jsonb_build_object('at', v.at, 'kind', v.kind, 'name', v.name, 'email', v.email, 'ip', v.ip, 'device', v.device, 'browser', v.browser) order by v.at, v.id)
      from esign_events v where v.envelope_id = e.id));
end $$;

create or replace function public.esign_finish(p_env uuid, p_path text, p_sha text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e esign_envelopes; names text;
begin
  select * into e from esign_envelopes where id = p_env for update;
  if not found then raise exception 'Not found'; end if;
  if e.status = 'completed' then raise exception 'Already finished'; end if;
  if e.status in ('draft', 'voided', 'declined') or exists (select 1 from esign_signers where envelope_id = e.id and signed_at is null) then raise exception 'Not ready to finish'; end if;
  if not private.esign_path_ok(e.tenant_id, p_path) or coalesce(p_sha, '') !~ '^[a-f0-9]{64}$' then raise exception 'Bad signed copy'; end if;
  update esign_envelopes set status = 'completed', completed_at = now(), final_path = p_path, final_sha256 = p_sha, updated_at = now() where id = e.id;
  select string_agg(name, ', ' order by sign_order) into names from esign_signers where envelope_id = e.id;
  update portal_approvals set status = 'approved', decided_at = now(), decided_name = left(names, 200) where id = e.portal_approval_id and status = 'pending';
  perform private.esign_event(e.id, null, 'completed', '{}'::jsonb, null, jsonb_build_object('final_sha256', p_sha));
  perform private.esign_emit(e.id, 'esign_completed', 'Signed by everyone: ' || e.title);
  if e.owner_id is not null then
    insert into notifications (user_id, kind, title, body, link) values (e.owner_id, 'esign', 'Signed by everyone: ' || e.title, null, '#esigndoc/' || e.id);
  end if;
  return jsonb_build_object('mail', private.esign_mail(e.id),
    'to', (select jsonb_agg(jsonb_build_object('name', s.name, 'email', s.email, 'token', s.token) order by s.sign_order) from esign_signers s where s.envelope_id = e.id));
end $$;

-- ---------- the public check: is this PDF one of ours? ----------
create or replace function public.esign_verify(p_sha text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('match', case when e.final_sha256 = lower(p_sha) then 'signed' else 'original' end,
      'title', e.title, 'status', e.status, 'envelope_id', e.id, 'completed_at', e.completed_at, 'sent_at', e.sent_at,
      'from', private.doc_brand(e.tenant_id)->>'name',
      'signers', (select jsonb_agg(jsonb_build_object('name', s.name, 'signed_at', s.signed_at) order by s.sign_order) from esign_signers s where s.envelope_id = e.id))), '[]'::jsonb)
  from (select * from esign_envelopes where lower(coalesce(p_sha, '')) ~ '^[a-f0-9]{64}$' and status <> 'draft'
          and (final_sha256 = lower(p_sha) or original_sha256 = lower(p_sha)) order by created_at desc limit 5) e
$$;

revoke execute on function public.esign_sign_view(text, jsonb), public.esign_sign_consent(text, jsonb), public.esign_sign_code(text, jsonb, text),
  public.esign_sign_check(text, text, jsonb), public.esign_sign_submit(text, text, jsonb, text, text, text, jsonb), public.esign_sign_decline(text, text, jsonb),
  public.esign_complete_data(uuid), public.esign_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.esign_sign_view(text, jsonb), public.esign_sign_consent(text, jsonb), public.esign_sign_code(text, jsonb, text),
  public.esign_sign_check(text, text, jsonb), public.esign_sign_submit(text, text, jsonb, text, text, text, jsonb), public.esign_sign_decline(text, text, jsonb),
  public.esign_complete_data(uuid), public.esign_finish(uuid, text, text) to service_role;
revoke execute on function public.esign_verify(text) from public;
grant execute on function public.esign_verify(text) to anon, authenticated;
