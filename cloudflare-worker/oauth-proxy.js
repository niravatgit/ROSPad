/**
 * Cloudflare Worker — GitHub OAuth token exchange proxy
 *
 * Receives { code } from the ROSpad GitHub Pages frontend and exchanges it
 * for an access_token using the stored client_secret (never exposed to the browser).
 *
 * Deploy:
 *   wrangler secret put GH_CLIENT_ID
 *   wrangler secret put GH_CLIENT_SECRET
 *   wrangler deploy
 *
 * Set the Worker URL as OAUTH_PROXY_URL in public/js/github-api.js.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

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
    return new Response(JSON.stringify(data), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  },
};
