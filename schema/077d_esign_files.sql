-- 077d: e-sign, part 4. The private bucket for documents to sign: esign-files/<account>/<file>.
-- PDFs only, 25 MB each. People with E-sign level 2 add files to their own account's folder; anyone who can see
-- e-sign in that account can read them. There's no update or delete rule, so an uploaded original can't be swapped
-- out under an envelope. Signed copies (<account>/<envelope>/signed-...) are written by the edge functions.
insert into storage.buckets (id, name, public) values ('esign-files', 'esign-files', false) on conflict (id) do nothing;
update storage.buckets set file_size_limit = 26214400, allowed_mime_types = array['application/pdf'] where id = 'esign-files';

create policy "esign files upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'esign-files' and private.esign_see() and private.can('esign', 2) and (storage.foldername(name))[1] = private.current_tenant()::text);
create policy "esign files read" on storage.objects for select to authenticated
  using (bucket_id = 'esign-files' and private.esign_see() and (storage.foldername(name))[1] = private.current_tenant()::text);
