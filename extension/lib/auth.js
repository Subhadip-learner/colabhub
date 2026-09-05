// lib/auth.js — GitHub OAuth (web flow + backend token exchange) and Google Drive OAuth.
// Runs in the MV3 service worker and uses chrome.identity.
//
// Why a backend for GitHub?  GitHub's web flow requires the client *secret* to swap the
// authorization code for a token, and a secret can't live inside an extension. The backend
// (backend/worker.js) is ~40 lines and only does that swap.
//
// Why no backend for Google?  Google supports the implicit flow (response_type=token) for
// public clients, so the extension can obtain a short-lived Drive token directly.

import { getConfig } from './appconfig.js';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_ACCESS_TOKEN = 'https://github.com/login/oauth/access_token';
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const SESSION_KEY = 'googleTokenCache';
let googleWebFlowInFlight = null;

function randomState() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function launchWebAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!redirectUrl) return reject(new Error('Authorization was cancelled'));
      resolve(redirectUrl);
    });
  });
}

/** 'oauth' (authorization code + PKCE, default) or 'device' (RFC 8628, opt-in). */
export async function githubAuthMethod() {
  const CONFIG = await getConfig();
  return CONFIG.GITHUB_AUTH_METHOD === 'device' ? 'device' : 'oauth';
}

/**
 * True when "Connect GitHub" can actually succeed: a Client ID plus a way to finish the token
 * exchange (backend URL or, for personal builds, the client secret). The device flow needs only
 * the Client ID. When false the popup shows the publisher setup screen instead of a dead button.
 */
export async function githubOAuthAvailable() {
  const CONFIG = await getConfig();
  if (!CONFIG.GITHUB_CLIENT_ID) return false;
  if (CONFIG.GITHUB_AUTH_METHOD === 'device') return true;
  return githubExchangeMode(CONFIG) !== 'none';
}

export async function googleAuthAvailable() {
  const CONFIG = await getConfig();
  if (CONFIG.GOOGLE_AUTH_METHOD === 'chrome') return Boolean(chrome.runtime.getManifest().oauth2?.client_id);
  return Boolean(CONFIG.GOOGLE_CLIENT_ID);
}

/** The redirect URLs you must register with GitHub / Google (shown in the popup's setup screen). */
export function redirectUrls() {
  return { github: chrome.identity.getRedirectURL('github'), google: chrome.identity.getRedirectURL('google') };
}

// ------------------------------------------------------------------ GitHub --
//
// Standard OAuth 2.0 authorization-code flow (+ PKCE, RFC 7636, supported by GitHub since July
// 2025). The user clicks "Connect GitHub", sees GitHub's normal Authorize page in a popup, clicks
// Authorize, and is back in the extension — no codes to type.
//
//   1. generate code_verifier (random) + code_challenge = BASE64URL(SHA-256(verifier))
//   2. launchWebAuthFlow → github.com/login/oauth/authorize?...&code_challenge=…&code_challenge_method=S256
//   3. GitHub redirects to https://<ext-id>.chromiumapp.org/github?code=…&state=…
//   4. exchange the code for a token. GitHub REQUIRES the OAuth App's client_secret at the token
//      endpoint (it "does not distinguish between public and confidential clients"; a secret-less
//      PKCE exchange is answered with incorrect_client_credentials). The secret must never ship
//      inside the extension, so:
//        - production: POST code (+ verifier) to TOKEN_EXCHANGE_URL — the tiny backend in
//          backend/worker.js adds the secret and returns the token. Users never see any key.
//        - personal / unpacked build: GITHUB_CLIENT_SECRET in the profile, exchange directly.
//        - neither configured: try the plain PKCE exchange anyway and explain the failure.

function base64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw); // 43 chars
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export async function githubOAuth() {
  const CONFIG = await getConfig();
  if (!CONFIG.GITHUB_CLIENT_ID) {
    throw new Error('GitHub sign-in is not configured — add the OAuth App Client ID first, or use a personal access token.');
  }
  const redirectUri = chrome.identity.getRedirectURL('github');
  const state = randomState();
  const { verifier, challenge } = await pkcePair();
  const params = new URLSearchParams({
    client_id: CONFIG.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CONFIG.GITHUB_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const redirected = new URL(await launchWebAuthFlow(`${GITHUB_AUTHORIZE}?${params}`, true));
  const err = redirected.searchParams.get('error_description') || redirected.searchParams.get('error');
  if (err) throw new Error(`GitHub: ${err}`);
  const code = redirected.searchParams.get('code');
  if (!code) throw new Error('GitHub did not return an authorization code');
  if (redirected.searchParams.get('state') !== state) throw new Error('OAuth state mismatch — please try again');

  // 4. exchange the code — see the note at the top of this section for why the order is this.
  const data = await exchangeCode(CONFIG, { code, redirectUri, verifier });
  if (!data.access_token) throw new Error(explainExchangeFailure(CONFIG, data));
  return { token: data.access_token, scope: data.scope ?? '' };
}

/** Which component finishes the code→token exchange for this configuration. */
export function githubExchangeMode(CONFIG) {
  if (CONFIG.TOKEN_EXCHANGE_URL) return 'backend';
  if (CONFIG.GITHUB_CLIENT_SECRET) return 'secret';
  return 'none';
}

async function exchangeCode(CONFIG, args) {
  const mode = githubExchangeMode(CONFIG);
  if (mode === 'backend') {
    const data = await exchangeViaBackend(CONFIG, args);
    // Backend unreachable (not deployed yet / offline) but a secret is configured for local dev → use it.
    if (!data.access_token && data.error === 'network_error' && CONFIG.GITHUB_CLIENT_SECRET) {
      return exchangeDirect(CONFIG, { ...args, secret: CONFIG.GITHUB_CLIENT_SECRET });
    }
    return data;
  }
  if (mode === 'secret') return exchangeDirect(CONFIG, { ...args, secret: CONFIG.GITHUB_CLIENT_SECRET });
  return exchangeDirect(CONFIG, args); // PKCE only — GitHub rejects this today; kept for the day it doesn't
}

function explainExchangeFailure(CONFIG, data) {
  const why = data.error_description || data.error || 'token exchange failed';
  const mode = githubExchangeMode(CONFIG);
  if (mode === 'backend') {
    const url = CONFIG.TOKEN_EXCHANGE_URL;
    if (data.error === 'network_error') {
      return `GitHub sign-in: could not reach the token-exchange backend at ${url} (${why}). Is the Worker deployed (npm run backend:deploy) and the URL correct?`;
    }
    if (data.error === 'forbidden_origin') {
      return `GitHub sign-in: the backend at ${url} rejected this extension (${why}). Add this extension's ID (${chrome.runtime.id}) to ALLOWED_EXTENSION_IDS in backend/wrangler.toml and redeploy.`;
    }
    if (/incorrect_client_credentials/i.test(data.error ?? '')) {
      return `GitHub sign-in: the backend at ${url} has the wrong GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET for this OAuth App (${why}). Re-run "npx wrangler secret put" for both and redeploy.`;
    }
    return `GitHub sign-in failed at the token-exchange backend (${url}): ${why}.`;
  }
  const wantsSecret = /incorrect_client_credentials|client_secret/i.test(`${data.error ?? ''} ${data.error_description ?? ''}`);
  if (mode === 'none' && wantsSecret) {
    return `GitHub: ${why}. GitHub requires the OAuth App's client secret to finish sign-in, and this build has no token-exchange backend configured. Publisher: deploy backend/worker.js (README → "Publisher setup") and enter its URL on the setup screen (Settings → "Open the sign-in setup screen") or in config.js. For a personal build you can paste the client secret there instead.`;
  }
  if (mode === 'secret' && wantsSecret) {
    return `GitHub: ${why}. The saved client secret does not match this Client ID — regenerate it on the OAuth App page and paste it again on the setup screen.`;
  }
  return `GitHub: ${why}.`;
}

async function exchangeDirect(CONFIG, { code, redirectUri, verifier, secret }) {
  try {
    const res = await fetch(GITHUB_ACCESS_TOKEN, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CONFIG.GITHUB_CLIENT_ID, ...(secret ? { client_secret: secret } : {}), code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    return await res.json().catch(() => ({ error: `http_${res.status}` }));
  } catch (e) {
    return { error: 'network_error', error_description: e.message };
  }
}

async function exchangeViaBackend(CONFIG, { code, redirectUri, verifier }) {
  try {
    const res = await fetch(`${CONFIG.TOKEN_EXCHANGE_URL.replace(/\/$/, '')}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    return await res.json().catch(() => ({ error: `backend_http_${res.status}`, error_description: `backend returned HTTP ${res.status}` }));
  } catch (e) {
    return { error: 'network_error', error_description: e.message };
  }
}

/**
 * Publisher setup helper: ping TOKEN_EXCHANGE_URL/health. Never throws.
 * @returns {Promise<{ok:boolean, reachable:boolean, originAllowed?:boolean, clientIdSet?:boolean, secretSet?:boolean, message:string}>}
 */
export async function checkTokenExchange(url) {
  const base = String(url ?? '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, reachable: false, message: 'Enter the Worker URL, e.g. https://colabhub-auth.<you>.workers.dev' };
  try {
    const res = await fetch(`${base}/health`, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* older worker answered plain "ok" */ }
    if (!res.ok) return { ok: false, reachable: true, message: `The URL answered HTTP ${res.status} — is this the ColabHub Worker?` };
    if (!data || typeof data !== 'object') {
      return /^ok\b/.test(text.trim()) ? { ok: true, reachable: true, message: 'Backend reachable ✓' } : { ok: false, reachable: true, message: 'Unexpected response — is this the ColabHub Worker?' };
    }
    if (data.origin_allowed === false) return { ok: false, reachable: true, originAllowed: false, message: `Backend reachable, but it rejects this extension (${chrome.runtime.id}). Add the ID to ALLOWED_EXTENSION_IDS in backend/wrangler.toml and redeploy.` };
    if (data.client_id_set === false || data.secret_set === false) return { ok: false, reachable: true, originAllowed: true, clientIdSet: data.client_id_set, secretSet: data.secret_set, message: 'Backend reachable, but GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set — run "npx wrangler secret put" for both and redeploy.' };
    return { ok: true, reachable: true, originAllowed: true, clientIdSet: true, secretSet: true, message: 'Backend reachable and configured ✓' };
  } catch (e) {
    return { ok: false, reachable: false, message: `Could not reach ${base} (${e.message}). Deploy it with "npm run backend:deploy" or check the URL.` };
  }
}

// ------------------------------------------------------- GitHub Device Flow --
//
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
//   1. POST /login/device/code            → { device_code, user_code, verification_uri, interval }
//   2. show user_code, open verification_uri in a tab; the user types the code on github.com
//   3. poll POST /login/oauth/access_token with grant_type=device_code until it returns a token
// No client secret, no redirect URL, no backend. Requires "Enable Device Flow" on the OAuth App.

const GITHUB_DEVICE_CODE = 'https://github.com/login/device/code';

/**
 * Step 1+2: request a device code. Returns what the popup needs to display.
 * @returns {Promise<{deviceCode:string, userCode:string, verificationUri:string, interval:number, expiresAt:number}>}
 */
export async function githubDeviceStart() {
  const CONFIG = await getConfig();
  if (!CONFIG.GITHUB_CLIENT_ID) throw new Error('GitHub OAuth is not configured — set GITHUB_CLIENT_ID in config.js.');
  const res = await fetch(GITHUB_DEVICE_CODE, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CONFIG.GITHUB_CLIENT_ID, scope: CONFIG.GITHUB_SCOPES }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    const hint = res.status === 404 || data.error === 'device_flow_disabled'
      ? ' Open your OAuth App on github.com and tick "Enable Device Flow".'
      : '';
    throw new Error(`${data.error_description || data.error || `GitHub returned ${res.status}`}.${hint}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    interval: Math.max(1, Number(data.interval) || 5),
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  };
}

/**
 * Step 3: one poll. Returns { status: 'pending' | 'slow_down' | 'ok', token?, scope? } or throws
 * for terminal errors (expired, denied, misconfigured).
 */
export async function githubDevicePoll(deviceCode) {
  const CONFIG = await getConfig();
  const res = await fetch(GITHUB_ACCESS_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CONFIG.GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.access_token) return { status: 'ok', token: data.access_token, scope: data.scope ?? '' };
  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down', interval: Number(data.interval) || 10 };
    case 'expired_token':
      throw new Error('The code expired before it was entered on GitHub. Click "Connect GitHub" to get a new one.');
    case 'access_denied':
      throw new Error('You cancelled the authorization on GitHub.');
    default:
      throw new Error(data.error_description || data.error || `GitHub returned ${res.status}`);
  }
}

// ------------------------------------------------------------------ Google --

async function readCache() {
  const { [SESSION_KEY]: c } = await chrome.storage.session.get(SESSION_KEY);
  return c ?? null;
}

async function writeCache(c) {
  if (c) await chrome.storage.session.set({ [SESSION_KEY]: c });
  else await chrome.storage.session.remove(SESSION_KEY);
}

/**
 * Get a Drive access token.
 *  - interactive=true  : may show the Google account chooser / consent screen
 *  - interactive=false : silent refresh (prompt=none); throws if user interaction is needed
 * @param {{interactive?: boolean, loginHint?: string}} opts
 */
export async function googleToken({ interactive = false, loginHint } = {}) {
  const CONFIG = await getConfig();
  const cached = await readCache();
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  let token;
  let expiresIn = 3600;

  if (CONFIG.GOOGLE_AUTH_METHOD === 'chrome') {
    token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive, scopes: [CONFIG.DRIVE_SCOPE] }, (t) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(typeof t === 'string' ? t : t?.token);
      });
    });
  } else {
    if (!CONFIG.GOOGLE_CLIENT_ID) throw new Error('Google Drive access is not configured — set GOOGLE_CLIENT_ID in config.js.');
    const redirectUri = chrome.identity.getRedirectURL('google');
    const state = randomState();
    const params = new URLSearchParams({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'token',
      scope: CONFIG.DRIVE_SCOPE,
      state,
      include_granted_scopes: 'true',
    });
    if (loginHint) params.set('login_hint', loginHint);
    if (!interactive) params.set('prompt', 'none');

    let redirected;
    const flow = googleWebFlowInFlight ?? (googleWebFlowInFlight = launchWebAuthFlow(`${GOOGLE_AUTHORIZE}?${params}`, interactive));
    try {
      redirected = new URL(await flow);
    } catch (e) {
      if (!interactive) throw new NeedsInteractionError(`Google Drive sign-in required (${e.message})`);
      throw e;
    } finally {
      if (googleWebFlowInFlight === flow) googleWebFlowInFlight = null;
    }
    const frag = new URLSearchParams(redirected.hash.replace(/^#/, ''));
    const err = frag.get('error') || redirected.searchParams.get('error');
    if (err) {
      if (!interactive) throw new NeedsInteractionError(`Google Drive sign-in required (${err})`);
      throw new Error(`Google: ${err}`);
    }
    if (frag.get('state') !== state) throw new Error('OAuth state mismatch — please try again');
    token = frag.get('access_token');
    expiresIn = Number(frag.get('expires_in') || 3600);
  }

  if (!token) throw new Error('Google did not return an access token');
  await writeCache({ token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

/** Drop a cached Google token (e.g. after a 401). */
export async function forgetGoogleToken() {
  const CONFIG = await getConfig();
  const c = await readCache();
  await writeCache(null);
  if (c?.token && CONFIG.GOOGLE_AUTH_METHOD === 'chrome') {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token: c.token }, r));
  }
}

export class NeedsInteractionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'NeedsInteractionError';
    this.needsInteraction = true;
  }
}
