-- 050: recall a team chat message within 30 seconds (Oct 20, 2026).
-- The sender can pull a message back for 30 seconds after sending. Everyone else then sees "Message recalled"
-- instead of the text or picture. Nothing is erased: the original text and picture move to a private table only
-- the server can read. The recall also re-sends the chat notification, so a phone that already showed the
-- message gets it replaced by "Message recalled" (same conversation tag). An email that already went out can't be
-- pulled back; email only goes to people who are away with no phone notifications.

alter table public.team_messages add column if not exists recalled_at timestamptz;

create table if not exists private.team_message_recalls (
  message_id uuid primary key references public.team_messages(id),
  body text not null,
  picture_path text,
  recalled_by uuid references public.app_users(id),
  recalled_at timestamptz not null default now()
);
alter table private.team_message_recalls enable row level security;
revoke all on private.team_message_recalls from public, anon, authenticated;

create or replace function public.team_recall(p_message uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare m team_messages;
begin
  select * into m from team_messages where id = p_message for update;
  if not found or m.sender_id <> auth.uid() or not private.team_can_see(m.room_id) then raise exception 'Message not found'; end if;
  if m.recalled_at is not null then return; end if;
  if m.created_at < now() - interval '30 seconds' then raise exception 'Too late to recall. Messages can be recalled for 30 seconds after sending.'; end if;
  insert into private.team_message_recalls (message_id, body, picture_path, recalled_by) values (m.id, m.body, m.picture_path, auth.uid())
  on conflict (message_id) do nothing;
  update team_messages set body = 'Message recalled', picture_path = null, recalled_at = now() where id = m.id;
end $$;
revoke execute on function public.team_recall(uuid) from public, anon;
grant execute on function public.team_recall(uuid) to authenticated;

-- the recall re-runs the notification so a phone notification is replaced by "Message recalled"
create or replace trigger team_message_recall_hook after update of recalled_at on public.team_messages
  for each row when (old.recalled_at is null and new.recalled_at is not null) execute function private.team_message_hook();

-- recalled messages don't count as unread
do $$
declare d text; b text; fn text;
begin
  foreach fn in array array['public.team_rooms_list()', 'public.team_unread()'] loop
    d := pg_get_functiondef(fn::regprocedure); b := d;
    d := replace(d, 'tm.room_id = r.id and tm.sender_id <> me', 'tm.room_id = r.id and tm.sender_id <> me and tm.recalled_at is null');
    if d <> b then execute d; end if;
  end loop;
end $$;
