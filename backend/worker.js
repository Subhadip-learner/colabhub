// backend/worker.js — Cloudflare Worker that finishes GitHub's OAuth web flow for ColabHub.
//
// WHY THIS EXISTS. GitHub's token endpoint requires the OAuth App's client_secret even with PKCE, and
// a secret must never ship inside a browser extension. So the extension does the whole user-facing
// flow itself (Authorize page → redirect back with a `code`) and only asks this Worker to swap the
// code for a token. The Worker holds the secret; users never see a Client ID or secret. It stores
// nothing and has no other endpoints:
//
//   POST /exchange  { code, redirect_uri, code_verifier? } -> { access_token, scope, token_type }
//   (code_verifier is the PKCE verifier; forwarded so GitHub can check it against the challenge)
//   POST /revoke    { access_token }              -> 204   (called on "Disconnect GitHub")
//   GET  /health                                  -> { ok, origin_allowed, client_id_set, secret_set }
//                                                    (used by the popup's setup screen "Test" button)
//
// Deploy (free tier):  npx wrangler login
//                      npx wrangler secret put GITHUB_CLIENT_ID
//                      npx wrangler secret put GITHUB_CLIENT_SECRET
//                      npx wrangler deploy              → https://colabhub-auth.<account>.workers.dev
//
// Secrets (set with `wrangler secret put`):
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
// Vars (wrangler.toml):
//   ALLOWED_EXTENSION_IDS = "opghjahdadhgakfklikfgmibfpajbggj"   comma-separated; requests from other
//                          extension origins are rejected. Leave empty to allow any (dev only).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin, env, true);
    if (url.pathname === '/health') {
      // Diagnostics only — never reveals secret values. CORS is always allowed here so the popup's
      // setup screen can tell "wrong URL" apart from "extension ID not allow-listed".
      const info = { ok: true, service: 'colabhub-auth', origin_allowed: originAllowed(origin, env), client_id_set: Boolean(env.GITHUB_CLIENT_ID), secret_set: Boolean(env.GITHUB_CLIENT_SECRET) };
      return cors(json(info), origin, env, true);
    }

    if (!originAllowed(origin, env)) {
      return cors(json({ error: 'forbidden_origin', error_description: `Origin ${origin || '(none)'} is not allowed` }, 403), origin, env);
    }
    if (request.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405), origin, env);

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json({ error: 'bad_request', error_description: 'Expected JSON body' }, 400), origin, env);
    }

    if (url.pathname === '/exchange') return cors(await exchange(body, env), origin, env);
    if (url.pathname === '/revoke') return cors(await revoke(body, env), origin, env);
    return cors(json({ error: 'not_found' }, 404), origin, env);
  },
};

async function exchange({ code, redirect_uri, code_verifier }, env) {
  if (!code || typeof code !== 'string') return json({ error: 'bad_request', error_description: 'code is required' }, 400);
  if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(redirect_uri ?? '')) {
    return json({ error: 'bad_request', error_description: 'redirect_uri must be a chromiumapp.org URL' }, 400);
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'colabhub-auth' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri, ...(code_verifier ? { code_verifier } : {}) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    return json({ error: data.error ?? 'exchange_failed', error_description: data.error_description ?? `GitHub returned ${res.status}` }, 400);
  }
  return json({ access_token: data.access_token, scope: data.scope ?? '', token_type: data.token_type ?? 'bearer' });
}

async function revoke({ access_token }, env) {
  if (!access_token) return json({ error: 'bad_request' }, 400);
  // DELETE /applications/{client_id}/token — basic auth with client id:secret
  const auth = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
  await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/vnd.github+json', 'User-Agent': 'colabhub-auth', 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token }),
  }).catch(() => {});
  return new Response(null, { status: 204 });
}

function originAllowed(origin, env) {
  const allowed = (env.ALLOWED_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true; // dev mode
  return allowed.some((id) => origin === `chrome-extension://${id}`);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function cors(res, origin, env, always = false) {
  const h = new Headers(res.headers);
  if ((always || originAllowed(origin, env)) && origin) h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
  h.set('Vary', 'Origin');
  h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}
