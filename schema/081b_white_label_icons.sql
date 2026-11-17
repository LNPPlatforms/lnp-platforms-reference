-- 081b: each agency's white label carries its own app icons and favicon, so the installed app, the browser tab
-- and the home screen show the agency (GELP, GCC, Cognix) instead of one shared LNP set. Clients see their agency's.
-- /manifest.json and the icon paths are served per web address by functions/ (Cloudflare Pages) from brand_for_host.
alter table public.white_labels
  add column if not exists favicon_url text,
  add column if not exists apple_icon_url text,
  add column if not exists icon_192_url text,
  add column if not exists icon_512_url text,
  add column if not exists icon_maskable_url text,
  add column if not exists logo_reverse_url text,
  add column if not exists background_color text;

create or replace function public.brand_for_host(p_host text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', name, 'short_name', short_name, 'logo_url', logo_url, 'logo_reverse_url', logo_reverse_url,
    'primary_color', primary_color, 'accent_color', accent_color, 'background_color', background_color,
    'favicon_url', favicon_url, 'apple_icon_url', apple_icon_url, 'icon_192_url', icon_192_url,
    'icon_512_url', icon_512_url, 'icon_maskable_url', icon_maskable_url)
    from white_labels where domain = lower(trim(p_host))
$$;

-- saving from Platform keeps the icon links unless the form sends new ones
create or replace function public.platform_save_white_label(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare w white_labels; ag uuid := (p->>'agency_tenant_id')::uuid; dom text := nullif(lower(trim(coalesce(p->>'domain', ''))), '');
  u text;
begin
  if not private.is_platform_owner() then raise exception 'Only the platform admin can change white labels'; end if;
  if not exists (select 1 from tenants where id = ag) then raise exception 'Pick the agency account'; end if;
  if dom is not null and dom !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Domain looks wrong, use something like app.example.com'; end if;
  foreach u in array array['favicon_url','apple_icon_url','icon_192_url','icon_512_url','icon_maskable_url','logo_reverse_url'] loop
    if coalesce(p->>u, '') <> '' and p->>u !~ '^https://' then raise exception 'Icon links need to start with https://'; end if;
  end loop;
  update tenants set is_agency = true where id = ag;
  insert into white_labels (agency_tenant_id, name, short_name, logo_url, primary_color, accent_color, domain, email_from_name, support_email,
    favicon_url, apple_icon_url, icon_192_url, icon_512_url, icon_maskable_url, logo_reverse_url, background_color)
  values (ag, trim(p->>'name'), nullif(trim(coalesce(p->>'short_name', '')), ''), nullif(trim(coalesce(p->>'logo_url', '')), ''),
          coalesce(nullif(p->>'primary_color', ''), '#1A2A52'), coalesce(nullif(p->>'accent_color', ''), '#C9A04A'), dom,
          nullif(trim(coalesce(p->>'email_from_name', '')), ''), nullif(trim(coalesce(p->>'support_email', '')), ''),
          nullif(trim(coalesce(p->>'favicon_url', '')), ''), nullif(trim(coalesce(p->>'apple_icon_url', '')), ''),
          nullif(trim(coalesce(p->>'icon_192_url', '')), ''), nullif(trim(coalesce(p->>'icon_512_url', '')), ''),
          nullif(trim(coalesce(p->>'icon_maskable_url', '')), ''), nullif(trim(coalesce(p->>'logo_reverse_url', '')), ''),
          nullif(trim(coalesce(p->>'background_color', '')), ''))
  on conflict (agency_tenant_id) do update set name = excluded.name, short_name = excluded.short_name, logo_url = excluded.logo_url,
    primary_color = excluded.primary_color, accent_color = excluded.accent_color, domain = excluded.domain,
    email_from_name = excluded.email_from_name, support_email = excluded.support_email,
    favicon_url = case when p ? 'favicon_url' then excluded.favicon_url else white_labels.favicon_url end,
    apple_icon_url = case when p ? 'apple_icon_url' then excluded.apple_icon_url else white_labels.apple_icon_url end,
    icon_192_url = case when p ? 'icon_192_url' then excluded.icon_192_url else white_labels.icon_192_url end,
    icon_512_url = case when p ? 'icon_512_url' then excluded.icon_512_url else white_labels.icon_512_url end,
    icon_maskable_url = case when p ? 'icon_maskable_url' then excluded.icon_maskable_url else white_labels.icon_maskable_url end,
    logo_reverse_url = case when p ? 'logo_reverse_url' then excluded.logo_reverse_url else white_labels.logo_reverse_url end,
    background_color = case when p ? 'background_color' then excluded.background_color else white_labels.background_color end,
    updated_at = now()
  returning * into w;
  return to_jsonb(w);
end $$;

-- Cognix CRM (added Nov 3): its brand kit files are in media/<tenant>/brand/
update public.white_labels w set name = 'Cognix CRM', short_name = 'Cognix', primary_color = '#031C3D', accent_color = '#F47700',
  background_color = '#FFFFFF', email_from_name = 'Cognix CRM',
  logo_url = b || 'cognix-logo.svg', logo_reverse_url = b || 'cognix-logo-reverse.svg', favicon_url = b || 'favicon-32.png',
  apple_icon_url = b || 'apple-touch-icon.png', icon_192_url = b || 'icon-192.png', icon_512_url = b || 'icon-512.png',
  icon_maskable_url = b || 'icon-maskable-512.png', updated_at = now()
from (select 'https://stfnpzqymjlxpainmgoo.supabase.co/storage/v1/object/public/media/22d9aac4-ce4f-42f5-8ad1-3bfa419c6076/brand/' b) x
where w.agency_tenant_id = '22d9aac4-ce4f-42f5-8ad1-3bfa419c6076';
