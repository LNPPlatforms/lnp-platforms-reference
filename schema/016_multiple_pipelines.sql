-- 016: multiple pipelines per account; dropdown lists per account (Oct 16, 2026).
-- Each account has one default pipeline and can add as many as it wants. Every pipeline starts with the four
-- built-in stages (Lead, Proposal Sent, Closed Won, Closed Lost), renamable. New organizations land in the default
-- pipeline's Lead stage. Proposals move an organization within the pipeline it's in (or the default one).
-- An organization sits in one pipeline at a time.

create table if not exists public.pipelines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) default private.current_tenant(),
  name text not null check (length(trim(name)) between 1 and 80),
  sort int not null default 100,
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists pipelines_one_default on public.pipelines (tenant_id) where is_default and archived_at is null;
alter table public.pipelines enable row level security;
create policy "team reads own pipelines" on public.pipelines for select using (private.is_internal() and tenant_id = private.current_tenant());
create policy "admins manage own pipelines" on public.pipelines for all using (private.is_admin() and tenant_id = private.current_tenant())
  with check (private.is_admin() and tenant_id = private.current_tenant());
grant select, insert, update on public.pipelines to authenticated;

alter table public.pipeline_stages add column if not exists pipeline_id uuid references public.pipelines(id);

-- every existing account gets a default pipeline holding its current stages
insert into public.pipelines (tenant_id, name, sort, is_default)
select t.id, 'Sales Pipeline', 10, true from public.tenants t
 where not exists (select 1 from public.pipelines p where p.tenant_id = t.id and p.is_default);
update public.pipeline_stages s set pipeline_id = p.id from public.pipelines p
 where p.tenant_id = s.tenant_id and p.is_default and s.pipeline_id is null;
alter table public.pipeline_stages alter column pipeline_id set not null;

-- built-in stages are unique per pipeline, not per account; dropdown labels are unique per account
alter table public.pipeline_stages drop constraint if exists pipeline_stages_tenant_id_system_key_key;
alter table public.pipeline_stages add constraint pipeline_stages_pipeline_system_key unique (pipeline_id, system_key);
alter table public.lookup_values drop constraint if exists lookup_values_list_name_label_key;
alter table public.lookup_values add constraint lookup_values_tenant_list_label unique (tenant_id, list_name, label);

-- a new pipeline gets the four built-in stages
create or replace function private.seed_stages(p_pipeline uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare t uuid;
begin
  select tenant_id into t from pipelines where id = p_pipeline;
  perform set_config('app.seed_stages', '1', true);
  insert into pipeline_stages (tenant_id, pipeline_id, name, sort, kind, system_key) values
    (t, p_pipeline, 'Lead', 10, 'open', 'lead'),
    (t, p_pipeline, 'Proposal Sent', 20, 'open', 'proposal_sent'),
    (t, p_pipeline, 'Closed Won', 900, 'won', 'won'),
    (t, p_pipeline, 'Closed Lost', 910, 'lost', 'lost')
  on conflict (pipeline_id, system_key) do nothing;
  perform set_config('app.seed_stages', '', true);
end $$;
create or replace function private.pipeline_created() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin perform private.seed_stages(new.id); return new; end $$;
create trigger pipelines_seed after insert on public.pipelines for each row execute function private.pipeline_created();

-- a new account gets its default pipeline (whose trigger adds the stages)
create or replace function private.seed_pipeline(p_tenant uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not exists (select 1 from pipelines where tenant_id = p_tenant and is_default and archived_at is null) then
    insert into pipelines (tenant_id, name, sort, is_default) values (p_tenant, 'Sales Pipeline', 10, true);
  end if;
end $$;

-- the default pipeline can be renamed but not removed; only one default
create or replace function private.guard_pipeline() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id then raise exception 'That cannot be changed'; end if;
    if old.is_default and (new.archived_at is not null or not new.is_default) then
      raise exception 'Pick another default pipeline first';
    end if;
    if new.is_default and not old.is_default then
      update pipelines set is_default = false where tenant_id = new.tenant_id and is_default and id <> new.id;
    end if;
  end if;
  return new;
end $$;
create trigger guard_pipeline before update on public.pipelines for each row execute function private.guard_pipeline();

-- stages: tenant comes from the pipeline; built-ins only by seeding
create or replace function private.guard_stage() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' then
    select tenant_id into new.tenant_id from pipelines where id = new.pipeline_id;
    if new.tenant_id is null then raise exception 'Pipeline not found'; end if;
    if coalesce(current_setting('app.seed_stages', true), '') = '1' then return new; end if;
    new.system_key := null;
    if new.kind <> 'open' then new.kind := 'open'; end if;
    return new;
  end if;
  if old.system_key is not null and (new.system_key is distinct from old.system_key or new.kind <> old.kind or new.archived_at is not null) then
    raise exception 'Built-in stages can be renamed, not removed';
  end if;
  if new.tenant_id <> old.tenant_id or new.pipeline_id <> old.pipeline_id then raise exception 'That cannot be changed'; end if;
  return new;
end $$;

-- new organizations start in the default pipeline's Lead stage
create or replace function private.company_stage() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if tg_op = 'INSERT' and new.pipeline_stage_id is null
     and not ('Referral Partner' = any(coalesce(new.org_types, '{}')) and coalesce(array_length(new.org_types, 1), 0) = 1) then
    select s.id into new.pipeline_stage_id from pipeline_stages s join pipelines p on p.id = s.pipeline_id
     where p.tenant_id = new.tenant_id and p.is_default and p.archived_at is null and s.system_key = 'lead';
  end if;
  if new.pipeline_stage_id is not null and not exists (select 1 from pipeline_stages where id = new.pipeline_stage_id and tenant_id = new.tenant_id) then
    raise exception 'That stage belongs to a different account';
  end if;
  if tg_op = 'INSERT' or new.pipeline_stage_id is distinct from old.pipeline_stage_id then new.stage_changed_at := now(); end if;
  return new;
end $$;

-- proposals move the organization within its own pipeline (or the default one if it isn't in any)
create or replace function private.pipeline_move(p_company uuid, p_key text) returns void
language plpgsql security definer set search_path = public, private as $$
declare c companies; pl uuid; s uuid; cur text;
begin
  select * into c from companies where id = p_company;
  if not found then return; end if;
  select pipeline_id, system_key into pl, cur from pipeline_stages where id = c.pipeline_stage_id;
  if pl is null then select id into pl from pipelines where tenant_id = c.tenant_id and is_default and archived_at is null; end if;
  select id into s from pipeline_stages where pipeline_id = pl and system_key = p_key;
  if s is null or s = c.pipeline_stage_id then return; end if;
  if p_key = 'proposal_sent' and cur = 'won' then return; end if;
  update companies set pipeline_stage_id = s where id = c.id;
  insert into activities (tenant_id, company_id, type, body, created_by)
  values (c.tenant_id, c.id, 'note', 'Pipeline: moved to ' || (select name from pipeline_stages where id = s) || ' (automatic, from the proposal).', coalesce(auth.uid(), c.owner_id));
end $$;
revoke execute on function private.seed_stages(uuid) from public, anon, authenticated;
