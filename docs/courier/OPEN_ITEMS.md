# Open items: things I could not verify or decide for you

## Must confirm before applying (the preflight catches the mechanical ones)
1. **Admin semantics.** `private.dh_is_admin()` assumes `private.is_admin()` means "admin of the *acting* account". When an agency user (e.g. GI Promotion) switches into a managed account, are they an admin there? The stand-in says no unless a membership row grants it. Point the wrapper at whatever `phone_line_save` really uses.
2. **Feature flag.** Policies use `private.feature_on('courier_marketplace')`. Register that key wherever your features are defined and enable it per pilot account. Until then every policy and function denies (safe default).
3. **`account_members` shape.** `dh_courier_enroll` checks `(tenant_id, user_id)` only. If the table has an active/status column, add that filter so removed members cannot be enrolled.
4. **`app_users.id` vs `auth.uid()`.** Assumed equal. If not, change `private.dh_me()` only. The `courier_id`/`user_id` foreign keys point at `app_users(id)`.
5. **Search path convention.** Match the `search_path` your existing definer functions pin.
6. **Immutability trigger exclusions** beyond `app_users` (merges, transfers, re-parenting flows).
7. **`crm_job_id`.** Optional link from a campaign to your existing Jobs record; add a real FK once its id type is known.

## Real-project checks I could not run
8. PostGIS installed in `extensions`? Functions assume `extensions` is on the search path.
9. Creating policies on `storage.objects` and the bucket row needs the right role (SQL editor as `postgres` works).
10. Run the audit file against production (read-only) and triage. I have not seen its results.
11. `private` schema must not be exposed through the Data API settings.
12. Any Edge Function using the `service_role` key bypasses RLS; each must re-check tenant and role itself (this includes any address-import job).

## Product / build gaps
13. **Payments:** funding gate on publish, `dh_ledger` writes on approval, Stripe Connect payouts (Edge Function), who is merchant of record for cross-account jobs, and applying `revenue_share_bps`.
14. **Review tab:** surface `dh_drops` flags in your existing Review > GPS flags / Auto-approved lists. Needs a look at how those lists are built.
15. **Auto-approve:** a scheduled job (e.g. pg_cron) approving verified drops after N hours with no contractor action.
16. **Courier ratings:** `courier_profiles.rating` is read but nothing updates it yet.
17. **Vision check:** send each photo to a vision model and flag `photo_no_door`.
18. **Notifications:** SMS fallback for new nearby jobs (iOS web push only works for installed PWAs).
19. **Route ordering** inside a zone (nearest-neighbour or a routing API).
20. **Address sourcing:** import job for Baltimore/DC open data, with a nationwide strategy later.

## Legal / compliance (needs a human professional)
21. Courier classification (1099 vs employee) in Maryland and DC.
22. Local rules on handbills/door hangers, HOA restrictions, and USPS mailbox rules; contractor licensing checks (home-improvement, tree-expert).
23. Money handling: escrow and merchant-of-record structure across separate legal entities.
24. Data-sharing agreements and courier consent before enabling any `tenant_shares` between companies.
25. Open-source license audit before distributing the codebase to other instances.
