-- 017: bulk import from a spreadsheet; pending invites for the Accounts page (Oct 16, 2026).
-- import_rows runs as the signed-in user (security invoker), so row security keeps every row inside the current account.
-- Each row can carry an organization, a contact, a pipeline, a stage, an owner and a note. Organizations match by name
-- (and city when given), contacts by email or by name at the same organization. Missing pipelines and stages are
-- created when the user is an admin (row security blocks it for everyone else, and the row reports why).
-- p_dry = true runs everything and rolls it back, returning the counts as a preview.
-- p_kind leaves room for other record types later; 'contacts' (organizations and their people) is the first.

create or replace function public.import_rows(p_rows jsonb, p_kind text default 'contacts', p_dry boolean default false) returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  r jsonb; i int := 0; n jsonb := jsonb_build_object('orgs_new',0,'orgs_matched',0,'people_new',0,'people_matched',0,'pipelines_new',0,'stages_new',0,'notes',0);
  errs jsonb := '[]'::jsonb; v_org uuid; v_person uuid; v_pipe uuid; v_stage uuid; v_owner uuid; v_name text; v_first text; v_last text; v_email text;
  v_types text[]; t uuid := private.current_tenant();
  bump text;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_kind <> 'contacts' then raise exception 'That import type is not available yet'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Send up to 1,000 rows at a time'; end if;
  begin
    for r in select value from jsonb_array_elements(p_rows) loop
      i := i + 1;
      begin
        v_org := null; v_person := null; v_pipe := null; v_stage := null; v_owner := null;
        v_name := nullif(trim(r->>'org_name'), '');
        v_email := lower(nullif(trim(r->>'email'), ''));
        v_first := nullif(trim(r->>'first_name'), ''); v_last := nullif(trim(r->>'last_name'), '');
        if v_first is null and nullif(trim(r->>'full_name'), '') is not null then
          v_first := split_part(trim(r->>'full_name'), ' ', 1);
          v_last := nullif(trim(substr(trim(r->>'full_name'), length(v_first) + 1)), '');
        end if;
        if v_name is null and v_first is null and v_email is null then raise exception 'No organization or contact on this row'; end if;
        if v_name is null and (nullif(trim(r->>'pipeline'), '') is not null or nullif(trim(r->>'stage'), '') is not null) then
          raise exception 'A pipeline or stage needs an organization name';
        end if;

        -- pipeline and stage
        if nullif(trim(r->>'pipeline'), '') is not null then
          select id into v_pipe from pipelines where tenant_id = t and archived_at is null and lower(name) = lower(trim(r->>'pipeline')) order by is_default desc limit 1;
          if v_pipe is null then
            insert into pipelines (name, sort) values (trim(r->>'pipeline'), 100 + (select count(*) from pipelines where tenant_id = t)::int * 10) returning id into v_pipe;
            n := jsonb_set(n, '{pipelines_new}', to_jsonb((n->>'pipelines_new')::int + 1));
          end if;
        elsif nullif(trim(r->>'stage'), '') is not null then
          select id into v_pipe from pipelines where tenant_id = t and is_default and archived_at is null;
        end if;
        if v_pipe is not null then
          if nullif(trim(r->>'stage'), '') is null then
            select id into v_stage from pipeline_stages where pipeline_id = v_pipe and system_key = 'lead';
          else
            select id into v_stage from pipeline_stages where pipeline_id = v_pipe and archived_at is null and lower(name) = lower(trim(r->>'stage')) limit 1;
            if v_stage is null then
              insert into pipeline_stages (pipeline_id, name, sort, kind)
              values (v_pipe, trim(r->>'stage'), least(890, coalesce((select max(sort) from pipeline_stages where pipeline_id = v_pipe and kind = 'open'), 20) + 10), 'open')
              returning id into v_stage;
              n := jsonb_set(n, '{stages_new}', to_jsonb((n->>'stages_new')::int + 1));
            end if;
          end if;
        end if;

        if nullif(trim(r->>'owner_email'), '') is not null then
          select id into v_owner from app_users where tenant_id = t and active and lower(email) = lower(trim(r->>'owner_email'));
        end if;

        -- organization
        if v_name is not null then
          select id into v_org from companies where tenant_id = t and archived_at is null and lower(name) = lower(v_name)
             and (nullif(trim(r->>'city'), '') is null or city is null or lower(city) = lower(trim(r->>'city')))
           order by created_at limit 1;
          if v_org is null then
            v_types := case when nullif(trim(r->>'org_type'), '') is null then null
                            else array(select trim(x) from unnest(string_to_array(r->>'org_type', ',')) x where trim(x) <> '') end;
            insert into companies (name, website, main_phone, main_email, address, city, state, zip, specialty, owner_id, org_types, pipeline_stage_id)
            values (v_name, nullif(trim(r->>'website'), ''), nullif(trim(r->>'main_phone'), ''), lower(nullif(trim(r->>'main_email'), '')),
                    nullif(trim(r->>'address'), ''), nullif(trim(r->>'city'), ''), upper(nullif(trim(r->>'state'), '')), nullif(trim(r->>'zip'), ''),
                    nullif(trim(r->>'specialty'), ''), coalesce(v_owner, auth.uid()), coalesce(v_types, '{Clinic}'), v_stage)
            returning id into v_org;
            bump := 'orgs_new';
          else
            update companies set
              website = coalesce(website, nullif(trim(r->>'website'), '')), main_phone = coalesce(main_phone, nullif(trim(r->>'main_phone'), '')),
              main_email = coalesce(main_email, lower(nullif(trim(r->>'main_email'), ''))), address = coalesce(address, nullif(trim(r->>'address'), '')),
              city = coalesce(city, nullif(trim(r->>'city'), '')), state = coalesce(state, upper(nullif(trim(r->>'state'), ''))),
              zip = coalesce(zip, nullif(trim(r->>'zip'), '')), specialty = coalesce(specialty, nullif(trim(r->>'specialty'), '')),
              owner_id = coalesce(v_owner, owner_id),
              pipeline_stage_id = coalesce(v_stage, pipeline_stage_id)
             where id = v_org;
            bump := 'orgs_matched';
          end if;
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
        end if;

        -- contact
        if v_first is not null or v_email is not null then
          if v_email is not null then
            select p.id into v_person from people p where p.tenant_id = t and p.archived_at is null and lower(p.personal_email) = v_email limit 1;
            if v_person is null then
              select cp.person_id into v_person from company_people cp join people p on p.id = cp.person_id
               where cp.tenant_id = t and p.archived_at is null and lower(cp.work_email) = v_email limit 1;
            end if;
          end if;
          if v_person is null and v_org is not null and v_first is not null then
            select p.id into v_person from people p join company_people cp on cp.person_id = p.id and cp.company_id = v_org
             where p.archived_at is null and lower(p.first_name) = lower(v_first) and lower(coalesce(p.last_name, '')) = lower(coalesce(v_last, '')) limit 1;
          end if;
          if v_person is null then
            insert into people (first_name, last_name, personal_email, personal_cell)
            values (coalesce(v_first, split_part(v_email, '@', 1)), v_last, case when v_org is null then v_email end,
                    case when v_org is null then nullif(trim(r->>'phone'), '') end)
            returning id into v_person;
            bump := 'people_new';
          else
            bump := 'people_matched';
          end if;
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
          if v_org is not null and not exists (select 1 from company_people where company_id = v_org and person_id = v_person) then
            insert into company_people (company_id, person_id, title, work_email, work_phone, is_primary_contact)
            values (v_org, v_person, nullif(trim(r->>'title'), ''), v_email, nullif(trim(r->>'phone'), ''),
                    not exists (select 1 from company_people where company_id = v_org));
          end if;
        end if;

        if nullif(trim(r->>'note'), '') is not null then
          insert into activities (company_id, person_id, type, body) values (v_org, v_person, 'note', trim(r->>'note'));
          n := jsonb_set(n, '{notes}', to_jsonb((n->>'notes')::int + 1));
        end if;
      exception when others then
        errs := errs || jsonb_build_object('row', i, 'error', case when sqlerrm ilike '%row-level security%' then 'Only an admin can add pipelines or stages' else sqlerrm end);
      end;
    end loop;
    if p_dry then raise exception 'IMPORT_DRY_RUN'; end if;
  exception when others then
    if sqlerrm <> 'IMPORT_DRY_RUN' then raise; end if;
  end;
  return n || jsonb_build_object('rows', i, 'errors', errs, 'dry', p_dry);
end $$;
revoke execute on function public.import_rows(jsonb, text, boolean) from public, anon;
grant execute on function public.import_rows(jsonb, text, boolean) to authenticated;

-- platform admins: open invites across accounts
create or replace function public.account_invites() returns setof jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('tenant_id', tenant_id, 'email', email, 'name', full_name, 'is_admin', is_admin, 'at', created_at)
    from invites where private.is_platform_admin() and accepted_at is null and revoked_at is null order by created_at
$$;
revoke execute on function public.account_invites() from public, anon;
grant execute on function public.account_invites() to authenticated;
