// The Pineapple Nation: static site plus contact form backend.
//   POST /api/contact     store an enquiry in D1, then email the team
//   GET  /admin           list enquiries, after signing in with ADMIN_PASSWORD
//   GET  /admin/export.csv
// Everything else is served from the static assets.

const LIMITS = { name: 120, email: 254, phone: 40, service: 80, message: 5000 };
const RATE_LIMIT = 5; // enquiries per IP per 10 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 7;
const LOGIN_LIMIT = 10; // failed sign-ins per IP per 15 minutes
const COOKIE = 'tpn_admin';

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

// The password is the Worker secret ADMIN_PASSWORD. It also signs the session
// cookie, so changing it signs everyone out. Without it, /admin stays closed.
async function admin(request, env, url) {
  if (!env.ADMIN_PASSWORD) return new Response('Not found', { status: 404 });
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response('Forbidden', { status: 403 });
    if (path === '/admin/login') return login(request, env);
    if (path === '/admin/logout') return redirect('/admin', clearCookie());
    return new Response('Not found', { status: 404 });
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const signedIn = await validSession(request, env);
  if (path === '/admin/export.csv') return signedIn ? exportCsv(env) : redirect('/admin');
  if (path !== '/admin') return new Response('Not found', { status: 404 });
  if (!signedIn) return html(loginPage(), 200);

  const { results } = await env.DB.prepare(
    'SELECT id, created_at, name, email, phone, service, message, notify_status FROM submissions ORDER BY id DESC LIMIT 500'
  ).all();
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM submissions').first('n');
  return html(adminPage(results, total), 200);
}

async function login(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const failures = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-15 minutes')"
  ).bind(ip).first('n');
  if (failures >= LOGIN_LIMIT) return html(loginPage('Too many attempts. Try again in 15 minutes.'), 429);

  let password = '';
  try { password = String((await request.formData()).get('password') ?? ''); } catch {}
  if (!(await sameSecret(password, env.ADMIN_PASSWORD))) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip) VALUES (?)').bind(ip),
      env.DB.prepare("DELETE FROM login_failures WHERE at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')"),
    ]);
    return html(loginPage('That password isn’t right.'), 401);
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const cookie = `${COOKIE}=${exp}.${await sign(env.ADMIN_PASSWORD, `admin:${exp}`)}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;
  return redirect('/admin', cookie);
}

async function validSession(request, env) {
  const value = (request.headers.get('Cookie') || '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [exp, sig] = (value || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return sameSecret(sig, await sign(env.ADMIN_PASSWORD, `admin:${exp}`));
}

async function exportCsv(env) {
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

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

// Compare digests so the check takes the same time whatever the input.
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
  return crypto.subtle.timingSafeEqual(x, y);
}

function clearCookie() {
  return `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function redirect(location, cookie) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

function html(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'same-origin',
    },
  });
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · The Pineapple Nation</title>
<link rel="icon" href="/assets/submark-black.png">
<style>
  :root{--ink:#1a1a1a;--paper:#fbfaf7;--muted:#6b6b66;--line:#e4e1d9;--blue:#2B61B1;--red:#D53E27}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--blue)}
  .btn{display:inline-block;padding:9px 18px;border:0;border-radius:999px;background:var(--blue);color:#fff;text-decoration:none;font:inherit;font-size:.9rem;cursor:pointer}
  .btn.ghost{background:none;color:var(--ink);border:1px solid var(--line)}
  .login{min-height:100vh;display:grid;place-items:center;padding:16px}
  .card{width:100%;max-width:360px;display:grid;gap:14px}
  .card img{width:44px;margin-bottom:6px}
  .card h1{font-size:1.25rem;font-weight:600;margin:0}
  .card label{font-size:.85rem;color:var(--muted)}
  .card input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font:inherit;background:#fff}
  .card input:focus{outline:2px solid var(--blue);outline-offset:1px;border-color:transparent}
  .card .btn{padding:11px 18px;font-size:.95rem}
  .error{margin:0;color:var(--red);font-size:.9rem}
  header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:20px 16px;max-width:1200px;margin:0 auto}
  header h1{font-size:1.25rem;font-weight:600;margin:0}
  .meta{color:var(--muted);font-size:.9rem}
  .actions{display:flex;gap:8px;align-items:center}
  .actions form{margin:0}
  .wrap{max-width:1200px;margin:0 auto;padding:0 16px 40px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;min-width:760px}
  th,td{text-align:left;vertical-align:top;padding:12px 10px;border-bottom:1px solid var(--line)}
  th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
  .when{white-space:nowrap;color:var(--muted)}
  .msg{white-space:pre-wrap;max-width:44ch}
  .ok{color:#2f7d4f}.warn{color:var(--red)}
  .empty{color:var(--muted);text-align:center;padding:40px}
</style></head>
<body>${body}</body></html>`;
}

function loginPage(error) {
  return shell('Sign in', `
<main class="login">
  <form class="card" method="post" action="/admin/login">
    <img src="/assets/submark-black.png" alt="">
    <h1>Website enquiries</h1>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <button class="btn" type="submit">Sign in</button>
  </form>
</main>`);
}

function adminPage(rows, total) {
  const body = rows.length
    ? rows.map(r => `<tr>
  <td class="when">${esc(r.created_at.replace('T', ' ').slice(0, 16))}</td>
  <td><strong>${esc(r.name)}</strong><br><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.phone ? `<br><a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>` : ''}</td>
  <td>${esc(r.service || '')}</td>
  <td class="msg">${esc(r.message)}</td>
  <td class="${r.notify_status === 'sent' ? 'ok' : 'warn'}">${esc(r.notify_status)}</td>
</tr>`).join('')
    : '<tr><td colspan="5" class="empty">No enquiries yet.</td></tr>';
  return shell('Enquiries', `
<header>
  <div><h1>Website enquiries</h1><div class="meta">${total} total${total > rows.length ? `, showing the latest ${rows.length}` : ''} · times in UTC</div></div>
  <div class="actions">
    <a class="btn" href="/admin/export.csv">Download CSV</a>
    <form method="post" action="/admin/logout"><button class="btn ghost" type="submit">Sign out</button></form>
  </div>
</header>
<div class="wrap"><table>
<thead><tr><th>Received</th><th>From</th><th>Service</th><th>Message</th><th>Email alert</th></tr></thead>
<tbody>${body}</tbody>
</table></div>`);
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

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
