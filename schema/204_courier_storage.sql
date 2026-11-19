-- 204_courier_storage.sql
-- Private bucket for proof-of-delivery photos. Object path convention (enforced by RLS):
--     t/<owner_tenant_id>/<zone_id>/<client_drop_id>.jpg
-- * a courier may UPLOAD only into a zone currently assigned to them, under that zone's
--   owning-account folder (so a courier from another account cannot write elsewhere)
-- * only admins of the OWNING account may READ
-- * no update/delete policies: objects are immutable evidence from the client side

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('drop-photos', 'drop-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Safe uuid parsing: malformed paths simply fail the check instead of erroring.
create or replace function private.dh_zone_path_ok(p_tenant text, p_zone text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_zone uuid;
begin
  if p_zone is null or p_tenant is null
     or p_zone !~ '^[0-9a-fA-F-]{36}$' or p_tenant !~ '^[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  v_zone := p_zone::uuid;
  return exists (
    select 1 from public.dh_zones z
    where z.id = v_zone and z.tenant_id = p_tenant::uuid
      and z.courier_id = private.dh_me() and z.status in ('claimed','in_progress'));
end $$;
revoke execute on function private.dh_zone_path_ok(text,text) from public, anon;
grant  execute on function private.dh_zone_path_ok(text,text) to authenticated;

create policy "dh photos: courier upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'drop-photos'
    and (storage.foldername(name))[1] = 't'
    and (select private.dh_enabled())
    and private.dh_zone_path_ok((storage.foldername(name))[2], (storage.foldername(name))[3]) );

create policy "dh photos: owner admin read" on storage.objects for select to authenticated
  using (
    bucket_id = 'drop-photos'
    and (storage.foldername(name))[1] = 't'
    and (select private.dh_enabled())
    and (select private.dh_is_admin())
    and (storage.foldername(name))[2] = (select private.current_tenant())::text );
