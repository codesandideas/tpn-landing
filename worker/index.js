// The Pineapple Nation: static site plus contact form backend.
//   POST /api/contact     store an enquiry in D1, then email the team
//   GET  /admin           list enquiries (behind Cloudflare Access)
//   GET  /admin/export.csv
// Everything else is served from the static assets.

const LIMITS = { name: 120, email: 254, phone: 40, service: 80, message: 5000 };
const RATE_LIMIT = 5; // enquiries per IP per 10 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405, { Allow: 'POST' });
      return contact(request, env, ctx, url);
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'not_found' }, 404);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return admin(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

// ---------- contact form ----------

async function contact(request, env, ctx, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ ok: false, error: 'origin' }, 403);

  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: 'invalid' }, 400); }

  // Honeypot: bots fill the hidden field. Pretend it worked.
  if (form.get('_gotcha')) return json({ ok: true });

  const d = {};
  for (const [k, max] of Object.entries(LIMITS)) d[k] = String(form.get(k) ?? '').trim().slice(0, max);
  if (!d.name || !d.message || !EMAIL_RE.test(d.email)) return json({ ok: false, error: 'invalid' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (env.TURNSTILE_SECRET) {
    const ok = await turnstile(env.TURNSTILE_SECRET, form.get('cf-turnstile-response'), ip);
    if (!ok) return json({ ok: false, error: 'captcha' }, 400);
  }

  if (ip) {
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE ip = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 minutes')"
    ).bind(ip).first('n');
    if (recent >= RATE_LIMIT) return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const row = await env.DB.prepare(
    `INSERT INTO submissions (name, email, phone, service, message, ip, country, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, created_at`
  ).bind(
    d.name, d.email, d.phone || null, d.service || null, d.message, ip || null,
    request.cf?.country || null, (request.headers.get('User-Agent') || '').slice(0, 300) || null
  ).first();

  // The enquiry is saved; the email goes out after the response so the visitor isn't kept waiting.
  ctx.waitUntil(notify(env, { ...d, ...row }));
  return json({ ok: true });
}

async function turnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return (await r.json()).success === true;
  } catch { return false; }
}

async function notify(env, s) {
  let status;
  if (!env.RESEND_API_KEY) {
    status = 'not configured';
  } else {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `submission-${s.id}`,
        },
        body: JSON.stringify({
          from: env.NOTIFY_FROM,
          to: env.NOTIFY_TO.split(',').map(e => e.trim()).filter(Boolean),
          reply_to: s.email,
          subject: `New enquiry from ${s.name}${s.service ? ` (${s.service})` : ''}`,
          text: emailText(s),
          html: emailHtml(s),
        }),
      });
      status = r.ok ? 'sent' : `failed: ${r.status} ${(await r.text()).slice(0, 200)}`;
    } catch (err) {
      status = `failed: ${String(err).slice(0, 200)}`;
    }
  }
  if (status !== 'sent') console.error(`Enquiry ${s.id} notification: ${status}`);
  await env.DB.prepare('UPDATE submissions SET notify_status = ? WHERE id = ?').bind(status, s.id).run();
}

function emailFields(s) {
  return [['Name', s.name], ['Email', s.email], ['Phone', s.phone], ['Service', s.service], ['Received', `${s.created_at.replace('T', ' ').replace('Z', '')} UTC`]]
    .filter(([, v]) => v);
}

function emailText(s) {
  return `${emailFields(s).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${s.message}\n\nReply to this email to answer ${s.name} directly.`;
}

function emailHtml(s) {
  const rows = emailFields(s).map(([k, v]) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#6b6b66;vertical-align:top">${k}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:560px">
<p style="margin:0 0 16px;font-size:18px">New enquiry from the website</p>
<table style="border-collapse:collapse;margin-bottom:16px">${rows}</table>
<div style="white-space:pre-wrap;padding:16px;background:#f4f2ec;border-radius:8px">${esc(s.message)}</div>
<p style="margin:16px 0 0;color:#6b6b66;font-size:13px">Reply to this email to answer ${esc(s.name)} directly.</p>
</div>`;
}

// ---------- admin ----------

async function admin(request, env, url) {
  const user = await verifyAccess(request, env);
  if (!user) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  if (url.pathname === '/admin/export.csv') {
    const { results } = await env.DB.prepare(
      'SELECT id, created_at, name, email, phone, service, message, country, notify_status FROM submissions ORDER BY id DESC'
    ).all();
    const cols = ['id', 'created_at', 'name', 'email', 'phone', 'service', 'message', 'country', 'notify_status'];
    const csv = [cols.join(','), ...results.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n');
    return new Response('﻿' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tpn-enquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }
  if (url.pathname !== '/admin' && url.pathname !== '/admin/') return new Response('Not found', { status: 404 });

  const { results } = await env.DB.prepare(
    'SELECT id, created_at, name, email, phone, service, message, notify_status FROM submissions ORDER BY id DESC LIMIT 500'
  ).all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first('n');
  return new Response(adminPage(results, total, user.email), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// Checks the token Cloudflare Access attaches to every request it lets through.
// Without ACCESS_TEAM_DOMAIN and ACCESS_AUD configured, nobody gets in.
async function verifyAccess(request, env) {
  const team = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!team || !env.ACCESS_AUD || !token) return null;
  try {
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(b64urlText(h));
    const payload = JSON.parse(b64urlText(p));
    if (header.alg !== 'RS256') return null;
    if (payload.iss !== `https://${team}`) return null;
    if (![].concat(payload.aud).includes(env.ACCESS_AUD)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    const certs = await (await fetch(`https://${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } })).json();
    const jwk = certs.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    return ok ? payload : null;
  } catch {
    return null;
  }
}

function adminPage(rows, total, viewer) {
  const body = rows.length
    ? rows.map(r => `<tr>
  <td class="when">${esc(r.created_at.replace('T', ' ').slice(0, 16))}</td>
  <td><strong>${esc(r.name)}</strong><br><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? `<br><a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : ''}</td>
  <td>${esc(r.service || '')}</td>
  <td class="msg">${esc(r.message)}</td>
  <td class="${r.notify_status === 'sent' ? 'ok' : 'warn'}">${esc(r.notify_status)}</td>
</tr>`).join('')
    : '<tr><td colspan="5" class="empty">No enquiries yet.</td></tr>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Enquiries · The Pineapple Nation</title>
<style>
  :root{--ink:#1a1a1a;--paper:#fbfaf7;--muted:#6b6b66;--line:#e4e1d9;--blue:#2B61B1;--red:#D53E27}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:20px 16px;max-width:1200px;margin:0 auto}
  h1{font-size:1.25rem;font-weight:600;margin:0}
  .meta{color:var(--muted);font-size:.9rem}
  .btn{display:inline-block;padding:8px 16px;border-radius:999px;background:var(--blue);color:#fff;text-decoration:none;font-size:.9rem}
  .wrap{max-width:1200px;margin:0 auto;padding:0 16px 40px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;min-width:760px}
  th,td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid var(--line)}
  th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
  a{color:var(--blue)}
  .when{white-space:nowrap;color:var(--muted)}
  .msg{white-space:pre-wrap;max-width:44ch}
  .ok{color:#2f7d4f}.warn{color:var(--red)}
  .empty{color:var(--muted);text-align:center;padding:40px}
</style></head>
<body>
<header>
  <div><h1>Website enquiries</h1><div class="meta">${total} total${total > rows.length ? `, showing the latest ${rows.length}` : ''} · times in UTC · signed in as ${esc(viewer || '')}</div></div>
  <a class="btn" href="/admin/export.csv">Download CSV</a>
</header>
<div class="wrap"><table>
<thead><tr><th>Received</th><th>From</th><th>Service</th><th>Message</th><th>Email alert</th></tr></thead>
<tbody>${body}</tbody>
</table></div>
</body></html>`;
}

// ---------- helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Quote every cell, and stop spreadsheet apps treating a cell as a formula.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

function b64urlText(s) {
  return new TextDecoder().decode(b64urlBytes(s));
}
