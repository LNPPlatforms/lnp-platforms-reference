-- 077b: e-sign, part 2. Templates, envelopes, signers, one-time codes and the event log.
-- Fields live on the template or envelope as jsonb:
--   [{id, signer, type, page, x, y, w, h, required, label}]
--   signer: the signer's key on an envelope (s1, s2...) or the role key on a template (client, rep...)
--   type: signature, initials, date (date signed, filled by the server), text, checkbox, name (the signer's name)
--   page: 1 based. x, y, w, h: fractions (0 to 1) of the page, measured from the top left corner.
-- Pages: [{w, h}] in PDF points, read in the browser when the PDF is uploaded (for the editor's layout only;
-- the completion function reads the real page boxes again from the file).

create table if not exists public.esign_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  message text check (message is null or length(message) <= 5000),
  file_path text not null check (length(file_path) between 3 and 500),
  file_name text not null check (length(file_name) between 1 and 255),
  file_size bigint check (file_size is null or file_size >= 0),
  pages jsonb not null default '[]'::jsonb,
  roles jsonb not null default '[{"key":"client","label":"Client","order":1}]'::jsonb,   -- [{key, label, order}]
  fields jsonb not null default '[]'::jsonb,
  ordered boolean not null default false,
  owner_id uuid references public.app_users(id) default auth.uid(),
  divisions uuid[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists esign_templates_tenant on public.esign_templates (tenant_id) where archived_at is null;

create table if not exists public.esign_envelopes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  title text not null check (length(trim(title)) between 1 and 200),
  message text check (message is null or length(message) <= 5000),
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'partly_signed', 'completed', 'declined', 'voided')),
  source text not null default 'upload' check (source in ('upload', 'template', 'api')),
  template_id uuid references public.esign_templates(id),
  -- what made it, for later callers like change orders and proposals (kind plus their id)
  ref_kind text check (ref_kind is null or ref_kind ~ '^[a-z_]{2,30}$'),
  ref_id uuid,
  -- the CRM record it belongs to (shows on that record's timeline)
  company_id uuid references public.companies(id),
  person_id uuid references public.people(id),
  job_id uuid references public.jobs(id),
  opportunity_id uuid references public.opportunities(id),
  ordered boolean not null default false,              -- signers sign one after another by sign_order
  file_path text not null check (length(file_path) between 3 and 500),
  file_name text not null check (length(file_name) between 1 and 255),
  file_size bigint check (file_size is null or file_size >= 0),
  pages jsonb not null default '[]'::jsonb,
  fields jsonb not null default '[]'::jsonb,
  original_sha256 text check (original_sha256 is null or original_sha256 ~ '^[a-f0-9]{64}$'),   -- locked at send
  final_path text,
  final_sha256 text check (final_sha256 is null or final_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz,
  sent_at timestamptz, completed_at timestamptz, declined_at timestamptz,
  voided_at timestamptz, voided_by uuid, void_reason text check (void_reason is null or length(void_reason) <= 1000),
  portal_approval_id uuid,
  owner_id uuid references public.app_users(id) default auth.uid(),
  divisions uuid[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists esign_envelopes_tenant on public.esign_envelopes (tenant_id, status, created_at desc);
create index if not exists esign_envelopes_company on public.esign_envelopes (company_id);
create index if not exists esign_envelopes_final on public.esign_envelopes (final_sha256) where final_sha256 is not null;
create index if not exists esign_envelopes_original on public.esign_envelopes (original_sha256) where original_sha256 is not null;

create table if not exists public.esign_signers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  envelope_id uuid not null references public.esign_envelopes(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,30}$'),   -- what the envelope's fields point at
  role_label text check (role_label is null or length(role_label) <= 100),
  name text not null check (length(trim(name)) between 1 and 200),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 320),
  phone text check (phone is null or length(phone) <= 40),     -- for codes by text later; email only today
  sign_order int not null default 1 check (sign_order between 1 and 50),
  status text not null default 'waiting' check (status in ('waiting', 'sent', 'viewed', 'signed', 'declined')),
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  invited_at timestamptz, last_sent_at timestamptz, reminders int not null default 0,
  viewed_at timestamptz, consent_at timestamptz, otp_verified_at timestamptz,
  session_hash text, session_until timestamptz,          -- set when the code checks out; signing needs it
  signed_at timestamptz, declined_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) <= 2000),
  sign_ip text, sign_user_agent text, sign_device text, sign_browser text,
  signature_png text check (signature_png is null or (signature_png ~ '^data:image/png;base64,' and length(signature_png) <= 400000)),
  initials_png text check (initials_png is null or (initials_png ~ '^data:image/png;base64,' and length(initials_png) <= 200000)),
  signature_kind text check (signature_kind is null or signature_kind in ('drawn', 'typed')),
  vals jsonb not null default '{}'::jsonb,            -- field id -> what they filled in
  created_at timestamptz not null default now(),
  unique (envelope_id, key)
);
create index if not exists esign_signers_env on public.esign_signers (envelope_id, sign_order);

-- one-time codes (only the hash is kept). channel: email today, sms is the seam for later
create table if not exists private.esign_codes (
  id uuid primary key default gen_random_uuid(),
  signer_id uuid not null references public.esign_signers(id) on delete cascade,
  code_hash text not null,
  channel text not null default 'email' check (channel in ('email', 'sms')),
  sent_to text,
  expires_at timestamptz not null,
  tries int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists esign_codes_signer on private.esign_codes (signer_id, created_at desc);
revoke all on private.esign_codes from public, anon, authenticated;

-- every event, with the server's own clock. Nobody edits or deletes these.
create table if not exists public.esign_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id),
  envelope_id uuid not null references public.esign_envelopes(id) on delete cascade,
  signer_id uuid references public.esign_signers(id) on delete set null,
  kind text not null check (kind ~ '^[a-z_]{2,30}$'),
  name text, email text,
  ip text, user_agent text, device text, browser text,
  by_user uuid,                                        -- a team member, for sent, reminded, voided
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default clock_timestamp()
);
create index if not exists esign_events_env on public.esign_events (envelope_id, at);

-- account e-sign settings live in account_settings.settings.esign: {default_message, expires_days}
