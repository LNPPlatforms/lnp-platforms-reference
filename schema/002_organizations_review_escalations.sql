-- GELP CRM v2: organizations with types, lead source picker + lock, admin flag,
-- reporting lines, archive instead of removal, review queue, escalations, editable lists.

-- ============================================================
-- USERS: admin is a flag, not a role; reporting lines
-- ============================================================
alter table app_users add column if not exists is_admin boolean not null default false;
alter table app_users add column if not exists manager_id uuid references app_users(id);
update app_users set is_admin = true where role = 'admin';
update app_users set role = 'staff' where role in ('admin', 'salesperson', 'contractor');

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select is_admin from app_users where id = auth.uid() and active and role <> 'vendor'), false)
$$;

create or replace function private.is_internal() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select role <> 'vendor' from app_users where id = auth.uid() and active), false)
$$;

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  insert into public.app_users (id, full_name, email, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.email, 'staff', false)
  on conflict (id) do nothing;
  return new;
end $$;

-- ============================================================
-- ORGANIZATIONS (the companies table): types, stage, lead source kinds, archive
-- ============================================================
alter table companies add column if not exists org_types text[] not null default '{Clinic}';
alter table companies add column if not exists stage text default 'Lead';
alter table companies add column if not exists lead_source_kind text
  check (lead_source_kind in ('self','internal','external','system'));
alter table companies add column if not exists lead_source_partner_id uuid references companies(id);
alter table companies add column if not exists archive_status text check (archive_status in ('pending','archived'));
alter table companies add column if not exists archived_at timestamptz;
alter table companies add column if not exists archived_by uuid references app_users(id);
alter table companies add column if not exists archive_reason text;
update companies set stage = 'Lead' where stage is null;
update companies set lead_source_kind = 'internal' where lead_source_id is not null and lead_source_kind is null;
create index if not exists companies_org_types_idx on companies using gin (org_types);
create index if not exists companies_stage_idx on companies (stage);
create index if not exists companies_archived_idx on companies (archived_at);

alter table people add column if not exists archive_status text check (archive_status in ('pending','archived'));
alter table people add column if not exists archived_at timestamptz;
alter table people add column if not exists archived_by uuid references app_users(id);
alter table people add column if not exists archive_reason text;
create index if not exists people_archived_idx on people (archived_at);

-- Lead source locks once set. Only an admin can change it. (Migrations/service role bypass: auth.uid() is null.)
create or replace function private.lock_lead_source() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is not null
     and (old.lead_source_id is not null or old.lead_source_partner_id is not null or old.lead_source_kind is not null)
     and (new.lead_source_id is distinct from old.lead_source_id
          or new.lead_source_partner_id is distinct from old.lead_source_partner_id
          or new.lead_source_kind is distinct from old.lead_source_kind)
     and not private.is_admin() then
    raise exception 'Only an admin can change the lead source once it is set';
  end if;
  return new;
end $$;
create trigger companies_lock_lead_source before update on companies
  for each row execute function private.lock_lead_source();

-- ============================================================
-- REVIEW QUEUE (admin only)
-- ============================================================
create table if not exists review_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('possible_duplicate','delete_request','import_issue')),
  entity text not null check (entity in ('companies','people')),
  entity_id uuid not null,
  related_id uuid,
  reason text,
  details jsonb,
  status text not null default 'open' check (status in ('open','approved','denied','resolved')),
  created_by uuid references app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  resolved_by uuid references app_users(id),
  resolved_at timestamptz,
  resolution text
);
create index if not exists review_items_open_idx on review_items (status, created_at desc);
alter table review_items enable row level security;
create policy "admin read review" on review_items for select using (private.is_admin());
create policy "admin update review" on review_items for update using (private.is_admin()) with check (private.is_admin());
grant select, update on review_items to authenticated;

-- ============================================================
-- ESCALATIONS
-- ============================================================
create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  from_user uuid not null references app_users(id) default auth.uid(),
  to_user uuid not null references app_users(id),
  reason text,
  note text,
  status text not null default 'open' check (status in ('open','cleared')),
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references app_users(id)
);
create index if not exists escalations_to_idx on escalations (to_user, status, created_at desc);
create index if not exists escalations_company_idx on escalations (company_id);
alter table escalations enable row level security;
create policy "escalation read" on escalations for select
  using (private.is_internal() and (from_user = auth.uid() or to_user = auth.uid() or private.is_admin()));
create policy "escalation create" on escalations for insert
  with check (private.is_internal() and from_user = auth.uid());
create policy "escalation clear" on escalations for update
  using (private.is_internal() and (to_user = auth.uid() or private.is_admin()))
  with check (private.is_internal() and (to_user = auth.uid() or private.is_admin()));
grant select, insert, update on escalations to authenticated;

-- ============================================================
-- ROW LEVEL SECURITY: archived/pending records hidden from everyone but admins
-- ============================================================
alter policy "internal all companies" on companies
  using (private.is_internal() and (archived_at is null or private.is_admin()))
  with check (private.is_internal() and (archived_at is null or private.is_admin()));
alter policy "vendor read assigned companies" on companies
  using (archived_at is null and private.vendor_can_see_company(id));

alter policy "internal all people" on people
  using (private.is_internal() and (archived_at is null or private.is_admin()))
  with check (private.is_internal() and (archived_at is null or private.is_admin()));
alter policy "vendor read people" on people using (archived_at is null and exists (
  select 1 from company_people cp where cp.person_id = people.id and private.vendor_can_see_company(cp.company_id)));

-- ============================================================
-- DUPLICATE DETECTION (flags only, never merges)
-- ============================================================
create or replace function private.norm(t text) returns text
language sql immutable as $$ select nullif(regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]', '', 'g'), '') $$;
create or replace function private.street_key(addr text, city text) returns text
language sql immutable as $$
  select case when substring(coalesce(addr,'') from '^\s*(\d+)') is null or private.norm(city) is null then null
    else substring(addr from '^\s*(\d+)') || '|' || private.norm(split_part(regexp_replace(trim(addr), '^\d+\s*', ''), ' ', 1)) || '|' || private.norm(city) end
$$;

create or replace function private.flag_company_dupes() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare m record;
begin
  if 'Referral Partner' = any(new.org_types) and array_length(new.org_types,1) = 1 then return new; end if;
  for m in
    select c.id, c.name from companies c
    where c.id <> new.id and c.archived_at is null
      and (
        (private.norm(c.name) = private.norm(new.name)
          and (c.city is null or new.city is null or private.norm(c.city) = private.norm(new.city)))
        or (private.street_key(new.address, new.city) is not null
          and private.street_key(c.address, c.city) = private.street_key(new.address, new.city)
          and private.norm(c.name) = private.norm(new.name))
      )
    limit 5
  loop
    insert into review_items (kind, entity, entity_id, related_id, reason, created_by)
    values ('possible_duplicate', 'companies', new.id, m.id,
            'Same name' || case when new.city is not null then ' and city' else '' end || ' as an existing organization', auth.uid());
  end loop;
  return new;
end $$;
create trigger companies_flag_dupes after insert on companies for each row execute function private.flag_company_dupes();

create or replace function private.flag_people_dupes() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare m record; cell text := right(regexp_replace(coalesce(new.personal_cell,''), '\D', '', 'g'), 10);
begin
  for m in
    select p.id from people p
    where p.id <> new.id and p.archived_at is null
      and ((length(cell) = 10 and right(regexp_replace(coalesce(p.personal_cell,''), '\D', '', 'g'), 10) = cell)
        or (new.personal_email is not null and lower(p.personal_email) = lower(new.personal_email)))
    limit 5
  loop
    insert into review_items (kind, entity, entity_id, related_id, reason, created_by)
    values ('possible_duplicate', 'people', new.id, m.id, 'Same cell phone or email as an existing person', auth.uid());
  end loop;
  return new;
end $$;
create trigger people_flag_dupes after insert on people for each row execute function private.flag_people_dupes();

-- Anyone on the team can flag a suspected duplicate; only admins act on it.
create or replace function public.flag_duplicate(p_entity text, p_id uuid, p_other uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if p_entity not in ('companies','people') or p_id = p_other then raise exception 'Bad request'; end if;
  insert into review_items (kind, entity, entity_id, related_id, reason, created_by)
  values ('possible_duplicate', p_entity, p_id, p_other, coalesce(nullif(trim(p_note),''), 'Flagged by a team member'), auth.uid());
end $$;

-- ============================================================
-- Removal = archive. Non-admins request; admins approve. Nothing is ever destroyed.
-- ============================================================
create or replace function public.request_delete(p_entity text, p_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = public, private as $$
declare adm boolean := private.is_admin();
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'A reason is required'; end if;
  if p_entity = 'companies' then
    update companies set archived_at = now(), archived_by = auth.uid(), archive_reason = trim(p_reason),
      archive_status = case when adm then 'archived' else 'pending' end
    where id = p_id and archived_at is null;
  elsif p_entity = 'people' then
    update people set archived_at = now(), archived_by = auth.uid(), archive_reason = trim(p_reason),
      archive_status = case when adm then 'archived' else 'pending' end
    where id = p_id and archived_at is null;
  else raise exception 'Bad request'; end if;
  if not found then raise exception 'Record not found'; end if;
  if not adm then
    insert into review_items (kind, entity, entity_id, reason, created_by)
    values ('delete_request', p_entity, p_id, trim(p_reason), auth.uid());
    return 'pending';
  end if;
  return 'archived';
end $$;

create or replace function public.restore_record(p_entity text, p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  if p_entity = 'companies' then
    update companies set archived_at = null, archived_by = null, archive_reason = null, archive_status = null where id = p_id;
  elsif p_entity = 'people' then
    update people set archived_at = null, archived_by = null, archive_reason = null, archive_status = null where id = p_id;
  else raise exception 'Bad request'; end if;
  update review_items set status = 'denied', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Restored'
  where entity = p_entity and entity_id = p_id and kind = 'delete_request' and status = 'open';
end $$;

create or replace function public.resolve_review(p_item uuid, p_decision text) returns void
language plpgsql security definer set search_path = public, private as $$
declare r review_items%rowtype;
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  select * into r from review_items where id = p_item and status = 'open';
  if not found then raise exception 'Item not found or already handled'; end if;
  if r.kind = 'delete_request' then
    if p_decision = 'approve' then
      if r.entity = 'companies' then update companies set archive_status = 'archived' where id = r.entity_id;
      else update people set archive_status = 'archived' where id = r.entity_id; end if;
      update review_items set status = 'approved', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Archived' where id = p_item;
    elsif p_decision = 'deny' then
      perform public.restore_record(r.entity, r.entity_id);
      update review_items set status = 'denied', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Kept' where id = p_item;
    else raise exception 'Bad decision'; end if;
  else
    if p_decision not in ('dismiss','resolve') then raise exception 'Bad decision'; end if;
    update review_items set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
      resolution = case when p_decision = 'dismiss' then 'Not a duplicate' else 'Resolved' end where id = p_item;
  end if;
end $$;

-- Merge: everything moves to the keeper, the other is archived (never destroyed).
create or replace function public.merge_records(p_entity text, p_keep uuid, p_drop uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare keep_name text;
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  if p_keep = p_drop then raise exception 'Pick two different records'; end if;
  if p_entity = 'companies' then
    select name into keep_name from companies where id = p_keep;
    update company_people set company_id = p_keep
      where company_id = p_drop and person_id not in (select person_id from company_people where company_id = p_keep);
    update opportunities set company_id = p_keep where company_id = p_drop;
    update activities set company_id = p_keep where company_id = p_drop;
    update tasks set company_id = p_keep where company_id = p_drop;
    update escalations set company_id = p_keep where company_id = p_drop;
    update vendor_companies set company_id = p_keep
      where company_id = p_drop and vendor_id not in (select vendor_id from vendor_companies where company_id = p_keep);
    update companies set parent_company_id = p_keep where parent_company_id = p_drop;
    update companies set lead_source_partner_id = p_keep where lead_source_partner_id = p_drop;
    update companies k set
      address = coalesce(k.address, d.address), city = coalesce(k.city, d.city), state = coalesce(k.state, d.state),
      zip = coalesce(k.zip, d.zip), main_phone = coalesce(k.main_phone, d.main_phone), fax = coalesce(k.fax, d.fax),
      main_email = coalesce(k.main_email, d.main_email), website = coalesce(k.website, d.website),
      specialty = coalesce(k.specialty, d.specialty),
      org_types = (select array(select distinct unnest(k.org_types || d.org_types))),
      notes = nullif(concat_ws(E'\n', k.notes, d.notes), '')
    from companies d where k.id = p_keep and d.id = p_drop;
    update companies set archived_at = now(), archived_by = auth.uid(), archive_status = 'archived',
      archive_reason = 'Merged into ' || coalesce(keep_name, 'another organization') where id = p_drop;
  elsif p_entity = 'people' then
    select concat_ws(' ', first_name, last_name) into keep_name from people where id = p_keep;
    update company_people set person_id = p_keep
      where person_id = p_drop and company_id not in (select company_id from company_people where person_id = p_keep);
    update activities set person_id = p_keep where person_id = p_drop;
    update tasks set person_id = p_keep where person_id = p_drop;
    update people k set personal_cell = coalesce(k.personal_cell, d.personal_cell), personal_email = coalesce(k.personal_email, d.personal_email),
      preferred_contact_method = coalesce(k.preferred_contact_method, d.preferred_contact_method),
      notes = nullif(concat_ws(E'\n', k.notes, d.notes), '')
    from people d where k.id = p_keep and d.id = p_drop;
    update people set archived_at = now(), archived_by = auth.uid(), archive_status = 'archived',
      archive_reason = 'Merged into ' || coalesce(keep_name, 'another person') where id = p_drop;
  else raise exception 'Bad request'; end if;
  update review_items set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution = 'Merged'
  where entity = p_entity and status = 'open' and kind = 'possible_duplicate'
    and (entity_id in (p_keep, p_drop) and related_id in (p_keep, p_drop));
end $$;

-- ============================================================
-- EDITABLE LISTS: rename carries through to records that use the value
-- ============================================================
create or replace function public.rename_lookup(p_list text, p_old text, p_new text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  if coalesce(trim(p_new),'') = '' then raise exception 'Name required'; end if;
  update lookup_values set label = trim(p_new) where list_name = p_list and label = p_old;
  case p_list
    when 'org_type' then update companies set org_types = array_replace(org_types, p_old, trim(p_new)) where p_old = any(org_types);
    when 'org_stage' then update companies set stage = trim(p_new) where stage = p_old;
    when 'specialty' then update companies set specialty = trim(p_new) where specialty = p_old;
    when 'interest_level' then update companies set interest_level = trim(p_new) where interest_level = p_old;
    when 'lead_channel' then update companies set lead_source_channel = trim(p_new) where lead_source_channel = p_old;
    when 'contact_role' then update company_people set role = trim(p_new) where role = p_old;
    when 'service' then update opportunities set service = trim(p_new) where service = p_old;
    when 'opportunity_status' then update opportunities set status = trim(p_new) where status = p_old;
    when 'preferred_contact' then update people set preferred_contact_method = trim(p_new) where preferred_contact_method = p_old;
    when 'escalation_reason' then update escalations set reason = trim(p_new) where reason = p_old;
    else null;
  end case;
end $$;

insert into lookup_values (list_name, label, sort_order) values
('org_type','Clinic',1),('org_type','Vendor',2),('org_type','Referral Partner',3),
('org_stage','Lead',1),('org_stage','Contacted',2),('org_stage','Met',3),('org_stage','Interested',4),
('org_stage','Demo / Assessment',5),('org_stage','Proposal',6),('org_stage','Signed',7),
('org_stage','Follow-Up Later',8),('org_stage','Not Interested',9),
('lead_channel','Door knock',1),('lead_channel','Referral',2),('lead_channel','RLX network',3),('lead_channel','Event',4),
('lead_channel','Phone',5),('lead_channel','Email',6),('lead_channel','Existing relationship',7),('lead_channel','Other',8),
('escalation_reason','Deal stalled',1),('escalation_reason','Price objection',2),('escalation_reason','Needs a service I can''t sell',3),
('escalation_reason','Need help reaching the decision maker',4),('escalation_reason','Contract or legal question',5),('escalation_reason','Other',6)
on conflict (list_name, label) do nothing;

-- ============================================================
-- QUICK ENTRY v3: org types, stage, lead source kind/partner
-- ============================================================
create or replace function public.quick_entry(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  cid uuid := nullif(p->>'company_id','')::uuid;
  c jsonb; pid uuid; svc text;
  me uuid := auth.uid();
  kind text := coalesce(nullif(p->>'lead_source_kind',''), 'self');
  ls_user uuid; ls_partner uuid;
  types text[];
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;

  if cid is null then
    if kind = 'self' then ls_user := me;
    elsif kind = 'internal' then ls_user := nullif(p->>'lead_source_id','')::uuid;
    elsif kind = 'external' then ls_partner := nullif(p->>'lead_source_partner_id','')::uuid;
    end if;
    if kind = 'internal' and ls_user is null then raise exception 'Pick who the lead came from'; end if;
    if kind = 'external' and ls_partner is null then raise exception 'Pick the referral partner'; end if;
    select coalesce(array_agg(distinct trim(t)) filter (where coalesce(trim(t),'') <> ''), '{Clinic}') into types
      from jsonb_array_elements_text(case when jsonb_typeof(p->'company'->'org_types') = 'array'
        then p->'company'->'org_types' else '["Clinic"]'::jsonb end) t;
    insert into companies (name, org_types, stage, specialty, address, city, state, zip, main_phone, owner_id,
                           lead_source_kind, lead_source_id, lead_source_partner_id, lead_source_channel)
    values (trim(p->'company'->>'name'), types, coalesce(nullif(p->'company'->>'stage',''), 'Lead'),
            nullif(p->'company'->>'specialty',''), nullif(trim(p->'company'->>'address'),''),
            nullif(trim(p->'company'->>'city'),''), nullif(upper(trim(p->'company'->>'state')),''), nullif(trim(p->'company'->>'zip'),''),
            nullif(p->'company'->>'main_phone',''), coalesce(nullif(p->>'owner_id','')::uuid, me),
            kind, ls_user, ls_partner, nullif(p->>'lead_source_channel',''))
    returning id into cid;
  end if;

  for c in select * from jsonb_array_elements(case when jsonb_typeof(p->'contacts') = 'array' then p->'contacts' else '[]'::jsonb end) loop
    pid := nullif(c->>'person_id','')::uuid;
    if pid is null then
      if coalesce(trim(c->>'first_name'),'') = '' then continue; end if;
      insert into people (first_name, last_name, personal_cell, personal_email, preferred_contact_method)
      values (trim(c->>'first_name'), nullif(trim(c->>'last_name'),''), nullif(c->>'cell',''),
              nullif(lower(c->>'email'),''), nullif(c->>'preferred_contact',''))
      returning id into pid;
    end if;
    insert into company_people (company_id, person_id, title, role, work_phone, work_email, is_decision_maker, is_primary_contact)
    values (cid, pid, nullif(c->>'title',''), nullif(c->>'role',''), nullif(c->>'work_phone',''),
            nullif(lower(c->>'work_email'),''), coalesce((c->>'is_decision_maker')::boolean,false),
            coalesce((c->>'is_primary_contact')::boolean,false))
    on conflict (company_id, person_id) do update set
      title = coalesce(excluded.title, company_people.title),
      role = coalesce(excluded.role, company_people.role),
      is_decision_maker = company_people.is_decision_maker or excluded.is_decision_maker,
      is_primary_contact = company_people.is_primary_contact or excluded.is_primary_contact;
  end loop;

  for svc in select jsonb_array_elements_text(case when jsonb_typeof(p->'services') = 'array' then p->'services' else '[]'::jsonb end) loop
    if not exists (select 1 from opportunities where company_id = cid and service = svc) then
      insert into opportunities (company_id, service, status, owner_id, lead_source_id)
      select cid, svc, 'Interested', co.owner_id, co.lead_source_id from companies co where co.id = cid;
    end if;
  end loop;

  if coalesce(trim(p->>'notes'),'') <> '' then
    insert into activities (company_id, type, body) values (cid, coalesce(nullif(p->>'activity_type',''),'visit'), trim(p->>'notes'));
  end if;

  update companies set
    last_contact_date = current_date,
    next_step = coalesce(nullif(trim(p->>'next_step'),''), next_step),
    follow_up_date = coalesce(nullif(p->>'follow_up_date','')::date, follow_up_date)
  where id = cid;

  if nullif(p->>'follow_up_date','') is not null then
    insert into tasks (company_id, title, due_date, assigned_to)
    values (cid, coalesce(nullif(trim(p->>'next_step'),''), 'Follow up'), (p->>'follow_up_date')::date, me);
  end if;

  return cid;
end $$;

-- Filter options that come from the data itself
create or replace function public.company_facets() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'states', (select coalesce(jsonb_agg(jsonb_build_object('v', state, 'n', n) order by n desc), '[]') from
               (select state, count(*) n from companies where archived_at is null and coalesce(state,'') <> '' group by state) s),
    'specialties', (select coalesce(jsonb_agg(jsonb_build_object('v', specialty, 'n', n) order by specialty), '[]') from
               (select specialty, count(*) n from companies where archived_at is null and coalesce(specialty,'') <> '' group by specialty) s)
  )
$$;
create or replace function public.company_states() returns table(state text, n bigint)
language sql stable security invoker set search_path = public as $$
  select state, count(*) from companies where archived_at is null and coalesce(state,'') <> '' group by state order by count(*) desc
$$;

-- Lock down function access
revoke execute on function public.quick_entry(jsonb), public.company_facets(), public.company_states(),
  public.flag_duplicate(text, uuid, uuid, text), public.request_delete(text, uuid, text), public.restore_record(text, uuid),
  public.resolve_review(uuid, text), public.merge_records(text, uuid, uuid), public.rename_lookup(text, text, text)
  from public, anon;
grant execute on function public.quick_entry(jsonb), public.company_facets(), public.company_states(),
  public.flag_duplicate(text, uuid, uuid, text), public.request_delete(text, uuid, text), public.restore_record(text, uuid),
  public.resolve_review(uuid, text), public.merge_records(text, uuid, uuid), public.rename_lookup(text, text, text)
  to authenticated;
revoke execute on function private.lock_lead_source(), private.flag_company_dupes(), private.flag_people_dupes(),
  private.handle_new_auth_user() from public, anon, authenticated;
grant execute on function private.norm(text), private.street_key(text, text) to authenticated;
