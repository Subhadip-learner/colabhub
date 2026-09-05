// lib/notebook.js — pure helpers for .ipynb content: normalisation, output stripping,
// secret scanning, filename/path sanitising, and Colab URL parsing.

/**
 * Parse a Colab URL and return the Drive file id, or null for non-Drive notebooks
 * (e.g. notebooks opened directly from GitHub or the built-in tutorials).
 *   https://colab.research.google.com/drive/1AbC_dEf?usp=sharing  -> 1AbC_dEf
 */
export function driveIdFromColabUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('colab.research.google.com')) return null;
    const m = u.pathname.match(/^\/drive\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Parse notebook JSON, throwing a friendly error for non-notebooks. */
export function parseNotebook(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    throw new Error('Notebook is not valid JSON');
  }
  if (!nb || !Array.isArray(nb.cells)) throw new Error('File does not look like a Jupyter notebook');
  return nb;
}

/**
 * Remove code-cell outputs and execution counts (the nbstripout convention).
 * Returns a *new* notebook object; the input is not mutated.
 */
export function stripOutputs(nb) {
  const clone = JSON.parse(JSON.stringify(nb));
  for (const cell of clone.cells) {
    if (cell.cell_type === 'code') {
      cell.outputs = [];
      cell.execution_count = null;
    }
    if (cell.metadata) {
      delete cell.metadata.executionInfo;
      delete cell.metadata.outputId;
      delete cell.metadata.execution;
    }
  }
  return clone;
}

/**
 * Deterministic serialisation: 1-space indent + trailing newline is what Jupyter/Colab
 * themselves write, so diffs on GitHub stay minimal and repeated syncs are byte-identical.
 */
export function serializeNotebook(nb) {
  return JSON.stringify(nb, null, 1) + '\n';
}

// ---------------------------------------------------------------------------
// Secret scanning (deliberately conservative: high-signal patterns only).
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: 'Stripe secret key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'Hard-coded credential assignment',
    // password = "..."  /  API_KEY: '...'  (value ≥ 8 chars, not an obvious placeholder)
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'](?!\s*(?:your|xxx|<|\.\.\.|changeme|placeholder|none|null))[^"'\s]{8,}["']/i,
  },
];

/**
 * Scan every cell (source + outputs) for likely secrets.
 * Returns [{ cell, kind, where }] — never the secret itself, so the report can be shown safely.
 */
export function scanForSecrets(nb) {
  const findings = [];
  nb.cells.forEach((cell, idx) => {
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    check(src, idx, 'source');
    for (const out of cell.outputs ?? []) {
      const text = [
        ...(Array.isArray(out.text) ? out.text : [out.text ?? '']),
        ...Object.values(out.data ?? {}).flatMap((v) => (Array.isArray(v) ? v : [String(v)])),
      ].join('');
      check(text, idx, 'output');
    }
  });
  return findings;

  function check(text, cellIndex, where) {
    if (!text) return;
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) findings.push({ cell: cellIndex + 1, kind: name, where });
    }
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Turn "My Analysis (v2).ipynb" into a safe, git-friendly filename. */
export function sanitizeFilename(name) {
  let base = String(name ?? '').trim().replace(/\.ipynb$/i, '');
  base = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  if (!base) base = 'notebook';
  return `${base}.ipynb`;
}

/** Normalise a user-supplied repo path: strip leading/trailing slashes, collapse '//' and '..'. */
export function normalizeRepoPath(path) {
  return String(path ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

/** Build the default in-repo path, e.g. notebooks/My_Analysis.ipynb */
export function defaultNotebookPath(folder, title) {
  const dir = normalizeRepoPath(folder);
  const file = sanitizeFilename(title);
  return dir ? `${dir}/${file}` : file;
}

/** GitHub's repository naming rules (a-z, 0-9, '-', '_', '.', max 100). */
export function validateRepoName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Repository name is required';
  if (n.length > 100) return 'Repository name must be 100 characters or fewer';
  if (!/^[A-Za-z0-9_.-]+$/.test(n)) return 'Only letters, numbers, "-", "_" and "." are allowed';
  if (/^\.+$/.test(n) || n === '.git') return 'That name is reserved';
  return null;
}

/** Suggest a repo name from a notebook title: "My Analysis.ipynb" -> "my-analysis" */
export function suggestRepoName(title) {
  const s = String(title ?? '')
    .replace(/\.ipynb$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'colab-project';
}
