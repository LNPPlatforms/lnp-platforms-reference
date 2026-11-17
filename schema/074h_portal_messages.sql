-- 074h: client portal, part 8. Messages with the team. One conversation per organization in the CRM Inbox
-- (source_ref 'portal'); the team answers with the normal Inbox reply. Internal system lines never show.

create or replace function private.portal_thread(x private.portal_ctx, p_make boolean) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare th uuid; wl jsonb; c companies;
begin
  select id into th from chat_threads where portal_company_id = x.company_id and tenant_id = x.tenant_id;
  if th is not null or not p_make then return th; end if;
  select * into c from companies where id = x.company_id;
  wl := private.brand_of(x.tenant_id);
  insert into chat_threads (tenant_id, visitor_key, visitor_name, company_id, source, source_ref, page_url, portal_company_id, divisions, visitor_seen_at)
  values (x.tenant_id, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), c.name, c.id, 'other', 'portal',
          'https://' || coalesce(nullif(wl->>'domain', ''), 'app.gelpstrategies.com') || '/portal/', c.id, coalesce(c.divisions, '{}'), now())
  on conflict (portal_company_id) where portal_company_id is not null do nothing
  returning id into th;
  if th is null then select id into th from chat_threads where portal_company_id = x.company_id; end if;
  return th;
end $$;
revoke execute on function private.portal_thread(private.portal_ctx, boolean) from public, anon, authenticated;

create or replace function public.portal_messages(p_ctx uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); th uuid;
begin
  perform private.portal_need(x, 'messages', 1);
  th := private.portal_thread(x, false);
  if th is not null and not x.preview then update chat_threads set visitor_seen_at = now() where id = th; end if;
  return jsonb_build_object('can_send', private.portal_lvl(x, 'messages') >= 2 and not x.preview,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'at', m.created_at,
        'from', case when m.sender = 'staff' then 'team' when m.portal_user_id = x.portal_user then 'me' else 'client' end,
        'name', case when m.sender = 'staff' then split_part(coalesce(u.full_name, ''), ' ', 1) else coalesce(nullif(trim(pu.full_name), ''), split_part(pu.email, '@', 1)) end)
        order by m.created_at)
      from chat_messages m left join app_users u on u.id = m.staff_id left join private.portal_users pu on pu.id = m.portal_user_id
     where th is not null and m.thread_id = th and m.sender in ('staff', 'visitor')), '[]'::jsonb));
end $$;

create or replace function public.portal_send(p_ctx uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); th chat_threads; tid uuid; pu private.portal_users; fresh boolean;
begin
  perform private.portal_need(x, 'messages', 2);
  if length(coalesce(trim(p_body), '')) < 1 then raise exception 'Type a message'; end if;
  if length(p_body) > 4000 then raise exception 'That message is too long'; end if;
  select * into pu from private.portal_users where id = x.portal_user;
  if (select count(*) from chat_messages where portal_user_id = pu.id and created_at > now() - interval '1 minute') >= 10
    then raise exception 'Slow down a little and try again in a minute.'; end if;
  fresh := private.portal_thread(x, false) is null;
  tid := private.portal_thread(x, true);
  insert into chat_messages (tenant_id, thread_id, sender, body, portal_user_id) values (x.tenant_id, tid, 'visitor', trim(p_body), pu.id);
  update chat_threads set last_message_at = now(), unread_staff = true, status = 'open', visitor_seen_at = now(),
    visitor_name = coalesce(nullif(trim(pu.full_name), ''), pu.email) || ' (' || (select name from companies where id = x.company_id) || ')', visitor_email = pu.email
   where id = tid returning * into th;
  if not fresh and th.assigned_to is not null then
    insert into notifications (user_id, kind, title, body, link) values (th.assigned_to, 'chat', 'Portal message from ' || th.visitor_name, left(trim(p_body), 140), '#inbox/' || th.id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.portal_messages(uuid), public.portal_send(uuid, text) from public, anon;
grant execute on function public.portal_messages(uuid), public.portal_send(uuid, text) to authenticated;
