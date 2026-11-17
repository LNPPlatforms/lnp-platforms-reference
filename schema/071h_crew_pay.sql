-- 071h: the whole crew can add photos, notes, costs and pin reports; pay per job goes to everyone on the crew.
-- Each fix swaps a piece of the live function; it stops if the piece isn't there (so nothing changes silently).

-- one person's per-job pay on a job. Split: the job's pay shared across the crew (equal unless a share is set).
-- Hours: the job's pay goes to the lead as before; everyone on a per-job rate gets their rate.
create or replace function private.crew_job_pay(j jobs, c job_crew) returns numeric
language plpgsql stable security definer set search_path = public, private as $$
declare r record; n int;
begin
  select * into r from private.rate_on(c.user_id, j.divisions[1], (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date);
  if j.pay_amount is not null then
    if private.crew_opt(null, 'pay') = 'split' then
      select count(*) into n from job_crew x where x.job_id = j.id and x.removed_at is null and not x.absent;
      return round(j.pay_amount * coalesce(c.share, 100.0 / greatest(n, 1)) / 100, 2);
    elsif c.user_id = j.assigned_to then
      return j.pay_amount;
    end if;
  end if;
  if r.kind = 'per_job' then return r.rate; end if;
  return null;
end $$;

-- split pay covers the time on that job, so those hours aren't paid twice
create or replace function private.crew_split_covers(p_job uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select p_job is not null and private.crew_opt(null, 'pay') = 'split' and exists (select 1 from jobs where id = p_job and pay_amount is not null)
$$;
revoke execute on function private.crew_job_pay(jobs, job_crew), private.crew_split_covers(uuid) from public, anon;
grant execute on function private.crew_job_pay(jobs, job_crew), private.crew_split_covers(uuid) to authenticated;

do $$
declare d text; b text; i int; s int; e int;
  fixes text[][] := array[
    array['public.job_note(uuid,text,text,text)', $q$j.assigned_to = auth.uid()$q$, $q$(j.assigned_to = auth.uid() or private.on_job_crew(j.id))$q$],
    array['public.job_cost_add(uuid,uuid,text,numeric,numeric,text)', $q$j.assigned_to = auth.uid()$q$, $q$(j.assigned_to = auth.uid() or private.on_job_crew(j.id))$q$],
    array['public.pin_report(uuid,double precision,double precision,double precision,text,text)', $q$j.assigned_to = auth.uid()$q$, $q$(j.assigned_to = auth.uid() or private.on_job_crew(j.id))$q$],
    array['public.pay_batch_build(date,date,text,uuid,uuid)', $q$and coalesce(p.worker_class, 'w2') = p_class;$q$,
          $q$and coalesce(p.worker_class, 'w2') = p_class and not private.crew_split_covers(t.job_id);$q$],
    array['public.pay_batch_build(date,date,text,uuid,uuid)', $q$update jobs set pay_batch_id = null where pay_batch_id = p_batch;$q$,
          $q$update jobs set pay_batch_id = null where pay_batch_id = p_batch; update job_crew set pay_batch_id = null where pay_batch_id = p_batch;$q$]];
  per_job text := $q$for r in select c.user_id, j.divisions[1] div, count(*)::int n, sum(private.crew_job_pay(j, c)) amt, array_agg(c.id) cids, array_agg(j.id) ids
           from job_crew c join jobs j on j.id = c.job_id left join worker_pay_profiles p on p.user_id = c.user_id
           where j.tenant_id = private.current_tenant() and j.approval in ('approved', 'auto') and c.removed_at is null and not c.absent and c.pay_batch_id is null
             and (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date between p_start and p_end and coalesce(p.worker_class, 'w2') = p_class
             and private.crew_job_pay(j, c) is not null
           group by 1, 2 loop
    insert into pay_lines (batch_id, user_id, division_id, kind, jobs, rate, amount, job_ids) values (b, r.user_id, r.div, 'per_job', r.n, case when r.n > 0 then round(r.amt / r.n, 2) else 0 end, round(r.amt, 2), r.ids);
    update job_crew set pay_batch_id = b where id = any(r.cids);
    update jobs set pay_batch_id = b where id = any(r.ids) and pay_batch_id is null;
  end loop;$q$;
  tail text := $q$update jobs set pay_batch_id = b where id = any(r.ids);
  end loop;$q$;
begin
  for i in 1 .. array_length(fixes, 1) loop
    d := replace(pg_get_functiondef(fixes[i][1]::regprocedure), E'\r\n', E'\n');
    if position(fixes[i][3] in d) > 0 then continue; end if;
    b := d; d := replace(d, fixes[i][2], fixes[i][3]);
    if d = b then raise exception 'crew patch % (%) did not match', i, fixes[i][1]; end if;
    execute d;
  end loop;
  -- the per-job pay loop: from its "for r in select j.assigned_to" to the end of that loop
  d := replace(pg_get_functiondef('public.pay_batch_build(date,date,text,uuid,uuid)'::regprocedure), E'\r\n', E'\n');
  if position('sum(private.crew_job_pay(j, c))' in d) = 0 then
    s := position('for r in select j.assigned_to user_id' in d);
    e := position(tail in d);
    if s = 0 or e = 0 or e < s then raise exception 'crew pay patch did not match'; end if;
    d := substr(d, 1, s - 1) || per_job || substr(d, e + length(tail));
    execute d;
  end if;
end $$;
