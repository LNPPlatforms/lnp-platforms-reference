-- 105: a customer can be an organization or a person (Nov 16, 2026). Some accounts serve homes, not businesses.
-- Jobs, repeat schedules and route stops still hang off an organization (that's where locations, pins, invoices and
-- history live), so picking a person who isn't at any organization files them the way website leads with no company
-- already are: an "Individual" organization in their name, with them as its primary contact. Picking them again
-- reuses it. A person who is at an organization gets that organization (their primary one first).
create or replace function public.customer_for_person(p_person uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); pe people; co uuid; nm text; ind text;
begin
  if not (private.can('contacts', 2) or private.can('jobs', 2) or private.can('dispatch', 2) or private.is_admin()) then raise exception 'Not allowed'; end if;
  select * into pe from people where id = p_person and tenant_id = t and archived_at is null;
  if pe.id is null then raise exception 'Not found'; end if;
  select c.id into co from company_people cp join companies c on c.id = cp.company_id and c.archived_at is null
   where cp.person_id = pe.id and cp.active
   order by cp.is_primary_contact desc, ('Individual' = any(c.org_types)) desc, cp.created_at limit 1;
  if co is null then
    nm := nullif(trim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')), '');
    -- the account's own word for an individual, if it renamed it; otherwise Individual
    select label into ind from lookup_values where tenant_id = t and list_name = 'org_type' and active and label ilike 'individual%' order by sort_order limit 1;
    insert into companies (tenant_id, name, main_phone, main_email, org_types, created_by)
    values (t, coalesce(nm, 'Customer'), pe.personal_cell, pe.personal_email, array[coalesce(ind, 'Individual')], auth.uid())
    returning id into co;
    insert into company_people (tenant_id, company_id, person_id, work_email, work_phone, is_primary_contact)
    values (t, co, pe.id, pe.personal_email, pe.personal_cell, true);
  end if;
  return (select jsonb_build_object('id', c.id, 'name', c.name, 'divisions', c.divisions, 'person_id', pe.id) from companies c where c.id = co);
end $$;
revoke execute on function public.customer_for_person(uuid) from public, anon;
grant execute on function public.customer_for_person(uuid) to authenticated;
