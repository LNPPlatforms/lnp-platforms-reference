-- 078e: booking calendars, part 5. Emails. Booking, cancelling and moving an appointment queue emails in
-- private.cal_mail; each one calls the booking-email edge function through pg_net (after the transaction commits, so a
-- booking that fails sends nothing). Reminders: a pg_cron job every minute queues the ones that are due (24 hours and
-- 1 hour before by default, set per calendar). The function reads the email with the shared hook secret, the same
-- way automation-send does, so only the database can make it send.
-- Customer emails can be skipped for one change with set_config('cal.quiet', '1', true) (a team member adding one by hand
-- without emailing them).

create or replace function private.cal_mail_hook(p_id uuid) returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return; end if;
  update private.cal_mail set tries = tries + 1 where id = p_id;
  perform net.http_post(url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/booking-email',
    body := jsonb_build_object('id', p_id, 'secret', s), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000);
exception when others then return;
end $$;
revoke execute on function private.cal_mail_hook(uuid) from public, anon, authenticated;

create or replace function private.cal_mail_send() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.cal_mail_hook(new.id);
  return null;
end $$;
revoke execute on function private.cal_mail_send() from public, anon, authenticated;
drop trigger if exists cal_mail_send on private.cal_mail;
create trigger cal_mail_send after insert on private.cal_mail for each row execute function private.cal_mail_send();

create or replace function private.cal_mail_add(a public.appointments, p_kind text, p_to text, p_minutes int default null) returns void
language sql security definer set search_path = public, private as $$
  insert into private.cal_mail (tenant_id, appointment_id, kind, to_email, minutes, for_start)
  select a.tenant_id, a.id, p_kind, lower(trim(p_to)), p_minutes, a.starts_at
   where coalesce(trim(p_to), '') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and private.feature_on_for(a.tenant_id, 'calendars')
  on conflict do nothing
$$;
revoke execute on function private.cal_mail_add(public.appointments, text, text, int) from public, anon, authenticated;

-- what changed on an appointment decides which emails go out
create or replace function private.cal_mail_queue() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare quiet boolean := coalesce(current_setting('cal.quiet', true), '') = '1';
  member text := (select email from app_users where id = new.user_id);
  self boolean := new.user_id is not distinct from auth.uid();
begin
  if tg_op = 'INSERT' then
    if new.status = 'cancelled' then return null; end if;
    if not quiet then perform private.cal_mail_add(new, 'confirm', new.email); end if;
    if not self then perform private.cal_mail_add(new, 'notice', member); end if;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    if not quiet then perform private.cal_mail_add(new, 'cancel', new.email); end if;
    if not self then perform private.cal_mail_add(new, 'cancel_notice', member); end if;
  elsif new.status <> 'cancelled' and (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at) then
    if not quiet then perform private.cal_mail_add(new, 'reschedule', new.email); end if;
    if not self then perform private.cal_mail_add(new, case when new.user_id is distinct from old.user_id then 'notice' else 'reschedule_notice' end, member); end if;
  elsif new.status <> 'cancelled' and new.user_id is distinct from old.user_id and not self then
    perform private.cal_mail_add(new, 'notice', member);
  end if;
  return null;
exception when others then return null;   -- email trouble never blocks a booking
end $$;
revoke execute on function private.cal_mail_queue() from public, anon, authenticated;
drop trigger if exists cal_mail_queue on public.appointments;
create trigger cal_mail_queue after insert or update of status, starts_at, ends_at, user_id on public.appointments for each row execute function private.cal_mail_queue();

-- every minute: queue the reminders that are due, and try again on emails that didn't go out
create or replace function private.cal_remind() returns int
language plpgsql security definer set search_path = public, private as $$
declare n int; m record;
begin
  insert into private.cal_mail (tenant_id, appointment_id, kind, to_email, minutes, for_start)
  select a.tenant_id, a.id, 'reminder', lower(trim(a.email)), r, a.starts_at
    from appointments a join calendars c on c.id = a.calendar_id, unnest(c.reminders) r
   where a.status in ('booked', 'confirmed', 'rescheduled') and a.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and a.starts_at > now() and a.starts_at < now() + interval '8 days'
     and a.starts_at - make_interval(mins => r) <= now()
     and a.starts_at - make_interval(mins => r) > now() - interval '2 hours'   -- never a stale reminder after a long outage
     and a.starts_at - make_interval(mins => r) > a.timed_at                   -- booked 2 hours out: no 24 hour reminder
     and private.feature_on_for(a.tenant_id, 'calendars')
  on conflict do nothing;
  get diagnostics n = row_count;
  for m in select id from private.cal_mail where status = 'queued' and tries < 3 and created_at < now() - interval '5 minutes' order by created_at limit 50 loop
    perform private.cal_mail_hook(m.id);
  end loop;
  update private.cal_mail set status = 'failed', error = coalesce(error, 'Gave up after 3 tries') where status = 'queued' and tries >= 3 and created_at < now() - interval '30 minutes';
  return n;
end $$;
revoke execute on function private.cal_remind() from public, anon, authenticated;
do $$ begin perform cron.unschedule('calendar-reminders'); exception when others then null; end $$;
select cron.schedule('calendar-reminders', '* * * * *', $$select private.cal_remind()$$);

-- the edge function reads one email (service role, with the hook secret)
create or replace function public.cal_mail_take(p_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare m private.cal_mail; a appointments; c calendars; u app_users; wl jsonb; tz text; utz text;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  select * into m from private.cal_mail where id = p_id and status = 'queued' for update;
  if not found then return null; end if;
  select * into a from appointments where id = m.appointment_id;
  select * into c from calendars where id = a.calendar_id;
  select * into u from app_users where id = a.user_id;
  -- skip what no longer applies: a reminder for a cancelled or moved time, a confirmation for something already cancelled
  if (m.kind in ('reminder', 'confirm', 'notice', 'reschedule', 'reschedule_notice') and (a.status = 'cancelled' or a.starts_at is distinct from m.for_start))
     or (m.kind = 'reminder' and a.starts_at <= now()) then
    update private.cal_mail set status = 'skipped' where id = m.id;
    return null;
  end if;
  wl := private.brand_of(a.tenant_id);
  tz := coalesce(c.time_zone, 'America/Chicago');
  utz := coalesce((select time_zone from cal_hours where tenant_id = a.tenant_id and user_id = a.user_id), tz);
  return jsonb_build_object('id', m.id, 'kind', m.kind, 'to', m.to_email, 'minutes', m.minutes,
    'for_team', m.kind in ('notice', 'cancel_notice', 'reschedule_notice'),
    'appointment', jsonb_build_object('id', a.id, 'title', coalesce(c.name, a.title), 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status,
      'location', a.location, 'name', a.name, 'email', a.email, 'phone', a.phone, 'company', a.company_name, 'answers', a.answers, 'notes', a.notes,
      'cancel_reason', a.cancel_reason, 'token', a.manage_token, 'date', to_char(a.starts_at at time zone tz, 'YYYY-MM-DD'),
      'description', c.description, 'allow_changes', coalesce(c.allow_cancel or c.allow_reschedule, false)),
    'time_zone', case when m.kind in ('notice', 'cancel_notice', 'reschedule_notice') then utz else coalesce(nullif(a.visitor_tz, ''), tz) end,
    'with', jsonb_build_object('name', u.full_name, 'email', u.email),
    'brand', private.doc_brand(a.tenant_id),
    'from_name', coalesce(nullif(trim(private.doc_brand(a.tenant_id)->>'name'), ''), (select name from tenants where id = a.tenant_id)),
    'app_url', case when coalesce(wl->>'domain', '') ~ '^[a-z0-9.-]+\.[a-z]{2,}$' then 'https://' || (wl->>'domain') end);
end $$;

create or replace function public.cal_mail_done(p_id uuid, p_secret text, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public, private as $$
declare m private.cal_mail; a appointments;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  update private.cal_mail set status = case when p_ok then 'sent' else 'failed' end, error = left(p_error, 500), sent_at = case when p_ok then now() end
   where id = p_id and status = 'queued' returning * into m;
  if found and m.kind in ('confirm', 'cancel', 'reschedule', 'reminder') then
    select * into a from appointments where id = m.appointment_id;
    if a.person_id is not null then
      perform private.emit(a.tenant_id, case when p_ok then 'email_sent' else 'email_failed' end,
        case when p_ok then 'Email sent: ' else 'Email failed: ' end || case m.kind when 'confirm' then 'booking confirmation' when 'cancel' then 'booking cancelled'
          when 'reschedule' then 'booking moved' else 'reminder' end, a.person_id, null, jsonb_build_object('appointment_id', a.id, 'error', p_error));
    end if;
  end if;
end $$;
revoke execute on function public.cal_mail_take(uuid, text), public.cal_mail_done(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.cal_mail_take(uuid, text), public.cal_mail_done(uuid, text, boolean, text) to service_role;
