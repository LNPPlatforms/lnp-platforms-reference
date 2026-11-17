-- 051: assets on an organization (Oct 20, 2026).
-- Links and files that belong to an organization: proposal pages, websites, funnels, logos, documents, designs.
-- The organization page also shows its logo, its CRM proposals and its directory listings next to these
-- automatically. Removing one archives it; nothing is deleted.

create table if not exists public.company_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  company_id uuid not null references public.companies(id),
  kind text not null default 'link' check (kind in ('proposal', 'website', 'funnel', 'logo', 'document', 'design', 'link')),
  title text not null check (length(trim(title)) between 1 and 200),
  url text not null check (url ~* '^https://'),
  media_id uuid references public.media(id),
  note text,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.app_users(id)
);
create index if not exists company_assets_company on public.company_assets (company_id) where archived_at is null;
alter table public.company_assets enable row level security;
create policy "account manages its company assets" on public.company_assets for all to authenticated
  using (private.is_internal() and tenant_id = private.current_tenant())
  with check (private.is_internal() and tenant_id = private.current_tenant()
              and exists (select 1 from companies c where c.id = company_id and c.tenant_id = private.current_tenant()));
revoke all on public.company_assets from anon, authenticated;
grant select, insert, update on public.company_assets to authenticated;
create trigger audit_company_assets after insert or update on public.company_assets for each row execute function private.audit();
