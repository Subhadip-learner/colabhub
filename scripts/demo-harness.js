/* demo-harness.js — simulated Chrome runtime + GitHub API + Google Drive for the ColabHub demo page.
   Everything here is fake; the extension code that runs on top of it is the real thing. */
(() => {
  const CLOCK = 60; // demo minutes run 60× faster (1 min → 1 s)
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ toast --
  function colabToast(text) {
    const frame = $('page')?.parentElement; // .browser — survives renderPage()'s innerHTML resets
    if (!frame) return;
    let el = frame.querySelector('.colab-toast');
    if (!el) { el = document.createElement('div'); el.className = 'colab-toast'; frame.appendChild(el); }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 5000);
  }
  const toast = (html, ms = 3500) => {
    let t = $('demo-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'demo-toast';
      document.body.appendChild(t);
    }
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
  };
  // native dialogs are blocked inside sandboxed previews → auto-accept and explain
  window.confirm = (m) => (toast(`<b>confirm()</b> auto-accepted in demo: <i>${esc(m)}</i>`), true);
  window.prompt = (m, d) => (toast(`<b>prompt()</b> used default in demo: <i>${esc(d ?? '')}</i>`), d ?? '');
  window.alert = (m) => toast(`<b>alert:</b> ${esc(m)}`);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const sha1 = async (text) => {
    const enc = new TextEncoder();
    const body = enc.encode(text);
    const header = enc.encode(`blob ${body.byteLength}\0`);
    const buf = new Uint8Array(header.length + body.length);
    buf.set(header);
    buf.set(body, header.length);
    const d = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // ------------------------------------------------------------ fake Drive --
  const nbA = () => ({
    nbformat: 4,
    nbformat_minor: 0,
    metadata: { colab: { name: 'Customer Churn Analysis.ipynb' }, kernelspec: { name: 'python3', display_name: 'Python 3' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Customer churn analysis\n', 'Exploring the telco dataset.'] },
      { cell_type: 'code', metadata: {}, execution_count: 1, source: ['import pandas as pd\n', 'df = pd.read_csv("churn.csv")\n', 'df.shape'], outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['(7043, 21)'] }, execution_count: 1, metadata: {} }] },
      { cell_type: 'code', metadata: {}, execution_count: 2, source: ['df["Churn"].value_counts(normalize=True)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['No     0.7346\n', 'Yes    0.2654\n'] }] },
    ],
  });
  const nbB = () => ({ nbformat: 4, nbformat_minor: 0, metadata: {}, cells: [{ cell_type: 'code', metadata: {}, execution_count: null, source: ['print("hello colab")'], outputs: [] }] });

  const drive = {
    '1kX9pQzR3tLmN8vB2cD4eF6gH7jK1mP0o': { name: 'Customer Churn Analysis.ipynb', modifiedTime: '2026-09-03T09:00:00Z', content: JSON.stringify(nbA(), null, 1) + '\n' },
    '1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV': { name: 'Untitled3.ipynb', modifiedTime: '2026-09-03T09:30:00Z', content: JSON.stringify(nbB(), null, 1) + '\n' },
  };
  let googleAuthorized = false;
  const deviceDemo = { approved: false };
  const pkceDemo = { challenge: null };
  let runCount = 0;
  let demoNow = Date.parse('2026-09-03T09:35:00Z');
  const nowIso = () => new Date((demoNow += 60_000)).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // ----------------------------------------------------------- fake GitHub --
  const gh = {
    viewer: { login: 'subhadip-medya', name: 'Subhadip Medya', avatar_url: '', html_url: 'https://github.com/subhadip-medya' },
    orgs: [{ login: 'durgapur-ml-lab', avatar_url: '' }],
    repos: {},
    log: [],
  };
  async function mkRepo(owner, name, { isPrivate = true, autoInit = true, description = '', gitignore = null } = {}) {
    const fullName = `${owner}/${name}`;
    const files = {};
    if (autoInit) {
      const readme = `# ${name}\n\n${description}\n`;
      files['README.md'] = { content: readme, sha: await sha1(readme) };
      if (gitignore) {
        const gi = `# ${gitignore}\n__pycache__/\n*.py[cod]\n.env\n`;
        files['.gitignore'] = { content: gi, sha: await sha1(gi) };
      }
    }
    const r = {
      meta: { id: Object.keys(gh.repos).length + 100, name, full_name: fullName, owner: { login: owner }, private: isPrivate, default_branch: 'main', html_url: `https://github.com/${fullName}`, description, permissions: { push: true, admin: true }, pushed_at: nowIso(), archived: false },
      files,
      commits: autoInit ? [{ sha: 'a1b2c3d', message: 'Initial commit', when: nowIso() }] : [],
    };
    gh.repos[fullName] = r;
    return r;
  }
  // a couple of pre-existing repos so "Connect Existing" has something to show
  (async () => {
    await mkRepo('subhadip-medya', 'dotfiles', { isPrivate: false, description: 'my dotfiles' });
    await mkRepo('subhadip-medya', 'colab-notebooks', { isPrivate: true, description: 'Assorted experiments', gitignore: 'Python' });
    await mkRepo('durgapur-ml-lab', 'research-2026', { isPrivate: true, description: 'Lab notebooks' });
    renderGithub();
  })();

  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const commitId = () => Math.random().toString(16).slice(2, 9);

  window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers?.Authorization ?? '';
    const res = await route(u, method, body, auth);
    logApi(method, u, res.status);
    return res;
  };

  async function route(u, method, body, auth) {
    // GitHub Device Flow (github.com, not api.github.com)
    if (u.hostname === 'github.com' && u.pathname === '/login/device/code') {
      if (!body?.client_id) return json(404, { error: 'not_found' });
      deviceDemo.approved = false;
      return json(200, { device_code: 'demo-device', user_code: 'C0LA-B5YN', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
    }
    // github.com token endpoint — like the real one, it refuses to issue a token without the app's
    // client secret (which only the backend has). Also used for device-flow polling.
    const exchangeCode = async (b) => {
      if (b.code !== 'demo-code') return json(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
      if (!b.code_verifier || !pkceDemo.challenge) return json(200, { error: 'incorrect_client_credentials', error_description: 'PKCE verifier missing' });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.code_verifier));
      const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (b64 !== pkceDemo.challenge) return json(200, { error: 'incorrect_client_credentials', error_description: 'PKCE verification failed' });
      return json(200, { access_token: 'gh-token', scope: 'repo,read:org', token_type: 'bearer' });
    };
    if (u.hostname === 'github.com' && u.pathname === '/login/oauth/access_token') {
      if (body?.code) {
        if (!body.client_secret) return json(200, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' });
        return exchangeCode(body);
      }
      return deviceDemo.approved
        ? json(200, { access_token: 'gh-token', scope: 'repo,read:org', token_type: 'bearer' })
        : json(200, { error: 'authorization_pending' });
    }
    // the publisher's deployed backend/worker.js (adds the client secret server-side)
    if (u.hostname === 'colabhub-auth.demo.workers.dev') {
      if (u.pathname === '/health') return json(200, { ok: true, service: 'colabhub-auth', origin_allowed: true, client_id_set: true, secret_set: true });
      if (u.pathname === '/exchange') {
        if (!/^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(body?.redirect_uri ?? '')) return json(400, { error: 'bad_request', error_description: 'redirect_uri must be a chromiumapp.org URL' });
        const r = await exchangeCode({ ...body, client_secret: 'server-side' });
        return r.status === 200 && (await r.clone().json()).access_token ? r : json(400, await r.json());
      }
      if (u.pathname === '/revoke') return new Response(null, { status: 204 });
      return json(404, { error: 'not_found' });
    }
    // Drive
    if (u.hostname === 'www.googleapis.com') {
      if (auth !== 'Bearer goog-token') return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
      const id = decodeURIComponent(u.pathname.split('/').pop());
      const f = drive[id];
      if (!f) return json(404, { error: { message: 'File not found' } });
      if (u.searchParams.get('alt') === 'media') return new Response(f.content, { status: 200 });
      return json(200, { id, name: f.name, mimeType: 'application/vnd.google.colaboratory', modifiedTime: f.modifiedTime, md5Checksum: 'demo' });
    }
    // GitHub
    if (u.hostname === 'api.github.com') {
      const tokenOk = auth === 'Bearer gh-token' || /^Bearer (ghp_|github_pat_)\w+/.test(auth);
      if (!tokenOk) return json(401, { message: 'Bad credentials' });
      const p = u.pathname;
      if (p === '/user') return json(200, gh.viewer);
      if (p === '/user/orgs') return json(200, gh.orgs);
      if (p === '/gitignore/templates') return json(200, ['C++', 'Go', 'Java', 'Jupyter', 'Node', 'Python', 'R', 'Rust', 'TeX']);
      if (p === '/user/repos' && method === 'GET') return json(200, Object.values(gh.repos).map((r) => r.meta));
      if ((p === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(p)) && method === 'POST') {
        const owner = p === '/user/repos' ? gh.viewer.login : p.split('/')[2];
        if (gh.repos[`${owner}/${body.name}`]) return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        const r = await mkRepo(owner, body.name, { isPrivate: body.private, autoInit: body.auto_init, description: body.description, gitignore: body.gitignore_template });
        renderGithub();
        return json(201, r.meta);
      }
      const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
      if (!m) return json(404, { message: 'Not Found' });
      const repo = gh.repos[`${m[1]}/${m[2]}`];
      if (!repo) return json(404, { message: 'Not Found' });
      const rest = m[3] ?? '';
      if (!rest) return json(200, repo.meta);
      if (rest === 'branches') return json(200, repo.commits.length ? [{ name: 'main', commit: { sha: 'c0' } }, ...(repo.meta.name === 'colab-notebooks' ? [{ name: 'experiments', commit: { sha: 'c1' } }] : [])] : []);
      if (rest.startsWith('contents/')) {
        const path = decodeURIComponent(rest.slice(9));
        const existing = repo.files[path];
        if (method === 'GET') {
          if (!existing) return json(404, { message: 'Not Found' });
          return json(200, { sha: existing.sha, size: existing.content.length, content: btoa(unescape(encodeURIComponent(existing.content))), html_url: `${repo.meta.html_url}/blob/main/${path}` });
        }
        if (method === 'PUT') {
          if (existing && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
          if (existing && body.sha !== existing.sha) return json(409, { message: `${path} does not match ${body.sha}` });
          const content = decodeURIComponent(escape(atob(body.content)));
          const sha = await sha1(content);
          repo.files[path] = { content, sha };
          const c = { sha: commitId(), message: body.message, when: nowIso(), path };
          repo.commits.unshift(c);
          repo.meta.pushed_at = c.when;
          renderGithub();
          return json(existing ? 200 : 201, { content: { sha, html_url: `${repo.meta.html_url}/blob/${body.branch}/${path}` }, commit: { sha: c.sha, html_url: `${repo.meta.html_url}/commit/${c.sha}` } });
        }
        if (method === 'DELETE') {
          if (!existing || existing.sha !== body.sha) return json(409, { message: 'sha mismatch' });
          delete repo.files[path];
          repo.commits.unshift({ sha: commitId(), message: body.message, when: nowIso(), path });
          renderGithub();
          return json(200, { commit: { sha: 'd' } });
        }
      }
      return json(404, { message: 'Not Found' });
    }
    return json(404, { message: `demo: unhandled ${method} ${u.href}` });
  }

  // ------------------------------------------------------------ fake Chrome --
  const storage = { local: {}, session: {} };
  const storageListeners = [];
  const area = (name) => ({
    async get(keys) {
      const src = storage[name];
      if (keys == null) return structuredClone(src);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in src) out[k] = structuredClone(src[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: storage[name][k], newValue: structuredClone(v) };
        storage[name][k] = structuredClone(v);
      }
      queueMicrotask(() => storageListeners.forEach((fn) => fn(changes, name)));
    },
    async remove(k) {
      const changes = {};
      for (const key of [].concat(k)) {
        changes[key] = { oldValue: storage[name][key] };
        delete storage[name][key];
      }
      queueMicrotask(() => storageListeners.forEach((fn) => fn(changes, name)));
    },
    async clear() {
      storage[name] = {};
    },
  });

  const tabs = [
    { id: 1, url: 'https://colab.research.google.com/drive/1kX9pQzR3tLmN8vB2cD4eF6gH7jK1mP0o?usp=sharing', label: 'Customer Churn Analysis.ipynb', fileId: '1kX9pQzR3tLmN8vB2cD4eF6gH7jK1mP0o' },
    { id: 2, url: 'https://colab.research.google.com/drive/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV', label: 'Untitled3.ipynb', fileId: '1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV' },
    { id: 3, url: 'https://github.com/subhadip-medya', label: 'GitHub', fileId: null },
  ];
  const tabTitle = (t) => (t.fileId ? `${drive[t.fileId].name} - Colab` : 'subhadip-medya · GitHub');
  const tabObj = (t) => ({ id: t.id, url: t.url, title: tabTitle(t), active: t.id === activeTabId });
  let activeTabId = 1;
  const badges = {};
  const messageListeners = [];
  const alarmListeners = [];
  const tabListeners = { onActivated: [], onUpdated: [] };
  const alarmTimers = new Map();

  window.chrome = {
    runtime: {
      lastError: null,
      onInstalled: { addListener: (fn) => setTimeout(fn, 0) },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage(msg, cb) {
        const sender = { id: 'demo', tab: tabObj(tabs.find((t) => t.id === activeTabId)) };
        messageListeners.forEach((fn) => fn(msg, sender, (res) => cb && cb(res)));
      },
      getManifest: () => ({ oauth2: undefined }),
      id: 'opghjahdadhgakfklikfgmibfpajbggj',
    },
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (fn) => storageListeners.push(fn) } },
    alarms: {
      async clear(name) {
        if (alarmTimers.has(name)) { clearTimeout(alarmTimers.get(name)); clearInterval(alarmTimers.get(name)); alarmTimers.delete(name); }
        return true;
      },
      async create(name, info) {
        if (alarmTimers.has(name)) clearTimeout(alarmTimers.get(name)), clearInterval(alarmTimers.get(name));
        const fire = () => alarmListeners.forEach((fn) => fn({ name }));
        const ms = (m) => (m * 60_000) / CLOCK;
        if (info.periodInMinutes) {
          const t = setTimeout(() => {
            fire();
            alarmTimers.set(name, setInterval(fire, ms(info.periodInMinutes)));
          }, ms(info.delayInMinutes ?? info.periodInMinutes));
          alarmTimers.set(name, t);
        } else {
          alarmTimers.set(name, setTimeout(() => { alarmTimers.delete(name); fire(); }, ms(info.delayInMinutes ?? 0)));
          if (!name.startsWith('colabsync:cell:')) toast(`⏱ Auto-sync scheduled in ${info.delayInMinutes} demo-minutes (${((info.delayInMinutes * 60) / CLOCK).toFixed(0)} s)`);
        }
      },
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
    tabs: {
      async sendMessage(tabId, msg) {
        // the content script's toast, rendered on the simulated Colab page
        if (msg?.type === 'syncStatus' && msg.status?.state === 'synced' && (msg.status.trigger === 'cell' || (msg.status.pushed && ['save', 'interval'].includes(msg.status.trigger)))) colabToast(`${msg.status.pushed === false ? '✔' : '✅'} ${msg.status.message}`);
        else if (msg?.type === 'syncStatus' && ['conflict', 'secrets', 'error'].includes(msg.status?.state)) colabToast(`⚠️ Not pushed: ${msg.status.message}`);
      },
      async create({ url }) {
        if (/github\.com\/login\/device/.test(url)) deviceModal();
        else toast(`Would open a new tab: <code>${esc(url)}</code>`);
        return { id: 99, url };
      },
      onActivated: { addListener: (fn) => tabListeners.onActivated.push(fn) },
      onUpdated: { addListener: (fn) => tabListeners.onUpdated.push(fn) },
      async get(id) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id ' + id);
        return tabObj(t);
      },
      async query(q = {}) {
        let list = tabs;
        if (q.active) list = list.filter((t) => t.id === activeTabId);
        if (q.url) list = list.filter((t) => new RegExp('^' + q.url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(t.url));
        return list.map(tabObj);
      },
    },
    action: {
      async setBadgeText({ tabId, text }) { badges[tabId] = { ...(badges[tabId] ?? {}), text }; renderBadge(); },
      async setBadgeBackgroundColor({ tabId, color }) { badges[tabId] = { ...(badges[tabId] ?? {}), color }; renderBadge(); },
      async setTitle({ tabId, title }) { badges[tabId] = { ...(badges[tabId] ?? {}), title }; renderBadge(); },
    },
    identity: {
      getRedirectURL: (p) => `https://opghjahdadhgakfklikfgmibfpajbggj.chromiumapp.org/${p}`,
      launchWebAuthFlow({ url, interactive }, cb) {
        const u = new URL(url);
        const isGoogle = u.hostname === 'accounts.google.com';
        const state = u.searchParams.get('state');
        const redirect = u.searchParams.get('redirect_uri');
        const done = (result, err) => {
          chrome.runtime.lastError = err ? { message: err } : null;
          try { cb(result); } finally { chrome.runtime.lastError = null; }
        };
        if (isGoogle && !interactive) {
          return googleAuthorized ? done(`${redirect}#access_token=goog-token&expires_in=3600&token_type=Bearer&state=${state}`) : done(undefined, 'User interaction required.');
        }
        if (!isGoogle) pkceDemo.challenge = u.searchParams.get('code_challenge');
        authModal(isGoogle ? 'google' : 'github', (approved) => {
          if (!approved) return done(undefined, 'The user did not approve access.');
          if (isGoogle) { googleAuthorized = true; done(`${redirect}#access_token=goog-token&expires_in=3600&token_type=Bearer&state=${state}`); }
          else done(`${redirect}?code=demo-code&state=${state}`);
        });
      },
      removeCachedAuthToken(_o, cb) { cb && cb(); },
    },
  };

  function deviceModal() {
    const wrap = document.createElement('div');
    wrap.className = 'auth-modal';
    wrap.innerHTML = `<div class="auth-card">
      <div class="auth-head">github.com/login/device — (new tab)</div>
      <h4>Device activation</h4>
      <p>Enter the code displayed in ColabHub:</p>
      <p><input class="device-input" placeholder="XXXX-XXXX" maxlength="9" style="font:700 20px ui-monospace,monospace;letter-spacing:.15em;width:100%;padding:8px;border:1px solid #d0d7de;border-radius:6px;text-align:center;text-transform:uppercase"></p>
      <p class="muted small">In the real flow this tab is GitHub's own page. Here, typing the code (or clicking Continue) approves it.</p>
      <div class="auth-actions"><button class="cancel">Cancel</button><button class="ok">Continue → Authorize ColabHub</button></div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.ok').onclick = () => { deviceDemo.approved = true; wrap.remove(); toast('Authorized on github.com — ColabHub will pick it up on the next poll'); };
    wrap.querySelector('.cancel').onclick = () => wrap.remove();
  }

  function authModal(provider, cb) {
    const wrap = document.createElement('div');
    wrap.className = 'auth-modal';
    const isG = provider === 'google';
    wrap.innerHTML = `<div class="auth-card">
      <div class="auth-head">${isG ? 'accounts.google.com' : 'github.com/login/oauth/authorize'}</div>
      <h4>${isG ? 'ColabHub wants to access your Google Account' : 'Authorize ColabHub'}</h4>
      <p>${isG ? 'See and download all your Google Drive files <span class="muted">(read-only — used to read the notebook file)</span>' : 'ColabHub by <b>subhadip-medya</b> would like permission to access your account:<br><b>repo</b> — full control of private repositories<br><b>read:org</b> — read org membership'}</p>
      <div class="auth-actions"><button class="cancel">Cancel</button><button class="ok">${isG ? 'Allow' : 'Authorize'}</button></div>
    </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.ok').onclick = () => { wrap.remove(); cb(true); };
    wrap.querySelector('.cancel').onclick = () => { wrap.remove(); cb(false); };
  }

  // -------------------------------------------------------------- rendering --
  function renderTabs() {
    $('tabstrip').innerHTML = tabs.map((t) => `<button class="tab ${t.id === activeTabId ? 'active' : ''}" data-id="${t.id}">${t.fileId ? '📓' : '🐙'} ${esc(t.fileId ? drive[t.fileId].name : t.label)}</button>`).join('');
    $('tabstrip').querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(Number(b.dataset.id))));
    $('urlbar').textContent = tabs.find((t) => t.id === activeTabId).url;
  }
  function renderBadge() {
    const b = badges[activeTabId];
    const el = $('ext-badge');
    el.textContent = b?.text ?? '';
    el.style.background = b?.color ?? 'transparent';
    el.style.display = b?.text ? 'inline-flex' : 'none';
    const icon = $('ext-icon');
    if (icon) icon.title = b?.title ?? 'ColabHub';
    const line = $('badge-title');
    if (line) line.textContent = b?.title ? b.title.replace(/^ColabHub — /, '') : '';
  }
  function renderPage() {
    const t = tabs.find((x) => x.id === activeTabId);
    const page = $('page');
    if (!t.fileId) {
      page.innerHTML = `<div class="ghpage"><div class="ghpage-top">GitHub</div><div class="muted" style="padding:20px">Not a Colab tab — click the ⚡ icon to see how the popup behaves here.</div></div>`;
      return;
    }
    const f = drive[t.fileId];
    let nb;
    try { nb = JSON.parse(f.content); } catch { nb = { cells: [] }; }
    page.innerHTML = `<div class="colab">
      <div class="colab-top"><span class="colab-logo">CO</span> <b>${esc(f.name)}</b> <span class="muted small">— ${f.saved === false ? 'Saving…' : 'All changes saved'} · modified ${esc(f.modifiedTime)}</span></div>
      ${nb.cells.map((c) => `<div class="cell ${c.cell_type}">
          <div class="gutter">${c.cell_type === 'code' ? `[${c.execution_count ?? ' '}]` : ''}</div>
          <div class="cell-body"><pre>${esc([].concat(c.source).join(''))}</pre>
          ${(c.outputs ?? []).map((o) => `<pre class="out">${esc([].concat(o.text ?? o.data?.['text/plain'] ?? '').join(''))}</pre>`).join('')}</div>
        </div>`).join('')}
    </div>`;
  }
  function renderGithub() {
    const el = $('github-view');
    if (!el) return;
    const repos = Object.values(gh.repos).sort((a, b) => (b.meta.pushed_at > a.meta.pushed_at ? 1 : -1));
    el.innerHTML = repos.map((r) => `<details class="repo" ${r.commits.some((c) => /ColabHub/.test(c.message)) ? 'open' : ''}>
        <summary>${r.meta.private ? '🔒' : '🌎'} <b>${esc(r.meta.full_name)}</b> <span class="muted">· ${r.commits.length} commit${r.commits.length === 1 ? '' : 's'}</span></summary>
        <div class="files">${Object.entries(r.files).map(([p, f]) => `<div><code>${esc(p)}</code> <span class="muted">${f.sha.slice(0, 7)} · ${f.content.length} B</span></div>`).join('') || '<div class="muted">empty repository</div>'}</div>
        <div class="commits">${r.commits.slice(0, 5).map((c) => `<div><span class="sha">${c.sha.slice(0, 7)}</span> ${esc(c.message)} <span class="muted">${c.when.slice(11, 16)}</span></div>`).join('')}</div>
      </details>`).join('');
  }
  function logApi(method, u, status) {
    const el = $('api-log');
    if (!el) return;
    const host = u.hostname === 'api.github.com' ? 'github' : u.hostname === 'www.googleapis.com' ? 'drive' : 'auth';
    const row = document.createElement('div');
    row.className = `row ${status >= 400 ? 'bad' : ''}`;
    row.innerHTML = `<span class="h ${host}">${host}</span> <span class="m">${method}</span> <span class="p">${esc(u.pathname + (u.search.length < 40 ? u.search : ''))}</span> <span class="s">${status}</span>`;
    el.prepend(row);
    while (el.children.length > 60) el.lastChild.remove();
  }

  function switchTab(id) {
    activeTabId = id;
    renderTabs();
    renderPage();
    renderBadge();
    tabListeners.onActivated.forEach((fn) => fn({ tabId: id }));
    window.__popupBoot && window.__popupBoot();
  }

  // ---------------------------------------------------------------- controls --
  function activeFile() {
    const t = tabs.find((x) => x.id === activeTabId);
    return t.fileId ? drive[t.fileId] : null;
  }
  function editNotebook(mutator, label) {
    const f = activeFile();
    if (!f) return toast('Switch to a Colab tab first');
    const nb = JSON.parse(f.content);
    mutator(nb);
    f.content = JSON.stringify(nb, null, 1) + '\n';
    f.modifiedTime = nowIso();
    renderPage();
    if (label) toast(label);
    tabListeners.onUpdated.forEach((fn) => fn(activeTabId, { status: 'complete' }));
  }
  let editCount = 0;
  const controls = [
    ['✏️ Edit notebook in Colab', () => editNotebook((nb) => { editCount++; nb.cells.push({ cell_type: 'code', metadata: {}, execution_count: editCount + 2, source: [`# experiment ${editCount}\n`, `df.groupby("Contract")["Churn"].mean()`], outputs: [{ output_type: 'stream', name: 'stdout', text: [`Month-to-month    0.4271\nOne year          0.1127\nTwo year          0.0283\n`] }] }); }, 'Notebook edited (Drive modifiedTime bumped)')],
    ['🔑 Paste an API key into a cell', () => editNotebook((nb) => { nb.cells.push({ cell_type: 'code', metadata: {}, execution_count: 9, source: ['import openai\n', 'openai.api_key = "sk-proj-' + 'Qx7Rt2Lp9Vm3Kn8Bw5Zc1Yd4Fh6Jg0S' + '"'], outputs: [] }); }, 'Oops — a secret is now in the notebook. Try Sync Now.')],
    ['🧹 Remove the API key cell', () => editNotebook((nb) => { nb.cells = nb.cells.filter((c) => ![].concat(c.source).join('').includes('api_key')); }, 'Secret removed')],
    ['▶️ Run a cell in Colab (Shift+Enter)', () => {
      const t = tabs.find((x) => x.id === activeTabId);
      if (!t.fileId) return toast('Not a Colab tab');
      // a realistic run: the user typed a new cell and executed it → new source + new output
      editNotebook((nb) => { runCount++; nb.cells.push({ cell_type: 'code', metadata: { id: `run${runCount}` }, execution_count: 10 + runCount, source: [`# cell run ${runCount}\n`, `print(df["Churn"].mean() * ${runCount})`], outputs: [{ output_type: 'stream', name: 'stdout', text: [`${(0.2653 * runCount).toFixed(4)}\n`] }] }); }, null);
      messageListeners.forEach((fn) => fn({ type: 'cellExecuted', why: 'demo' }, { tab: tabObj(t) }, (r) => {
        if (!r?.result?.scheduled) return toast('Cell ran — Auto-Push is off for this notebook (enable it in the popup)');
        toast(`Cell ran → Auto-Push in ${(r.result.inMs / 1000).toFixed(0)} s (${r.result.granularity})`);
      }));
    }],
    ['⌨️ Press Ctrl+S in Colab', () => { const t = tabs.find((x) => x.id === activeTabId); if (!t.fileId) return toast('Not a Colab tab'); messageListeners.forEach((fn) => fn({ type: 'notebookSaved' }, { tab: tabObj(t) }, (r) => toast(r?.result ? 'Save noticed → debounced auto-sync scheduled' : 'Save noticed, but auto-sync is off for this notebook'))); }],
    ['🐙 Someone edits the file on GitHub', async () => {
      const nbs = storage.local.notebooks ?? {};
      const t = tabs.find((x) => x.id === activeTabId);
      const cfg = t.fileId && nbs[t.fileId];
      if (!cfg) return toast('Connect this notebook to a repository first');
      const repo = gh.repos[`${cfg.owner}/${cfg.repo}`];
      const cur = repo?.files[cfg.path];
      if (!cur) return toast('The notebook has not been pushed yet');
      const nb = JSON.parse(cur.content);
      nb.cells.unshift({ cell_type: 'markdown', metadata: {}, source: ['> Edited on github.com by a teammate'] });
      const content = JSON.stringify(nb, null, 1) + '\n';
      repo.files[cfg.path] = { content, sha: await sha1(content) };
      repo.commits.unshift({ sha: commitId(), message: 'Fix typo in intro (via web UI)', when: nowIso(), path: cfg.path });
      renderGithub();
      toast('Remote file changed. Edit the notebook and Sync → conflict.');
    }],
    ['⏱ Fire the auto-sync timer now', () => { alarmListeners.forEach((fn) => fn({ name: 'colabsync:autosync' })); toast('Auto-sync interval fired'); }],
    ['🧑‍💻 Show developer setup screen', () => { location.search = '?unconfigured'; }],
    ['🔄 Reset demo', () => { location.search = ''; }],
  ];
  $('controls').innerHTML = '';
  for (const [label, fn] of controls) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    $('controls').appendChild(b);
  }
  $('ext-icon').onclick = () => { const p = $('popup'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) window.__popupBoot && window.__popupBoot(); };

  // links inside the popup point at the simulated GitHub → don't navigate, highlight the panel
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="https://github.com/"], a[href^="https://colab.research.google.com/"]');
    if (!a) return;
    e.preventDefault();
    if (a.href.startsWith('https://colab')) { const t = tabs.find((x) => a.href.includes(x.fileId)); if (t) switchTab(t.id); return; }
    const panel = $('github-view');
    panel.classList.add('flash');
    setTimeout(() => panel.classList.remove('flash'), 1200);
    toast(`Would open <code>${esc(a.href)}</code> — see the GitHub panel →`);
  });

  renderTabs();
  renderPage();
  renderBadge();

  // status line: confirms the bundle booted and which environment we're in
  const statusTimer = setInterval(() => {
    const el = $('demo-status');
    if (!el) return;
    if (typeof window.__popupBoot === 'function') {
      clearInterval(statusTimer);
      const secure = window.isSecureContext ? 'secure context' : 'non-secure context';
      const shim = window.__demoUsedDigestShim ? ', using JS hash shim' : '';
      const framed = window.top !== window ? 'embedded' : 'top-level';
      el.textContent = `✅ Extension code running (${framed}, ${secure}${shim}).`;
    }
  }, 100);
})();
