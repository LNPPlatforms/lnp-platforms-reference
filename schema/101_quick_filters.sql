-- 101: Quick filters on the organizations list. They're Shortcuts (screen 'orgs') under a friendlier name: any mix of
-- filters saved as one chip, personal by default, shared with the whole team when an admin chooses.
-- New filter: "active in the last N days", from the organization's latest activity (a note, change, form, chat...).
alter table public.companies add column if not exists last_activity_at timestamptz;
create index if not exists companies_last_activity on public.companies (tenant_id, last_activity_at desc);

create or replace function private.touch_company_activity() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.company_id is not null then
    update companies set last_activity_at = greatest(coalesce(last_activity_at, new.created_at), new.created_at) where id = new.company_id;
  end if;
  return null;
exception when others then return null;   -- never block the note or event itself
end $$;
revoke execute on function private.touch_company_activity() from public, anon, authenticated;
create or replace trigger touch_company_activity after insert on public.contact_events for each row execute function private.touch_company_activity();
create or replace trigger touch_company_activity after insert on public.activities for each row execute function private.touch_company_activity();

-- fill it in from what's already there
update companies c set last_activity_at = x.at
  from (select company_id, max(created_at) at from (
          select company_id, created_at from contact_events where company_id is not null
          union all select company_id, created_at from activities where company_id is not null) a group by company_id) x
 where x.company_id = c.id and (c.last_activity_at is null or c.last_activity_at < x.at);

-- admins can rename, reorder or remove any shared quick filter (not just their own)
drop policy if exists "admins manage shared shortcuts" on public.shortcuts;
create policy "admins manage shared shortcuts" on public.shortcuts for update using (tenant_id = private.current_tenant() and private.is_admin() and shared)
  with check (tenant_id = private.current_tenant() and private.is_admin());
drop policy if exists "admins remove shared shortcuts" on public.shortcuts;
create policy "admins remove shared shortcuts" on public.shortcuts for delete using (tenant_id = private.current_tenant() and private.is_admin() and shared);
