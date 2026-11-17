-- 071b: crew helpers and who can see crews, job crews and crew flags.

-- is the signed-in person on this job's crew
create or replace function private.on_job_crew(p_job uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from job_crew c where c.job_id = p_job and c.user_id = auth.uid() and c.removed_at is null)
$$;

-- a crew setting for a service type: the service's own, else the account's, else the default
create or replace function private.crew_opt(p_service text, k text) returns text
language sql stable security definer set search_path = public, private as $$
  select coalesce(case when k in ('clock', 'steps') then private.acct_setting('crews')->'by_service'->coalesce(p_service, '')->>k end,
                  private.acct_setting('crews')->>k,
                  case k when 'mode' then 'pick' when 'clock' then 'self' when 'steps' then 'foreman' when 'pay' then 'hours' end)
$$;

-- someone's default crew (foreman of it or a member)
create or replace function private.default_crew(p_user uuid) returns uuid
language sql stable security definer set search_path = public, private as $$
  select id from crews where tenant_id = private.current_tenant() and archived_at is null and (foreman_id = p_user or p_user = any(member_ids))
  order by (foreman_id = p_user) desc, created_at limit 1
$$;

-- who supervises a crew: its supervisor, else the foreman's manager
create or replace function private.crew_supervisor(p_crew uuid) returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce(c.supervisor_id, u.manager_id) from crews c left join app_users u on u.id = c.foreman_id where c.id = p_crew
$$;

create policy "see crews" on public.crews for select using (tenant_id = private.current_tenant() and private.is_internal());
create policy "see job crew" on public.job_crew for select using (tenant_id = private.current_tenant()
  and (user_id = auth.uid() or private.can('jobs', 1) or private.can('dispatch', 1) or private.on_job_crew(job_id)));
create policy "see crew flags" on public.crew_flags for select using (tenant_id = private.current_tenant()
  and (foreman_id = auth.uid() or supervisor_id = auth.uid() or (private.can('review', 1) and private.in_scope('review', user_id, divisions))));
-- crew members see the jobs they're on; supervisors see the timesheets sent to them
create policy "crew sees jobs" on public.jobs for select using (tenant_id = private.current_tenant() and private.feature_on('jobs') and private.on_job_crew(id));
create policy "supervisor sees crew reviews" on public.work_reviews for select using (tenant_id = private.current_tenant() and supervisor_id = auth.uid());

revoke execute on function private.on_job_crew(uuid), private.crew_opt(text, text), private.default_crew(uuid), private.crew_supervisor(uuid) from public, anon;
grant execute on function private.on_job_crew(uuid), private.crew_opt(text, text), private.default_crew(uuid), private.crew_supervisor(uuid) to authenticated;
