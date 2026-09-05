// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { gitBlobSha, sha256Hex, utf8Encode, bytesToBase64, base64ToBytes } from '../extension/lib/hash.js';
import {
  driveIdFromColabUrl,
  stripOutputs,
  scanForSecrets,
  sanitizeFilename,
  normalizeRepoPath,
  defaultNotebookPath,
  validateRepoName,
  suggestRepoName,
  serializeNotebook,
} from '../extension/lib/notebook.js';
import { ghFetch, GitHubError, createRepo, getFile, encodePath } from '../extension/lib/github.js';
import { prepareNotebook, planSync, executeSync, defaultCommitMessage } from '../extension/lib/syncEngine.js';
import { notebookToScript, notebookToOutputs, pathForGranularity, describePush, filterRepos, GRANULARITIES } from '../extension/lib/granularity.js';

const sampleNb = {
  nbformat: 4,
  nbformat_minor: 0,
  metadata: { colab: { name: 'My Analysis.ipynb' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Hello'] },
    {
      cell_type: 'code',
      metadata: { executionInfo: { elapsed: 12 }, outputId: 'abc' },
      execution_count: 3,
      source: ['print("hi")'],
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }],
    },
  ],
};

// ---------------------------------------------------------------- hash.js
test('gitBlobSha matches git hash-object', async () => {
  const content = 'hello world\n';
  const bytes = utf8Encode(content);
  // Known value: `echo "hello world" | git hash-object --stdin`
  assert.equal(await gitBlobSha(bytes), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
  // And matches Node's crypto computing the same thing
  const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(content).digest('hex');
  assert.equal(await gitBlobSha(bytes), expected);
});

test('sha256Hex matches node crypto', async () => {
  const bytes = utf8Encode('colabsync');
  assert.equal(await sha256Hex(bytes), createHash('sha256').update('colabsync').digest('hex'));
});

test('base64 round-trips binary including unicode', () => {
  const bytes = utf8Encode('héllo — 日本語 🚀');
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  // GitHub returns base64 with embedded newlines
  assert.deepEqual(base64ToBytes('aGVs\nbG8=\n'), utf8Encode('hello'));
});

// ------------------------------------------------------------ notebook.js
test('driveIdFromColabUrl', () => {
  assert.equal(driveIdFromColabUrl('https://colab.research.google.com/drive/1AbC_dEf-GhIjKlMnOp?usp=sharing'), '1AbC_dEf-GhIjKlMnOp');
  assert.equal(driveIdFromColabUrl('https://colab.research.google.com/drive/1AbC_dEf-GhIjKlMnOp#scrollTo=x'), '1AbC_dEf-GhIjKlMnOp');
  assert.equal(driveIdFromColabUrl('https://colab.research.google.com/github/user/repo/blob/main/nb.ipynb'), null);
  assert.equal(driveIdFromColabUrl('https://colab.research.google.com/'), null);
  assert.equal(driveIdFromColabUrl('https://evil.com/drive/1AbC_dEf-GhIjKlMnOp'), null);
  assert.equal(driveIdFromColabUrl('not a url'), null);
});

test('stripOutputs clears outputs and Colab execution metadata without mutating input', () => {
  const stripped = stripOutputs(sampleNb);
  assert.deepEqual(stripped.cells[1].outputs, []);
  assert.equal(stripped.cells[1].execution_count, null);
  assert.equal(stripped.cells[1].metadata.executionInfo, undefined);
  assert.equal(stripped.cells[1].metadata.outputId, undefined);
  // original untouched
  assert.equal(sampleNb.cells[1].execution_count, 3);
  assert.equal(sampleNb.cells[1].outputs.length, 1);
});

test('serializeNotebook is deterministic and ends with newline', () => {
  const a = serializeNotebook(sampleNb);
  const b = serializeNotebook(JSON.parse(JSON.stringify(sampleNb)));
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
});

test('scanForSecrets finds tokens in source and outputs, reports no secret text', () => {
  const nb = {
    cells: [
      { cell_type: 'code', source: ['token = "ghp_' + 'a'.repeat(36) + '"'], outputs: [] },
      { cell_type: 'code', source: ['print(key)'], outputs: [{ output_type: 'stream', text: ['AKIA' + 'B'.repeat(16)] }] },
      { cell_type: 'code', source: ['password = "hunter2hunter2"'], outputs: [] },
      { cell_type: 'code', source: ['password = "your_password_here"'], outputs: [] }, // placeholder → ignored
      { cell_type: 'markdown', source: ['nothing here'] },
    ],
  };
  const f = scanForSecrets(nb);
  const kinds = f.map((x) => `${x.cell}:${x.where}:${x.kind}`);
  assert.ok(kinds.includes('1:source:GitHub token'), kinds.join(','));
  assert.ok(kinds.includes('2:output:AWS access key id'));
  assert.ok(kinds.includes('3:source:Hard-coded credential assignment'));
  assert.ok(!kinds.some((k) => k.startsWith('4:')));
  assert.ok(!kinds.some((k) => k.startsWith('5:')));
  assert.ok(!JSON.stringify(f).includes('hunter2'), 'findings must not leak secret values');
});

test('scanForSecrets is quiet on a clean notebook', () => {
  assert.deepEqual(scanForSecrets(sampleNb), []);
});

test('filename / path helpers', () => {
  assert.equal(sanitizeFilename('My Analysis (v2).ipynb'), 'My_Analysis_(v2).ipynb');
  assert.equal(sanitizeFilename('  weird:/name?.ipynb '), 'weird_name.ipynb');
  assert.equal(sanitizeFilename('Untitled0'), 'Untitled0.ipynb');
  assert.equal(sanitizeFilename(''), 'notebook.ipynb');
  assert.equal(normalizeRepoPath('/notebooks//2025/../x/'), 'notebooks/2025/x');
  assert.equal(defaultNotebookPath('notebooks', 'My Analysis.ipynb'), 'notebooks/My_Analysis.ipynb');
  assert.equal(defaultNotebookPath('', 'My Analysis.ipynb'), 'My_Analysis.ipynb');
  assert.equal(encodePath('notebooks/My Analysis#1.ipynb'), 'notebooks/My%20Analysis%231.ipynb');
});

test('validateRepoName / suggestRepoName', () => {
  assert.equal(validateRepoName('ML-Projects'), null);
  assert.equal(validateRepoName('my.repo_1'), null);
  assert.ok(validateRepoName(''));
  assert.ok(validateRepoName('has space'));
  assert.ok(validateRepoName('..'));
  assert.ok(validateRepoName('x'.repeat(101)));
  assert.equal(suggestRepoName('My Analysis.ipynb'), 'my-analysis');
  assert.equal(suggestRepoName('!!!'), 'colab-project');
});

// -------------------------------------------------------------- github.js
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const h = handlers.find((h) => (h.method ?? 'GET') === (init.method ?? 'GET') && h.match.test(url));
    if (!h) throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    const body = typeof h.body === 'function' ? h.body(init) : h.body;
    return {
      ok: h.status >= 200 && h.status < 300,
      status: h.status,
      statusText: 'x',
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
  };
  impl.calls = calls;
  return impl;
}

test('ghFetch sets auth headers and maps error statuses', async () => {
  const f = fakeFetch([
    { match: /\/user$/, status: 200, body: { login: 'octo' } },
    { match: /\/repos\/a\/b$/, status: 404, body: { message: 'Not Found' } },
    { match: /\/repos\/a\/c$/, status: 409, body: { message: 'sha mismatch' } },
    { match: /\/repos\/a\/d$/, status: 422, body: { message: 'Validation Failed', errors: [{ message: 'name already exists on this account' }] } },
    { match: /\/repos\/a\/e$/, status: 403, body: { message: 'API rate limit exceeded' } },
  ]);
  const u = await ghFetch('tok', '/user', { fetchImpl: f });
  assert.equal(u.login, 'octo');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(f.calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');

  await assert.rejects(ghFetch('tok', '/repos/a/b', { fetchImpl: f }), (e) => e instanceof GitHubError && e.code === 'not_found');
  await assert.rejects(ghFetch('tok', '/repos/a/c', { fetchImpl: f }), (e) => e.code === 'conflict' && e.status === 409);
  await assert.rejects(ghFetch('tok', '/repos/a/d', { fetchImpl: f }), (e) => e.code === 'validation' && /already exists/.test(e.message));
  await assert.rejects(ghFetch('tok', '/repos/a/e', { fetchImpl: f }), (e) => e.code === 'rate_limited');
});

test('createRepo targets /user/repos for self and /orgs/:org/repos for orgs; README+gitignore → auto_init', async () => {
  const f = fakeFetch([
    { method: 'POST', match: /\/user\/repos$/, status: 201, body: (init) => ({ ...JSON.parse(init.body), full_name: 'me/x', owner: { login: 'me' }, default_branch: 'main' }) },
    { method: 'POST', match: /\/orgs\/acme\/repos$/, status: 201, body: (init) => ({ ...JSON.parse(init.body), full_name: 'acme/x', owner: { login: 'acme' }, default_branch: 'main' }) },
  ]);
  const r1 = await createRepo('t', { owner: 'me', viewerLogin: 'me', name: 'x', addReadme: true, gitignoreTemplate: 'Python' }, { fetchImpl: f });
  assert.equal(r1.fullName, 'me/x');
  const sent1 = JSON.parse(f.calls[0].init.body);
  assert.equal(sent1.private, true);
  assert.equal(sent1.auto_init, true);
  assert.equal(sent1.gitignore_template, 'Python');

  await createRepo('t', { owner: 'acme', viewerLogin: 'me', name: 'x', isPrivate: false, addReadme: false }, { fetchImpl: f });
  assert.match(f.calls[1].url, /\/orgs\/acme\/repos$/);
  const sent2 = JSON.parse(f.calls[1].init.body);
  assert.equal(sent2.private, false);
  assert.equal(sent2.auto_init, false);
  assert.equal('gitignore_template' in sent2, false);
});

test('getFile returns null on 404 and decodes metadata on 200', async () => {
  const f = fakeFetch([
    { match: /contents\/notebooks\/a\.ipynb\?ref=main$/, status: 200, body: { sha: 'abc', size: 10, content: 'e30=\n', html_url: 'u' } },
    { match: /contents\/missing\.ipynb/, status: 404, body: { message: 'Not Found' } },
  ]);
  const a = await getFile('t', 'o', 'r', 'notebooks/a.ipynb', 'main', { fetchImpl: f });
  assert.equal(a.sha, 'abc');
  assert.equal(await getFile('t', 'o', 'r', 'missing.ipynb', 'main', { fetchImpl: f }), null);
});

// ---------------------------------------------------------- syncEngine.js
test('prepareNotebook: blobSha equals git blob sha of the serialised bytes; strip option respected', async () => {
  const raw = JSON.stringify(sampleNb);
  const p = await prepareNotebook(raw, { stripOutputs: false });
  const expected = createHash('sha1').update(`blob ${p.bytes.length}\0`).update(Buffer.from(p.bytes)).digest('hex');
  assert.equal(p.blobSha, expected);
  assert.equal(p.cellCount, 2);
  assert.ok(p.text.includes('"hi\\n"'));

  const s = await prepareNotebook(raw, { stripOutputs: true });
  assert.ok(!s.text.includes('"hi\\n"'));
  assert.notEqual(s.blobSha, p.blobSha);
  await assert.rejects(prepareNotebook('{"nope":1}'), /Jupyter notebook/);
  await assert.rejects(prepareNotebook('not json'), /valid JSON/);
});

test('planSync decision table', () => {
  const L = 'local';
  // first push, file missing
  assert.equal(planSync({ localBlobSha: L, remote: null, lastSyncedRemoteSha: null }).action, 'create');
  // remote identical → nothing to do (even if we never synced before)
  assert.equal(planSync({ localBlobSha: L, remote: { sha: L }, lastSyncedRemoteSha: null }).action, 'none');
  // normal update: remote is exactly what we last pushed
  const upd = planSync({ localBlobSha: L, remote: { sha: 'r1' }, lastSyncedRemoteSha: 'r1' });
  assert.equal(upd.action, 'update');
  assert.equal(upd.sha, 'r1');
  // remote changed by someone else since our last push
  const c = planSync({ localBlobSha: L, remote: { sha: 'r2' }, lastSyncedRemoteSha: 'r1' });
  assert.equal(c.action, 'conflict');
  assert.equal(c.reason, 'remote_changed');
  // file exists but we've never synced this notebook here (e.g. connecting to an existing repo)
  const e = planSync({ localBlobSha: L, remote: { sha: 'r2' }, lastSyncedRemoteSha: null });
  assert.equal(e.action, 'conflict');
  assert.equal(e.reason, 'remote_exists');
  // force overrides both conflict cases and carries the current sha for the PUT
  const forced = planSync({ localBlobSha: L, remote: { sha: 'r2' }, lastSyncedRemoteSha: 'r1', force: true });
  assert.equal(forced.action, 'update');
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.sha, 'r2');
});

test('executeSync pushes with sha for update, without for create, and maps 409 to conflict', async () => {
  const f = fakeFetch([
    {
      method: 'PUT',
      match: /contents\/ok\.ipynb$/,
      status: 200,
      body: { content: { sha: 'newsha', html_url: 'f' }, commit: { sha: 'c1', html_url: 'c' } },
    },
    { method: 'PUT', match: /contents\/raced\.ipynb$/, status: 409, body: { message: 'is at abc but expected def' } },
  ]);
  const bytes = utf8Encode('{}');
  const r = await executeSync(
    { token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'ok.ipynb', bytes, plan: { action: 'update', sha: 'old' }, message: 'm' },
    { fetchImpl: f },
  );
  assert.equal(r.status, 'pushed');
  assert.equal(r.contentSha, 'newsha');
  assert.equal(JSON.parse(f.calls[0].init.body).sha, 'old');
  assert.equal(JSON.parse(f.calls[0].init.body).branch, 'main');

  await executeSync(
    { token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'ok.ipynb', bytes, plan: { action: 'create' }, message: 'm' },
    { fetchImpl: f },
  );
  assert.equal('sha' in JSON.parse(f.calls[1].init.body), false);

  const c = await executeSync(
    { token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'raced.ipynb', bytes, plan: { action: 'update', sha: 'def' }, message: 'm' },
    { fetchImpl: f },
  );
  assert.equal(c.status, 'conflict');

  await assert.rejects(
    executeSync({ token: 't', owner: 'o', repo: 'r', branch: 'main', path: 'x', bytes, plan: { action: 'conflict' }, message: 'm' }, { fetchImpl: f }),
    /non-writable/,
  );
});

test('defaultCommitMessage', () => {
  assert.equal(defaultCommitMessage({ action: 'create', title: 'My Analysis.ipynb' }), 'Add My Analysis.ipynb via ColabHub');
  assert.equal(defaultCommitMessage({ action: 'update', path: 'n/x.ipynb' }), 'Update n/x.ipynb via ColabHub');
  assert.equal(defaultCommitMessage({ action: 'update', title: 'A', trigger: 'cell', granularity: 'py' }), 'Update A (script) after cell run via ColabHub');
  assert.equal(defaultCommitMessage({ action: 'update', title: 'A', trigger: 'interval', granularity: 'outputs' }), 'Update A (outputs) (auto sync) via ColabHub');
});

// ---------------------------------------------------------- granularity.js
const richNb = {
  nbformat: 4,
  nbformat_minor: 0,
  metadata: {},
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Title\n', '\n', 'Some *text*'] },
    { cell_type: 'code', metadata: { id: 'abc1' }, execution_count: 1, source: ['!pip install foo\n', '%matplotlib inline\n', 'import foo\n', 'x = 1\n'], outputs: [] },
    {
      cell_type: 'code',
      metadata: { id: 'abc2', executionInfo: { elapsed: 42, timestamp: 1756900000000 } },
      execution_count: 2,
      source: ['print(x)\n', '1 / 0'],
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['1\n'] },
        { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'] },
      ],
    },
    { cell_type: 'code', metadata: {}, execution_count: null, source: ['never_ran()'], outputs: [] },
    { cell_type: 'raw', metadata: {}, source: ['raw stuff'] },
  ],
};

test('notebookToScript: percent-format .py with magics commented out and markdown preserved', () => {
  const py = notebookToScript(richNb, { title: 'Demo.ipynb' });
  assert.match(py, /^# -\*- coding: utf-8 -\*-\n"""Demo\.ipynb/);
  assert.match(py, /# %% \[markdown\]\n# # Title\n#\n# Some \*text\*/);
  assert.match(py, /# %% id="abc1"\n# \[colab\] !pip install foo\n# \[colab\] %matplotlib inline\nimport foo\nx = 1/);
  assert.match(py, /# %% id="abc2"\nprint\(x\)\n1 \/ 0/);
  assert.match(py, /# %% \[raw\]\n# raw stuff/);
  assert.doesNotMatch(py, /outputs|ZeroDivisionError/, 'script never contains outputs');
  assert.ok(py.endsWith('\n'));
  assert.equal(notebookToScript(richNb, { title: 'Demo.ipynb' }), py, 'deterministic');
});

test('notebookToOutputs: outputs + execution log, no source, ANSI stripped', () => {
  const doc = JSON.parse(notebookToOutputs(richNb, { title: 'Demo.ipynb', trigger: 'cell', executedAt: 0 }));
  assert.equal(doc.format, 'colabhub-outputs/1');
  assert.equal(doc.trigger, 'cell');
  assert.deepEqual(doc.summary, { code_cells: 3, executed: 2, errors: 1 });
  assert.equal(doc.cells.length, 3);
  assert.equal(doc.cells[0].status, 'ok');
  assert.equal(doc.cells[1].status, 'error');
  assert.equal(doc.cells[1].elapsed_ms, 42);
  assert.equal(doc.cells[1].executed_at, new Date(1756900000000).toISOString());
  assert.equal(doc.cells[1].outputs[1].traceback[0], 'ZeroDivisionError: division by zero');
  assert.equal(doc.cells[2].status, 'not_run');
  assert.equal(doc.log.length, 2);
  assert.match(doc.log[1], /^\[2\] ERROR cell 2 \(42 ms\): print\(x\) → ZeroDivisionError: division by zero$/);
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /import foo|x = 1|1 \/ 0/, 'source is not included (only a first-line preview)');
  assert.match(text, /"preview":"print\(x\)"/);
});

test('prepareNotebook honours granularity', async () => {
  const raw = JSON.stringify(richNb);
  const py = await prepareNotebook(raw, { granularity: 'py' });
  assert.match(py.text, /^# -\*- coding/);
  const outs = await prepareNotebook(raw, { granularity: 'outputs', stripOutputs: true });
  assert.equal(JSON.parse(outs.text).summary.executed, 2, 'outputs mode ignores stripOutputs');
  const nb = await prepareNotebook(raw);
  assert.equal(nb.granularity, 'ipynb');
  assert.match(nb.text, /"cell_type"/);
});

test('pathForGranularity + describePush', () => {
  assert.equal(pathForGranularity('notebooks/My Analysis.ipynb', 'py'), 'notebooks/My Analysis.py');
  assert.equal(pathForGranularity('notebooks/My Analysis.py', 'outputs'), 'notebooks/My Analysis.outputs.json');
  assert.equal(pathForGranularity('notebooks/My Analysis.outputs.json', 'ipynb'), 'notebooks/My Analysis.ipynb');
  assert.equal(pathForGranularity('notebooks/data.v2', 'ipynb'), 'notebooks/data.v2.ipynb');
  assert.equal(pathForGranularity('x.ipynb', 'nope'), 'x.ipynb');
  assert.deepEqual(Object.keys(GRANULARITIES), ['ipynb', 'py', 'outputs']);
  assert.equal(describePush({ branch: 'main', trigger: 'cell' }), 'Pushed notebook to main after cell run');
  assert.equal(describePush({ branch: 'dev', granularity: 'py', trigger: 'manual', kind: 'create' }), 'Added .py to dev (manual)');
  assert.equal(describePush({ branch: 'main', granularity: 'outputs', trigger: 'interval' }), 'Pushed outputs to main (auto sync)');
  assert.equal(describePush({ branch: 'main', trigger: 'save' }), 'Pushed notebook to main after save');
});

test('filterRepos: multi-term search, owner: filter, name-prefix ranking', () => {
  const repos = [
    { owner: 'alice', name: 'ml-projects', description: 'Machine learning experiments' },
    { owner: 'alice', name: 'dotfiles', description: '' },
    { owner: 'acme', name: 'projects-ml', description: 'company notebooks' },
    { owner: 'alice', name: 'notes', description: 'ML reading notes' },
  ];
  assert.equal(filterRepos(repos, '').length, 4);
  assert.deepEqual(filterRepos(repos, 'ml').map((r) => r.name), ['ml-projects', 'projects-ml', 'notes']);
  assert.deepEqual(filterRepos(repos, 'ml owner:acme').map((r) => r.name), ['projects-ml']);
  assert.deepEqual(filterRepos(repos, 'alice/dot').map((r) => r.name), ['dotfiles']);
  assert.deepEqual(filterRepos(repos, 'machine experiments').map((r) => r.name), ['ml-projects']);
  assert.deepEqual(filterRepos(repos, 'zzz'), []);
  assert.equal(filterRepos(repos, 'ml', { limit: 1 }).length, 1);
});

