-- 006: proposal email tracking (applied Oct 16, 2026). Emails go out through the proposal-email
-- Supabase Edge Function (supabase/functions/proposal-email) using the RESEND_API_KEY secret.
alter table public.proposals add column if not exists last_emailed_at timestamptz;
alter table public.proposals add column if not exists last_emailed_to text;
alter table public.proposals add column if not exists accept_notified_at timestamptz;
-- The email function runs as service_role, which has no table rights by default in this project.
grant select, update on public.proposals to service_role;
grant select on public.proposal_versions, public.companies, public.app_users to service_role;
grant select, insert on public.activities to service_role;
grant usage on schema private to service_role;
grant execute on function private.current_tenant(), private.default_tenant(), private.actor() to service_role;
