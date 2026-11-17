-- 053: completed to-dos can be found and reopened (Oct 20, 2026).
-- tasks.done_at and done_by are stamped when a to-do is ticked off and cleared when it's reopened, so My Day and the
-- organization page can list what was finished, newest first. Nothing is deleted. To-dos finished before today have
-- no date (they show as "earlier").

alter table public.tasks add column if not exists done_at timestamptz;
alter table public.tasks add column if not exists done_by uuid references public.app_users(id);
create index if not exists tasks_done_recent on public.tasks (tenant_id, done_at desc) where done;

create or replace function private.task_done_stamp() returns trigger
language plpgsql set search_path = public, private as $$
begin
  if new.done and not coalesce(old.done, false) then new.done_at := now(); new.done_by := auth.uid();
  elsif not new.done and coalesce(old.done, false) then new.done_at := null; new.done_by := null;
  end if;
  return new;
end $$;
create or replace trigger task_done_stamp before update of done on public.tasks for each row execute function private.task_done_stamp();
