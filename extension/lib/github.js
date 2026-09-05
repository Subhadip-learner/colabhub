// lib/github.js — thin GitHub REST client. Pure functions over `fetch`, no Chrome APIs,
// so it's unit-testable in Node. All calls take the token explicitly.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, { status, code, response } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code; // e.g. 'conflict' | 'not_found' | 'unauthorized' | 'forbidden' | 'validation'
    this.response = response;
  }
}

function codeFor(status, body) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return /rate limit/i.test(body?.message ?? '') ? 'rate_limited' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  return 'http_error';
}

export async function ghFetch(token, path, { method = 'GET', body, headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(path.startsWith('http') ? path : API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  if (!res.ok) {
    const detail = json?.errors?.map((e) => e.message ?? e.code).filter(Boolean).join('; ');
    const msg = `${json?.message ?? res.statusText ?? 'GitHub request failed'}${detail ? ` (${detail})` : ''}`;
    throw new GitHubError(msg, { status: res.status, code: codeFor(res.status, json), response: json });
  }
  return json;
}

// --- Identity -----------------------------------------------------------------

export async function getViewer(token, o) {
  const u = await ghFetch(token, '/user', o);
  return { login: u.login, name: u.name, avatarUrl: u.avatar_url, htmlUrl: u.html_url };
}

/** Organisations the token can see (for the "Owner" dropdown). */
export async function listOrgs(token, o) {
  const orgs = await ghFetch(token, '/user/orgs?per_page=100', o);
  return orgs.map((x) => ({ login: x.login, avatarUrl: x.avatar_url }));
}

// --- Repositories -------------------------------------------------------------

/** Repos the user can push to, most recently pushed first. Pages until exhausted (cap 300). */
export async function listRepos(token, o) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await ghFetch(
      token,
      `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      o,
    );
    for (const r of batch) {
      if (r.permissions && !r.permissions.push) continue;
      if (r.archived) continue;
      out.push(repoSummary(r));
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function getRepo(token, owner, repo, o) {
  return repoSummary(await ghFetch(token, `/repos/${owner}/${repo}`, o));
}

/**
 * Create a repository under the user's account (owner === viewer login) or an organisation.
 * README + .gitignore both hang off `auto_init`; if the user wants .gitignore without README we
 * still auto_init (GitHub always writes a README then) — the caller can delete it afterwards
 * via deleteFile(), which is what syncEngine does.
 */
export async function createRepo(
  token,
  { owner, viewerLogin, name, description = '', isPrivate = true, addReadme = true, gitignoreTemplate = null },
  o,
) {
  const body = {
    name,
    description,
    private: isPrivate,
    auto_init: Boolean(addReadme || gitignoreTemplate),
    has_wiki: false,
  };
  if (gitignoreTemplate) body.gitignore_template = gitignoreTemplate;
  const path = owner && owner !== viewerLogin ? `/orgs/${owner}/repos` : '/user/repos';
  return repoSummary(await ghFetch(token, path, { ...o, method: 'POST', body }));
}

export async function listBranches(token, owner, repo, o) {
  const branches = await ghFetch(token, `/repos/${owner}/${repo}/branches?per_page=100`, o);
  return branches.map((b) => ({ name: b.name, sha: b.commit.sha }));
}

// --- Contents -----------------------------------------------------------------

/** Returns { sha, size, content(Uint8Array-able base64) } or null if the file doesn't exist. */
export async function getFile(token, owner, repo, path, ref, o) {
  try {
    const f = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, o);
    if (Array.isArray(f)) throw new GitHubError('Path is a directory', { status: 409, code: 'is_directory' });
    return { sha: f.sha, size: f.size, contentBase64: f.content ?? null, htmlUrl: f.html_url };
  } catch (e) {
    if (e instanceof GitHubError && e.code === 'not_found') return null;
    throw e;
  }
}

/**
 * Create or update a file. Pass `sha` (the current blob sha) when updating; omit when creating.
 * GitHub returns 409 when `sha` no longer matches HEAD — that's our conflict signal.
 */
export async function putFile(token, owner, repo, path, { contentBase64, message, branch, sha }, o) {
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  const r = await ghFetch(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, { ...o, method: 'PUT', body });
  return {
    contentSha: r.content?.sha ?? null,
    commitSha: r.commit?.sha ?? null,
    commitUrl: r.commit?.html_url ?? null,
    fileUrl: r.content?.html_url ?? null,
  };
}

export async function deleteFile(token, owner, repo, path, { message, branch, sha }, o) {
  return ghFetch(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    ...o,
    method: 'DELETE',
    body: { message, branch, sha },
  });
}

export async function listGitignoreTemplates(token, o) {
  return ghFetch(token, '/gitignore/templates', o);
}

// --- helpers ------------------------------------------------------------------

function repoSummary(r) {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    owner: r.owner?.login,
    private: r.private,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    description: r.description ?? '',
    pushedAt: r.pushed_at,
    permissions: r.permissions ?? null,
  };
}

export function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
