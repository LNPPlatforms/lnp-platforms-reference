-- 109: form lead alerts also reach account members.
-- form_submit only notified admins whose home account (app_users.tenant_id) is the form's account, so admins who are
-- in an account as members (account_members, e.g. Chris in Cognix) got no "New lead" alert. Now it notifies every
-- active admin of the account either way, once each. Nothing else changes.
create or replace function public.form_submit(p_key text, p_data jsonb, p_consent boolean default false, p_page text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'private'
as $function$
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
    -- every active admin of the account: home-account admins plus admins who are members of it
    for u in select a.id from app_users a where a.tenant_id = t and a.active and a.is_admin and a.role <> 'vendor'
             union
             select a.id from account_members m join app_users a on a.id = m.user_id
              where m.tenant_id = t and m.active and m.is_admin and m.removed_at is null and a.active and a.role <> 'vendor' loop
      perform private.notify(u.id, 'form_lead', 'New lead: ' || v_name, 'From ' || f.name || coalesce('. ' || v_msg, ''), '#org/' || co);
    end loop;
  end loop;
  return jsonb_build_object('ok', true);
end $function$;
