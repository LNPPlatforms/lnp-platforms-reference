-- 074g: client portal, part 7. Clients can open the job photos the team shared with them (signed links, private bucket).
create policy "portal reads shared job photos" on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and private.portal_photo_ok(name));
