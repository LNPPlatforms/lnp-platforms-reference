-- 113: brand kit colors in pickers, and off-brand flags (Nov 16, 2026).
-- Color pickers offer the account's own brand kit colors first; any other color is still allowed. When something is
-- saved as finished (a calendar, a directory page; drafts and clicking around don't count) with a color or font that
-- isn't in the brand kit, admins get one flag in Review for that item. Saving it again on-brand clears the flag.
-- No brand kit colors (or fonts): no flags for that part.
create table if not exists public.brand_flags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),     -- calendar, directory, ...
  ref text not null check (length(ref) <= 120),            -- the item's id
  name text check (name is null or length(name) <= 200),
  off jsonb not null default '{}'::jsonb,                  -- {colors: ["#ff0000"], fonts: ["Comic Sans"]}
  flagged_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'ok', 'resolved')),
  resolved_by uuid,
  resolved_at timestamptz
);
create unique index if not exists brand_flags_open on public.brand_flags (tenant_id, kind, ref) where status = 'open';
alter table public.brand_flags enable row level security;
create policy "admins see brand flags" on public.brand_flags for select using (tenant_id = private.current_tenant() and private.is_admin());
revoke all on public.brand_flags from anon, authenticated;
grant select on public.brand_flags to authenticated;

-- check what was just saved as finished against the brand kit; returns {off: {colors, fonts}}
create or replace function public.brand_check(p_kind text, p_ref text, p_name text, p_colors text[] default '{}', p_fonts text[] default '{}') returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); kc text[]; kf text[]; oc text[]; ofn text[]; o jsonb;
begin
  if auth.uid() is null or t is null or not private.is_internal() then return '{}'::jsonb; end if;
  select array(select lower(trim(x->>'hex')) from jsonb_array_elements(colors) x where coalesce(x->>'hex', '') <> ''),
         array(select lower(trim(x->>'family')) from jsonb_array_elements(fonts) x where coalesce(x->>'family', '') <> '')
    into kc, kf from brand_kits where tenant_id = t;
  oc := case when cardinality(coalesce(kc, '{}')) > 0 then array(select distinct lower(trim(c)) from unnest(coalesce(p_colors, '{}')) c
          where coalesce(trim(c), '') <> '' and not lower(trim(c)) = any (kc)) else '{}' end;
  ofn := case when cardinality(coalesce(kf, '{}')) > 0 then array(select distinct trim(f) from unnest(coalesce(p_fonts, '{}')) f
          where coalesce(trim(f), '') <> '' and not lower(trim(f)) = any (kf)) else '{}' end;
  if cardinality(oc) = 0 and cardinality(ofn) = 0 then
    update brand_flags set status = 'resolved', resolved_at = now(), resolved_by = auth.uid() where tenant_id = t and kind = p_kind and ref = p_ref and status = 'open';
    return jsonb_build_object('off', '{}'::jsonb);
  end if;
  o := jsonb_build_object('colors', to_jsonb(oc), 'fonts', to_jsonb(ofn));
  update brand_flags set off = o, name = left(p_name, 200), flagged_by = auth.uid(), created_at = now() where tenant_id = t and kind = p_kind and ref = p_ref and status = 'open';
  if not found then insert into brand_flags (tenant_id, kind, ref, name, off) values (t, left(p_kind, 40), left(p_ref, 120), left(p_name, 200), o); end if;
  return jsonb_build_object('off', o);
end $$;

-- an admin says it's fine (stays fine until it's saved off-brand again)
create or replace function public.brand_flag_ok(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  update brand_flags set status = 'ok', resolved_at = now(), resolved_by = auth.uid() where id = p_id and tenant_id = private.current_tenant() and status = 'open';
end $$;
revoke execute on function public.brand_check(text, text, text, text[], text[]), public.brand_flag_ok(uuid) from public, anon;
grant execute on function public.brand_check(text, text, text, text[], text[]), public.brand_flag_ok(uuid) to authenticated;
