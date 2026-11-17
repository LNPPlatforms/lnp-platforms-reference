-- 066: the native automation builder, tracked links and QR codes, incoming webhooks and the email outbox.
-- Automations are a trigger plus a list of steps (if/then branches nest). A run walks the steps; waits park it until later.
-- Runner: pg_cron every 30 seconds. Email goes out through the automation-send edge function (Resend).

-- ---------- automations ----------
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  active boolean not null default false,
  trigger jsonb not null default '{}'::jsonb,       -- {kind, form_id, link_id, hook_id, field, to, tag}
  steps jsonb not null default '[]'::jsonb,         -- [{type, ...}], if: {then: [...], else: [...]}
  allow_repeat boolean not null default false,      -- start again for a contact who is already in it
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  person_id uuid references public.people(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  pos jsonb not null default '[0]'::jsonb,          -- where it is in the steps, like [2, "then", 0]
  status text not null default 'running' check (status in ('running', 'waiting', 'done', 'failed', 'stopped')),
  wake_at timestamptz not null default now(),
  log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists automation_runs_due on public.automation_runs (wake_at) where status in ('running', 'waiting');
create index if not exists automation_runs_auto on public.automation_runs (automation_id, created_at desc);
alter table public.automations enable row level security;
alter table public.automation_runs enable row level security;
create policy "see automations" on public.automations for select using (tenant_id = private.current_tenant() and private.can('automations', 1));
create policy "see runs" on public.automation_runs for select using (tenant_id = private.current_tenant() and private.can('automations', 1));
revoke all on public.automations, public.automation_runs from anon, authenticated;
grant select on public.automations, public.automation_runs to authenticated;
create trigger audit_automations after insert or update on public.automations for each row execute function private.audit();

-- people can opt out of automated email
alter table public.people add column if not exists email_opt_out boolean not null default false;

-- check a step list before saving (types, required bits, no runaway nesting)
create or replace function private.check_steps(p jsonb, depth int default 0) returns void
language plpgsql immutable as $$
declare s jsonb;
begin
  if depth > 6 then raise exception 'Too many if/then levels (6 max)'; end if;
  if jsonb_typeof(coalesce(p, '[]'::jsonb)) <> 'array' then raise exception 'Steps must be a list'; end if;
  if jsonb_array_length(p) > 100 then raise exception 'Too many steps (100 max)'; end if;
  for s in select * from jsonb_array_elements(p) loop
    case s->>'type'
      when 'wait' then if coalesce((s->>'amount')::numeric, 0) <= 0 or coalesce(s->>'unit', '') not in ('minutes', 'hours', 'days') then raise exception 'A wait needs an amount and minutes, hours or days'; end if;
      when 'if' then
        if coalesce(s->>'field', '') = '' then raise exception 'An if step needs a field to check'; end if;
        perform private.check_steps(coalesce(s->'then', '[]'::jsonb), depth + 1);
        perform private.check_steps(coalesce(s->'else', '[]'::jsonb), depth + 1);
      when 'set_field' then if coalesce(s->>'field', '') = '' then raise exception 'Pick the field to update'; end if;
      when 'add_tag', 'remove_tag' then if coalesce(trim(s->>'tag'), '') = '' then raise exception 'Type the tag'; end if;
      when 'assign' then if coalesce(s->>'user_id', '') = '' then raise exception 'Pick who to assign'; end if;
      when 'task' then if coalesce(trim(s->>'title'), '') = '' then raise exception 'A to-do needs a title'; end if;
      when 'email' then if coalesce(s->>'template_id', '') = '' and coalesce(trim(s->>'body'), '') = '' then raise exception 'An email needs a template or a message'; end if;
      when 'webhook' then if coalesce(s->>'url', '') !~ '^https://' then raise exception 'A webhook needs an https:// address'; end if;
      when 'notify' then if coalesce(trim(s->>'text'), '') = '' then raise exception 'Type the notification'; end if;
      when 'start' then if coalesce(s->>'automation_id', '') = '' then raise exception 'Pick the automation to start'; end if;
      when 'stop' then null;
      else raise exception 'Unknown step: %', coalesce(s->>'type', '(none)');
    end case;
  end loop;
end $$;

create or replace function public.automation_save(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; k text := p->'trigger'->>'kind';
begin
  if not private.can('automations', 2) then raise exception 'Your role can''t build automations'; end if;
  if k is null or k not in ('contact_created', 'field_changed', 'tag_added', 'tag_removed', 'form_submitted', 'link_clicked', 'qr_scanned',
                           'job_completed', 'chat_started', 'webhook_in', 'task_done', 'manual') then raise exception 'Pick what starts it'; end if;
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
create or replace function public.automation_set(p_id uuid, p_active boolean, p_archive boolean default false) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('automations', 2) then raise exception 'Your role can''t change automations'; end if;
  update automations set active = case when p_archive then false else p_active end, archived_at = case when p_archive then now() else archived_at end, updated_at = now()
   where id = p_id and tenant_id = private.current_tenant();
  if not found then raise exception 'Automation not found'; end if;
  if p_archive or not p_active then
    update automation_runs set status = 'stopped', updated_at = now(), log = log || jsonb_build_object('at', now(), 'msg', 'Stopped: automation turned off')
     where automation_id = p_id and status in ('running', 'waiting');
  end if;
end $$;
-- start an automation by hand for one or more contacts (bulk action, or a "manual" automation)
create or replace function public.automation_start(p_id uuid, p_people uuid[], p_companies uuid[] default '{}') returns int
language plpgsql security definer set search_path = public, private as $$
declare a automations; x uuid; n int := 0;
begin
  if not private.can('automations', 1) or not private.can('contacts', 2) then raise exception 'Not allowed'; end if;
  select * into a from automations where id = p_id and tenant_id = private.current_tenant() and archived_at is null and active;
  if not found then raise exception 'That automation isn''t on'; end if;
  foreach x in array coalesce(p_people, '{}') loop
    if exists (select 1 from people where id = x and tenant_id = a.tenant_id) then
      insert into automation_runs (tenant_id, automation_id, person_id, data) values (a.tenant_id, a.id, x, jsonb_build_object('started_by', auth.uid())); n := n + 1;
    end if;
  end loop;
  foreach x in array coalesce(p_companies, '{}') loop
    if exists (select 1 from companies where id = x and tenant_id = a.tenant_id) then
      insert into automation_runs (tenant_id, automation_id, company_id, data) values (a.tenant_id, a.id, x, jsonb_build_object('started_by', auth.uid())); n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.automation_save(uuid, jsonb), public.automation_set(uuid, boolean, boolean), public.automation_start(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.automation_save(uuid, jsonb), public.automation_set(uuid, boolean, boolean), public.automation_start(uuid, uuid[], uuid[]) to authenticated;

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

-- everything an automation can read or fill in: {contact.*}, {company.*}, {account.name}, {trigger.*}
create or replace function private.contact_ctx(p_person uuid, p_company uuid, p_data jsonb default '{}'::jsonb) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'contact', coalesce((select to_jsonb(p) - 'custom' || coalesce(p.custom, '{}'::jsonb) || jsonb_build_object('email', p.personal_email, 'phone', p.personal_cell,
       'full_name', trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))) from people p where p.id = p_person), '{}'::jsonb),
    'company', coalesce((select to_jsonb(c) - 'custom' || coalesce(c.custom, '{}'::jsonb) || jsonb_build_object('email', c.main_email, 'phone', c.main_phone,
       'owner', (select full_name from app_users where id = c.owner_id)) from companies c where c.id = p_company), '{}'::jsonb),
    'account', coalesce((select jsonb_build_object('name', t.name) from tenants t where t.id = coalesce(
       (select tenant_id from people where id = p_person), (select tenant_id from companies where id = p_company))), '{}'::jsonb),
    'trigger', coalesce(p_data, '{}'::jsonb))
$$;
revoke execute on function private.contact_ctx(uuid, uuid, jsonb) from public, anon, authenticated;

-- fill {contact.first_name} style fields; unknown ones become blank
create or replace function private.render(p_text text, ctx jsonb) returns text
language plpgsql immutable as $$
declare m text[]; out text := coalesce(p_text, ''); v text;
begin
  for m in select regexp_matches(coalesce(p_text, ''), '\{([a-z_]+)\.([a-z0-9_]+)\}', 'g') loop
    v := ctx->m[1]->>m[2];
    out := replace(out, '{' || m[1] || '.' || m[2] || '}', coalesce(v, ''));
  end loop;
  return out;
end $$;

-- read a field for an if step: contact.x, company.x, tag
create or replace function private.ctx_value(ctx jsonb, p_field text) returns text
language sql immutable as $$
  select case when p_field like '%.%' then ctx->split_part(p_field, '.', 1)->>split_part(p_field, '.', 2) else ctx->'contact'->>p_field end
$$;

create or replace function private.cond_ok(s jsonb, ctx jsonb, p_person uuid, p_company uuid) returns boolean
language plpgsql stable security definer set search_path = public, private as $$
declare v text := private.ctx_value(ctx, s->>'field'); want text := private.render(s->>'value', ctx); op text := coalesce(s->>'op', 'equals');
begin
  if s->>'field' = 'tag' then
    return case when op = 'not_has' then not exists (select 1 from people where id = p_person and lower(want) = any(select lower(unnest(tags))))
                                     and not exists (select 1 from companies where id = p_company and lower(want) = any(select lower(unnest(tags))))
           else exists (select 1 from people where id = p_person and lower(want) = any(select lower(unnest(tags))))
             or exists (select 1 from companies where id = p_company and lower(want) = any(select lower(unnest(tags)))) end;
  end if;
  return case op
    when 'equals' then lower(coalesce(v, '')) = lower(coalesce(want, ''))
    when 'not_equals' then lower(coalesce(v, '')) <> lower(coalesce(want, ''))
    when 'contains' then coalesce(v, '') ilike '%' || coalesce(want, '') || '%'
    when 'empty' then coalesce(v, '') = ''
    when 'not_empty' then coalesce(v, '') <> ''
    when 'gt' then case when v ~ '^-?[0-9.]+$' and want ~ '^-?[0-9.]+$' then v::numeric > want::numeric else v > want end
    when 'lt' then case when v ~ '^-?[0-9.]+$' and want ~ '^-?[0-9.]+$' then v::numeric < want::numeric else v < want end
    else false end;
end $$;
revoke execute on function private.cond_ok(jsonb, jsonb, uuid, uuid) from public, anon, authenticated;

-- the step list at a position, and the step there
create or replace function private.steps_at(p_steps jsonb, p_pos jsonb) returns jsonb
language plpgsql immutable as $$
declare cur jsonb := p_steps; i int := 0; n int := jsonb_array_length(p_pos);
begin
  while i < n - 1 loop
    cur := cur->((p_pos->>i)::int)->(p_pos->>(i + 1));
    i := i + 2;
  end loop;
  return coalesce(cur, '[]'::jsonb);
end $$;
-- move to the next step: next in this list, or back out of the branch
create or replace function private.pos_next(p_steps jsonb, p_pos jsonb) returns jsonb
language plpgsql immutable as $$
declare pos jsonb := p_pos; n int;
begin
  loop
    n := jsonb_array_length(pos);
    pos := jsonb_set(pos, array[(n - 1)::text], to_jsonb((pos->>(n - 1))::int + 1));
    if (pos->>(n - 1))::int < jsonb_array_length(private.steps_at(p_steps, pos)) or n = 1 then return pos; end if;
    pos := pos - (n - 1) - (n - 2);   -- leave the branch, continue after the if
  end loop;
end $$;

-- set a field from an automation, link or webhook. contact fields: first_name, last_name, email, phone, or custom keys.
create or replace function private.set_contact_field(p_person uuid, p_company uuid, p_field text, p_value text) returns void
language plpgsql security definer set search_path = public, private as $$
declare ent text := case when p_field like 'company.%' then 'company' else 'contact' end; k text := regexp_replace(p_field, '^(contact|company)\.', '');
begin
  if ent = 'contact' and p_person is not null then
    if k = 'first_name' then update people set first_name = p_value, updated_at = now() where id = p_person;
    elsif k = 'last_name' then update people set last_name = p_value, updated_at = now() where id = p_person;
    elsif k = 'email' then update people set personal_email = lower(p_value), updated_at = now() where id = p_person;
    elsif k = 'phone' then update people set personal_cell = p_value, updated_at = now() where id = p_person;
    elsif k = 'email_opt_out' then update people set email_opt_out = lower(p_value) in ('true', 'yes', '1') where id = p_person;
    elsif k ~ '^[a-z0-9_]{1,40}$' then update people set custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object(k, p_value), updated_at = now() where id = p_person;
    end if;
  elsif ent = 'company' and p_company is not null then
    if k in ('stage', 'interest_level', 'next_step', 'notes') then execute format('update companies set %I = $1, updated_at = now() where id = $2', k) using p_value, p_company;
    elsif k = 'email' then update companies set main_email = lower(p_value), updated_at = now() where id = p_company;
    elsif k = 'phone' then update companies set main_phone = p_value, updated_at = now() where id = p_company;
    elsif k = 'follow_up_date' then update companies set follow_up_date = nullif(p_value, '')::date, updated_at = now() where id = p_company;
    elsif k ~ '^[a-z0-9_]{1,40}$' then update companies set custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object(k, p_value), updated_at = now() where id = p_company;
    end if;
  end if;
end $$;
revoke execute on function private.set_contact_field(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------- email outbox (automation emails, campaigns later) ----------
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  run_id uuid references public.automation_runs(id) on delete set null,
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists email_outbox_queued on public.email_outbox (created_at) where status = 'queued';
alter table public.email_outbox enable row level security;
create policy "see outbox" on public.email_outbox for select using (tenant_id = private.current_tenant() and private.can('automations', 1));
revoke all on public.email_outbox from anon, authenticated;
grant select on public.email_outbox to authenticated;

create or replace function private.send_email_hook(p_id uuid) returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return; end if;
  perform net.http_post(url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/automation-send',
    body := jsonb_build_object('id', p_id, 'secret', s), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000);
exception when others then return;
end $$;
revoke execute on function private.send_email_hook(uuid) from public, anon, authenticated;

-- the edge function reads the queued email and marks how it went (service role only)
create or replace function public.outbox_take(p_id uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare o email_outbox;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  select * into o from email_outbox where id = p_id and status = 'queued' for update;
  if not found then return null; end if;
  return jsonb_build_object('id', o.id, 'to', o.to_email, 'subject', o.subject, 'body', o.body, 'person_id', o.person_id,
    'from_name', coalesce((select w.email_from_name from white_labels w where w.agency_tenant_id = (select coalesce(case when t.is_agency then t.id end, t.agency_tenant_id) from tenants t where t.id = o.tenant_id)), (select name from tenants where id = o.tenant_id)),
    'account', (select name from tenants where id = o.tenant_id));
end $$;
create or replace function public.outbox_done(p_id uuid, p_secret text, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public, private as $$
declare o email_outbox;
begin
  if p_secret is distinct from (select hook_secret from private.push_keys where id = 1) then raise exception 'Not allowed'; end if;
  update email_outbox set status = case when p_ok then 'sent' else 'failed' end, error = left(p_error, 500), sent_at = case when p_ok then now() end
   where id = p_id and status = 'queued' returning * into o;
  if found and o.person_id is not null then
    perform private.emit(o.tenant_id, case when p_ok then 'email_sent' else 'email_failed' end, case when p_ok then 'Email sent: ' else 'Email failed: ' end || o.subject,
      o.person_id, null, jsonb_build_object('outbox_id', o.id, 'error', p_error));
  end if;
end $$;
revoke execute on function public.outbox_take(uuid, text), public.outbox_done(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.outbox_take(uuid, text), public.outbox_done(uuid, text, boolean, text) to service_role;

-- anyone who got an automated email can opt out (the link carries their contact id)
create or replace function public.email_unsubscribe(p_person uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p people;
begin
  update people set email_opt_out = true where id = p_person returning * into p;
  if not found then return jsonb_build_object('ok', false); end if;
  perform private.emit(p.tenant_id, 'unsubscribed', 'Opted out of automated email', p.id, null, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'account', (select name from tenants where id = p.tenant_id));
end $$;
revoke execute on function public.email_unsubscribe(uuid) from public;
grant execute on function public.email_unsubscribe(uuid) to anon, authenticated;

-- ---------- run one step ----------
create or replace function private.run_step(r automation_runs, s jsonb, ctx jsonb) returns jsonb   -- {next: 'go'|'wait'|'stop'|'branch', wake, msg, branch}
language plpgsql security definer set search_path = public, private, extensions as $$
declare v_to text; v_subj text; v_body text; v_id uuid; tp templates; v_user uuid; v_due date;
begin
  case s->>'type'
    when 'wait' then
      return jsonb_build_object('next', 'wait', 'wake', now() + ((s->>'amount') || ' ' || (s->>'unit'))::interval, 'msg', 'Waiting ' || (s->>'amount') || ' ' || (s->>'unit'));
    when 'if' then
      return jsonb_build_object('next', 'branch', 'branch', case when private.cond_ok(s, ctx, r.person_id, r.company_id) then 'then' else 'else' end);
    when 'set_field' then
      perform private.set_contact_field(r.person_id, r.company_id, s->>'field', private.render(s->>'value', ctx));
      return jsonb_build_object('next', 'go', 'msg', 'Set ' || (s->>'field'));
    when 'add_tag' then
      update people set tags = array(select distinct unnest(tags || array[trim(s->>'tag')])) where id = r.person_id and not (trim(s->>'tag') = any(tags));
      if r.person_id is null then update companies set tags = array(select distinct unnest(tags || array[trim(s->>'tag')])) where id = r.company_id and not (trim(s->>'tag') = any(tags)); end if;
      return jsonb_build_object('next', 'go', 'msg', 'Tag added: ' || (s->>'tag'));
    when 'remove_tag' then
      update people set tags = array_remove(tags, trim(s->>'tag')) where id = r.person_id and trim(s->>'tag') = any(tags);
      update companies set tags = array_remove(tags, trim(s->>'tag')) where id = r.company_id and trim(s->>'tag') = any(tags);
      return jsonb_build_object('next', 'go', 'msg', 'Tag removed: ' || (s->>'tag'));
    when 'assign' then
      v_user := (s->>'user_id')::uuid;
      if not exists (select 1 from app_users where id = v_user and tenant_id = r.tenant_id and active) then return jsonb_build_object('next', 'go', 'msg', 'Skipped assign: person not on the account'); end if;
      update companies set owner_id = v_user, updated_at = now() where id = r.company_id;
      return jsonb_build_object('next', 'go', 'msg', 'Assigned to ' || (select full_name from app_users where id = v_user));
    when 'task' then
      v_user := case when s->>'assign_to' = 'owner' then (select owner_id from companies where id = r.company_id) else nullif(s->>'assign_to', '')::uuid end;
      v_due := current_date + coalesce(nullif(s->>'due_days', '')::int, 0);
      insert into tasks (tenant_id, company_id, person_id, title, due_date, assigned_to, created_by, notes)
      values (r.tenant_id, r.company_id, r.person_id, left(private.render(s->>'title', ctx), 200), v_due, v_user, null, nullif(private.render(s->>'notes', ctx), ''));
      return jsonb_build_object('next', 'go', 'msg', 'To-do added');
    when 'email' then
      if coalesce(s->>'template_id', '') <> '' then
        select * into tp from templates where id = (s->>'template_id')::uuid and (tenant_id = r.tenant_id or tenant_id is null);
      end if;
      v_to := case when coalesce(s->>'to', 'contact') = 'contact' then coalesce(ctx->'contact'->>'email', ctx->'company'->>'email')
                   when s->>'to' = 'owner' then (select email from app_users where id = (select owner_id from companies where id = r.company_id))
                   else private.render(s->>'to', ctx) end;
      if coalesce(v_to, '') !~ '^\S+@\S+\.\S+$' then return jsonb_build_object('next', 'go', 'msg', 'Skipped email: no email address'); end if;
      if coalesce(s->>'to', 'contact') = 'contact' and exists (select 1 from people where id = r.person_id and email_opt_out) then
        return jsonb_build_object('next', 'go', 'msg', 'Skipped email: they opted out');
      end if;
      v_subj := private.render(coalesce(nullif(s->>'subject', ''), tp.subject, tp.name, 'A message from ' || (ctx->'account'->>'name')), ctx);
      v_body := private.render(coalesce(nullif(s->>'body', ''), tp.body, ''), ctx);
      insert into email_outbox (tenant_id, person_id, run_id, to_email, subject, body)
      values (r.tenant_id, case when coalesce(s->>'to', 'contact') = 'contact' then r.person_id end, r.id, lower(v_to), left(v_subj, 200), v_body) returning id into v_id;
      perform private.send_email_hook(v_id);
      return jsonb_build_object('next', 'go', 'msg', 'Email queued to ' || v_to);
    when 'webhook' then
      perform net.http_post(url := s->>'url', body := jsonb_build_object('event', r.data, 'contact', ctx->'contact', 'company', ctx->'company',
        'account', ctx->'account', 'automation_id', r.automation_id, 'run_id', r.id, 'sent_at', now()),
        headers := jsonb_build_object('Content-Type', 'application/json') || coalesce(s->'headers', '{}'::jsonb), timeout_milliseconds := 10000);
      return jsonb_build_object('next', 'go', 'msg', 'Webhook sent');
    when 'notify' then
      v_user := case when coalesce(s->>'user_id', 'owner') = 'owner' then (select owner_id from companies where id = r.company_id) else (s->>'user_id')::uuid end;
      if v_user is not null then
        insert into notifications (user_id, kind, title, body, link) values (v_user, 'automation', left(private.render(s->>'text', ctx), 200),
          (select name from automations where id = r.automation_id), case when r.person_id is not null then '#people/' || r.person_id when r.company_id is not null then '#org/' || r.company_id end);
      end if;
      return jsonb_build_object('next', 'go', 'msg', 'Notified');
    when 'start' then
      insert into automation_runs (tenant_id, automation_id, person_id, company_id, data)
      select r.tenant_id, a.id, r.person_id, r.company_id, r.data from automations a where a.id = (s->>'automation_id')::uuid and a.tenant_id = r.tenant_id and a.active and a.id <> r.automation_id;
      return jsonb_build_object('next', 'go', 'msg', 'Started another automation');
    when 'stop' then return jsonb_build_object('next', 'stop', 'msg', 'Stopped');
    else return jsonb_build_object('next', 'go', 'msg', 'Skipped unknown step');
  end case;
end $$;
revoke execute on function private.run_step(automation_runs, jsonb, jsonb) from public, anon, authenticated;

-- walk every run that's due (pg_cron calls this every 30 seconds)
create or replace function private.automation_tick() returns int
language plpgsql security definer set search_path = public, private as $$
declare r automation_runs; a automations; s jsonb; res jsonb; list jsonb; idx int; steps int; ctx jsonb; done int := 0; lg jsonb;
begin
  perform set_config('gelp.auto_depth', '1', true);
  for r in select * from automation_runs where status in ('running', 'waiting') and wake_at <= now() order by wake_at limit 200 for update skip locked loop
    select * into a from automations where id = r.automation_id;
    if a.id is null or not a.active or a.archived_at is not null then
      update automation_runs set status = 'stopped', updated_at = now() where id = r.id; continue;
    end if;
    steps := 0; lg := '[]'::jsonb;
    begin
      loop
        list := private.steps_at(a.steps, r.pos);
        idx := (r.pos->>(jsonb_array_length(r.pos) - 1))::int;
        if idx >= jsonb_array_length(list) then r.status := 'done'; exit; end if;
        s := list->idx;
        ctx := private.contact_ctx(r.person_id, r.company_id, r.data);
        res := private.run_step(r, s, ctx);
        if res ? 'msg' then lg := lg || jsonb_build_object('at', now(), 'msg', res->>'msg'); end if;
        steps := steps + 1;
        if res->>'next' = 'stop' then r.status := 'done'; exit;
        elsif res->>'next' = 'branch' then
          if jsonb_array_length(coalesce(s->(res->>'branch'), '[]'::jsonb)) > 0 then r.pos := r.pos || jsonb_build_array(res->>'branch', 0);
          else r.pos := private.pos_next(a.steps, r.pos); end if;
        elsif res->>'next' = 'wait' then
          r.pos := private.pos_next(a.steps, r.pos); r.status := 'waiting'; r.wake_at := (res->>'wake')::timestamptz; exit;
        else r.pos := private.pos_next(a.steps, r.pos);
        end if;
        r.status := 'running';
        if steps >= 50 then r.wake_at := now(); exit; end if;   -- long runs pick up again next tick
      end loop;
      update automation_runs set pos = r.pos, status = r.status, wake_at = r.wake_at, log = log || lg, updated_at = now() where id = r.id;
    exception when others then
      update automation_runs set status = 'failed', updated_at = now(), log = log || lg || jsonb_build_object('at', now(), 'msg', 'Error: ' || sqlerrm) where id = r.id;
    end;
    done := done + 1;
  end loop;
  return done;
end $$;
revoke execute on function private.automation_tick() from public, anon, authenticated;
do $$ begin perform cron.unschedule('automation-tick'); exception when others then null; end $$;
select cron.schedule('automation-tick', '30 seconds', $$select private.automation_tick()$$);

-- stop one run by hand
create or replace function public.automation_run_stop(p_run uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('automations', 2) then raise exception 'Not allowed'; end if;
  update automation_runs set status = 'stopped', updated_at = now(), log = log || jsonb_build_object('at', now(), 'msg', 'Stopped by ' || (select full_name from app_users where id = auth.uid()))
   where id = p_run and tenant_id = private.current_tenant() and status in ('running', 'waiting');
end $$;
revoke execute on function public.automation_run_stop(uuid) from public, anon;
grant execute on function public.automation_run_stop(uuid) to authenticated;

-- ---------- tracked links and QR codes ----------
create table if not exists public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-zA-Z0-9_-]{4,40}$'),
  name text not null check (length(trim(name)) between 1 and 100),
  kind text not null default 'link' check (kind in ('link', 'qr')),
  url text not null check (url ~ '^https?://'),
  actions jsonb not null default '{}'::jsonb,      -- {add_tag, remove_tag, set_field: {field, value}, automation_id}
  clicks int not null default 0,
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create table if not exists public.link_hits (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.tracked_links(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  visitor text,               -- hashed ip + browser, never the raw ip
  ref text,
  created_at timestamptz not null default now()
);
create index if not exists link_hits_link on public.link_hits (link_id, created_at desc);
alter table public.tracked_links enable row level security;
alter table public.link_hits enable row level security;
create policy "see links" on public.tracked_links for select using (tenant_id = private.current_tenant() and private.can('marketing', 1));
create policy "see hits" on public.link_hits for select using (tenant_id = private.current_tenant() and private.can('marketing', 1));
revoke all on public.tracked_links, public.link_hits from anon, authenticated;
grant select on public.tracked_links, public.link_hits to authenticated;
create trigger audit_tracked_links after insert or update on public.tracked_links for each row execute function private.audit();

create or replace function public.link_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v tracked_links; v_slug text;
begin
  if not private.can('marketing', 2) then raise exception 'Your role can''t make tracked links'; end if;
  if coalesce(p->>'url', '') !~ '^https?://' then raise exception 'The link has to start with https://'; end if;
  if coalesce(p->'actions'->>'automation_id', '') <> '' and not exists (select 1 from automations where id = (p->'actions'->>'automation_id')::uuid and tenant_id = private.current_tenant())
    then raise exception 'Automation not found'; end if;
  if p_id is null then
    v_slug := coalesce(nullif(trim(p->>'slug'), ''), substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    insert into tracked_links (slug, name, kind, url, actions) values (v_slug, trim(p->>'name'), coalesce(p->>'kind', 'link'), trim(p->>'url'), coalesce(p->'actions', '{}'))
    returning * into v;
  else
    update tracked_links set name = trim(p->>'name'), url = trim(p->>'url'), actions = coalesce(p->'actions', '{}')
     where id = p_id and tenant_id = private.current_tenant() and archived_at is null returning * into v;
    if v.id is null then raise exception 'Link not found'; end if;
  end if;
  return to_jsonb(v);
exception when unique_violation then raise exception 'That short name is taken, try another';
end $$;
create or replace function public.link_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('marketing', 2) then raise exception 'Not allowed'; end if;
  update tracked_links set archived_at = now() where id = p_id and tenant_id = private.current_tenant();
end $$;
revoke execute on function public.link_save(uuid, jsonb), public.link_archive(uuid) from public, anon;
grant execute on function public.link_save(uuid, jsonb), public.link_archive(uuid) to authenticated;

-- the /go/ page calls this, then sends the visitor on. p_person comes from ?p= on links in our own emails.
create or replace function public.link_hit(p_slug text, p_person uuid default null, p_ref text default null) returns text
language plpgsql security definer set search_path = public, private as $$
declare l tracked_links; hdr json; v_vis text; v_person uuid; co uuid; act jsonb;
begin
  select * into l from tracked_links where slug = p_slug and archived_at is null;
  if not found then return null; end if;
  hdr := nullif(current_setting('request.headers', true), '')::json;
  v_vis := encode(extensions.digest(coalesce(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1), '') || coalesce(hdr->>'user-agent', '') || l.id::text, 'sha256'), 'hex');
  if (select count(*) from link_hits where link_id = l.id and visitor = v_vis and created_at > now() - interval '1 minute') >= 5 then return l.url; end if;
  select id into v_person from people where id = p_person and tenant_id = l.tenant_id;
  insert into link_hits (link_id, tenant_id, person_id, visitor, ref) values (l.id, l.tenant_id, v_person, v_vis, left(p_ref, 200));
  update tracked_links set clicks = clicks + 1 where id = l.id;
  if v_person is not null then
    act := l.actions;
    select company_id into co from company_people where person_id = v_person limit 1;
    if coalesce(trim(act->>'add_tag'), '') <> '' then
      update people set tags = array(select distinct unnest(tags || array[trim(act->>'add_tag')])) where id = v_person and not (trim(act->>'add_tag') = any(tags));
    end if;
    if coalesce(trim(act->>'remove_tag'), '') <> '' then update people set tags = array_remove(tags, trim(act->>'remove_tag')) where id = v_person; end if;
    if coalesce(act->'set_field'->>'field', '') <> '' then
      perform private.set_contact_field(v_person, co, act->'set_field'->>'field', act->'set_field'->>'value');
    end if;
    perform private.emit(l.tenant_id, case when l.kind = 'qr' then 'qr_scanned' else 'link_clicked' end,
      case when l.kind = 'qr' then 'Scanned QR code: ' else 'Clicked link: ' end || l.name, v_person, co, jsonb_build_object('link_id', l.id, 'name', l.name, 'url', l.url));
    if coalesce(act->>'automation_id', '') <> '' then
      insert into automation_runs (tenant_id, automation_id, person_id, company_id, data)
      select l.tenant_id, a.id, v_person, co, jsonb_build_object('link_id', l.id) from automations a where a.id = (act->>'automation_id')::uuid and a.active and a.tenant_id = l.tenant_id;
    end if;
  end if;
  return l.url;
end $$;
revoke execute on function public.link_hit(text, uuid, text) from public;
grant execute on function public.link_hit(text, uuid, text) to anon, authenticated;

-- ---------- incoming webhooks ----------
create table if not exists public.inbound_hooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  token text not null unique default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  field_map jsonb not null default '{}'::jsonb,     -- {"contact.email": "email", "contact.first_name": "data.first", "contact.custom_key": "..."}
  match_on text not null default 'email' check (match_on in ('email', 'phone', 'none')),
  active boolean not null default true,
  hits int not null default 0,
  last_hit_at timestamptz,
  last_body jsonb,                                  -- the latest payload, so the map is easy to build
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
alter table public.inbound_hooks enable row level security;
create policy "see hooks" on public.inbound_hooks for select using (tenant_id = private.current_tenant() and (private.can('automations', 2) or private.can('sites', 2)));
revoke all on public.inbound_hooks from anon, authenticated;
grant select on public.inbound_hooks to authenticated;
create trigger audit_inbound_hooks after insert or update on public.inbound_hooks for each row execute function private.audit();

create or replace function public.hook_save(p_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v inbound_hooks;
begin
  if not (private.can('automations', 2) or private.can('sites', 2)) then raise exception 'Your role can''t set up webhooks'; end if;
  if p_id is null then
    insert into inbound_hooks (name, field_map, match_on) values (trim(p->>'name'), coalesce(p->'field_map', '{}'), coalesce(p->>'match_on', 'email')) returning * into v;
  else
    update inbound_hooks set name = trim(p->>'name'), field_map = coalesce(p->'field_map', field_map), match_on = coalesce(p->>'match_on', match_on),
      active = coalesce((p->>'active')::boolean, active), archived_at = case when (p->>'archive')::boolean then now() else archived_at end
     where id = p_id and tenant_id = private.current_tenant() returning * into v;
    if v.id is null then raise exception 'Webhook not found'; end if;
  end if;
  return to_jsonb(v);
end $$;
revoke execute on function public.hook_save(uuid, jsonb) from public, anon;
grant execute on function public.hook_save(uuid, jsonb) to authenticated;

-- an outside app posts here (directly as an RPC with the public key, or through the hook-in function).
-- finds or creates the contact, maps the fields, logs it and fires "webhook received".
create or replace function public.hook_receive(p_token text, p_body jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare h inbound_hooks; k text; src text; val text; v_email text; v_phone text; v_person uuid; created boolean := false; co uuid;
begin
  select * into h from inbound_hooks where token = p_token and archived_at is null;
  if not found or not h.active then raise exception 'Webhook not found'; end if;
  if pg_column_size(p_body) > 200000 then raise exception 'Too big'; end if;
  if h.last_hit_at > now() - interval '1 second' and h.hits > 0 and (select count(*) from contact_events where tenant_id = h.tenant_id and kind = 'webhook_in' and created_at > now() - interval '1 minute') > 120
    then raise exception 'Slow down'; end if;
  update inbound_hooks set hits = hits + 1, last_hit_at = now(), last_body = p_body where id = h.id;
  -- pull the matching values
  for k, src in select key, value #>> '{}' from jsonb_each(h.field_map) loop
    val := p_body #>> string_to_array(src, '.');
    if k = 'contact.email' then v_email := lower(trim(val)); elsif k = 'contact.phone' then v_phone := trim(val); end if;
  end loop;
  if h.match_on = 'email' and v_email ~ '^\S+@\S+\.\S+$' then
    select id into v_person from people where tenant_id = h.tenant_id and lower(personal_email) = v_email and archive_status is distinct from 'archived' limit 1;
  elsif h.match_on = 'phone' and coalesce(v_phone, '') <> '' then
    select id into v_person from people where tenant_id = h.tenant_id and regexp_replace(personal_cell, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g') limit 1;
  end if;
  if v_person is null and (coalesce(v_email, '') <> '' or coalesce(v_phone, '') <> '') then
    perform set_config('gelp.source', 'Webhook: ' || h.name, true);
    insert into people (tenant_id, first_name, personal_email, personal_cell) values (h.tenant_id, '', nullif(v_email, ''), nullif(v_phone, '')) returning id into v_person;
    created := true;
  end if;
  if v_person is not null then
    select company_id into co from company_people where person_id = v_person limit 1;
    for k, src in select key, value #>> '{}' from jsonb_each(h.field_map) loop
      val := p_body #>> string_to_array(src, '.');
      if val is not null and k not in ('contact.email', 'contact.phone') and k ~ '^(contact|company)\.[a-z0-9_]{1,40}$' then
        perform private.set_contact_field(v_person, co, k, left(val, 2000));
      end if;
    end loop;
    perform private.emit(h.tenant_id, 'webhook_in', 'Webhook received: ' || h.name, v_person, co, jsonb_build_object('hook_id', h.id, 'name', h.name, 'body', p_body));
  end if;
  return jsonb_build_object('ok', true, 'contact', v_person, 'created', created);
end $$;
revoke execute on function public.hook_receive(text, jsonb) from public;
grant execute on function public.hook_receive(text, jsonb) to anon, authenticated, service_role;
