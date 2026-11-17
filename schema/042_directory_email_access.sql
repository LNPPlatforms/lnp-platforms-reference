-- 042: the directory-email function (server only) couldn't read the directory tables, so invites and message emails
-- failed with "not found". It needs to read them and mark threads as notified.
grant select on public.directories, public.directory_listings, public.directory_members, public.directory_threads, public.directory_messages to service_role;
grant update on public.directory_threads to service_role;
