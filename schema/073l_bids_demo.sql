-- 073l: Demo Home Service Company: Bids on, a sample scorecard, a base in Biloxi and three sample bids.
do $$
declare t uuid := 'a4fb486d-a9e5-4039-a3ed-62652c9f0dde'; own uuid;
begin
  if not exists (select 1 from tenants where id = t) then return; end if;
  insert into account_settings (tenant_id, settings) values (t, '{"features":{"bids":true}}'::jsonb)
  on conflict (tenant_id) do update set settings = account_settings.settings
    || jsonb_build_object('features', coalesce(account_settings.settings->'features', '{}'::jsonb) || '{"bids":true}'::jsonb);
  insert into private.bid_settings (tenant_id, base_address, base_lat, base_lng, geocoded_at, metrics, go_at, maybe_at)
  values (t, '1 Main St, Biloxi, MS', 30.3960, -88.8853, now(), jsonb_build_array(
      jsonb_build_object('key', 'value', 'kind', 'value', 'label', 'Job size', 'rank', 1, 'good', 50000, 'poor', 5000),
      jsonb_build_object('key', 'margin', 'kind', 'margin', 'label', 'Expected margin', 'rank', 1, 'good', 30, 'poor', 10),
      jsonb_build_object('key', 'distance', 'kind', 'distance', 'label', 'Distance from the shop', 'rank', 2, 'good', 25, 'poor', 100),
      jsonb_build_object('key', 'crew', 'kind', 'crew', 'label', 'Crew free in the work window', 'rank', 2),
      jsonb_build_object('key', 'lead_time', 'kind', 'lead_time', 'label', 'Time to prepare', 'rank', 3, 'good', 14, 'poor', 3),
      jsonb_build_object('key', 'q_repeat', 'kind', 'yesno', 'label', 'Have we worked for them before?', 'rank', 3, 'yes_good', true)), 70, 45)
  on conflict (tenant_id) do nothing;
  if exists (select 1 from bids where tenant_id = t) then return; end if;
  select id into own from app_users where tenant_id = t and active and is_admin order by id limit 1;
  insert into bids (tenant_id, title, client_name, owner_id, status, due_at, window_start, window_end, est_value, est_margin, site_address, site_lat, site_lng, answers, competitor_notes, created_by) values
    (t, 'Edgewater Mall lot reseal and restripe', 'Edgewater Mall', own, 'reviewing', now() + interval '18 days', current_date + 30, current_date + 37, 68000, 28,
     '2600 Beach Blvd, Biloxi, MS', 30.3947, -88.9543, '{"crew":"yes","q_repeat":"yes"}', 'Gulf Paving bid it last year.', null),
    (t, 'Hattiesburg clinic parking lot', 'Forrest Health', own, 'new', now() + interval '4 days', current_date + 10, current_date + 12, 9000, 15,
     'Hattiesburg, MS', 31.3271, -89.2903, '{"crew":"tight","q_repeat":"no"}', null, null),
    (t, 'Gulfport school district striping', 'Gulfport School District', own, 'submitted', now() - interval '3 days', current_date + 20, current_date + 25, 24000, 22,
     'Gulfport, MS', 30.3674, -89.0928, '{"crew":"yes","q_repeat":"yes"}', 'Three other bidders at the walk-through.', null);
  update bids set submitted_amount = 23500 where tenant_id = t and status = 'submitted';
end $$;
