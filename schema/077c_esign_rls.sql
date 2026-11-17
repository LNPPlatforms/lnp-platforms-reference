-- 077c: e-sign, part 3. Who sees what. The team reads its own account's templates, envelopes, signers and events
-- (envelopes by the E-sign area's scope). Every change goes through the functions in 077e and 077f, so the original
-- file, its fingerprint, the signatures and the event log can't be edited from the app. Signers never read these
-- tables; the signing page goes through the esign-sign edge function and the token functions in 077f.

alter table public.esign_templates enable row level security;
alter table public.esign_envelopes enable row level security;
alter table public.esign_signers enable row level security;
alter table public.esign_events enable row level security;
alter table private.esign_codes enable row level security;

create policy "see esign templates" on public.esign_templates for select using (
  tenant_id = private.current_tenant() and private.esign_see());
create policy "see envelopes" on public.esign_envelopes for select using (
  tenant_id = private.current_tenant() and private.esign_see() and private.in_scope('esign', owner_id, divisions));
create policy "see signers" on public.esign_signers for select using (
  tenant_id = private.current_tenant() and exists (select 1 from public.esign_envelopes e where e.id = envelope_id));
create policy "see esign events" on public.esign_events for select using (
  tenant_id = private.current_tenant() and exists (select 1 from public.esign_envelopes e where e.id = envelope_id));

revoke all on public.esign_templates, public.esign_envelopes, public.esign_signers, public.esign_events from anon, authenticated;
grant select on public.esign_templates, public.esign_envelopes, public.esign_events to authenticated;
-- signers: everything but the link code (the token is the signer's key to the signing page)
grant select (id, tenant_id, envelope_id, key, role_label, name, email, phone, sign_order, status, invited_at, last_sent_at, reminders,
  viewed_at, consent_at, otp_verified_at, signed_at, declined_at, decline_reason, sign_ip, sign_user_agent, sign_device, sign_browser,
  signature_kind, created_at) on public.esign_signers to authenticated;

create trigger audit_esign_envelopes after insert or update on public.esign_envelopes for each row execute function private.audit();
create trigger audit_esign_templates after insert or update on public.esign_templates for each row execute function private.audit();
