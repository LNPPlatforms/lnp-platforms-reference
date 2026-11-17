-- 071c: crew settings in account_settings, and job_crew kept in step with jobs.assigned_to.

-- account_settings_save learns the crews key. Swaps one line of the live function; stops if it isn't there.
do $$
declare d text; b text;
  old_ text := $q$    else raise exception 'Unknown setting %', k;$q$;
  new_ text := $q$    elsif k = 'crews' then
      if jsonb_typeof(v) <> 'object' or coalesce(v->>'mode', 'pick') not in ('standing', 'pick') or coalesce(v->>'clock', 'self') not in ('self', 'foreman')
         or coalesce(v->>'steps', 'foreman') not in ('foreman', 'each') or coalesce(v->>'pay', 'hours') not in ('hours', 'split')
         or (v ? 'by_service' and (jsonb_typeof(v->'by_service') <> 'object' or exists (select 1 from jsonb_each(v->'by_service') e
              where jsonb_typeof(e.value) <> 'object' or coalesce(e.value->>'clock', 'self') not in ('self', 'foreman') or coalesce(e.value->>'steps', 'foreman') not in ('foreman', 'each')))) then
        raise exception 'Crew settings have the wrong shape';
      end if;
      clean := clean || jsonb_build_object(k, v);
    else raise exception 'Unknown setting %', k;$q$;
begin
  d := replace(pg_get_functiondef('public.account_settings_save(jsonb)'::regprocedure), E'\r\n', E'\n');
  if position($q$elsif k = 'crews' then$q$ in d) > 0 then return; end if;
  b := d; d := replace(d, old_, new_);
  if d = b then raise exception 'crews settings patch did not match'; end if;
  execute d;
end $$;

-- a job from a repeat schedule picks up the schedule's crew, and its foreman when nobody is set
create or replace function private.job_crew_before() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare cr crews;
begin
  if new.crew_id is null and new.schedule_id is not null then
    select c.* into cr from job_schedules s join crews c on c.id = s.crew_id and c.archived_at is null where s.id = new.schedule_id;
    if cr.id is not null then new.crew_id := cr.id; new.assigned_to := coalesce(new.assigned_to, cr.foreman_id); end if;
  end if;
  return new;
end $$;
create or replace trigger job_crew_before before insert on public.jobs for each row execute function private.job_crew_before();

-- one person on the job (the lead) or a whole crew
create or replace function private.job_crew_add(p_tenant uuid, p_job uuid, p_user uuid, p_role text) returns void
language sql security definer set search_path = public, private as $$
  insert into job_crew (tenant_id, job_id, user_id, role, from_crew_id, added_by)
  values (p_tenant, p_job, p_user, p_role, private.default_crew(p_user), auth.uid())
  on conflict (job_id, user_id) do update set role = excluded.role, absent = case when job_crew.removed_at is not null then false else job_crew.absent end, removed_at = null
$$;

-- keep job_crew in step when assigned_to changes the old way (dispatch move, reassign, Quick Add, schedules)
create or replace function private.job_crew_sync() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare cr crews; n int; x uuid;
begin
  if tg_op = 'INSERT' then
    if new.crew_id is not null then
      select * into cr from crews where id = new.crew_id;
      foreach x in array array[cr.foreman_id] || cr.member_ids loop
        if x is not null and private.on_team(x, new.tenant_id) then perform private.job_crew_add(new.tenant_id, new.id, x, case when x = new.assigned_to then 'lead' else 'member' end); end if;
      end loop;
    end if;
    if new.assigned_to is not null then perform private.job_crew_add(new.tenant_id, new.id, new.assigned_to, 'lead'); end if;
    return null;
  end if;
  if new.assigned_to is not distinct from old.assigned_to then return null; end if;
  if new.assigned_to is null then
    update job_crew set removed_at = now() where job_id = new.id and removed_at is null;
    update jobs set crew_id = null where id = new.id and crew_id is not null;
    return null;
  end if;
  if exists (select 1 from job_crew where job_id = new.id and user_id = new.assigned_to and role = 'lead' and removed_at is null) then return null; end if;
  select count(*) into n from job_crew where job_id = new.id and removed_at is null;
  if n <= 1 and new.crew_id is null then
    update job_crew set removed_at = now() where job_id = new.id and removed_at is null and user_id <> new.assigned_to;
  else
    update job_crew set role = 'member' where job_id = new.id and role = 'lead' and user_id <> new.assigned_to;
  end if;
  perform private.job_crew_add(new.tenant_id, new.id, new.assigned_to, 'lead');
  return null;
end $$;
create or replace trigger job_crew_sync after insert or update of assigned_to on public.jobs for each row execute function private.job_crew_sync();
revoke execute on function private.job_crew_before(), private.job_crew_sync(), private.job_crew_add(uuid, uuid, uuid, text) from public, anon, authenticated;

-- jobs from before crews: the assigned person becomes the lead (and keeps any pay batch they were in)
insert into public.job_crew (tenant_id, job_id, user_id, role, pay_batch_id, added_by, added_at)
select j.tenant_id, j.id, j.assigned_to, 'lead', j.pay_batch_id, j.created_by, j.created_at from public.jobs j
where j.assigned_to is not null on conflict (job_id, user_id) do nothing;
