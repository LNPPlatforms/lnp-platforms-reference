-- 117: phone system on Telnyx (Nov 16, 2026). Feature switch "phone", off until an account turns it on.
-- Lines: a number bought for an account, ringing one person (direct) or several at once (group, like the main line).
-- Calls ring people in the CRM in their browser (Telnyx WebRTC); nobody answers in time = voicemail.
-- Every call logs on the timeline of whoever owns the other number (a person's cell → that person, an org's main
-- number → the org); unknown numbers wait in the phone log until someone files them.
-- Usage: minutes pooled per account, 1,500 a month per line; admins and the billing contact hear at 90, 95 and 100%.
-- The edge functions phone (signed in) and phone-hook (Telnyx events) do the talking to Telnyx; this file keeps state.

-- ---------- feature switch: off by default ----------
do $$
declare d text; f text;
begin
  foreach f in array array['private.feature_on(text)', 'private.feature_on_for(uuid,text)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('''routes'', ''phone'')' in d) = 0 then
      if position('''calendars'', ''routes'')' in d) = 0 then raise exception 'feature list did not match in %', f; end if;
      execute replace(d, '''calendars'', ''routes'')', '''calendars'', ''routes'', ''phone'')');
    end if;
  end loop;
end $$;

-- ---------- platform setup (one Telnyx account for the whole CRM) ----------
create table if not exists private.phone_cfg (
  id int primary key default 1 check (id = 1),
  voice_profile_id text, cc_app_id text, cred_conn_id text,
  hook_key text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  updated_at timestamptz not null default now()
);
insert into private.phone_cfg (id) values (1) on conflict do nothing;

-- each person's browser phone login (one Telnyx credential per person, used in every account they work in)
create table if not exists private.phone_creds (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  cred_id text not null, sip_username text not null unique,
  created_at timestamptz not null default now()
);

-- ---------- lines ----------
create table if not exists public.phone_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  kind text not null default 'group' check (kind in ('direct', 'group')),
  number text not null check (number ~ '^\+1[2-9]\d{9}$'),
  members uuid[] not null default '{}',
  ring_secs int not null default 25 check (ring_secs between 10 and 60),
  record boolean not null default false,
  voicemail boolean not null default true,
  greeting text check (greeting is null or length(greeting) <= 500),
  order_id text,
  active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index if not exists phone_lines_number_live on public.phone_lines (number) where active;
create index if not exists phone_lines_tenant on public.phone_lines (tenant_id) where active;
alter table public.phone_lines enable row level security;
drop policy if exists "see lines" on public.phone_lines;
create policy "see lines" on public.phone_lines for select using (tenant_id = private.current_tenant() and private.is_internal() and private.feature_on('phone'));
revoke all on public.phone_lines from anon, authenticated;
grant select on public.phone_lines to authenticated;

-- ---------- calls ----------
create table if not exists public.phone_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  line_id uuid references public.phone_lines(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  ccid text unique,
  from_number text, to_number text,
  other_number text,                       -- the outside party (in: who called; out: who we called)
  user_id uuid references public.app_users(id) on delete set null,   -- who answered or placed it
  person_id uuid references public.people(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  status text not null default 'ringing' check (status in ('ringing', 'answered', 'missed', 'voicemail', 'done', 'failed')),
  legs jsonb not null default '{}'::jsonb, -- ring group legs: {ccid: {"u": user, "s": ringing|answered|ended}}
  started_at timestamptz not null default now(),
  answered_at timestamptz, ended_at timestamptz,
  seconds int not null default 0,
  recording_path text, voicemail_path text,
  notes text check (notes is null or length(notes) <= 4000),
  event_id uuid,
  filed_by uuid references public.app_users(id) on delete set null, filed_at timestamptz,
  dismissed_at timestamptz
);
create index if not exists phone_calls_tenant on public.phone_calls (tenant_id, started_at desc);
create index if not exists phone_calls_person on public.phone_calls (person_id, started_at desc);
create index if not exists phone_calls_company on public.phone_calls (company_id, started_at desc);
create index if not exists phone_calls_unfiled on public.phone_calls (tenant_id, started_at desc) where person_id is null and company_id is null and dismissed_at is null;
alter table public.phone_calls enable row level security;
drop policy if exists "see calls" on public.phone_calls;
create policy "see calls" on public.phone_calls for select using (tenant_id = private.current_tenant() and private.is_internal() and private.feature_on('phone')
  and (user_id = auth.uid() or private.is_admin() or private.can('contacts', 1)));
revoke all on public.phone_calls from anon, authenticated;
grant select on public.phone_calls to authenticated;

-- alerts already sent this month (90, 95, 100)
create table if not exists private.phone_alerts (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month date not null, level int not null,
  sent_at timestamptz not null default now(),
  minutes int, lim int,
  cleared_at timestamptz, cleared_by uuid,
  primary key (tenant_id, month, level)
);

-- recordings and voicemails: private bucket, one folder per account
insert into storage.buckets (id, name, public) values ('phone', 'phone', false) on conflict (id) do nothing;
drop policy if exists "phone recordings read" on storage.objects;
create policy "phone recordings read" on storage.objects for select to authenticated
  using (bucket_id = 'phone' and (storage.foldername(name))[1] = private.current_tenant()::text and private.is_internal() and private.feature_on('phone'));

-- ---------- helpers ----------
create or replace function private.phone_digits(p text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '')
$$;
create or replace function private.phone_e164(p text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) = 10 then '+1' || regexp_replace(p, '\D', '', 'g')
              when regexp_replace(coalesce(p, ''), '\D', '', 'g') ~ '^1\d{10}$' then '+' || regexp_replace(p, '\D', '', 'g') end
$$;

-- who owns a number in this account: a person's own cell → that person; a work phone → the person at that org;
-- an org's main number → the org
create or replace function private.phone_match(p_tenant uuid, p_number text) returns table (person_id uuid, company_id uuid)
language plpgsql stable security definer set search_path = public, private as $$
declare d text := private.phone_digits(p_number); r record;
begin
  if d is null or length(d) < 10 then return; end if;
  select p.id into r from people p where p.tenant_id = p_tenant and coalesce(p.archive_status, 'active') <> 'archived'
     and private.phone_digits(p.personal_cell) = d order by p.updated_at desc nulls last limit 1;
  if found then person_id := r.id; company_id := null; return next; return; end if;
  select cp.person_id pid, cp.company_id cid into r from company_people cp join people p on p.id = cp.person_id
   where cp.tenant_id = p_tenant and cp.active and private.phone_digits(cp.work_phone) = d limit 1;
  if found then person_id := r.pid; company_id := r.cid; return next; return; end if;
  select c.id into r from companies c where c.tenant_id = p_tenant and coalesce(c.archive_status, 'active') <> 'archived'
     and private.phone_digits(c.main_phone) = d order by c.updated_at desc nulls last limit 1;
  if found then person_id := null; company_id := r.id; return next; end if;
end $$;


create or replace function private.phone_fmt(p text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when p ~ '^\+1\d{10}$' then '(' || substr(p, 3, 3) || ') ' || substr(p, 6, 3) || '-' || substr(p, 9) else coalesce(p, 'Unknown') end
$$;

-- the timeline entry for a finished call (or after it's filed)
create or replace function private.phone_emit(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; l phone_lines; t text; who text;
begin
  select * into c from phone_calls where id = p_id;
  if not found or c.ended_at is null or (c.person_id is null and c.company_id is null) then return; end if;
  select * into l from phone_lines where id = c.line_id;
  who := (select full_name from app_users where id = c.user_id);
  t := case when c.direction = 'out' then 'Call to ' || private.phone_fmt(c.other_number) || case when c.status = 'done' then '' else ', no answer' end
            when c.status = 'voicemail' then 'Voicemail from ' || private.phone_fmt(c.other_number)
            when c.status = 'missed' then 'Missed call from ' || private.phone_fmt(c.other_number)
            else 'Call from ' || private.phone_fmt(c.other_number) end;
  if c.event_id is not null then
    update contact_events set person_id = c.person_id, company_id = c.company_id where id = c.event_id;
    return;
  end if;
  insert into contact_events (tenant_id, person_id, company_id, kind, title, data, actor)
  values (c.tenant_id, c.person_id, c.company_id, 'call', left(t, 300),
          jsonb_build_object('call_id', c.id, 'direction', c.direction, 'line', coalesce(l.name, 'Phone'), 'seconds', c.seconds, 'status', c.status,
                             'user', who, 'recorded', c.recording_path is not null, 'voicemail', c.voicemail_path is not null),
          c.user_id)
  returning id into c.event_id;
  update phone_calls set event_id = c.event_id where id = p_id;
end $$;

-- usage this month, and the 90 / 95 / 100% alerts
create or replace function private.phone_usage_of(p_tenant uuid, p_month date default date_trunc('month', now())::date) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'month', p_month,
    'lines', (select count(*) from phone_lines where tenant_id = p_tenant and active),
    'limit', 3000 * (select count(*) from phone_lines where tenant_id = p_tenant and active),
    'minutes', coalesce((select sum(ceil(seconds / 60.0)) from phone_calls where tenant_id = p_tenant and started_at >= p_month and started_at < p_month + interval '1 month'), 0),
    'calls_in', (select count(*) from phone_calls where tenant_id = p_tenant and direction = 'in' and started_at >= p_month and started_at < p_month + interval '1 month'),
    'calls_out', (select count(*) from phone_calls where tenant_id = p_tenant and direction = 'out' and started_at >= p_month and started_at < p_month + interval '1 month'),
    'missed', (select count(*) from phone_calls where tenant_id = p_tenant and status in ('missed', 'voicemail') and started_at >= p_month and started_at < p_month + interval '1 month'))
$$;

create or replace function private.phone_usage_check(p_tenant uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare u jsonb := private.phone_usage_of(p_tenant); pct numeric; lvl int; who uuid[]; m date := date_trunc('month', now())::date;
begin
  if coalesce((u->>'limit')::int, 0) = 0 then return; end if;
  pct := 100.0 * (u->>'minutes')::numeric / (u->>'limit')::numeric;
  who := array(select id from app_users where tenant_id = p_tenant and is_admin and active and forward_to is null
               union select billing_contact from account_plans where tenant_id = p_tenant and billing_contact is not null);
  foreach lvl in array array[90, 95, 100] loop
    continue when pct < lvl;
    insert into private.phone_alerts (tenant_id, month, level, minutes, lim) values (p_tenant, m, lvl, (u->>'minutes')::int, (u->>'limit')::int) on conflict do nothing;
    continue when not found;
    -- an email each time
    insert into notifications (user_id, kind, title, body, link, deliver, tenant_id, via_override)
    select x, 'phone_usage', 'Phone minutes at ' || lvl || '%', 'Your team has used ' || (u->>'minutes') || ' of ' || (u->>'limit') || ' pooled minutes this month.',
           '#phoneusage', true, p_tenant, 'email' from unnest(who) x;
    if lvl = 100 then
      perform private.urgent(p_tenant, who, 'phone_usage', 'Phone minutes over the monthly pool',
        'Your team has used ' || (u->>'minutes') || ' of ' || (u->>'limit') || ' pooled minutes. Calls keep working; extra minutes may be billed.', '#phoneusage');
    end if;
    -- 90% and up also wait in Review (phone_review) until an admin clears them
  end loop;
end $$;

-- ---------- for the edge functions (service role only) ----------
create or replace function public.phone_cfg_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select to_jsonb(c) from private.phone_cfg c where id = 1
$$;
create or replace function public.phone_cfg_set(p jsonb) returns void
language sql security definer set search_path = public, private as $$
  update private.phone_cfg set voice_profile_id = coalesce(p->>'voice_profile_id', voice_profile_id), cc_app_id = coalesce(p->>'cc_app_id', cc_app_id),
    cred_conn_id = coalesce(p->>'cred_conn_id', cred_conn_id), updated_at = now() where id = 1
$$;
create or replace function public.phone_cred_get(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select to_jsonb(c) from private.phone_creds c where user_id = p_user
$$;
create or replace function public.phone_cred_set(p_user uuid, p_cred text, p_sip text) returns void
language sql security definer set search_path = public, private as $$
  insert into private.phone_creds (user_id, cred_id, sip_username) values (p_user, p_cred, p_sip)
  on conflict (user_id) do update set cred_id = excluded.cred_id, sip_username = excluded.sip_username, created_at = now()
$$;
create or replace function public.phone_line_add(p_tenant uuid, p_user uuid, p_number text, p_name text, p_order text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v uuid;
begin
  insert into phone_lines (tenant_id, name, kind, number, members, order_id, created_by)
  values (p_tenant, coalesce(nullif(trim(p_name), ''), 'Main line'), 'group', p_number, array[p_user], p_order, p_user) returning id into v;
  return v;
end $$;
create or replace function public.phone_line_released(p_id uuid) returns void
language sql security definer set search_path = public, private as $$
  update phone_lines set active = false, released_at = now() where id = p_id
$$;

-- a call comes in: which line, who rings, what to do
create or replace function public.phone_in_start(p_ccid text, p_from text, p_to text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare l phone_lines; v uuid; m record;
begin
  select * into l from phone_lines where number = private.phone_e164(p_to) and active;
  if not found then return null; end if;
  select * into m from private.phone_match(l.tenant_id, p_from);
  insert into phone_calls (tenant_id, line_id, direction, ccid, from_number, to_number, other_number, person_id, company_id)
  values (l.tenant_id, l.id, 'in', p_ccid, p_from, p_to, coalesce(private.phone_e164(p_from), p_from), m.person_id, m.company_id)
  on conflict (ccid) do nothing returning id into v;
  if v is null then select id into v from phone_calls where ccid = p_ccid; end if;
  return jsonb_build_object('call_id', v, 'tenant_id', l.tenant_id, 'line_id', l.id, 'line', l.name, 'number', l.number, 'ring_secs', l.ring_secs,
    'record', l.record, 'voicemail', l.voicemail, 'greeting', l.greeting,
    'business', (select name from tenants where id = l.tenant_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'sip', c.sip_username))
                 from app_users u join private.phone_creds c on c.user_id = u.id
                where u.id = any(l.members) and u.active), '[]'::jsonb));
end $$;

create or replace function public.phone_leg_add(p_call uuid, p_leg text, p_user uuid) returns void
language sql security definer set search_path = public, private as $$
  update phone_calls set legs = legs || jsonb_build_object(p_leg, jsonb_build_object('u', p_user, 's', 'ringing')) where id = p_call and ended_at is null
$$;

-- someone picked up: the first one wins; returns the inbound call to bridge to and the other legs to hang up
create or replace function public.phone_leg_answered(p_leg text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; u uuid;
begin
  select * into c from phone_calls where legs ? p_leg for update;
  if not found then return null; end if;
  u := (c.legs->p_leg->>'u')::uuid;
  if c.answered_at is not null or c.ended_at is not null or c.status <> 'ringing' then
    update phone_calls set legs = jsonb_set(legs, array[p_leg, 's'], '"ended"') where id = c.id;
    return jsonb_build_object('lost', true, 'call_id', c.id);
  end if;
  update phone_calls set answered_at = now(), status = 'answered', user_id = u, legs = jsonb_set(legs, array[p_leg, 's'], '"answered"') where id = c.id;
  return jsonb_build_object('call_id', c.id, 'inbound', c.ccid, 'user_id', u,
    'record', (select record from phone_lines where id = c.line_id),
    'others', coalesce((select jsonb_agg(k) from jsonb_each(c.legs) e(k, v) where k <> p_leg and v->>'s' = 'ringing'), '[]'::jsonb));
end $$;

-- a ringing leg ended: if nobody answered and nobody else is still ringing, the caller goes to voicemail
create or replace function public.phone_leg_ended(p_leg text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; left_ringing int;
begin
  select * into c from phone_calls where legs ? p_leg for update;
  if not found then return null; end if;
  if c.legs->p_leg->>'s' = 'answered' then return jsonb_build_object('answered_leg', true, 'call_id', c.id, 'inbound', c.ccid); end if;
  update phone_calls set legs = jsonb_set(legs, array[p_leg, 's'], '"ended"') where id = c.id returning * into c;
  select count(*) into left_ringing from jsonb_each(c.legs) e(k, v) where v->>'s' = 'ringing';
  return jsonb_build_object('call_id', c.id, 'inbound', c.ccid, 'nobody', c.answered_at is null and c.ended_at is null and left_ringing = 0 and c.status = 'ringing');
end $$;

-- nobody answered: mark it voicemail (or missed), say whether there's a voicemail box and the greeting
create or replace function public.phone_to_voicemail(p_call uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; l phone_lines;
begin
  select * into c from phone_calls where id = p_call;
  select * into l from phone_lines where id = c.line_id;
  update phone_calls set status = case when coalesce(l.voicemail, false) then 'voicemail' else 'missed' end where id = p_call and status = 'ringing';
  return jsonb_build_object('voicemail', coalesce(l.voicemail, false), 'greeting', coalesce(nullif(trim(l.greeting), ''),
    'Thanks for calling ' || (select name from tenants where id = c.tenant_id) || '. We can''t get to the phone right now. Please leave your name, number and a short message after the tone.'));
end $$;

-- a call is over (in or out): wrap it up once, log it, tell people about missed calls and voicemail
create or replace function public.phone_call_ended(p_ccid text, p_cause text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; l phone_lines; secs int; legs jsonb;
begin
  select * into c from phone_calls where ccid = p_ccid for update;
  if not found or c.ended_at is not null then return null; end if;
  secs := case when c.answered_at is not null then greatest(0, extract(epoch from now() - c.answered_at)::int) else 0 end;
  update phone_calls set ended_at = now(), seconds = secs,
    status = case when status = 'answered' then 'done' when status = 'ringing' then case when direction = 'out' then 'failed' else 'missed' end else status end
  where id = c.id returning * into c;
  select * into l from phone_lines where id = c.line_id;
  if c.direction = 'in' and c.status = 'missed' then
    insert into notifications (user_id, kind, title, body, link, tenant_id)
    select m, 'phone', 'Missed call on ' || l.name, coalesce((select trim(first_name || ' ' || coalesce(last_name, '')) from people where id = c.person_id),
      (select name from companies where id = c.company_id), private.phone_fmt(c.other_number)), '#phonelog', c.tenant_id from unnest(l.members) m;
  end if;
  perform private.phone_emit(c.id);
  perform private.phone_usage_check(c.tenant_id);
  legs := coalesce((select jsonb_agg(k) from jsonb_each(c.legs) e(k, v) where v->>'s' = 'ringing'), '[]'::jsonb);
  return jsonb_build_object('call_id', c.id, 'ringing_legs', legs);
end $$;

-- a recording or voicemail landed in storage
create or replace function public.phone_recording_saved(p_call uuid, p_path text, p_voicemail boolean) returns void
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls; l phone_lines;
begin
  if p_voicemail then update phone_calls set voicemail_path = p_path where id = p_call returning * into c;
  else update phone_calls set recording_path = p_path where id = p_call returning * into c; end if;
  if not found then return; end if;
  if c.event_id is not null then
    update contact_events set data = data || case when p_voicemail then '{"voicemail": true}'::jsonb else '{"recorded": true}'::jsonb end where id = c.event_id;
  end if;
  if p_voicemail then
    select * into l from phone_lines where id = c.line_id;
    perform private.urgent(c.tenant_id, l.members, 'phone', 'New voicemail on ' || l.name,
      coalesce((select trim(first_name || ' ' || coalesce(last_name, '')) from people where id = c.person_id),
               (select name from companies where id = c.company_id), private.phone_fmt(c.other_number)) || ' left a message.', '#phonelog');
  end if;
end $$;

create or replace function public.phone_call_by_ccid(p_ccid text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('call_id', c.id, 'tenant_id', c.tenant_id, 'direction', c.direction, 'status', c.status, 'record', l.record)
    from phone_calls c left join phone_lines l on l.id = c.line_id where c.ccid = p_ccid
$$;
create or replace function public.phone_call_answered_out(p_ccid text) returns void
language sql security definer set search_path = public, private as $$
  update phone_calls set answered_at = coalesce(answered_at, now()), status = case when status = 'ringing' then 'answered' else status end
   where ccid = p_ccid and direction = 'out' and ended_at is null
$$;

revoke execute on function public.phone_cfg_get(), public.phone_cfg_set(jsonb), public.phone_cred_get(uuid), public.phone_cred_set(uuid, text, text),
  public.phone_line_add(uuid, uuid, text, text, text), public.phone_line_released(uuid), public.phone_in_start(text, text, text), public.phone_leg_add(uuid, text, uuid),
  public.phone_leg_answered(text), public.phone_leg_ended(text), public.phone_to_voicemail(uuid), public.phone_call_ended(text, text),
  public.phone_recording_saved(uuid, text, boolean), public.phone_call_by_ccid(text), public.phone_call_answered_out(text) from public, anon, authenticated;
grant execute on function public.phone_cfg_get(), public.phone_cfg_set(jsonb), public.phone_cred_get(uuid), public.phone_cred_set(uuid, text, text),
  public.phone_line_add(uuid, uuid, text, text, text), public.phone_line_released(uuid), public.phone_in_start(text, text, text), public.phone_leg_add(uuid, text, uuid),
  public.phone_leg_answered(text), public.phone_leg_ended(text), public.phone_to_voicemail(uuid), public.phone_call_ended(text, text),
  public.phone_recording_saved(uuid, text, boolean), public.phone_call_by_ccid(text), public.phone_call_answered_out(text) to service_role;
revoke execute on function private.phone_match(uuid, text), private.phone_emit(uuid), private.phone_usage_of(uuid, date), private.phone_usage_check(uuid) from public, anon, authenticated;

-- ---------- for people in the app ----------
-- what the edge function needs to know about whoever is calling it
create or replace function public.phone_me() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('user_id', auth.uid(), 'tenant_id', private.current_tenant(), 'internal', private.is_internal(),
    'on', private.feature_on('phone'), 'admin', private.is_admin(), 'platform', private.is_platform_admin(),
    'can_buy', private.is_platform_admin() or (private.is_admin() and private.manages(private.current_tenant())))
$$;
revoke execute on function public.phone_me() from public, anon;
grant execute on function public.phone_me() to authenticated;

-- an account admin changes a line: name, direct or group, who rings, how long, recording, voicemail and greeting
create or replace function public.phone_line_save(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare mem uuid[];
begin
  if not (private.feature_on('phone') and private.is_admin()) then raise exception 'Only an admin can change phone lines'; end if;
  if not exists (select 1 from phone_lines where id = p_id and tenant_id = private.current_tenant() and active) then raise exception 'Line not found'; end if;
  mem := array(select x::uuid from jsonb_array_elements_text(coalesce(p->'members', '[]')) x);
  if exists (select 1 from unnest(mem) m where not exists (select 1 from app_users u where u.id = m and u.active and (u.tenant_id = private.current_tenant()
       or exists (select 1 from account_members a where a.user_id = m and a.tenant_id = private.current_tenant() and a.active)))) then
    raise exception 'Pick people on this account''s team';
  end if;
  if coalesce(p->>'kind', 'group') = 'direct' and cardinality(mem) > 1 then raise exception 'A direct line rings one person. Make it a group line to ring several'; end if;
  update phone_lines set name = coalesce(nullif(trim(p->>'name'), ''), name), kind = coalesce(p->>'kind', kind), members = mem,
    ring_secs = coalesce((p->>'ring_secs')::int, ring_secs), record = coalesce((p->>'record')::boolean, record),
    voicemail = coalesce((p->>'voicemail')::boolean, voicemail), greeting = nullif(trim(coalesce(p->>'greeting', '')), '')
   where id = p_id;
end $$;
revoke execute on function public.phone_line_save(uuid, jsonb) from public, anon;
grant execute on function public.phone_line_save(uuid, jsonb) to authenticated;

-- start an outgoing call from the browser (the edge function's token lets the browser place it)
create or replace function public.phone_out_start(p_line uuid, p_to text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare l phone_lines; n text := private.phone_e164(p_to); v uuid; m record;
begin
  if not (private.feature_on('phone') and private.is_internal()) then raise exception 'Phone is off for this account'; end if;
  select * into l from phone_lines where id = p_line and tenant_id = private.current_tenant() and active;
  if not found then raise exception 'Pick a line to call from'; end if;
  if not (auth.uid() = any(l.members) or private.is_admin()) then raise exception 'You''re not on that line. Ask an admin to add you'; end if;
  if n is null then raise exception 'Use a 10 digit US number'; end if;
  if (select count(*) from phone_calls where user_id = auth.uid() and direction = 'out' and started_at > now() - interval '1 minute') >= 10 then
    raise exception 'Too many calls in a minute. Wait a moment';
  end if;
  select * into m from private.phone_match(l.tenant_id, n);
  insert into phone_calls (tenant_id, line_id, direction, from_number, to_number, other_number, user_id, person_id, company_id)
  values (l.tenant_id, l.id, 'out', l.number, n, n, auth.uid(), m.person_id, m.company_id) returning id into v;
  return jsonb_build_object('call_id', v, 'from', l.number, 'to', n);
end $$;
create or replace function public.phone_out_ccid(p_call uuid, p_ccid text) returns void
language sql security definer set search_path = public, private as $$
  update phone_calls set ccid = coalesce(ccid, nullif(p_ccid, '')) where id = p_call and user_id = auth.uid() and direction = 'out'
$$;
-- the browser says how it went, in case Telnyx's events didn't (the first one to wrap it up wins)
create or replace function public.phone_out_end(p_call uuid, p_answered_secs int) returns void
language plpgsql security definer set search_path = public, private as $$
declare c phone_calls;
begin
  select * into c from phone_calls where id = p_call and user_id = auth.uid() and direction = 'out' for update;
  if not found or c.ended_at is not null then return; end if;
  update phone_calls set ended_at = now(), seconds = greatest(0, least(coalesce(p_answered_secs, 0), 86400)),
    answered_at = case when coalesce(p_answered_secs, 0) > 0 then coalesce(answered_at, now() - make_interval(secs => p_answered_secs)) end,
    status = case when coalesce(p_answered_secs, 0) > 0 then 'done' else 'failed' end where id = p_call;
  perform private.phone_emit(p_call);
  perform private.phone_usage_check(c.tenant_id);
end $$;
revoke execute on function public.phone_out_start(uuid, text), public.phone_out_ccid(uuid, text), public.phone_out_end(uuid, int) from public, anon;
grant execute on function public.phone_out_start(uuid, text), public.phone_out_ccid(uuid, text), public.phone_out_end(uuid, int) to authenticated;

-- who's calling (for the ringing popup)
create or replace function public.phone_who(p_number text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.feature_on('phone') and private.is_internal() then (
    select jsonb_build_object('person_id', m.person_id, 'company_id', m.company_id,
      'person', (select trim(first_name || ' ' || coalesce(last_name, '')) from people where id = m.person_id),
      'company', (select name from companies where id = coalesce(m.company_id, (select company_id from company_people where person_id = m.person_id and active limit 1))))
    from private.phone_match(private.current_tenant(), p_number) m) end
$$;
revoke execute on function public.phone_who(text) from public, anon;
grant execute on function public.phone_who(text) to authenticated;

-- notes on a call (anyone who can see it and edit contacts)
create or replace function public.phone_call_note(p_call uuid, p_notes text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.feature_on('phone') and (private.can('contacts', 2) or exists (select 1 from phone_calls where id = p_call and user_id = auth.uid()))) then raise exception 'Not allowed'; end if;
  update phone_calls set notes = nullif(left(trim(coalesce(p_notes, '')), 4000), '') where id = p_call and tenant_id = private.current_tenant();
  if not found then raise exception 'Call not found'; end if;
  update contact_events e set data = e.data || jsonb_build_object('notes', nullif(left(trim(coalesce(p_notes, '')), 300), '')) from phone_calls c where c.id = p_call and e.id = c.event_id;
end $$;
-- file an unknown call (or move a filed one) to a person and/or organization, or dismiss it from the log
create or replace function public.phone_call_file(p_call uuid, p_person uuid, p_company uuid, p_dismiss boolean default false) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.feature_on('phone') and private.can('contacts', 2)) then raise exception 'Not allowed'; end if;
  if not exists (select 1 from phone_calls where id = p_call and tenant_id = private.current_tenant()) then raise exception 'Call not found'; end if;
  if p_dismiss then update phone_calls set dismissed_at = now(), filed_by = auth.uid(), filed_at = now() where id = p_call; return; end if;
  if p_person is null and p_company is null then raise exception 'Pick a person or an organization'; end if;
  if p_person is not null and not exists (select 1 from people where id = p_person and tenant_id = private.current_tenant()) then raise exception 'Person not found'; end if;
  if p_company is not null and not exists (select 1 from companies where id = p_company and tenant_id = private.current_tenant()) then raise exception 'Organization not found'; end if;
  update phone_calls set person_id = p_person, company_id = p_company, filed_by = auth.uid(), filed_at = now(), dismissed_at = null where id = p_call;
  perform private.phone_emit(p_call);
end $$;
-- this month's numbers: mine, and the company's for admins
create or replace function public.phone_usage(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare m date := date_trunc('month', coalesce(p_month, now()))::date; t uuid := private.current_tenant();
begin
  if not (private.feature_on('phone') and private.is_internal()) then return null; end if;
  return jsonb_build_object('me', (select jsonb_build_object('calls_in', count(*) filter (where direction = 'in'), 'calls_out', count(*) filter (where direction = 'out'),
                                     'minutes', coalesce(sum(ceil(seconds / 60.0)), 0))
                                     from phone_calls where tenant_id = t and user_id = auth.uid() and started_at >= m and started_at < m + interval '1 month'),
    'company', case when private.is_admin() then private.phone_usage_of(t, m) end,
    'people', case when private.is_admin() then (select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
        select jsonb_build_object('user_id', u.id, 'name', u.full_name, 'calls_in', count(*) filter (where c.direction = 'in'),
          'calls_out', count(*) filter (where c.direction = 'out'), 'minutes', coalesce(sum(ceil(c.seconds / 60.0)), 0)) x
          from phone_calls c join app_users u on u.id = c.user_id where c.tenant_id = t and c.started_at >= m and c.started_at < m + interval '1 month'
         group by u.id, u.full_name) s) end);
end $$;
revoke execute on function public.phone_call_note(uuid, text), public.phone_call_file(uuid, uuid, uuid, boolean), public.phone_usage(date) from public, anon;
grant execute on function public.phone_call_note(uuid, text), public.phone_call_file(uuid, uuid, uuid, boolean), public.phone_usage(date) to authenticated;

-- Review: usage alerts admins haven't cleared (90% and over)
create or replace function public.phone_review() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.feature_on('phone') and private.is_admin() then coalesce((select jsonb_agg(jsonb_build_object('month', month, 'level', level, 'minutes', minutes, 'limit', lim, 'at', sent_at) order by month desc, level desc)
    from private.phone_alerts where tenant_id = private.current_tenant() and cleared_at is null), '[]'::jsonb) else '[]'::jsonb end
$$;
create or replace function public.phone_review_clear(p_month date, p_level int) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (private.feature_on('phone') and private.is_admin()) then raise exception 'Not allowed'; end if;
  update private.phone_alerts set cleared_at = now(), cleared_by = auth.uid() where tenant_id = private.current_tenant() and month = p_month and level <= p_level and cleared_at is null;
end $$;
revoke execute on function public.phone_review(), public.phone_review_clear(date, int) from public, anon;
grant execute on function public.phone_review(), public.phone_review_clear(date, int) to authenticated;
