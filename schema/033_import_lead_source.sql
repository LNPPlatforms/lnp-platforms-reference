-- 033: imports give lead credit. Default is the person importing; an admin can credit a team member, a referral partner
-- or nobody. A Lead source column on a row wins for that row. Existing records only get a lead source where none is set.
-- Undo can put a lead source back even though lead sources are otherwise locked to admins.
alter function public.import_rows(jsonb, text, boolean, uuid, text) rename to import_rows_v2_retired;
revoke execute on function public.import_rows_v2_retired(jsonb, text, boolean, uuid, text) from public, anon, authenticated;
create or replace function public.import_rows(p_rows jsonb, p_kind text default 'contacts', p_dry boolean default false,
  p_batch uuid default null, p_file text default null, p_lead jsonb default null) returns jsonb
language plpgsql security invoker set search_path = public, private as $$
declare
  r jsonb; i int := 0; n jsonb := jsonb_build_object('orgs_new',0,'orgs_matched',0,'orgs_updated',0,'people_new',0,'people_matched',0,'people_updated',0,'pipelines_new',0,'stages_new',0,'notes',0);
  errs jsonb := '[]'::jsonb; v_org uuid; v_person uuid; v_pipe uuid; v_stage uuid; v_owner uuid; v_name text; v_first text; v_last text; v_email text; v_work text; v_pers text;
  v_types text[]; t uuid := private.current_tenant();
  bump text; flagged int := 0; seen jsonb := '{}'::jsonb; k text; new_org boolean; m jsonb; dupes jsonb := '[]'::jsonb; new_person boolean;
  -- p_kind: 'contacts' = Import (every row new, duplicates flagged); 'contacts:fill' / 'contacts:overwrite' = Import and Update
  adm boolean := private.is_admin(); d_kind text; d_user uuid; d_partner uuid; l_kind text; l_user uuid; l_partner uuid; x_id uuid; v_ls text; warns jsonb := '[]'::jsonb;
  upd boolean := p_kind in ('contacts:fill', 'contacts:overwrite'); ow boolean := p_kind = 'contacts:overwrite';
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_kind not in ('contacts', 'contacts:fill', 'contacts:overwrite') then raise exception 'That import type is not available yet'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 1000 then raise exception 'Send up to 1,000 rows at a time'; end if;
  -- a real run with a batch id is recorded so it can be undone for 48 hours
  -- lead source for the whole file: the person importing, unless an admin picks a team member, a referral partner or nobody.
  -- A Lead source column on a row (team member email or name, or referral partner name) wins for that row.
  d_kind := coalesce(nullif(p_lead->>'kind', ''), 'self');
  if d_kind not in ('self', 'internal', 'external', 'none') then raise exception 'Unknown lead source choice'; end if;
  if d_kind <> 'self' and not adm then raise exception 'Only an admin can give lead credit for an import to someone else'; end if;
  if d_kind = 'self' then d_user := auth.uid();
  elsif d_kind = 'internal' then
    select id into d_user from app_users where id = nullif(p_lead->>'user_id', '')::uuid and tenant_id = t and active and role not in ('vendor', 'member');
    if d_user is null then raise exception 'Pick the team member who gets lead credit'; end if;
    if d_user = auth.uid() then d_kind := 'self'; end if;
  elsif d_kind = 'external' then
    select id into d_partner from companies where id = nullif(p_lead->>'partner_id', '')::uuid and tenant_id = t and archived_at is null;
    if d_partner is null then raise exception 'Pick the referral partner who gets lead credit'; end if;
  end if;
  if not p_dry and p_batch is not null then
    perform private.import_batch_open(p_batch, p_kind, p_file);
    perform set_config('gelp.import_batch', p_batch::text, true);
  end if;
  begin
    for r in select value from jsonb_array_elements(p_rows) loop
      i := i + 1;
      begin
        v_org := null; v_person := null; v_pipe := null; v_stage := null; v_owner := null; new_org := false; new_person := false;
        v_name := nullif(trim(r->>'org_name'), '');
        -- emails: a column mapped to work or personal email wins; a plain Email column is sorted by its domain
        -- (Gmail, Yahoo, iCloud and the like are personal, anything else is work). With no organization, it's personal.
        v_email := lower(nullif(trim(r->>'email'), ''));
        v_work := lower(nullif(trim(r->>'work_email'), '')); v_pers := lower(nullif(trim(r->>'personal_email'), ''));
        if v_email is not null then
          if private.is_personal_email(v_email) then v_pers := coalesce(v_pers, v_email); else v_work := coalesce(v_work, v_email); end if;
        end if;
        if v_name is null then v_pers := coalesce(v_pers, v_work); v_work := null; end if;
        v_email := coalesce(v_work, v_pers);
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

        l_kind := d_kind; l_user := d_user; l_partner := d_partner;
        v_ls := nullif(trim(r->>'lead_source'), '');
        if v_ls is not null and v_name is not null then
          select id into x_id from app_users where tenant_id = t and active and role not in ('vendor', 'member')
             and (lower(email) = lower(v_ls) or lower(full_name) = lower(v_ls)) order by (lower(email) = lower(v_ls)) desc limit 1;
          if x_id is not null then
            l_kind := case when x_id = auth.uid() then 'self' else 'internal' end; l_user := x_id; l_partner := null;
          else
            select id into x_id from companies where tenant_id = t and archived_at is null and 'Referral Partner' = any (org_types) and lower(name) = lower(v_ls) limit 1;
            if x_id is not null then l_kind := 'external'; l_user := null; l_partner := x_id;
            elsif jsonb_array_length(warns) < 1000 then
              warns := warns || jsonb_build_object('row', i, 'warning', format('Lead source "%s" isn''t a team member or referral partner, so the default lead source was used', v_ls));
            end if;
          end if;
        end if;
        if l_kind = 'none' then l_kind := null; l_user := null; l_partner := null; end if;

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
              pipeline_stage_id = case when ow then coalesce(v_stage, c.pipeline_stage_id) else coalesce(c.pipeline_stage_id, v_stage) end,
              -- lead source is only ever filled in where none is set; an import never takes credit away
              lead_source_kind = case when c.lead_source_kind is null and c.lead_source_id is null and c.lead_source_partner_id is null then l_kind else c.lead_source_kind end,
              lead_source_id = case when c.lead_source_kind is null and c.lead_source_id is null and c.lead_source_partner_id is null then l_user else c.lead_source_id end,
              lead_source_partner_id = case when c.lead_source_kind is null and c.lead_source_id is null and c.lead_source_partner_id is null then l_partner else c.lead_source_partner_id end
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
          insert into companies (name, website, main_phone, fax, main_email, address, city, state, zip, specialty, owner_id, org_types, pipeline_stage_id,
                                 lead_source_kind, lead_source_id, lead_source_partner_id)
          values (v_name, nullif(trim(r->>'website'), ''), nullif(trim(r->>'main_phone'), ''), nullif(trim(r->>'fax'), ''), lower(nullif(trim(r->>'main_email'), '')),
                  nullif(trim(r->>'address'), ''), nullif(trim(r->>'city'), ''), upper(nullif(trim(r->>'state'), '')), nullif(trim(r->>'zip'), ''),
                  nullif(trim(r->>'specialty'), ''), coalesce(v_owner, auth.uid()), coalesce(v_types, '{Clinic}'), v_stage,
                  l_kind, l_user, l_partner)
          returning id into v_org;
          bump := 'orgs_new';
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
          seen := seen || jsonb_build_object(k, v_org); new_org := true;
        end if;

        -- contact
        -- Import and Update: a contact with the same email (or the same name at the matched organization) is updated
        if upd and (v_first is not null or v_email is not null) then
          if v_email is not null then
            select p.id into v_person from people p where p.tenant_id = t and p.archived_at is null and lower(p.personal_email) in (v_pers, v_work) limit 1;
            if v_person is null then
              select cp.person_id into v_person from company_people cp join people p on p.id = cp.person_id
               where cp.tenant_id = t and p.archived_at is null and lower(cp.work_email) in (v_work, v_pers) limit 1;
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
              personal_email = case when ow then coalesce(v_pers, p.personal_email) else coalesce(p.personal_email, v_pers) end,
              personal_cell = case when v_org is not null then p.personal_cell when ow then coalesce(nullif(trim(r->>'phone'), ''), p.personal_cell) else coalesce(p.personal_cell, nullif(trim(r->>'phone'), '')) end
             where p.id = v_person;
            if v_org is not null then
              if exists (select 1 from company_people where company_id = v_org and person_id = v_person) then
                update company_people cp set
                  title      = case when ow then coalesce(nullif(trim(r->>'title'), ''), cp.title) else coalesce(cp.title, nullif(trim(r->>'title'), '')) end,
                  work_email = case when ow then coalesce(v_work, cp.work_email) else coalesce(cp.work_email, v_work) end,
                  work_phone = case when ow then coalesce(nullif(trim(r->>'phone'), ''), cp.work_phone) else coalesce(cp.work_phone, nullif(trim(r->>'phone'), '')) end
                 where cp.company_id = v_org and cp.person_id = v_person;
              else
                insert into company_people (company_id, person_id, title, work_email, work_phone, is_primary_contact)
                values (v_org, v_person, nullif(trim(r->>'title'), ''), v_work, nullif(trim(r->>'phone'), ''),
                        not exists (select 1 from company_people where company_id = v_org));
              end if;
            end if;
            n := jsonb_set(n, '{people_updated}', to_jsonb((n->>'people_updated')::int + 1));
          end if;
        end if;
        if v_person is null and (v_first is not null or v_email is not null) then
          new_person := true;
          insert into people (first_name, last_name, personal_email, personal_cell)
          values (coalesce(v_first, split_part(v_email, '@', 1)), v_last, v_pers,
                  case when v_org is null then nullif(trim(r->>'phone'), '') end)
          returning id into v_person;
          bump := 'people_new';
          n := jsonb_set(n, array[bump], to_jsonb((n->>bump)::int + 1));
          if v_org is not null and not exists (select 1 from company_people where company_id = v_org and person_id = v_person) then
            insert into company_people (company_id, person_id, title, work_email, work_phone, is_primary_contact)
            values (v_org, v_person, nullif(trim(r->>'title'), ''), v_work, nullif(trim(r->>'phone'), ''),
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
    if not p_dry and p_batch is not null then perform private.import_batch_add(p_batch, n || jsonb_build_object('rows', i, 'flagged', flagged)); end if;
    if p_dry then raise exception 'IMPORT_DRY_RUN'; end if;
  exception when others then
    if sqlerrm <> 'IMPORT_DRY_RUN' then raise; end if;
  end;
  return n || jsonb_build_object('rows', i, 'errors', errs, 'dry', p_dry, 'flagged', flagged, 'dupes', dupes, 'warnings', warns);
end $$;

revoke execute on function public.import_rows(jsonb, text, boolean, uuid, text, jsonb) from public, anon;
grant execute on function public.import_rows(jsonb, text, boolean, uuid, text, jsonb) to authenticated;

create or replace function private.lock_lead_source() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('gelp.import_undo', true), '') <> '1'
     and (old.lead_source_id is not null or old.lead_source_partner_id is not null or old.lead_source_kind is not null)
     and (new.lead_source_id is distinct from old.lead_source_id
          or new.lead_source_partner_id is distinct from old.lead_source_partner_id
          or new.lead_source_kind is distinct from old.lead_source_kind)
     and not private.is_admin() then
    raise exception 'Only an admin can change the lead source once it is set';
  end if;
  return new;
end $$;
create or replace function public.import_undo(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare
  b private.import_batches%rowtype; c record; cur jsonb; ks text[]; back text[]; kept text[];
  res jsonb := jsonb_build_object('restored', 0, 'fields_kept', 0, 'archived', 0, 'links_left', 0, 'notes_left', 0);
  made_c uuid[]; made_p uuid[]; cnt int; kcnt int; skip constant text[] := array['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'stage_changed_at'];
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into b from private.import_batches where id = p_batch for update;
  if not found or b.tenant_id <> private.current_tenant() then raise exception 'Import not found'; end if;
  if b.undone_at is not null then raise exception 'This import was already undone'; end if;
  if b.created_at <= now() - interval '48 hours' then raise exception 'Imports can only be undone within 48 hours'; end if;
  if b.created_by is distinct from auth.uid() and not private.is_admin() then raise exception 'Only the person who ran this import, or an admin, can undo it'; end if;

  perform set_config('gelp.import_undo', '1', true);
  select coalesce(array_agg(row_id) filter (where tbl = 'companies'), '{}'), coalesce(array_agg(row_id) filter (where tbl = 'people'), '{}')
    into made_c, made_p from private.import_changes where batch_id = p_batch and op = 'insert';

  -- 1. put updated records back, field by field; a field someone changed after the import keeps their change
  for c in select * from private.import_changes where batch_id = p_batch and op = 'update' loop
    execute format('select to_jsonb(t) from public.%I t where t.id = $1', c.tbl) into cur using c.row_id;
    if cur is null or cur->>'tenant_id' <> b.tenant_id::text then continue; end if;
    select array_agg(k) into ks from jsonb_object_keys(c.after) k where k <> all (skip) and (c.before->k) is distinct from (c.after->k);
    if ks is null then continue; end if;
    select array_agg(k) filter (where (cur->k) is not distinct from (c.after->k)), array_agg(k) filter (where (cur->k) is distinct from (c.after->k))
      into back, kept from unnest(ks) k;
    if back is not null then
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) o where t.id = $2', c.tbl,
        (select string_agg(format('%I = o.%I', k, k), ', ') from unnest(back) k), c.tbl) using c.before, c.row_id;
      res := jsonb_set(res, '{restored}', to_jsonb((res->>'restored')::int + 1));
    end if;
    res := jsonb_set(res, '{fields_kept}', to_jsonb((res->>'fields_kept')::int + coalesce(array_length(kept, 1), 0)));
  end loop;

  -- 2. links and notes the import added to records that already existed come off (History keeps a copy)
  -- 2. links and notes the import added to records that already existed are left in place (never hard delete); counted so the person can see them
  select count(*) filter (where tbl = 'company_people'), count(*) filter (where tbl = 'activities') into cnt, kcnt
    from private.import_changes ic where ic.batch_id = p_batch and ic.op = 'insert' and ic.tbl in ('company_people', 'activities')
     and not (coalesce((ic.after->>'company_id')::uuid = any (made_c), false) or coalesce((ic.after->>'person_id')::uuid = any (made_p), false));
  res := res || jsonb_build_object('links_left', cnt, 'notes_left', kcnt);

  update public.companies set archived_at = now(), archived_by = auth.uid(), archive_reason = 'Import undone', archive_status = 'archived'
   where id = any (made_c) and tenant_id = b.tenant_id and archived_at is null;
  get diagnostics cnt = row_count;
  res := jsonb_set(res, '{archived}', to_jsonb(cnt));
  update public.people set archived_at = now(), archived_by = auth.uid(), archive_reason = 'Import undone', archive_status = 'archived'
   where id = any (made_p) and tenant_id = b.tenant_id and archived_at is null;
  get diagnostics cnt = row_count;
  res := jsonb_set(res, '{archived}', to_jsonb((res->>'archived')::int + cnt));
  update public.review_items set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Import undone'
   where status = 'open' and tenant_id = b.tenant_id
     and ((entity = 'companies' and (entity_id = any (made_c) or related_id = any (made_c)))
       or (entity = 'people' and (entity_id = any (made_p) or related_id = any (made_p))));

  update private.import_batches set undone_at = now(), undone_by = auth.uid(), undo_result = res where id = p_batch;
  return res;
end $$;
