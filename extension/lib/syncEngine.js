// lib/syncEngine.js — the sync decision logic, independent of Chrome and of any UI.
//
//   prepareNotebook()  raw .ipynb text  ->  bytes to commit (+ secret findings)
//   planSync()         local bytes + remote state + last-sync memory  ->  {action}
//   executeSync()      performs the GitHub write for an 'update'/'create' plan
//
// Conflict model (single-file, last-writer-wins with a guard):
//   We remember the blob sha GitHub gave us after our last push (lastSyncedRemoteSha).
//   If the remote file's sha now differs from that, somebody else changed it → conflict,
//   and the user must explicitly choose "Overwrite" (force) or resolve manually on GitHub.
//   The PUT itself also carries the expected sha, so a race between plan and push
//   surfaces as a 409 from GitHub, which we map to the same 'conflict' outcome.

import { gitBlobSha, sha256Hex, utf8Encode, bytesToBase64 } from './hash.js';
import { parseNotebook, stripOutputs, serializeNotebook, scanForSecrets } from './notebook.js';
import { notebookToScript, notebookToOutputs } from './granularity.js';
import { putFile, GitHubError } from './github.js';

/**
 * @param {string} rawText            notebook JSON as downloaded from Drive
 * @param {{stripOutputs?: boolean, granularity?: 'ipynb'|'py'|'outputs', title?: string, trigger?: string}} opts
 */
export async function prepareNotebook(rawText, { stripOutputs: strip = false, granularity = 'ipynb', title = '', trigger = 'manual' } = {}) {
  const nb = parseNotebook(rawText);
  const finalNb = strip ? stripOutputs(nb) : nb;
  let text;
  if (granularity === 'py') text = notebookToScript(finalNb, { title });
  else if (granularity === 'outputs') text = notebookToOutputs(nb, { title, trigger, executedAt: 0 }); // outputs mode ignores "strip"; fixed timestamp keeps it deterministic
  else text = serializeNotebook(finalNb);
  const bytes = utf8Encode(text);
  const [blobSha, contentHash] = await Promise.all([gitBlobSha(bytes), sha256Hex(bytes)]);
  return {
    bytes,
    text,
    granularity,
    blobSha, // == GitHub's content sha for this exact byte sequence
    contentHash, // sha-256, stored locally for cheap "did anything change?" checks
    findings: scanForSecrets(granularity === 'outputs' ? nb : finalNb),
    cellCount: finalNb.cells.length,
  };
}

/**
 * Decide what to do.
 * @returns {{action:'none'|'create'|'update'|'conflict', reason?:string, sha?:string}}
 */
export function planSync({ localBlobSha, remote, lastSyncedRemoteSha, force = false }) {
  if (!remote) return { action: 'create', reason: 'remote_missing' };
  if (remote.sha === localBlobSha) return { action: 'none', reason: 'identical' };

  const remoteMoved = lastSyncedRemoteSha ? remote.sha !== lastSyncedRemoteSha : true;
  if (remoteMoved && !force) {
    return {
      action: 'conflict',
      reason: lastSyncedRemoteSha ? 'remote_changed' : 'remote_exists',
      sha: remote.sha,
    };
  }
  return { action: 'update', reason: force && remoteMoved ? 'forced' : 'fast_forward', sha: remote.sha };
}

/** Human-readable default commit message. */
export function defaultCommitMessage({ action, title, path, trigger = 'manual', granularity = 'ipynb' }) {
  const verb = action === 'create' ? 'Add' : 'Update';
  const what = granularity === 'py' ? `${title || path} (script)` : granularity === 'outputs' ? `${title || path} (outputs)` : title || path;
  const why = trigger === 'cell' ? ' after cell run' : trigger === 'save' || trigger === 'interval' ? ' (auto sync)' : '';
  return `${verb} ${what}${why} via ColabHub`;
}

/**
 * Perform the write for a 'create' or 'update' plan.
 * @returns {{status:'pushed'|'conflict', contentSha?:string, commitSha?:string, commitUrl?:string, fileUrl?:string}}
 */
export async function executeSync({ token, owner, repo, branch, path, bytes, plan, message }, o) {
  if (plan.action !== 'create' && plan.action !== 'update') {
    throw new Error(`executeSync called with non-writable plan: ${plan.action}`);
  }
  try {
    const r = await putFile(
      token,
      owner,
      repo,
      path,
      { contentBase64: bytesToBase64(bytes), message, branch, sha: plan.action === 'update' ? plan.sha : undefined },
      o,
    );
    return { status: 'pushed', ...r };
  } catch (e) {
    // 409 = sha mismatch (someone pushed between plan and execute); 422 "sha wasn't supplied"
    // = file appeared since we planned a create. Both are conflicts from the user's perspective.
    if (e instanceof GitHubError && (e.code === 'conflict' || (e.code === 'validation' && /sha/i.test(e.message)))) {
      return { status: 'conflict', reason: 'raced' };
    }
    throw e;
  }
}
