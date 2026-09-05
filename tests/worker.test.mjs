// Unit test for backend/worker.js — the hosted token exchange. Runs the Worker's fetch handler
// in-process against a fake github.com.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../backend/worker.js';

const EXT = 'opghjahdadhgakfklikfgmibfpajbggj';
const ORIGIN = `chrome-extension://${EXT}`;
const REDIRECT = `https://${EXT}.chromiumapp.org/github`;
const env = { GITHUB_CLIENT_ID: 'Ov23liPublisher', GITHUB_CLIENT_SECRET: 'f'.repeat(40), ALLOWED_EXTENSION_IDS: EXT };

const githubCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  githubCalls.push({ url: String(url), method: init.method, headers: init.headers, body });
  if (url === 'https://github.com/login/oauth/access_token') {
    if (body.client_id !== env.GITHUB_CLIENT_ID || body.client_secret !== env.GITHUB_CLIENT_SECRET) {
      return Response.json({ error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
    }
    if (body.code !== 'good-code') return Response.json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    return Response.json({ access_token: 'gho_secret_token', scope: 'repo,read:org', token_type: 'bearer' });
  }
  if (String(url).startsWith('https://api.github.com/applications/')) return new Response(null, { status: 204 });
  throw new Error(`unexpected fetch ${url}`);
};

const call = (path, { method = 'POST', body, origin = ORIGIN, e = env } = {}) =>
  worker.fetch(new Request(`https://colabhub-auth.example.workers.dev${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);

test('/exchange: adds the client secret server-side, forwards the PKCE verifier, returns only the token fields', async () => {
  githubCalls.length = 0;
  const res = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { access_token: 'gho_secret_token', scope: 'repo,read:org', token_type: 'bearer' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(githubCalls.length, 1);
  assert.equal(githubCalls[0].body.client_secret, env.GITHUB_CLIENT_SECRET);
  assert.equal(githubCalls[0].body.code_verifier, 'v'.repeat(43));
  assert.equal(githubCalls[0].body.redirect_uri, REDIRECT);
});

test('/exchange: GitHub errors are passed through as 400 with the description', async () => {
  const res = await call('/exchange', { body: { code: 'stale', redirect_uri: REDIRECT } });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'bad_verification_code');
  assert.match(data.error_description, /expired/);

  const wrong = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT }, e: { ...env, GITHUB_CLIENT_SECRET: 'nope' } });
  assert.equal((await wrong.json()).error, 'incorrect_client_credentials');
});

test('/exchange: validates input — code required, redirect_uri must be a chromiumapp.org URL, JSON only', async () => {
  assert.equal((await call('/exchange', { body: { redirect_uri: REDIRECT } })).status, 400);
  const evil = await call('/exchange', { body: { code: 'good-code', redirect_uri: 'https://attacker.example/cb' } });
  assert.equal(evil.status, 400);
  assert.match((await evil.json()).error_description, /chromiumapp\.org/);
  const notJson = await worker.fetch(new Request('https://x.workers.dev/exchange', { method: 'POST', headers: { Origin: ORIGIN }, body: 'code=1' }), env);
  assert.equal(notJson.status, 400);
});

test('origin allow-list: other extensions / web pages get 403 and no CORS grant; empty list = dev mode', async () => {
  const other = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT }, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(other.status, 403);
  assert.equal((await other.json()).error, 'forbidden_origin');
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);

  const web = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT }, origin: 'https://evil.example' });
  assert.equal(web.status, 403);

  const dev = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT }, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', e: { ...env, ALLOWED_EXTENSION_IDS: '' } });
  assert.equal(dev.status, 200);

  const multi = await call('/exchange', { body: { code: 'good-code', redirect_uri: REDIRECT }, origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', e: { ...env, ALLOWED_EXTENSION_IDS: `${EXT}, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` } });
  assert.equal(multi.status, 200);
});

test('/health: diagnostics for the setup screen (never the secret values), CORS always granted', async () => {
  const res = await call('/health', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'colabhub-auth', origin_allowed: true, client_id_set: true, secret_set: true });

  const foreign = await call('/health', { method: 'GET', origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(foreign.status, 200);
  assert.equal((await foreign.json()).origin_allowed, false, 'tells the developer their ID is not allow-listed');
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  const unset = await call('/health', { method: 'GET', e: { ...env, GITHUB_CLIENT_SECRET: '' } });
  const body = await unset.json();
  assert.equal(body.secret_set, false);
  assert.equal(JSON.stringify(body).includes('f'.repeat(40)), false);
});

test('/revoke: calls DELETE /applications/{client_id}/token with basic auth and answers 204; preflight OK', async () => {
  githubCalls.length = 0;
  const res = await call('/revoke', { body: { access_token: 'gho_secret_token' } });
  assert.equal(res.status, 204);
  assert.equal(githubCalls.length, 1);
  assert.equal(githubCalls[0].method, 'DELETE');
  assert.equal(githubCalls[0].url, `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`);
  assert.equal(githubCalls[0].headers.Authorization, `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`);

  const pre = await call('/exchange', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');

  assert.equal((await call('/exchange', { method: 'GET' })).status, 405);
  assert.equal((await call('/nope', { body: {} })).status, 404);
});
