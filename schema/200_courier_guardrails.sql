-- 200_courier_guardrails.sql
-- Additive hardening + the three small adapter functions the courier module uses.
-- Does NOT touch private.current_tenant(), set_acting_tenant() or any policy.
--
-- ADAPTATION POINTS (edit here only, nowhere else in the bundle):
--   private.dh_me()        who is the caller               (default: auth.uid())
--   private.dh_is_admin()  is the caller an admin of the   (default: private.is_admin())
--                          ACTING account
--   private.dh_enabled()   feature + internal-user gate    (default: is_internal() AND
--                          feature_on('courier_marketplace'), same shape as your
--                          "see lines" policy on phone_lines)
-- If app_users.id is NOT the same as auth.uid(), change dh_me() only.

create or replace function private.dh_me() returns uuid
language sql stable set search_path = '' as $$
  select auth.uid() $$;

create or replace function private.dh_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.is_internal(), false)
     and coalesce(private.feature_on('courier_marketplace'), false) $$;

create or replace function private.dh_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.is_admin(), false) $$;

-- Guard helpers used inside SECURITY DEFINER functions (same checks your
-- phone_line_save does: feature, then admin; tenant match is checked per row).
create or replace function private.dh_require_enabled() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.dh_enabled() then
    raise exception 'courier marketplace is not enabled for this account' using errcode = '42501';
  end if;
end $$;

create or replace function private.dh_require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.dh_require_enabled();
  if not private.dh_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
end $$;

revoke execute on function private.dh_me(), private.dh_enabled(), private.dh_is_admin(),
                           private.dh_require_enabled(), private.dh_require_admin()
  from public, anon;
-- Policies call these as the signed-in user, so authenticated needs execute on the first three.
grant execute on function private.dh_me(), private.dh_enabled(), private.dh_is_admin() to authenticated;
revoke execute on function private.dh_require_enabled(), private.dh_require_admin() from authenticated;

-- ---------------------------------------------------------------------------
-- tenant_id immutability: a row can never be moved to another account by UPDATE.
-- Installed on every public table that has a tenant_id, EXCEPT the listed ones.
-- app_users is excluded by default because a person's home account may legitimately change.
-- Add any other table whose tenant_id is legitimately re-assigned by your own flows
-- (merges, transfers) to the exclusion list below BEFORE applying.
-- ---------------------------------------------------------------------------
create or replace function private.forbid_tenant_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable (table %)', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.install_tenant_immutable(p_exclude text[] default '{}')
returns int language plpgsql set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where ns.nspname = 'public' and c.relkind = 'r' and c.relname <> all (p_exclude)
  loop
    execute format('drop trigger if exists trg_tenant_immutable on public.%I', r.relname);
    execute format('create trigger trg_tenant_immutable before update of tenant_id on public.%I
                    for each row execute function private.forbid_tenant_change()', r.relname);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function private.install_tenant_immutable(text[]) from public, anon, authenticated;
revoke execute on function private.forbid_tenant_change() from public, anon, authenticated;

-- Applied to existing tables here. The new dh_* tables get it in 201 (re-run safe).
select private.install_tenant_immutable(array['app_users']) as tables_protected;

-- Future functions created in public are no longer executable by anon/PUBLIC by default.
-- Existing functions are unchanged. If you later add a deliberately public RPC
-- (booking pages, portal sign-in), grant execute to anon on that function explicitly.
alter default privileges in schema public revoke execute on functions from public, anon;
