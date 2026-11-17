-- 038: suggestions can carry a short screen recording (up to 30 seconds) as well as a marked-up screenshot.
-- Recordings go in the same private feedback bucket (sender's own folder; only Chris and Claude's login read it).
alter table public.suggestions add column if not exists video_path text;
update storage.buckets set file_size_limit = 26214400,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','video/webm','video/mp4']
where id = 'feedback';

create or replace function private.guard_suggestion() returns trigger
language plpgsql set search_path = public, private as $$
begin
  if (new.body, new.user_id, new.tenant_id, new.view, new.record_id, new.url, new.screenshot_path, new.video_path, new.created_at)
     is distinct from (old.body, old.user_id, old.tenant_id, old.view, old.record_id, old.url, old.screenshot_path, old.video_path, old.created_at) then
    raise exception 'Suggestions can only be marked done or not doing';
  end if;
  new.resolved_at := case when new.status = 'new' then null else coalesce(old.resolved_at, now()) end;
  return new;
end $$;
