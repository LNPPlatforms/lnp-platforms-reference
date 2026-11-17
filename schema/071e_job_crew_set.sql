-- 071e: putting people on a job, and swaps in Review.

-- who is on a job. p_crew: a saved crew (everyone on it comes along unless p_people says who). p_people: everyone,
-- for picking per job or pulling someone extra on. p_lead: the foreman for this job (else the crew's, else the first).
create or replace function public.job_crew_set(p_job uuid, p_crew uuid, p_people uuid[], p_lead uuid default null)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare j jobs; cr crews; ppl uuid[]; prev uuid[]; lead uuid; x uuid; dc uuid; sup uuid; swaps int := 0;
begin
  select * into j from jobs where id = p_job and tenant_id = private.current_tenant() and archived_at is null for update;
  if j.id is null or not private.feature_on('jobs') then raise exception 'Job not found'; end if;
  if not (private.can('dispatch', 2) or private.can('jobs', 3)) then raise exception 'Only dispatch or a manager can change who is on a job'; end if;
  if j.status in ('left', 'cancelled', 'no_show') then raise exception 'This job is already closed'; end if;
  if p_crew is not null then
    if private.crew_opt(null, 'mode') <> 'standing' then raise exception 'This account picks people per job. Turn on standing crews in Settings first.'; end if;
    select * into cr from crews where id = p_crew and tenant_id = j.tenant_id and archived_at is null;
    if cr.id is null then raise exception 'Crew not found'; end if;
  end if;
  ppl := coalesce(p_people, case when cr.id is not null then array[cr.foreman_id] || cr.member_ids end, '{}');
  select coalesce(array_agg(p order by o), '{}') into ppl from (select p, min(o) o from unnest(ppl) with ordinality u(p, o) where p is not null group by p) s;
  lead := coalesce(p_lead, case when cr.foreman_id = any(ppl) then cr.foreman_id end, ppl[1]);
  if lead is not null and not lead = any(ppl) then ppl := array[lead] || ppl; end if;
  foreach x in array ppl loop
    if not private.on_team(x, j.tenant_id) then raise exception 'Everyone on a job has to be on this account''s team'; end if;
  end loop;

  select coalesce(array_agg(user_id), '{}') into prev from job_crew where job_id = j.id and removed_at is null;
  update job_crew set removed_at = now() where job_id = j.id and removed_at is null and not (user_id = any(ppl));
  foreach x in array ppl loop
    perform private.job_crew_add(j.tenant_id, j.id, x, case when x = lead then 'lead' else 'member' end);
    -- pulled off their default crew for this job: Review only when it wasn't that crew's supervisor
    dc := private.default_crew(x);
    if private.crew_opt(null, 'mode') = 'standing' and not x = any(prev) and dc is not null and dc is distinct from p_crew then
      sup := private.crew_supervisor(dc);
      if sup is distinct from auth.uid() then
        insert into crew_flags (tenant_id, kind, job_id, user_id, foreman_id, supervisor_id, divisions, summary, details)
        values (j.tenant_id, 'swap', j.id, x, (select foreman_id from crews where id = dc), sup, j.divisions,
                format('%s moved %s off %s for one job', (select full_name from app_users where id = auth.uid()), (select full_name from app_users where id = x), (select name from crews where id = dc)),
                jsonb_build_object('from_crew', dc, 'to_crew', p_crew, 'moved_by', auth.uid()));
        swaps := swaps + 1;
      end if;
    end if;
  end loop;
  update jobs set assigned_to = lead, crew_id = p_crew where id = j.id;
  return jsonb_build_object('lead', lead, 'people', to_jsonb(ppl), 'swaps', swaps);
end $$;

-- a supervisor (or reviewer) marks a swap as seen
create or replace function public.crew_flag_seen(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare f crew_flags;
begin
  select * into f from crew_flags where id = p_id and tenant_id = private.current_tenant() for update;
  if f.id is null then raise exception 'Not found'; end if;
  if not (f.supervisor_id = auth.uid() or (private.can('review', 3) and private.in_scope('review', f.user_id, f.divisions))) then raise exception 'You can''t decide this one'; end if;
  if f.kind <> 'swap' or f.status <> 'open' then raise exception 'Already decided'; end if;
  update crew_flags set status = 'seen', answered_by = auth.uid(), answered_at = now(), details = details || jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')) where id = f.id;
end $$;

revoke execute on function public.job_crew_set(uuid, uuid, uuid[], uuid), public.crew_flag_seen(uuid, text) from public, anon;
grant execute on function public.job_crew_set(uuid, uuid, uuid[], uuid), public.crew_flag_seen(uuid, text) to authenticated;
