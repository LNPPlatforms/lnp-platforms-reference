-- 078f: booking calendars, part 6. What the team does in the app: set up calendars (level 4), keep hours and days off
-- (your own at level 2, anyone's at level 3), and add, move, cancel and mark appointments (level 2, within your scope).

create or replace function private.cal_tz_ok(tz text) returns boolean
language plpgsql stable set search_path = pg_catalog as $$
begin perform now() at time zone tz; return tz is not null and length(tz) between 2 and 60; exception when others then return false; end $$;

create or replace function public.calendar_save(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); v_id uuid; v_slug text; v_users uuid[]; v_q jsonb := '[]'::jsonb; q jsonb; k text; keys text[] := '{}';
  v_durs int[]; v_rem int[]; v_kind text := coalesce(p->>'kind', 'one'); v_tz text := coalesce(nullif(p->>'time_zone', ''), 'America/Chicago');
begin
  if not private.cal_setup() then raise exception 'Your role can''t set up calendars'; end if;
  if length(trim(coalesce(p->>'name', ''))) < 1 then raise exception 'Give the calendar a name'; end if;
  v_slug := trim(both '-' from regexp_replace(lower(coalesce(nullif(trim(p->>'slug'), ''), p->>'name')), '[^a-z0-9]+', '-', 'g'));
  if v_slug = '' then raise exception 'Give it a short link name (letters and numbers)'; end if;
  v_slug := left(v_slug, 60);
  if exists (select 1 from calendars where tenant_id = t and slug = v_slug and archived_at is null and id is distinct from p_id) then
    raise exception 'Another calendar already uses the link name %', v_slug;
  end if;
  select coalesce(array_agg(u order by o), '{}') into v_users from (select distinct on (u) u, o from jsonb_array_elements_text(coalesce(p->'user_ids', '[]'::jsonb)) with ordinality x(u, o) order by u, o) y;
  if exists (select 1 from unnest(v_users) u where not private.on_team(u, t)) then raise exception 'Only people on this account''s team can take bookings'; end if;
  if v_kind not in ('one', 'round_robin', 'pick') then raise exception 'Pick who takes the bookings'; end if;
  if coalesce((p->>'active')::boolean, true) and cardinality(v_users) = 0 then raise exception 'Add at least one person who takes bookings'; end if;
  if not private.cal_tz_ok(v_tz) then raise exception 'That time zone isn''t one we know'; end if;
  for q in select * from jsonb_array_elements(coalesce(p->'questions', '[]'::jsonb)) loop
    if length(trim(coalesce(q->>'label', ''))) < 1 then raise exception 'Every question needs a label'; end if;
    if coalesce(q->>'kind', 'short') not in ('short', 'long', 'choice') then raise exception 'Unknown question type'; end if;
    if q->>'kind' = 'choice' and jsonb_array_length(coalesce(q->'options', '[]'::jsonb)) < 2 then raise exception 'A choice question needs at least two choices'; end if;
    k := coalesce(nullif(regexp_replace(lower(coalesce(q->>'key', '')), '[^a-z0-9_]', '', 'g'), ''), 'q' || substr(md5(random()::text), 1, 8));
    if k = any (keys) or k in ('name', 'email', 'phone', 'company', 'address') then k := k || '_' || substr(md5(random()::text), 1, 4); end if;
    keys := keys || k;
    v_q := v_q || jsonb_build_array(jsonb_build_object('key', k, 'label', left(trim(q->>'label'), 200), 'kind', coalesce(q->>'kind', 'short'),
      'options', case when q->>'kind' = 'choice' then (select jsonb_agg(left(trim(o), 120)) from jsonb_array_elements_text(q->'options') o where trim(o) <> '') else '[]'::jsonb end,
      'required', coalesce((q->>'required')::boolean, false)));
  end loop;
  if jsonb_array_length(v_q) > 20 then raise exception 'Keep it to 20 questions or fewer'; end if;
  select coalesce(array_agg(distinct x::int order by x::int), '{}') into v_durs from jsonb_array_elements_text(coalesce(p->'durations', '[]'::jsonb)) x;
  if exists (select 1 from unnest(v_durs) d where d not between 5 and 720) then raise exception 'Lengths go from 5 minutes to 12 hours'; end if;
  select coalesce(array_agg(distinct x::int order by x::int desc), '{}') into v_rem from jsonb_array_elements_text(coalesce(p->'reminders', '[1440,60]'::jsonb)) x;
  if exists (select 1 from unnest(v_rem) d where d not between 5 and 10080) or cardinality(v_rem) > 4 then raise exception 'Up to 4 reminders, from 5 minutes to 7 days before'; end if;
  if p_id is null then
    insert into calendars (tenant_id, name, slug, created_by) values (t, left(trim(p->>'name'), 120), v_slug, auth.uid()) returning id into v_id;
  else
    select id into v_id from calendars where id = p_id and tenant_id = t and archived_at is null;
    if v_id is null then raise exception 'Calendar not found'; end if;
  end if;
  update calendars set name = left(trim(p->>'name'), 120), slug = v_slug, description = nullif(left(trim(coalesce(p->>'description', '')), 2000), ''),
    color = case when coalesce(p->>'color', '') ~* '^#[0-9a-f]{6}$' then p->>'color' else color end, kind = v_kind, user_ids = v_users,
    duration_min = coalesce((p->>'duration_min')::int, duration_min), durations = array(select d from unnest(v_durs) d where d <> coalesce((p->>'duration_min')::int, duration_min)),
    slot_min = coalesce((p->>'slot_min')::int, slot_min), buffer_before = coalesce((p->>'buffer_before')::int, buffer_before), buffer_after = coalesce((p->>'buffer_after')::int, buffer_after),
    notice_min = coalesce((p->>'notice_min')::int, notice_min), ahead_days = coalesce((p->>'ahead_days')::int, ahead_days), daily_max = nullif((p->>'daily_max')::int, 0),
    location_kind = coalesce(nullif(p->>'location_kind', ''), location_kind), location_text = nullif(left(trim(coalesce(p->>'location_text', '')), 500), ''),
    questions = v_q, ask_company = coalesce((p->>'ask_company')::boolean, false), confirm_text = nullif(left(trim(coalesce(p->>'confirm_text', '')), 2000), ''),
    redirect_url = nullif(trim(coalesce(p->>'redirect_url', '')), ''), time_zone = v_tz,
    allow_cancel = coalesce((p->>'allow_cancel')::boolean, allow_cancel), allow_reschedule = coalesce((p->>'allow_reschedule')::boolean, allow_reschedule),
    cutoff_hours = coalesce((p->>'cutoff_hours')::int, cutoff_hours), reminders = v_rem, active = coalesce((p->>'active')::boolean, active),
    divisions = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p->'divisions') x), divisions), updated_at = now()
   where id = v_id;
  return v_id;
end $$;

create or replace function public.calendar_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.cal_setup() then raise exception 'Your role can''t set up calendars'; end if;
  update calendars set archived_at = now(), active = false, updated_at = now() where id = p_id and tenant_id = private.current_tenant() and archived_at is null;
  if not found then raise exception 'Calendar not found'; end if;
end $$;

-- may the signed-in person change this person's hours and days off: their own at level 2, anyone's at level 3
create or replace function private.cal_hours_ok(p_user uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.cal_see() and private.on_team(p_user, private.current_tenant())
     and ((p_user = auth.uid() and private.can('calendars', 2)) or private.can('calendars', 3) or private.is_admin())
$$;

-- ranges: [["09:00","12:00"],["13:00","17:00"]]; start before end, no overlaps, 24:00 allowed as an end
create or replace function private.cal_ranges_ok(r jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare x jsonb; out jsonb := '[]'::jsonb; prev time; a time; b time; b24 boolean;
begin
  if r is null or jsonb_typeof(r) <> 'array' then raise exception 'Hours need to be a list of times'; end if;
  for x in select v from jsonb_array_elements(r) v order by v->>0 loop
    if coalesce(x->>0, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(x->>1, '') !~ '^(([01]\d|2[0-3]):[0-5]\d|24:00)$' then raise exception 'Times look like 09:00 or 17:30'; end if;
    a := (x->>0)::time; b24 := x->>1 = '24:00'; b := case when b24 then '23:59:59'::time else (x->>1)::time end;
    if not b24 and b <= a then raise exception 'Each range has to end after it starts (%-%)', x->>0, x->>1; end if;
    if prev is not null and a < prev then raise exception 'Two ranges overlap on the same day'; end if;
    prev := case when b24 then '23:59:59'::time else b end;
    out := out || jsonb_build_array(jsonb_build_array(x->>0, x->>1));
  end loop;
  return out;
end $$;

create or replace function public.cal_hours_save(p_user uuid, p_weekly jsonb, p_tz text) returns void
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); wk jsonb := '{}'::jsonb; d int;
begin
  if not private.cal_hours_ok(p_user) then raise exception 'You can''t change their hours'; end if;
  if not private.cal_tz_ok(coalesce(p_tz, '')) then raise exception 'That time zone isn''t one we know'; end if;
  for d in 0..6 loop
    wk := wk || jsonb_build_object(d::text, private.cal_ranges_ok(coalesce(p_weekly->(d::text), '[]'::jsonb)));
  end loop;
  insert into cal_hours (tenant_id, user_id, weekly, time_zone, updated_at, updated_by) values (t, p_user, wk, p_tz, now(), auth.uid())
  on conflict (tenant_id, user_id) do update set weekly = excluded.weekly, time_zone = excluded.time_zone, updated_at = now(), updated_by = auth.uid();
end $$;

-- a day off ([] ranges) or different hours on one day. Saving the same day again replaces it.
create or replace function public.cal_override_save(p_user uuid, p_day date, p_ranges jsonb, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); v_id uuid;
begin
  if not private.cal_hours_ok(p_user) then raise exception 'You can''t change their hours'; end if;
  if p_day is null or p_day < current_date - 1 then raise exception 'Pick a day from today on'; end if;
  insert into cal_overrides (tenant_id, user_id, day, ranges, note) values (t, p_user, p_day, private.cal_ranges_ok(coalesce(p_ranges, '[]'::jsonb)), nullif(left(trim(coalesce(p_note, '')), 300), ''))
  on conflict (tenant_id, user_id, day) do update set ranges = excluded.ranges, note = excluded.note
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.cal_override_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare o cal_overrides;
begin
  select * into o from cal_overrides where id = p_id and tenant_id = private.current_tenant();
  if not found or not private.cal_hours_ok(o.user_id) then raise exception 'Not found'; end if;
  delete from cal_overrides where id = p_id;
end $$;

-- ---------- appointments by hand ----------
-- something else in the way for this person (appointments anywhere, jobs, outside busy times; no hours or buffers)
create or replace function private.cal_clash(p_user uuid, p_start timestamptz, p_end timestamptz, p_ignore uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from unnest(private.cal_busy_for(p_user, p_start, p_end, p_ignore, false)) x where x && tstzrange(p_start, p_end))
$$;

-- may the signed-in person change appointments for this team member
create or replace function private.cal_edit_ok(p_user uuid, p_divs uuid[]) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.cal_see() and private.can('calendars', 2) and private.in_scope('calendars', p_user, coalesce(p_divs, '{}'))
$$;

-- add or edit one by hand. p: {calendar_id, user_id, person_id, company_id, starts_at, ends_at, title, location, notes, name, email, phone,
-- notify (email the customer, default true), force (book over something already there)}
create or replace function public.appointment_save(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); a appointments; c calendars; pe people; v_user uuid := nullif(p->>'user_id', '')::uuid;
  s timestamptz := (p->>'starts_at')::timestamptz; e timestamptz := (p->>'ends_at')::timestamptz; old_s timestamptz; v_co uuid := nullif(p->>'company_id', '')::uuid; v_pe uuid := nullif(p->>'person_id', '')::uuid;
begin
  if not private.cal_see() then raise exception 'Calendars aren''t on for this account'; end if;
  if nullif(p->>'calendar_id', '') is not null then
    select * into c from calendars where id = (p->>'calendar_id')::uuid and tenant_id = t and archived_at is null;
    if c.id is null then raise exception 'Calendar not found'; end if;
  end if;
  if s is null then raise exception 'Pick a start time'; end if;
  e := coalesce(e, s + make_interval(mins => coalesce(c.duration_min, 30)));
  if e <= s then raise exception 'It has to end after it starts'; end if;
  if v_user is null then raise exception 'Pick who it''s with'; end if;
  if not private.on_team(v_user, t) then raise exception 'They aren''t on this account''s team'; end if;
  if not private.cal_edit_ok(v_user, coalesce(c.divisions, '{}')) then raise exception 'Your role can''t book for them'; end if;
  if v_pe is not null then
    select * into pe from people where id = v_pe and tenant_id = t;
    if pe.id is null then raise exception 'Contact not found'; end if;
    v_co := coalesce(v_co, (select cp.company_id from company_people cp where cp.person_id = v_pe order by cp.is_primary_contact desc nulls last limit 1));
  end if;
  if v_co is not null and not exists (select 1 from companies where id = v_co and tenant_id = t) then raise exception 'Not found'; end if;
  if p_id is not null then
    select * into a from appointments where id = p_id and tenant_id = t;
    if a.id is null or not private.cal_edit_ok(a.user_id, a.divisions) then raise exception 'Appointment not found'; end if;
  end if;
  perform private.cal_lock(array[v_user]);
  if not coalesce((p->>'force')::boolean, false) and private.cal_clash(v_user, s, e, p_id) then
    raise exception 'BUSY: % already has something then. Book it anyway?', coalesce((select full_name from app_users where id = v_user), 'They');
  end if;
  if not coalesce((p->>'notify')::boolean, true) then perform set_config('cal.quiet', '1', true); end if;
  if p_id is null then
    insert into appointments (tenant_id, calendar_id, user_id, person_id, company_id, starts_at, ends_at, buffer_before, buffer_after, status, title, location, name, email, phone,
      notes, source, divisions, created_by, history)
    values (t, c.id, v_user, v_pe, v_co, s, e, coalesce(c.buffer_before, 0), coalesce(c.buffer_after, 0), 'booked',
      left(coalesce(nullif(trim(p->>'title'), ''), concat_ws(' with ', c.name, nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '')), 'Appointment'), 200),
      nullif(left(trim(coalesce(p->>'location', case when c.location_kind in ('video', 'in_person') then c.location_text end, '')), 500), ''),
      coalesce(nullif(left(trim(coalesce(p->>'name', '')), 200), ''), nullif(trim(concat_ws(' ', pe.first_name, pe.last_name)), '')),
      lower(coalesce(nullif(trim(coalesce(p->>'email', '')), ''), pe.personal_email)), coalesce(nullif(trim(coalesce(p->>'phone', '')), ''), pe.personal_cell),
      nullif(left(trim(coalesce(p->>'notes', '')), 5000), ''), 'manual', coalesce(c.divisions, '{}'), auth.uid(),
      jsonb_build_array(jsonb_build_object('at', now(), 'what', 'booked', 'by', (select full_name from app_users where id = auth.uid()))))
    returning * into a;
    perform private.cal_event(a, 'appointment_booked', 'Booked: ' || a.title || ' on ' || to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'Mon FMDD "at" FMHH12:MI AM'));
    if v_user <> auth.uid() then
      insert into notifications (user_id, kind, title, body, link) values (v_user, 'appointment', 'New appointment: ' || a.title,
        to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'Dy Mon FMDD "at" FMHH12:MI AM'), '#calendar/' || to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'YYYY-MM-DD'));
    end if;
  else
    old_s := a.starts_at;
    update appointments set calendar_id = coalesce(c.id, calendar_id), user_id = v_user, person_id = coalesce(v_pe, person_id), company_id = coalesce(v_co, company_id),
      starts_at = s, ends_at = e, timed_at = case when s <> a.starts_at then now() else timed_at end,
      status = case when s <> a.starts_at and a.status in ('booked', 'confirmed') then 'rescheduled' else status end,
      title = coalesce(nullif(left(trim(coalesce(p->>'title', '')), 200), ''), title), location = nullif(left(trim(coalesce(p->>'location', location, '')), 500), ''),
      notes = nullif(left(trim(coalesce(p->>'notes', notes, '')), 5000), ''), updated_at = now(),
      history = history || case when s <> a.starts_at or v_user <> a.user_id then jsonb_build_array(jsonb_build_object('at', now(), 'what', 'moved', 'by', (select full_name from app_users where id = auth.uid()),
        'from', a.starts_at, 'to', s)) else '[]'::jsonb end
     where id = p_id returning * into a;
    if s <> old_s then
      perform private.cal_event(a, 'appointment_rescheduled', 'Rescheduled: ' || a.title || ' to ' || to_char(a.starts_at at time zone coalesce(c.time_zone, 'America/Chicago'), 'Mon FMDD "at" FMHH12:MI AM'));
    end if;
  end if;
  return a.id;
end $$;

-- confirmed, completed, no show, cancelled (or back to booked)
create or replace function public.appointment_status(p_id uuid, p_status text, p_reason text default null, p_notify boolean default true) returns void
language plpgsql security definer set search_path = public, private as $$
declare a appointments;
begin
  select * into a from appointments where id = p_id and tenant_id = private.current_tenant();
  if a.id is null or not private.cal_edit_ok(a.user_id, a.divisions) then raise exception 'Appointment not found'; end if;
  if p_status not in ('booked', 'confirmed', 'cancelled', 'no_show', 'completed') then raise exception 'Unknown status'; end if;
  if p_status = a.status then return; end if;
  if a.status = 'cancelled' and not private.cal_edit_ok(a.user_id, a.divisions) then raise exception 'Not allowed'; end if;
  if a.status = 'cancelled' and private.cal_clash(a.user_id, a.starts_at, a.ends_at, a.id) then raise exception 'That time is taken now. Move it to bring it back.'; end if;
  if not p_notify then perform set_config('cal.quiet', '1', true); end if;
  update appointments set status = p_status, updated_at = now(),
    cancelled_at = case when p_status = 'cancelled' then now() end, cancelled_by = case when p_status = 'cancelled' then (select full_name from app_users where id = auth.uid()) end,
    cancel_reason = case when p_status = 'cancelled' then nullif(left(trim(coalesce(p_reason, '')), 1000), '') end,
    history = history || jsonb_build_object('at', now(), 'what', p_status, 'by', (select full_name from app_users where id = auth.uid()))
   where id = p_id returning * into a;
  if p_status in ('cancelled', 'no_show', 'completed') then
    perform private.cal_event(a, 'appointment_' || case p_status when 'cancelled' then 'cancelled' when 'no_show' then 'no_show' else 'completed' end,
      case p_status when 'cancelled' then 'Cancelled: ' when 'no_show' then 'No show: ' else 'Completed: ' end || coalesce(a.title, 'appointment'));
  end if;
end $$;

revoke execute on function public.calendar_save(uuid, jsonb), public.calendar_archive(uuid), public.cal_hours_save(uuid, jsonb, text), public.cal_override_save(uuid, date, jsonb, text),
  public.cal_override_remove(uuid), public.appointment_save(uuid, jsonb), public.appointment_status(uuid, text, text, boolean) from public, anon;
grant execute on function public.calendar_save(uuid, jsonb), public.calendar_archive(uuid), public.cal_hours_save(uuid, jsonb, text), public.cal_override_save(uuid, date, jsonb, text),
  public.cal_override_remove(uuid), public.appointment_save(uuid, jsonb), public.appointment_status(uuid, text, text, boolean) to authenticated;
revoke execute on function private.cal_tz_ok(text), private.cal_hours_ok(uuid), private.cal_ranges_ok(jsonb), private.cal_clash(uuid, timestamptz, timestamptz, uuid),
  private.cal_edit_ok(uuid, uuid[]) from public, anon;
grant execute on function private.cal_hours_ok(uuid), private.cal_edit_ok(uuid, uuid[]) to authenticated;
