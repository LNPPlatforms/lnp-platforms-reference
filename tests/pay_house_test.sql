-- 108: house accounts take payments in LNP's own Stripe; a connected Stripe still wins
do $$ declare t uuid := private.platform_tenant(); begin
  if private.pay_method(t) is distinct from 'platform' then raise exception 'LNP should be a house account: %', private.pay_method(t); end if;
  if not public.pay_house(t) then raise exception 'pay_house false for LNP'; end if;
  insert into private.pay_processors (tenant_id, stripe_account_id, stripe_ready) values (t, 'acct_test', true)
    on conflict (tenant_id) do update set stripe_account_id = 'acct_test', stripe_ready = true;
  if private.pay_method(t) <> 'stripe' then raise exception 'connected Stripe should win'; end if;
  delete from private.pay_processors where tenant_id = t;
  raise notice 'pay_house ok';
end $$;
