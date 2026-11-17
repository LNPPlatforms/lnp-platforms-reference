-- 068: report builder. Owners build the report they want: pick what to count (contacts, organizations, deals, chats,
-- to-dos, jobs, timeline events), how to group it, what to measure and the dates. Saved reports are personal or shared.
-- report_run is security invoker: the normal row rules decide what each person's report can see.

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.app_users(id),
  name text not null check (length(trim(name)) between 1 and 80),
  spec jsonb not null,                 -- {source, group, measure, range, from, to, mine, chart}
  shared boolean not null default false,
  pinned boolean not null default false,  -- shows on the owner's dashboard
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
alter table public.reports enable row level security;
create policy "see reports" on public.reports for select using (tenant_id = private.current_tenant() and private.can('reports', 1) and archived_at is null and (owner_id = auth.uid() or shared));
create policy "own reports" on public.reports for all using (tenant_id = private.current_tenant() and owner_id = auth.uid() and private.can('reports', 1))
  with check (tenant_id = private.current_tenant() and owner_id = auth.uid() and private.can('reports', 1) and (not shared or private.can('reports', 3) or private.is_admin()));
revoke all on public.reports from anon, authenticated;
grant select, insert, update on public.reports to authenticated;

-- what each source can be grouped by and measured with. Every expression is fixed here; nothing from the request goes into the SQL as text.
create or replace function private.report_catalog() returns jsonb language sql immutable as $$
  select '{
    "contacts": {"table": "people", "date": "created_at", "owner": null,
      "groups": {"lead_source": "coalesce(lead_source, ''(none)'')", "preferred_contact_method": "coalesce(preferred_contact_method, ''(none)'')", "tag": "unnest(case when cardinality(tags) = 0 then array[''(no tags)''] else tags end)"},
      "measures": {"count": "count(*)"}},
    "organizations": {"table": "companies", "date": "created_at", "owner": "owner_id",
      "groups": {"stage": "coalesce(stage, ''(none)'')", "owner": "coalesce((select full_name from app_users where id = owner_id), ''(nobody)'')", "lead_source": "coalesce(lead_source_channel, ''(none)'')",
                 "city": "coalesce(city, ''(none)'')", "state": "coalesce(state, ''(none)'')", "interest_level": "coalesce(interest_level, ''(none)'')", "tag": "unnest(case when cardinality(tags) = 0 then array[''(no tags)''] else tags end)"},
      "measures": {"count": "count(*)"}},
    "deals": {"table": "opportunities", "date": "created_at", "owner": "owner_id",
      "groups": {"status": "coalesce(status, ''(none)'')", "owner": "coalesce((select full_name from app_users where id = owner_id), ''(nobody)'')", "service": "coalesce(service, ''(none)'')"},
      "measures": {"count": "count(*)", "value": "coalesce(sum(estimated_value), 0)", "average_value": "round(coalesce(avg(estimated_value), 0), 2)"}},
    "chats": {"table": "chat_threads", "date": "created_at", "owner": "assigned_to", "where": "kind is distinct from ''team''",
      "groups": {"person": "coalesce((select full_name from app_users where id = assigned_to), ''(nobody)'')", "widget": "coalesce((select name from chat_widgets where id = widget_id), ''(default)'')", "source": "coalesce(source, ''(none)'')", "status": "coalesce(status, ''(none)'')"},
      "measures": {"count": "count(*)", "picked_up": "count(picked_up_at)", "missed": "count(*) filter (where picked_up_at is null)", "avg_pickup_minutes": "round(coalesce(avg(extract(epoch from picked_up_at - created_at) / 60.0), 0)::numeric, 1)"}},
    "todos": {"table": "tasks", "date": "created_at", "owner": "assigned_to",
      "groups": {"person": "coalesce((select full_name from app_users where id = assigned_to), ''(nobody)'')", "done": "case when done then ''Done'' else ''Open'' end"},
      "measures": {"count": "count(*)", "done": "count(*) filter (where done)", "overdue": "count(*) filter (where not done and due_date < current_date)"}},
    "jobs": {"table": "jobs", "date": "created_at", "owner": "assigned_to", "where": "archived_at is null",
      "groups": {"person": "coalesce((select full_name from app_users where id = assigned_to), ''(nobody)'')", "status": "status", "service_type": "coalesce(service_type, ''(none)'')"},
      "measures": {"count": "count(*)", "revenue": "coalesce(sum(price), 0)", "completed": "count(*) filter (where status in (''completed'', ''left''))"}},
    "activity": {"table": "contact_events", "date": "created_at", "owner": "actor",
      "groups": {"kind": "kind", "person": "coalesce((select full_name from app_users where id = actor), ''(automatic)'')"},
      "measures": {"count": "count(*)"}}
  }'::jsonb
$$;

-- time groupings work on any source
create or replace function public.report_options() returns jsonb language sql stable as $$
  select jsonb_build_object('sources', (select jsonb_object_agg(k, jsonb_build_object('groups', (select jsonb_agg(g) from jsonb_object_keys(v->'groups') g) || '["day","week","month"]'::jsonb,
    'measures', (select jsonb_agg(m) from jsonb_object_keys(v->'measures') m))) from jsonb_each(private.report_catalog()) x(k, v)))
$$;
revoke execute on function public.report_options() from public, anon;
grant execute on function public.report_options() to authenticated;

create or replace function public.report_run(p jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public, private as $$
declare cat jsonb := private.report_catalog()->(p->>'source'); g text := coalesce(p->>'group', 'month'); m text := coalesce(p->>'measure', 'count');
  gexpr text; mexpr text; dfrom timestamptz; dto timestamptz; sql text; out jsonb; v_where text; v_range text := coalesce(p->>'range', '90d');
begin
  if not private.can('reports', 1) then raise exception 'Your role can''t run reports'; end if;
  if cat is null then raise exception 'Pick what to report on'; end if;
  gexpr := case g when 'day' then format('to_char(date_trunc(''day'', %I), ''YYYY-MM-DD'')', cat->>'date') when 'week' then format('to_char(date_trunc(''week'', %I), ''YYYY-MM-DD'')', cat->>'date')
                 when 'month' then format('to_char(date_trunc(''month'', %I), ''YYYY-MM'')', cat->>'date') else cat->'groups'->>g end;
  mexpr := cat->'measures'->>m;
  if gexpr is null then raise exception 'That grouping isn''t available'; end if;
  if mexpr is null then raise exception 'That measure isn''t available'; end if;
  dto := coalesce(nullif(p->>'to', '')::date + 1, now());
  dfrom := case v_range when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days' when '90d' then now() - interval '90 days'
    when '12m' then now() - interval '12 months' when 'ytd' then date_trunc('year', now()) when 'all' then '-infinity'::timestamptz
    when 'custom' then coalesce(nullif(p->>'from', '')::date::timestamptz, '-infinity') else now() - interval '90 days' end;
  v_where := format('tenant_id = private.current_tenant() and %I >= $1 and %I < $2', cat->>'date', cat->>'date') || coalesce(' and ' || (cat->>'where'), '');
  -- "just mine", and anyone whose role sees only their own
  if cat->>'owner' is not null and (coalesce((p->>'mine')::boolean, false) or private.perm('reports')->>'scope' = 'own') then
    v_where := v_where || format(' and %I = auth.uid()', cat->>'owner');
  end if;
  sql := format('select coalesce(jsonb_agg(jsonb_build_object(''label'', label, ''value'', value) order by %s), ''[]''::jsonb) from (select %s as label, %s as value from %I where %s group by 1) s',
    case when g in ('day', 'week', 'month') then 'label' else 'value desc, label' end, gexpr, mexpr, cat->>'table', v_where);
  execute sql into out using dfrom, dto;
  return jsonb_build_object('rows', out, 'source', p->>'source', 'group', g, 'measure', m, 'from', dfrom, 'to', dto);
end $$;
revoke execute on function public.report_run(jsonb) from public, anon;
grant execute on function public.report_run(jsonb) to authenticated;
