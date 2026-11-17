-- 114: chat across accounts, the rest of it (Nov 16, 2026). Internal chat already follows you (092). This adds the
-- customer side: customer chats waiting in the other accounts you work in, so the chat box can show and notify them.
-- Reading them still means switching to that account's Inbox (customer conversations stay in their account).
create or replace function public.other_accounts_waiting() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('tenant_id', x.tenant_id, 'account', private.chat_account_label(x.tenant_id), 'waiting', x.n, 'latest', x.latest)
           order by x.latest desc), '[]'::jsonb)
    from (select ct.tenant_id, count(*)::int n, max(ct.last_message_at) latest
            from chat_threads ct
           where ct.tenant_id <> private.current_tenant() and ct.unread_staff and ct.status = 'open'
             and private.on_team(auth.uid(), ct.tenant_id)
           group by ct.tenant_id) x
   where private.is_internal()
$$;
revoke execute on function public.other_accounts_waiting() from public, anon;
grant execute on function public.other_accounts_waiting() to authenticated;
