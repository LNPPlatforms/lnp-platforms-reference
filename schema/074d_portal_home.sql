-- 074d: client portal, part 4. What the portal reads: who I am, the sign in brand and the home page.
-- Only rows for the client's organization and the locations under it, in that account, that the team hasn't hidden.

-- every portal I can open (a person can be a client of more than one organization or account)
create or replace function public.portal_me() returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is null then return null; end if;
  if exists (select 1 from app_users where id = auth.uid()) then return jsonb_build_object('crm', true, 'portals', '[]'::jsonb); end if;
  update private.portal_users set last_seen_at = now() where user_id = auth.uid() and removed_at is null;
  return jsonb_build_object('crm', false, 'portals', coalesce((select jsonb_agg(jsonb_build_object('id', pu.id, 'org', c.name, 'account', t.name,
      'is_admin', pu.is_admin, 'brand', private.doc_brand(pu.tenant_id)) order by t.name, c.name)
    from private.portal_users pu join companies c on c.id = pu.company_id and c.archived_at is null join tenants t on t.id = pu.tenant_id
    where pu.user_id = auth.uid() and pu.removed_at is null and private.feature_on_for(pu.tenant_id, 'portal')), '[]'::jsonb));
end $$;

-- the brand on the sign in page, from the account's short name in the invite link (only when its portal is on)
create or replace function public.portal_brand(p_account text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select private.doc_brand(t.id) from tenants t where t.slug = lower(trim(p_account)) and private.feature_on_for(t.id, 'portal')
$$;

create or replace function public.portal_home(p_ctx uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); pu private.portal_users; wl jsonb;
begin
  select * into pu from private.portal_users where id = x.portal_user;
  wl := private.brand_of(x.tenant_id);
  return jsonb_build_object('org', (select name from companies where id = x.company_id), 'account', (select name from tenants where id = x.tenant_id),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from companies where id = any(x.orgs) and id <> x.company_id),
    'brand', private.doc_brand(x.tenant_id), 'platform', case when wl is not null then jsonb_build_object('name', wl->>'name', 'support_email', wl->>'support_email') end,
    'levels', x.levels, 'is_admin', x.is_admin, 'preview', x.preview, 'welcome', x.settings->>'welcome',
    'me', case when pu.id is not null then jsonb_build_object('name', pu.full_name, 'email', pu.email) end,
    'counts', jsonb_build_object(
      'upcoming', case when private.portal_lvl(x, 'schedule') > 0 then (select count(*) from jobs j where j.tenant_id = x.tenant_id and j.company_id = any(x.orgs)
         and not j.portal_hidden and j.archived_at is null and j.scheduled_start >= now() and j.status not in ('cancelled', 'no_show')) end,
      'next_visit', case when private.portal_lvl(x, 'schedule') > 0 then (select min(j.scheduled_start) from jobs j where j.tenant_id = x.tenant_id and j.company_id = any(x.orgs)
         and not j.portal_hidden and j.archived_at is null and j.scheduled_start >= now() and j.status not in ('cancelled', 'no_show')) end,
      'open_invoices', case when private.portal_lvl(x, 'invoices') > 0 then (select count(*) from invoices i where i.tenant_id = x.tenant_id and i.company_id = any(x.orgs)
         and not i.portal_hidden and i.status in ('sent', 'partial') and i.balance > 0) end,
      'balance', case when private.portal_lvl(x, 'invoices') > 0 then (select coalesce(sum(i.balance), 0) from invoices i where i.tenant_id = x.tenant_id and i.company_id = any(x.orgs)
         and not i.portal_hidden and i.status in ('sent', 'partial')) end,
      'estimates', case when private.portal_lvl(x, 'estimates') > 0 then (select count(*) from proposals p where p.tenant_id = x.tenant_id and p.company_id = any(x.orgs)
         and not p.portal_hidden and p.status = 'sent' and (p.expires_at is null or p.expires_at > now())) end,
      'approvals', case when private.portal_lvl(x, 'approvals') > 0 then (select count(*) from portal_approvals a where a.tenant_id = x.tenant_id and a.company_id = any(x.orgs)
         and not a.portal_hidden and a.status = 'pending') end));
end $$;

revoke execute on function public.portal_me(), public.portal_home(uuid) from public, anon;
grant execute on function public.portal_me(), public.portal_home(uuid) to authenticated;
revoke execute on function public.portal_brand(text) from public;
grant execute on function public.portal_brand(text) to anon, authenticated;
