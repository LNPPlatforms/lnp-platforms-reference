-- 044: directory messages work as live chat. Business logins report when their portal is open (member_heartbeat), so
-- visitors see "online now"; the business sees whether the visitor is still on the page. Email stays the backup when
-- the other side has left (visitor away 45+ seconds, or nobody from the business online).
create or replace function public.member_heartbeat() returns void
language sql security definer set search_path = public, private as $$
  update app_users set last_seen_at = now() where id = auth.uid() and role = 'member'
$$;
revoke execute on function public.member_heartbeat() from public, anon;
grant execute on function public.member_heartbeat() to authenticated;

do $$ declare d text; n text;
begin
  d := pg_get_functiondef('public.directory_thread_fetch(uuid,text)'::regprocedure);
  n := replace(d, $q$'name', t.visitor_name, 'status', t.status,$q$,
    $q$'name', t.visitor_name, 'status', t.status,
    'business_online', exists (select 1 from directory_members dm join app_users u on u.id = dm.user_id
       where dm.listing_id = t.listing_id and dm.revoked_at is null and u.last_seen_at > now() - interval '2 minutes'),$q$);
  if n = d then raise exception 'directory_thread_fetch did not match'; end if;
  execute n;
  d := pg_get_functiondef('public.directory_thread_open(uuid)'::regprocedure);
  n := replace(d, $q$'can_reply', mine,$q$, $q$'can_reply', mine, 'visitor_here', coalesce(t.visitor_seen_at > now() - interval '45 seconds', false),$q$);
  if n = d then raise exception 'directory_thread_open did not match'; end if;
  execute n;
end $$;
