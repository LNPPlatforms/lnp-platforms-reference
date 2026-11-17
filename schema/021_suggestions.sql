-- 021: Suggestions. Anyone signed in (any account) can send a suggestion from the side tab on every screen.
-- Only Chris can read and manage them: no other admins, across every account. Kept forever (no deletes).
-- Screenshots go to a private bucket that only Chris can read (they can show client data).

create or replace function private.suggestions_owner() returns uuid
language sql immutable set search_path = pg_catalog as $$ select 'a4643b4e-012b-4b1a-9aac-ac35002048b2'::uuid $$;  -- chris@gelpstrategies.com
create or replace function private.is_suggestions_owner() returns boolean
language sql stable set search_path = pg_catalog, private as $$ select auth.uid() is not null and auth.uid() = private.suggestions_owner() $$;

create table if not exists public.suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  user_id uuid default auth.uid() references public.app_users(id),
  user_name text,
  user_email text,
  account_name text,
  body text not null check (length(trim(body)) > 0),
  view text,
  record_id text,
  page_title text,
  url text,
  device text,
  screen text,
  app_version text,
  screenshot_path text,
  status text not null default 'new' check (status in ('new','done','not_doing')),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists suggestions_status_idx on public.suggestions (status, created_at desc);

-- who sent it comes from the login, never from the browser
create or replace function private.stamp_suggestion() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare u app_users;
begin
  select * into u from app_users where id = auth.uid();
  if not found then raise exception 'Sign in to send a suggestion'; end if;
  new.user_id := u.id; new.user_name := u.full_name; new.user_email := u.email;
  new.tenant_id := private.current_tenant();
  new.account_name := (select name from tenants where id = new.tenant_id);
  new.status := 'new'; new.resolved_at := null; new.created_at := now();
  new.body := left(trim(new.body), 5000);
  return new;
end $$;
create trigger stamp_suggestion before insert on public.suggestions for each row execute function private.stamp_suggestion();

-- Chris can only change the status, nothing the sender wrote
create or replace function private.guard_suggestion() returns trigger
language plpgsql set search_path = public, private as $$
begin
  if (new.body, new.user_id, new.tenant_id, new.view, new.record_id, new.url, new.screenshot_path, new.created_at)
     is distinct from (old.body, old.user_id, old.tenant_id, old.view, old.record_id, old.url, old.screenshot_path, old.created_at) then
    raise exception 'Suggestions can only be marked done or not doing';
  end if;
  new.resolved_at := case when new.status = 'new' then null else coalesce(old.resolved_at, now()) end;
  return new;
end $$;
create trigger guard_suggestion before update on public.suggestions for each row execute function private.guard_suggestion();
create trigger audit_suggestions after insert or update or delete on public.suggestions for each row execute function private.audit();

alter table public.suggestions enable row level security;
create policy "anyone signed in can send" on public.suggestions for insert to authenticated with check (auth.uid() is not null);
create policy "only Chris reads suggestions" on public.suggestions for select to authenticated using (private.is_suggestions_owner());
create policy "only Chris updates suggestions" on public.suggestions for update to authenticated
  using (private.is_suggestions_owner()) with check (private.is_suggestions_owner());
grant select, insert, update on public.suggestions to authenticated;

-- private screenshot bucket: senders upload into their own folder, only Chris can read
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback', 'feedback', false, 8388608, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;
create policy "send suggestion screenshots" on storage.objects for insert to authenticated
  with check (bucket_id = 'feedback' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "only Chris reads suggestion screenshots" on storage.objects for select to authenticated
  using (bucket_id = 'feedback' and private.is_suggestions_owner());

revoke execute on function private.stamp_suggestion(), private.guard_suggestion() from public, anon, authenticated;
grant execute on function private.is_suggestions_owner(), private.suggestions_owner() to authenticated;
