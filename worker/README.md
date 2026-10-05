# Contact form backend

One Cloudflare Worker (`tpn-landing`) serves the static site and handles the contact form.

- `POST /api/contact` validates the enquiry, saves it to D1 (`tpn-forms`), then emails `NOTIFY_TO` through Resend. The visitor's address is set as reply-to.
- `GET /admin` lists enquiries; `/admin/export.csv` downloads them. Both are closed until Cloudflare Access is set up.
- Spam: hidden honeypot field, same-origin check, 5 enquiries per IP per 10 minutes, and Cloudflare Turnstile once its keys are set.

## Setup

1. **Deploy.** Workers & Pages → Create → Import a repository → `codesandideas/tpn-landing`. Defaults are fine: wrangler deploys on every push to `main`.
2. **Email.** In Resend, add the domain `send.thepineapplenation.com` and add its DNS records in Cloudflare. Create an API key, then set it on the Worker: Settings → Variables and Secrets → `RESEND_API_KEY` (type Secret).
3. **Turnstile (optional).** Create a widget for the site's hostnames. Put the site key in `TURNSTILE_SITE_KEY` in `index.html` and set the secret on the Worker as `TURNSTILE_SECRET`.
4. **Admin access.** Zero Trust → Access → Applications → Self-hosted, for `<domain>/admin`, allowing the team's emails. Copy the team domain (`<team>.cloudflareaccess.com`) and the application's AUD tag into `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc`.

## Local development

```bash
npx wrangler d1 execute tpn-forms --local --persist-to ../.tpn-wrangler-state --file worker/schema.sql
npx wrangler dev --persist-to ../.tpn-wrangler-state
```

Keep `--persist-to` outside the repo: the site is served from the repo root, so local database writes inside it make the dev server reload in a loop. Without `RESEND_API_KEY`, enquiries are saved with `notify_status = 'not configured'`.
