-- 020: expired proposals close the deal. Once an hour, any sent proposal past its expiration date (never accepted)
-- moves its organization to Closed Lost in its pipeline and leaves a note. Each expiration is handled once
-- (expired_for remembers which expiration date was processed), so a re-sent proposal with a new date starts fresh.
alter table public.proposals add column if not exists expired_for timestamptz;

create or replace function private.expire_proposals() returns int
language plpgsql security definer set search_path = public, private as $$
declare p record; n int := 0; cur text;
begin
  perform set_config('app.proposal_rpc', '1', true);
  for p in
    select pr.* from proposals pr
     where pr.status = 'sent' and pr.expires_at < now() and pr.expired_for is distinct from pr.expires_at
     order by pr.expires_at
  loop
    update proposals set expired_for = p.expires_at where id = p.id;
    -- leave the deal alone if it's already won or another proposal for it is still live
    select s.system_key into cur from companies c left join pipeline_stages s on s.id = c.pipeline_stage_id where c.id = p.company_id;
    if coalesce(cur, '') in ('won', 'lost') then continue; end if;
    if exists (select 1 from proposals o where o.company_id = p.company_id and o.id <> p.id
                 and (o.status = 'accepted' or (o.status = 'sent' and o.expires_at >= now()))) then continue; end if;
    insert into activities (tenant_id, company_id, type, body, created_by)
    values (p.tenant_id, p.company_id, 'note',
            format('Proposal version %s expired on %s without being accepted.', p.version, to_char(p.expires_at at time zone 'America/Chicago', 'FMMonth FMDD, YYYY')),
            p.owner_id);
    perform private.pipeline_move(p.company_id, 'lost');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function private.expire_proposals() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('expire-proposals', '7 * * * *', $$select private.expire_proposals()$$);
