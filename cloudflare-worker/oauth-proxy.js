/**
 * Cloudflare Worker — GitHub OAuth token exchange proxy + usage analytics
 *
 * Routes:
 *   POST /          — exchange OAuth code for GitHub access token
 *   GET  /stats     — HTML dashboard (requires ?key=STATS_KEY)
 *
 * Secrets (set via wrangler secret put):
 *   GH_CLIENT_ID      — GitHub App client ID
 *   GH_CLIENT_SECRET  — GitHub App client secret
 *   STATS_KEY         — password for the /stats dashboard
 *
 * D1 binding (see wrangler.toml):
 *   DB — rospad-analytics database
 *
 * Analytics schema (run once with wrangler d1 execute):
 *   CREATE TABLE IF NOT EXISTS sessions (
 *     id        INTEGER PRIMARY KEY AUTOINCREMENT,
 *     user_hash TEXT    NOT NULL,
 *     ts        INTEGER NOT NULL,
 *     country   TEXT
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_hash);
 *   CREATE INDEX IF NOT EXISTS idx_sessions_ts   ON sessions(ts);
 *
 * Privacy: only a one-way SHA-256 hash of the GitHub username is stored.
 * The hash cannot be reversed. Raw usernames are never written to disk.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/stats') {
      return handleStats(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // ── OAuth token exchange ─────────────────────────────────────────────────

    let code;
    try {
      ({ code } = await request.json());
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS });
    }
    if (!code) {
      return new Response(JSON.stringify({ error: 'Missing code' }), { status: 400, headers: CORS });
    }

    const ghResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id:     env.GH_CLIENT_ID,
        client_secret: env.GH_CLIENT_SECRET,
        code,
      }),
    });

    const data = await ghResp.json();

    // ── Fire-and-forget analytics (does not delay the login response) ────────
    if (data.access_token && env.DB) {
      ctx.waitUntil(trackSession(data.access_token, request, env));
    }

    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};

// ── Session tracking ─────────────────────────────────────────────────────────

async function trackSession(token, request, env) {
  try {
    const userResp = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'rospad-analytics' },
    });
    if (!userResp.ok) return;
    const { login } = await userResp.json();
    if (!login) return;

    const userHash = await sha256(login.toLowerCase());
    const ts       = Math.floor(Date.now() / 1000);
    const country  = request.cf?.country ?? null;

    await env.DB.prepare(
      'INSERT INTO sessions (user_hash, ts, country) VALUES (?, ?, ?)'
    ).bind(userHash, ts, country).run();
  } catch {
    // never let analytics errors surface to the user
  }
}

async function sha256(text) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Stats dashboard ──────────────────────────────────────────────────────────

async function handleStats(request, env) {
  const url = new URL(request.url);
  if (!env.STATS_KEY || url.searchParams.get('key') !== env.STATS_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!env.DB) {
    return new Response('D1 database not bound', { status: 503 });
  }

  const now7d  = Math.floor(Date.now() / 1000) - 7  * 86400;
  const now30d = Math.floor(Date.now() / 1000) - 30 * 86400;

  const [
    totalUsers,
    totalSessions,
    mau,
    dau7d,
    returnUsers,
    newUsers30d,
    topCountries,
    daily30d,
  ] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(DISTINCT user_hash) AS n FROM sessions'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions'),
    env.DB.prepare('SELECT COUNT(DISTINCT user_hash) AS n FROM sessions WHERE ts > ?').bind(now30d),
    env.DB.prepare('SELECT COUNT(DISTINCT user_hash) AS n FROM sessions WHERE ts > ?').bind(now7d),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT user_hash FROM sessions GROUP BY user_hash HAVING COUNT(*) > 1
      )
    `),
    env.DB.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT user_hash FROM sessions GROUP BY user_hash
        HAVING MIN(ts) > ?
      )
    `).bind(now30d),
    env.DB.prepare(`
      SELECT country, COUNT(DISTINCT user_hash) AS users
      FROM sessions WHERE country IS NOT NULL
      GROUP BY country ORDER BY users DESC LIMIT 10
    `),
    env.DB.prepare(`
      SELECT DATE(ts, 'unixepoch') AS day, COUNT(DISTINCT user_hash) AS users
      FROM sessions WHERE ts > ?
      GROUP BY day ORDER BY day
    `).bind(now30d),
  ]);

  const v = r => r.results?.[0]?.n ?? 0;
  const stats = {
    total_users:    v(totalUsers),
    total_sessions: v(totalSessions),
    mau:            v(mau),
    dau_7d:         v(dau7d),
    return_users:   v(returnUsers),
    new_users_30d:  v(newUsers30d),
    top_countries:  topCountries.results ?? [],
    daily_30d:      daily30d.results ?? [],
  };

  return new Response(renderDashboard(stats), {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

function renderDashboard(s) {
  const returnPct = s.total_users > 0
    ? ((s.return_users / s.total_users) * 100).toFixed(1)
    : '0.0';

  const dailyRows = s.daily_30d.map(r =>
    `<tr><td>${r.day}</td><td>${r.users}</td></tr>`
  ).join('');

  const countryRows = s.top_countries.map(r =>
    `<tr><td>${r.country}</td><td>${r.users}</td></tr>`
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>ROSpad Usage Stats</title>
<style>
  body{font-family:monospace;background:#0d1117;color:#c9d1d9;padding:2rem;max-width:800px;margin:0 auto}
  h1{color:#58a6ff;margin-bottom:.3rem}
  .sub{color:#8b949e;font-size:.85rem;margin-bottom:2rem}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:2rem}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem}
  .card .val{font-size:2rem;font-weight:bold;color:#58a6ff}
  .card .lbl{font-size:.75rem;color:#8b949e;margin-top:.25rem}
  table{width:100%;border-collapse:collapse;margin-bottom:2rem}
  th{text-align:left;color:#8b949e;font-size:.75rem;padding:.4rem .6rem;border-bottom:1px solid #30363d}
  td{padding:.35rem .6rem;border-bottom:1px solid #21262d;font-size:.85rem}
  h2{color:#8b949e;font-size:.85rem;text-transform:uppercase;letter-spacing:.1em;margin:1.5rem 0 .5rem}
  .note{font-size:.75rem;color:#8b949e;margin-top:2rem;border-top:1px solid #21262d;padding-top:1rem}
</style></head><body>
<h1>ROSpad Usage Stats</h1>
<div class="sub">Generated ${new Date().toUTCString()} · hashed user IDs only · no PII stored</div>

<div class="grid">
  <div class="card"><div class="val">${s.total_users}</div><div class="lbl">Total unique users</div></div>
  <div class="card"><div class="val">${s.mau}</div><div class="lbl">Active last 30 days (MAU)</div></div>
  <div class="card"><div class="val">${s.dau_7d}</div><div class="lbl">Active last 7 days</div></div>
  <div class="card"><div class="val">${s.total_sessions}</div><div class="lbl">Total login sessions</div></div>
  <div class="card"><div class="val">${s.return_users}</div><div class="lbl">Return users (2+ logins)</div></div>
  <div class="card"><div class="val">${returnPct}%</div><div class="lbl">Return rate</div></div>
</div>

<h2>Daily active users — last 30 days</h2>
<table><tr><th>Date</th><th>Unique users</th></tr>${dailyRows || '<tr><td colspan="2">No data yet</td></tr>'}</table>

<h2>Top countries</h2>
<table><tr><th>Country</th><th>Unique users</th></tr>${countryRows || '<tr><td colspan="2">No data yet</td></tr>'}</table>

<div class="note">
  Privacy: each row represents one login session. The user_hash is a one-way SHA-256 hash
  of the GitHub username — it cannot be reversed to identify any individual.
  No workspace files, code, or browsing behaviour is ever collected.
</div>
</body></html>`;
}
