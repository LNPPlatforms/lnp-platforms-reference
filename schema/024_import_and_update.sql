-- 024: Import and Update. p_kind 'contacts' = Import (every row new, duplicates flagged for review).
-- 'contacts:fill' = update matching records, filling only their blank fields. 'contacts:overwrite' = spreadsheet values replace
-- what's there (blank cells never erase anything). Rows with no match are added as new, same as Import.
create or replace function public.import_rows(p_rows jsonb, p_kind text default 'contacts', p_dry boolean default false) returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  r jsonb; i int := 0; n jsonb := jsonb_build_object('orgs_new',0,'orgs_matched',0,'orgs_updated',0,'people_new',0,'people_matched',0,'people_updated',0,'pipelines_new',0,'stages_new',0,'notes',0);
  errs jsonb := '[]'::jsonb; v_org uuid; v_person uuid; v_pipe uuid; v_stage uuid; v_owner uuid; v_name text; v_first text; v_last text; v_email text;
  v_types text[]; t uuid := private.current_tenant();
  bump text; flagged int := 0; seen jsonb := '{}'::jsonb; k text; new_org boolean; m jsonb; dupes jsonb := '[]'::jsonb; new_person boolean;
  -- p_kind: 'contacts' = Import (every row new, duplicates flagged); 'contacts:fill' / 'contacts:overwrite' = Import and Update
  upd boolean := p_kind in ('contacts:fill', 'contacts:overwrite'); ow boolean := p_kind = 'contacts:overwrite';
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_kind not in ('contacts', 'contacts:fill', 'contacts:overwrite') then raise exception 'That import type is not available yet'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Send up to 1,000 rows at a time'; end if;
  begin
    for r in select value from jsonb_array_elements(p_rows) loop
      i := i + 1;
      begin
        v_org := null; v_person := null; v_pipe := null; v_stage := null; v_owner := null; new_org := false; new_person := false;
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
        -- rows in this file that repeat the exact same organization (for another contact) share it;
        -- anything that differs at all becomes its own record and gets flagged in Review
        k := lower(coalesce(v_name,'')) || '|' || lower(coalesce(trim(r->>'address'),'')) || '|' || lower(coalesce(trim(r->>'city'),''))
             || '|' || regexp_replace(coalesce(r->>'main_phone',''), '\D', '', 'g');
        if v_name is not null and seen ? k then
          v_org := (seen->>k)::uuid;
          bump := 'orgs_matched';
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
        end if;
        -- Import and Update: a row that matches an organization already here (same name, same or missing city) updates it
        if upd and v_name is not null and v_org is null then
          select id into v_org from companies where tenant_id = t and archived_at is null and lower(name) = lower(v_name)
             and (nullif(trim(r->>'city'), '') is null or city is null or lower(city) = lower(trim(r->>'city')))
           order by created_at limit 1;
          if v_org is not null then
            v_types := case when nullif(trim(r->>'org_type'), '') is null then null
                            else array(select trim(x) from unnest(string_to_array(r->>'org_type', ',')) x where trim(x) <> '') end;
            update companies c set
              website     = case when ow then coalesce(nullif(trim(r->>'website'), ''), c.website) else coalesce(c.website, nullif(trim(r->>'website'), '')) end,
              main_phone  = case when ow then coalesce(nullif(trim(r->>'main_phone'), ''), c.main_phone) else coalesce(c.main_phone, nullif(trim(r->>'main_phone'), '')) end,
              fax         = case when ow then coalesce(nullif(trim(r->>'fax'), ''), c.fax) else coalesce(c.fax, nullif(trim(r->>'fax'), '')) end,
              main_email  = case when ow then coalesce(lower(nullif(trim(r->>'main_email'), '')), c.main_email) else coalesce(c.main_email, lower(nullif(trim(r->>'main_email'), ''))) end,
              address     = case when ow then coalesce(nullif(trim(r->>'address'), ''), c.address) else coalesce(c.address, nullif(trim(r->>'address'), '')) end,
              city        = case when ow then coalesce(nullif(trim(r->>'city'), ''), c.city) else coalesce(c.city, nullif(trim(r->>'city'), '')) end,
              state       = case when ow then coalesce(upper(nullif(trim(r->>'state'), '')), c.state) else coalesce(c.state, upper(nullif(trim(r->>'state'), ''))) end,
              zip         = case when ow then coalesce(nullif(trim(r->>'zip'), ''), c.zip) else coalesce(c.zip, nullif(trim(r->>'zip'), '')) end,
              specialty   = case when ow then coalesce(nullif(trim(r->>'specialty'), ''), c.specialty) else coalesce(c.specialty, nullif(trim(r->>'specialty'), '')) end,
              owner_id    = case when ow then coalesce(v_owner, c.owner_id) else coalesce(c.owner_id, v_owner) end,
              org_types   = case when ow and v_types is not null then v_types else c.org_types end,
              pipeline_stage_id = case when ow then coalesce(v_stage, c.pipeline_stage_id) else coalesce(c.pipeline_stage_id, v_stage) end
             where c.id = v_org;
            bump := 'orgs_updated';
            n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
            seen := seen || jsonb_build_object(k, v_org);
          end if;
        end if;
        if v_name is not null and v_org is null then
          -- every row becomes its own record; possible duplicates are flagged in Review, never merged
          v_types := case when nullif(trim(r->>'org_type'), '') is null then null
                          else array(select trim(x) from unnest(string_to_array(r->>'org_type', ',')) x where trim(x) <> '') end;
          insert into companies (name, website, main_phone, fax, main_email, address, city, state, zip, specialty, owner_id, org_types, pipeline_stage_id)
          values (v_name, nullif(trim(r->>'website'), ''), nullif(trim(r->>'main_phone'), ''), nullif(trim(r->>'fax'), ''), lower(nullif(trim(r->>'main_email'), '')),
                  nullif(trim(r->>'address'), ''), nullif(trim(r->>'city'), ''), upper(nullif(trim(r->>'state'), '')), nullif(trim(r->>'zip'), ''),
                  nullif(trim(r->>'specialty'), ''), coalesce(v_owner, auth.uid()), coalesce(v_types, '{Clinic}'), v_stage)
          returning id into v_org;
          bump := 'orgs_new';
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
          seen := seen || jsonb_build_object(k, v_org); new_org := true;
        end if;

        -- contact
        -- Import and Update: a contact with the same email (or the same name at the matched organization) is updated
        if upd and (v_first is not null or v_email is not null) then
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
          if v_person is not null then
            update people p set
              first_name = case when ow then coalesce(v_first, p.first_name) else p.first_name end,
              last_name  = case when ow then coalesce(v_last, p.last_name) else coalesce(p.last_name, v_last) end,
              personal_cell = case when v_org is not null then p.personal_cell when ow then coalesce(nullif(trim(r->>'phone'), ''), p.personal_cell) else coalesce(p.personal_cell, nullif(trim(r->>'phone'), '')) end
             where p.id = v_person;
            if v_org is not null then
              if exists (select 1 from company_people where company_id = v_org and person_id = v_person) then
                update company_people cp set
                  title      = case when ow then coalesce(nullif(trim(r->>'title'), ''), cp.title) else coalesce(cp.title, nullif(trim(r->>'title'), '')) end,
                  work_email = case when ow then coalesce(v_email, cp.work_email) else coalesce(cp.work_email, v_email) end,
                  work_phone = case when ow then coalesce(nullif(trim(r->>'phone'), ''), cp.work_phone) else coalesce(cp.work_phone, nullif(trim(r->>'phone'), '')) end
                 where cp.company_id = v_org and cp.person_id = v_person;
              else
                insert into company_people (company_id, person_id, title, work_email, work_phone, is_primary_contact)
                values (v_org, v_person, nullif(trim(r->>'title'), ''), v_email, nullif(trim(r->>'phone'), ''),
                        not exists (select 1 from company_people where company_id = v_org));
              end if;
            end if;
            n := jsonb_set(n, '{people_updated}', to_jsonb((n->>'people_updated')::int + 1));
          end if;
        end if;
        if v_person is null and (v_first is not null or v_email is not null) then
          new_person := true;
          insert into people (first_name, last_name, personal_email, personal_cell)
          values (coalesce(v_first, split_part(v_email, '@', 1)), v_last, case when v_org is null then v_email end,
                  case when v_org is null then nullif(trim(r->>'phone'), '') end)
          returning id into v_person;
          bump := 'people_new';
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
          if v_org is not null and not exists (select 1 from company_people where company_id = v_org and person_id = v_person) then
            insert into company_people (company_id, person_id, title, work_email, work_phone, is_primary_contact)
            values (v_org, v_person, nullif(trim(r->>'title'), ''), v_email, nullif(trim(r->>'phone'), ''),
                    not exists (select 1 from company_people where company_id = v_org));
          end if;
        end if;

        -- what this row looks like a duplicate of (existing records, or another row in this file)
        if new_org or new_person then
          m := private.import_dupe_matches(case when new_org then v_org end, case when new_person then v_person end);
          if m is not null and jsonb_array_length(dupes) < 1000 then dupes := dupes || jsonb_build_object('row', i, 'matches', m); end if;
        end if;

        if nullif(trim(r->>'note'), '') is not null then
          insert into activities (company_id, person_id, type, body) values (v_org, v_person, 'note', trim(r->>'note'));
          n := jsonb_set(n, '{notes}', to_jsonb((n->>'notes')::int + 1));
        end if;
      exception when others then
        errs := errs || jsonb_build_object('row', i, 'error', case when sqlerrm ilike '%row-level security%' then 'Only an admin can add pipelines or stages' else sqlerrm end);
      end;
    end loop;
    flagged := private.import_flag_count();
    if p_dry then raise exception 'IMPORT_DRY_RUN'; end if;
  exception when others then
    if sqlerrm <> 'IMPORT_DRY_RUN' then raise; end if;
  end;
  return n || jsonb_build_object('rows', i, 'errors', errs, 'dry', p_dry, 'flagged', flagged, 'dupes', dupes);
end $$;
