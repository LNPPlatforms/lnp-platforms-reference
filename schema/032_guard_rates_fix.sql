-- 032: guard_rates crashed for non-admins editing organizations (it read app_users fields on a companies row).
create or replace function private.guard_rates() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is not null and not private.is_admin() then
    if tg_table_name = 'app_users' then
      if new.sales_rate is distinct from old.sales_rate or new.lead_rate is distinct from old.lead_rate then
        raise exception 'Only an admin can change commission rates';
      end if;
    elsif tg_table_name = 'companies' then
      if new.lead_gen_rate is distinct from old.lead_gen_rate then
        raise exception 'Only an admin can change lead gen rates';
      end if;
    end if;
  end if;
  return new;
end $$;
