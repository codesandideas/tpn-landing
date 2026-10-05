# Contact form backend

One Cloudflare Worker (`tpn-landing`) serves the static site and handles the contact form.

- `POST /api/contact` validates the enquiry, saves it to D1 (`tpn-forms`), then emails `NOTIFY_TO` through Resend. The visitor's address is set as reply-to.
- `GET /admin` lists enquiries and `/admin/export.csv` downloads them, after signing in with the password in the `ADMIN_PASSWORD` secret. Sessions last 7 days; changing the password signs everyone out. After 10 wrong passwords an IP is locked out for 15 minutes. Without the secret, `/admin` returns 404.
- Spam: hidden honeypot field, same-origin check, 5 enquiries per IP per 10 minutes, and Cloudflare Turnstile once its keys are set.

## Setup

1. **Deploy.** Workers & Pages → Create → Import a repository → `codesandideas/tpn-landing`. Defaults are fine: wrangler deploys on every push to `main`.
2. **Email.** In Resend, add the domain `send.thepineapplenation.com` and add its DNS records in Cloudflare. Create an API key, then set it on the Worker: Settings → Variables and Secrets → `RESEND_API_KEY` (type Secret).
3. **Turnstile (optional).** Create a widget for the site's hostnames. Put the site key in `TURNSTILE_SITE_KEY` in `index.html` and set the secret on the Worker as `TURNSTILE_SECRET`.
4. **Admin password.** On the Worker: Settings → Variables and Secrets → add `ADMIN_PASSWORD` (type Secret). Use a long passphrase.

## Local development

```bash
npx wrangler d1 execute tpn-forms --local --persist-to ../.tpn-wrangler-state --file worker/schema.sql
npx wrangler dev --persist-to ../.tpn-wrangler-state
```

Keep `--persist-to` outside the repo: the site is served from the repo root, so local database writes inside it make the dev server reload in a loop. Put `ADMIN_PASSWORD="..."` in `.dev.vars` to sign in locally. Without `RESEND_API_KEY`, enquiries are saved with `notify_status = 'not configured'`.
