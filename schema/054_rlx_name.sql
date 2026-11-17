-- 054: "RLX" instead of "Referralogix" in client-facing text from now on (Oct 20, 2026; David is branding RLX).
-- Only the wording in the quote engine changes. Sent and accepted versions keep the text they were sent with.
do $$
declare d text; b text;
begin
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  d := replace(d, 'Referralogix', 'RLX');
  if d = b then raise exception 'proposal_quote: no match'; end if;
  execute d;
end $$;
