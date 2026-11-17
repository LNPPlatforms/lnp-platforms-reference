# Planning features for the CRM

This repository is a **read-only reference copy** of a white label CRM. It is here so you (and your AI assistant) can see what already exists and what's possible while planning new features. Nothing here deploys or runs anywhere. Changes made here go nowhere.

**Your job is to plan, not build.** The output is a written feature spec (format at the bottom) that gets sent to the owner. Don't write code, don't promise dates or prices, and don't change files here.

## If you're an AI assistant reading this

- Read this file first, then look through the code to answer "does this exist?" and "how does it work today?" before suggesting anything.
- Interview the person. Ask one or two questions at a time, not ten. Push back when an idea duplicates something that exists, breaks a rule below or needs something the platform can't do.
- When you're confident, write the spec in the format at the bottom. Mark anything you're unsure of as an open question instead of guessing.

## What the CRM is

- A mobile-first CRM for service businesses (home services, healthcare practices, agencies). It runs in the browser and installs as an app on phones (a PWA). There's no app store app.
- **White label, three levels.** The platform owner sits at the top. Under it are **agencies**, each with its own brand, app name, logo, web address and email domain. Under each agency are **client accounts** (the businesses that use it). Users never see the platform's name or another agency's name.
- **Feature switches.** Almost everything is a per-account feature that can be turned on or off. Agencies sell packages that decide which features a client account is allowed to turn on.
- **Roles and permissions.** Admins plus roles with levels per area (none, view, edit, manage) and scope (own or all). Vendors and portal members are outside users with limited views.
- People can belong to more than one account and switch between them.

## How the code is laid out

- **No build step.** Plain HTML, CSS and JavaScript modules served as static files.
  - `index.html`, `app.js`: the app shell, navigation, contacts, organizations, settings, help articles (`HELP` in `app.js`), chat, review queue, platform admin.
  - Feature modules: `field.js` (feature list, dashboard widgets, jobs and field work), `grow.js` (marketing, timelines, brand kit), `calendars.js` (booking), `docs.js` (proposals, invoices, payments), `bids.js`, `esign.js`, `measure.js`, `plans.js` (packages and billing), `routes.js`, `phone.js`, `social` and others.
  - Public pages: `book/` (booking pages), `forms/`, `portal/` (client portal), `proposal/`, `sites/` (marketing websites served on their own domains).
- **Database: Supabase (Postgres).** `schema/` holds every change in order. Business rules live in database functions (`create or replace function public.x` is something the app calls; `private.x` is internal). Row level security keeps each account's data separate.
- **Server functions:** `supabase/functions/` (Deno). Email, Stripe payments, Microsoft 365, phone (Telnyx), webhooks, scheduled jobs.
- **Tests:** `tests/` has database tests (`*_test.sql`) and a browser click-through (`ui_clickthrough.js`) that runs the app against a fake backend.

## Feature switches today

Sales and pipeline · Inbox and live chat · Sites and forms · Custom fields · Parent locations and nesting · Jobs and repeat schedules · Dispatch and GPS check-in · Other costs on jobs · Time clock · Routes (beta) · Worker pay and payroll export · Accounting connection (Wave first) · Measuring on a satellite map · Bids (RFPs) · Client portal · E-sign · Calendars and booking · Phone · Social planner

The full list with descriptions is `FEATURES` in `field.js`. Always check whether an idea fits inside one of these before proposing a new one.

## Building blocks you can reuse

- **Contacts:** organizations and people, with many-to-many links (a person can work at several organizations), tags, types, lead source, custom fields, duplicate review and merge.
- **Timeline:** every contact has an activity timeline (notes, emails, calls, form fills, bookings, changes). New features should log there.
- **Notifications:** in-app, push, email and urgent alerts, with each person choosing how urgent things reach them. There's a Review tab for things that need a decision.
- **Automations:** triggers, waits, conditions and actions, plus webhooks.
- **Forms and sites:** form builder, website pages, form submissions that create leads.
- **Calendars:** booking pages, round robin, hours and days off, reminders, Microsoft 365 and calendar feeds, video links.
- **Docs:** proposals with signing and checkout, invoices, recurring invoices, autopay, reminders and late fees, Stripe payments.
- **Phone:** numbers, ring groups, a browser phone, voicemail, recording, call logging and usage.
- **Field work:** jobs, dispatch board, worker steps with photos, GPS check-in, time clock, routes, an offline mode for the day's jobs.
- **Chat:** internal team chat across accounts, website live chat, a support tab.
- **Media library,** brand kit (colors, fonts, logos), quick filters, saved views, a dashboard with widgets, a help center with an article for every feature, and a What's new banner after each weekly release.
- **AI connector** (in progress): lets a user's own AI (Claude, ChatGPT, Copilot, Gemini) act inside the CRM as that user, within their role.

## Hard limits

- **It's a web app.** No constant background GPS, and no reading texts or call logs from the phone itself. Location only comes when the app is open or someone taps.
- **Outside services need approval or registration.** Business texting needs carrier registration for each business (days). Google, Meta, TikTok and QuickBooks connections need their app review. Plan for "works once approved."
- **Anything with a per-use cost** (texts, minutes, AI, storage, maps) needs to say who pays and how usage is limited or shown.
- **Email** goes out from each agency's own sending domain. No mass email to people who didn't opt in.
- **No secrets in the browser.** Anything involving a password or API key happens in a server function.

## How features are built here (follow these)

1. **Platform features, not one-offs.** Build it so any account can use it, with settings and a feature switch, even when one client asked for it.
2. **White label everywhere.** No platform or other agency names in anything a user or their customer sees.
3. **Plain words** in the app. Buttons say what happens ("Send invoice", not "Submit"). No jargon.
4. **Mobile first.** Every screen has to work on a phone.
5. **Respect roles.** Say who can see it, who can change it and what "own vs all" means for it.
6. **Log it.** If it touches a customer, it shows on their timeline.
7. **Help comes with it.** Every feature gets help articles, and outdated ones get fixed in the same change.
8. **Beta first** when it's big: shown to admins first, off for everyone else until an admin turns it on.
9. **Weekly releases.** Updates ship Sunday at 2 AM Central unless something is urgent. New database changes must not break screens that are already out.

## Questions to ask about any idea

- Who's it for: the business owner, office staff, field workers, their customers, or an agency?
- What problem does it solve today, and how do they handle it now?
- Which feature switch does it belong under, or is it new?
- Who can see it, who can change it, and does "own vs all" matter?
- What starts it (a button, a time, an event like a booking or payment)?
- What does it look like on a phone?
- What gets logged, and who gets notified, and how urgently?
- What happens when it goes wrong (no internet, missing info, a payment fails, nobody responds)?
- Does it cost money per use, and who pays?
- What's the smallest version worth shipping first?

## The spec to hand back

```
Title:
One-line summary:

Problem: (what's painful today, for whom)
Who uses it: (roles, and which accounts or industries)
Where it lives: (which tab or screen, and which feature switch)

How it works:
  1. ...
  2. ...

Screens: (each screen or panel, what's on it, what each button does, phone layout notes)
Rules: (limits, defaults, what happens in edge cases)
Permissions: (who can view, edit, manage; own vs all)
Notifications and timeline: (what gets logged where, who's told and how)
Settings: (what admins can change)
Costs or outside services: (anything per-use or needing approval)

Out of scope for the first version:
Open questions:
Already exists and reused: (what you found in the code that this builds on)
```
