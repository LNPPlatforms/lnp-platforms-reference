-- 071f: the foreman's Arrived and Left count for the crew, and missed clock-ins get flagged.

create or replace function private.crew_after_step() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare c record; foreman_name text; sup uuid;
begin
  if new.status not in ('arrived', 'left') or new.status is not distinct from old.status then return null; end if;
  if new.status = 'arrived' then
    -- foreman mode: everyone on the crew arrived with the foreman. Each mode: only the person tapping.
    update job_crew set arrived_at = now() where job_id = new.id and removed_at is null and not absent and arrived_at is null
      and (private.crew_opt(new.service_type, 'steps') = 'foreman' or user_id = coalesce(auth.uid(), new.assigned_to));
    -- missed clock-in: the crew clocks themselves and someone has no time running for this job
    if private.feature_on('timeclock') and private.crew_opt(new.service_type, 'clock') = 'self' then
      foreman_name := (select full_name from app_users where id = coalesce(new.assigned_to, auth.uid()));
      sup := coalesce(private.crew_supervisor(new.crew_id), (select manager_id from app_users where id = new.assigned_to));
      for c in select x.user_id, u.full_name from job_crew x join app_users u on u.id = x.user_id
               where x.job_id = new.id and x.removed_at is null and not x.absent and x.user_id is distinct from new.assigned_to
                 and not exists (select 1 from time_entries t where t.user_id = x.user_id and t.tenant_id = new.tenant_id
                                   and (t.job_id = new.id or (t.clock_out is null and t.clock_in > now() - interval '16 hours')))
                 and not exists (select 1 from crew_flags f where f.kind = 'missed_clock' and f.job_id = new.id and f.user_id = x.user_id) loop
        insert into crew_flags (tenant_id, kind, job_id, user_id, foreman_id, supervisor_id, divisions, summary)
        values (new.tenant_id, 'missed_clock', new.id, c.user_id, new.assigned_to, sup, new.divisions,
                format('%s marked the crew arrived but %s never clocked in', coalesce(foreman_name, 'The foreman'), c.full_name));
      end loop;
    end if;
  else
    update job_crew set left_at = now() where job_id = new.id and removed_at is null and not absent and left_at is null
      and (private.crew_opt(new.service_type, 'steps') = 'foreman' or user_id = coalesce(auth.uid(), new.assigned_to));
  end if;
  return null;
end $$;
create or replace trigger crew_after_step after update of status on public.jobs for each row execute function private.crew_after_step();

-- clocking in after the flag went up clears it
create or replace function private.crew_clocked_in() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if 'added_by_foreman' = any(new.flags) then return null; end if;
  update crew_flags set status = 'clocked_in', answered_at = now(), time_entry_id = new.id
   where kind = 'missed_clock' and status = 'open' and user_id = new.user_id and tenant_id = new.tenant_id
     and (job_id = new.job_id or (new.job_id is null and created_at > now() - interval '16 hours'));
  return null;
end $$;
create or replace trigger crew_clocked_in after insert on public.time_entries for each row execute function private.crew_clocked_in();
revoke execute on function private.crew_after_step(), private.crew_clocked_in() from public, anon, authenticated;

-- the foreman answers a missed clock-in. Was here: the hours they worked (and a note) become a time entry flagged
-- added_by_foreman that waits for the supervisor in Review. Wasn't here: they're marked absent on this job.
create or replace function public.crew_missed_answer(p_flag uuid, p_here boolean, p_hours numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare f crew_flags; j jobs; te uuid; who text; me text; st timestamptz; note_ text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into f from crew_flags where id = p_flag and tenant_id = private.current_tenant() for update;
  if f.id is null or f.kind <> 'missed_clock' then raise exception 'Not found'; end if;
  select * into j from jobs where id = f.job_id;
  if not (f.foreman_id = auth.uid() or j.assigned_to = auth.uid() or f.supervisor_id = auth.uid() or (private.can('dispatch', 2) and private.in_scope('dispatch', coalesce(j.assigned_to, j.created_by), j.divisions))) then
    raise exception 'Only the foreman or the supervisor can answer this';
  end if;
  if f.status <> 'open' then raise exception 'Already answered'; end if;
  who := (select full_name from app_users where id = f.user_id); me := (select full_name from app_users where id = auth.uid());
  if not p_here then
    update crew_flags set status = 'not_here', answered_by = auth.uid(), answered_at = now(), details = details || jsonb_build_object('note', note_) where id = f.id;
    update job_crew set absent = true where job_id = f.job_id and user_id = f.user_id;
    return jsonb_build_object('status', 'not_here');
  end if;
  if p_hours is null or p_hours <= 0 or p_hours > 24 then raise exception 'Enter the hours they worked (up to 24)'; end if;
  update crew_flags set status = 'was_here', answered_by = auth.uid(), answered_at = now(),
         details = details || jsonb_build_object('note', note_, 'hours', p_hours) where id = f.id;
  st := coalesce(j.arrived_at, now() - make_interval(secs => (p_hours * 3600)::int));
  insert into time_entries (tenant_id, user_id, job_id, company_id, divisions, clock_in, clock_out, flags, status, note, edited_by, edit_reason)
  values (f.tenant_id, f.user_id, j.id, j.company_id, j.divisions, st, st + make_interval(secs => greatest((p_hours * 3600)::int, 60)), array['added_by_foreman'],
          'pending', note_, auth.uid(), 'Added by ' || coalesce(me, 'the foreman') || coalesce(': ' || note_, ''))
  returning id into te;
  update crew_flags set time_entry_id = te where id = f.id;
  insert into work_reviews (tenant_id, kind, ref_id, job_id, company_id, divisions, worker_id, supervisor_id, summary, details)
  values (f.tenant_id, 'timesheet', te, j.id, j.company_id, j.divisions, f.user_id, f.supervisor_id,
          format('%s forgot to clock in, %s added these hours: %s hrs', who, coalesce(me, 'the foreman'), round(p_hours, 2)),
          jsonb_build_object('flags', array['added_by_foreman'], 'added_by', auth.uid(), 'note', note_, 'hours', p_hours, 'crew_flag', f.id));
  return jsonb_build_object('status', 'was_here', 'time_entry', te);
end $$;
revoke execute on function public.crew_missed_answer(uuid, boolean, numeric, text) from public, anon;
grant execute on function public.crew_missed_answer(uuid, boolean, numeric, text) to authenticated;
