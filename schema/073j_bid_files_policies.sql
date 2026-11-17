-- 073j: bid files live in bid-files/<account>/<bid>/<file>. Only that account's people who can see bids reach them;
-- adding needs bids level 2. Email and the public page store theirs with the service key.
create policy "bid files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'bid-files' and private.bids_see() and private.can('bids', 2) and (storage.foldername(name))[1] = private.current_tenant()::text);
create policy "bid files read" on storage.objects for select to authenticated
  using (bucket_id = 'bid-files' and private.bids_see() and (storage.foldername(name))[1] = private.current_tenant()::text);
