-- 019: shared forms can name the group (e.g. "the Compassio coalition") and each company's role (Oct 16, 2026).
-- The consent box names the group and, in parentheses, every company in it. The fine print and the terms clause list
-- every company with its role, e.g. "MAICO (the manufacturer)" and "E3 (the US distributor)".
-- Applied live with the function below (see 018 for the rest of form_disclosure's contract).
alter table public.site_forms add column if not exists share_group_name text check (share_group_name is null or length(trim(share_group_name)) between 2 and 80);
alter table public.site_forms add column if not exists recipient_roles jsonb not null default '{}'::jsonb;

create or replace function private.form_disclosure(f site_forms) returns jsonb
language sql stable security definer set search_path = public, private as $q$
  with r as (
    select t.name, nullif(trim(f.recipient_roles->>t.id::text), '') role, 0 ord from tenants t where t.id = f.tenant_id
    union all select t.name, nullif(trim(f.recipient_roles->>t.id::text), ''), 1 from tenants t where t.id = any(f.share_tenant_ids)
  ), names as (select array_agg(name order by ord, name) a,
                      array_agg(name || coalesce(' (' || left(role, 60) || ')', '') order by ord, name) ar from r),
  g as (select case when cardinality(f.share_tenant_ids) > 0 then nullif(trim(f.share_group_name), '') end grp)
  select jsonb_build_object(
    'recipients', to_jsonb(a),
    'recipients_with_roles', to_jsonb(ar),
    'group', grp,
    'shared', cardinality(f.share_tenant_ids) > 0,
    'fine_print', case
      when cardinality(f.share_tenant_ids) = 0
        then 'Your information goes to ' || a[1] || ' only, so they can contact you about your request. It is not sold or shared.'
      when grp is not null
        then 'By submitting, you agree that your information will be shared with ' || grp || ', which is ' || private.list_names(ar)
             || ', so they can contact you about your request. Each of them may contact you by phone, text or email. Your information is not sold to anyone else.'
      else 'By submitting, you agree that your information will be shared with ' || private.list_names(ar)
           || ' so they can contact you about your request. Each of them may contact you by phone, text or email. Your information is not sold to anyone else.' end,
    'consent_label', case
      when cardinality(f.share_tenant_ids) = 0 then null
      when grp is not null then 'I agree to share my information with ' || grp || ' (' || private.list_names(a) || ').'
      else 'I agree to share my information with ' || private.list_names(a) || '.' end,
    'terms_clause', case
      when cardinality(f.share_tenant_ids) = 0
        then 'Information submitted through the ' || f.name || ' form is received by ' || a[1] || ' and used only to respond to your request. It is not sold or shared with other companies.'
      else 'Information submitted through the ' || f.name || ' form is shared with '
           || coalesce(grp || ', which is made up of the following companies', 'the following companies')
           || '. Each of them receives it and may contact you about your request: ' || private.list_names(ar)
           || '. Each company uses the information under its own privacy practices. It is not sold to anyone else.' end)
  from names, g
$q$;
