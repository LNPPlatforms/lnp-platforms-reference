-- 086d (Nov 9, 2026): portal invites go out from the agency's own sending domain (send_domain added to the answer).
create or replace function public.portal_invite_info(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare pu private.portal_users; me private.portal_users; from_name text; wl jsonb;
begin
  select * into pu from private.portal_users where id = p_id and removed_at is null;
  if not found then return null; end if;
  if private.portal_staff_ok(pu.company_id) then
    select full_name into from_name from app_users where id = auth.uid();
  else
    select * into me from private.portal_users where user_id = auth.uid() and company_id = pu.company_id and removed_at is null and is_admin;
    if not found or not private.feature_on_for(pu.tenant_id, 'portal') then return null; end if;
    from_name := coalesce(nullif(trim(me.full_name), ''), me.email);
  end if;
  if pu.invite_sent_at > now() - interval '1 minute' then raise exception 'That invite just went out. Give it a minute.'; end if;
  update private.portal_users set invite_sent_at = now() where id = pu.id;
  wl := private.brand_of(pu.tenant_id);
  return jsonb_build_object('email', pu.email, 'name', pu.full_name, 'is_admin', pu.is_admin, 'has_login', pu.user_id is not null,
    'org', (select name from companies where id = pu.company_id), 'account', (select name from tenants where id = pu.tenant_id),
    'slug', (select slug from tenants where id = pu.tenant_id), 'from_name', from_name, 'brand', private.doc_brand(pu.tenant_id),
    'domain', wl->>'domain', 'send_domain', wl->>'send_domain', 'from_label', private.doc_brand(pu.tenant_id)->>'name', 'reply_to', wl->>'support_email');
end $$;
