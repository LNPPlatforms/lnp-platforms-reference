-- 047b: the second subscription for a proposal that bills both monthly and weekly
alter table public.proposals add column if not exists stripe_weekly_subscription_id text;
