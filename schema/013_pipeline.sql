-- 013: pipeline (Oct 16, 2026).
-- Each account (tenant) has its own sales stages, set up by its admins in Admin > Settings. Every account starts
-- with four built-in stages: Lead, Proposal Sent, Closed Won, Closed Lost. They can be renamed (they keep their job),
-- and admins can add, reorder and remove their own stages in between.
--   New organizations land in the Lead stage.
--   Sending a proposal moves the organization to Proposal Sent; the client accepting moves it to Closed Won.
-- The board under Sales > Pipeline shows organizations by stage. (The older free-text companies.stage is no longer used.)

create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) default private.current_tenant(),
  name text not null check (length(trim(name)) between 1 and 60),
  sort int not null default 100,
  kind text not null default 'open' check (kind in ('open','won','lost')),
  system_key text check (system_key in ('lead','proposal_sent','won','lost')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, system_key)
);
create index if not exists pipeline_stages_tenant on public.pipeline_stages (tenant_id, sort);
alter table public.pipeline_stages enable row level security;
drop policy if exists "team reads own stages" on public.pipeline_stages;
create policy "team reads own stages" on public.pipeline_stages for select using (private.is_internal() and tenant_id = private.current_tenant());
drop policy if exists "admins manage own stages" on public.pipeline_stages;
create policy "admins manage own stages" on public.pipeline_stages for all using (private.is_admin() and tenant_id = private.current_tenant())
  with check (private.is_admin() and tenant_id = private.current_tenant());
grant select, insert, update on public.pipeline_stages to authenticated;

alter table public.companies add column if not exists pipeline_stage_id uuid references public.pipeline_stages(id);
alter table public.companies add column if not exists stage_changed_at timestamptz;
create index if not exists companies_pipeline_stage on public.companies (pipeline_stage_id);

-- built-in stages for an account (safe to run again)
create or replace function private.seed_pipeline(p_tenant uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  perform set_config('app.seed_stages', '1', true);
  insert into pipeline_stages (tenant_id, name, sort, kind, system_key) values
    (p_tenant, 'Lead', 10, 'open', 'lead'),
    (p_tenant, 'Proposal Sent', 20, 'open', 'proposal_sent'),
    (p_tenant, 'Closed Won', 900, 'won', 'won'),
    (p_tenant, 'Closed Lost', 910, 'lost', 'lost')
  on conflict (tenant_id, system_key) do nothing;
  perform set_config('app.seed_stages', '', true);
end $$;
create or replace function private.seed_pipeline_trg() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin perform private.seed_pipeline(new.id); return new; end $$;
drop trigger if exists tenants_seed_pipeline on public.tenants;
create trigger tenants_seed_pipeline after insert on public.tenants for each row execute function private.seed_pipeline_trg();
select private.seed_pipeline(id) from public.tenants;

-- built-in stages can be renamed and moved, never removed or retyped
create or replace function private.guard_stage() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('app.seed_stages', true), '') = '1' then return new; end if;
    new.system_key := null;
    if new.kind <> 'open' then new.kind := 'open'; end if;
    return new;
  end if;
  if old.system_key is not null and (new.system_key is distinct from old.system_key or new.kind <> old.kind or new.archived_at is not null) then
    raise exception 'Built-in stages can be renamed, not removed';
  end if;
  if new.tenant_id <> old.tenant_id then raise exception 'That cannot be changed'; end if;
  return new;
end $$;
drop trigger if exists guard_stage on public.pipeline_stages;
create trigger guard_stage before insert or update on public.pipeline_stages for each row execute function private.guard_stage();

-- organizations: new ones start in Lead; a stage must belong to the same account; track when the stage changed
create or replace function private.company_stage() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' and new.pipeline_stage_id is null
     and not ('Referral Partner' = any(coalesce(new.org_types, '{}')) and coalesce(array_length(new.org_types, 1), 0) = 1) then
    select id into new.pipeline_stage_id from pipeline_stages where tenant_id = new.tenant_id and system_key = 'lead';
  end if;
  if new.pipeline_stage_id is not null and not exists (select 1 from pipeline_stages where id = new.pipeline_stage_id and tenant_id = new.tenant_id) then
    raise exception 'That stage belongs to a different account';
  end if;
  if tg_op = 'INSERT' or new.pipeline_stage_id is distinct from old.pipeline_stage_id then new.stage_changed_at := now(); end if;
  return new;
end $$;
drop trigger if exists company_stage on public.companies;
create trigger company_stage before insert or update of pipeline_stage_id on public.companies for each row execute function private.company_stage();

-- move an organization to a built-in stage (used by proposals). Won is final unless someone moves it by hand.
create or replace function private.pipeline_move(p_company uuid, p_key text) returns void
language plpgsql security definer set search_path = public, private as $$
declare c companies; s uuid; cur text;
begin
  select * into c from companies where id = p_company;
  if not found then return; end if;
  select id into s from pipeline_stages where tenant_id = c.tenant_id and system_key = p_key;
  if s is null or s = c.pipeline_stage_id then return; end if;
  select system_key into cur from pipeline_stages where id = c.pipeline_stage_id;
  if p_key = 'proposal_sent' and cur = 'won' then return; end if;
  update companies set pipeline_stage_id = s where id = c.id;
  insert into activities (tenant_id, company_id, type, body, created_by)
  values (c.tenant_id, c.id, 'note', 'Pipeline: moved to ' || (select name from pipeline_stages where id = s) || ' (automatic, from the proposal).', coalesce(auth.uid(), c.owner_id));
end $$;
revoke execute on function private.pipeline_move(uuid, text), private.seed_pipeline(uuid) from public, anon, authenticated;

-- existing organizations (except referral-partner-only) join the pipeline at Lead
update public.companies c set pipeline_stage_id = s.id
  from public.pipeline_stages s
 where s.tenant_id = c.tenant_id and s.system_key = 'lead' and c.pipeline_stage_id is null
   and not ('Referral Partner' = any(coalesce(c.org_types, '{}')) and coalesce(array_length(c.org_types, 1), 0) = 1);

-- proposals move the pipeline: sent -> Proposal Sent, accepted -> Closed Won
do $$
declare d text; b text;
begin
  d := replace(pg_get_functiondef('public.proposal_send(uuid)'::regprocedure), E'\r\n', E'\n');
  if position('pipeline_move' in d) = 0 then
    b := d;
    d := replace(d, $q$  return jsonb_build_object('version', p.version, 'token', p.share_token, 'expires_at', p.expires_at);$q$,
                    $q$  perform private.pipeline_move(p.company_id, 'proposal_sent');
  return jsonb_build_object('version', p.version, 'token', p.share_token, 'expires_at', p.expires_at);$q$);
    if d = b then raise exception 'proposal_send patch did not match'; end if;
    execute d;
  end if;
  d := replace(pg_get_functiondef('public.proposal_accept(text,text,text,boolean)'::regprocedure), E'\r\n', E'\n');
  if position('pipeline_move' in d) = 0 then
    b := d;
    d := replace(d, $q$  return jsonb_build_object('ok', true, 'version', p.version);$q$,
                    $q$  perform private.pipeline_move(p.company_id, 'won');
  return jsonb_build_object('ok', true, 'version', p.version);$q$);
    if d = b then raise exception 'proposal_accept patch did not match'; end if;
    execute d;
  end if;
end $$;
