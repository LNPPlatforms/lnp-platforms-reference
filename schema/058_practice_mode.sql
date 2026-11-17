-- 058: practice mode for the help overlay (Oct 26, 2026).
-- While someone runs a walkthrough, anything they create (organizations, people, to-dos, notes, deals, proposals) is
-- practice and is deleted when the walkthrough ends. Sends and payments never fire during practice (the app stops them).
-- A walkthrough left open (closed tab, dead battery) is cleaned up the next time that person opens the CRM.

create table if not exists private.practice_sessions (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  tenant_id uuid not null,
  started_at timestamptz not null default now()
);

create or replace function public.practice_start() returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  perform public.practice_end();
  insert into private.practice_sessions (user_id, tenant_id) values (auth.uid(), private.current_tenant());
  return jsonb_build_object('ok', true, 'started_at', now());
end $$;

create or replace function public.practice_status() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('open', exists (select 1 from private.practice_sessions where user_id = auth.uid()))
$$;

-- delete what this person made since their walkthrough started, in the account they practiced in
create or replace function public.practice_end() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare s private.practice_sessions; cos uuid[]; ppl uuid[]; props uuid[]; n int := 0;
begin
  select * into s from private.practice_sessions where user_id = auth.uid();
  if not found then return jsonb_build_object('ok', true, 'removed', 0); end if;
  delete from private.practice_sessions where user_id = auth.uid();
  cos := array(select id from companies where tenant_id = s.tenant_id and created_by = s.user_id and created_at >= s.started_at);
  ppl := array(select id from people where tenant_id = s.tenant_id and created_by = s.user_id and created_at >= s.started_at);
  props := array(select id from proposals where tenant_id = s.tenant_id and created_by = s.user_id and created_at >= s.started_at);
  delete from proposal_versions where proposal_id = any(props);
  delete from proposals where id = any(props);
  delete from tasks where tenant_id = s.tenant_id and created_by = s.user_id and created_at >= s.started_at;
  delete from activities where tenant_id = s.tenant_id and created_by = s.user_id and created_at >= s.started_at;
  delete from escalations where company_id = any(cos);
  delete from company_assets where company_id = any(cos);
  delete from proposal_versions where company_id = any(cos);
  delete from proposals where company_id = any(cos);
  delete from company_people where person_id = any(ppl) or company_id = any(cos);
  delete from people where id = any(ppl);
  get diagnostics n = row_count;
  delete from companies where id = any(cos);
  return jsonb_build_object('ok', true, 'removed', coalesce(cardinality(cos), 0) + n + coalesce(cardinality(props), 0));
end $$;

revoke execute on function public.practice_start(), public.practice_status(), public.practice_end() from public, anon;
grant execute on function public.practice_start(), public.practice_status(), public.practice_end() to authenticated;
