// lib/granularity.js — what exactly gets committed. Pure functions, no Chrome APIs.
//
//   'ipynb'    the whole notebook file                          notebooks/Name.ipynb
//   'py'       code cells exported as a runnable .py script      notebooks/Name.py
//   'outputs'  cell outputs + an execution log, no source        notebooks/Name.outputs.json
//
// The .py export follows the "percent" cell format (# %%) that VS Code, Spyder, PyCharm and
// jupytext all understand, so the script round-trips back into cells. Colab magics (%pip, !ls)
// are not valid Python; they're kept as comments so the script still runs.

export const GRANULARITIES = Object.freeze({
  ipynb: { label: 'Whole notebook (.ipynb)', ext: '.ipynb', hint: 'Exact copy of the notebook — source, outputs and metadata.' },
  py: { label: 'Python script (.py)', ext: '.py', hint: 'Only the code cells, as a clean script (# %% cell markers). Best for diffs and code review.' },
  outputs: { label: 'Cell outputs + log (.outputs.json)', ext: '.outputs.json', hint: 'What each cell printed/plotted plus an execution log — a lab notebook of results, without source.' },
});

export function isGranularity(g) {
  return Object.prototype.hasOwnProperty.call(GRANULARITIES, g);
}

/** Swap the extension of a repo path to the one this granularity uses. */
export function pathForGranularity(path, granularity) {
  const g = isGranularity(granularity) ? granularity : 'ipynb';
  const stripped = String(path ?? '').replace(/\.outputs\.json$/i, '').replace(/\.(ipynb|py|json)$/i, '');
  return stripped + GRANULARITIES[g].ext;
}

function cellSource(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
}

/**
 * Notebook → Python script (percent format).
 * @param {object} nb parsed notebook
 * @param {{title?: string}} opts
 */
export function notebookToScript(nb, { title = '' } = {}) {
  const out = [];
  out.push('# -*- coding: utf-8 -*-');
  if (title) out.push(`"""${title.replace(/"""/g, '\\"\\"\\"')}\n\nExported from Google Colab by ColabHub.\n"""`);
  else out.push('"""Exported from Google Colab by ColabHub."""');

  for (const cell of nb.cells ?? []) {
    const src = cellSource(cell).replace(/\s+$/, '');
    if (cell.cell_type === 'markdown') {
      out.push('', '# %% [markdown]');
      for (const line of src.split('\n')) out.push(line.trim() ? `# ${line}` : '#');
    } else if (cell.cell_type === 'code') {
      const id = cell.metadata?.id ? ` id="${cell.metadata.id}"` : '';
      out.push('', `# %%${id}`);
      for (const line of src.split('\n')) {
        // shell escapes and line magics aren't Python; keep them visible but inert
        out.push(/^\s*[!%]/.test(line) ? `# [colab] ${line}` : line);
      }
    } else if (cell.cell_type === 'raw') {
      out.push('', '# %% [raw]');
      for (const line of src.split('\n')) out.push(`# ${line}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function textOf(x) {
  return Array.isArray(x) ? x.join('') : String(x ?? '');
}

/** Flatten one nbformat output into a compact, git-friendly record. */
function summariseOutput(o) {
  switch (o.output_type) {
    case 'stream':
      return { type: 'stream', name: o.name, text: textOf(o.text) };
    case 'error':
      return { type: 'error', ename: o.ename, evalue: o.evalue, traceback: (o.traceback ?? []).map(stripAnsi) };
    case 'execute_result':
    case 'display_data': {
      const d = o.data ?? {};
      const rec = { type: o.output_type };
      if (d['text/plain']) rec.text = textOf(d['text/plain']);
      if (d['text/html']) rec.html = textOf(d['text/html']);
      const img = Object.keys(d).find((k) => k.startsWith('image/'));
      if (img) rec.image = { mime: img, bytes: Math.round((textOf(d[img]).length * 3) / 4), base64: textOf(d[img]) };
      if (o.execution_count != null) rec.execution_count = o.execution_count;
      return rec;
    }
    default:
      return { type: o.output_type ?? 'unknown' };
  }
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Notebook → outputs + execution log. Source code is *not* included, only a short preview
 * of each cell's first line so the log is readable.
 * @param {object} nb
 * @param {{title?: string, trigger?: string, executedAt?: number}} opts
 */
export function notebookToOutputs(nb, { title = '', trigger = 'manual', executedAt = Date.now() } = {}) {
  const cells = [];
  const log = [];
  let i = 0;
  for (const cell of nb.cells ?? []) {
    if (cell.cell_type !== 'code') {
      i++;
      continue;
    }
    const firstLine = cellSource(cell).split('\n').find((l) => l.trim()) ?? '';
    const outputs = (cell.outputs ?? []).map(summariseOutput);
    const errors = outputs.filter((o) => o.type === 'error');
    const info = cell.metadata?.executionInfo ?? {};
    const rec = {
      index: i,
      id: cell.metadata?.id ?? null,
      execution_count: cell.execution_count ?? null,
      preview: firstLine.slice(0, 120),
      status: errors.length ? 'error' : outputs.length ? 'ok' : cell.execution_count != null ? 'ok' : 'not_run',
      outputs,
    };
    if (info.timestamp) rec.executed_at = new Date(Number(info.timestamp)).toISOString();
    if (info.elapsed != null) rec.elapsed_ms = Number(info.elapsed);
    cells.push(rec);
    if (rec.status !== 'not_run') {
      log.push(
        `[${rec.execution_count ?? '-'}] ${rec.status.toUpperCase().padEnd(5)} cell ${i}${rec.elapsed_ms != null ? ` (${rec.elapsed_ms} ms)` : ''}: ${rec.preview}` +
          (errors.length ? ` → ${errors[0].ename}: ${errors[0].evalue}` : ''),
      );
    }
    i++;
  }
  const doc = {
    format: 'colabhub-outputs/1',
    notebook: title,
    generated_at: new Date(executedAt).toISOString(),
    trigger,
    summary: {
      code_cells: cells.length,
      executed: cells.filter((c) => c.status !== 'not_run').length,
      errors: cells.filter((c) => c.status === 'error').length,
    },
    log,
    cells,
  };
  return JSON.stringify(doc, null, 1) + '\n';
}

/**
 * Human-readable status line for the badge/toast, e.g.
 *   "Pushed to main after cell run" · "Pushed .py to dev (manual)"
 */
export function describePush({ branch, granularity = 'ipynb', trigger = 'manual', kind = 'update' }) {
  const what = granularity === 'py' ? '.py' : granularity === 'outputs' ? 'outputs' : 'notebook';
  const why =
    trigger === 'cell'
      ? 'after cell run'
      : trigger === 'save'
        ? 'after save'
        : trigger === 'interval' || trigger === 'alarm'
          ? '(auto sync)'
          : trigger === 'initial'
            ? '(first sync)'
            : '(manual)';
  const verb = kind === 'create' ? 'Added' : 'Pushed';
  return `${verb} ${what} to ${branch} ${why}`.replace(/\s+/g, ' ').trim();
}

// --- repo search --------------------------------------------------------------

/**
 * Client-side fuzzy-ish filter for the "Connect existing repo" search box.
 * Every whitespace-separated term must appear in `owner/name` or the description.
 * `owner:foo` restricts to that owner. Results keep the input order (most-recently pushed first)
 * but repos whose *name* starts with the query float to the top.
 */
export function filterRepos(repos, query, { limit = 50 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return repos.slice(0, limit);
  const terms = q.split(/\s+/);
  const ownerTerm = terms.find((t) => t.startsWith('owner:'))?.slice(6);
  const words = terms.filter((t) => !t.startsWith('owner:'));
  const scored = [];
  for (const r of repos) {
    const owner = (r.owner ?? '').toLowerCase();
    const name = (r.name ?? '').toLowerCase();
    if (ownerTerm && owner !== ownerTerm) continue;
    const hay = `${owner}/${name} ${(r.description ?? '').toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const score = words.some((w) => name.startsWith(w)) ? 0 : words.some((w) => name.includes(w)) ? 1 : 2;
    scored.push([score, r]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, limit).map(([, r]) => r);
}
