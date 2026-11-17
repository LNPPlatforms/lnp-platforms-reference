-- 081z (applied Nov 3, Chris said yes): undo the products that were first put in the Measuring price book during the
-- Nov 3 call. They live in public.products now (081a). GELP doesn't use Measuring, so nothing shows these rows today.
delete from public.price_items where tenant_id = '00000000-0000-0000-0000-000000000001'
  and name in ('RLX Professional','Dashboard','Dashboard Setup','Client Organization License','Additional Enrolled Physician','Template Website','Template Funnel','Custom Funnel');
alter table public.price_items drop constraint if exists price_items_frequency_check;
alter table public.price_items drop constraint if exists price_items_unit_check;
alter table public.price_items add constraint price_items_unit_check check (unit = any (array['sq_ft','ln_ft','each']));
alter table public.price_items drop column if exists taxable, drop column if exists default_frequency,
  drop column if exists frequency_interval, drop column if exists frequency_unit;
