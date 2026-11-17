-- 098: proposals have a name (Nov 11, 2026), so one client can have more than one open proposal ("Website rebuild",
-- "Patient enrollment"). The name shows in the builder, the proposals list and at the top of the client's page.
alter table public.proposals add column if not exists name text check (name is null or length(name) <= 120);

do $m$
declare d text; b text;
begin
  d := pg_get_functiondef('public.proposal_view(text,jsonb)'::regprocedure); b := d;
  if position($q$'name', p.name$q$ in d) > 0 then return; end if;
  d := replace(d, $q$'org', c.name, 'account'$q$, $q$'org', c.name, 'name', p.name, 'account'$q$);
  if d = b then raise exception 'proposal_view did not match; nothing changed'; end if;
  execute d;
end $m$;
