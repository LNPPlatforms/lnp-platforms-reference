-- 046: a business login is always a contact of its business (Oct 19, 2026).
-- Inviting someone to manage a listing now makes sure they're a person on that organization in the directory
-- owner's CRM: it finds them by email (personal or work email) or adds them, then links them to the organization.
-- Existing business logins are linked the same way. Nothing is removed; a deactivated link is switched back on.

create or replace function private.member_contact(p_tenant uuid, p_company uuid, p_email text, p_name text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare em text := lower(trim(coalesce(p_email, ''))); nm text := nullif(trim(coalesce(p_name, '')), ''); pid uuid; fn text; ln text;
begin
  if em = '' or p_company is null then return null; end if;
  select p.id into pid from people p
   where p.tenant_id = p_tenant and p.archived_at is null
     and (lower(p.personal_email) = em or exists (select 1 from company_people cp where cp.person_id = p.id and lower(cp.work_email) = em))
   order by exists (select 1 from company_people cp where cp.person_id = p.id and cp.company_id = p_company) desc, p.created_at
   limit 1;
  if pid is null then
    fn := coalesce(split_part(nm, ' ', 1), split_part(em, '@', 1));
    ln := nullif(trim(substr(coalesce(nm, ''), length(split_part(coalesce(nm, ''), ' ', 1)) + 1)), '');
    insert into people (tenant_id, first_name, last_name, personal_email) values (p_tenant, fn, ln, em) returning id into pid;
  end if;
  insert into company_people (tenant_id, company_id, person_id, work_email)
  values (p_tenant, p_company, pid, case when exists (select 1 from people where id = pid and lower(personal_email) = em) then null else em end)
  on conflict (company_id, person_id) do update set active = true;
  return pid;
end $$;
revoke execute on function private.member_contact(uuid, uuid, text, text) from public, anon, authenticated;

do $$
declare d text; b text;
begin
  d := pg_get_functiondef('public.directory_invite_member(uuid,text,text)'::regprocedure); b := d;
  d := replace(d, $q$  returning id into m;$q$, $q$  returning id into m;
  perform private.member_contact(l.tenant_id, l.company_id, em, coalesce(nullif(trim(coalesce(p_name, '')), ''), u.full_name));$q$);
  if d = b then raise exception 'directory_invite_member: no match'; end if;
  execute d;
end $$;

-- the business logins that exist today
do $$ declare r record; begin
  for r in select m.tenant_id, l.company_id, m.email, m.full_name from directory_members m join directory_listings l on l.id = m.listing_id
            where m.revoked_at is null loop
    perform private.member_contact(r.tenant_id, r.company_id, r.email, r.full_name);
  end loop;
end $$;
