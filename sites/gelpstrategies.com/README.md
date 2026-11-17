# gelpstrategies.com

GELP Strategies' public website. Plain static files, no build step.

Hosting: its own Cloudflare Pages project (gelp-site) pointed at this repo with
root directory `sites/gelpstrategies.com`. Custom domains: gelpstrategies.com and www.

- RLX content is hidden, not deleted. Remove the `.gp-rlx { display: none }` rule in each page and the
  /rlx and /vendor lines in `_redirects` to bring it back.
- Booking still loads the GHL calendar (`BOOKING_SRC` in each page's script and the iframe on /chris).
  Swap to the CRM calendar link when it ships.
- Public contact is info@gelpstrategies.com. No personal cell or chris@ on main pages. No em dashes.
