-- 074m: client portal, part 13. The portal settings (Tools, Admin, Client portal).

create or replace function public.portal_settings_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then private.portal_settings(private.current_tenant())
    || jsonb_build_object('can_edit', private.is_admin() or private.can('settings', 4), 'on', private.feature_on('portal')) end
$$;

create or replace function public.portal_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); cur jsonb; secs jsonb := '{}'::jsonb; k text;
begin
  if not private.is_internal() or not (private.is_admin() or private.can('settings', 4)) then raise exception 'Only an admin can change portal settings'; end if;
  cur := private.portal_settings(t);
  for k in select jsonb_object_keys(private.portal_areas()) loop
    secs := secs || jsonb_build_object(k, coalesce(case when jsonb_typeof(p->'sections'->k) = 'boolean' then (p->'sections'->>k)::boolean end, (cur->'sections'->>k)::boolean));
  end loop;
  insert into account_settings (tenant_id, settings) values (t, '{}'::jsonb) on conflict (tenant_id) do nothing;
  update account_settings set settings = settings || jsonb_build_object('portal', jsonb_build_object('sections', secs,
      'files_default', case when coalesce(p->>'files_default', cur->>'files_default') = 'shared' then 'shared' else 'hidden' end,
      'welcome', left(nullif(trim(coalesce(case when p ? 'welcome' then p->>'welcome' else cur->>'welcome' end, '')), ''), 500))),
    updated_at = now(), updated_by = auth.uid() where tenant_id = t;
  return public.portal_settings_get();
end $$;

revoke execute on function public.portal_settings_get(), public.portal_settings_save(jsonb) from public, anon;
grant execute on function public.portal_settings_get(), public.portal_settings_save(jsonb) to authenticated;
