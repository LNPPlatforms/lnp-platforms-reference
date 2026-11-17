-- 112: booking answers save to custom fields, and side-by-side duplicate merge (Nov 16, 2026).
-- A booking question can point at a custom field on the person or the organization ("people:key" or "companies:key").
--   When someone books, answers fill fields that are blank on file. If any answer disagrees with what's on file,
--   nothing on the old record changes: a new person (or organization) is made with the answers, the appointment goes on
--   it, and Review gets a possible duplicate so someone can compare and merge.
-- Merging (merge_pick): pick, field by field, which value to keep. Blank fields fill from the other record. Every value
--   that loses goes into a note on the kept record ("Merge: kept X, replaced Y, approved by <name>"), then the usual
--   merge moves contacts, notes, tasks and appointments over and archives the other record.

-- ---------- calendar questions remember their field ----------
do $$ declare d text; n text;
begin
  d := pg_get_functiondef('public.calendar_save(uuid, jsonb)'::regprocedure);
  n := replace(d, '''required'', coalesce((q->>''required'')::boolean, false)));',
    '''required'', coalesce((q->>''required'')::boolean, false),
      ''field'', case when coalesce(q->>''field'', '''') ~ ''^(people|companies):[a-z][a-z0-9_]{0,39}$''
        and exists (select 1 from custom_fields f where f.tenant_id = t and f.archived_at is null
                     and f.entity = split_part(q->>''field'', '':'', 1) and f.key = split_part(q->>''field'', '':'', 2)) then q->>''field'' end));');
  if n = d then raise exception 'calendar_save did not match; nothing changed'; end if;
  execute n;
end $$;

-- an answer as the field's type wants it (number, yes/no, list), or null when it can't be read that way
create or replace function private.cf_value(p_type text, v text) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if v is null or trim(v) = '' then return null; end if;
  if p_type in ('number', 'money') then return to_jsonb(replace(replace(trim(v), '$', ''), ',', '')::numeric); end if;
  if p_type = 'checkbox' then return to_jsonb(lower(trim(v)) in ('yes', 'y', 'true', '1', 'checked')); end if;
  if p_type = 'multi_select' then return to_jsonb(array(select trim(x) from unnest(string_to_array(v, ',')) x where trim(x) <> '')); end if;
  if p_type = 'date' then return to_jsonb(trim(v)::date::text); end if;
  return to_jsonb(trim(v));
exception when others then return to_jsonb(trim(v));
end $$;

-- same value? text compares ignoring case and spaces; numbers and lists by value
create or replace function private.cf_same(a jsonb, b jsonb) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case when a is null or b is null or a = 'null'::jsonb or b = 'null'::jsonb then true
              when jsonb_typeof(a) = 'string' and jsonb_typeof(b) = 'string' then lower(trim(a #>> '{}')) = lower(trim(b #>> '{}'))
              else a = b end
$$;

create or replace function private.cal_fill(c public.calendars, p_ans jsonb, p_person uuid, p_company uuid, p_name text, p_email text, p_phone text,
  out o_person uuid, out o_company uuid)
language plpgsql security definer set search_path = public, private as $$
declare q jsonb; a jsonb; ent text; fk text; ftype text; v jsonb; cur jsonb;
  fill_p jsonb := '{}'; fill_c jsonb := '{}'; all_p jsonb := '{}'; all_c jsonb := '{}';
  clash_p text[] := '{}'; clash_c text[] := '{}'; v_first text; v_last text; co_name text;
begin
  o_person := p_person; o_company := p_company;
  for q in select * from jsonb_array_elements(coalesce(c.questions, '[]')) loop
    continue when coalesce(q->>'field', '') = '';
    select x into a from jsonb_array_elements(coalesce(p_ans, '[]')) x where x->>'key' = q->>'key' limit 1;
    continue when a is null;
    ent := split_part(q->>'field', ':', 1); fk := split_part(q->>'field', ':', 2);
    select type into ftype from custom_fields where tenant_id = c.tenant_id and entity = ent and key = fk and archived_at is null;
    continue when ftype is null;
    v := private.cf_value(ftype, a->>'value');
    continue when v is null;
    if ent = 'people' then
      all_p := all_p || jsonb_build_object(fk, v);
      select custom->fk into cur from people where id = p_person;
      if cur is null or cur = 'null'::jsonb or cur #>> '{}' = '' then fill_p := fill_p || jsonb_build_object(fk, v);
      elsif not private.cf_same(cur, v) then clash_p := clash_p || (q->>'label'); end if;
    elsif ent = 'companies' and p_company is not null then
      all_c := all_c || jsonb_build_object(fk, v);
      select custom->fk into cur from companies where id = p_company;
      if cur is null or cur = 'null'::jsonb or cur #>> '{}' = '' then fill_c := fill_c || jsonb_build_object(fk, v);
      elsif not private.cf_same(cur, v) then clash_c := clash_c || (q->>'label'); end if;
    end if;
  end loop;

  if cardinality(clash_p) = 0 and fill_p <> '{}' then update people set custom = custom || fill_p where id = p_person; end if;
  if cardinality(clash_c) = 0 and fill_c <> '{}' then update companies set custom = custom || fill_c where id = p_company; end if;

  -- answers that disagree: a new record with them, flagged so someone can compare and merge
  if cardinality(clash_p) > 0 then
    v_first := nullif(left(split_part(trim(p_name), ' ', 1), 80), '');
    v_last := nullif(left(trim(substr(trim(p_name), length(split_part(trim(p_name), ' ', 1)) + 1)), 80), '');
    insert into people (tenant_id, first_name, last_name, personal_email, personal_cell, custom, created_by)
    values (c.tenant_id, coalesce(v_first, 'Guest'), v_last, p_email, p_phone, all_p, null) returning id into o_person;
    if p_company is not null then
      insert into company_people (tenant_id, company_id, person_id, work_email, work_phone) values (c.tenant_id, p_company, o_person, p_email, p_phone)
      on conflict do nothing;
    end if;
    insert into review_items (kind, entity, entity_id, related_id, reason, details, created_by, tenant_id)
    values ('possible_duplicate', 'people', o_person, p_person, 'Booking answers differ from what''s on file: ' || array_to_string(clash_p, ', '),
            jsonb_build_object('source', 'booking', 'calendar', c.name), null, c.tenant_id);
  end if;
  if cardinality(clash_c) > 0 then
    select name into co_name from companies where id = p_company;
    insert into companies (tenant_id, name, custom, lead_source_kind, lead_source_channel, created_by)
    values (c.tenant_id, co_name, all_c, 'system', left('Booking: ' || c.name, 120), null) returning id into o_company;
    insert into company_people (tenant_id, company_id, person_id, work_email, work_phone) values (c.tenant_id, o_company, o_person, p_email, p_phone)
    on conflict do nothing;
    insert into review_items (kind, entity, entity_id, related_id, reason, details, created_by, tenant_id)
    values ('possible_duplicate', 'companies', o_company, p_company, 'Booking answers differ from what''s on file: ' || array_to_string(clash_c, ', '),
            jsonb_build_object('source', 'booking', 'calendar', c.name), null, c.tenant_id);
  end if;
end $$;
revoke execute on function private.cal_fill(public.calendars, jsonb, uuid, uuid, text, text, text), private.cf_value(text, text), private.cf_same(jsonb, jsonb) from public, anon, authenticated;

do $$ declare d text; n text;
begin
  d := pg_get_functiondef('private.cal_book(public.calendars, timestamptz, int, uuid, jsonb, text, text)'::regprocedure);
  n := replace(d, 'select * into ct from private.cal_contact(c.tenant_id, v_name, v_email, v_phone, v_co, ''Booking: '' || c.name);',
    'select * into ct from private.cal_contact(c.tenant_id, v_name, v_email, v_phone, v_co, ''Booking: '' || c.name);
  select * into ct from private.cal_fill(c, ans, ct.o_person, ct.o_company, v_name, v_email, v_phone);');
  if n = d then raise exception 'cal_book did not match; nothing changed'; end if;
  execute n;
end $$;

-- ---------- side-by-side merge ----------
-- p_take: the fields to take from the record going away, e.g. ["personal_cell", "custom.shirt_size"]. Everything else
-- keeps the kept record's value, except blanks, which fill from the other one.
create or replace function public.merge_pick(p_entity text, p_keep uuid, p_drop uuid, p_take jsonb default '[]') returns void
language plpgsql security definer set search_path = public, private as $$
declare cols text[]; col text; kv text; dv text; lines text[] := '{}'; k_custom jsonb; d_custom jsonb; ck text; lbl text;
  take text[] := array(select jsonb_array_elements_text(coalesce(p_take, '[]'))); keep_name text; drop_name text; me text; co uuid;
  labels jsonb := '{"first_name":"First name","last_name":"Last name","personal_cell":"Cell","personal_email":"Email","preferred_contact_method":"Preferred contact",
    "name":"Name","specialty":"Specialty","address":"Address","city":"City","state":"State","zip":"Zip","main_phone":"Main phone","fax":"Fax","main_email":"Main email","website":"Website"}';
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  if p_entity = 'people' then cols := array['first_name', 'last_name', 'personal_cell', 'personal_email', 'preferred_contact_method'];
  elsif p_entity = 'companies' then cols := array['name', 'specialty', 'address', 'city', 'state', 'zip', 'main_phone', 'fax', 'main_email', 'website'];
  else raise exception 'Bad request'; end if;
  if p_keep = p_drop then raise exception 'Pick two different records'; end if;
  execute format('select count(*) = 2 from %I where id in ($1, $2) and tenant_id = private.current_tenant()', p_entity) into strict kv using p_keep, p_drop;
  if kv <> 'true' then raise exception 'Record not found'; end if;
  select full_name into me from app_users where id = auth.uid();

  foreach col in array cols loop
    execute format('select %1$I::text from %2$I where id = $1', col, p_entity) into kv using p_keep;
    execute format('select %1$I::text from %2$I where id = $1', col, p_entity) into dv using p_drop;
    continue when nullif(trim(coalesce(dv, '')), '') is null or lower(trim(coalesce(kv, ''))) = lower(trim(dv));
    if nullif(trim(coalesce(kv, '')), '') is null or col = any (take) then
      execute format('update %I set %I = $1 where id = $2', p_entity, col) using dv, p_keep;
      if nullif(trim(coalesce(kv, '')), '') is not null then lines := lines || format('%s: kept "%s", replaced "%s"', labels->>col, dv, kv); end if;
    else
      lines := lines || format('%s: kept "%s", replaced "%s"', labels->>col, kv, dv);
    end if;
  end loop;

  execute format('select custom from %I where id = $1', p_entity) into k_custom using p_keep;
  execute format('select custom from %I where id = $1', p_entity) into d_custom using p_drop;
  for ck in select jsonb_object_keys(coalesce(d_custom, '{}')) loop
    continue when d_custom->ck is null or d_custom->ck = 'null'::jsonb or d_custom->>ck = '';
    select coalesce((select label from custom_fields where tenant_id = private.current_tenant() and entity = p_entity and key = ck), ck) into lbl;
    if k_custom->ck is null or k_custom->ck = 'null'::jsonb or k_custom->>ck = '' then k_custom := coalesce(k_custom, '{}') || jsonb_build_object(ck, d_custom->ck);
    elsif not private.cf_same(k_custom->ck, d_custom->ck) then
      if ('custom.' || ck) = any (take) then
        lines := lines || format('%s: kept "%s", replaced "%s"', lbl, d_custom->>ck, k_custom->>ck);
        k_custom := k_custom || jsonb_build_object(ck, d_custom->ck);
      else lines := lines || format('%s: kept "%s", replaced "%s"', lbl, k_custom->>ck, d_custom->>ck); end if;
    end if;
  end loop;
  execute format('update %I set custom = $1 where id = $2', p_entity) using coalesce(k_custom, '{}'), p_keep;

  if p_entity = 'people' then
    select concat_ws(' ', first_name, last_name) into keep_name from people where id = p_keep;
    select concat_ws(' ', first_name, last_name) into drop_name from people where id = p_drop;
    update appointments set person_id = p_keep where person_id = p_drop;
    select company_id into co from company_people where person_id = p_keep order by is_primary_contact desc nulls last limit 1;
    insert into activities (company_id, person_id, type, body, created_by, tenant_id)
    values (co, p_keep, 'note', 'Merge: ' || coalesce(drop_name, 'a duplicate') || ' merged into this record, approved by ' || coalesce(me, 'an admin') || '.'
      || case when cardinality(lines) > 0 then E'\n' || array_to_string(lines, E'\n') else '' end, auth.uid(), private.current_tenant());
  else
    select name into keep_name from companies where id = p_keep;
    select name into drop_name from companies where id = p_drop;
    update appointments set company_id = p_keep where company_id = p_drop;
    insert into activities (company_id, type, body, created_by, tenant_id)
    values (p_keep, 'note', 'Merge: ' || coalesce(drop_name, 'a duplicate') || ' merged into this record, approved by ' || coalesce(me, 'an admin') || '.'
      || case when cardinality(lines) > 0 then E'\n' || array_to_string(lines, E'\n') else '' end, auth.uid(), private.current_tenant());
  end if;
  perform public.merge_records(p_entity, p_keep, p_drop);
end $$;
revoke execute on function public.merge_pick(text, uuid, uuid, jsonb) from public, anon;
grant execute on function public.merge_pick(text, uuid, uuid, jsonb) to authenticated;
