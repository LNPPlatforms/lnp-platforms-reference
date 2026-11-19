# Door-hanger courier module for LNP Platforms

Marketplace layer that lets contractors (roofers, tree services, landscapers) hire couriers to hang
door hangers after a storm, with per-door GPS + photo proof, contractor review, and cross-account
sharing between white-label instances. Built **inside your existing tenancy model**: `tenant_id` on
every table, RLS using `private.current_tenant()`, SECURITY DEFINER functions that check feature,
admin and tenant themselves. Nothing here changes how tenancy resolves.

## Status: read this first

| | |
|---|---|
| **Verified** | All migrations apply cleanly on Postgres 16 + PostGIS 3.4 against a **stand-in** schema that mimics your described tenancy (home/acting tenant, agency-managed accounts, portal users, feature gate). 72 assertions pass (`tests/courier_isolation.test.sql`). Rollback and re-apply work. The PWA modules type-check under `tsc --strict`. |
| **NOT verified** | Against your **real** `private.current_tenant()`, `is_admin`, `feature_on`, `account_members` columns, or a real Supabase project (storage ownership, PostgREST exposure, `extensions` schema layout). I was given descriptions of those, not their source. |
| **Not built** | Payments (escrow, payouts, ledger writes), Review-tab integration, photo vision check, push/SMS alerts, route ordering, auto-approve job, courier rating updates. Each is marked `TODO(...)` or listed in `OPEN_ITEMS.md`. |

**Apply to a Supabase dev branch (or a copy of the project) first, never straight to production.**

## Order of operations

1. `schema/_preflight_courier.sql`: read-only. Lists everything this module assumes and every name it will create. Fix what it reports.
2. `schema/_audit_tenancy.sql`: read-only. Run each query; triage results (this is the hardening pass). Expected exception: `network_jobs` (deliberate RLS-bypassing, column-limited view).
3. `schema/200_courier_guardrails.sql`: adapters + tenant_id immutability triggers.
   **Before applying, review the exclusion list** (`app_users` by default) for tables whose `tenant_id` legitimately changes in your own flows.
4. `schema/201` to `204`: tables, sharing, functions, storage. Notices like `trigger ... does not exist, skipping` are expected.
5. Enable the feature for a pilot account (see OPEN_ITEMS #2: key `courier_marketplace`).
6. `tests/courier_isolation.test.sql`: replace the fixture block with your own seeding, then run with `psql`.
   `tests/isolation_sweep.sql`: generic "no foreign rows visible" sweep over every table with a `tenant_id`.
7. Wire the PWA modules (`pwa/`) into the courier screens.

Renumber the 200-series files to follow your latest `schema/NNN_` file if needed; later files win, as in your repo.

## Adaptation points (edit in ONE place)

| What | Where | Default |
|---|---|---|
| Who is the caller | `private.dh_me()` in 200 | `auth.uid()`; change if `app_users.id` differs |
| Admin of the **acting** account | `private.dh_is_admin()` in 200 | `private.is_admin()` |
| Feature + internal gate | `private.dh_enabled()` in 200 | `is_internal() AND feature_on('courier_marketplace')` |
| Function `search_path` | each definer function in 203 | `public, extensions, pg_temp`; match your existing convention |
| Tenant-immutable exclusions | `select private.install_tenant_immutable(array['app_users'])` | add tables that legitimately move accounts |

## Design in one paragraph

Campaigns, zones, addresses, drops and the ledger all carry the **campaign owner's** `tenant_id`.
Policies are SELECT-only; every write goes through a definer function. Other accounts never read
your tables: they see a column-limited `network_jobs` view, and only after a share is granted by one
admin and accepted by the other. A courier from another account gets read access to **exactly the
zone assigned to them** (not the tenant), through `private.dh_is_my_zone()`, and can upload photos
only under `t/<owner tenant>/<assigned zone>/`. Drops are stored under the owner's `tenant_id`, never
the courier's. Agency access (e.g. GI Promotion managing an account) is **not** re-modelled: your
`current_tenant()` already handles it.

## Files

```
README.md                       this file
OPEN_ITEMS.md                   what I could not verify or decide for you
schema/_preflight_courier.sql   read-only checks
schema/_audit_tenancy.sql       read-only hardening queries
schema/200_courier_guardrails.sql
schema/201_courier_core.sql     tables, composite tenant FKs, SELECT-only RLS, append-only ledger
schema/202_courier_shares.sql   tenant_shares, grant/accept/revoke, network_jobs view
schema/203_courier_functions.sql campaigns, zones (k-means), claim, submit_drops, review, approve
schema/204_courier_storage.sql  private drop-photos bucket + policies
schema/_rollback_courier.sql    DESTRUCTIVE: removes 201-204
tests/courier_isolation.test.sql 72 assertions
tests/isolation_sweep.sql       generic sweep for your real DB
tests/harness/stub_schema.sql   DEV-ONLY stand-in; never run on Supabase
pwa/src/lib/*.ts                offline queue, camera + GPS capture, sync, API wrappers
```

## What changed vs. the designs earlier in the chat

- Tables are `dh_*`-prefixed so they cannot collide with your existing Jobs/Routes/Pay objects.
- Cross-account claiming is a single definer function; couriers never read another account's `jobs`/campaigns table.
- S3 pre-signed URLs are replaced by Supabase Storage with RLS.
- Mock-location detection is gone (browsers cannot report it); `clock_drift`, accuracy, speed and distance checks stay on the server.
- The `set_config('app.tenant_id')` approach is dropped in favor of your `private.current_tenant()`.
- `admin_support` share scope dropped: agency management already exists in your model.
