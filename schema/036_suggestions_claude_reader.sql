-- 036: suggestions are readable by Chris and by Claude's own login (Claude Vickrey), and nobody else.
create or replace function private.is_suggestions_owner() returns boolean
language sql stable set search_path = pg_catalog, private as $$
  select auth.uid() is not null and auth.uid() in (private.suggestions_owner(), '365e73a5-434c-4719-9b68-23ea43de7a37'::uuid)
$$;
