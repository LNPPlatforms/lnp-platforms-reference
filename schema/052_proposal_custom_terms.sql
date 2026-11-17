-- 052: custom terms on one proposal (Oct 20, 2026).
-- items.terms_custom, when set, replaces the standard terms on that proposal's client page. It is saved with each
-- version, so the accepted record keeps the exact terms the client agreed to.
do $$ declare d text; b text; begin
  d := pg_get_functiondef('public.proposal_view(text,jsonb)'::regprocedure); b := d;
  d := replace(d, $q$'note', nullif(coalesce(acc_items, p.items)->>'note_shared',''),$q$,
    $q$'note', nullif(coalesce(acc_items, p.items)->>'note_shared',''),
    'terms', nullif(trim(coalesce(acc_items, p.items)->>'terms_custom'),''),$q$);
  if d = b then raise exception 'proposal_view: no match'; end if;
  execute d;
end $$;
