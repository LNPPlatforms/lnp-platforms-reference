-- 040: pictures in team chat (photos, GIFs, stickers). Files live in a private bucket at <account>/<conversation>/<sender>/...
-- Only people who can see the conversation can upload to or open its folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-chat', 'team-chat', false, 8388608, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

create policy "team chat pictures upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-chat' and (storage.foldername(name))[1] = private.current_tenant()::text
    and (storage.foldername(name))[3] = auth.uid()::text
    and private.team_can_see(nullif((storage.foldername(name))[2], '')::uuid));
create policy "team chat pictures read" on storage.objects for select to authenticated
  using (bucket_id = 'team-chat' and private.team_can_see(nullif((storage.foldername(name))[2], '')::uuid));

alter table public.team_messages add column if not exists picture_path text;
-- a picture sent with no words is saved with the text "📷 Picture" (that's also what notifications say)
alter function public.team_send(uuid, text) rename to team_send_v1_retired;
revoke execute on function public.team_send_v1_retired(uuid, text) from public, anon, authenticated;

create or replace function public.team_send(p_room uuid, p_body text, p_picture text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare me uuid := auth.uid(); b text := trim(coalesce(p_body, '')); m team_messages%rowtype; t uuid; pic text := nullif(trim(p_picture), '');
begin
  if not private.team_can_see(p_room) then raise exception 'Conversation not found'; end if;
  select tenant_id into t from team_rooms where id = p_room;
  if pic is not null and (pic not like t::text || '/' || p_room::text || '/' || me::text || '/%' or pic like '%..%') then raise exception 'That picture didn''t upload right. Try again.'; end if;
  if b = '' and pic is null then raise exception 'Type a message first'; end if;
  if b = '' then b := '📷 Picture'; end if;
  if length(b) > 4000 then raise exception 'That message is too long'; end if;
  insert into team_messages (tenant_id, room_id, sender_id, body, picture_path) values (t, p_room, me, b, pic) returning * into m;
  update team_rooms set last_message_at = m.created_at where id = p_room;
  insert into team_room_members (room_id, user_id, added_by, last_read_at) values (p_room, me, me, m.created_at)
  on conflict (room_id, user_id) do update set last_read_at = excluded.last_read_at;
  return to_jsonb(m);
end $$;
revoke execute on function public.team_send(uuid, text, text) from public, anon;
grant execute on function public.team_send(uuid, text, text) to authenticated;
