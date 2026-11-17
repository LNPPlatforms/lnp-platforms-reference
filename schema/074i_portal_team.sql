-- 074i: client portal, part 9. Invites. The account invites the first person (who becomes the client's admin); the
-- client's admin invites their own people and sets what each one sees (off, view or act per area).

create or replace function private.portal_clean_perms(p jsonb) returns jsonb language sql immutable as $$
  select coalesce((select jsonb_object_agg(a.key, least(a.value::int, greatest(0, coalesce((p->>a.key)::int, a.value::int))))
    from jsonb_each_text(private.portal_areas()) a), '{}'::jsonb)
$$;

create or replace function private.portal_invite_make(p_tenant uuid, p_company uuid, p_email text, p_name text, p_admin boolean, p_perms jsonb,
  p_staff uuid, p_portal uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare em text := lower(trim(coalesce(p_email, ''))); v_user uuid; nid uuid;
begin
  if em !~ '^\S+@\S+\.\S+$' then raise exception 'Enter a full email address'; end if;
  if private.is_crm_email(em) then raise exception 'That email is a login for a CRM team. Use a different email for the client portal.'; end if;
  if exists (select 1 from private.portal_users where company_id = p_company and lower(email) = em and removed_at is null) then
    raise exception 'That person already has access. Use Email it again to resend the invite.';
  end if;
  -- they may already have a portal login from another organization or account
  select user_id into v_user from private.portal_users where lower(email) = em and user_id is not null order by accepted_at desc nulls last limit 1;
  if v_user is null then
    select u.id into v_user from auth.users u where lower(u.email) = em and not exists (select 1 from app_users a where a.id = u.id) limit 1;
  end if;
  insert into private.portal_users (tenant_id, company_id, user_id, email, full_name, is_admin, perms, invited_by, invited_by_portal, accepted_at)
  values (p_tenant, p_company, v_user, em, nullif(left(trim(coalesce(p_name, '')), 120), ''), coalesce(p_admin, false), private.portal_clean_perms(p_perms),
          p_staff, p_portal, case when v_user is not null then now() end)
  returning id into nid;
  return nid;
end $$;
revoke execute on function private.portal_invite_make(uuid, uuid, text, text, boolean, jsonb, uuid, uuid), private.portal_clean_perms(jsonb) from public, anon, authenticated;

-- the client's admin: their people
create or replace function public.portal_team(p_ctx uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx);
begin
  if not x.is_admin then raise exception 'Only your portal admin can see this'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', pu.id, 'name', pu.full_name, 'email', pu.email, 'is_admin', pu.is_admin,
      'perms', private.portal_areas() || pu.perms, 'joined', pu.user_id is not null, 'invited_at', pu.invited_at, 'last_seen_at', pu.last_seen_at, 'me', pu.id = x.portal_user)
      order by pu.is_admin desc, coalesce(pu.full_name, pu.email)), '[]'::jsonb)
    from private.portal_users pu where pu.company_id = x.company_id and pu.tenant_id = x.tenant_id and pu.removed_at is null);
end $$;

create or replace function public.portal_team_invite(p_ctx uuid, p_email text, p_name text, p_admin boolean default false, p_perms jsonb default null) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx);
begin
  if not x.is_admin or x.preview then raise exception 'Only your portal admin can invite people'; end if;
  if (select count(*) from private.portal_users where company_id = x.company_id and invited_at > now() - interval '1 day') >= 30 then
    raise exception 'That''s a lot of invites for one day. Try again tomorrow.';
  end if;
  return private.portal_invite_make(x.tenant_id, x.company_id, p_email, p_name, p_admin, coalesce(p_perms, private.portal_areas()), null, x.portal_user);
end $$;

create or replace function public.portal_team_set(p_ctx uuid, p_user uuid, p_admin boolean, p_perms jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); pu private.portal_users;
begin
  if not x.is_admin or x.preview then raise exception 'Only your portal admin can change this'; end if;
  select * into pu from private.portal_users where id = p_user and company_id = x.company_id and tenant_id = x.tenant_id and removed_at is null for update;
  if not found then raise exception 'Not found'; end if;
  if pu.id = x.portal_user and not coalesce(p_admin, false) then raise exception 'You can''t take away your own admin. Make someone else admin first, then they can.'; end if;
  update private.portal_users set is_admin = coalesce(p_admin, false), perms = private.portal_clean_perms(coalesce(p_perms, perms)) where id = pu.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.portal_team_remove(p_ctx uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx);
begin
  if not x.is_admin or x.preview then raise exception 'Only your portal admin can remove people'; end if;
  if p_user = x.portal_user then raise exception 'You can''t remove yourself'; end if;
  update private.portal_users set removed_at = now() where id = p_user and company_id = x.company_id and tenant_id = x.tenant_id and removed_at is null;
  if not found then raise exception 'Not found'; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.portal_team(uuid), public.portal_team_invite(uuid, text, text, boolean, jsonb), public.portal_team_set(uuid, uuid, boolean, jsonb),
  public.portal_team_remove(uuid, uuid) from public, anon;
grant execute on function public.portal_team(uuid), public.portal_team_invite(uuid, text, text, boolean, jsonb), public.portal_team_set(uuid, uuid, boolean, jsonb),
  public.portal_team_remove(uuid, uuid) to authenticated;
