-- 078d: booking calendars, part 4. Booking from the public page, and the customer's manage link (cancel or reschedule).
-- Every booking is checked again on the server inside one transaction: the people who could take it are locked in a
-- fixed order (advisory locks, so the same person booked from two accounts at once waits too), then the open times are
-- worked out fresh. Two people can't take the same slot.

-- find or add the person (and the organization when a company name was given), like a form lead
create or replace function private.cal_contact(t uuid, p_name text, p_email text, p_phone text, p_company text, p_source text,
  out o_person uuid, out o_company uuid)
language plpgsql security definer set search_path = public, private as $$
declare v_first text; v_last text; dg text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10); is_new_co boolean := false;
begin
  perform set_config('gelp.source', left(p_source, 120), true);
  if p_email is not null then
    select p.id into o_person from people p where p.tenant_id = t and p.archived_at is null and lower(p.personal_email) = lower(p_email) order by p.created_at limit 1;
    if o_person is null then
      select cp.person_id into o_person from company_people cp join people p on p.id = cp.person_id
       where cp.tenant_id = t and p.archived_at is null and lower(cp.work_email) = lower(p_email) order by p.created_at limit 1;
    end if;
  end if;
  if o_person is null and length(dg) = 10 then
    select p.id into o_person from people p where p.tenant_id = t and p.archived_at is null and right(regexp_replace(coalesce(p.personal_cell, ''), '\D', '', 'g'), 10) = dg
     order by p.created_at limit 1;
  end if;
  if o_person is null then
    v_first := nullif(left(split_part(trim(p_name), ' ', 1), 80), '');
    v_last := nullif(left(trim(substr(trim(p_name), length(split_part(trim(p_name), ' ', 1)) + 1)), 80), '');
    insert into people (tenant_id, first_name, last_name, personal_email, personal_cell, created_by)
    values (t, coalesce(v_first, 'Guest'), v_last, p_email, p_phone, null) returning id into o_person;
  else
    update people set personal_email = coalesce(personal_email, p_email), personal_cell = coalesce(personal_cell, p_phone) where id = o_person
      and (personal_email is null and p_email is not null or personal_cell is null and p_phone is not null);
  end if;
  if p_company is not null then
    select c.id into o_company from company_people cp join companies c on c.id = cp.company_id
     where cp.person_id = o_person and c.archived_at is null and lower(c.name) = lower(p_company) limit 1;
    if o_company is null then
      select c.id into o_company from companies c where c.tenant_id = t and c.archived_at is null and lower(c.name) = lower(p_company) order by c.created_at limit 1;
    end if;
    if o_company is null then
      insert into companies (tenant_id, name, main_phone, main_email, lead_source_kind, lead_source_channel, created_by)
      values (t, p_company, null, null, 'system', left(p_source, 120), null) returning id into o_company;
      is_new_co := true;
    end if;
    if not exists (select 1 from company_people where company_id = o_company and person_id = o_person) then
      insert into company_people (tenant_id, company_id, person_id, work_email, work_phone, is_primary_contact) values (t, o_company, o_person, p_email, p_phone, is_new_co);
    end if;
  else
    select cp.company_id into o_company from company_people cp join companies c on c.id = cp.company_id
     where cp.person_id = o_person and c.archived_at is null order by cp.is_primary_contact desc nulls last, c.created_at limit 1;
  end if;
end $$;
revoke execute on function private.cal_contact(uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function private.cal_lock(p_people uuid[]) returns void
language sql volatile set search_path = pg_catalog as $$
  select pg_advisory_xact_lock(hashtextextended('cal:' || x::text, 0)) from (select unnest(p_people) x order by 1) s
$$;
revoke execute on function private.cal_lock(uuid[]) from public, anon, authenticated;

-- the answers to the calendar's questions, checked. p_answers: {key: value}
create or replace function private.cal_answers(c public.calendars, p_answers jsonb) returns jsonb
language plpgsql stable set search_path = public, private as $$
declare q jsonb; v text; out jsonb := '[]'::jsonb;
begin
  for q in select * from jsonb_array_elements(c.questions) loop
    v := nullif(left(trim(coalesce(p_answers->>(q->>'key'), '')), case when q->>'kind' = 'long' then 4000 else 500 end), '');
    if v is null and coalesce((q->>'required')::boolean, false) then raise exception 'Please answer: %', q->>'label'; end if;
    if v is not null and q->>'kind' = 'choice' and not exists (select 1 from jsonb_array_elements_text(coalesce(q->'options', '[]'::jsonb)) o where o = v) then
      raise exception 'Pick one of the choices for: %', q->>'label';
    end if;
    if v is not null then out := out || jsonb_build_array(jsonb_build_object('key', q->>'key', 'label', q->>'label', 'value', v)); end if;
  end loop;
  return out;
end $$;
revoke execute on function private.cal_answers(public.calendars, jsonb) from public, anon, authenticated;

create or replace function private.cal_location(c public.calendars, p_phone text, p_address text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case c.location_kind when 'phone' then 'Phone call' || coalesce(' to ' || nullif(p_phone, ''), '')
    when 'video' then coalesce('Video: ' || nullif(c.location_text, ''), 'Video call (link to follow)')
    when 'in_person' then coalesce(nullif(c.location_text, ''), 'In person')
    else coalesce(nullif(p_address, ''), 'At your place') end
$$;

-- who takes a time: for pick a person, the person picked; otherwise whoever is open, least recently booked on this calendar first
create or replace function private.cal_pick(c public.calendars, p_start timestamptz, p_dur int, p_user uuid, p_ignore uuid default null, p_prefer uuid default null) returns uuid
language sql stable security definer set search_path = public, private as $$
  select s.user_id from private.cal_slots(c, p_start, p_start + interval '1 second', p_dur, p_user, p_ignore) s
   where s.starts_at = p_start
   order by (s.user_id = p_prefer) desc nulls last,
            (select max(a.created_at) from appointments a where a.calendar_id = c.id and a.user_id = s.user_id and a.id is distinct from p_ignore) nulls first, s.user_id
   limit 1
$$;
revoke execute on function private.cal_pick(public.calendars, timestamptz, int, uuid, uuid, uuid) from public, anon, authenticated;

-- make the booking. p: {name, email, phone, company, address, answers, tz, notes}
create or replace function private.cal_book(c public.calendars, p_start timestamptz, p_dur int, p_user uuid, p jsonb, p_source text, p_ip text) returns public.appointments
language plpgsql security definer set search_path = public, private as $$
declare ppl uuid[]; who uuid; a appointments; ct record; v_name text := left(trim(coalesce(p->>'name', '')), 200);
  v_email text := lower(nullif(left(trim(coalesce(p->>'email', '')), 320), '')); v_phone text := nullif(left(trim(coalesce(p->>'phone', '')), 40), '');
  v_co text := nullif(left(trim(coalesce(p->>'company', '')), 200), ''); v_addr text := nullif(left(trim(coalesce(p->>'address', '')), 300), ''); ans jsonb;
begin
  if c.id is null or not c.active or c.archived_at is not null then raise exception 'This calendar isn''t taking bookings'; end if;
  if p_dur is null or not p_dur = any (private.cal_lengths(c)) then raise exception 'Pick one of the lengths offered'; end if;
  if length(v_name) < 1 then raise exception 'Add your name'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Add a good email address'; end if;
  if c.location_kind = 'phone' and length(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g')) < 7 then raise exception 'Add a phone number we can call'; end if;
  if c.location_kind = 'customer' and v_addr is null then raise exception 'Add the address where we''re meeting'; end if;
  if not c.ask_company then v_co := null; end if;
  ans := private.cal_answers(c, coalesce(p->'answers', '{}'::jsonb));
  ppl := private.cal_people(c);
  if c.kind = 'pick' then
    if p_user is null then raise exception 'Pick who you''d like to meet with'; end if;
    ppl := array(select x from unnest(ppl) x where x = p_user);
  else p_user := null;
  end if;
  if cardinality(ppl) = 0 then raise exception 'Nobody is taking bookings on this calendar right now'; end if;
  perform private.cal_lock(ppl);
  who := private.cal_pick(c, p_start, p_dur, p_user);
  if who is null then raise exception 'That time was just taken. Pick another time.'; end if;
  select * into ct from private.cal_contact(c.tenant_id, v_name, v_email, v_phone, v_co, 'Booking: ' || c.name);
  insert into appointments (tenant_id, calendar_id, user_id, person_id, company_id, starts_at, ends_at, buffer_before, buffer_after, status, title, location,
    name, email, phone, company_name, answers, notes, visitor_tz, source, ip, divisions, created_by, history)
  values (c.tenant_id, c.id, who, ct.o_person, ct.o_company, p_start, p_start + make_interval(mins => p_dur), c.buffer_before, c.buffer_after, 'booked',
    left(c.name || ' with ' || v_name, 200), private.cal_location(c, v_phone, v_addr), v_name, v_email, v_phone, v_co, ans,
    nullif(left(trim(coalesce(p->>'notes', '')), 5000), ''), nullif(left(p->>'tz', 60), ''), p_source, p_ip, c.divisions, auth.uid(),
    jsonb_build_array(jsonb_build_object('at', now(), 'what', 'booked', 'by', case when p_source = 'booking' then 'customer' else (select full_name from app_users where id = auth.uid()) end)))
  returning * into a;
  perform private.cal_event(a, 'appointment_booked', 'Booked: ' || c.name || ' on ' || to_char(a.starts_at at time zone c.time_zone, 'Mon FMDD "at" FMHH12:MI AM'));
  insert into notifications (user_id, kind, title, body, link)
  values (who, 'appointment', 'New booking: ' || v_name, c.name || ', ' || to_char(a.starts_at at time zone coalesce((select time_zone from cal_hours where tenant_id = c.tenant_id and user_id = who), c.time_zone), 'Dy Mon FMDD "at" FMHH12:MI AM'),
          '#calendar/' || to_char(a.starts_at at time zone c.time_zone, 'YYYY-MM-DD'));
  return a;
end $$;
revoke execute on function private.cal_book(public.calendars, timestamptz, int, uuid, jsonb, text, text) from public, anon, authenticated;

-- the timeline and automations hear about appointments
create or replace function private.cal_event(a public.appointments, p_kind text, p_title text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if a.person_id is null and a.company_id is null then return; end if;
  perform private.emit(a.tenant_id, p_kind, p_title, a.person_id, a.company_id,
    jsonb_build_object('appointment_id', a.id, 'calendar_id', a.calendar_id, 'calendar', (select name from calendars where id = a.calendar_id),
      'starts_at', a.starts_at, 'with', (select full_name from app_users where id = a.user_id), 'status', a.status));
end $$;
revoke execute on function private.cal_event(public.appointments, text, text) from public, anon, authenticated;

-- the request's address, for the rate limit
create or replace function private.req_ip() returns text
language sql stable set search_path = pg_catalog as $$
  select nullif(trim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for',
                                         nullif(current_setting('request.headers', true), '')::json->>'x-real-ip', ''), ',', 1)), '')
$$;
revoke execute on function private.req_ip() from public, anon, authenticated;

-- public: book a time. p: {name, email, phone, company, address, answers {key: value}, tz, website (the honeypot, left empty by people)}
create or replace function public.book_make(p_account text, p_cal text, p_start timestamptz, p_duration int, p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare c calendars; a appointments; v_ip text := private.req_ip(); v_email text := lower(trim(coalesce(p->>'email', '')));
begin
  c := private.cal_public(p_account, p_cal);
  if c.id is null then raise exception 'This calendar isn''t taking bookings'; end if;
  if coalesce(p->>'website', '') <> '' then return jsonb_build_object('ok', true); end if;   -- a bot filled the hidden field: say thanks, do nothing
  if length(coalesce(p::text, '')) > 20000 then raise exception 'That is too much information for one booking'; end if;
  if v_ip is not null and (select count(*) from appointments where ip = v_ip and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many bookings from here. Please try again later.';
  end if;
  if (select count(*) from appointments where calendar_id = c.id and lower(email) = v_email and status in ('booked', 'confirmed', 'rescheduled') and starts_at > now()) >= 3 then
    raise exception 'You already have a few times booked here. Use the link in your email to change one.';
  end if;
  a := private.cal_book(c, p_start, coalesce(p_duration, c.duration_min), p_user, p, 'booking', v_ip);
  return jsonb_build_object('ok', true, 'token', a.manage_token, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'location', a.location,
    'with', private.cal_short_name(a.user_id), 'confirm_text', c.confirm_text, 'redirect_url', c.redirect_url);
end $$;
revoke execute on function public.book_make(text, text, timestamptz, int, uuid, jsonb) from public;
grant execute on function public.book_make(text, text, timestamptz, int, uuid, jsonb) to anon, authenticated;

-- ---------- the customer's manage link ----------
create or replace function private.cal_by_token(p_token text) returns public.appointments
language sql stable security definer set search_path = public, private as $$
  select * from appointments where manage_token = p_token and length(coalesce(p_token, '')) = 64 and p_token ~ '^[a-f0-9]{64}$'
$$;
revoke execute on function private.cal_by_token(text) from public, anon, authenticated;

-- can the customer still change it: active, the calendar allows it, and we're not inside the cutoff
create or replace function private.cal_can(a public.appointments, c public.calendars, p_what text) returns boolean
language sql stable set search_path = public, private as $$
  select a.status in ('booked', 'confirmed', 'rescheduled') and c.id is not null and c.archived_at is null
     and case p_what when 'cancel' then c.allow_cancel else c.allow_reschedule and c.active end
     and a.starts_at - make_interval(hours => c.cutoff_hours) > now()
$$;
revoke execute on function private.cal_can(public.appointments, public.calendars, text) from public, anon, authenticated;

create or replace function public.book_manage(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare a appointments; c calendars;
begin
  a := private.cal_by_token(p_token);
  if a.id is null or not private.feature_on_for(a.tenant_id, 'calendars') then return null; end if;
  select * into c from calendars where id = a.calendar_id;
  return jsonb_build_object('name', a.name, 'title', coalesce(c.name, a.title), 'status', a.status, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
    'location', a.location, 'with', private.cal_short_name(a.user_id), 'color', c.color, 'time_zone', coalesce(c.time_zone, 'America/Chicago'),
    'can_cancel', private.cal_can(a, c, 'cancel'), 'can_reschedule', private.cal_can(a, c, 'reschedule'), 'cutoff_hours', c.cutoff_hours,
    'ahead_days', c.ahead_days, 'brand', private.doc_brand(a.tenant_id));
end $$;

create or replace function public.book_manage_slots(p_token text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare a appointments; c calendars;
begin
  a := private.cal_by_token(p_token);
  if a.id is null then return null; end if;
  select * into c from calendars where id = a.calendar_id;
  if not private.cal_can(a, c, 'reschedule') or not private.feature_on_for(a.tenant_id, 'calendars') then return '[]'::jsonb; end if;
  if p_to - p_from > interval '45 days' then p_to := p_from + interval '45 days'; end if;
  return (select coalesce(jsonb_agg(to_char(x at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') order by x), '[]'::jsonb)
            from (select distinct s.starts_at x from private.cal_slots(c, p_from, p_to, (extract(epoch from a.ends_at - a.starts_at) / 60)::int,
                    case when c.kind = 'round_robin' then null else a.user_id end, a.id) s) d);
end $$;

create or replace function public.book_cancel(p_token text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare a appointments; c calendars;
begin
  a := private.cal_by_token(p_token);
  if a.id is null then raise exception 'We couldn''t find that booking'; end if;
  select * into c from calendars where id = a.calendar_id;
  if a.status = 'cancelled' then return jsonb_build_object('ok', true, 'status', 'cancelled'); end if;
  if not private.cal_can(a, c, 'cancel') then
    raise exception 'It''s too close to the start to cancel online. Please call or email us.';
  end if;
  update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = 'customer', cancel_reason = nullif(left(trim(coalesce(p_reason, '')), 1000), ''),
    updated_at = now(), history = history || jsonb_build_object('at', now(), 'what', 'cancelled', 'by', 'customer')
   where id = a.id returning * into a;
  perform private.cal_event(a, 'appointment_cancelled', 'Cancelled: ' || coalesce(c.name, a.title));
  insert into notifications (user_id, kind, title, body, link) values (a.user_id, 'appointment', 'Cancelled: ' || coalesce(a.name, ''),
    coalesce(c.name, '') || ', ' || to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'Dy Mon FMDD "at" FMHH12:MI AM') || coalesce('. ' || a.cancel_reason, ''),
    '#calendar/' || to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'YYYY-MM-DD'));
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

-- move it to another open time (same length). Round robin may hand it to someone else when the person isn't free then.
create or replace function public.book_reschedule(p_token text, p_start timestamptz) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare a appointments; c calendars; who uuid; dur int; old timestamptz;
begin
  a := private.cal_by_token(p_token);
  if a.id is null then raise exception 'We couldn''t find that booking'; end if;
  select * into c from calendars where id = a.calendar_id;
  if not private.cal_can(a, c, 'reschedule') or not private.feature_on_for(a.tenant_id, 'calendars') then
    raise exception 'This booking can''t be moved online anymore. Please call or email us.';
  end if;
  dur := (extract(epoch from a.ends_at - a.starts_at) / 60)::int;
  perform private.cal_lock(case when c.kind = 'round_robin' then private.cal_people(c) else array[a.user_id] end);
  who := private.cal_pick(c, p_start, dur, case when c.kind = 'round_robin' then null else a.user_id end, a.id, a.user_id);
  if who is null then raise exception 'That time was just taken. Pick another time.'; end if;
  old := a.starts_at;
  update appointments set starts_at = p_start, ends_at = p_start + make_interval(mins => dur), user_id = who, status = 'rescheduled', updated_at = now(), timed_at = now(),
    history = history || jsonb_build_object('at', now(), 'what', 'rescheduled', 'by', 'customer', 'from', old, 'to', p_start)
   where id = a.id returning * into a;
  perform private.cal_event(a, 'appointment_rescheduled', 'Rescheduled: ' || coalesce(c.name, a.title) || ' to ' || to_char(a.starts_at at time zone c.time_zone, 'Mon FMDD "at" FMHH12:MI AM'));
  insert into notifications (user_id, kind, title, body, link) values (who, 'appointment', 'Rescheduled: ' || coalesce(a.name, ''),
    coalesce(c.name, '') || ', now ' || to_char(a.starts_at at time zone c.time_zone, 'Dy Mon FMDD "at" FMHH12:MI AM'),
    '#calendar/' || to_char(a.starts_at at time zone c.time_zone, 'YYYY-MM-DD'));
  return jsonb_build_object('ok', true, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'with', private.cal_short_name(who));
end $$;

revoke execute on function public.book_manage(text), public.book_manage_slots(text, timestamptz, timestamptz), public.book_cancel(text, text), public.book_reschedule(text, timestamptz) from public;
grant execute on function public.book_manage(text), public.book_manage_slots(text, timestamptz, timestamptz), public.book_cancel(text, text), public.book_reschedule(text, timestamptz) to anon, authenticated;
