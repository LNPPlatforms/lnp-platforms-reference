-- 118: fair use matches Vonage, 3,000 minutes a month per line, pooled per company (was 1,500). Nov 16, 2026.
do $$
declare d text := pg_get_functiondef('private.phone_usage_of(uuid,date)'::regprocedure);
begin
  if position('''limit'', 3000 *' in d) > 0 then return; end if;
  if position('''limit'', 1500 *' in d) = 0 then raise exception 'phone_usage_of did not match'; end if;
  execute replace(d, '''limit'', 1500 *', '''limit'', 3000 *');
end $$;
