-- 073i: the private bucket for bid files (RFPs, plans, spec books). 50 MB a file.
insert into storage.buckets (id, name, public) values ('bid-files', 'bid-files', false) on conflict (id) do nothing;
update storage.buckets set file_size_limit = 52428800 where id = 'bid-files';
