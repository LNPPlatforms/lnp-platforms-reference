-- 049: escalations can carry your own notes and turn into a regular to-do (Oct 20, 2026).
-- escalations.my_notes: notes from the person it was sent to (kept with the escalation).
-- escalation_to_task: makes a follow-up (task) on the same organization, assigned to you, carrying the escalation's
-- reason, note and your notes; the escalation is marked handled and linked to the task. Nothing is deleted.
-- tasks.notes: notes on any follow-up.

alter table public.escalations add column if not exists my_notes text;
alter table public.escalations add column if not exists task_id uuid references public.tasks(id);
alter table public.tasks add column if not exists notes text;
alter table public.tasks add column if not exists escalation_id uuid references public.escalations(id);

create or replace function public.escalation_to_task(p_esc uuid, p_title text, p_due date, p_notes text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare e escalations; tid uuid; nt text;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into e from escalations where id = p_esc and tenant_id = private.current_tenant() and (to_user = auth.uid() or private.is_admin()) for update;
  if not found then raise exception 'Escalation not found'; end if;
  if e.task_id is not null then raise exception 'This escalation is already a to-do'; end if;
  if length(trim(coalesce(p_title, ''))) < 2 then raise exception 'Give the to-do a title'; end if;
  nt := nullif(trim(coalesce(p_notes, '')), '');
  insert into tasks (tenant_id, company_id, title, due_date, assigned_to, notes, escalation_id)
  values (e.tenant_id, e.company_id, left(trim(p_title), 300), p_due, auth.uid(), nt, e.id) returning id into tid;
  update escalations set task_id = tid, my_notes = coalesce(nt, my_notes), status = 'cleared', cleared_at = now(), cleared_by = auth.uid() where id = e.id;
  insert into activities (company_id, type, body, created_by) values (e.company_id, 'note',
    format('Escalation from %s (%s) turned into a to-do: %s%s.', (select full_name from app_users where id = e.from_user), coalesce(e.reason, 'no reason given'),
      trim(p_title), case when p_due is not null then ', due ' || to_char(p_due, 'Mon DD, YYYY') else '' end), auth.uid());
  return tid;
end $$;
revoke execute on function public.escalation_to_task(uuid, text, date, text) from public, anon;
grant execute on function public.escalation_to_task(uuid, text, date, text) to authenticated;
