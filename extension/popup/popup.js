// popup/popup.js — UI state machine. Talks to background.js via sendMessage.
import { validateRepoName, suggestRepoName, defaultNotebookPath, normalizeRepoPath } from '../lib/notebook.js';
import { GRANULARITIES, pathForGranularity, filterRepos } from '../lib/granularity.js';

const $view = document.getElementById('view');
const $back = document.getElementById('btn-back');
const $ghStatus = document.getElementById('gh-status');
const $settings = document.getElementById('btn-settings');

let state = null; // from background getState
let route = { name: 'boot' };
let history = [];
let repoCache = null;
let ownerCache = null;

// ------------------------------------------------------------------ messaging

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from background'));
      if (!res.ok) {
        const e = new Error(res.error?.message || 'Unknown error');
        Object.assign(e, res.error);
        return reject(e);
      }
      resolve(res.result);
    });
  });
}

const $brandSub = document.getElementById('brand-sub');

async function refreshState() {
  state = await send('getState');
  $ghStatus.textContent = state.github ? `Connected as @${state.github.viewer.login}` : 'Ready';
  $ghStatus.classList.toggle('ok', Boolean(state.github));
  $brandSub.textContent = !state.tab?.fileId
    ? 'Open Google Colab first'
    : state.notebook ? `Linked to ${state.notebook.repoFullName}` : (state.tab.title || 'Colab notebook');
  return state;
}

// -------------------------------------------------------------------- routing

function go(name, params = {}, { replace = false } = {}) {
  if (!replace && route.name !== 'boot') history.push(route);
  route = { name, ...params };
  render();
}

function back() {
  route = history.pop() ?? { name: 'auto' };
  render();
}

$back.addEventListener('click', back);
$settings.addEventListener('click', () => (route.name === 'settings' ? back() : go('settings')));

function tpl(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function mount(el) {
  $view.replaceChildren(el);
  $back.classList.toggle('hidden', history.length === 0);
  return el;
}

function showError(root, err) {
  const slot = root.querySelector('[data-slot="error"]');
  if (!slot) return alert(err?.message ?? String(err));
  slot.textContent = err ? err.message ?? String(err) : '';
  slot.classList.toggle('hidden', !err);
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${label ?? 'Working…'}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

function autoRoute() {
  if (state.github && state.tab?.fileId && state.notebook) return { name: 'dashboard' };
  return { name: 'overview' };
}

async function render() {
  if (route.name === 'auto' || route.name === 'boot') {
    route = autoRoute();
    history = [];
  }
  switch (route.name) {
    // legacy route names → the single overview screen
    case 'connect-github':
    case 'not-colab':
    case 'home':
    case 'overview': return renderOverview();
    case 'setup': return renderSetup();
    case 'create': return renderCreate();
    case 'existing': return renderExisting();
    case 'dashboard': return renderDashboard();
    case 'settings': return renderSettings();
    default: route = autoRoute(); return render();
  }
}

// ---------------------------------------------------------- views: overview
// One dashboard screen: GitHub connection card · current notebook card · Create / Connect actions.
// Everything is visible at once; cards just change state (like the LeetHub-style popups).

function renderOverview() {
  if (!state.github && !state.capabilities.githubOAuth && !route.forceConnect) return renderSetup();
  const el = mount(tpl('tpl-overview'));
  const s = (name) => el.querySelector(`[data-slot="${name}"]`);
  const a = (name) => el.querySelector(`[data-action="${name}"]`);
  const connected = Boolean(state.github);
  const isDevice = state.capabilities.githubAuthMethod === 'device';

  // ---- GitHub connection card
  s('gh-dot').className = 'dot ' + (connected ? 'ok' : state.capabilities.githubOAuth ? 'warn' : '');
  const oauthBtn = a('oauth');
  if (connected) {
    s('gh-sub').textContent = state.github.source === 'oauth' ? 'Signed in with GitHub OAuth' : 'Signed in with a personal access token';
    oauthBtn.classList.add('hidden');
    s('pat-details').classList.add('hidden');
    s('account').classList.remove('hidden');
    const v = state.github.viewer;
    s('login').textContent = `@${v.login}`;
    s('name').textContent = v.name || '';
    const avatar = v.avatarUrl || v.avatar_url;
    if (avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(avatar)) s('avatar').innerHTML = `<img src="${avatar}" alt="" />`;
    else s('avatar').textContent = (v.login || '?')[0].toUpperCase();
    a('disconnect-github').addEventListener('click', async () => {
      if (!confirm('Disconnect GitHub? Notebook links are kept; you can reconnect later.')) return;
      await send('disconnectGithub');
      await refreshState();
      history = [];
      go('auto', {}, { replace: true });
    });
  } else if (!state.capabilities.githubOAuth) {
    s('gh-sub').innerHTML = 'One-click sign-in is not set up in this build — <a href="#" data-action="open-setup">finish the publisher setup</a>, or use a token below.';
    s('gh-sub').querySelector('[data-action="open-setup"]').addEventListener('click', (e) => { e.preventDefault(); go('setup'); });
    oauthBtn.classList.add('hidden');
    s('pat-details').open = true;
  } else {
    s('gh-sub').textContent = isDevice
      ? 'Sign in on github.com with a one-time code'
      : state.capabilities.githubExchange === 'backend' ? 'Backend OAuth proxy ready' : 'GitHub OAuth ready';
    oauthBtn.title = isDevice
      ? 'Opens github.com in a new tab where you enter a short one-time code.'
      : 'Opens GitHub\'s authorization page — click Authorize and you\'re back here.';
  }

  let devicePollTimer = null;
  const stopPolling = () => { clearTimeout(devicePollTimer); devicePollTimer = null; };

  oauthBtn.addEventListener('click', async () => {
    busy(oauthBtn, true, 'Waiting for GitHub…');
    showError(el, null);
    try {
      const r = await send('connectGithubOAuth');
      if (r?.done === false) return showDeviceCode(r);
      await refreshState();
      flash(`✅ Connected as <b>@${escapeHtml(state.github.viewer.login)}</b>`);
      go('auto', {}, { replace: true });
    } catch (e) {
      showError(el, e);
    } finally {
      if (!devicePollTimer) busy(oauthBtn, false);
    }
  });

  // Device-flow panel: shows the code, keeps polling until GitHub confirms.
  function showDeviceCode({ userCode, verificationUri, expiresAt }) {
    const panel = s('device');
    panel.classList.remove('hidden');
    panel.querySelector('[data-slot="code"]').textContent = userCode;
    const link = panel.querySelector('[data-slot="verify-link"]');
    link.href = verificationUri;
    link.textContent = verificationUri.replace(/^https?:\/\//, '');
    const status = panel.querySelector('[data-slot="device-status"]');
    busy(oauthBtn, true, 'Waiting for you to enter the code…');

    panel.querySelector('[data-action="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(userCode); flash('Code copied'); } catch { /* clipboard blocked */ }
    };
    panel.querySelector('[data-action="cancel-device"]').onclick = async () => {
      stopPolling();
      await send('deviceFlowCancel').catch(() => {});
      panel.classList.add('hidden');
      busy(oauthBtn, false);
    };

    const tick = async () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      status.textContent = `Waiting for GitHub… code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      try {
        const r = await send('deviceFlowPoll');
        if (r.status === 'ok') {
          stopPolling();
          status.textContent = `Connected as @${r.viewer.login} ✓`;
          await refreshState();
          return go('auto', {}, { replace: true });
        }
        if (r.status === 'expired') {
          stopPolling();
          panel.classList.add('hidden');
          busy(oauthBtn, false);
          return showError(el, new Error('The code expired. Click "Connect GitHub" to get a new one.'));
        }
        devicePollTimer = setTimeout(tick, Math.min(Math.max(r.retryIn ?? 5000, 1000), 10000));
      } catch (e) {
        stopPolling();
        panel.classList.add('hidden');
        busy(oauthBtn, false);
        showError(el, e);
      }
    };
    devicePollTimer = setTimeout(tick, 1000);
  }

  const patBtn = a('pat');
  const patInput = el.querySelector('[data-field="pat"]');
  const connectPat = async () => {
    busy(patBtn, true, 'Checking token…');
    showError(el, null);
    try {
      await send('connectGithubPat', { token: patInput.value });
      await refreshState();
      go('auto', {}, { replace: true });
    } catch (e) {
      showError(el, e);
    } finally {
      busy(patBtn, false);
    }
  };
  patBtn.addEventListener('click', connectPat);
  patInput.addEventListener('keydown', (e) => e.key === 'Enter' && connectPat());

  // Google Drive line (only worth mentioning once GitHub is connected)
  if (connected) {
    if (!state.capabilities.google) {
      s('drive').textContent = 'Google Drive access isn\'t configured in this build (GOOGLE_CLIENT_ID) — syncing will fail until it is.';
    } else {
      s('drive').innerHTML = 'Google Drive: read-only access is requested on first sync. <a href="#" data-action="google">Grant now</a>';
      s('drive').querySelector('[data-action="google"]').addEventListener('click', async (e) => {
        e.preventDefault();
        try { await send('connectGoogle'); s('drive').textContent = 'Google Drive: access granted ✓'; } catch (err) { showError(el, err); }
      });
    }
  }

  // ---- current notebook card
  const tab = state.tab;
  const onColab = Boolean(tab?.fileId);
  const title = onColab ? (tab.title || 'Untitled notebook') : 'Open a Colab notebook';
  s('nb-title').textContent = title;
  s('nb-path').textContent = defaultNotebookPath(state.settings.defaultFolder, onColab ? title : 'Open a Colab notebook');
  const pill = s('nb-pill');
  if (onColab) { pill.textContent = 'Not linked'; pill.className = 'pill'; }
  else { pill.textContent = 'Not Colab'; pill.className = 'pill warn'; }
  if (!onColab) {
    const reason = s('nb-reason');
    reason.classList.remove('hidden');
    reason.textContent = tab?.isColab
      ? 'This Colab tab isn\'t a Drive-backed notebook (opened from GitHub or a tutorial). File → Save a copy in Drive, then click the icon again.'
      : 'ColabHub works on notebooks saved in Google Drive — open one at colab.research.google.com/drive/… and click this icon again.';
  }

  // ---- actions
  const ready = connected && onColab;
  for (const name of ['create', 'existing']) {
    const btn = a(name);
    btn.disabled = !ready;
    btn.title = ready ? '' : !connected ? 'Connect GitHub first' : 'Open a Colab notebook first';
    btn.addEventListener('click', () => ready && go(name));
  }

  // ---- other connected notebooks (handy when not on a Colab tab)
  if (state.notebooks.length) {
    s('recent').classList.remove('hidden');
    s('recent-list').appendChild(notebookList(state.notebooks));
  }
}

// ------------------------------------------------------------- views: setup
// Shown only when the build has no OAuth client IDs (developer / unpacked install).
// End users of a published build never see this screen.

async function renderSetup() {
  const el = mount(tpl('tpl-setup'));
  const f = (name) => el.querySelector(`[data-field="${name}"]`);
  const s = (name) => el.querySelector(`[data-slot="${name}"]`);
  const cfg = await send('getAppConfig');
  const urls = state.capabilities.redirectUrls;

  s('cb-github').textContent = urls.github;
  s('cb-google').textContent = urls.google;
  f('githubClientId').value = cfg.githubClientId || '';
  f('tokenExchangeUrl').value = cfg.tokenExchangeUrl || '';
  f('googleClientId').value = cfg.googleClientId || '';
  if (cfg.githubClientSecretSet) {
    f('githubClientSecret').placeholder = 'Client secret saved ✓ (paste a new one to replace)';
    if (!cfg.tokenExchangeUrl) el.querySelector('details').open = true;
  }

  const pill = (slot, done, okText, todoText) => {
    s(slot).textContent = done ? okText : todoText;
    s(slot).className = 'pill ' + (done ? 'ok' : 'todo');
  };
  pill('gh-state', Boolean(cfg.githubClientId), '✓ configured', 'not configured');
  pill('be-state', cfg.githubExchange !== 'none', cfg.githubExchange === 'backend' ? '✓ Worker' : '✓ client secret (dev)', 'required');
  pill('g-state', Boolean(cfg.googleClientId), '✓ configured', 'optional for now — needed for Sync');

  el.querySelectorAll('[data-action="copy"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const text = el.querySelector(`[data-slot="${b.dataset.target}"]`).textContent;
      try { await navigator.clipboard.writeText(text); flash('Copied'); } catch { prompt('Copy this URL', text); }
    }),
  );
  el.querySelector('[data-action="open-gh"]').addEventListener('click', () => chrome.tabs.create({ url: 'https://github.com/settings/applications/new' }));
  el.querySelector('[data-action="open-gcp"]').addEventListener('click', () => chrome.tabs.create({ url: 'https://console.cloud.google.com/apis/credentials' }));

  const beResult = s('be-result');
  const showBackendResult = (r) => {
    beResult.classList.remove('hidden');
    beResult.textContent = r.message;
    beResult.style.color = r.ok ? 'var(--primary)' : 'var(--danger)';
  };
  el.querySelector('[data-action="test-backend"]').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, '…');
    showBackendResult(await send('checkTokenExchange', { url: f('tokenExchangeUrl').value }));
    busy(e.currentTarget, false);
  });

  el.querySelector('[data-action="save"]').addEventListener('click', async (e) => {
    const gh = f('githubClientId').value.trim();
    const be = f('tokenExchangeUrl').value.trim().replace(/\/+$/, '');
    const g = f('googleClientId').value.trim();
    const secret = f('githubClientSecret').value.trim();
    if (gh && /^(ghp_|gho_|github_pat_)/.test(gh)) return showError(el, new Error('That is a personal access token, not a Client ID. Use "Skip — sign in with a personal access token" below for that.'));
    if (gh && /^[a-f0-9]{40}$/i.test(gh)) return showError(el, new Error('That looks like the client secret. The Client ID is the short value starting with Ov23li… shown above it on the OAuth App page.'));
    if (gh && !/^(Ov23li|Iv1\.|Iv23li)[A-Za-z0-9]+$/.test(gh) && gh.length < 12) return showError(el, new Error('That does not look like a GitHub OAuth App Client ID (they start with Ov23li… or Iv1.…).'));
    if (be && !/^https?:\/\/[^\s/]+/.test(be)) return showError(el, new Error('The backend URL should look like https://colabhub-auth.<you>.workers.dev'));
    if (be && /github\.com|googleapis\.com/.test(be)) return showError(el, new Error('The backend URL is the address of YOUR deployed Worker (…workers.dev), not github.com.'));
    if (secret && !/^[a-f0-9]{40}$/i.test(secret)) return showError(el, new Error('A client secret is 40 hex characters (from "Generate a new client secret" on the OAuth App page).'));
    if (g && !/\.apps\.googleusercontent\.com$/.test(g)) return showError(el, new Error('A Google client ID ends with .apps.googleusercontent.com'));
    if (gh && !be && !secret && !cfg.githubClientSecretSet && state.capabilities.githubAuthMethod !== 'device') {
      return showError(el, new Error('Step 2 is missing: without the Worker URL (or, for a personal build, the client secret) GitHub will refuse to issue a token after the user clicks Authorize.'));
    }
    busy(e.currentTarget, true, 'Saving…');
    await send('setAppConfig', { patch: { GITHUB_CLIENT_ID: gh, TOKEN_EXCHANGE_URL: be, GOOGLE_CLIENT_ID: g, ...(secret ? { GITHUB_CLIENT_SECRET: secret } : {}) } });
    await refreshState();
    busy(e.currentTarget, false);
    if (state.capabilities.githubOAuth) {
      flash('Saved — users can now sign in with GitHub');
      history = [];
      go('overview', { forceConnect: true }, { replace: true });
    } else {
      render();
    }
  });
  el.querySelector('[data-action="use-pat"]').addEventListener('click', () => go('overview', { forceConnect: true }));
}

// ------------------------------------------------------------ views: create

async function renderCreate() {
  const el = mount(tpl('tpl-create'));
  const f = (name) => el.querySelector(`[data-field="${name}"]`);
  const title = state.tab.title || 'notebook';

  f('name').value = suggestRepoName(title);
  f('path').value = defaultNotebookPath(state.settings.defaultFolder, title);
  f('autoSync').checked = state.settings.autoSyncDefault;
  f('autoPushOnCell').checked = Boolean(state.settings.autoPushOnCellDefault);
  f('stripOutputs').checked = state.settings.stripOutputsDefault;
  wireGranularity(el, state.settings.granularityDefault);

  // owner dropdown
  const ownerSel = f('owner');
  ownerSel.innerHTML = `<option value="${state.github.viewer.login}">${state.github.viewer.login} (you)</option>`;
  loadOwners().then((owners) => {
    for (const o of owners) {
      if (o.type === 'user') continue;
      const opt = document.createElement('option');
      opt.value = o.login;
      opt.textContent = `${o.login} (organization)`;
      ownerSel.appendChild(opt);
    }
  }).catch(() => {});

  // gitignore templates (lazy; default list keeps working offline)
  send('listGitignoreTemplates').then((list) => {
    const sel = f('gitignoreTemplate');
    const cur = sel.value;
    sel.innerHTML = '';
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    sel.value = list.includes(cur) ? cur : 'Python';
  }).catch(() => {});

  // name validation
  const nameHint = el.querySelector('[data-slot="name-hint"]');
  const validate = () => {
    const err = validateRepoName(f('name').value);
    nameHint.textContent = err ?? `Will be created as ${ownerSel.value}/${f('name').value.trim()}`;
    nameHint.classList.toggle('bad', Boolean(err));
    nameHint.classList.toggle('good', !err);
    return !err;
  };
  f('name').addEventListener('input', validate);
  ownerSel.addEventListener('change', validate);
  validate();

  // visibility warning
  const warn = el.querySelector('[data-slot="public-warning"]');
  const updateVis = () => warn.classList.toggle('hidden', !f('public').checked);
  f('private').addEventListener('change', updateVis);
  f('public').addEventListener('change', updateVis);

  // gitignore toggle
  f('gitignore').addEventListener('change', () => (f('gitignoreTemplate').disabled = !f('gitignore').checked));

  const submitCreate = async (ev) => {
    ev?.preventDefault?.();
    if (!validate()) return f('name').focus();
    if (f('public').checked && !confirm('Create a PUBLIC repository? Anyone will be able to read this notebook.')) return;

    const btn = el.querySelector('[data-action="submit"]');
    busy(btn, true, 'Creating repository…');
    showError(el, null);
    try {
      const res = await send('createRepoAndConnect', {
        fileId: state.tab.fileId,
        title,
        owner: ownerSel.value,
        name: f('name').value.trim(),
        description: f('description').value.trim(),
        isPrivate: f('private').checked,
        addReadme: f('readme').checked,
        gitignoreTemplate: f('gitignore').checked ? f('gitignoreTemplate').value : null,
        path: normalizeRepoPath(f('path').value),
        autoSync: f('autoSync').checked,
        autoPushOnCell: f('autoPushOnCell').checked,
        granularity: f('granularity').value,
        stripOutputs: f('stripOutputs').checked,
      });
      repoCache = null;
      await refreshState();
      history = [];
      go('dashboard', { justCreated: res.created, sync: res.sync }, { replace: true });
    } catch (e) {
      showError(el, e);
      busy(btn, false);
    }
  };
  wireSubmit(el, submitCreate);
}

// ---------------------------------------------------------- views: existing

async function renderExisting() {
  const el = mount(tpl('tpl-existing'));
  const f = (name) => el.querySelector(`[data-field="${name}"]`);
  const title = state.tab.title || 'notebook';
  const list = f('repo');
  const branchSel = f('branch');
  const hint = el.querySelector('[data-slot="repo-hint"]');
  let selected = null; // repo summary

  f('path').value = defaultNotebookPath(state.settings.defaultFolder, title);
  f('autoSync').checked = state.settings.autoSyncDefault;
  f('autoPushOnCell').checked = Boolean(state.settings.autoPushOnCellDefault);
  f('stripOutputs').checked = state.settings.stripOutputsDefault;
  wireGranularity(el, state.settings.granularityDefault);

  hint.innerHTML = '<span class="spinner"></span> Loading your repositories…';
  let repos = [];
  try {
    repos = await loadRepos();
    hint.textContent = `${repos.length} repositories with push access — most recently pushed first`;
  } catch (e) {
    hint.textContent = '';
    showError(el, e);
  }

  const renderList = () => {
    const q = f('filter').value;
    const matches = filterRepos(repos, q, { limit: 30 });
    list.innerHTML = '';
    if (!matches.length) {
      list.innerHTML = `<div class="repo-empty muted small">${repos.length ? `No repositories match “${escapeHtml(q)}”` : 'No repositories found'}</div>`;
      return;
    }
    for (const r of matches) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'repo-item' + (selected?.fullName === r.fullName ? ' selected' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(selected?.fullName === r.fullName));
      item.dataset.fullName = r.fullName;
      item.innerHTML = `<span class="repo-vis" title="${r.private ? 'Private' : 'Public'}">${r.private ? '🔒' : '🌎'}</span>
        <span class="repo-body">
          <span class="repo-name"><span class="muted">${escapeHtml(r.owner)}/</span>${escapeHtml(r.name)}</span>
          ${r.description ? `<span class="repo-desc muted small">${escapeHtml(r.description)}</span>` : ''}
        </span>
        <span class="repo-meta muted small">${r.defaultBranch ? escapeHtml(r.defaultBranch) : ''}</span>`;
      item.addEventListener('click', () => select(r));
      list.appendChild(item);
    }
    if (!selected && matches.length === 1) select(matches[0]);
  };

  const select = (r) => {
    selected = r;
    for (const it of list.querySelectorAll('.repo-item')) {
      const on = it.dataset.fullName === r.fullName;
      it.classList.toggle('selected', on);
      it.setAttribute('aria-selected', String(on));
    }
    loadBranches();
  };

  const loadBranches = async () => {
    const r = selected;
    branchSel.innerHTML = '<option value="">Loading branches…</option>';
    if (!r) return;
    try {
      const branches = await send('listBranches', { owner: r.owner, repo: r.name });
      if (selected !== r) return; // user picked another repo meanwhile
      branchSel.innerHTML = '';
      if (!branches.length) {
        branchSel.innerHTML = `<option value="${r.defaultBranch || 'main'}">${r.defaultBranch || 'main'} (repository is empty)</option>`;
        return;
      }
      for (const b of branches) {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = b.name === r.defaultBranch ? `${b.name} (default)` : b.name;
        branchSel.appendChild(opt);
      }
      branchSel.value = r.defaultBranch;
    } catch (e) {
      branchSel.innerHTML = `<option value="${r.defaultBranch}">${r.defaultBranch}</option>`;
    }
  };

  f('filter').addEventListener('input', renderList);
  f('filter').addEventListener('keydown', (ev) => {
    // ↓ jumps into the list; Enter picks the first match
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list.querySelector('.repo-item')?.focus(); }
    if (ev.key === 'Enter') { ev.preventDefault(); const first = list.querySelector('.repo-item'); if (first && !selected) first.click(); }
  });
  list.addEventListener('keydown', (ev) => {
    const items = [...list.querySelectorAll('.repo-item')];
    const i = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' && i < items.length - 1) { ev.preventDefault(); items[i + 1].focus(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); (i > 0 ? items[i - 1] : f('filter')).focus(); }
  });
  renderList();
  f('filter').focus();

  const submitExisting = async (ev) => {
    ev?.preventDefault?.();
    const r = selected;
    if (!r) return showError(el, new Error('Search for a repository and pick one from the list'));
    const btn = el.querySelector('[data-action="submit"]');
    busy(btn, true, 'Connecting…');
    showError(el, null);
    try {
      const res = await send('connectExistingRepo', {
        fileId: state.tab.fileId,
        title,
        owner: r.owner,
        repo: r.name,
        branch: branchSel.value || r.defaultBranch,
        path: normalizeRepoPath(f('path').value),
        autoSync: f('autoSync').checked,
        autoPushOnCell: f('autoPushOnCell').checked,
        granularity: f('granularity').value,
        stripOutputs: f('stripOutputs').checked,
      });
      await refreshState();
      history = [];
      go('dashboard', { sync: res.sync }, { replace: true });
    } catch (e) {
      showError(el, e);
      busy(btn, false);
    }
  };
  wireSubmit(el, submitExisting);
}

/** Granularity <select> + hint + keep the path's extension in step (shared by create/existing forms). */
function wireGranularity(el, initial) {
  const sel = el.querySelector('[data-field="granularity"]');
  const path = el.querySelector('[data-field="path"]');
  const hint = el.querySelector('[data-slot="granularity-hint"]');
  const strip = el.querySelector('[data-field="stripOutputs"]')?.closest('label');
  const apply = () => {
    const g = sel.value in GRANULARITIES ? sel.value : 'ipynb';
    if (hint) hint.textContent = GRANULARITIES[g].hint;
    if (path) path.value = pathForGranularity(path.value, g);
    if (strip) strip.classList.toggle('hidden', g !== 'ipynb'); // strip-outputs only matters for .ipynb
  };
  sel.value = initial in GRANULARITIES ? initial : 'ipynb';
  sel.addEventListener('change', apply);
  apply();
}

// --------------------------------------------------------- views: dashboard

function renderDashboard() {
  const nb = state.notebook;
  if (!nb) return go('overview', {}, { replace: true });
  const el = mount(tpl('tpl-dashboard'));
  const s = (name) => el.querySelector(`[data-slot="${name}"]`);
  const f = (name) => el.querySelector(`[data-field="${name}"]`);

  s('title').textContent = nb.title || state.tab.title || 'Notebook';
  s('repo').textContent = nb.repoFullName;
  s('repo').href = nb.repoUrl;
  s('visibility').textContent = nb.repoPrivate ? '🔒 Private' : '🌎 Public';
  s('branch').textContent = nb.branch;
  s('path').textContent = nb.path;
  s('path').title = GRANULARITIES[nb.granularity ?? 'ipynb']?.label ?? '';
  s('path').href = nb.lastFileUrl || `${nb.repoUrl}/blob/${encodeURIComponent(nb.branch)}/${nb.path}`;

  // status
  const st = nb.status ?? { state: 'idle' };
  const statusEl = s('status');
  statusEl.dataset.state = st.state;
  const titles = {
    synced: 'Synced ✓', syncing: 'Syncing…', pending: 'Changes pending', conflict: 'Conflict',
    secrets: 'Possible secrets found', error: 'Sync failed', idle: 'Not synced yet',
  };
  s('status-title').textContent = titles[st.state] ?? st.state;
  const when = nb.lastSyncedAt ? `Last synced ${relTime(nb.lastSyncedAt)}` : 'Never synced';
  s('status-sub').innerHTML = `${escapeHtml(st.message ?? '')}${st.message ? ' · ' : ''}${when}${nb.lastCommitUrl ? ` · <a href="${nb.lastCommitUrl}" target="_blank" rel="noopener">view commit</a>` : ''}`;

  if (route.justCreated) {
    s('status-title').textContent = 'Repository created ✓';
  }
  if (st.state === 'synced' && st.trigger === 'cell') s('status-title').textContent = 'Auto-pushed ✓';

  // secrets panel
  if (st.state === 'secrets' && st.findings?.length) {
    const p = s('findings');
    p.classList.remove('hidden');
    p.innerHTML = `<b>ColabHub found what looks like credentials and did not commit:</b>
      <ul>${st.findings.slice(0, 8).map((x) => `<li>Cell ${x.cell} (${x.where}): ${escapeHtml(x.kind)}</li>`).join('')}</ul>
      <div class="muted">Remove them (or move them to Colab Secrets 🔑), then Sync again.${nb.stripOutputs || nb.granularity === 'py' ? '' : ' If they only appear in outputs, enabling "Strip outputs" (or the .py granularity) fixes it.'}</div>
      <div class="row"><button class="btn btn-sm btn-danger" data-action="sync-anyway">Commit anyway</button></div>`;
    p.querySelector('[data-action="sync-anyway"]').addEventListener('click', () => doSync({ allowSecrets: true }));
  }

  // conflict panel
  if (st.state === 'conflict') {
    const p = s('conflict');
    p.classList.remove('hidden');
    p.innerHTML = `<b>The file on GitHub differs from what ColabHub last pushed.</b>
      <div class="muted">Someone (or another notebook) changed <code>${escapeHtml(nb.path)}</code>. Choose what to do:</div>
      <div class="row">
        <button class="btn btn-sm btn-danger" data-action="overwrite">Overwrite GitHub with this notebook</button>
        ${st.remoteUrl ? `<a class="btn btn-sm" href="${st.remoteUrl}" target="_blank" rel="noopener">View on GitHub</a>` : ''}
      </div>
      <div class="muted small">Or change the path below to keep both versions.</div>`;
    p.querySelector('[data-action="overwrite"]').addEventListener('click', () => {
      if (confirm('Overwrite the GitHub copy with this notebook? The other version stays in git history.')) doSync({ force: true });
    });
  }

  // Colab integration controls
  f('autoSync').checked = Boolean(nb.autoSync);
  f('autoPushOnCell').checked = Boolean(nb.autoPushOnCell);
  f('stripOutputs').checked = Boolean(nb.stripOutputs);
  const gSel = f('granularity');
  gSel.value = nb.granularity ?? 'ipynb';
  el.querySelector('[data-slot="granularity-hint"]').textContent = GRANULARITIES[gSel.value]?.hint ?? '';
  s('strip-row').classList.toggle('hidden', gSel.value !== 'ipynb');
  f('autoSync').addEventListener('change', async (e) => {
    await send('updateNotebookConfig', { fileId: nb.fileId, patch: { autoSync: e.target.checked } });
    await refreshState();
  });
  f('autoPushOnCell').addEventListener('change', async (e) => {
    await send('updateNotebookConfig', { fileId: nb.fileId, patch: { autoPushOnCell: e.target.checked } });
    await refreshState();
    flash(e.target.checked ? `Auto-Push on: every cell run commits to <b>${escapeHtml(nb.branch)}</b>` : 'Auto-Push off');
  });
  gSel.addEventListener('change', async (e) => {
    const g = e.target.value;
    const newPath = pathForGranularity(nb.path, g);
    await send('updateNotebookConfig', { fileId: nb.fileId, patch: { granularity: g } });
    await refreshState();
    render();
    flash(`Now committing <b>${escapeHtml(GRANULARITIES[g].label)}</b> → <code>${escapeHtml(newPath)}</code>. Sync to push it.`);
  });
  f('stripOutputs').addEventListener('change', async (e) => {
    await send('updateNotebookConfig', { fileId: nb.fileId, patch: { stripOutputs: e.target.checked } });
    await refreshState();
    render();
  });

  f('path').value = nb.path;
  el.querySelector('[data-action="save-path"]').addEventListener('click', async () => {
    const path = normalizeRepoPath(f('path').value);
    if (!path) return showError(el, new Error('Path cannot be empty'));
    await send('updateNotebookConfig', { fileId: nb.fileId, patch: { path } });
    await refreshState();
    render();
  });
  el.querySelector('[data-action="disconnect"]').addEventListener('click', async () => {
    if (!confirm('Disconnect this notebook? Nothing is deleted from GitHub.')) return;
    await send('disconnectNotebook', { fileId: nb.fileId });
    await refreshState();
    history = [];
    go('auto', {}, { replace: true });
  });

  const syncBtn = el.querySelector('[data-action="sync"]');
  syncBtn.addEventListener('click', () => doSync());
  el.querySelector('[data-action="sync-msg"]').addEventListener('click', () => {
    const message = prompt('Commit message', `Update ${nb.title || nb.path} via ColabHub`);
    if (message !== null) doSync({ message });
  });

  async function doSync(opts = {}) {
    busy(syncBtn, true, 'Syncing…');
    showError(el, null);
    statusEl.dataset.state = 'syncing';
    s('status-title').textContent = 'Syncing…';
    try {
      const r = await send('syncNow', { fileId: nb.fileId, ...opts });
      await refreshState();
      route.justCreated = null;
      render();
      if (r.action === 'pushed' && r.commitUrl) flash(`✅ ${escapeHtml(r.message || 'Pushed')} — <a href="${r.commitUrl}" target="_blank" rel="noopener">view commit</a>`);
      else if (r.action === 'none') flash('Already up to date');
    } catch (e) {
      await refreshState();
      render();
      const errEl = $view.querySelector('[data-slot="error"]');
      if (errEl) {
        errEl.textContent = e.needsInteraction ? 'Google Drive access is needed. Click "Sync Now" again and approve the Google prompt.' : e.message;
        errEl.classList.remove('hidden');
      }
      if (e.needsInteraction) {
        // trigger the interactive Google prompt directly
        try { await send('connectGoogle'); await send('syncNow', { fileId: nb.fileId, ...opts }); await refreshState(); render(); } catch { /* shown above */ }
      }
    }
  }

  if (route.sync && route.sync.action && !route._shown) {
    route._shown = true;
    const r = route.sync;
    if (r.action === 'pushed' && r.commitUrl) flash(`✅ ${escapeHtml(r.message || 'Committed')} — <a href="${r.commitUrl}" target="_blank" rel="noopener">view commit</a>`);
    else if (r.action === 'error') showError(el, new Error(`Connected, but the first sync failed: ${r.error}`));
  }
}

// ---------------------------------------------------------- views: settings

async function renderSettings() {
  const el = mount(tpl('tpl-settings'));
  const f = (name) => el.querySelector(`[data-field="${name}"]`);
  const s = (name) => el.querySelector(`[data-slot="${name}"]`);
  const set = state.settings;

  s('account').innerHTML = state.github
    ? `<div class="nb-title">@${escapeHtml(state.github.viewer.login)}</div><div class="muted small">${escapeHtml(state.github.viewer.name || '')} · ${state.github.source === 'oauth' ? 'OAuth' : 'personal access token'}</div>`
    : '<div class="muted">GitHub not connected</div>';

  f('defaultFolder').value = set.defaultFolder;
  f('autoSyncMinutes').value = set.autoSyncMinutes;
  f('autoSyncDefault').checked = set.autoSyncDefault;
  f('autoPushOnCellDefault').checked = Boolean(set.autoPushOnCellDefault);
  f('stripOutputsDefault').checked = set.stripOutputsDefault;
  f('granularityDefault').value = set.granularityDefault in GRANULARITIES ? set.granularityDefault : 'ipynb';

  el.querySelector('[data-action="save"]').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Saving…');
    await send('setSettings', {
      patch: {
        defaultFolder: normalizeRepoPath(f('defaultFolder').value),
        autoSyncMinutes: Math.max(1, Math.min(120, Number(f('autoSyncMinutes').value) || 5)),
        autoSyncDefault: f('autoSyncDefault').checked,
        autoPushOnCellDefault: f('autoPushOnCellDefault').checked,
        stripOutputsDefault: f('stripOutputsDefault').checked,
        granularityDefault: f('granularityDefault').value,
      },
    });
    await refreshState();
    busy(e.currentTarget, false);
    flash('Settings saved');
  });

  s('notebooks').replaceChildren(state.notebooks.length ? notebookList(state.notebooks, true) : Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No notebooks connected yet.' }));

  s('redirect-github').textContent = state.capabilities.redirectUrls.github;
  s('redirect-google').textContent = state.capabilities.redirectUrls.google;
  const method = state.capabilities.githubAuthMethod;
  const exch = state.capabilities.githubExchange;
  const ghDesc = !state.capabilities.githubOAuth
    ? 'not configured'
    : method === 'device' ? 'configured (Device Flow)'
      : exch === 'backend' ? 'configured (OAuth via token-exchange backend)'
        : 'configured (OAuth, client secret in this profile — dev build)';
  s('caps').innerHTML = `<a href="#" data-action="open-setup">Open the publisher setup screen</a><br>` +
    `GitHub sign-in: <b>${ghDesc}</b> · ` +
    `Google Drive: <b>${state.capabilities.google ? 'configured' : 'not configured'}</b>` +
    (state.capabilities.githubOAuth ? '' : `<br><br><b>Publisher setup:</b> register a GitHub OAuth App (callback URL = the GitHub line above), deploy <code>backend/worker.js</code> with its client secret, ` +
      `then enter the Client ID and Worker URL on the setup screen or via <code>npm run configure</code>. End users never do this.`) +
    (state.capabilities.google ? '' : `<br><br><b>Google Drive:</b> console.cloud.google.com → enable Drive API → OAuth client (Web application) with the Google redirect URI above → paste the Client ID into <code>config.js</code> as <code>GOOGLE_CLIENT_ID</code>.`);
  s('caps').querySelector('[data-action="open-setup"]').addEventListener('click', (e) => { e.preventDefault(); go('setup'); });

  el.querySelector('[data-action="disconnect-github"]').addEventListener('click', async () => {
    if (!confirm('Disconnect GitHub? Notebook links are kept; you can reconnect later.')) return;
    await send('disconnectGithub');
    await refreshState();
    history = [];
    go('auto', {}, { replace: true });
  });
}

// --------------------------------------------------------------- helpers

/**
 * Wire a <form> so it works even where native submission is blocked (e.g. sandboxed iframes
 * without allow-forms): the submit button becomes type="button" and Enter in any single-line
 * input triggers the handler.
 */
function wireSubmit(form, handler) {
  const btn = form.querySelector('[data-action="submit"]');
  if (btn) {
    btn.type = 'button';
    btn.addEventListener('click', handler);
  }
  form.addEventListener('submit', (ev) => ev.preventDefault());
  form.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.type !== 'checkbox' && t.type !== 'radio') {
      ev.preventDefault();
      handler(ev);
    }
  });
}

function notebookList(list, withRemove = false) {
  const wrap = document.createElement('div');
  for (const nb of list) {
    const row = document.createElement('div');
    row.className = 'nb-list-item';
    const st = nb.status?.state ?? 'idle';
    row.innerHTML = `<div><div class="t">${escapeHtml(nb.title || nb.path)}</div><div class="muted">${escapeHtml(nb.repoFullName)} · ${escapeHtml(nb.path)} · ${st}</div></div>`;
    const actions = document.createElement('div');
    const open = document.createElement('a');
    open.href = `https://colab.research.google.com/drive/${nb.fileId}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    actions.appendChild(open);
    if (withRemove) {
      const rm = document.createElement('button');
      rm.className = 'link';
      rm.style.marginLeft = '8px';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async () => {
        if (!confirm(`Disconnect "${nb.title || nb.path}"?`)) return;
        await send('disconnectNotebook', { fileId: nb.fileId });
        await refreshState();
        render();
      });
      actions.appendChild(rm);
    }
    row.appendChild(actions);
    wrap.appendChild(row);
  }
  return wrap;
}

async function loadRepos() {
  if (!repoCache) repoCache = await send('listRepos');
  return repoCache;
}
async function loadOwners() {
  if (!ownerCache) ownerCache = await send('listOwners');
  return ownerCache;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ts).toLocaleString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let flashTimer;
function flash(html) {
  let bar = document.getElementById('flash');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'flash';
    document.body.appendChild(bar);
  }
  bar.innerHTML = html;
  bar.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (bar.style.display = 'none'), 4000);
}

// live updates while the popup is open (auto-sync finishing, etc.)
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.notebooks) return;
  await refreshState();
  if (route.name === 'dashboard' || route.name === 'settings' || route.name === 'overview') render();
});

// boot
refreshState()
  .then(() => render())
  .catch((e) => {
    $view.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  });
