-- 045b: a listing chat is marked by the listing it came from (chat_threads.listing_id) and keeps source 'other',
-- so the existing source list doesn't need to change.
alter table public.chat_threads add column if not exists listing_id uuid references public.directory_listings(id);
do $$
declare d text; b text;
begin
  d := pg_get_functiondef('public.chat_start(text,text,text,text,text,text,text)'::regprocedure); b := d;
  d := replace(d, $q$case when p_source in ('website','proposal','invoice','directory') then p_source else 'other' end$q$, $q$case when p_source in ('website','proposal','invoice') then p_source else 'other' end$q$);
  d := replace(d, $q$insert into chat_threads (tenant_id, visitor_key,$q$, $q$insert into chat_threads (listing_id, tenant_id, visitor_key,$q$);
  d := replace(d, $q$values (t.id, key,$q$, $q$values (dl.id, t.id, key,$q$);
  if position('(listing_id, tenant_id' in d) = 0 or position('(dl.id, t.id, key' in d) = 0 or position('''directory'') then' in d) > 0 then raise exception 'chat_start: no match'; end if;
  execute d;
end $$;
