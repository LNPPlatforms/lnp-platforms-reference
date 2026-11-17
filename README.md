> **Reference copy for planning and building.** This repository doesn't deploy or run anything. Work goes on feature branches and gets moved into the live app by the owner. Start with [PLANNING.md](PLANNING.md).

# LNP Platforms

Mobile-first white label CRM owned by LNP Platforms. GELP and Get Coast Customers are agencies on it. Static site (HTML, CSS, JS) backed by Supabase.

- Database, logins and security rules live in Supabase (project `stfnpzqymjlxpainmgoo`, us-east-2).
- No build step. Cloudflare Pages serves the folder as a static site.
- `schema/` holds the database structure for reference.

## Weekly releases
- After Nov 13, 2026, updates ship once a week: **Sunday at 2 AM Central** (`.github/workflows/weekly-release.yml`). Urgent fixes can still go straight to `main`.
- The week's work collects on the `next` branch. Claude drafts `release/next.json` (title, plain-words description, optional `feature` or `admin`, and the help article titles that cover it). Chris approves by setting `"approved": true`. Not approved means no release that week.
- At 2 AM Sunday the workflow runs `node scripts/release.mjs publish` (moves the notes into `release/notes.json`, newest first) and merges `next` into `main`, which Cloudflare Pages deploys. Two cron times cover daylight saving time; the job only runs at 2 AM in Chicago.
- **Nothing ships unless help covers it.** `scripts/release.mjs check` fails if an item names no help article, names one that isn't in `HELP` in `app.js`, or lists one under `help_removed` that's still there. Update or remove outdated articles in the same change.
- Database migrations go live ahead of the release and must keep working with the screens already out there.
- The **What's new** banner shows on each person's first visit after a release, combined (newest first) if they missed some, with only what their account and role can use, and nothing if none of it applies. Every update is under Help › What's new.
