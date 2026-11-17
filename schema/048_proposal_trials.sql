-- 048: free trials on proposal lines (Oct 20, 2026).
-- items.trials maps a line key (lic, pages:<id>, custom:<id>, ex) to a number of free days (1 to 365). The line's
-- recurring price still counts in the totals and margin lights; the quote marks the line with 'trial' so the client
-- page says "first 30 days free" and checkout starts that line's billing after the trial. Setup fees are never
-- part of a trial. The card or bank account is still taken at Accept.
-- Checkout bookkeeping: proposals.stripe_extra_subs holds the subscriptions started after checkout.

alter table public.proposals add column if not exists stripe_extra_subs jsonb;

do $$
declare d text; b text;
begin
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  d := replace(d, $q$  d_s := least(100, greatest(0, coalesce((it->'disc'->>'setup')::numeric,0))) / 100;$q$,
    $q$  -- free trials: mark recurring lines that start billing later
  if jsonb_typeof(it->'trials') = 'object' then
    select coalesce(jsonb_agg(case when l ? 'lk' and coalesce(it->'trials'->>(l->>'lk'), '') ~ '^\d{1,3}$'
                                   and (it->'trials'->>(l->>'lk'))::int between 1 and 365
                                   and (coalesce((l->>'mo')::numeric, 0) > 0 or coalesce((l->>'wk')::numeric, 0) > 0)
                              then l || jsonb_build_object('trial', (it->'trials'->>(l->>'lk'))::int) else l end order by t.o2), '[]'::jsonb)
      into lines from jsonb_array_elements(lines) with ordinality t(l, o2);
  end if;
  d_s := least(100, greatest(0, coalesce((it->'disc'->>'setup')::numeric,0))) / 100;$q$);
  if d = b then raise exception 'proposal_quote: no match'; end if;
  execute d;

  -- a trial change is a price change: an earlier override no longer applies
  d := pg_get_functiondef('private.proposal_price_sig(jsonb)'::regprocedure); b := d;
  d := replace(d, $q$    'disc', it->'disc',$q$, $q$    'disc', it->'disc',
    'trials', it->'trials',$q$);
  if d = b then raise exception 'proposal_price_sig: no match'; end if;
  execute d;
end $$;
