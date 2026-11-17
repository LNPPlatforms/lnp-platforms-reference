-- GELP CRM schema v1
-- Paste into Supabase: SQL Editor > New query > paste all > Run.
-- Safe to run once on a fresh project.

-- ============================================================
-- USERS AND ROLES
-- ============================================================
create type user_role as enum ('admin', 'salesperson', 'contractor', 'staff', 'vendor');

-- Vendors in the RLX vendor program (they log in and see only assigned clinics)
create table vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text,                       -- Vendor Access / Vendor Insights / Vendor Promote
  website text,
  notes text,
  created_at timestamptz not null default now()
);

-- One row per person who can log in. Linked to Supabase's built-in login table.
create table app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role user_role not null default 'salesperson',
  vendor_id uuid references vendors(id),   -- only set for vendor logins
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- DROPDOWN LISTS (admin editable)
-- ============================================================
create table lookup_values (
  id uuid primary key default gen_random_uuid(),
  list_name text not null,          -- contact_role, service, specialty, opportunity_status, interest_level, lead_source_channel
  label text not null,
  sort_order int not null default 0,
  active boolean not null default true,
  unique (list_name, label)
);

-- ============================================================
-- COMPANIES (clinics / organizations)
-- ============================================================
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  parent_company_id uuid references companies(id),
  specialty text,
  address text,
  city text,
  state text,
  zip text,
  main_phone text,
  fax text,
  main_email text,
  website text,
  number_of_locations int,
  current_vendors text,
  interest_level text,              -- High / Medium / Low
  owner_id uuid references app_users(id),        -- salesperson / closer
  lead_source_id uuid references app_users(id),  -- who brought it in
  lead_source_channel text,         -- door knock, referral, RLX, event, etc.
  last_contact_date date,
  next_step text,
  follow_up_date date,
  notes text,
  created_by uuid references app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_name_idx on companies (lower(name));
create index companies_owner_idx on companies (owner_id);
create index companies_follow_up_idx on companies (follow_up_date);

-- ============================================================
-- PEOPLE (personal info only, no job title here)
-- ============================================================
create table people (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text,
  personal_cell text,
  personal_email text,
  preferred_contact_method text,    -- Call / Text / Email
  notes text,
  created_by uuid references app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index people_name_idx on people (lower(first_name), lower(last_name));
create index people_cell_idx on people (personal_cell);
create index people_email_idx on people (lower(personal_email));

-- ============================================================
-- LINKS (person at a company). Everything company-dependent lives here.
-- ============================================================
create table company_people (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  title text,                       -- free text: CEO, Director of Client Success
  role text,                        -- dropdown: Office Manager, Clinical, etc.
  work_phone text,
  work_email text,
  is_decision_maker boolean not null default false,
  is_primary_contact boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, person_id)
);
create index company_people_title_idx on company_people (lower(title));
create index company_people_person_idx on company_people (person_id);
create index company_people_work_email_idx on company_people (lower(work_email));

-- ============================================================
-- OPPORTUNITIES (on the company, one per service pitch)
-- ============================================================
create table opportunities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  service text not null,            -- from service list
  status text not null default 'New',
  estimated_value numeric(12,2),
  owner_id uuid references app_users(id),
  lead_source_id uuid references app_users(id),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index opportunities_company_idx on opportunities (company_id);

-- ============================================================
-- ACTIVITY (notes, calls, visits) and TASKS (follow ups)
-- ============================================================
create table activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  type text not null default 'note',   -- note, visit, call, email, text
  body text,
  created_by uuid references app_users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index activities_company_idx on activities (company_id, created_at desc);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  person_id uuid references people(id) on delete set null,
  title text not null,
  due_date date,
  assigned_to uuid references app_users(id),
  done boolean not null default false,
  created_by uuid references app_users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index tasks_due_idx on tasks (assigned_to, done, due_date);

-- ============================================================
-- VENDOR ASSIGNMENTS (which clinics each vendor can see)
-- ============================================================
create table vendor_companies (
  vendor_id uuid not null references vendors(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (vendor_id, company_id)
);

-- ============================================================
-- updated_at auto-stamp
-- ============================================================
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger companies_touch before update on companies for each row execute function touch_updated_at();
create trigger people_touch before update on people for each row execute function touch_updated_at();
create trigger opportunities_touch before update on opportunities for each row execute function touch_updated_at();

-- ============================================================
-- SECURITY HELPERS
-- ============================================================
create or replace function current_role_name() returns user_role
language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid() and active
$$;

create or replace function is_internal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_name() in ('admin','salesperson','contractor','staff'), false)
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(current_role_name() = 'admin', false)
$$;

create or replace function vendor_can_see_company(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from vendor_companies vc
    join app_users u on u.vendor_id = vc.vendor_id
    where u.id = auth.uid() and u.active and u.role = 'vendor' and vc.company_id = cid
  )
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- Internal team: full read/write on CRM data.
-- Vendors: read only, and only clinics assigned to them.
-- ============================================================
alter table vendors enable row level security;
alter table app_users enable row level security;
alter table lookup_values enable row level security;
alter table companies enable row level security;
alter table people enable row level security;
alter table company_people enable row level security;
alter table opportunities enable row level security;
alter table activities enable row level security;
alter table tasks enable row level security;
alter table vendor_companies enable row level security;

-- app_users: everyone sees themselves, internal sees all, admin manages
create policy "self read" on app_users for select using (id = auth.uid() or is_internal());
create policy "admin manage users" on app_users for all using (is_admin()) with check (is_admin());

-- vendors
create policy "internal read vendors" on vendors for select using (is_internal()
  or id = (select vendor_id from app_users where id = auth.uid()));
create policy "admin manage vendors" on vendors for all using (is_admin()) with check (is_admin());

-- lookups: anyone logged in reads, admin edits
create policy "read lookups" on lookup_values for select using (auth.uid() is not null);
create policy "admin manage lookups" on lookup_values for all using (is_admin()) with check (is_admin());

-- companies
create policy "internal all companies" on companies for all using (is_internal()) with check (is_internal());
create policy "vendor read assigned companies" on companies for select using (vendor_can_see_company(id));

-- people (vendors see people linked to their assigned clinics)
create policy "internal all people" on people for all using (is_internal()) with check (is_internal());
create policy "vendor read people" on people for select using (exists (
  select 1 from company_people cp where cp.person_id = people.id and vendor_can_see_company(cp.company_id)));

-- links
create policy "internal all links" on company_people for all using (is_internal()) with check (is_internal());
create policy "vendor read links" on company_people for select using (vendor_can_see_company(company_id));

-- opportunities, activities, tasks: internal only for now
create policy "internal all opps" on opportunities for all using (is_internal()) with check (is_internal());
create policy "internal all activities" on activities for all using (is_internal()) with check (is_internal());
create policy "internal all tasks" on tasks for all using (is_internal()) with check (is_internal());

-- vendor assignments
create policy "internal all assignments" on vendor_companies for all using (is_internal()) with check (is_internal());
create policy "vendor read own assignments" on vendor_companies for select using (
  vendor_id = (select vendor_id from app_users where id = auth.uid()));

-- Let logged in users reach the tables through the API (RLS above still decides what they see)
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- ============================================================
-- STARTER DROPDOWNS (from David's requirements doc)
-- ============================================================
insert into lookup_values (list_name, label, sort_order) values
('contact_role','Owner/Physician',1),('contact_role','CEO/Executive',2),('contact_role','Administrator',3),
('contact_role','Office Manager',4),('contact_role','Referral Coordinator',5),('contact_role','Clinical',6),
('contact_role','Billing/RCM',7),('contact_role','IT',8),('contact_role','Marketing',9),
('contact_role','Purchasing/Vendor Relations',10),('contact_role','Other',11),

('service','Referralogix / Clinic Communication',1),('service','Care Management / Navigation',2),
('service','Cybersecurity / HIPAA',3),('service','Revenue Cycle / Billing',4),('service','Patient Engagement',5),
('service','Digital Marketing',6),('service','Website / SEO',7),('service','Payment Processing',8),
('service','Utility / Expense Management',9),('service','Fax Services',10),('service','Other',11),

('opportunity_status','New',1),('opportunity_status','Contacted',2),('opportunity_status','Met',3),
('opportunity_status','Interested',4),('opportunity_status','Assessment/Demo',5),('opportunity_status','Proposal',6),
('opportunity_status','Customer',7),('opportunity_status','Follow-Up Later',8),('opportunity_status','Not Interested',9),

('interest_level','High',1),('interest_level','Medium',2),('interest_level','Low',3),

('preferred_contact','Call',1),('preferred_contact','Text',2),('preferred_contact','Email',3),

('specialty','Primary Care',1),('specialty','Family Medicine',2),('specialty','Internal Medicine',3),
('specialty','Pediatrics',4),('specialty','ENT',5),('specialty','Cardiology',6),('specialty','Orthopedics',7),
('specialty','Urgent Care',8),('specialty','Rural Health Clinic',9),('specialty','Hospital / Health System',10),
('specialty','Other',11);

-- Helper functions are for security rules only; keep them off the public API for logged out visitors
revoke execute on function current_role_name(), is_internal(), is_admin(), vendor_can_see_company(uuid) from anon, public;
grant execute on function current_role_name(), is_internal(), is_admin(), vendor_can_see_company(uuid) to authenticated;
