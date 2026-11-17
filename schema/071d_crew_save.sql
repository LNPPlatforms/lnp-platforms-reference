-- 071d: saving crews.

-- add or change a saved crew. Someone joining this crew leaves their old default crew (a foreman can't lead two).
create or replace function public.crew_save(p_id uuid, p_name text, p_foreman uuid, p_members uuid[], p_supervisor uuid, p_divisions uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); mem uuid[]; x uuid; out uuid; other text;
begin
  if not (private.can('dispatch', 3) or private.can('jobs', 4)) then raise exception 'Only dispatch or someone who manages jobs can set up crews'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Give the crew a name'; end if;
  if p_foreman is null then raise exception 'Pick the foreman'; end if;
  select coalesce(array_agg(distinct m), '{}') into mem from unnest(coalesce(p_members, '{}')) m where m is not null and m <> p_foreman;
  foreach x in array array[p_foreman] || mem || case when p_supervisor is null then '{}'::uuid[] else array[p_supervisor] end loop
    if not private.on_team(x, t) then raise exception 'Everyone on a crew has to be on this account''s team'; end if;
  end loop;
  select name into other from crews where tenant_id = t and archived_at is null and id is distinct from p_id and foreman_id = any(array[p_foreman] || mem) limit 1;
  if other is not null then raise exception 'Someone here already leads %. Pick a different foreman for one of them first.', other; end if;
  if p_id is null then
    insert into crews (name, foreman_id, member_ids, supervisor_id, divisions) values (trim(p_name), p_foreman, mem, p_supervisor, coalesce(p_divisions, '{}')) returning id into out;
  else
    update crews set name = trim(p_name), foreman_id = p_foreman, member_ids = mem, supervisor_id = p_supervisor, divisions = coalesce(p_divisions, '{}')
     where id = p_id and tenant_id = t and archived_at is null returning id into out;
    if out is null then raise exception 'Crew not found'; end if;
  end if;
  -- their old default crew lets them go
  update crews set member_ids = (select coalesce(array_agg(m), '{}') from unnest(member_ids) m where not (m = any(array[p_foreman] || mem)))
   where tenant_id = t and archived_at is null and id <> out and member_ids && (array[p_foreman] || mem);
  return out;
end $$;

create or replace function public.crew_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.can('dispatch', 3) or private.can('jobs', 4)) then raise exception 'Only dispatch or someone who manages jobs can change crews'; end if;
  update crews set archived_at = now() where id = p_id and tenant_id = private.current_tenant();
  update job_schedules set crew_id = null where crew_id = p_id and tenant_id = private.current_tenant();
end $$;

revoke execute on function public.crew_save(uuid, text, uuid, uuid[], uuid, uuid[]), public.crew_archive(uuid) from public, anon;
grant execute on function public.crew_save(uuid, text, uuid, uuid[], uuid, uuid[]), public.crew_archive(uuid) to authenticated;
