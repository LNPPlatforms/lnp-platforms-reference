-- 071g: each person marking their own arrived and left (steps = each), and the foreman clocking the crew (clock = foreman).

create or replace function public.crew_mark(p_job uuid, p_step text, p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare j jobs; np_pin uuid; np_feet double precision; np_radius int; far boolean := false;
begin
  select * into j from jobs where id = p_job and tenant_id = private.current_tenant() and archived_at is null;
  if j.id is null or not private.on_job_crew(j.id) then raise exception 'You''re not on this job'; end if;
  if private.crew_opt(j.service_type, 'steps') <> 'each' then raise exception 'Your foreman marks arrived and left for the crew'; end if;
  if p_step not in ('arrived', 'left') then raise exception 'Unknown step %', p_step; end if;
  if p_lat is not null and p_lng is not null then
    select n.pin_id, n.feet, n.radius into np_pin, np_feet, np_radius from private.nearest_pin(j.company_id, p_lat, p_lng) n;
    far := np_pin is not null and np_feet > np_radius;
  end if;
  if p_step = 'arrived' then
    update job_crew set arrived_at = now(), arrive_lat = p_lat, arrive_lng = p_lng, arrive_feet = np_feet where job_id = j.id and user_id = auth.uid() and removed_at is null and arrived_at is null;
  else
    update job_crew set left_at = now(), leave_lat = p_lat, leave_lng = p_lng, leave_feet = np_feet where job_id = j.id and user_id = auth.uid() and removed_at is null and left_at is null;
  end if;
  if not found then raise exception 'That step is already done'; end if;
  insert into job_events (tenant_id, job_id, kind, status, lat, lng, accuracy_m, distance_ft, pin_id, flagged, note)
  values (j.tenant_id, j.id, 'note', p_step, p_lat, p_lng, p_accuracy, np_feet, np_pin, far or p_lat is null,
          (select full_name from app_users where id = auth.uid()) || case when p_step = 'arrived' then ' arrived' else ' left' end);
  if far then
    insert into work_reviews (tenant_id, kind, ref_id, job_id, company_id, divisions, worker_id, summary, details)
    values (j.tenant_id, 'gps_flag', j.id, j.id, j.company_id, j.divisions, auth.uid(),
            format('%s %s ft from the pin (allowed %s)', case when p_step = 'arrived' then 'Arrived' else 'Left' end, round(np_feet), np_radius),
            jsonb_build_object('lat', p_lat, 'lng', p_lng, 'feet', round(np_feet), 'radius', np_radius, 'pin_id', np_pin, 'step', p_step, 'crew', true));
  end if;
  return jsonb_build_object('step', p_step, 'flag', case when far then 'far' when p_lat is null then 'no_gps' end, 'feet', round(np_feet), 'radius', np_radius);
end $$;

-- the foreman clocks the whole crew in or out on this job (GPS from the foreman's phone)
create or replace function public.crew_clock(p_job uuid, p_dir text, p_lat double precision default null, p_lng double precision default null, p_accuracy double precision default null)
returns int language plpgsql security definer set search_path = public, private as $$
declare j jobs; pin uuid; feet double precision; rad int; fl text[] := array['by_foreman']; t time_entries; n int := 0; x record;
begin
  select * into j from jobs where id = p_job and tenant_id = private.current_tenant() and archived_at is null;
  if j.id is null then raise exception 'Job not found'; end if;
  if not private.feature_on('timeclock') then raise exception 'The time clock isn''t on for this account'; end if;
  if not (j.assigned_to = auth.uid() or (private.can('dispatch', 2) and private.in_scope('dispatch', coalesce(j.assigned_to, j.created_by), j.divisions))) then
    raise exception 'Only the foreman can clock the crew';
  end if;
  if private.crew_opt(j.service_type, 'clock') <> 'foreman' then raise exception 'Everyone clocks themselves in on this account'; end if;
  if p_dir not in ('in', 'out') then raise exception 'In or out'; end if;
  if p_lat is not null then
    select n2.pin_id, n2.feet, n2.radius into pin, feet, rad from private.nearest_pin(j.company_id, p_lat, p_lng) n2;
    if pin is not null and feet > rad then fl := fl || case when p_dir = 'in' then 'far_in' else 'far_out' end; end if;
  else fl := fl || 'no_gps'::text;
  end if;
  if p_dir = 'in' then
    for x in select c.user_id from job_crew c where c.job_id = j.id and c.removed_at is null and not c.absent
               and not exists (select 1 from time_entries o where o.user_id = c.user_id and o.clock_out is null) loop
      insert into time_entries (tenant_id, user_id, job_id, company_id, divisions, in_lat, in_lng, in_feet, flags)
      values (j.tenant_id, x.user_id, j.id, j.company_id, j.divisions, p_lat, p_lng, feet, fl);
      n := n + 1;
    end loop;
    return n;
  end if;
  for t in select o.* from time_entries o join job_crew c on c.user_id = o.user_id and c.job_id = j.id and c.removed_at is null
           where o.job_id = j.id and o.clock_out is null for update of o loop
    update time_entries set clock_out = greatest(now(), clock_in + interval '1 minute'), out_lat = p_lat, out_lng = p_lng, out_feet = feet,
           flags = (select array_agg(distinct f) from unnest(flags || fl) f), status = 'pending' where id = t.id returning * into t;
    insert into work_reviews (tenant_id, kind, ref_id, job_id, company_id, divisions, worker_id, summary, details)
    values (t.tenant_id, 'timesheet', t.id, t.job_id, t.company_id, t.divisions, t.user_id,
            format('%s hrs, clocked by %s', round((extract(epoch from (t.clock_out - t.clock_in)) / 3600 - t.break_min / 60.0)::numeric, 2), (select full_name from app_users where id = auth.uid())),
            jsonb_build_object('flags', t.flags, 'break_min', t.break_min));
    if private.time_auto_ok(t) then
      update time_entries set status = 'auto' where id = t.id;
      update work_reviews set status = 'auto', decided_at = now(), decision_note = 'Passed the auto-approve rules' where kind = 'timesheet' and ref_id = t.id and status = 'pending';
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.crew_mark(uuid, text, double precision, double precision, double precision), public.crew_clock(uuid, text, double precision, double precision, double precision) from public, anon;
grant execute on function public.crew_mark(uuid, text, double precision, double precision, double precision), public.crew_clock(uuid, text, double precision, double precision, double precision) to authenticated;
