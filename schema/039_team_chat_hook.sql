-- 039: every saved team chat message tells the chat-email function right away (pg_net), so notifications go out
-- no matter how the message was sent. The call carries a random secret that only the database and the function know.
create extension if not exists pg_net;
alter table private.push_keys add column if not exists hook_secret text;
update private.push_keys set hook_secret = encode(gen_random_bytes(24), 'hex') where id = 1 and hook_secret is null;

create or replace function public.push_vapid() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('public_key', public_key, 'private_key', private_key, 'subject', subject, 'hook_secret', hook_secret) from private.push_keys where id = 1
$$;
revoke execute on function public.push_vapid() from public, anon, authenticated;
grant execute on function public.push_vapid() to service_role;

create or replace function private.team_message_hook() returns trigger
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return null; end if;
  perform net.http_post(
    url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/chat-email',
    body := jsonb_build_object('kind', 'team_hook', 'message_id', new.id, 'secret', s),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000);
  return null;
exception when others then return null;   -- a notification problem never blocks sending a message
end $$;
revoke execute on function private.team_message_hook() from public, anon, authenticated;
create or replace trigger team_message_hook after insert on public.team_messages for each row execute function private.team_message_hook();
