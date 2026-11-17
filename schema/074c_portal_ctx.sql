-- 074c: client portal, part 3. Who is asking and what they may see.
-- Every portal function takes p_ctx: the portal_users id of the signed-in client, or (for the CRM's "Preview what
-- they see") an organization id, which only works for the account's own team and only ever reads.

-- the portal settings: sections on or off (all on unless turned off) and the files and photos default
create or replace function private.portal_settings(t uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'sections', jsonb_build_object(
      'schedule', coalesce((s->'sections'->>'schedule')::boolean, true), 'estimates', coalesce((s->'sections'->>'estimates')::boolean, true),
      'invoices', coalesce((s->'sections'->>'invoices')::boolean, true), 'files', coalesce((s->'sections'->>'files')::boolean, true),
      'messages', coalesce((s->'sections'->>'messages')::boolean, true), 'approvals', coalesce((s->'sections'->>'approvals')::boolean, true)),
    'files_default', case when s->>'files_default' = 'shared' then 'shared' else 'hidden' end,
    'welcome', nullif(trim(coalesce(s->>'welcome', '')), ''))
  from (select coalesce((select settings->'portal' from account_settings where tenant_id = t), '{}'::jsonb) s) x
$$;

-- the areas and the most each allows: schedule and files are view only
create or replace function private.portal_areas() returns jsonb language sql immutable as $$
  select '{"schedule":1,"estimates":2,"invoices":2,"files":1,"messages":2,"approvals":2}'::jsonb
$$;

-- an organization and every location under it (any depth)
create or replace function private.portal_orgs(p_company uuid) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  with recursive t(id, d) as (select id, 0 from companies where id = p_company
    union all select c.id, t.d + 1 from companies c join t on c.parent_company_id = t.id where c.archived_at is null and t.d < 20)
  select coalesce(array_agg(id), '{}') from t
$$;

-- can this CRM team member manage (and preview) this organization's portal?
create or replace function private.portal_staff_ok(p_company uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('portal') and (private.is_admin() or private.can('contacts', 3))
     and exists (select 1 from companies c where c.id = p_company and c.tenant_id = private.current_tenant() and private.div_ok(c.divisions))
$$;

do $$ begin
  create type private.portal_ctx as (tenant_id uuid, company_id uuid, portal_user uuid, is_admin boolean, levels jsonb, preview boolean, orgs uuid[], settings jsonb);
exception when duplicate_object then null; end $$;

create or replace function private.portal_ctx(p_ctx uuid) returns private.portal_ctx
language plpgsql stable security definer set search_path = public, private as $$
declare pu private.portal_users; c companies; out private.portal_ctx; st jsonb; lv jsonb := '{}'::jsonb; k text; mx int;
begin
  if auth.uid() is null or p_ctx is null then raise exception 'Sign in first'; end if;
  select * into pu from private.portal_users where id = p_ctx and user_id = auth.uid() and removed_at is null;
  if found then
    select * into c from companies where id = pu.company_id and tenant_id = pu.tenant_id and archived_at is null;
    if not found or not private.feature_on_for(pu.tenant_id, 'portal') then raise exception 'This portal is not open right now'; end if;
    out.portal_user := pu.id; out.is_admin := pu.is_admin; out.preview := false;
  elsif private.portal_staff_ok(p_ctx) then
    select * into c from companies where id = p_ctx;
    out.portal_user := null; out.is_admin := false; out.preview := true;
  else
    raise exception 'You don''t have access to this portal';
  end if;
  out.tenant_id := c.tenant_id; out.company_id := c.id; out.orgs := private.portal_orgs(c.id);
  st := private.portal_settings(c.tenant_id); out.settings := st;
  for k, mx in select key, value::int from jsonb_each_text(private.portal_areas()) loop
    lv := lv || jsonb_build_object(k, case
      when not coalesce((st->'sections'->>k)::boolean, true) then 0
      when out.preview then 1
      when pu.is_admin then mx
      else least(mx, greatest(0, coalesce((pu.perms->>k)::int, mx))) end);
  end loop;
  out.levels := lv;
  return out;
end $$;

create or replace function private.portal_lvl(x private.portal_ctx, area text) returns int language sql immutable as $$
  select coalesce((x.levels->>area)::int, 0)
$$;
-- for actions: a real client with "act" on the area (never the CRM preview)
create or replace function private.portal_need(x private.portal_ctx, area text, lvl int) returns void language plpgsql immutable as $$
begin
  if x.preview and lvl > 1 then raise exception 'This is a preview. Clients do this from their own login.'; end if;
  if private.portal_lvl(x, area) < lvl then raise exception 'Your portal login can''t do that'; end if;
end $$;

-- files and photos: shared or hidden, falling back to the account's default
create or replace function private.portal_shared(p_share text, x private.portal_ctx) returns boolean language sql immutable as $$
  select coalesce(p_share = 'shared', (x.settings->>'files_default') = 'shared')
$$;

revoke execute on function private.portal_settings(uuid), private.portal_orgs(uuid), private.portal_staff_ok(uuid), private.portal_ctx(uuid),
  private.portal_lvl(private.portal_ctx, text), private.portal_need(private.portal_ctx, text, int), private.portal_shared(text, private.portal_ctx),
  private.portal_areas() from public, anon, authenticated;
