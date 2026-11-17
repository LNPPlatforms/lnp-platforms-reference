-- 007: mockups on proposals (applied Oct 16, 2026).
-- Reps attach images, PDFs or links to the whole proposal or to any line. They live in the proposal's items JSON
-- (items.mockups, items.cs.mockups, items.pages[i].mockups, ...), so they're frozen into each sent and accepted version.

-- media rows can belong to a proposal; the media bucket also takes PDFs, up to 10 MB
alter table public.media drop constraint if exists media_entity_check;
alter table public.media add constraint media_entity_check check (entity in ('companies','people','proposals'));
update storage.buckets set file_size_limit = 10485760,
  allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif','application/pdf'] where id = 'media';

-- pass each line's mockups through the pricing engine (they are client-safe)
do $$
declare d text; before text; f regprocedure := 'private.proposal_quote(public.proposals,text,uuid)'::regprocedure;
  pairs text[][] := array[
    array[$a$'sub',nullif(x->>'desc',''),'desc',pb->'page'->>'description',$a$,
          $a$'sub',nullif(x->>'desc',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'page'->>'description',$a$],
    array[$a$'note',nullif(x->>'note',''),'desc',pb->'tSite'->>'description',$a$,
          $a$'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'tSite'->>'description',$a$],
    array[$a$'note',nullif(x->>'note',''),'desc',pb->'tFunnel'->>'description',$a$,
          $a$'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'tFunnel'->>'description',$a$],
    array[$a$'note',nullif(it->'cs'->>'note',''),'desc',pb->'cSite'->>'description',$a$,
          $a$'note',nullif(it->'cs'->>'note',''),'mockups',coalesce(it->'cs'->'mockups','[]'::jsonb),'desc',pb->'cSite'->>'description',$a$],
    array[$a$'note',nullif(x->>'note',''),'desc',pb->'cFunnel'->>'description',$a$,
          $a$'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'cFunnel'->>'description',$a$]];
  i int;
begin
  d := pg_get_functiondef(f);
  if position('''mockups''' in d) > 0 then return; end if;   -- already applied
  for i in 1 .. array_length(pairs, 1) loop
    before := d;
    d := replace(d, pairs[i][1], pairs[i][2]);
    if d = before then raise exception 'mockups patch % did not match', i; end if;
  end loop;
  execute d;
end $$;

-- client link: include proposal-level mockups (from the accepted version once accepted)
create or replace function public.proposal_public(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare p public.proposals; c record; logo text; acc jsonb; acc_items jsonb;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into p from proposals where share_token = p_token;
  if not found then return null; end if;
  select name, logo_media_id into c from companies where id = p.company_id;
  select url into logo from media where id = c.logo_media_id and archived_at is null;
  if p.status = 'accepted' then
    select quote, items into acc, acc_items from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  end if;
  return jsonb_build_object(
    'org', c.name, 'logo', logo, 'contact_name', p.contact_name, 'contact_email', p.contact_email,
    'status', p.status, 'version', p.version, 'expires_at', p.expires_at, 'updated_at', p.updated_at,
    'note', nullif(coalesce(acc_items, p.items)->>'note_shared',''),
    'mockups', coalesce(coalesce(acc_items, p.items)->'mockups', '[]'::jsonb),
    'accepted', case when p.status = 'accepted' then jsonb_build_object('name', p.accepted_name, 'email', p.accepted_email,
       'at', p.accepted_at, 'version', p.accepted_version) end,
    'quote', coalesce(acc, private.proposal_quote(p, 'client')));
end $$;
revoke execute on function public.proposal_public(text) from public;
grant execute on function public.proposal_public(text) to anon, authenticated;
