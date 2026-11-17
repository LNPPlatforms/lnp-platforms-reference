-- 103: the "What's new" banner. Release notes live in release/notes.json (published every Sunday at 2 AM Central by
-- the weekly release). Each person's newest release they've seen is kept here, so the banner shows once per person
-- across all their devices, and someone who missed a few weeks sees them together, newest first.
alter table public.app_users add column if not exists release_seen text;

create or replace function public.my_release_seen_set(p_id text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if p_id !~ '^\d{4}-\d{2}-\d{2}[a-z]*$' then raise exception 'Bad release id'; end if;
  update app_users set release_seen = p_id where id = auth.uid() and (release_seen is null or release_seen < p_id);
end $$;
revoke execute on function public.my_release_seen_set(text) from public, anon;
grant execute on function public.my_release_seen_set(text) to authenticated;
-- everyone already on the CRM sees the first release (Nov 13); people who join later start from the latest one
update public.app_users set release_seen = '2026-11-12' where release_seen is null;
