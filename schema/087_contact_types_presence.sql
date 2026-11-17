-- 087: contact types on people (Contact, Client, Vendor, more than one at a time), Client added to organization types,
-- and team presence for the online dots in Internal chat. Nov 10, 2026.

-- People get types the same way organizations do: a text array driven by an editable per-account list.
alter table public.people add column if not exists person_types text[] not null default '{Contact}';
create index if not exists people_person_types_idx on public.people using gin (person_types);

-- every account starts with Contact, Client and Vendor for people
insert into public.lookup_values (tenant_id, list_name, label, sort_order, active)
select t.id, v.list, v.label, v.ord, true
  from public.tenants t
  cross join (values ('person_type', 'Contact', 1), ('person_type', 'Client', 2), ('person_type', 'Vendor', 3)) as v(list, label, ord)
 where not exists (select 1 from public.lookup_values x where x.tenant_id = t.id and x.list_name = v.list and x.label = v.label);

-- organizations already have Vendor; add Client where it's missing
insert into public.lookup_values (tenant_id, list_name, label, sort_order, active)
select t.id, 'org_type', 'Client', 2, true from public.tenants t
 where not exists (select 1 from public.lookup_values x where x.tenant_id = t.id and x.list_name = 'org_type' and x.label = 'Client');

-- renaming a person type carries through to the people that use it
create or replace function public.rename_lookup(p_list text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(trim(p_new),'') = '' then raise exception 'Name required'; end if;
  update lookup_values set label = trim(p_new) where tenant_id = private.current_tenant() and list_name = p_list and label = p_old;
  case p_list
    when 'org_type' then update companies set org_types = array_replace(org_types, p_old, trim(p_new)) where tenant_id = private.current_tenant() and p_old = any(org_types);
    when 'person_type' then update people set person_types = array_replace(person_types, p_old, trim(p_new)) where tenant_id = private.current_tenant() and p_old = any(person_types);
    when 'org_stage' then update companies set stage = trim(p_new) where tenant_id = private.current_tenant() and stage = p_old;
    when 'specialty' then update companies set specialty = trim(p_new) where tenant_id = private.current_tenant() and specialty = p_old;
    when 'interest_level' then update companies set interest_level = trim(p_new) where tenant_id = private.current_tenant() and interest_level = p_old;
    when 'lead_channel' then update companies set lead_source_channel = trim(p_new) where tenant_id = private.current_tenant() and lead_source_channel = p_old;
    when 'contact_role' then update company_people set role = trim(p_new) where tenant_id = private.current_tenant() and role = p_old;
    when 'service' then update opportunities set service = trim(p_new) where tenant_id = private.current_tenant() and service = p_old;
    when 'opportunity_status' then update opportunities set status = trim(p_new) where tenant_id = private.current_tenant() and status = p_old;
    when 'preferred_contact' then update people set preferred_contact_method = trim(p_new) where tenant_id = private.current_tenant() and preferred_contact_method = p_old;
    when 'escalation_reason' then update escalations set reason = trim(p_new) where tenant_id = private.current_tenant() and reason = p_old;
    else null;
  end case;
end $$;

-- Presence: when each person on this account (staff and members from other accounts) was last in the CRM.
-- The chat heartbeat already stamps app_users.last_seen_at every minute while the CRM is open and showing.
create or replace function public.team_presence() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'last_seen_at', u.last_seen_at, 'online', private.online(u.id))), '[]'::jsonb)
    from app_users u
   where private.is_internal() and u.active
     and (u.tenant_id = private.current_tenant()
       or u.id in (select m.user_id from account_members m where m.active and m.tenant_id = private.current_tenant()))
$$;
revoke execute on function public.team_presence() from public, anon;
grant execute on function public.team_presence() to authenticated;
