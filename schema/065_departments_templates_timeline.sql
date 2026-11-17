-- 065: departments, customer facing, new permission areas, saved replies and the template library,
-- Shortcut sharing rules, tags, the contact timeline with lead source, media sharing and the brand kit.
-- Decisions from Chris's Oct 29 night voice walk-through (BACKLOG.md).

-- ---------- new permission areas ----------
-- automations: build automations and webhooks. marketing: tracked links, QR codes, campaigns.
-- templates: 1 use, 2 save personal, 3 publish to a department or the company (also sharing Shortcuts).
-- media: 1 view, 2 upload personal, 3 publish and share.
create or replace function private.perm_areas() returns text[] language sql immutable as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team',
               'automations', 'marketing', 'templates', 'media']
$$;

-- defaults for areas added after a role was saved (and for the presets, which predate them)
create or replace function private.area_default(p_preset text, area text) returns jsonb language sql immutable as $$
  select coalesce(case area
    when 'automations' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' end
    when 'marketing' then case p_preset when 'manager' then '{"level":4,"scope":"all"}' when 'division_manager' then '{"level":2,"scope":"division"}' when 'sales_rep' then '{"level":2,"scope":"own"}' end
    when 'templates' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":2,"scope":"all"}' else '{"level":2,"scope":"own"}' end
    when 'media' then case p_preset when 'manager' then '{"level":3,"scope":"all"}' when 'division_manager' then '{"level":3,"scope":"division"}' when 'accounting' then '{"level":1,"scope":"all"}' else '{"level":2,"scope":"own"}' end
  end, '{"level":0,"scope":"own"}')::jsonb
$$;

create or replace function private.perm(area text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case
    when u.id is null or not u.active or u.role in ('vendor', 'member') then '{"level":0,"scope":"own"}'::jsonb
    when u.is_admin then '{"level":4,"scope":"all"}'::jsonb
    when r.id is not null then coalesce(r.perms->area, private.area_default(r.preset_key, area))
    else coalesce(public.role_presets()->'manager'->'perms'->area, private.area_default('manager', area))
  end
  from (select auth.uid() as uid) x
  left join app_users u on u.id = x.uid
  left join roles r on r.id = u.role_id and r.archived_at is null and r.tenant_id = u.tenant_id
$$;
revoke execute on function private.area_default(text, text) from public, anon;
grant execute on function private.area_default(text, text) to authenticated;

-- ---------- customer facing ----------
-- the role makes someone customer facing (can be put on chat widgets). Admins and people with no role use the per-person switch.
alter table public.roles add column if not exists customer_facing boolean not null default false;
alter table public.app_users add column if not exists customer_facing boolean;
create or replace function private.is_customer_facing(p_user uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce(u.customer_facing, r.customer_facing, false) from app_users u
    left join roles r on r.id = u.role_id and r.archived_at is null where u.id = p_user and u.active
$$;
revoke execute on function private.is_customer_facing(uuid) from public, anon;
grant execute on function private.is_customer_facing(uuid) to authenticated;

-- team managers flip the switch
create or replace function public.user_customer_facing_set(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.is_admin() or private.can('team', 4)) then raise exception 'Only people who manage the team can change this'; end if;
  update app_users set customer_facing = p_on where id = p_user and tenant_id = private.current_tenant();
  if not found then raise exception 'Person not found'; end if;
end $$;
revoke execute on function public.user_customer_facing_set(uuid, boolean) from public, anon;
grant execute on function public.user_customer_facing_set(uuid, boolean) to authenticated;

-- role_save keeps working; this sets the role's customer facing flag
create or replace function public.role_customer_facing_set(p_role uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.is_admin() or private.can('team', 4)) then raise exception 'Only people who manage the team can change roles'; end if;
  update roles set customer_facing = p_on, updated_at = now() where id = p_role and tenant_id = private.current_tenant();
  if not found then raise exception 'Role not found'; end if;
end $$;
revoke execute on function public.role_customer_facing_set(uuid, boolean) from public, anon;
grant execute on function public.role_customer_facing_set(uuid, boolean) to authenticated;

-- ---------- departments (Sales, Support...) inside an account ----------
create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  manager_id uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create table if not exists public.department_members (
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  primary key (department_id, user_id)
);
alter table public.departments enable row level security;
alter table public.department_members enable row level security;
create policy "see departments" on public.departments for select using (tenant_id = private.current_tenant() and private.is_internal());
create policy "manage departments" on public.departments for all using (tenant_id = private.current_tenant() and (private.is_admin() or private.can('team', 4)))
  with check (tenant_id = private.current_tenant() and (private.is_admin() or private.can('team', 4)));
create policy "see department members" on public.department_members for select using (tenant_id = private.current_tenant() and private.is_internal());
create policy "manage department members" on public.department_members for all using (tenant_id = private.current_tenant() and (private.is_admin() or private.can('team', 4)))
  with check (tenant_id = private.current_tenant() and (private.is_admin() or private.can('team', 4))
    and exists (select 1 from departments d where d.id = department_id and d.tenant_id = private.current_tenant())
    and exists (select 1 from app_users u where u.id = user_id and u.tenant_id = private.current_tenant()));
revoke all on public.departments, public.department_members from anon, authenticated;
grant select, insert, update on public.departments to authenticated;
grant select, insert, delete on public.department_members to authenticated;
create trigger audit_departments after insert or update on public.departments for each row execute function private.audit();

create or replace function private.my_departments() returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce(array_agg(department_id), '{}') from department_members where user_id = auth.uid()
$$;
revoke execute on function private.my_departments() from public, anon;
grant execute on function private.my_departments() to authenticated;

-- ---------- tags (kept light: custom fields do most of the work now) ----------
alter table public.people add column if not exists tags text[] not null default '{}';
alter table public.companies add column if not exists tags text[] not null default '{}';
create index if not exists people_tags on public.people using gin (tags);
create index if not exists companies_tags on public.companies using gin (tags);

-- ---------- saved replies and the template library ----------
-- scope: starter (built in, every account), personal, department, company.
create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,      -- null only for starter templates
  kind text not null default 'reply' check (kind in ('reply', 'email', 'text', 'document')),
  scope text not null default 'personal' check (scope in ('starter', 'personal', 'department', 'company')),
  department_id uuid references public.departments(id),
  owner_id uuid references public.app_users(id),
  name text not null check (length(trim(name)) between 1 and 80),
  shortcut text check (shortcut is null or shortcut ~ '^[a-z0-9_-]{1,30}$'),
  subject text,
  body text not null default '' check (length(body) <= 50000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((scope = 'starter') = (tenant_id is null)),
  check (scope <> 'department' or department_id is not null)
);
create index if not exists templates_tenant on public.templates (tenant_id, kind);
alter table public.templates enable row level security;
create policy "see templates" on public.templates for select using (
  private.is_internal() and archived_at is null and (
    scope = 'starter'
    or (tenant_id = private.current_tenant() and (
         scope = 'company'
      or (scope = 'personal' and owner_id = auth.uid())
      or (scope = 'department' and (department_id = any(private.my_departments()) or private.can('templates', 3) and private.perm('templates')->>'scope' = 'all'))))));
revoke all on public.templates from anon, authenticated;
grant select on public.templates to authenticated;
create trigger audit_templates after insert or update on public.templates for each row execute function private.audit();

-- save (create or edit) a template. Publishing to a department or the company needs templates level 3.
create or replace function public.template_save(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare t templates; v_scope text := coalesce(p->>'scope', 'personal'); v_dept uuid := nullif(p->>'department_id', '')::uuid; v_id uuid;
begin
  if not private.can('templates', 2) then raise exception 'Your role can''t save templates'; end if;
  if v_scope not in ('personal', 'department', 'company') then raise exception 'Pick personal, a department or the company'; end if;
  if v_scope in ('department', 'company') and not private.can('templates', 3) then raise exception 'Your role can save personal templates only'; end if;
  if v_scope = 'department' then
    if v_dept is null or not exists (select 1 from departments where id = v_dept and tenant_id = private.current_tenant()) then raise exception 'Pick a department'; end if;
    if private.perm('templates')->>'scope' <> 'all' and not (v_dept = any(private.my_departments())) then raise exception 'You can only publish to your own departments'; end if;
  else v_dept := null; end if;
  if p_id is not null then
    select * into t from templates where id = p_id and tenant_id = private.current_tenant() and archived_at is null;
    if not found then raise exception 'Template not found'; end if;
    if not (t.owner_id = auth.uid() or (t.scope <> 'personal' and private.can('templates', 3))) then raise exception 'You can''t edit that template'; end if;
    update templates set kind = coalesce(p->>'kind', kind), scope = v_scope, department_id = v_dept, name = trim(p->>'name'),
      shortcut = nullif(lower(trim(p->>'shortcut')), ''), subject = nullif(p->>'subject', ''), body = coalesce(p->>'body', ''), updated_at = now()
     where id = p_id returning id into v_id;
  else
    insert into templates (tenant_id, kind, scope, department_id, owner_id, name, shortcut, subject, body)
    values (private.current_tenant(), coalesce(p->>'kind', 'reply'), v_scope, v_dept, auth.uid(), trim(p->>'name'),
            nullif(lower(trim(p->>'shortcut')), ''), nullif(p->>'subject', ''), coalesce(p->>'body', '')) returning id into v_id;
  end if;
  return v_id;
end $$;
create or replace function public.template_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare t templates;
begin
  select * into t from templates where id = p_id and tenant_id = private.current_tenant() and archived_at is null;
  if not found then raise exception 'Template not found'; end if;
  if not (t.owner_id = auth.uid() or (t.scope <> 'personal' and private.can('templates', 3))) then raise exception 'You can''t remove that template'; end if;
  update templates set archived_at = now() where id = p_id;
end $$;
revoke execute on function public.template_save(uuid, jsonb), public.template_archive(uuid) from public, anon;
grant execute on function public.template_save(uuid, jsonb), public.template_archive(uuid) to authenticated;

-- starter set every account gets
insert into public.templates (tenant_id, kind, scope, name, shortcut, body) values
  (null, 'reply', 'starter', 'Greeting', 'hi', 'Hi {contact.first_name}, this is {sender.first_name} with {account.name}. How can I help you today?'),
  (null, 'reply', 'starter', 'Thanks for reaching out', 'thanks', 'Thanks for reaching out, {contact.first_name}! Give me just a moment to look into that for you.'),
  (null, 'reply', 'starter', 'Get your email', 'email', 'What''s the best email to send that to?'),
  (null, 'reply', 'starter', 'Get your phone', 'phone', 'What''s the best number to reach you at?'),
  (null, 'reply', 'starter', 'Book a time', 'book', 'I''d love to set up a time to talk. What day and time work best for you?'),
  (null, 'reply', 'starter', 'Follow up soon', 'later', 'I''ll look into this and get back to you shortly.'),
  (null, 'reply', 'starter', 'Anything else', 'else', 'Is there anything else I can help you with today?'),
  (null, 'reply', 'starter', 'Closing', 'bye', 'Thanks for chatting with us, {contact.first_name}. Have a great day!'),
  (null, 'email', 'starter', 'Follow up after a call', 'followup', 'Hi {contact.first_name},

Thanks for your time today. As promised, here is a quick recap and the next steps.

Talk soon,
{sender.full_name}
{account.name}'),
  (null, 'email', 'starter', 'Review request', 'review', 'Hi {contact.first_name},

Thanks for choosing {account.name}. Would you take a minute to tell us how we did?

{sender.full_name}')
on conflict do nothing;

-- ---------- Shortcuts: sharing needs templates level 3; can be shared with a department ----------
alter table public.shortcuts add column if not exists department_id uuid references public.departments(id);
create or replace function private.guard_shortcut() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if (new.shared or new.department_id is not null) and not private.can('templates', 3) then
    raise exception 'Your role can save personal Shortcuts only';
  end if;
  return new;
end $$;
revoke execute on function private.guard_shortcut() from public, anon, authenticated;
create or replace trigger guard_shortcut before insert or update on public.shortcuts for each row execute function private.guard_shortcut();
drop policy if exists "see shortcuts" on public.shortcuts;
create policy "see shortcuts" on public.shortcuts for select using (tenant_id = private.current_tenant() and private.is_internal()
  and (user_id = auth.uid() or shared or department_id = any(private.my_departments())));

-- ---------- contact timeline and lead source ----------
-- every touch on a person or organization lands here (form, chat, link click, QR scan, webhook, email, automation, job...).
-- the first touch becomes the lead source.
create table if not exists public.contact_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  person_id uuid references public.people(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]{2,30}$'),
  title text not null,
  data jsonb not null default '{}'::jsonb,
  actor uuid references public.app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists contact_events_person on public.contact_events (person_id, created_at desc);
create index if not exists contact_events_company on public.contact_events (company_id, created_at desc);
create index if not exists contact_events_tenant on public.contact_events (tenant_id, kind, created_at desc);
alter table public.contact_events enable row level security;
create policy "see timeline" on public.contact_events for select using (tenant_id = private.current_tenant() and private.is_internal() and private.can('contacts', 1));
revoke all on public.contact_events from anon, authenticated;
grant select on public.contact_events to authenticated;

alter table public.people add column if not exists lead_source text;
alter table public.people add column if not exists lead_source_at timestamptz;

-- automations hook in here in 066 (private.automation_fire)
create or replace function private.automation_fire(p_tenant uuid, p_kind text, p_person uuid, p_company uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public, private as $$ begin return; end $$;

create or replace function private.emit(p_tenant uuid, p_kind text, p_title text, p_person uuid, p_company uuid, p_data jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; src text;
begin
  if p_tenant is null or (p_person is null and p_company is null) then return null; end if;
  insert into contact_events (tenant_id, person_id, company_id, kind, title, data, actor)
  values (p_tenant, p_person, p_company, p_kind, left(p_title, 300), coalesce(p_data, '{}'::jsonb), auth.uid()) returning id into v_id;
  src := case p_kind when 'form_submitted' then 'Form: ' || coalesce(p_data->>'form', 'website form')
    when 'chat_started' then 'Live chat' || coalesce(': ' || nullif(p_data->>'widget', ''), '')
    when 'link_clicked' then 'Link: ' || coalesce(p_data->>'name', '') when 'qr_scanned' then 'QR code: ' || coalesce(p_data->>'name', '')
    when 'webhook_in' then 'Webhook: ' || coalesce(p_data->>'name', '') when 'imported' then 'Import'
    when 'created' then coalesce(nullif(p_data->>'source', ''), 'Added by hand') end;
  if p_person is not null and src is not null then
    update people set lead_source = src, lead_source_at = now() where id = p_person and lead_source is null;
  end if;
  if p_company is not null and src is not null then
    update companies set lead_source_channel = src where id = p_company and lead_source_channel is null;
  end if;
  begin
    perform private.automation_fire(p_tenant, p_kind, p_person, p_company, coalesce(p_data, '{}'::jsonb) || jsonb_build_object('event_id', v_id));
  exception when others then
    insert into contact_events (tenant_id, person_id, company_id, kind, title, data)
    values (p_tenant, p_person, p_company, 'automation_error', 'Automation could not start', jsonb_build_object('error', sqlerrm));
  end;
  return v_id;
end $$;
revoke execute on function private.emit(uuid, text, text, uuid, uuid, jsonb), private.automation_fire(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- staff add a note-like entry by hand (shows on the timeline)
create or replace function public.timeline_note(p_person uuid, p_company uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('contacts', 2) then raise exception 'Not allowed'; end if;
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a note'; end if;
  if p_person is not null and not exists (select 1 from people where id = p_person and tenant_id = private.current_tenant()) then raise exception 'Not found'; end if;
  if p_company is not null and not exists (select 1 from companies where id = p_company and tenant_id = private.current_tenant()) then raise exception 'Not found'; end if;
  return private.emit(private.current_tenant(), 'note', left(trim(p_body), 300), p_person, p_company, jsonb_build_object('body', trim(p_body)));
end $$;
revoke execute on function public.timeline_note(uuid, uuid, text) from public, anon;
grant execute on function public.timeline_note(uuid, uuid, text) to authenticated;

-- events from what already happens in the CRM
create or replace function private.ev_person() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare k text; fld text;
begin
  if tg_op = 'INSERT' then
    perform private.emit(new.tenant_id, 'created', 'Added to contacts', new.id, null, jsonb_build_object('source', current_setting('gelp.source', true)));
  else
    if new.tags is distinct from old.tags then
      for k in select unnest(new.tags) except select unnest(old.tags) loop perform private.emit(new.tenant_id, 'tag_added', 'Tag added: ' || k, new.id, null, jsonb_build_object('tag', k)); end loop;
      for k in select unnest(old.tags) except select unnest(new.tags) loop perform private.emit(new.tenant_id, 'tag_removed', 'Tag removed: ' || k, new.id, null, jsonb_build_object('tag', k)); end loop;
    end if;
    for fld in select key from jsonb_each(coalesce(new.custom, '{}'::jsonb)) where (old.custom->key) is distinct from value
               union select key from jsonb_each(coalesce(old.custom, '{}'::jsonb)) where not (coalesce(new.custom, '{}'::jsonb) ? key) loop
      perform private.emit(new.tenant_id, 'field_changed', 'Field changed: ' || fld, new.id, null,
        jsonb_build_object('field', 'custom.' || fld, 'from', old.custom->fld, 'to', new.custom->fld));
    end loop;
    foreach fld in array array['first_name', 'last_name', 'personal_email', 'personal_cell', 'preferred_contact_method'] loop
      if (to_jsonb(new)->fld) is distinct from (to_jsonb(old)->fld) then
        perform private.emit(new.tenant_id, 'field_changed', 'Field changed: ' || fld, new.id, null, jsonb_build_object('field', fld, 'from', to_jsonb(old)->fld, 'to', to_jsonb(new)->fld));
      end if;
    end loop;
  end if;
  return null;
exception when others then return null;   -- the timeline never blocks a save
end $$;
create or replace function private.ev_company() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare k text; fld text;
begin
  if tg_op = 'INSERT' then
    perform private.emit(new.tenant_id, 'created', 'Organization added', null, new.id, jsonb_build_object('source', current_setting('gelp.source', true)));
  else
    if new.tags is distinct from old.tags then
      for k in select unnest(new.tags) except select unnest(old.tags) loop perform private.emit(new.tenant_id, 'tag_added', 'Tag added: ' || k, null, new.id, jsonb_build_object('tag', k)); end loop;
      for k in select unnest(old.tags) except select unnest(new.tags) loop perform private.emit(new.tenant_id, 'tag_removed', 'Tag removed: ' || k, null, new.id, jsonb_build_object('tag', k)); end loop;
    end if;
    for fld in select key from jsonb_each(coalesce(new.custom, '{}'::jsonb)) where (old.custom->key) is distinct from value loop
      perform private.emit(new.tenant_id, 'field_changed', 'Field changed: ' || fld, null, new.id, jsonb_build_object('field', 'custom.' || fld, 'from', old.custom->fld, 'to', new.custom->fld));
    end loop;
    foreach fld in array array['stage', 'pipeline_stage_id', 'owner_id', 'interest_level', 'follow_up_date', 'main_email', 'main_phone'] loop
      if (to_jsonb(new)->fld) is distinct from (to_jsonb(old)->fld) then
        perform private.emit(new.tenant_id, 'field_changed', 'Field changed: ' || fld, null, new.id, jsonb_build_object('field', fld, 'from', to_jsonb(old)->fld, 'to', to_jsonb(new)->fld));
      end if;
    end loop;
  end if;
  return null;
exception when others then return null;
end $$;
create or replace function private.ev_form() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  perform private.emit(new.tenant_id, 'form_submitted', 'Submitted ' || coalesce((select name from site_forms where id = new.form_id), 'a form'),
    new.person_id, new.company_id, jsonb_build_object('form_id', new.form_id, 'form', (select name from site_forms where id = new.form_id), 'page', new.page_url));
  return null;
exception when others then return null;
end $$;
create or replace function private.ev_job() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    perform private.emit(new.tenant_id, 'job_completed', 'Job completed: ' || coalesce(new.title, '#' || new.number), new.person_id, new.company_id, jsonb_build_object('job_id', new.id));
  end if;
  return null;
exception when others then return null;
end $$;
create or replace function private.ev_task() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.done and not coalesce(old.done, false) then
    perform private.emit(new.tenant_id, 'task_done', 'To-do done: ' || new.title, new.person_id, new.company_id, jsonb_build_object('task_id', new.id));
  end if;
  return null;
exception when others then return null;
end $$;
revoke execute on function private.ev_person(), private.ev_company(), private.ev_form(), private.ev_job(), private.ev_task() from public, anon, authenticated;
create or replace trigger ev_person after insert or update on public.people for each row execute function private.ev_person();
create or replace trigger ev_company after insert or update on public.companies for each row execute function private.ev_company();
create or replace trigger ev_form after insert on public.form_submissions for each row execute function private.ev_form();
create or replace trigger ev_job after update of status on public.jobs for each row execute function private.ev_job();
create or replace trigger ev_task after update of done on public.tasks for each row execute function private.ev_task();

-- one timeline for a person or an organization (organization includes its people)
create or replace function public.timeline(p_person uuid, p_company uuid, p_limit int default 100) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', e.id, 'kind', e.kind, 'title', e.title, 'data', e.data, 'at', e.created_at,
      'by', (select full_name from app_users where id = e.actor), 'person', (select trim(first_name || ' ' || coalesce(last_name, '')) from people where id = e.person_id)) x
    from contact_events e
    where e.tenant_id = private.current_tenant() and private.is_internal() and private.can('contacts', 1)
      and ((p_person is not null and e.person_id = p_person)
        or (p_company is not null and (e.company_id = p_company or e.person_id in (select person_id from company_people where company_id = p_company))))
    order by e.created_at desc limit least(coalesce(p_limit, 100), 500)) s
$$;
revoke execute on function public.timeline(uuid, uuid, int) from public, anon;
grant execute on function public.timeline(uuid, uuid, int) to authenticated;

-- ---------- media: personal, department or company; shared down to companies in the account and child accounts ----------
alter table public.media add column if not exists scope text not null default 'company' check (scope in ('personal', 'department', 'company'));
alter table public.media add column if not exists department_id uuid references public.departments(id);
alter table public.media add column if not exists divisions uuid[] not null default '{}';          -- companies in this account it's shared with; empty: parent level only
alter table public.media add column if not exists share_tenant_ids uuid[] not null default '{}';   -- child accounts it's shared with
alter table public.media add column if not exists folder text;
alter table public.media drop constraint if exists media_kind_check;
alter table public.media add constraint media_kind_check check (kind in ('logo', 'photo', 'file', 'video', 'brand'));
alter table public.media drop constraint if exists media_entity_check;

create or replace function private.media_visible(m public.media) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and m.archived_at is null and (
    (m.tenant_id = private.current_tenant() and (
       (m.scope = 'personal' and m.created_by = auth.uid())
       or (m.scope = 'department' and (m.department_id = any(private.my_departments()) or private.can('media', 3)))
       or (m.scope = 'company' and (cardinality(private.my_divisions()) = 0 or m.divisions && private.my_divisions()))
       or m.entity is not null))
    or (private.current_tenant() = any(m.share_tenant_ids) and m.scope = 'company'))
$$;
revoke execute on function private.media_visible(public.media) from public, anon;
grant execute on function private.media_visible(public.media) to authenticated;
drop policy if exists "shared media" on public.media;
create policy "shared media" on public.media for select using (private.media_visible(media));
create policy "internal add media" on public.media for insert with check (private.is_internal() and tenant_id = private.current_tenant());
create policy "internal edit media" on public.media for update using (private.is_internal() and tenant_id = private.current_tenant()
  and (entity is not null or created_by = auth.uid() or private.can('media', 3))) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "internal all media" on public.media using (false) with check (false);   -- replaced by the three above

-- library listing (only files meant for the library, not attachments on a record)
create or replace function public.media_library() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'url', m.url, 'title', m.title, 'kind', m.kind, 'mime', m.mime, 'bytes', m.bytes,
      'scope', m.scope, 'department_id', m.department_id, 'divisions', m.divisions, 'share_tenant_ids', m.share_tenant_ids, 'folder', m.folder,
      'mine', m.created_by = auth.uid(), 'from_parent', m.tenant_id <> private.current_tenant(), 'created_at', m.created_at,
      'by', (select full_name from app_users where id = m.created_by)) order by m.created_at desc), '[]'::jsonb)
  from media m where m.entity is null and private.can('media', 1) and private.media_visible(m)
$$;
create or replace function public.media_add(p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v_scope text := coalesce(p->>'scope', 'personal'); v_id uuid; v_divs uuid[]; v_tenants uuid[];
begin
  if not private.can('media', 2) then raise exception 'Your role can''t upload media'; end if;
  if v_scope <> 'personal' and not private.can('media', 3) then raise exception 'Your role can save personal files only'; end if;
  if coalesce(p->>'path', '') !~ ('^' || private.current_tenant()::text || '/') then raise exception 'Upload into your account''s folder'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_divs from jsonb_array_elements_text(coalesce(p->'divisions', '[]')) x
    where exists (select 1 from divisions where id = x::uuid and tenant_id = private.current_tenant());
  select coalesce(array_agg(x::uuid), '{}') into v_tenants from jsonb_array_elements_text(coalesce(p->'share_tenant_ids', '[]')) x
    where exists (select 1 from tenants where id = x::uuid and agency_tenant_id = private.current_tenant());
  insert into media (tenant_id, bucket, path, url, kind, title, mime, bytes, scope, department_id, divisions, share_tenant_ids, folder)
  values (private.current_tenant(), 'media', p->>'path', p->>'url', coalesce(nullif(p->>'kind', ''), 'file'), left(p->>'title', 200), p->>'mime',
          nullif(p->>'bytes', '')::bigint, v_scope, case when v_scope = 'department' then nullif(p->>'department_id', '')::uuid end, v_divs, v_tenants, nullif(trim(p->>'folder'), ''))
  returning id into v_id;
  return v_id;
end $$;
create or replace function public.media_share(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare m media; v_divs uuid[]; v_tenants uuid[];
begin
  select * into m from media where id = p_id and tenant_id = private.current_tenant() and archived_at is null;
  if not found then raise exception 'File not found'; end if;
  if not (m.created_by = auth.uid() and coalesce(p->>'scope', m.scope) = 'personal' or private.can('media', 3)) then raise exception 'Your role can''t share files'; end if;
  select coalesce(array_agg(x::uuid), '{}') into v_divs from jsonb_array_elements_text(coalesce(p->'divisions', '[]')) x
    where exists (select 1 from divisions where id = x::uuid and tenant_id = private.current_tenant());
  select coalesce(array_agg(x::uuid), '{}') into v_tenants from jsonb_array_elements_text(coalesce(p->'share_tenant_ids', '[]')) x
    where exists (select 1 from tenants where id = x::uuid and agency_tenant_id = private.current_tenant());
  update media set scope = coalesce(p->>'scope', scope), department_id = case when coalesce(p->>'scope', scope) = 'department' then nullif(p->>'department_id', '')::uuid end,
    divisions = v_divs, share_tenant_ids = v_tenants, title = coalesce(nullif(p->>'title', ''), title), folder = nullif(trim(coalesce(p->>'folder', folder)), '')
   where id = p_id;
end $$;
create or replace function public.media_remove(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  update media set archived_at = now() where id = p_id and tenant_id = private.current_tenant() and entity is null
     and (created_by = auth.uid() or private.can('media', 3));
  if not found then raise exception 'You can''t remove that file'; end if;
end $$;
revoke execute on function public.media_library(), public.media_add(jsonb), public.media_share(uuid, jsonb), public.media_remove(uuid) from public, anon;
grant execute on function public.media_library(), public.media_add(jsonb), public.media_share(uuid, jsonb), public.media_remove(uuid) to authenticated;
-- the media bucket takes more than pictures now
update storage.buckets set allowed_mime_types = null, file_size_limit = 52428800 where id = 'media';

-- ---------- brand kit ----------
create table if not exists public.brand_kits (
  tenant_id uuid primary key default private.current_tenant() references public.tenants(id) on delete cascade,
  logos jsonb not null default '{}'::jsonb,        -- {favicon, wide, square, circle, default}: media urls
  colors jsonb not null default '[]'::jsonb,       -- [{name, hex}]
  fonts jsonb not null default '[]'::jsonb,        -- [{role: heading|body|accent, family, url}]
  rules jsonb not null default '[]'::jsonb,        -- [{kind: do|dont, text, image}]
  guide_url text,                                  -- uploaded brand kit file (reading it automatically comes later)
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.brand_kits enable row level security;
create policy "see brand kit" on public.brand_kits for select using (tenant_id = private.current_tenant() and private.is_internal());
revoke all on public.brand_kits from anon, authenticated;
grant select on public.brand_kits to authenticated;
create trigger audit_brand_kits after insert or update on public.brand_kits for each row execute function private.audit();
create or replace function public.brand_kit_save(p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.is_admin() or private.can('settings', 2) or private.can('media', 3)) then raise exception 'Your role can''t change the brand kit'; end if;
  insert into brand_kits (tenant_id, logos, colors, fonts, rules, guide_url, updated_at, updated_by)
  values (private.current_tenant(), coalesce(p->'logos', '{}'), coalesce(p->'colors', '[]'), coalesce(p->'fonts', '[]'), coalesce(p->'rules', '[]'), nullif(p->>'guide_url', ''), now(), auth.uid())
  on conflict (tenant_id) do update set logos = excluded.logos, colors = excluded.colors, fonts = excluded.fonts, rules = excluded.rules,
    guide_url = excluded.guide_url, updated_at = now(), updated_by = auth.uid();
end $$;
revoke execute on function public.brand_kit_save(jsonb) from public, anon;
grant execute on function public.brand_kit_save(jsonb) to authenticated;
