# cognixcrm.com

The Cognix CRM sales site. Served by the app's own Pages project (lnp-platforms) through functions/_middleware.js and sites/hosts.js. Custom domains to add on that project: cognixcrm.com and www.cognixcrm.com (app.cognixcrm.com is the app itself, also on that project).

- brand/: logo (light and reverse), mark, favicon and app icons made from Chris's outlined SVG (Nov 9, 2026). The Cognix white label in the CRM points its icons here.
- The demo form posts to the Cognix account through forms/form.js (FORM_KEY in index.html: the "Contact form" on Cognix CRM main site, Tools > Sites). Leads land in Lead in the Cognix account.
- phones/: phone system builder (Nov 16, 2026). Lines, recording, texting, fax and Yealink desk phones (buy or rent) with live monthly and one-time totals at the Nov 13 prices (T31P rent $7/mo, set Nov 16). Submits to the Contact form as a lead with the whole build in the message.
- start/: client project intake (one submission per page they need built). Posts to the Cognix "Contact form" for now (swap FORM_KEY in start/index.html for a dedicated intake form's key once one exists). Files upload through the form-upload function into the Cognix media library, folder "Intake: <company>". After submitting, visitors land on start/thanks/, which offers another submission (contact details carry over) or booking the Project Kickoff Call (app.cognixcrm.com/book/?a=cognix&c=kickoff).
- Privacy and terms redirect to the app's legal pages. 404.html is the not found page.
- Copy rules: no em dashes, no "unlimited" (except phone calling, which Chris set as unlimited under fair use on Nov 16), no "AI" buzzwords, no pricing until Chris sets it.

## After the site is live (cognixcrm.com/brand/icon-512.png loads)
Point the Cognix white label's icons at the new files (they still use the Nov 3 set in Supabase storage):

```sql
update white_labels set logo_url = 'https://cognixcrm.com/brand/logo.svg', logo_reverse_url = 'https://cognixcrm.com/brand/logo-reverse.svg',
  favicon_url = 'https://cognixcrm.com/brand/favicon-32.png', apple_icon_url = 'https://cognixcrm.com/brand/apple-touch-icon.png',
  icon_192_url = 'https://cognixcrm.com/brand/icon-192.png', icon_512_url = 'https://cognixcrm.com/brand/icon-512.png',
  icon_maskable_url = 'https://cognixcrm.com/brand/icon-maskable-512.png', updated_at = now()
where agency_tenant_id = '22d9aac4-ce4f-42f5-8ad1-3bfa419c6076';
```
Then add https://app.cognixcrm.com to Supabase Auth > URL Configuration > Redirect URLs and to LIVE_BRAND_DOMAINS in app.js so password resets land on the Cognix address.
