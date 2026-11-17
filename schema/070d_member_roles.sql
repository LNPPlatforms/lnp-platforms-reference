-- 070d: role, customer facing and pay rates work for members too (the member row holds them for that account).

create or replace function public.user_role_set(p_user uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); mem boolean;
begin
  if not private.can('team', 4) then raise exception 'Only someone who can manage the team can change roles'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own role'; end if;
  mem := exists (select 1 from account_members where user_id = p_user and tenant_id = t and active);
  if not mem and not exists (select 1 from app_users where id = p_user and tenant_id = t) then raise exception 'Person not found'; end if;
  if private.admin_in(p_user, t) and not private.is_admin() then raise exception 'Only an admin can change an admin'; end if;
  if p_role is not null and not exists (select 1 from roles where id = p_role and tenant_id = t and archived_at is null) then raise exception 'Role not found'; end if;
  if p_role is not null and not private.within_mine((select perms from roles where id = p_role)) then raise exception 'You can''t give someone more access than you have yourself'; end if;
  if mem then update account_members set role_id = p_role where user_id = p_user and tenant_id = t;
  else update app_users set role_id = p_role where id = p_user; end if;
end $$;

create or replace function public.user_customer_facing_set(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.is_admin() or private.can('team', 4)) then raise exception 'Only people who manage the team can change this'; end if;
  update app_users set customer_facing = p_on where id = p_user and tenant_id = private.current_tenant();
  if not found then
    update account_members set customer_facing = p_on where user_id = p_user and tenant_id = private.current_tenant() and active;
    if not found then raise exception 'Person not found'; end if;
  end if;
end $$;

create or replace function public.pay_rate_save(p_user uuid, p_kind text, p_rate numeric, p_division uuid, p_from date, p_note text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare out uuid;
begin
  if not private.can('pay', 4) then raise exception 'Only someone who manages pay can set rates'; end if;
  if not private.on_team(p_user, private.current_tenant()) then raise exception 'Person not found'; end if;
  if not coalesce((private.acct_setting('mixed_pay_types')#>>'{}')::boolean, true)
     and exists (select 1 from pay_rates where user_id = p_user and archived_at is null and kind <> p_kind) then
    raise exception 'This account pays each person one way. Turn on mixed pay types in Settings to add a second.';
  end if;
  insert into pay_rates (user_id, kind, rate, division_id, effective_from, note) values (p_user, p_kind, p_rate, p_division, coalesce(p_from, current_date), p_note) returning id into out;
  return out;
end $$;

create or replace function public.role_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('team', 4) then raise exception 'Only someone who can manage the team can remove roles'; end if;
  if not private.within_mine((select perms from roles where id = p_id and tenant_id = private.current_tenant())) then raise exception 'That role has more access than you do'; end if;
  if exists (select 1 from app_users where role_id = p_id and active) or exists (select 1 from account_members where role_id = p_id and active) then
    raise exception 'Move everyone off this role first';
  end if;
  update roles set archived_at = now() where id = p_id and tenant_id = private.current_tenant();
end $$;

-- the team list: members of the account you're in show up next to its own people
alter policy "self read" on public.app_users
  using (id = auth.uid() or (private.is_internal() and (tenant_id = private.current_tenant()
    or exists (select 1 from public.account_members m where m.user_id = app_users.id and m.tenant_id = private.current_tenant() and m.active))));
alter policy "manage pay profile" on public.worker_pay_profiles
  with check (tenant_id = private.current_tenant() and private.can('pay', 4) and private.on_team(user_id, private.current_tenant()));
alter policy "manage department members" on public.department_members
  with check (tenant_id = private.current_tenant() and (private.is_admin() or private.can('team', 4))
    and exists (select 1 from departments d where d.id = department_members.department_id and d.tenant_id = private.current_tenant())
    and private.on_team(user_id, private.current_tenant()));
