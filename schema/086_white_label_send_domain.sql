-- 086 (Nov 9, 2026): each white label can send email from its own verified domain (send.cognixcrm.com).
-- Blank: the shared sending domain (SEND_DOMAIN). Applied Nov 9.
alter table public.white_labels add column if not exists send_domain text
  check (send_domain is null or send_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
comment on column public.white_labels.send_domain is 'Email sending domain verified in Resend (send.theirbrand.com). Blank: the shared one.';
