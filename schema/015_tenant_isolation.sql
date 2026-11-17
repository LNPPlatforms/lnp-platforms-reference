-- 015: tenant isolation and account switching (Oct 16, 2026).
-- Every account (tenant) sees only its own data. Admins are admins of their own account only.
-- Platform admins (admins whose home account is GELP) can switch into any account to work in it as that account's
-- admin; current_tenant() follows the switch. Functions that bypass row security now check the account too.
-- New accounts get the four default pipeline stages and a copy of GELP's dropdown lists to start from.

alter table public.app_users add column if not exists acting_tenant_id uuid references public.tenants(id);

create or replace function private.current_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.acting_tenant_id is not null and u.is_admin and u.active and u.tenant_id = private.default_tenant()
                               then u.acting_tenant_id else u.tenant_id end
                     from app_users u where u.id = private.actor()), private.default_tenant())
$$;

-- platform admins: switch into an account (null or GELP = back home)
create or replace function public.set_acting_tenant(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_admin() then raise exception 'Only GELP admins can switch accounts'; end if;
  if p_tenant is not null and not exists (select 1 from tenants where id = p_tenant) then raise exception 'Account not found'; end if;
  update app_users set acting_tenant_id = nullif(p_tenant, private.default_tenant()) where id = auth.uid();
  return jsonb_build_object('ok', true, 'tenant', private.current_tenant());
end $$;

-- who am I working as right now
create or replace function public.current_account() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'home', (select tenant_id from app_users where id = auth.uid()),
    'platform_admin', private.is_platform_admin(), 'is_gelp', t.id = private.default_tenant())
  from tenants t where t.id = private.current_tenant()
$$;

-- platform admins: create an account and invite its first owner
create or replace function public.create_account(p_name text, p_slug text, p_owner_email text, p_owner_name text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare tid uuid; v_slug text := lower(regexp_replace(coalesce(nullif(trim(p_slug), ''), p_name), '[^a-zA-Z0-9]+', '-', 'g'));
begin
  if not private.is_platform_admin() then raise exception 'Only GELP admins can create accounts'; end if;
  if length(coalesce(trim(p_name), '')) < 2 then raise exception 'Name the account'; end if;
  v_slug := trim(both '-' from v_slug);
  if exists (select 1 from tenants where slug = v_slug) then raise exception 'That short name is taken'; end if;
  insert into tenants (name, slug, agency_tenant_id) values (trim(p_name), v_slug, private.default_tenant()) returning id into tid;
  if coalesce(trim(p_owner_email), '') ~ '^\S+@\S+\.\S+$' then
    insert into invites (tenant_id, email, full_name, role, is_admin, invited_by)
    values (tid, lower(trim(p_owner_email)), nullif(trim(p_owner_name), ''), 'staff', true, auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'id', tid, 'slug', v_slug);
end $$;

-- new accounts start with GELP's dropdown lists (they can edit their copy)
create or replace function private.seed_lookups(p_tenant uuid) returns void
language sql security definer set search_path = public, private as $$
  insert into lookup_values (tenant_id, list_name, label, sort_order, active)
  select p_tenant, list_name, label, sort_order, active from lookup_values
   where tenant_id = private.default_tenant() and list_name <> 'org_stage' and p_tenant <> private.default_tenant()
     and not exists (select 1 from lookup_values x where x.tenant_id = p_tenant and x.list_name = lookup_values.list_name and x.label = lookup_values.label)
$$;
create or replace function private.seed_pipeline_trg() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin perform private.seed_pipeline(new.id); perform private.seed_lookups(new.id); return new; end $$;

revoke execute on function private.seed_lookups(uuid) from public, anon, authenticated;
revoke execute on function public.set_acting_tenant(uuid), public.current_account(), public.create_account(text, text, text, text) from public, anon;
grant execute on function public.set_acting_tenant(uuid), public.current_account(), public.create_account(text, text, text, text) to authenticated;

-- row security: same account only
alter policy "internal all activities" on public.activities using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "admin manage users" on public.app_users using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
alter policy "self read" on public.app_users using (id = auth.uid() or (private.is_internal() and tenant_id = private.current_tenant()));
alter policy "admin read audit" on public.audit_log using (private.is_admin() and tenant_id = private.current_tenant());
alter policy "internal all companies" on public.companies
  using (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()))
  with check (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()));
alter policy "internal all links" on public.company_people using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "escalation create" on public.escalations with check (private.is_internal() and tenant_id = private.current_tenant() and from_user = auth.uid());
alter policy "escalation read" on public.escalations using (private.is_internal() and tenant_id = private.current_tenant() and (from_user = auth.uid() or to_user = auth.uid() or private.is_admin()));
alter policy "escalation clear" on public.escalations
  using (private.is_internal() and tenant_id = private.current_tenant() and (to_user = auth.uid() or private.is_admin()))
  with check (private.is_internal() and tenant_id = private.current_tenant() and (to_user = auth.uid() or private.is_admin()));
alter policy "admin manage invites" on public.invites using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
alter policy "admin manage lookups" on public.lookup_values using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
alter policy "read lookups" on public.lookup_values using (auth.uid() is not null and tenant_id = private.current_tenant());
alter policy "internal all media" on public.media using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "internal all opps" on public.opportunities using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "internal all people" on public.people
  using (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()))
  with check (private.is_internal() and tenant_id = private.current_tenant() and (archived_at is null or private.is_admin()));
alter policy "admin read review" on public.review_items using (private.is_admin() and tenant_id = private.current_tenant());
alter policy "admin update review" on public.review_items using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
alter policy "internal all tasks" on public.tasks using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "internal all assignments" on public.vendor_companies using (private.is_internal() and tenant_id = private.current_tenant()) with check (private.is_internal() and tenant_id = private.current_tenant());
alter policy "admin manage vendors" on public.vendors using (private.is_admin() and tenant_id = private.current_tenant()) with check (private.is_admin() and tenant_id = private.current_tenant());
alter policy "internal read vendors" on public.vendors using ((private.is_internal() and tenant_id = private.current_tenant()) or id = (select vendor_id from app_users where id = auth.uid()));
alter policy "create proposals" on public.proposals with check (private.is_internal() and tenant_id = private.current_tenant());

-- audit rows belong to the record's account
alter table public.audit_log alter column tenant_id set default private.current_tenant();

-- functions that skip row security: check the account
do $$
declare d text; b text;
  fixes text[][] := array[
    array['public.merge_records(text,uuid,uuid)',
      $q$  if p_keep = p_drop then raise exception 'Pick two different records'; end if;$q$,
      $q$  if p_keep = p_drop then raise exception 'Pick two different records'; end if;
  if p_entity = 'companies' and (select count(*) from companies where id in (p_keep, p_drop) and tenant_id = private.current_tenant()) <> 2 then raise exception 'Record not found'; end if;
  if p_entity = 'people' and (select count(*) from people where id in (p_keep, p_drop) and tenant_id = private.current_tenant()) <> 2 then raise exception 'Record not found'; end if;$q$],
    array['public.flag_duplicate(text,uuid,uuid,text)',
      $q$  if p_entity not in ('companies','people') or p_id = p_other then raise exception 'Bad request'; end if;$q$,
      $q$  if p_entity not in ('companies','people') or p_id = p_other then raise exception 'Bad request'; end if;
  if p_entity = 'companies' and (select count(*) from companies where id in (p_id, p_other) and tenant_id = private.current_tenant()) <> 2 then raise exception 'Record not found'; end if;
  if p_entity = 'people' and (select count(*) from people where id in (p_id, p_other) and tenant_id = private.current_tenant()) <> 2 then raise exception 'Record not found'; end if;$q$],
    array['public.request_delete(text,uuid,text)',
      $q$    where id = p_id and archived_at is null;$q$,
      $q$    where id = p_id and archived_at is null and tenant_id = private.current_tenant();$q$],
    array['public.resolve_review(uuid,text)',
      $q$  select * into r from review_items where id = p_item and status = 'open';$q$,
      $q$  select * into r from review_items where id = p_item and status = 'open' and tenant_id = private.current_tenant();$q$],
    array['public.restore_record(text,uuid)',
      $q$ where id = p_id;$q$,
      $q$ where id = p_id and tenant_id = private.current_tenant();$q$],
    array['private.audit()',
      $q$coalesce(nullif(r->>'tenant_id','')::uuid, private.default_tenant())$q$,
      $q$coalesce(nullif(r->>'tenant_id','')::uuid, private.current_tenant())$q$]];
  i int;
begin
  for i in 1 .. array_length(fixes, 1) loop
    d := replace(pg_get_functiondef(fixes[i][1]::regprocedure), E'\r\n', E'\n');
    if position('current_tenant()' in d) > 0 and fixes[i][1] <> 'private.audit()' then continue; end if;
    b := d; d := replace(d, fixes[i][2], fixes[i][3]);
    if d = b then
      if fixes[i][1] = 'private.audit()' and position('private.current_tenant())' in d) > 0 then continue; end if;
      raise exception 'tenancy patch % (%) did not match', i, fixes[i][1];
    end if;
    execute d;
  end loop;
  -- rename_lookup: every update stays inside the account
  d := replace(pg_get_functiondef('public.rename_lookup(text,text,text)'::regprocedure), E'\r\n', E'\n');
  if position('current_tenant()' in d) = 0 then
    b := d;
    d := regexp_replace(d, '(update [a-z_]+ set [^;]*? where )', '\1tenant_id = private.current_tenant() and ', 'g');
    if d = b then raise exception 'rename_lookup patch did not match'; end if;
    execute d;
  end if;
end $$;
