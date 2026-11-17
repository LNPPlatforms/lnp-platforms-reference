-- 109: a person's hours apply everywhere; an account's own hours win there; days off layer the same way
do $$ declare t uuid := private.platform_tenant(); u uuid; t2 uuid := gen_random_uuid(); h public.cal_hours; begin
  u := gen_random_uuid(); insert into app_users (id, full_name, email, tenant_id, is_admin, active) values (u, 'Hal Hours', 'hal@x.com', t, false, true);
  insert into tenants (id, name) values (t2, 'Other') on conflict do nothing;
  insert into user_hours (user_id, weekly, time_zone) values (u, '{"1":[["08:00","12:00"]]}', 'America/Chicago')
    on conflict (user_id) do update set weekly = excluded.weekly;
  h := private.cal_hours_for(t2, u);
  if h.weekly->'1'->0->>0 <> '08:00' then raise exception 'user hours should apply in another account: %', h.weekly; end if;
  insert into cal_hours (tenant_id, user_id, weekly) values (t2, u, '{"1":[["13:00","17:00"]]}');
  h := private.cal_hours_for(t2, u);
  if h.weekly->'1'->0->>0 <> '13:00' then raise exception 'account hours should win there'; end if;
  h := private.cal_hours_for(t, u);
  if h.weekly->'1'->0->>0 <> '08:00' then raise exception 'home should still use user hours'; end if;
  insert into user_days (user_id, day, ranges) values (u, date '2030-01-07', '[]');
  if private.cal_day_ranges(t, u, date '2030-01-07', h.weekly) <> '[]'::jsonb then raise exception 'user day off should apply'; end if;
  insert into cal_overrides (tenant_id, user_id, day, ranges) values (t2, u, date '2030-01-07', '[["10:00","11:00"]]');
  if private.cal_day_ranges(t2, u, date '2030-01-07', h.weekly)->0->>0 <> '10:00' then raise exception 'account day should win in that account'; end if;
  if private.cal_day_ranges(t, u, date '2030-01-07', h.weekly) <> '[]'::jsonb then raise exception 'other account still off'; end if;
  raise notice 'user hours ok';
end $$;
