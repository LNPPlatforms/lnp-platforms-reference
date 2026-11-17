-- 037: billing contacts and per-account settings.
-- Any number of contacts at an organization can be marked as billing contacts.
-- account_settings holds simple per-account choices (one row per account). First one: the follow-up date buttons
-- (default Tomorrow, 1 week, 15 days, 30 days). The whole team reads them; admins change them.

alter table public.company_people add column if not exists is_billing boolean not null default false;

create table if not exists public.account_settings (
  tenant_id uuid primary key references public.tenants(id),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id)
);
alter table public.account_settings enable row level security;
create policy "team reads account settings" on public.account_settings for select using (private.is_internal() and tenant_id = private.current_tenant());
revoke all on public.account_settings from anon, authenticated;
grant select on public.account_settings to authenticated;
create trigger audit_account_settings after insert or update on public.account_settings for each row execute function private.audit();

-- save one or more settings (merged into what's there). Admins only. Each key is checked.
create or replace function public.account_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare k text; v jsonb; clean jsonb := '{}'::jsonb; out jsonb;
begin
  if not private.is_admin() then raise exception 'Only an admin can change account settings'; end if;
  for k, v in select * from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    if k = 'followup_days' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 8
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'number' or (e::text)::numeric not between 1 and 365 or (e::text)::numeric <> round((e::text)::numeric)) then
        raise exception 'Follow-up buttons need 1 to 8 whole numbers of days between 1 and 365';
      end if;
      clean := clean || jsonb_build_object(k, (select jsonb_agg(d order by d) from (select distinct (e::text)::int d from jsonb_array_elements(v) e) s));
    else raise exception 'Unknown setting %', k;
    end if;
  end loop;
  insert into account_settings (tenant_id, settings, updated_by) values (private.current_tenant(), clean, auth.uid())
  on conflict (tenant_id) do update set settings = account_settings.settings || excluded.settings, updated_at = now(), updated_by = auth.uid()
  returning settings into out;
  return out;
end $$;
revoke execute on function public.account_settings_save(jsonb) from public, anon;
grant execute on function public.account_settings_save(jsonb) to authenticated;

-- Quick Add saves the billing flag too
do $$ declare d text := pg_get_functiondef('public.quick_entry(jsonb)'::regprocedure); n text;
begin
  n := replace(d, 'work_email, is_decision_maker, is_primary_contact)', 'work_email, is_decision_maker, is_primary_contact, is_billing)');
  n := replace(n, 'coalesce((c->>''is_primary_contact'')::boolean,false))', 'coalesce((c->>''is_primary_contact'')::boolean,false), coalesce((c->>''is_billing'')::boolean,false))');
  n := replace(n, 'is_primary_contact = company_people.is_primary_contact or excluded.is_primary_contact;', 'is_primary_contact = company_people.is_primary_contact or excluded.is_primary_contact,
      is_billing = company_people.is_billing or excluded.is_billing;');
  if n = d or (length(n) - length(d)) < 100 then raise exception 'quick_entry did not match; nothing changed'; end if;
  execute n;
end $$;
