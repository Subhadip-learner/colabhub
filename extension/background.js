// background.js — MV3 service worker. Orchestrates auth, GitHub, Drive and the sync engine.
// The popup and content script talk to it via chrome.runtime.sendMessage({ type, ...payload }).

import { getConfig, setConfigOverrides, describeConfig } from './lib/appconfig.js';
import * as store from './lib/storage.js';
import * as gh from './lib/github.js';
import {
  githubOAuth,
  githubOAuthAvailable,
  githubAuthMethod,
  githubDeviceStart,
  githubDevicePoll,
  googleAuthAvailable,
  googleToken,
  forgetGoogleToken,
  redirectUrls,
  checkTokenExchange,
} from './lib/auth.js';
import { getFileMeta, downloadNotebook } from './lib/drive.js';
import { prepareNotebook, planSync, executeSync, defaultCommitMessage } from './lib/syncEngine.js';
import { driveIdFromColabUrl, defaultNotebookPath, validateRepoName, normalizeRepoPath } from './lib/notebook.js';
import { isGranularity, pathForGranularity, describePush } from './lib/granularity.js';

const AUTOSYNC_ALARM = 'colabsync:autosync';
const SAVE_ALARM_PREFIX = 'colabsync:save:';
const CELL_ALARM_PREFIX = 'colabsync:cell:';
const CELL_DEBOUNCE_MS = 8000; // a cell run usually comes in bursts (Shift+Enter, Shift+Enter…)
const CELL_MAX_WAITS = 3; // Colab autosaves a little after a run; re-check Drive up to 3 × 30 s
const inflight = new Map(); // fileId -> Promise, prevents concurrent syncs of the same notebook
const cellTimers = new Map(); // fileId -> setTimeout handle (short debounce; alarms can't go < 30 s)

// ----------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => scheduleAutoSync());
chrome.runtime.onStartup.addListener(() => scheduleAutoSync());

async function scheduleAutoSync() {
  const { autoSyncMinutes } = await store.getSettings();
  const period = Math.max(1, Number(autoSyncMinutes) || 5);
  await chrome.alarms.create(AUTOSYNC_ALARM, { periodInMinutes: period, delayInMinutes: period });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTOSYNC_ALARM) return runAutoSync('interval');
  if (alarm.name.startsWith(SAVE_ALARM_PREFIX)) {
    const fileId = alarm.name.slice(SAVE_ALARM_PREFIX.length);
    const cfg = await store.getNotebook(fileId);
    if (cfg?.autoSync) await syncNotebook(fileId, { trigger: 'save' }).catch(() => {});
  }
  if (alarm.name.startsWith(CELL_ALARM_PREFIX)) {
    // safety net: if the service worker was suspended before the setTimeout fired
    const fileId = alarm.name.slice(CELL_ALARM_PREFIX.length);
    await pushAfterCell(fileId);
  }
});

// Badge follows the active tab.
chrome.tabs.onActivated.addListener(({ tabId }) => refreshBadge(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url || info.status === 'complete') refreshBadge(tabId);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.notebooks) refreshActiveBadges();
});

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      console.warn('[ColabHub]', msg?.type, err);
      sendResponse({
        ok: false,
        error: { message: err?.message ?? String(err), code: err?.code, status: err?.status, needsInteraction: Boolean(err?.needsInteraction) },
      });
    });
  return true; // keep the channel open for the async response
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'getState':
      return getState(msg.tabId);

    // --- GitHub auth
    case 'connectGithubOAuth': {
      if ((await githubAuthMethod()) === 'device') return deviceFlowStart();
      const { token, scope } = await githubOAuth(); // authorization code + PKCE
      return { done: true, ...(await connectGithubWithToken(token, 'oauth', scope)) };
    }
    case 'deviceFlowPoll':
      return deviceFlowPoll();
    case 'deviceFlowCancel':
      deviceSession = null;
      return true;
    case 'connectGithubPat':
      return connectGithubWithToken(String(msg.token ?? '').trim(), 'pat');
    case 'disconnectGithub': {
      const g = await store.getGithub();
      const CONFIG = await getConfig();
      if (g?.source === 'oauth' && CONFIG.TOKEN_EXCHANGE_URL) {
        fetch(`${CONFIG.TOKEN_EXCHANGE_URL.replace(/\/$/, '')}/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: g.token }),
        }).catch(() => {});
      }
      await store.setGithub(null);
      return true;
    }

    // --- Google auth
    case 'connectGoogle':
      await forgetGoogleToken();
      await googleToken({ interactive: true });
      return true;

    // --- GitHub data
    case 'listOwners': {
      const { token, viewer } = await requireGithub();
      const orgs = await gh.listOrgs(token).catch(() => []);
      return [{ login: viewer.login, avatarUrl: viewer.avatarUrl, type: 'user' }, ...orgs.map((o) => ({ ...o, type: 'org' }))];
    }
    case 'listRepos': {
      const { token } = await requireGithub();
      return gh.listRepos(token);
    }
    case 'listBranches': {
      const { token } = await requireGithub();
      return gh.listBranches(token, msg.owner, msg.repo);
    }
    case 'listGitignoreTemplates': {
      const { token } = await requireGithub();
      return gh.listGitignoreTemplates(token);
    }

    // --- Repo creation + notebook linking
    case 'createRepoAndConnect':
      return createRepoAndConnect(msg);
    case 'connectExistingRepo':
      return connectExistingRepo(msg);
    case 'updateNotebookConfig': {
      const cur = await store.getNotebook(msg.fileId);
      if (!cur) throw new Error('This notebook is not connected to a repository');
      const patch = {};
      for (const k of ['autoSync', 'autoPushOnCell', 'stripOutputs', 'path', 'branch', 'granularity']) if (k in msg.patch) patch[k] = msg.patch[k];
      if ('granularity' in patch) {
        if (!isGranularity(patch.granularity)) throw new Error(`Unknown push granularity: ${patch.granularity}`);
        // the file type changes with the granularity → keep the path's extension in step
        if (!('path' in patch)) patch.path = pathForGranularity(cur.path, patch.granularity);
      }
      if ('path' in patch) patch.path = normalizeRepoPath(patch.path);
      if ('stripOutputs' in patch || 'path' in patch || 'branch' in patch || 'granularity' in patch) {
        // content or destination changed → next sync must re-evaluate against the remote
        patch.lastSyncedContentHash = null;
        if ('path' in patch || 'branch' in patch) patch.lastSyncedRemoteSha = null;
        patch.status = { state: 'pending', at: Date.now() };
      }
      return store.setNotebook(msg.fileId, patch);
    }
    case 'disconnectNotebook':
      await store.removeNotebook(msg.fileId);
      return true;

    // --- Sync
    case 'syncNow':
      return syncNotebook(msg.fileId, { trigger: 'manual', force: Boolean(msg.force), allowSecrets: Boolean(msg.allowSecrets), message: msg.message });
    case 'notebookSaved': {
      // From the content script on Ctrl/Cmd+S: debounce a sync 30 s after the last save.
      const fileId = driveIdFromColabUrl(sender?.tab?.url ?? sender?.url ?? '');
      if (!fileId) return false;
      const cfg = await store.getNotebook(fileId);
      if (!cfg?.autoSync) return false;
      await chrome.alarms.create(SAVE_ALARM_PREFIX + fileId, { delayInMinutes: 0.5 });
      await store.setNotebookStatus(fileId, { state: 'pending', message: 'Change detected — syncing shortly' });
      return true;
    }
    case 'cellExecuted': {
      // From the content script when a code cell finishes running. Auto-Push: debounce a few
      // seconds (people run several cells in a row), then commit at the chosen granularity.
      const fileId = driveIdFromColabUrl(sender?.tab?.url ?? sender?.url ?? '');
      if (!fileId) return { scheduled: false };
      const cfg = await store.getNotebook(fileId);
      if (!cfg?.autoPushOnCell) return { scheduled: false };
      clearTimeout(cellTimers.get(fileId));
      cellTimers.set(fileId, setTimeout(() => pushAfterCell(fileId), CELL_DEBOUNCE_MS));
      await chrome.alarms.create(CELL_ALARM_PREFIX + fileId, { delayInMinutes: 0.5 }); // SW-suspension fallback
      if (!(cfg.status?.state === 'pending' && cfg.status.pendingCell) || cfg.cellWait) {
        await store.setNotebook(fileId, { cellWait: null, status: { state: 'pending', message: 'Cell ran — pushing shortly…', pendingCell: true, at: Date.now() } });
      }
      return { scheduled: true, inMs: CELL_DEBOUNCE_MS, granularity: cfg.granularity ?? 'ipynb' };
    }
    case 'getStatus': {
      // Content script polls this to render its in-page toast.
      const fileId = driveIdFromColabUrl(sender?.tab?.url ?? sender?.url ?? '');
      const cfg = fileId ? await store.getNotebook(fileId) : null;
      return cfg ? { connected: true, status: cfg.status ?? null, branch: cfg.branch, path: cfg.path, repoFullName: cfg.repoFullName, lastCommitUrl: cfg.lastCommitUrl ?? null } : { connected: false };
    }

    // --- App (publisher) configuration: OAuth client ID, token-exchange backend, Google client ID
    case 'getAppConfig':
      return describeConfig();
    case 'setAppConfig':
      await setConfigOverrides(msg.patch ?? {});
      return describeConfig();
    case 'checkTokenExchange':
      return checkTokenExchange(msg.url);

    // --- Settings
    case 'getSettings':
      return store.getSettings();
    case 'setSettings': {
      const s = await store.setSettings(msg.patch ?? {});
      await scheduleAutoSync();
      return s;
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// --------------------------------------------------------------------- state

async function getState(tabId) {
  const [github, settings, notebooks] = await Promise.all([store.getGithub(), store.getSettings(), store.getNotebooks()]);
  let tab = null;
  try {
    tab = tabId ? await chrome.tabs.get(tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    /* no tab access */
  }
  const fileId = tab?.url ? driveIdFromColabUrl(tab.url) : null;
  const isColab = Boolean(tab?.url && /^https:\/\/colab\.research\.google\.com\//.test(tab.url));
  const title = tab?.title ? tab.title.replace(/\s*-\s*Colab(oratory)?\s*$/i, '').trim() : '';

  return {
    github: github ? { viewer: github.viewer, source: github.source, scope: github.scope ?? '' } : null,
    settings,
    capabilities: {
      githubOAuth: await githubOAuthAvailable(),
      githubAuthMethod: await githubAuthMethod(),
      githubExchange: (await describeConfig()).githubExchange,
      google: await googleAuthAvailable(),
      redirectUrls: redirectUrls(),
      extensionId: chrome.runtime.id,
    },
    tab: tab ? { id: tab.id, url: tab.url, isColab, fileId, title: title || (fileId ? 'Untitled notebook' : '') } : null,
    notebook: fileId ? notebooks[fileId] ?? null : null,
    notebooks: Object.values(notebooks).sort((a, b) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0)),
  };
}

async function requireGithub() {
  const g = await store.getGithub();
  if (!g?.token) {
    const e = new Error('GitHub is not connected');
    e.code = 'no_github';
    throw e;
  }
  return g;
}

// ------------------------------------------------------- GitHub device flow

// Kept in memory only; a fresh code is requested if the worker was suspended in between.
let deviceSession = null; // { deviceCode, userCode, verificationUri, interval, expiresAt, nextPollAt }

async function deviceFlowStart() {
  const s = await githubDeviceStart();
  deviceSession = { ...s, nextPollAt: Date.now() + s.interval * 1000 };
  // Open GitHub's verification page in a new tab; the popup shows the code to type.
  chrome.tabs.create({ url: s.verificationUri, active: true }).catch(() => {});
  return { done: false, userCode: s.userCode, verificationUri: s.verificationUri, expiresAt: s.expiresAt, interval: s.interval };
}

/** Called repeatedly by the popup. Respects GitHub's minimum polling interval. */
async function deviceFlowPoll() {
  if (!deviceSession) return { status: 'expired' };
  if (Date.now() > deviceSession.expiresAt) {
    deviceSession = null;
    return { status: 'expired' };
  }
  if (Date.now() < deviceSession.nextPollAt) return { status: 'pending', retryIn: deviceSession.nextPollAt - Date.now() };

  let r;
  try {
    r = await githubDevicePoll(deviceSession.deviceCode);
  } catch (e) {
    deviceSession = null;
    throw e;
  }
  if (r.status === 'ok') {
    deviceSession = null;
    const connected = await connectGithubWithToken(r.token, 'oauth', r.scope);
    return { status: 'ok', ...connected };
  }
  if (r.status === 'slow_down') deviceSession.interval = r.interval;
  deviceSession.nextPollAt = Date.now() + deviceSession.interval * 1000;
  return { status: 'pending', retryIn: deviceSession.interval * 1000 };
}

async function connectGithubWithToken(token, source, scope = '') {
  if (!token) throw new Error('Token is empty');
  let viewer;
  try {
    viewer = await gh.getViewer(token);
  } catch (e) {
    if (e.code === 'unauthorized') throw new Error('GitHub rejected that token. Check that it is valid and has the "repo" scope.');
    throw e;
  }
  const record = { token, source, scope, viewer, connectedAt: Date.now() };
  await store.setGithub(record);
  return { viewer, source, scope };
}

// --------------------------------------------------------- connect / create

async function createRepoAndConnect({ fileId, title, owner, name, description, isPrivate, addReadme, gitignoreTemplate, path, autoSync, autoPushOnCell, granularity, stripOutputs }) {
  const { token, viewer } = await requireGithub();
  const nameError = validateRepoName(name);
  if (nameError) throw new Error(nameError);

  const settings = await store.getSettings();
  const repo = await gh.createRepo(token, {
    owner,
    viewerLogin: viewer.login,
    name: name.trim(),
    description: description ?? '',
    isPrivate: isPrivate !== false,
    addReadme: addReadme !== false,
    gitignoreTemplate: gitignoreTemplate || null,
  });

  // GitHub only writes .gitignore via auto_init, which always adds a README too.
  // Honour "no README, yes .gitignore" by deleting the README it created.
  if (addReadme === false && gitignoreTemplate) {
    const readme = await gh.getFile(token, repo.owner, repo.name, 'README.md', repo.defaultBranch).catch(() => null);
    if (readme) {
      await gh
        .deleteFile(token, repo.owner, repo.name, 'README.md', { message: 'Remove auto-generated README', branch: repo.defaultBranch, sha: readme.sha })
        .catch(() => {});
    }
  }

  // An empty repo (no auto_init) has no branches yet; the first PUT creates the default branch.
  const branch = repo.defaultBranch || 'main';
  const cfg = await linkNotebook(fileId, {
    title,
    repo,
    branch,
    path: path || defaultNotebookPath(settings.defaultFolder, title),
    autoSync: autoSync ?? settings.autoSyncDefault,
    autoPushOnCell: autoPushOnCell ?? settings.autoPushOnCellDefault,
    granularity: granularity ?? settings.granularityDefault,
    stripOutputs: stripOutputs ?? settings.stripOutputsDefault,
  });

  // Fire the first sync straight away so the user sees the notebook land in the new repo.
  const sync = await syncNotebook(fileId, { trigger: 'initial', message: `Add ${title} via ColabHub` }).catch((e) => ({ action: 'error', error: e.message }));
  return { notebook: await store.getNotebook(fileId), sync, created: repo, cfg };
}

async function connectExistingRepo({ fileId, title, owner, repo: repoName, branch, path, autoSync, autoPushOnCell, granularity, stripOutputs }) {
  const { token } = await requireGithub();
  const settings = await store.getSettings();
  const repo = await gh.getRepo(token, owner, repoName);
  if (repo.permissions && !repo.permissions.push) throw new Error(`You don't have push access to ${repo.fullName}`);
  await linkNotebook(fileId, {
    title,
    repo,
    branch: branch || repo.defaultBranch,
    path: path || defaultNotebookPath(settings.defaultFolder, title),
    autoSync: autoSync ?? settings.autoSyncDefault,
    autoPushOnCell: autoPushOnCell ?? settings.autoPushOnCellDefault,
    granularity: granularity ?? settings.granularityDefault,
    stripOutputs: stripOutputs ?? settings.stripOutputsDefault,
  });
  const sync = await syncNotebook(fileId, { trigger: 'initial' }).catch((e) => ({ action: 'error', error: e.message }));
  return { notebook: await store.getNotebook(fileId), sync };
}

async function linkNotebook(fileId, { title, repo, branch, path, autoSync, autoPushOnCell, granularity, stripOutputs }) {
  if (!fileId) throw new Error('Open a Google Colab notebook (a /drive/… URL) first');
  const g = isGranularity(granularity) ? granularity : 'ipynb';
  const cleanPath = normalizeRepoPath(pathForGranularity(path, g));
  if (!cleanPath) throw new Error('Notebook path is required');
  return store.setNotebook(fileId, {
    fileId,
    title,
    owner: repo.owner,
    repo: repo.name,
    repoFullName: repo.fullName,
    repoPrivate: repo.private,
    repoUrl: repo.htmlUrl,
    branch,
    path: cleanPath,
    autoSync: Boolean(autoSync),
    autoPushOnCell: Boolean(autoPushOnCell),
    granularity: g,
    stripOutputs: Boolean(stripOutputs),
    lastSyncedRemoteSha: null,
    lastSyncedContentHash: null,
    lastSyncedAt: null,
    lastCommitUrl: null,
    connectedAt: Date.now(),
    status: { state: 'pending', at: Date.now() },
  });
}

// ---------------------------------------------------------------------- sync

/**
 * @returns {Promise<{action:'none'|'pushed'|'conflict'|'blocked_secrets'|'skipped', ...}>}
 */
function syncNotebook(fileId, opts = {}) {
  if (inflight.has(fileId)) return inflight.get(fileId);
  const p = doSync(fileId, opts).finally(() => {
    inflight.delete(fileId);
    refreshActiveBadges().catch(() => {}); // badge + tooltip reflect the outcome immediately
    notifyTabs(fileId).catch(() => {}); // in-page toast on the Colab tab(s)
  });
  inflight.set(fileId, p);
  return p;
}

async function doSync(fileId, { trigger = 'manual', force = false, allowSecrets = false, message } = {}) {
  const cfg = await store.getNotebook(fileId);
  if (!cfg) throw new Error('This notebook is not connected to a repository');
  const { token } = await requireGithub();
  const interactive = trigger === 'manual' || trigger === 'initial';

  await store.setNotebookStatus(fileId, { state: 'syncing', message: 'Syncing…' });
  try {
    // 1. Drive metadata (title may have changed; modifiedTime feeds the cheap change check)
    const meta = await getFileMeta(fileId, { interactive });
    const title = meta.name || cfg.title;
    const driveChanged = !cfg.lastSeenDriveModifiedTime || meta.modifiedTime !== cfg.lastSeenDriveModifiedTime;

    if (trigger === 'cell' && !driveChanged && cfg.lastSyncedContentHash && !force) {
      // Colab hasn't autosaved since we last looked — nothing to download yet (pushAfterCell retries)
      await store.setNotebookStatus(fileId, { state: 'pending', message: 'Cell ran — waiting for Colab to save…', pendingCell: true });
      return { action: 'none', reason: 'not_saved_yet' };
    }

    // 2. Download + prepare (at the notebook's push granularity: .ipynb / .py / outputs)
    const raw = await downloadNotebook(fileId, { interactive });
    const prepared = await prepareNotebook(raw, { stripOutputs: cfg.stripOutputs, granularity: cfg.granularity ?? 'ipynb', title, trigger });

    const baseline = { title, lastSeenDriveModifiedTime: meta.modifiedTime };

    if (!force && cfg.lastSyncedContentHash && prepared.contentHash === cfg.lastSyncedContentHash) {
      // e.g. a cell run that only changed outputs while committing the .py script → nothing new
      const message = trigger === 'cell' ? `Cell ran — nothing new to push (${describeWhat(cfg.granularity)} unchanged)` : 'Up to date';
      await store.setNotebook(fileId, { ...baseline, status: { state: 'synced', message, trigger, pushed: false, at: Date.now() } });
      return { action: 'none', reason: 'unchanged', message, driveChanged };
    }

    // 3. Secret scan
    if (prepared.findings.length && !allowSecrets) {
      await store.setNotebook(fileId, {
        ...baseline,
        status: { state: 'secrets', message: `${prepared.findings.length} possible secret(s) found — sync blocked`, findings: prepared.findings, at: Date.now() },
      });
      return { action: 'blocked_secrets', findings: prepared.findings };
    }

    // 4. Remote state + plan
    const remote = await gh.getFile(token, cfg.owner, cfg.repo, cfg.path, cfg.branch);
    const plan = planSync({ localBlobSha: prepared.blobSha, remote, lastSyncedRemoteSha: cfg.lastSyncedRemoteSha, force });

    if (plan.action === 'none') {
      await store.setNotebook(fileId, {
        ...baseline,
        lastSyncedRemoteSha: remote.sha,
        lastSyncedContentHash: prepared.contentHash,
        lastSyncedAt: cfg.lastSyncedAt ?? Date.now(),
        status: { state: 'synced', message: 'Up to date', at: Date.now() },
      });
      return { action: 'none', reason: 'identical' };
    }

    if (plan.action === 'conflict') {
      await store.setNotebook(fileId, {
        ...baseline,
        status: {
          state: 'conflict',
          message:
            plan.reason === 'remote_exists'
              ? 'A different file already exists at this path on GitHub'
              : 'The file on GitHub changed since your last sync',
          remoteSha: remote.sha,
          remoteUrl: remote.htmlUrl,
          at: Date.now(),
        },
      });
      return { action: 'conflict', reason: plan.reason, remoteUrl: remote.htmlUrl };
    }

    // 5. Push
    const commitMessage = (message && message.trim()) || defaultCommitMessage({ action: plan.action, title, path: cfg.path, trigger, granularity: cfg.granularity });
    const result = await executeSync({
      token,
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch,
      path: cfg.path,
      bytes: prepared.bytes,
      plan,
      message: commitMessage,
    });

    if (result.status === 'conflict') {
      await store.setNotebook(fileId, {
        ...baseline,
        status: { state: 'conflict', message: 'GitHub changed while syncing — please retry', at: Date.now() },
      });
      return { action: 'conflict', reason: 'raced' };
    }

    await store.setNotebook(fileId, {
      ...baseline,
      lastSyncedRemoteSha: result.contentSha,
      lastSyncedContentHash: prepared.contentHash,
      lastSyncedAt: Date.now(),
      lastCommitUrl: result.commitUrl,
      lastFileUrl: result.fileUrl,
      status: {
        state: 'synced',
        message: describePush({ branch: cfg.branch, granularity: cfg.granularity, trigger, kind: plan.action }),
        commitUrl: result.commitUrl,
        trigger,
        pushed: true,
        at: Date.now(),
      },
    });
    return { action: 'pushed', kind: plan.action, commitUrl: result.commitUrl, fileUrl: result.fileUrl, secretsOverridden: prepared.findings.length > 0, message: describePush({ branch: cfg.branch, granularity: cfg.granularity, trigger, kind: plan.action }) };
  } catch (err) {
    const needsInteraction = Boolean(err?.needsInteraction);
    await store.setNotebookStatus(fileId, {
      state: 'error',
      message: needsInteraction ? 'Google Drive access needed — open ColabHub to continue' : err?.message ?? String(err),
      needsInteraction,
      code: err?.code,
    });
    if (err?.code === 'unauthorized') {
      // token revoked/expired → force re-auth on next popup open
      const g = await store.getGithub();
      if (g) await store.setGithub({ ...g, invalid: true });
    }
    throw err;
  }
}

function describeWhat(granularity) {
  return granularity === 'py' ? 'script' : granularity === 'outputs' ? 'outputs' : 'notebook';
}

/**
 * Auto-Push after a cell run. Quiet: never resolves conflicts or commits detected secrets.
 * Colab writes the notebook back to Drive a few seconds after a run; if Drive hasn't changed yet
 * we come back every 30 s (alarm, survives service-worker suspension) up to CELL_MAX_WAITS times.
 */
async function pushAfterCell(fileId) {
  clearTimeout(cellTimers.get(fileId));
  cellTimers.delete(fileId);
  await chrome.alarms.clear(CELL_ALARM_PREFIX + fileId).catch(() => {});
  const cfg = await store.getNotebook(fileId);
  if (!cfg?.autoPushOnCell) return { action: 'skipped', reason: 'disabled' };
  if (cfg.status?.state === 'conflict' || cfg.status?.state === 'secrets') return { action: 'skipped', reason: cfg.status.state };

  let r;
  try {
    r = await syncNotebook(fileId, { trigger: 'cell' });
  } catch (e) {
    await store.setNotebook(fileId, { cellWait: null });
    return { action: 'error', error: e?.message ?? String(e) };
  }

  if (r.action === 'none' && r.reason === 'not_saved_yet') {
    const attempts = (cfg.cellWait?.attempts ?? 0) + 1;
    if (attempts <= CELL_MAX_WAITS) {
      await store.setNotebook(fileId, { cellWait: { attempts } });
      await chrome.alarms.create(CELL_ALARM_PREFIX + fileId, { delayInMinutes: 0.5 });
      return { action: 'waiting', attempts };
    }
    await store.setNotebook(fileId, {
      cellWait: null,
      status: { state: 'pending', message: 'Cell ran — Colab has not saved the notebook to Drive yet; will push on the next change', trigger: 'cell', pushed: false, at: Date.now() },
    });
    return { action: 'none', reason: 'not_saved_yet', gaveUp: true };
  }
  if (cfg.cellWait) await store.setNotebook(fileId, { cellWait: null });
  return r;
}

async function runAutoSync(trigger) {
  const [github, notebooks] = await Promise.all([store.getGithub(), store.getNotebooks()]);
  if (!github?.token) return;
  for (const cfg of Object.values(notebooks)) {
    if (!cfg.autoSync) continue;
    if (cfg.status?.state === 'conflict' || cfg.status?.state === 'secrets') continue; // needs a human
    try {
      const meta = await getFileMeta(cfg.fileId, { interactive: false });
      if (cfg.lastSeenDriveModifiedTime && meta.modifiedTime === cfg.lastSeenDriveModifiedTime && cfg.status?.state === 'synced') continue;
      await syncNotebook(cfg.fileId, { trigger });
    } catch (e) {
      // status already recorded by doSync; metadata failures land here
      if (!inflight.has(cfg.fileId)) {
        await store.setNotebookStatus(cfg.fileId, {
          state: 'error',
          message: e?.needsInteraction ? 'Google Drive access needed — open ColabHub to continue' : e?.message ?? String(e),
          needsInteraction: Boolean(e?.needsInteraction),
        });
      }
    }
  }
}

/** Tell every open Colab tab for this notebook what just happened (content script shows a toast). */
async function notifyTabs(fileId) {
  const cfg = await store.getNotebook(fileId);
  if (!cfg?.status) return;
  const tabs = await chrome.tabs.query({ url: `https://colab.research.google.com/drive/${fileId}*` });
  await Promise.all(
    tabs.map((t) =>
      chrome.tabs.sendMessage(t.id, { type: 'syncStatus', status: cfg.status, meta: { commitUrl: cfg.lastCommitUrl ?? null, branch: cfg.branch, path: cfg.path } }).catch(() => {}),
    ),
  );
}

// --------------------------------------------------------------------- badge

const BADGE = {
  synced: { text: '✓', color: '#1a7f37' },
  syncing: { text: '…', color: '#0969da' },
  pending: { text: '•', color: '#bf8700' },
  conflict: { text: '!', color: '#cf222e' },
  secrets: { text: '!', color: '#cf222e' },
  error: { text: '!', color: '#cf222e' },
  idle: { text: '', color: '#6e7781' },
};

async function refreshBadge(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const fileId = tab.url ? driveIdFromColabUrl(tab.url) : null;
  const cfg = fileId ? await store.getNotebook(fileId) : null;
  const b = BADGE[cfg?.status?.state ?? 'idle'] ?? BADGE.idle;
  await chrome.action.setBadgeText({ tabId, text: cfg ? b.text : '' });
  if (cfg) await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
  // tooltip doubles as a status line: "ColabHub — Pushed notebook to main after cell run"
  const line = cfg?.status?.message ? `ColabHub — ${cfg.status.message}` : cfg ? `ColabHub — ${cfg.repoFullName}` : 'ColabHub';
  await chrome.action.setTitle({ tabId, title: line }).catch(() => {});
}

async function refreshActiveBadges() {
  const tabs = await chrome.tabs.query({ url: 'https://colab.research.google.com/*' });
  await Promise.all(tabs.map((t) => refreshBadge(t.id)));
}
