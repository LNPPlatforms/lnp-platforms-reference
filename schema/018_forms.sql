-- 018: site forms and lead routing (Oct 16, 2026).
-- Every form belongs to a site, and the site belongs to one account. A submission lands only in that account,
-- as a new organization in its default pipeline's Lead stage, with the contact and the message as a note.
-- Only platform admins (the agency login) can turn on sharing for a form so the same lead also goes to other accounts
-- (for example Compassio, MAICO and E3 on the ENT funnel). Accounts can see who their forms share with but can't change it.
-- When sharing is on, the form's fine print and the terms clause name every company that receives the information,
-- the visitor must tick the consent box, and the exact wording they agreed to is stored with the submission.

create table if not exists public.site_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  site_id uuid not null references public.sites(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  form_key text not null unique default replace(gen_random_uuid()::text, '-', ''),
  share_tenant_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists site_forms_site on public.site_forms (site_id);
alter table public.site_forms enable row level security;
create policy "account reads own forms" on public.site_forms for select using ((private.is_internal() and tenant_id = private.current_tenant()) or private.is_platform_admin());
create policy "platform admins manage forms" on public.site_forms for all using (private.is_platform_admin()) with check (private.is_platform_admin());
grant select, insert, update on public.site_forms to authenticated;

-- the form's account always follows its site; sharing never includes the owner twice
create or replace function private.guard_form() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_admin() then raise exception 'Only GELP admins can change forms'; end if;
  select tenant_id into new.tenant_id from sites where id = new.site_id;
  if new.tenant_id is null then raise exception 'Site not found'; end if;
  new.share_tenant_ids := array(select distinct x from unnest(coalesce(new.share_tenant_ids, '{}')) x
                                 where x <> new.tenant_id and exists (select 1 from tenants where id = x));
  return new;
end $$;
create trigger guard_form before insert or update on public.site_forms for each row execute function private.guard_form();

create table if not exists public.form_submissions (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references public.site_forms(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  company_id uuid references public.companies(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,
  data jsonb not null,
  shared_with text[] not null default '{}',
  consent_text text,
  page_url text,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists form_submissions_tenant on public.form_submissions (tenant_id, created_at desc);
create index if not exists form_submissions_ip on public.form_submissions (ip, created_at);
alter table public.form_submissions enable row level security;
create policy "account reads own submissions" on public.form_submissions for select using (private.is_internal() and tenant_id = private.current_tenant());
grant select on public.form_submissions to authenticated;

-- 'Individual' organization type for leads without a company name
insert into public.lookup_values (tenant_id, list_name, label, sort_order, active)
select t.id, 'org_type', 'Individual', 40, true from public.tenants t
 where not exists (select 1 from public.lookup_values x where x.tenant_id = t.id and x.list_name = 'org_type' and x.label = 'Individual');

create or replace function private.list_names(a text[]) returns text
language sql immutable as $$
  select case coalesce(cardinality(a), 0) when 0 then '' when 1 then a[1] when 2 then a[1] || ' and ' || a[2]
    else array_to_string(a[1:cardinality(a) - 1], ', ') || ' and ' || a[cardinality(a)] end
$$;

-- the wording shown under the form (and stored with each submission)
create or replace function private.form_disclosure(f site_forms) returns jsonb
language sql stable security definer set search_path = public, private as $$
  with r as (
    select t.name, 0 ord from tenants t where t.id = f.tenant_id
    union all select t.name, 1 from tenants t where t.id = any(f.share_tenant_ids)
  ), names as (select array_agg(name order by ord, name) a from r)
  select jsonb_build_object(
    'recipients', to_jsonb(a),
    'shared', cardinality(f.share_tenant_ids) > 0,
    'fine_print', case when cardinality(f.share_tenant_ids) = 0
      then 'Your information goes to ' || a[1] || ' only, so they can contact you about your request. It is not sold or shared.'
      else 'By submitting, you agree that your information will be shared with ' || private.list_names(a)
           || ' so they can contact you about your request. Each of them may contact you by phone, text or email. Your information is not sold to anyone else.' end,
    'consent_label', case when cardinality(f.share_tenant_ids) = 0 then null
      else 'I agree to share my information with ' || private.list_names(a) || '.' end,
    'terms_clause', case when cardinality(f.share_tenant_ids) = 0
      then 'Information submitted through the ' || f.name || ' form is received by ' || a[1] || ' and used only to respond to your request. It is not sold or shared with other companies.'
      else 'Information submitted through the ' || f.name || ' form is shared with the following companies, each of which receives it and may contact you about your request: '
           || private.list_names(a) || '. Each company uses the information under its own privacy practices. It is not sold to anyone else.' end)
  from names
$$;

-- public: what a form page needs to show (no account ids leave the server)
create or replace function public.form_config(p_key text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', f.name) || private.form_disclosure(f)
    from site_forms f where f.form_key = p_key and f.active
$$;

-- public: submit a form. One lead per receiving account.
create or replace function public.form_submit(p_key text, p_data jsonb, p_consent boolean default false, p_page text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare f site_forms; disc jsonb; hdr json; v_ip text; d jsonb := coalesce(p_data, '{}'::jsonb);
  v_first text; v_last text; v_email text; v_phone text; v_org text; v_msg text; v_name text;
  t uuid; co uuid; pe uuid; u record; body text; shared text[];
begin
  select * into f from site_forms where form_key = p_key and active;
  if not found then raise exception 'This form is not available'; end if;
  disc := private.form_disclosure(f);
  if (disc->>'shared')::boolean and not coalesce(p_consent, false) then raise exception 'Please tick the box to agree to how your information is shared'; end if;
  v_first := nullif(left(trim(coalesce(d->>'first_name', split_part(trim(coalesce(d->>'name', '')), ' ', 1))), 80), '');
  v_last := nullif(left(trim(coalesce(d->>'last_name', nullif(substr(trim(coalesce(d->>'name', '')), length(split_part(trim(coalesce(d->>'name', '')), ' ', 1)) + 1), ''))), 80), '');
  v_email := lower(nullif(left(trim(coalesce(d->>'email', '')), 200), ''));
  v_phone := nullif(left(trim(coalesce(d->>'phone', '')), 40), '');
  v_org := nullif(left(trim(coalesce(d->>'organization', d->>'company', '')), 160), '');
  v_msg := nullif(left(trim(coalesce(d->>'message', '')), 4000), '');
  if v_first is null then raise exception 'Add your name'; end if;
  if v_email is null and v_phone is null then raise exception 'Add an email or phone number so we can reach you'; end if;
  if v_email is not null and v_email !~ '^\S+@\S+\.\S+$' then raise exception 'Check the email address'; end if;
  if length(d::text) > 20000 then raise exception 'That is too much information for one form'; end if;
  hdr := nullif(current_setting('request.headers', true), '')::json;
  v_ip := nullif(trim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'x-real-ip', ''), ',', 1)), '');
  if v_ip is not null and (select count(distinct s.created_at) from form_submissions s where s.ip = v_ip and s.created_at > now() - interval '1 hour') >= 10
    then raise exception 'Too many submissions. Please try again later.'; end if;
  v_name := coalesce(v_org, trim(v_first || ' ' || coalesce(v_last, '')));
  select array_agg(x) into shared from jsonb_array_elements_text(disc->'recipients') x;
  body := 'Website form: ' || f.name || coalesce(E'\nPage: ' || left(p_page, 300), '')
       || coalesce(E'\nMessage: ' || v_msg, '')
       || coalesce((select E'\n' || string_agg(initcap(replace(k, '_', ' ')) || ': ' || left(v, 500), E'\n')
                      from jsonb_each_text(d) e(k, v)
                     where k not in ('first_name','last_name','name','email','phone','organization','company','message') and trim(v) <> ''), '')
       || case when (disc->>'shared')::boolean then E'\nShared with: ' || private.list_names(shared) || ' (visitor agreed)' else '' end;
  foreach t in array (f.tenant_id || f.share_tenant_ids) loop
    insert into companies (tenant_id, name, main_phone, main_email, org_types, lead_source_kind, lead_source_channel, created_by)
    values (t, v_name, case when v_org is not null then null else v_phone end, case when v_org is not null then null else v_email end,
            case when v_org is null then '{Individual}'::text[] else '{Clinic}'::text[] end, 'system', left('Website form: ' || f.name, 120), null)
    returning id into co;
    insert into people (tenant_id, first_name, last_name, personal_email, personal_cell, created_by)
    values (t, v_first, v_last, v_email, v_phone, null) returning id into pe;
    insert into company_people (tenant_id, company_id, person_id, work_email, work_phone, is_primary_contact)
    values (t, co, pe, v_email, v_phone, true);
    insert into activities (tenant_id, company_id, person_id, type, body, created_by) values (t, co, pe, 'note', body, null);
    insert into form_submissions (form_id, tenant_id, company_id, person_id, data, shared_with, consent_text, page_url, ip)
    values (f.id, t, co, pe, d, shared, case when (disc->>'shared')::boolean then disc->>'fine_print' end, left(p_page, 500), v_ip);
    for u in select id from app_users where tenant_id = t and active and is_admin and role <> 'vendor' loop
      perform private.notify(u.id, 'form_lead', 'New lead: ' || v_name, 'From ' || f.name || coalesce('. ' || v_msg, ''), '#org/' || co);
    end loop;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function private.form_disclosure(site_forms), private.list_names(text[]) from public, anon;
grant execute on function private.form_disclosure(site_forms), private.list_names(text[]) to authenticated;
grant execute on function public.form_config(text), public.form_submit(text, jsonb, boolean, text) to anon, authenticated;

-- signed-in: a form's wording (for the Sites page)
create or replace function public.form_details(p_form uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select private.form_disclosure(f) from site_forms f
   where f.id = p_form and ((private.is_internal() and f.tenant_id = private.current_tenant()) or private.is_platform_admin())
$$;
revoke execute on function public.form_details(uuid) from public, anon;
grant execute on function public.form_details(uuid) to authenticated;
