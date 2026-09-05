// lib/appconfig.js — effective configuration = build-time defaults (config.js) overridden by
// values saved at runtime in chrome.storage.local ("appConfig").
//
// Why: the OAuth client ID and the token-exchange backend URL belong to whoever *publishes* the
// extension. When you ship a build with them filled in config.js, users never see any setup. But
// while developing — or when someone loads the unpacked source — the popup can collect them through
// a guided screen instead of asking the developer to edit a file.

import { CONFIG } from '../config.js';

const BUILD = CONFIG; // build-time defaults

const KEY = 'appConfig';
const OVERRIDABLE = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_AUTH_METHOD', 'TOKEN_EXCHANGE_URL', 'GOOGLE_CLIENT_ID'];

let cache = null;

/** @returns {Promise<typeof BUILD>} */
export async function getConfig() {
  if (cache) return cache;
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const merged = { ...BUILD };
  for (const k of OVERRIDABLE) {
    const v = saved?.[k];
    if (typeof v === 'string' && v.trim()) merged[k] = v.trim();
  }
  cache = Object.freeze(merged);
  return cache;
}

/** Save runtime overrides (only whitelisted keys; empty string clears an override). */
export async function setConfigOverrides(patch) {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const next = { ...(saved ?? {}) };
  for (const k of OVERRIDABLE) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? '').trim();
    if (v) next[k] = v;
    else delete next[k];
  }
  await chrome.storage.local.set({ [KEY]: next });
  cache = null;
  return getConfig();
}

/** Which keys came from the build vs. runtime — for the setup screen. */
export async function describeConfig() {
  const { [KEY]: saved } = await chrome.storage.local.get(KEY);
  const cfg = await getConfig();
  return {
    githubClientId: cfg.GITHUB_CLIENT_ID,
    githubAuthMethod: cfg.GITHUB_AUTH_METHOD === 'device' ? 'device' : 'oauth',
    githubClientSecretSet: Boolean(cfg.GITHUB_CLIENT_SECRET), // never expose the value to the UI
    tokenExchangeUrl: cfg.TOKEN_EXCHANGE_URL,
    // how the authorization code becomes a token: 'backend' (Worker, production) | 'secret' (dev) | 'none'
    githubExchange: cfg.TOKEN_EXCHANGE_URL ? 'backend' : cfg.GITHUB_CLIENT_SECRET ? 'secret' : 'none',
    googleClientId: cfg.GOOGLE_CLIENT_ID,
    fromBuild: {
      github: Boolean(BUILD.GITHUB_CLIENT_ID),
      tokenExchange: Boolean(BUILD.TOKEN_EXCHANGE_URL),
      google: Boolean(BUILD.GOOGLE_CLIENT_ID),
    },
    overrides: Object.fromEntries(Object.entries(saved ?? {}).filter(([k]) => k !== 'GITHUB_CLIENT_SECRET')),
  };
}

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === 'local' && changes[KEY]) cache = null;
});
