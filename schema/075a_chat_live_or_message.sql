-- 075a: chat widgets let the visitor pick live chat or leave a message (Oct 30, 2026).
-- Each widget decides what visitors can pick: both, live chat only, or message only. A message is a normal conversation in the
-- Inbox (same thread, same replies, team emailed right away), it just never gets the "nobody picked up" blast.
-- A live chat started while nobody is online is saved as a message too.

alter table public.chat_widgets add column if not exists offer text not null default 'both' check (offer in ('both', 'live', 'message'));
alter table public.chat_widgets add column if not exists message_thanks text not null
  default 'Thanks! We got your message and we''ll get back to you by email soon.';
alter table public.chat_threads add column if not exists chat_mode text not null default 'live' check (chat_mode in ('live', 'message'));

-- widget: what this widget offers (no widget set up: both)
create or replace function public.chat_widget_config(p_tenant text, p_widget text default null) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce((
    select jsonb_build_object('offer', w.offer, 'message_thanks', w.message_thanks, 'offline_text', w.offline_text)
      from chat_widgets w join tenants t on t.id = w.tenant_id
     where t.slug = lower(trim(p_tenant)) and w.archived_at is null
       and (case when coalesce(trim(p_widget), '') <> '' then w.key = lower(trim(p_widget)) else w.is_default end)
     order by w.is_default desc limit 1),
    jsonb_build_object('offer', 'both', 'message_thanks', 'Thanks! We got your message and we''ll get back to you by email soon.'))
$$;
revoke execute on function public.chat_widget_config(text, text) from public;
grant execute on function public.chat_widget_config(text, text) to anon, authenticated;

-- widget: mark a new conversation as a message (only before anyone on the team has answered)
create or replace function public.chat_set_mode(p_thread uuid, p_key text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if p_mode not in ('live', 'message') then raise exception 'Pick live chat or message'; end if;
  update chat_threads set chat_mode = p_mode
   where id = p_thread and visitor_key = p_key and picked_up_at is null
     and not exists (select 1 from chat_messages m where m.thread_id = p_thread and m.sender = 'staff');
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.chat_set_mode(uuid, text, text) from public;
grant execute on function public.chat_set_mode(uuid, text, text) to anon, authenticated;

-- the blast skips messages (same as 067 otherwise)
create or replace function private.chat_tick() returns int
language plpgsql security definer set search_path = public, private as $$
declare th chat_threads; w chat_widgets; who uuid[]; x uuid; n int := 0;
begin
  for th in select * from chat_threads where status = 'open' and picked_up_at is null and blast_at is null and kind is distinct from 'team'
             and chat_mode = 'live' and assigned_at is not null and created_at > now() - interval '1 day' for update skip locked loop
    select * into w from chat_widgets where id = th.widget_id;
    if th.assigned_at > now() - make_interval(secs => coalesce(w.wait_seconds, 120)) then continue; end if;
    who := private.blast_people(th, w);
    foreach x in array who loop
      insert into notifications (user_id, kind, title, body, link) values (x, 'chat', 'Chat waiting: ' || coalesce(th.visitor_name, 'visitor') || ' needs someone',
        'Nobody has picked this up yet. First to reply takes it.', '#inbox/' || th.id);
    end loop;
    update chat_threads set blast_at = now() where id = th.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function private.chat_tick() from public, anon, authenticated;
