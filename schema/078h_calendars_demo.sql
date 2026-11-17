-- 078h: Demo Home Service Company: Calendars on, with a round robin "Free estimate" calendar across its team (home
-- team and members like Julie) and weekday hours 8 to 5. Booking page: /book/?a=demo-home-service&c=free-estimate
do $$
declare t uuid := 'a4fb486d-a9e5-4039-a3ed-62652c9f0dde'; team uuid[];
begin
  if not exists (select 1 from tenants where id = t) then return; end if;
  insert into account_settings (tenant_id, settings) values (t, '{"features":{"calendars":true}}'::jsonb)
  on conflict (tenant_id) do update set settings = account_settings.settings
    || jsonb_build_object('features', coalesce(account_settings.settings->'features', '{}'::jsonb) || '{"calendars":true}'::jsonb);
  if exists (select 1 from calendars where tenant_id = t) then return; end if;
  select coalesce(array_agg(u.id order by u.full_name), '{}') into team from app_users u
   where u.active and u.role not in ('vendor', 'member') and private.on_team(u.id, t);
  insert into calendars (tenant_id, name, slug, description, color, kind, user_ids, duration_min, durations, slot_min, buffer_after, notice_min, ahead_days,
    location_kind, questions, ask_company, confirm_text, time_zone)
  values (t, 'Free estimate', 'free-estimate', 'We come out, look at the job and give you a price on the spot.', '#2A6B4F', 'round_robin', team, 60, '{30}', 30, 15, 240, 45,
    'customer', '[{"key":"what","label":"What do you need done?","kind":"long","options":[],"required":true},
                  {"key":"heard","label":"How did you hear about us?","kind":"choice","options":["Google","A friend","Facebook","Other"],"required":false}]'::jsonb,
    true, 'Thanks! You''ll get an email with the details. Reply to it if anything changes.', 'America/Chicago');
  insert into cal_hours (tenant_id, user_id, weekly, time_zone)
  select t, u, '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","12:00"]]}'::jsonb, 'America/Chicago'
    from unnest(team) u on conflict do nothing;
end $$;
