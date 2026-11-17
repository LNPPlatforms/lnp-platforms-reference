-- 074n: Demo Home Service Company gets the Client portal switch on.
do $$
declare t uuid := 'a4fb486d-a9e5-4039-a3ed-62652c9f0dde';
begin
  if not exists (select 1 from tenants where id = t) then return; end if;
  insert into account_settings (tenant_id, settings) values (t, '{"features":{"portal":true}}'::jsonb)
  on conflict (tenant_id) do update set settings = account_settings.settings
    || jsonb_build_object('features', coalesce(account_settings.settings->'features', '{}'::jsonb) || '{"portal":true}'::jsonb);
end $$;
