-- 086b (Nov 9, 2026): the Platform screen saves a white label's sending domain. Applied Nov 9.
create or replace function public.platform_save_white_label(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare w white_labels; ag uuid := (p->>'agency_tenant_id')::uuid; dom text := nullif(lower(trim(coalesce(p->>'domain', ''))), '');
  sd text := nullif(lower(trim(coalesce(p->>'send_domain', ''))), ''); u text;
begin
  if not private.is_platform_owner() then raise exception 'Only the platform admin can change white labels'; end if;
  if not exists (select 1 from tenants where id = ag) then raise exception 'Pick the agency account'; end if;
  if dom is not null and dom !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Domain looks wrong, use something like app.example.com'; end if;
  if sd is not null and sd !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then raise exception 'Sending domain looks wrong, use something like send.example.com'; end if;
  foreach u in array array['favicon_url','apple_icon_url','icon_192_url','icon_512_url','icon_maskable_url','logo_reverse_url'] loop
    if coalesce(p->>u, '') <> '' and p->>u !~ '^https://' then raise exception 'Icon links need to start with https://'; end if;
  end loop;
  update tenants set is_agency = true where id = ag;
  insert into white_labels (agency_tenant_id, name, short_name, logo_url, primary_color, accent_color, domain, email_from_name, support_email,
    favicon_url, apple_icon_url, icon_192_url, icon_512_url, icon_maskable_url, logo_reverse_url, background_color, send_domain)
  values (ag, trim(p->>'name'), nullif(trim(coalesce(p->>'short_name', '')), ''), nullif(trim(coalesce(p->>'logo_url', '')), ''),
          coalesce(nullif(p->>'primary_color', ''), '#1A2A52'), coalesce(nullif(p->>'accent_color', ''), '#C9A04A'), dom,
          nullif(trim(coalesce(p->>'email_from_name', '')), ''), nullif(trim(coalesce(p->>'support_email', '')), ''),
          nullif(trim(coalesce(p->>'favicon_url', '')), ''), nullif(trim(coalesce(p->>'apple_icon_url', '')), ''),
          nullif(trim(coalesce(p->>'icon_192_url', '')), ''), nullif(trim(coalesce(p->>'icon_512_url', '')), ''),
          nullif(trim(coalesce(p->>'icon_maskable_url', '')), ''), nullif(trim(coalesce(p->>'logo_reverse_url', '')), ''),
          nullif(trim(coalesce(p->>'background_color', '')), ''), sd)
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
    send_domain = case when p ? 'send_domain' then excluded.send_domain else white_labels.send_domain end,
    updated_at = now()
  returning * into w;
  return to_jsonb(w);
end $$;
