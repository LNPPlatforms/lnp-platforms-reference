-- 072e: plain starting item types and price book lines, made the first time an account opens the measuring tool.
-- Prices start at 0 so nobody quotes a made-up number; the demo account gets sample prices.
create or replace function private.measure_seed_for(t uuid, sample boolean) returns int
language plpgsql security definer set search_path = public, private as $$
declare pave uuid; stripe uuid; curb uuid; space uuid; pole uuid; sign uuid; saw uuid; reloc uuid;
  p numeric[] := case when sample then array[0.22, 0.45, 18, 12, 650, 85, 175, 350] else array[0, 0, 0, 0, 0, 0, 0, 0]::numeric[] end;
begin
  if exists (select 1 from measure_types where tenant_id = t) then return 0; end if;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Paving', 'Priced per square foot of paved area, cutouts taken out.', 'sq_ft', p[1], 1) returning id into pave;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Striping', 'Priced per linear foot of line.', 'ln_ft', p[2], 2) returning id into stripe;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Curb', 'Priced per linear foot of curb.', 'ln_ft', p[3], 3) returning id into curb;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Parking space', 'Each parking space.', 'each', p[4], 4) returning id into space;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Light pole', 'Each light pole.', 'each', p[5], 5) returning id into pole;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Sign', 'Each sign.', 'each', p[6], 6) returning id into sign;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Saw cut and patch', 'Cutting out and patching around an item that is removed or moved.', 'each', p[7], 7) returning id into saw;
  insert into price_items (tenant_id, name, description, unit, price, sort) values (t, 'Remove or relocate', 'Taking an item out or moving it.', 'each', p[8], 8) returning id into reloc;
  insert into measure_types (tenant_id, name, kind, color, price_item_id, sort) values
    (t, 'Paved area', 'area', '#2563EB', pave, 1), (t, 'Striping', 'length', '#EAB308', stripe, 2), (t, 'Curb', 'length', '#64748B', curb, 3);
  insert into measure_types (tenant_id, name, kind, color, price_item_id, states, sort) values
    (t, 'Parking space', 'count', '#16A34A', space, jsonb_build_array(jsonb_build_object('key', 'count', 'name', 'Counted', 'short', '', 'color', '#16A34A', 'base', true, 'addons', '[]'::jsonb)), 4),
    (t, 'Light pole', 'count', '#2563EB', pole, jsonb_build_array(
       jsonb_build_object('key', 'count', 'name', 'Counted', 'short', '', 'color', '#2563EB', 'base', true, 'addons', '[]'::jsonb),
       jsonb_build_object('key', 'moved', 'name', 'Remove or relocate', 'short', 'moved', 'color', '#DC2626', 'base', false, 'addons', jsonb_build_array(reloc, saw))), 5),
    (t, 'Sign', 'count', '#2563EB', sign, jsonb_build_array(
       jsonb_build_object('key', 'count', 'name', 'Counted', 'short', '', 'color', '#2563EB', 'base', true, 'addons', '[]'::jsonb),
       jsonb_build_object('key', 'moved', 'name', 'Remove or relocate', 'short', 'moved', 'color', '#DC2626', 'base', false, 'addons', jsonb_build_array(reloc, saw))), 6);
  return 6;
end $$;
revoke execute on function private.measure_seed_for(uuid, boolean) from public, anon, authenticated;

-- the tool calls this when the account has no item types yet
create or replace function public.measure_seed() returns int
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.measure_see() and (private.can('proposals', 2) or private.measure_setup())) then raise exception 'Your role can''t measure'; end if;
  return private.measure_seed_for(private.current_tenant(), false);
end $$;
revoke execute on function public.measure_seed() from public, anon;
grant execute on function public.measure_seed() to authenticated;

-- Demo Home Service Company: Measuring on, with sample prices
do $$
declare t uuid := 'a4fb486d-a9e5-4039-a3ed-62652c9f0dde';
begin
  if not exists (select 1 from tenants where id = t) then return; end if;
  insert into account_settings (tenant_id, settings) values (t, '{"features":{"measure":true}}'::jsonb)
  on conflict (tenant_id) do update set settings = account_settings.settings
    || jsonb_build_object('features', coalesce(account_settings.settings->'features', '{}'::jsonb) || '{"measure":true}'::jsonb);
  perform private.measure_seed_for(t, true);
end $$;
