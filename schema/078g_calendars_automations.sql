-- 078g: booking calendars, part 7. Automations can start when an appointment is booked, cancelled, rescheduled, marked
-- no show or completed (optionally only for one calendar), and when an invoice is paid (069 already sends that event).
-- automation_save and automation_fire are the 066 versions with these added.

create or replace function public.automation_save(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; k text := p->'trigger'->>'kind';
begin
  if not private.can('automations', 2) then raise exception 'Your role can''t build automations'; end if;
  if k is null or k not in ('contact_created', 'field_changed', 'tag_added', 'tag_removed', 'form_submitted', 'link_clicked', 'qr_scanned',
                           'job_completed', 'chat_started', 'webhook_in', 'task_done', 'manual', 'invoice_paid',
                           'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_no_show', 'appointment_completed') then raise exception 'Pick what starts it'; end if;
  perform private.check_steps(coalesce(p->'steps', '[]'::jsonb));
  if p_id is null then
    insert into automations (name, active, trigger, steps, allow_repeat)
    values (trim(p->>'name'), coalesce((p->>'active')::boolean, false), p->'trigger', coalesce(p->'steps', '[]'), coalesce((p->>'allow_repeat')::boolean, false))
    returning id into v_id;
  else
    update automations set name = trim(p->>'name'), active = coalesce((p->>'active')::boolean, active), trigger = p->'trigger',
      steps = coalesce(p->'steps', '[]'), allow_repeat = coalesce((p->>'allow_repeat')::boolean, allow_repeat), updated_at = now()
     where id = p_id and tenant_id = private.current_tenant() and archived_at is null returning id into v_id;
    if v_id is null then raise exception 'Automation not found'; end if;
  end if;
  return v_id;
end $$;

-- an event starts every active automation it matches
create or replace function private.automation_fire(p_tenant uuid, p_kind text, p_person uuid, p_company uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare a automations; t jsonb;
begin
  if coalesce(nullif(current_setting('gelp.auto_depth', true), '')::int, 0) > 5 then return; end if;   -- automations setting off automations: stop at 5 deep
  for a in select * from automations where tenant_id = p_tenant and active and archived_at is null and trigger->>'kind' = p_kind loop
    t := a.trigger;
    if p_kind = 'form_submitted' and coalesce(t->>'form_id', '') <> '' and t->>'form_id' <> coalesce(p_data->>'form_id', '') then continue; end if;
    if p_kind in ('link_clicked', 'qr_scanned') and coalesce(t->>'link_id', '') <> '' and t->>'link_id' <> coalesce(p_data->>'link_id', '') then continue; end if;
    if p_kind like 'appointment\_%' and coalesce(t->>'calendar_id', '') <> '' and t->>'calendar_id' <> coalesce(p_data->>'calendar_id', '') then continue; end if;
    if p_kind = 'webhook_in' and coalesce(t->>'hook_id', '') <> '' and t->>'hook_id' <> coalesce(p_data->>'hook_id', '') then continue; end if;
    if p_kind in ('tag_added', 'tag_removed') and coalesce(t->>'tag', '') <> '' and lower(t->>'tag') <> lower(coalesce(p_data->>'tag', '')) then continue; end if;
    if p_kind = 'field_changed' then
      if coalesce(t->>'field', '') <> '' and t->>'field' <> coalesce(p_data->>'field', '') then continue; end if;
      if coalesce(t->>'to', '') <> '' and lower(t->>'to') <> lower(coalesce(p_data->>'to', '""')::jsonb #>> '{}') then continue; end if;
    end if;
    if not a.allow_repeat and exists (select 1 from automation_runs r where r.automation_id = a.id and r.status in ('running', 'waiting')
        and r.person_id is not distinct from p_person and (p_person is not null or r.company_id is not distinct from p_company)) then continue; end if;
    if (select count(*) from automation_runs r where r.automation_id = a.id and r.created_at > now() - interval '1 day'
        and r.person_id is not distinct from p_person and r.company_id is not distinct from p_company) >= 20 then continue; end if;
    insert into automation_runs (tenant_id, automation_id, person_id, company_id, data)
    values (p_tenant, a.id, p_person, case when p_person is null then p_company else coalesce(p_company,
      (select company_id from company_people where person_id = p_person limit 1)) end, p_data);
  end loop;
end $$;
revoke execute on function private.automation_fire(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.automation_save(uuid, jsonb) from public, anon;
grant execute on function public.automation_save(uuid, jsonb) to authenticated;
