-- 073f: bids, part 4. Reading and saving an account's bid settings and scorecard. Saving rescores every open bid.

-- the account's bid email address: bids+slug@domain (or slug@domain), null until the platform sets the domain
create or replace function private.bid_address(t uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select case when c.domain is null or tn.slug is null then null when c.style = 'plain' then tn.slug || '@' || c.domain else 'bids+' || tn.slug || '@' || c.domain end
  from private.bid_intake_config c, tenants tn where c.id = 1 and tn.id = t
$$;
revoke execute on function private.bid_address(uuid) from public, anon, authenticated;

create or replace function public.bid_settings_get() returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); s private.bid_settings; setup boolean := private.bids_setup(); out jsonb;
begin
  if not private.bids_see() then return null; end if;
  select * into s from private.bid_settings where tenant_id = t;
  out := jsonb_build_object('base_address', s.base_address, 'base_lat', s.base_lat, 'base_lng', s.base_lng, 'geocoded_at', s.geocoded_at,
    'metrics', coalesce(s.metrics, '[]'::jsonb), 'go_at', coalesce(s.go_at, 70), 'maybe_at', coalesce(s.maybe_at, 45),
    'override_review', coalesce(s.override_review, true), 'email_on', coalesce(s.email_on, true), 'upload_on', coalesce(s.upload_on, false),
    'upload_intro', s.upload_intro, 'email_address', case when coalesce(s.email_on, true) then private.bid_address(t) end,
    'email_ready', (select domain is not null from private.bid_intake_config where id = 1),
    'can_edit', setup, 'set_up', s.tenant_id is not null);
  if setup then
    out := out || jsonb_build_object('upload_token', s.upload_token, 'email_domain', (select domain from private.bid_intake_config where id = 1),
      'email_style', (select style from private.bid_intake_config where id = 1), 'platform_owner', private.is_platform_owner());
  end if;
  return out;
end $$;

revoke execute on function public.bid_settings_get() from public, anon;
grant execute on function public.bid_settings_get() to authenticated;
