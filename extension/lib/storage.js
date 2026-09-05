// lib/storage.js — typed-ish wrapper around chrome.storage.local.
//
// Shape:
//   settings  : { defaultFolder, autoSyncDefault, autoSyncMinutes, stripOutputsDefault }
//   github    : null | { token, source: 'oauth'|'pat', viewer: {login,name,avatarUrl,htmlUrl}, connectedAt }
//   notebooks : { [driveFileId]: NotebookConfig }
//
// NotebookConfig:
//   { fileId, title, owner, repo, repoPrivate, repoUrl, branch, path,
//     autoSync, stripOutputs,
//     lastSyncedRemoteSha, lastSyncedContentHash, lastSyncedAt, lastCommitUrl, lastSeenDriveModifiedTime,
//     status: { state: 'idle'|'synced'|'pending'|'conflict'|'secrets'|'error', message?, at, findings? } }

export const DEFAULT_SETTINGS = Object.freeze({
  defaultFolder: 'notebooks',
  autoSyncDefault: true,
  autoSyncMinutes: 5,
  stripOutputsDefault: false,
  autoPushOnCellDefault: true, // Auto-Push after every cell run (per-notebook toggle, this is the default for new links)
  granularityDefault: 'ipynb', // 'ipynb' | 'py' | 'outputs'
});

async function read(keys) {
  return chrome.storage.local.get(keys);
}

export async function getSettings() {
  const { settings } = await read('settings');
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getGithub() {
  const { github } = await read('github');
  return github ?? null;
}

export async function setGithub(value) {
  if (value === null) await chrome.storage.local.remove('github');
  else await chrome.storage.local.set({ github: value });
}

export async function getNotebooks() {
  const { notebooks } = await read('notebooks');
  return Object.fromEntries(
    Object.entries(notebooks ?? {}).map(([fileId, notebook]) => [
      fileId,
      'autoPushOnCell' in notebook ? notebook : { ...notebook, autoPushOnCell: true },
    ]),
  );
}

export async function getNotebook(fileId) {
  const all = await getNotebooks();
  return all[fileId] ?? null;
}

export async function setNotebook(fileId, patch) {
  const all = await getNotebooks();
  const next = { ...(all[fileId] ?? { fileId }), ...patch };
  all[fileId] = next;
  await chrome.storage.local.set({ notebooks: all });
  return next;
}

export async function removeNotebook(fileId) {
  const all = await getNotebooks();
  delete all[fileId];
  await chrome.storage.local.set({ notebooks: all });
}

export async function setNotebookStatus(fileId, status) {
  return setNotebook(fileId, { status: { ...status, at: Date.now() } });
}

export async function clearAll() {
  await chrome.storage.local.clear();
}
