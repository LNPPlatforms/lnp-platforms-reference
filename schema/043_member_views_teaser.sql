-- 043: every business sees its listing's views for the last 30 days, even on a plan without stats (a teaser;
-- calls, directions and website clicks stay locked until the listing is upgraded).
do $$ declare d text := pg_get_functiondef('public.member_home()'::regprocedure); n text;
begin
  n := replace(d, $q$'messages', coalesce((t.features->>'messages')::boolean, false),$q$,
    $q$'views30', (select count(*) from directory_events where listing_id = l.id and kind = 'view' and at > now() - interval '30 days'),
      'messages', coalesce((t.features->>'messages')::boolean, false),$q$);
  if n = d then raise exception 'member_home did not match'; end if;
  execute n;
end $$;
