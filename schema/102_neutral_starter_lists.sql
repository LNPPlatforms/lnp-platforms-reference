-- 102: new accounts start with plain, any-business lists instead of GELP's healthcare ones (Nov 13, 2026).
-- Until now a new account copied GELP's lists (Clinic, physician roles, medical specialties). Now it gets the starter
-- lists below. Accounts that already exist (GELP included) keep exactly what they have; each account edits its own
-- lists in Admin > Settings as before.
create table if not exists private.starter_lookups (
  list_name text not null,
  label text not null,
  sort_order int not null default 0,
  primary key (list_name, label)
);
revoke all on private.starter_lookups from public, anon, authenticated;

insert into private.starter_lookups (list_name, label, sort_order) values
  ('org_type', 'Client', 1), ('org_type', 'Prospect', 2), ('org_type', 'Vendor', 3), ('org_type', 'Partner', 4), ('org_type', 'Individual', 5),
  ('contact_role', 'Owner', 1), ('contact_role', 'Manager', 2), ('contact_role', 'Office / Admin', 3), ('contact_role', 'Sales', 4),
  ('contact_role', 'Operations', 5), ('contact_role', 'Billing / Accounting', 6), ('contact_role', 'Other', 7),
  ('lead_channel', 'Referral', 1), ('lead_channel', 'Website', 2), ('lead_channel', 'Google', 3), ('lead_channel', 'Social media', 4),
  ('lead_channel', 'Phone', 5), ('lead_channel', 'Email', 6), ('lead_channel', 'Event', 7), ('lead_channel', 'Existing relationship', 8), ('lead_channel', 'Other', 9),
  ('service', 'Consultation', 1), ('service', 'Installation', 2), ('service', 'Maintenance', 3), ('service', 'Repair', 4), ('service', 'Support', 5), ('service', 'Other', 6),
  ('specialty', 'Home Services', 1), ('specialty', 'Construction', 2), ('specialty', 'Retail', 3), ('specialty', 'Professional Services', 4),
  ('specialty', 'Healthcare', 5), ('specialty', 'Hospitality', 6), ('specialty', 'Other', 7),
  ('opportunity_status', 'New', 1), ('opportunity_status', 'Contacted', 2), ('opportunity_status', 'Met', 3), ('opportunity_status', 'Interested', 4),
  ('opportunity_status', 'Estimate / Quote', 5), ('opportunity_status', 'Proposal', 6), ('opportunity_status', 'Customer', 7),
  ('opportunity_status', 'Follow-Up Later', 8), ('opportunity_status', 'Not Interested', 9)
on conflict do nothing;

-- lists that were already industry-neutral carry over from the platform default as they are today
insert into private.starter_lookups (list_name, label, sort_order)
select list_name, label, sort_order from lookup_values
 where tenant_id = private.default_tenant() and active
   and list_name in ('escalation_reason', 'interest_level', 'person_type', 'preferred_contact')
on conflict do nothing;

-- new accounts: the starter lists (any list not in the starter set still copies from the platform default, minus its
-- healthcare lists, so nothing a new screen expects goes missing)
create or replace function private.seed_lookups(p_tenant uuid) returns void
language sql security definer set search_path = public, private as $$
  insert into lookup_values (tenant_id, list_name, label, sort_order, active)
  select p_tenant, s.list_name, s.label, s.sort_order, true from private.starter_lookups s
   where p_tenant <> private.default_tenant()
     and not exists (select 1 from lookup_values x where x.tenant_id = p_tenant and x.list_name = s.list_name and x.label = s.label);
  insert into lookup_values (tenant_id, list_name, label, sort_order, active)
  select p_tenant, list_name, label, sort_order, active from lookup_values
   where tenant_id = private.default_tenant() and list_name <> 'org_stage' and p_tenant <> private.default_tenant()
     and list_name not in (select distinct list_name from private.starter_lookups)
     and not exists (select 1 from lookup_values x where x.tenant_id = p_tenant and x.list_name = lookup_values.list_name and x.label = lookup_values.label)
$$;
revoke execute on function private.seed_lookups(uuid) from public, anon, authenticated;

-- older paths (imports, website forms, the column default) still say Clinic. In an account that has no Clinic type,
-- that becomes the account's first organization type instead (Client in new accounts).
create or replace function private.org_type_fallback() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare d text;
begin
  if new.org_types = '{Clinic}'::text[] and not exists (
       select 1 from lookup_values where tenant_id = new.tenant_id and list_name = 'org_type' and label = 'Clinic' and active) then
    select label into d from lookup_values where tenant_id = new.tenant_id and list_name = 'org_type' and active order by sort_order, label limit 1;
    new.org_types := array[coalesce(d, 'Client')];
  end if;
  return new;
end $$;
revoke execute on function private.org_type_fallback() from public, anon, authenticated;
create or replace trigger org_type_fallback before insert on public.companies for each row execute function private.org_type_fallback();
