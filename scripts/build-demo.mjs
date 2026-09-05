#!/usr/bin/env node
// scripts/build-demo.mjs — bundle the REAL extension code (popup + background + libs) into a
// single self-contained HTML page with a simulated Chrome runtime, GitHub API and Google Drive.
// Output: demo/colabhub-demo.html  — open it in any browser, no network needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = (p) => fs.readFileSync(path.join(root, 'extension', p), 'utf8');

// Module order = dependency order.
const MODULES = [
  // The demo plays a *published* build: Client ID + token-exchange backend URL baked in (users never
  // see setup). `?unconfigured` plays the unpacked-source case → publisher setup screen.
  { id: 'config', src: fs.readFileSync(path.join(root, 'tests', 'helpers', 'config.test.js'), 'utf8')
      .replace("GITHUB_CLIENT_ID: 'test-client-id'", "GITHUB_CLIENT_ID: location.search.includes('unconfigured') ? '' : 'test-client-id'")
      .replace("TOKEN_EXCHANGE_URL: ''", "TOKEN_EXCHANGE_URL: location.search.includes('unconfigured') ? '' : 'https://colabhub-auth.demo.workers.dev'")
      .replace("GOOGLE_CLIENT_ID: 'test-google-client-id'", "GOOGLE_CLIENT_ID: location.search.includes('unconfigured') ? '' : 'test-google-client-id'") },
  { id: 'hash', src: ext('lib/hash.js') },
  { id: 'notebook', src: ext('lib/notebook.js') },
  { id: 'granularity', src: ext('lib/granularity.js') },
  { id: 'github', src: ext('lib/github.js') },
  { id: 'syncEngine', src: ext('lib/syncEngine.js') },
  { id: 'storage', src: ext('lib/storage.js') },
  { id: 'appconfig', src: ext('lib/appconfig.js') },
  { id: 'auth', src: ext('lib/auth.js') },
  { id: 'drive', src: ext('lib/drive.js') },
  { id: 'background', src: ext('background.js') },
  { id: 'popup', src: ext('popup/popup.js') },
];

const modIdFor = (spec) => path.basename(spec).replace(/\.js$/, '').replace(/^config$/, 'config');

function transform({ id, src }) {
  const nsImports = [];
  // namespace imports → alias to the module object
  src = src.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?[ \t]*\r?\n/gm, (_, alias, spec) => {
    nsImports.push(`const ${alias} = __mod_${modIdFor(spec)};`);
    return '';
  });
  // named imports → nothing (all exports are hoisted to the bundle scope)
  src = src.replace(/^import\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"][^'"]+['"];?[ \t]*\r?\n/gm, (m) => {
    if (/\bas\b/.test(m)) throw new Error(`aliased import not supported in ${id}: ${m.trim()}`);
    return '';
  });
  // exports
  const names = [];
  src = src.replace(/^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
  if (/^export\b/m.test(src)) throw new Error(`unsupported export form in ${id}`);

  if (id === 'popup') {
    // make the popup re-bootable so the demo can "reopen" it when switching tabs
    const boot = `refreshState()
  .then(() => render())`;
    if (!src.includes(boot)) throw new Error('popup boot line not found');
    src = src.replace(
      boot,
      `window.__popupBoot = () => { history = []; route = { name: 'boot' }; return refreshState().then(() => render()); };
window.__popupBoot()`,
    );
  }

  const body = `${nsImports.join('\n')}\n${src}\n${names.length ? `return { ${names.join(', ')} };` : ''}`;
  const decl = names.length ? `const __mod_${id} = (() => {\n${body}\n})();\nconst { ${names.join(', ')} } = __mod_${id};` : `(() => {\n${body}\n})();`;
  return `// ===== ${id} =====\n${decl}\n`;
}

const bundle = MODULES.map(transform).join('\n');
if (/^\s*(import|export)\b/m.test(bundle)) throw new Error('bundle still contains import/export statements');

// popup.html → body markup + templates (without link/script tags)
const popupHtml = ext('popup/popup.html');
const iconDataUri = `data:image/png;base64,${fs.readFileSync(path.join(root, 'extension', 'icons', 'icon32.png')).toString('base64')}`;
const bodyInner = popupHtml
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*><\/script>/g, '')
  .replace('src="../icons/icon32.png"', `src="${iconDataUri}"`)
  .trim();
const popupCss = ext('popup/popup.css').replace(/html, body \{[\s\S]*?\}/, (m) => m.replace('html, body {', '.popup {').replace(/\n\s*margin: 0;/, ''));

const polyfills = fs.readFileSync(path.join(root, 'scripts', 'demo-polyfills.js'), 'utf8');
const harness = fs.readFileSync(path.join(root, 'scripts', 'demo-harness.js'), 'utf8');
const demoCss = fs.readFileSync(path.join(root, 'scripts', 'demo.css'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ColabHub — interactive demo</title>
<style>
${demoCss}
/* ---- popup styles (scoped) ---- */
.popup { ${''} }
${popupCss.replace(/(^|\n)([^@\n;{}][^{;\n]*)\{/g, (m, lead, sel) => {
  // scope every selector under .popup (skip keyframes/media blocks and :root);
  // the character class excludes ';' and newlines so declaration lines are never treated as selectors
  const scoped = sel
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s === ':root' || s.startsWith('.popup') ? s : `.popup ${s}`))
    .join(', ');
  return `${lead}${scoped} {`;
})}
</style>
</head>
<body>
<div class="demo">
  <aside class="left">
    <div class="browser">
      <div class="tabstrip" id="tabstrip"></div>
      <div class="toolbar">
        <div class="urlbar" id="urlbar"></div>
        <button class="ext-icon" id="ext-icon" title="ColabHub">
          <img src="${iconDataUri}" width="20" height="20" alt="ColabHub" style="border-radius:5px;display:block" />
          <span class="badge" id="ext-badge"></span>
        </button>
      </div>
      <div class="badge-title muted small" id="badge-title" title="What the toolbar icon's tooltip says"></div>
      <div class="page" id="page"></div>
    </div>
    <div class="popup-anchor">
      <div class="popup" id="popup">
${bodyInner}
      </div>
    </div>
  </aside>

  <section class="right">
    <div class="panel">
      <h3>Simulate</h3>
      <div class="controls" id="controls"></div>
      <p class="note" id="demo-status">Starting…</p>
      <p class="note">This page runs the real extension code (popup + service worker) against an in-memory GitHub &amp; Drive. Auth popups are simulated. The demo clock runs 60× faster, so "5 minutes" of auto-sync is 5 seconds.</p>
    </div>
    <div class="panel">
      <h3>GitHub (simulated)</h3>
      <div id="github-view" class="gh"></div>
    </div>
    <div class="panel">
      <h3>API log</h3>
      <div id="api-log" class="log"></div>
    </div>
  </section>
</div>

<script>
${polyfills}
</script>
<script>
${harness}
</script>
<script>
// The bundle is a plain classic script (no import/export) so it runs even where <script type="module">
// is blocked. It is wrapped so an unexpected failure is reported visibly rather than swallowed.
try {
${bundle}
  window.__demoBundleLoaded = true;
} catch (e) {
  console.error(e);
  window.dispatchEvent(new ErrorEvent('error', { error: e, message: e && e.message }));
}
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
const out = path.join(root, 'demo', 'colabhub-demo.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);
