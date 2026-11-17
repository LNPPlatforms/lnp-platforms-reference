-- 050b: the screen shows 30 seconds; the server allows 35 so a click at 29 seconds still lands
do $$ declare d text; begin
  d := replace(pg_get_functiondef('public.team_recall(uuid)'::regprocedure), $q$interval '30 seconds'$q$, $q$interval '35 seconds'$q$);
  execute d;
end $$;
