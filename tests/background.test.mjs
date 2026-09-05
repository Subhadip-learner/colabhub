// Integration test: runs the real background.js service worker against a fake `chrome` API,
// a fake GitHub REST API and a fake Google Drive API — all in-memory.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';

// Swap extension/config.js for a configured fixture (OAuth + Google client IDs set).
register('./helpers/config-hook.mjs', import.meta.url);

// ------------------------------------------------------------- fake chrome --
const storage = { local: {}, session: {} };
const listeners = { onMessage: [], onAlarm: [] };
const alarms = new Map();
const badge = {};
const tabs = new Map([[1, { id: 1, url: 'https://colab.research.google.com/drive/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing', title: 'My Analysis.ipynb - Colab' }]]);

const area = (name) => ({
  async get(keys) {
    const src = storage[name];
    if (keys == null) return { ...src };
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in src) out[k] = structuredClone(src[k]);
    return out;
  },
  async set(obj) {
    Object.assign(storage[name], structuredClone(obj));
  },
  async remove(k) {
    for (const key of [].concat(k)) delete storage[name][key];
  },
  async clear() {
    storage[name] = {};
  },
});

let googleInteractiveCalls = 0;
globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
    getManifest: () => ({ oauth2: undefined }),
    id: 'test-ext-id',
    lastError: null,
  },
  storage: { local: area('local'), session: area('session'), onChanged: { addListener() {} } },
  alarms: {
    async create(name, info) {
      alarms.set(name, info);
    },
    async clear(name) {
      return alarms.delete(name);
    },
    onAlarm: { addListener: (fn) => listeners.onAlarm.push(fn) },
  },
  tabs: {
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} },
    async create(o) {
      createdTabs.push(o.url);
      return { id: 99, ...o };
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error('no tab');
      return tabs.get(id);
    },
    async query({ url } = {}) {
      const all = [...tabs.values()];
      if (!url) return all;
      const re = new RegExp('^' + url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return all.filter((t) => re.test(t.url ?? ''));
    },
    async sendMessage(tabId, msg) {
      tabMessages.push({ tabId, ...msg });
    },
  },
  action: {
    async setBadgeText({ tabId, text }) {
      badge[tabId] = { ...(badge[tabId] ?? {}), text };
    },
    async setBadgeBackgroundColor({ tabId, color }) {
      badge[tabId] = { ...(badge[tabId] ?? {}), color };
    },
    async setTitle({ tabId, title }) {
      badge[tabId] = { ...(badge[tabId] ?? {}), title };
    },
  },
  identity: {
    getRedirectURL: (p) => `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/${p}`,
    launchWebAuthFlow({ url, interactive }, cb) {
      // GitHub authorization-code flow: capture PKCE challenge, redirect back with a code
      if (url.startsWith('https://github.com/login/oauth/authorize')) {
        const u = new URL(url);
        pkce.challenge = u.searchParams.get('code_challenge');
        pkce.method = u.searchParams.get('code_challenge_method');
        pkce.scope = u.searchParams.get('scope');
        const redirect = u.searchParams.get('redirect_uri');
        const state = u.searchParams.get('state');
        cb(`${redirect}?code=auth-code-1&state=${state}`);
        return;
      }
      // Google implicit flow: return a fragment with an access token
      if (url.startsWith('https://accounts.google.com/')) {
        if (interactive) googleInteractiveCalls++;
        const u = new URL(url);
        const state = u.searchParams.get('state');
        const redirect = u.searchParams.get('redirect_uri');
        cb(`${redirect}#access_token=goog-token&expires_in=3600&state=${state}&token_type=Bearer`);
        return;
      }
      cb(undefined);
    },
    removeCachedAuthToken(_o, cb) {
      cb();
    },
  },
};

// ---------------------------------------------------------- fake servers --
const gitBlobSha = (text) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

const drive = {
  files: {
    '1AbCdEfGhIjKlMnOpQrStUv': {
      name: 'My Analysis.ipynb',
      modifiedTime: '2026-09-03T10:00:00Z',
      content: JSON.stringify({
        nbformat: 4,
        nbformat_minor: 0,
        metadata: {},
        cells: [
          { cell_type: 'markdown', metadata: {}, source: ['# Analysis'] },
          { cell_type: 'code', metadata: {}, execution_count: 1, source: ['print(1)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] },
        ],
      }),
    },
  },
};

const deviceFlow = { approved: false, polls: 0 };
const pkce = { challenge: null, method: null, scope: null, exchanged: [] };
const backend = { requests: [], down: false, rejectOrigin: false, secretSet: true };
const BACKEND_URL = 'https://colabhub-auth.test';
const tabMessages = []; // chrome.tabs.sendMessage → content-script toasts
const sha256b64url = (str) => createHash('sha256').update(str).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const createdTabs = [];
const github = {
  viewer: { login: 'subhadip', name: 'Subhadip', avatar_url: 'a', html_url: 'h' },
  orgs: [{ login: 'acme-lab', avatar_url: 'o' }],
  repos: {}, // fullName -> { meta, files: { path -> {content, sha} }, commits: [] }
  requests: [],
};

function ghRepo(owner, name, { isPrivate = true, autoInit = true, description = '' } = {}) {
  const fullName = `${owner}/${name}`;
  const files = {};
  if (autoInit) {
    const readme = `# ${name}\n`;
    files['README.md'] = { content: readme, sha: gitBlobSha(readme) };
  }
  const r = {
    meta: { id: Object.keys(github.repos).length + 1, name, full_name: fullName, owner: { login: owner }, private: isPrivate, default_branch: 'main', html_url: `https://github.com/${fullName}`, description, permissions: { push: true }, pushed_at: '2026-09-01T00:00:00Z' },
    files,
    commits: [],
  };
  github.repos[fullName] = r;
  return r;
}

const jsonRes = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  const auth = init.headers?.Authorization ?? '';

  // ---- Drive
  if (u.hostname === 'www.googleapis.com') {
    if (auth !== 'Bearer goog-token') return jsonRes(401, { error: { message: 'Invalid Credentials' } });
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const f = drive.files[id];
    if (!f) return jsonRes(404, { error: { message: 'File not found' } });
    if (u.searchParams.get('alt') === 'media') {
      drive.reads = (drive.reads ?? 0) + 1;
      return new Response(f.content, { status: 200 });
    }
    return jsonRes(200, { id, name: f.name, mimeType: 'application/vnd.google.colaboratory', modifiedTime: f.modifiedTime, md5Checksum: 'x' });
  }

  // ---- token-exchange backend (backend/worker.js deployed at https://colabhub-auth.test)
  if (u.hostname === 'colabhub-auth.test') {
    backend.requests.push({ method, path: u.pathname, body, origin: init.headers?.Origin ?? null });
    if (backend.down) throw new TypeError('fetch failed');
    if (u.pathname === '/health') return jsonRes(200, { ok: true, service: 'colabhub-auth', origin_allowed: !backend.rejectOrigin, client_id_set: true, secret_set: backend.secretSet });
    if (backend.rejectOrigin) return jsonRes(403, { error: 'forbidden_origin', error_description: 'Origin chrome-extension://x is not allowed' });
    if (u.pathname === '/exchange') {
      if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(body.redirect_uri ?? '')) return jsonRes(400, { error: 'bad_request', error_description: 'redirect_uri must be a chromiumapp.org URL' });
      if (!backend.secretSet) return jsonRes(400, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
      if (body.code !== 'auth-code-1') return jsonRes(400, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
      if (!body.code_verifier || sha256b64url(body.code_verifier) !== pkce.challenge) return jsonRes(400, { error: 'incorrect_client_credentials', error_description: 'PKCE verification failed' });
      return jsonRes(200, { access_token: 'gh-token', scope: 'repo,read:org', token_type: 'bearer' });
    }
    if (u.pathname === '/revoke') return new Response(null, { status: 204 });
    return jsonRes(404, { error: 'not_found' });
  }

  // ---- github.com device flow
  if (u.hostname === 'github.com') {
    if (u.pathname === '/login/device/code') {
      if (body.client_id !== 'test-client-id') return jsonRes(404, {});
      deviceFlow.polls = 0;
      return jsonRes(200, { device_code: 'dev-123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (u.pathname === '/login/oauth/access_token') {
      if (body.code) {
        // authorization-code exchange. Like real GitHub, the client_secret is REQUIRED even with PKCE
        // (a secret-less attempt gets incorrect_client_credentials) — which is why production goes via the backend.
        pkce.exchanged.push(body);
        if (body.client_id !== 'test-client-id') return jsonRes(200, { error: 'incorrect_client_credentials' });
        if (body.client_secret !== 'a'.repeat(40)) return jsonRes(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
        if (body.code !== 'auth-code-1') return jsonRes(200, { error: 'bad_verification_code' });
        if (!body.code_verifier || sha256b64url(body.code_verifier) !== pkce.challenge) return jsonRes(200, { error: 'incorrect_client_credentials', error_description: 'PKCE verification failed' });
        return jsonRes(200, { access_token: 'gh-token', scope: 'repo,read:org', token_type: 'bearer' });
      }
      if (body.device_code !== 'dev-123') return jsonRes(200, { error: 'incorrect_device_code' });
      deviceFlow.polls++;
      if (deviceFlow.approved) return jsonRes(200, { access_token: 'gh-token', scope: 'repo,read:org', token_type: 'bearer' });
      return jsonRes(200, { error: 'authorization_pending' });
    }
  }

  // ---- GitHub
  if (u.hostname === 'api.github.com') {
    github.requests.push({ method, path: u.pathname + u.search, body });
    if (auth !== 'Bearer gh-token') return jsonRes(401, { message: 'Bad credentials' });
    const p = u.pathname;

    if (p === '/user') return jsonRes(200, github.viewer);
    if (p === '/user/orgs') return jsonRes(200, github.orgs);
    if (p === '/gitignore/templates') return jsonRes(200, ['Node', 'Python', 'R']);
    if (p === '/user/repos' && method === 'GET') return jsonRes(200, Object.values(github.repos).map((r) => r.meta));
    if ((p === '/user/repos' || p.startsWith('/orgs/')) && method === 'POST') {
      const owner = p === '/user/repos' ? github.viewer.login : p.split('/')[2];
      if (github.repos[`${owner}/${body.name}`]) return jsonRes(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      const r = ghRepo(owner, body.name, { isPrivate: body.private, autoInit: body.auto_init, description: body.description });
      if (body.auto_init && body.gitignore_template) r.files['.gitignore'] = { content: '__pycache__/\n', sha: gitBlobSha('__pycache__/\n') };
      return jsonRes(201, r.meta);
    }

    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (!m) return jsonRes(404, { message: 'Not Found' });
    const repo = github.repos[`${m[1]}/${m[2]}`];
    if (!repo) return jsonRes(404, { message: 'Not Found' });
    const rest = m[3] ?? '';

    if (!rest) return jsonRes(200, repo.meta);
    if (rest === 'branches') return jsonRes(200, [{ name: 'main', commit: { sha: 'c0' } }, { name: 'dev', commit: { sha: 'c1' } }]);
    if (rest.startsWith('contents/')) {
      const path = decodeURIComponent(rest.slice('contents/'.length));
      const existing = repo.files[path];
      if (method === 'GET') {
        if (!existing) return jsonRes(404, { message: 'Not Found' });
        return jsonRes(200, { sha: existing.sha, size: existing.content.length, content: Buffer.from(existing.content).toString('base64'), html_url: `${repo.meta.html_url}/blob/main/${path}` });
      }
      if (method === 'PUT') {
        if (existing && !body.sha) return jsonRes(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        if (existing && body.sha !== existing.sha) return jsonRes(409, { message: `${path} does not match ${body.sha}` });
        if (!existing && body.sha) return jsonRes(422, { message: 'sha provided for new file' });
        const content = Buffer.from(body.content, 'base64').toString('utf8');
        const sha = gitBlobSha(content);
        repo.files[path] = { content, sha };
        const commitSha = `commit${repo.commits.length + 1}`;
        repo.commits.push({ sha: commitSha, message: body.message, branch: body.branch, path });
        return jsonRes(existing ? 200 : 201, { content: { sha, html_url: `${repo.meta.html_url}/blob/main/${path}` }, commit: { sha: commitSha, html_url: `${repo.meta.html_url}/commit/${commitSha}` } });
      }
      if (method === 'DELETE') {
        if (!existing || existing.sha !== body.sha) return jsonRes(409, { message: 'sha mismatch' });
        delete repo.files[path];
        repo.commits.push({ sha: `commit${repo.commits.length + 1}`, message: body.message, path, deleted: true });
        return jsonRes(200, { commit: { sha: 'd' } });
      }
    }
    return jsonRes(404, { message: 'Not Found' });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
};

// ----------------------------------------------------------------- helpers --
function send(msg, sender = {}) {
  return new Promise((resolve) => {
    const handler = listeners.onMessage[0];
    handler(msg, sender, resolve);
  });
}
async function ok(msg, sender) {
  const r = await send(msg, sender);
  if (!r.ok) throw Object.assign(new Error(r.error.message), r.error);
  return r.result;
}
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUv';

before(async () => {
  await import('../extension/background.js');
  assert.equal(listeners.onMessage.length, 1, 'background registered a message listener');
});

// ------------------------------------------------------------------- tests --
test('getState before anything is connected', async () => {
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.github, null);
  assert.equal(s.tab.fileId, FILE_ID);
  assert.equal(s.tab.title, 'My Analysis.ipynb');
  assert.equal(s.tab.isColab, true);
  assert.equal(s.notebook, null);
  // The fixture build has a Client ID but no token-exchange backend: GitHub cannot issue a token
  // without the app's secret, so the popup must show the publisher setup screen, not a dead button.
  assert.equal(s.capabilities.githubOAuth, false);
  assert.equal(s.capabilities.githubExchange, 'none');
  assert.equal(s.capabilities.githubAuthMethod, 'oauth');
  assert.equal(s.capabilities.google, true);
  assert.match(s.capabilities.redirectUrls.github, /chromiumapp\.org\/github$/);

  // Publisher enters the deployed Worker URL (setup screen or `npm run configure`) → one-click sign-in is on.
  await ok({ type: 'setAppConfig', patch: { TOKEN_EXCHANGE_URL: BACKEND_URL + '/' } });
  const s2 = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s2.capabilities.githubOAuth, true);
  assert.equal(s2.capabilities.githubExchange, 'backend');
});

test('GitHub OAuth (production): Authorize → code → token via the token-exchange backend; GitHub verifies PKCE; no secret in the extension', async () => {
  backend.requests = [];
  pkce.exchanged = [];
  const r = await ok({ type: 'connectGithubOAuth' });
  assert.equal(r.done, true);
  assert.equal(r.viewer.login, 'subhadip');
  assert.equal(pkce.method, 'S256');
  assert.equal(pkce.challenge.length, 43);
  assert.equal(pkce.scope, 'repo read:org');
  assert.equal(pkce.exchanged.length, 0, 'the extension never talks to github.com/login/oauth/access_token itself');
  const ex = backend.requests.filter((q) => q.path === '/exchange');
  assert.equal(ex.length, 1);
  assert.equal(ex[0].body.code, 'auth-code-1');
  assert.equal('client_secret' in ex[0].body, false);
  assert.equal('client_id' in ex[0].body, false, 'the backend knows the app; the extension only sends the code');
  assert.equal(sha256b64url(ex[0].body.code_verifier), pkce.challenge);
  assert.match(ex[0].body.redirect_uri, /chromiumapp\.org\/github$/);
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.github.source, 'oauth');
  assert.equal(s.capabilities.githubExchange, 'backend');

  // Disconnect revokes through the backend (it holds the credentials needed for DELETE /applications/…/token)
  backend.requests = [];
  await ok({ type: 'disconnectGithub' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(backend.requests.map((q) => q.path), ['/revoke']);
  assert.equal(backend.requests[0].body.access_token, 'gh-token');
  assert.equal((await ok({ type: 'getState', tabId: 1 })).github, null);
});

test('GitHub OAuth: backend problems produce actionable errors (unreachable, wrong secrets, origin not allow-listed)', async () => {
  backend.down = true;
  const r1 = await send({ type: 'connectGithubOAuth' });
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /could not reach the token-exchange backend at https:\/\/colabhub-auth\.test/);
  assert.match(r1.error.message, /backend:deploy/);
  backend.down = false;

  backend.secretSet = false;
  const r2 = await send({ type: 'connectGithubOAuth' });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /wrong GITHUB_CLIENT_ID\/GITHUB_CLIENT_SECRET/);
  assert.match(r2.error.message, /wrangler secret put/);
  backend.secretSet = true;

  backend.rejectOrigin = true;
  const r3 = await send({ type: 'connectGithubOAuth' });
  assert.equal(r3.ok, false);
  assert.match(r3.error.message, /ALLOWED_EXTENSION_IDS/);
  backend.rejectOrigin = false;

  // the setup screen's "Test" button
  const h1 = await ok({ type: 'checkTokenExchange', url: BACKEND_URL + '/' });
  assert.equal(h1.ok, true);
  assert.match(h1.message, /configured/);
  backend.secretSet = false;
  const h2 = await ok({ type: 'checkTokenExchange', url: BACKEND_URL });
  assert.equal(h2.ok, false);
  assert.match(h2.message, /wrangler secret put/);
  backend.secretSet = true;
  backend.down = true;
  const h3 = await ok({ type: 'checkTokenExchange', url: BACKEND_URL });
  assert.equal(h3.ok, false);
  assert.equal(h3.reachable, false);
  backend.down = false;
  const h4 = await ok({ type: 'checkTokenExchange', url: 'not a url' });
  assert.equal(h4.ok, false);
});

test('GitHub OAuth (dev build): Client ID alone cannot finish sign-in; a pasted client secret enables the direct exchange (never distributed)', async () => {
  await ok({ type: 'setAppConfig', patch: { TOKEN_EXCHANGE_URL: '' } }); // back to "Client ID only"
  let s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.capabilities.githubOAuth, false);

  // If sign-in is attempted anyway, GitHub refuses the secret-less PKCE exchange → error says exactly what to do
  pkce.exchanged = [];
  const r1 = await send({ type: 'connectGithubOAuth' });
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /client_id and\/or client_secret passed are incorrect/);
  assert.match(r1.error.message, /requires the OAuth App's client secret/);
  assert.match(r1.error.message, /backend\/worker\.js/);
  assert.equal(pkce.exchanged.length, 1);
  assert.equal('client_secret' in pkce.exchanged[0], false);

  // Personal build: paste the secret on the setup screen → direct exchange, PKCE still verified by GitHub
  await ok({ type: 'setAppConfig', patch: { GITHUB_CLIENT_SECRET: 'a'.repeat(40) } });
  const desc = await ok({ type: 'getAppConfig' });
  assert.equal(desc.githubClientSecretSet, true);
  assert.equal(desc.githubExchange, 'secret');
  assert.equal('GITHUB_CLIENT_SECRET' in desc.overrides, false, 'secret value never returned to the UI');
  s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.capabilities.githubOAuth, true);
  pkce.exchanged = [];
  const r2 = await ok({ type: 'connectGithubOAuth' });
  assert.equal(r2.done, true);
  assert.equal(pkce.exchanged.length, 1);
  assert.equal(pkce.exchanged[0].client_secret, 'a'.repeat(40));
  assert.equal(sha256b64url(pkce.exchanged[0].code_verifier), pkce.challenge);
  backend.requests = [];
  await ok({ type: 'disconnectGithub' });
  assert.equal(backend.requests.length, 0, 'no backend configured → nothing to call');

  // wrong secret → specific hint
  await ok({ type: 'setAppConfig', patch: { GITHUB_CLIENT_SECRET: 'b'.repeat(40) } });
  const r3 = await send({ type: 'connectGithubOAuth' });
  assert.equal(r3.ok, false);
  assert.match(r3.error.message, /saved client secret does not match/);

  // Backend configured AND a secret present (developer machine): backend wins; secret is only a fallback when it is unreachable
  await ok({ type: 'setAppConfig', patch: { GITHUB_CLIENT_SECRET: 'a'.repeat(40), TOKEN_EXCHANGE_URL: BACKEND_URL } });
  backend.requests = []; pkce.exchanged = [];
  await ok({ type: 'connectGithubOAuth' });
  assert.equal(backend.requests.filter((q) => q.path === '/exchange').length, 1);
  assert.equal(pkce.exchanged.length, 0);
  await ok({ type: 'disconnectGithub' });
  backend.down = true; backend.requests = []; pkce.exchanged = [];
  await ok({ type: 'connectGithubOAuth' });
  assert.equal(pkce.exchanged.length, 1, 'fell back to the direct exchange with the dev secret');
  backend.down = false;
  await ok({ type: 'disconnectGithub' });

  await ok({ type: 'setAppConfig', patch: { GITHUB_CLIENT_SECRET: '' } });
});

test('GitHub Device Flow: returns a user code and polling connects once approved', async () => {
  await ok({ type: 'setAppConfig', patch: { GITHUB_AUTH_METHOD: 'device' } });
  assert.equal((await ok({ type: 'getState', tabId: 1 })).capabilities.githubAuthMethod, 'device');
  const start = await ok({ type: 'connectGithubOAuth' });
  assert.equal(start.done, false);
  assert.equal(start.userCode, 'ABCD-1234');
  assert.equal(start.verificationUri, 'https://github.com/login/device');
  assert.deepEqual(createdTabs, [], 'popup keeps the code visible before the user opens GitHub');

  // too early → worker respects the interval without hitting GitHub
  const early = await ok({ type: 'deviceFlowPoll' });
  assert.equal(early.status, 'pending');
  assert.equal(deviceFlow.polls, 0);

  // user approves on github.com; advance the clock past GitHub's minimum polling interval
  deviceFlow.approved = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 6000;
  try {
    const done = await ok({ type: 'deviceFlowPoll' });
    assert.equal(done.status, 'ok');
    assert.equal(done.viewer.login, 'subhadip');
    assert.equal(deviceFlow.polls, 1);
  } finally {
    Date.now = realNow;
  }
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.github.source, 'oauth');
  assert.equal(s.github.viewer.login, 'subhadip');

  // cancel + poll after cancel → expired
  await ok({ type: 'connectGithubOAuth' });
  await ok({ type: 'deviceFlowCancel' });
  assert.equal((await ok({ type: 'deviceFlowPoll' })).status, 'expired');

  await ok({ type: 'disconnectGithub' });
  await ok({ type: 'setAppConfig', patch: { GITHUB_AUTH_METHOD: '' } }); // clear the runtime override
});

test('runtime app config overrides the build config and flips capabilities', async () => {
  const before = await ok({ type: 'getAppConfig' });
  assert.equal(before.githubClientId, 'test-client-id'); // from fixture build config
  assert.equal(before.fromBuild.github, true);

  await ok({ type: 'setAppConfig', patch: { GOOGLE_CLIENT_ID: '999-zzz.apps.googleusercontent.com' } });
  const after = await ok({ type: 'getAppConfig' });
  assert.equal(after.googleClientId, '999-zzz.apps.googleusercontent.com');
  assert.deepEqual(Object.keys(after.overrides).sort(), ['GOOGLE_CLIENT_ID', 'TOKEN_EXCHANGE_URL']);

  // clearing an override falls back to the build value
  await ok({ type: 'setAppConfig', patch: { GOOGLE_CLIENT_ID: '' } });
  assert.equal((await ok({ type: 'getAppConfig' })).googleClientId, 'test-google-client-id');
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.capabilities.google, true);
  assert.equal(s.capabilities.extensionId, 'test-ext-id');
});

test('connect GitHub with a PAT: rejects bad tokens, stores viewer for good ones', async () => {
  const bad = await send({ type: 'connectGithubPat', token: 'nope' });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /rejected that token/);

  const r = await ok({ type: 'connectGithubPat', token: 'gh-token' });
  assert.equal(r.viewer.login, 'subhadip');
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.github.viewer.login, 'subhadip');
  assert.equal(s.github.source, 'pat');
});

test('listOwners puts the user first, then orgs', async () => {
  const owners = await ok({ type: 'listOwners' });
  assert.deepEqual(owners.map((o) => o.login), ['subhadip', 'acme-lab']);
  assert.equal(owners[0].type, 'user');
});

test('createRepoAndConnect: creates private repo with README + .gitignore, links notebook, first sync commits it', async () => {
  const res = await ok({
    type: 'createRepoAndConnect',
    fileId: FILE_ID,
    title: 'My Analysis.ipynb',
    owner: 'subhadip',
    name: 'ML-Projects',
    description: 'My Google Colab projects',
    isPrivate: true,
    addReadme: true,
    gitignoreTemplate: 'Python',
    path: 'notebooks/My_Analysis.ipynb',
    autoSync: true,
    stripOutputs: false,
  });

  const createReq = github.requests.find((r) => r.method === 'POST' && r.path === '/user/repos');
  assert.deepEqual(createReq.body, { name: 'ML-Projects', description: 'My Google Colab projects', private: true, auto_init: true, has_wiki: false, gitignore_template: 'Python' });

  const repo = github.repos['subhadip/ML-Projects'];
  assert.ok(repo.files['README.md']);
  assert.ok(repo.files['.gitignore']);
  assert.ok(repo.files['notebooks/My_Analysis.ipynb'], 'notebook was committed on first sync');
  assert.equal(repo.commits.at(-1).message, 'Add My Analysis.ipynb via ColabHub');
  assert.equal(repo.commits.at(-1).branch, 'main');

  assert.equal(res.sync.action, 'pushed');
  assert.equal(res.sync.kind, 'create');
  assert.equal(res.notebook.status.state, 'synced');
  assert.equal(res.notebook.lastSyncedRemoteSha, repo.files['notebooks/My_Analysis.ipynb'].sha);
  assert.equal(res.notebook.repoPrivate, true);
  assert.equal(googleInteractiveCalls, 1, 'Drive consent prompted once (interactive first sync)');

  // committed content is the canonical 1-space-indented serialisation
  const committed = repo.files['notebooks/My_Analysis.ipynb'].content;
  assert.ok(committed.startsWith('{\n "nbformat": 4'));
  assert.ok(committed.endsWith('\n'));
});

test('syncNow with no changes is a no-op (no extra commit, no GitHub write)', async () => {
  const before = github.requests.length;
  const r = await ok({ type: 'syncNow', fileId: FILE_ID });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'unchanged');
  assert.equal(github.repos['subhadip/ML-Projects'].commits.length, 1, 'still only the initial notebook commit');
  assert.ok(!github.requests.slice(before).some((x) => x.method === 'PUT'), 'no PUT issued');
});

test('editing the notebook in Colab → syncNow produces an update commit with the previous sha', async () => {
  const f = drive.files[FILE_ID];
  const nb = JSON.parse(f.content);
  nb.cells.push({ cell_type: 'code', metadata: {}, execution_count: 2, source: ['print(2)'], outputs: [] });
  f.content = JSON.stringify(nb);
  f.modifiedTime = '2026-09-03T10:05:00Z';

  const prevSha = github.repos['subhadip/ML-Projects'].files['notebooks/My_Analysis.ipynb'].sha;
  const r = await ok({ type: 'syncNow', fileId: FILE_ID, message: 'Add second cell' });
  assert.equal(r.action, 'pushed');
  assert.equal(r.kind, 'update');
  const put = github.requests.filter((x) => x.method === 'PUT').at(-1);
  assert.equal(put.body.sha, prevSha, 'update carried the expected sha');
  assert.equal(put.body.message, 'Add second cell');
  const s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook.status.state, 'synced');
  assert.equal(s.notebook.lastSeenDriveModifiedTime, '2026-09-03T10:05:00Z');
});

test('someone else changes the file on GitHub → conflict, not silent overwrite; force overwrites', async () => {
  const repo = github.repos['subhadip/ML-Projects'];
  const foreign = '{"cells": [], "nbformat": 4, "edited": "on github"}\n';
  repo.files['notebooks/My_Analysis.ipynb'] = { content: foreign, sha: gitBlobSha(foreign) };

  // make local differ too, otherwise "unchanged" short-circuits
  const f = drive.files[FILE_ID];
  const nb = JSON.parse(f.content);
  nb.cells[0].source = ['# Analysis v2'];
  f.content = JSON.stringify(nb);
  f.modifiedTime = '2026-09-03T10:10:00Z';

  const r = await ok({ type: 'syncNow', fileId: FILE_ID });
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'remote_changed');
  assert.equal(repo.files['notebooks/My_Analysis.ipynb'].content, foreign, 'remote untouched');
  let s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook.status.state, 'conflict');

  const forced = await ok({ type: 'syncNow', fileId: FILE_ID, force: true });
  assert.equal(forced.action, 'pushed');
  assert.ok(repo.files['notebooks/My_Analysis.ipynb'].content.includes('Analysis v2'));
  s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook.status.state, 'synced');
});

test('secrets in the notebook block the commit until allowSecrets; strip outputs clears output-only secrets', async () => {
  const repo = github.repos['subhadip/ML-Projects'];
  const f = drive.files[FILE_ID];
  const nb = JSON.parse(f.content);
  nb.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: ['token: ghp_' + 'z'.repeat(36) + '\n'] }];
  f.content = JSON.stringify(nb);
  f.modifiedTime = '2026-09-03T10:15:00Z';
  const commitsBefore = repo.commits.length;

  const r = await ok({ type: 'syncNow', fileId: FILE_ID });
  assert.equal(r.action, 'blocked_secrets');
  assert.equal(r.findings[0].kind, 'GitHub token');
  assert.equal(r.findings[0].where, 'output');
  assert.equal(repo.commits.length, commitsBefore, 'nothing committed');
  let s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook.status.state, 'secrets');

  // turning on strip-outputs removes the offending output → sync succeeds
  await ok({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { stripOutputs: true } });
  const r2 = await ok({ type: 'syncNow', fileId: FILE_ID });
  assert.equal(r2.action, 'pushed');
  assert.ok(!repo.files['notebooks/My_Analysis.ipynb'].content.includes('ghp_'));
  assert.ok(repo.files['notebooks/My_Analysis.ipynb'].content.includes('"outputs": []'));

  // and with outputs kept, "commit anyway" pushes despite findings
  await ok({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { stripOutputs: false } });
  const r3 = await ok({ type: 'syncNow', fileId: FILE_ID, allowSecrets: true });
  assert.equal(r3.action, 'pushed');
  assert.equal(r3.secretsOverridden, true);
  s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook.status.state, 'synced');
});

test('creating a repo whose name exists surfaces GitHub\'s validation message', async () => {
  const r = await send({ type: 'createRepoAndConnect', fileId: FILE_ID, title: 'x', owner: 'subhadip', name: 'ML-Projects', isPrivate: true });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /already exists/);
  assert.equal(r.error.code, 'validation');
});

test('invalid repo names are rejected before hitting GitHub', async () => {
  const before = github.requests.length;
  const r = await send({ type: 'createRepoAndConnect', fileId: FILE_ID, title: 'x', owner: 'subhadip', name: 'has spaces!' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /Only letters/);
  assert.equal(github.requests.length, before);
});

test('org repo, public, README off + .gitignore on → auto_init then README removed', async () => {
  const otherFile = '1ZyXwVuTsRqPoNmLkJiHgF';
  drive.files[otherFile] = { name: 'Team Notebook.ipynb', modifiedTime: '2026-09-03T11:00:00Z', content: JSON.stringify({ nbformat: 4, metadata: {}, cells: [] }) };
  tabs.set(2, { id: 2, url: `https://colab.research.google.com/drive/${otherFile}`, title: 'Team Notebook.ipynb - Colab' });

  const res = await ok({
    type: 'createRepoAndConnect',
    fileId: otherFile,
    title: 'Team Notebook.ipynb',
    owner: 'acme-lab',
    name: 'team-notebooks',
    isPrivate: false,
    addReadme: false,
    gitignoreTemplate: 'Python',
  });
  const createReq = github.requests.find((r) => r.method === 'POST' && r.path === '/orgs/acme-lab/repos');
  assert.ok(createReq, 'posted to the org endpoint');
  assert.equal(createReq.body.private, false);
  assert.equal(createReq.body.auto_init, true);
  const repo = github.repos['acme-lab/team-notebooks'];
  assert.ok(!repo.files['README.md'], 'auto-generated README removed');
  assert.ok(repo.files['.gitignore']);
  assert.ok(repo.files['notebooks/Team_Notebook.ipynb'], 'default path uses settings.defaultFolder + sanitised title');
  assert.equal(res.notebook.repoPrivate, false);
});

test('connectExistingRepo links to a chosen branch/path and syncs', async () => {
  const thirdFile = '1QqWwEeRrTtYyUuIiOoPp';
  drive.files[thirdFile] = { name: 'Scratch.ipynb', modifiedTime: '2026-09-03T12:00:00Z', content: JSON.stringify({ nbformat: 4, metadata: {}, cells: [] }) };
  const res = await ok({ type: 'connectExistingRepo', fileId: thirdFile, title: 'Scratch.ipynb', owner: 'subhadip', repo: 'ML-Projects', branch: 'dev', path: 'experiments/scratch.ipynb', autoSync: false });
  assert.equal(res.sync.action, 'pushed');
  assert.equal(res.notebook.branch, 'dev');
  const put = github.requests.filter((x) => x.method === 'PUT').at(-1);
  assert.equal(put.body.branch, 'dev');
  assert.match(put.path, /contents\/experiments\/scratch\.ipynb$/);
});

test('notebookSaved from the content script schedules a debounced alarm only for auto-sync notebooks', async () => {
  const sender = { tab: { url: `https://colab.research.google.com/drive/${FILE_ID}` } };
  const r = await ok({ type: 'notebookSaved' }, sender);
  assert.equal(r, true);
  assert.ok(alarms.has(`colabsync:save:${FILE_ID}`));
  assert.equal(alarms.get(`colabsync:save:${FILE_ID}`).delayInMinutes, 0.5);

  const r2 = await ok({ type: 'notebookSaved' }, { tab: { url: 'https://colab.research.google.com/drive/1QqWwEeRrTtYyUuIiOoPp' } });
  assert.equal(r2, false, 'autoSync=false notebook is ignored');
});

test('interval auto-sync skips unchanged notebooks and syncs changed ones without prompting Google', async () => {
  const repo = github.repos['subhadip/ML-Projects'];
  const commitsBefore = repo.commits.length;
  const interactiveBefore = googleInteractiveCalls;

  // unchanged → no commit
  await listeners.onAlarm[0]({ name: 'colabsync:autosync' });
  assert.equal(repo.commits.length, commitsBefore);

  // change it → commit
  const f = drive.files[FILE_ID];
  const nb = JSON.parse(f.content);
  nb.cells[1].outputs = [];
  nb.cells.push({ cell_type: 'markdown', metadata: {}, source: ['auto'] });
  f.content = JSON.stringify(nb);
  f.modifiedTime = '2026-09-03T13:00:00Z';
  await listeners.onAlarm[0]({ name: 'colabsync:autosync' });
  assert.equal(repo.commits.length, commitsBefore + 1);
  assert.equal(repo.commits.at(-1).message, 'Update My Analysis.ipynb (auto sync) via ColabHub');
  assert.equal(googleInteractiveCalls, interactiveBefore, 'background sync never opens a Google prompt');
});

test('Auto-Push after cell run: debounced, commits at the chosen granularity, status reads "Pushed … after cell run"', async () => {
  const repo = github.repos['subhadip/ML-Projects'];
  const sender = { tab: { id: 1, url: `https://colab.research.google.com/drive/${FILE_ID}` } };

  // the production default enables Auto-Push for newly linked notebooks
  assert.equal((await ok({ type: 'getState', tabId: 1 })).notebook.autoPushOnCell, true);

  // switch to .py granularity → path extension follows, next sync re-evaluates
  let nb = await ok({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { autoPushOnCell: true, granularity: 'py' } });
  assert.equal(nb.path, 'notebooks/My_Analysis.py');
  assert.equal(nb.autoPushOnCell, true);

  const before = repo.commits.length;
  const r = await ok({ type: 'cellExecuted' }, sender);
  assert.equal(r.scheduled, true);
  assert.equal(r.granularity, 'py');
  assert.equal((await ok({ type: 'getState', tabId: 1 })).notebook.status.state, 'pending');
  // two quick runs coalesce into one push
  await ok({ type: 'cellExecuted' }, sender);
  assert.ok(alarms.has(`colabsync:cell:${FILE_ID}`), 'SW-suspension fallback alarm armed');

  // fire the fallback alarm instead of waiting 8 s for the timer
  await listeners.onAlarm[0]({ name: `colabsync:cell:${FILE_ID}` });
  assert.equal(repo.commits.length, before + 1);
  const commit = repo.commits.at(-1);
  assert.equal(commit.message, 'Add My Analysis.ipynb (script) after cell run via ColabHub'); // new path → create
  assert.equal(commit.path, 'notebooks/My_Analysis.py');
  const script = repo.files['notebooks/My_Analysis.py'].content; // fake stores decoded text
  assert.match(script, /^# %%/m);
  assert.match(script, /print\(/);
  assert.doesNotMatch(script, /"cell_type"/, 'script mode does not commit notebook JSON');
  assert.equal(alarms.has(`colabsync:cell:${FILE_ID}`), false, 'fallback alarm cleared after push');

  const st = (await ok({ type: 'getState', tabId: 1 })).notebook.status;
  assert.equal(st.state, 'synced');
  assert.equal(st.message, 'Added .py to main after cell run');
  assert.equal(st.trigger, 'cell');
  assert.match(badge[1].title, /ColabHub — Added \.py to main after cell run/);

  // background pushes the status to the Colab tab (content script renders the toast)
  await new Promise((r) => setTimeout(r, 0));
  const pushed = tabMessages.filter((m) => m.type === 'syncStatus').at(-1);
  assert.equal(pushed.tabId, 1);
  assert.equal(pushed.status.message, 'Added .py to main after cell run');
  assert.match(pushed.meta.commitUrl, /commit/);

  // content script status poll (drives the in-page toast)
  const poll = await ok({ type: 'getStatus' }, sender);
  assert.equal(poll.connected, true);
  assert.equal(poll.status.message, 'Added .py to main after cell run');
  assert.equal(poll.branch, 'main');

  // second run, but Colab hasn't autosaved to Drive yet → wait (alarm re-armed), don't download
  const driveReadsBefore = drive.reads;
  await ok({ type: 'cellExecuted' }, sender);
  await listeners.onAlarm[0]({ name: `colabsync:cell:${FILE_ID}` });
  assert.equal(repo.commits.length, before + 1);
  let st2 = (await ok({ type: 'getState', tabId: 1 })).notebook;
  assert.equal(st2.status.state, 'pending');
  assert.match(st2.status.message, /waiting for Colab to save/);
  assert.equal(st2.cellWait.attempts, 1);
  assert.ok(alarms.has(`colabsync:cell:${FILE_ID}`), 're-armed to check Drive again');
  assert.equal(drive.reads, driveReadsBefore, 'notebook not downloaded while Drive is unchanged');

  // Colab autosaves (outputs only) → retry fires → script unchanged → user told why, no commit
  {
    const f = drive.files[FILE_ID];
    const nb = JSON.parse(f.content);
    nb.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: ['hi again\n'] }];
    f.content = JSON.stringify(nb);
    f.modifiedTime = '2026-09-03T14:00:00Z';
  }
  await listeners.onAlarm[0]({ name: `colabsync:cell:${FILE_ID}` });
  assert.equal(repo.commits.length, before + 1);
  st2 = (await ok({ type: 'getState', tabId: 1 })).notebook;
  assert.equal(st2.status.state, 'synced');
  assert.equal(st2.status.pushed, false);
  assert.equal(st2.status.message, 'Cell ran — nothing new to push (script unchanged)');
  assert.equal(st2.cellWait, null);
  assert.equal(alarms.has(`colabsync:cell:${FILE_ID}`), false);

  // outputs granularity → .outputs.json with a log, without source (granularity change resets the
  // content baseline, so the next cell push downloads even though Drive is unchanged)
  nb = await ok({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { granularity: 'outputs' } });
  assert.equal(nb.path, 'notebooks/My_Analysis.outputs.json');
  await ok({ type: 'cellExecuted' }, sender);
  await listeners.onAlarm[0]({ name: `colabsync:cell:${FILE_ID}` });
  const outDoc = JSON.parse(repo.files['notebooks/My_Analysis.outputs.json'].content);
  assert.equal(outDoc.format, 'colabhub-outputs/1');
  assert.ok(Array.isArray(outDoc.log));
  assert.equal(repo.commits.at(-1).message, 'Add My Analysis.ipynb (outputs) after cell run via ColabHub');
  assert.equal((await ok({ type: 'getState', tabId: 1 })).notebook.status.message, 'Added outputs to main after cell run');

  // unknown granularity rejected; back to ipynb restores the extension
  const bad = await send({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { granularity: 'docx' } });
  assert.equal(bad.ok, false);
  nb = await ok({ type: 'updateNotebookConfig', fileId: FILE_ID, patch: { granularity: 'ipynb', autoPushOnCell: false } });
  assert.equal(nb.path, 'notebooks/My_Analysis.ipynb');
});

test('settings round-trip and alarm rescheduling', async () => {
  const s = await ok({ type: 'setSettings', patch: { autoSyncMinutes: 2, defaultFolder: 'nb' } });
  assert.equal(s.autoSyncMinutes, 2);
  assert.equal(alarms.get('colabsync:autosync').periodInMinutes, 2);
});

test('disconnectNotebook + disconnectGithub clean up', async () => {
  await ok({ type: 'disconnectNotebook', fileId: FILE_ID });
  let s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.notebook, null);
  await ok({ type: 'disconnectGithub' });
  s = await ok({ type: 'getState', tabId: 1 });
  assert.equal(s.github, null);
  const r = await send({ type: 'syncNow', fileId: '1QqWwEeRrTtYyUuIiOoPp' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_github');
});
