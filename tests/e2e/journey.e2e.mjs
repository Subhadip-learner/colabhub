// tests/e2e/journey.e2e.mjs — the user journey, start to finish, on the demo page (real popup +
// service-worker code). Also covers the developer's first run with an unconfigured build.
//   npm i -D playwright-core && npx playwright-core install chromium
//   node tests/e2e/journey.e2e.mjs
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = 'file://' + path.join(ROOT, 'demo', 'colabhub-demo.html');
const OUT = path.join(os.tmpdir(), 'colabhub-journey');
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const popup = (s) => page.locator('#popup ' + s);
const view = async () => (await popup('#view').innerText()).replace(/\s+/g, ' ');
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`), clip: { x: 356, y: 92, width: 380, height: 760 } });
let failed = false;
const step = async (n, label, re) => {
  const t = await view();
  const ok = re.test(t);
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}. ${label}`);
  if (!ok) console.log('     ', t.slice(0, 220));
  await shot(n);
};

// ---- A) developer's first run: unconfigured build
await page.goto(DEMO + '?unconfigured');
await page.waitForTimeout(900);
await step('A1', 'unconfigured build → publisher setup screen (not a dead button; users never see it)', /Publisher setup.*End users never see this screen.*Callback URL.*Token-exchange backend.*wrangler deploy/s);
await popup('[data-field="githubClientId"]').fill('Ov23liDemoClientId1234');
await popup('[data-field="googleClientId"]').fill('1234567890-demo.apps.googleusercontent.com');
await popup('[data-action="save"]').click();
await page.waitForTimeout(400);
const a1err = await popup('[data-slot="error"]').innerText().catch(() => '');
const a1ok = /Step 2 is missing/.test(a1err);
console.log(`${a1ok ? 'PASS' : 'FAIL'} A1b. Client ID without a backend is refused (GitHub would reject the token exchange)`);
if (!a1ok) failed = true;
await popup('[data-field="tokenExchangeUrl"]').fill('https://colabhub-auth.demo.workers.dev');
await popup('[data-action="test-backend"]').click();
await page.waitForTimeout(400);
const beMsg = await popup('[data-slot="be-result"]').innerText().catch(() => '');
const a1cok = /reachable and configured/.test(beMsg);
console.log(`${a1cok ? 'PASS' : 'FAIL'} A1c. "Test" pings the Worker's /health → "${beMsg}"`);
if (!a1cok) failed = true;
await popup('[data-action="save"]').click();
await page.waitForTimeout(600);
await step('A2', 'after saving Client ID + Worker URL → overview: GitHub card (Backend OAuth proxy ready) · notebook card · Create / Connect', /GitHub connection.*Backend OAuth proxy ready.*Connect GitHub.*Current notebook.*Not linked.*Create New Repository.*Connect Existing Repo/);
console.log('      actions disabled until signed in:', await popup('[data-action="create"]').isDisabled());
console.log('      connect button visible:', await popup('[data-action="oauth"]').isVisible());

// ---- B) the end-user journey (identical for a published build)
await popup('[data-action="oauth"]').click();
await page.waitForSelector('.auth-modal', { timeout: 5000 });
const authHead = await page.locator('.auth-modal .auth-head').innerText();
const authTitle = await page.locator('.auth-modal h4').innerText();
console.log(`      GitHub authorize page: ${authHead} — "${authTitle}"`);
const b1ok = /login\/oauth\/authorize/.test(authHead) && /Authorize ColabHub/.test(authTitle) && !/device/i.test(await view());
console.log(`${b1ok ? 'PASS' : 'FAIL'} B1. Connect GitHub → standard OAuth authorize page (no code to type)`);
if (!b1ok) failed = true;
await page.screenshot({ path: path.join(OUT, 'B1.png'), clip: { x: 356, y: 92, width: 380, height: 760 } });
await page.locator('.auth-modal .ok').click(); // "Authorize"
await page.waitForFunction(() => document.querySelector('#popup #gh-status')?.textContent.includes('@'), null, { timeout: 15000 });
await page.waitForTimeout(200);
await step('B2', 'Authorize → "Connected as @…" in the GitHub card; Create / Connect enabled', /GitHub connection.*@subhadip-medya.*Create New Repository.*Connect Existing Repo/);
console.log('      footer:', await popup('#gh-status').innerText(), '· create enabled:', await popup('[data-action="create"]').isEnabled());
await popup('[data-action="create"]').click();
await page.waitForTimeout(300);
await step('B3', 'Create form: owner, name, description, Private/Public, README, .gitignore', /Owner.*Repository name.*Description.*Private.*Public.*README\.md.*\.gitignore/);
await popup('summary:has-text("Notebook options")').click();
await page.waitForTimeout(150);
const b3b = await view();
console.log(`${/Push granularity.*Auto Sync.*Auto-Push/.test(b3b) ? 'PASS' : 'FAIL'} B3b. Notebook options include Push granularity + Auto Sync + Auto-Push`);
await popup('[data-field="name"]').fill('ML-Projects');
await popup('[data-field="description"]').fill('My Google Colab projects');
await popup('[data-action="submit"]').click();
await page.waitForSelector('.auth-modal', { timeout: 5000 });
console.log('      Google Drive consent (first sync only):', await page.locator('.auth-modal h4').innerText());
await page.locator('.auth-modal .ok').click();
await page.waitForTimeout(900);
await step('B4', 'Repository created + notebook committed → dashboard', /Linked.*notebooks\/Customer_Churn_Analysis\.ipynb.*ML-Projects.*main.*🔒 Private.*Repository created/);

// ---- C) reopen the popup later: straight to the dashboard
await page.locator('#ext-icon').click(); await page.waitForTimeout(150);
await page.locator('#ext-icon').click(); await page.waitForTimeout(400);
await step('C1', 'reopen popup → dashboard directly (no sign-in, no setup)', /Synced|Repository created/);

// ---- C2) Colab integration: Auto-Push after a cell run + granularity + toast
await popup('[data-field="autoPushOnCell"]').check();
await page.waitForTimeout(200);
await popup('[data-field="granularity"]').selectOption('py');
await page.waitForTimeout(500);
await step('C2', 'dashboard: Auto-Push on, granularity → Python script, path now .py', /notebooks\/Customer_Churn_Analysis\.py.*Auto-Push/);
console.log('      Auto-Push checked:', await popup('[data-field="autoPushOnCell"]').isChecked(), '· granularity:', await popup('[data-field="granularity"]').inputValue());
await page.locator('#controls button:has-text("Run a cell")').click();
await page.waitForFunction(() => /after cell run/.test(document.querySelector('#popup #view')?.innerText ?? ''), null, { timeout: 20000 });
await page.waitForTimeout(300);
await step('C3', 'cell ran → auto-pushed .py; status "Added .py to main after cell run"', /Auto-pushed|Synced.*Added \.py to main after cell run/);
const badgeTitle = await page.locator('#badge-title').innerText();
console.log(`${/\.py to main after cell run/.test(badgeTitle) ? 'PASS' : 'FAIL'} C3b. toolbar badge tooltip: "${badgeTitle}"`);
const colabToast = await page.locator('.colab-toast').innerText().catch(() => '');
console.log(`${/after cell run/.test(colabToast) ? 'PASS' : 'FAIL'} C3c. in-page toast on Colab: "${colabToast}"`);
const ghText = await page.locator('#github-view').innerText();
console.log(`${/Customer_Churn_Analysis\.py/.test(ghText) && /\(script\) after cell run via ColabHub/.test(ghText) ? 'PASS' : 'FAIL'} C3d. GitHub has the .py file + commit "… (script) after cell run via ColabHub"`);
await page.screenshot({ path: path.join(OUT, 'C3-full.png') });

// ---- D) another notebook: sign-in remembered; Connect Existing with search
await page.locator('.tab:has-text("Untitled3")').click(); await page.waitForTimeout(400);
await step('D1', 'another notebook → overview, still signed in', /@subhadip-medya.*Untitled3.*Create New Repository.*Connect Existing Repo/);
await popup('[data-action="existing"]').click();
await page.waitForFunction(() => document.querySelectorAll('#popup .repo-item').length > 0, null, { timeout: 5000 });
const totalRepos = await popup('.repo-item').count();
await popup('[data-field="filter"]').fill('ml-proj');
await page.waitForTimeout(200);
const hits = await popup('.repo-item').locator('visible=true').count();
const firstHit = await popup('.repo-item').first().innerText();
console.log(`${totalRepos > 1 && hits === 1 && /ML-Projects/.test(firstHit) ? 'PASS' : 'FAIL'} D2. search "ml-proj" narrows ${totalRepos} repos to 1: ${firstHit.replace(/\s+/g, ' ')}`);
await popup('.repo-item').first().click();
await page.waitForFunction(() => /main/.test(document.querySelector('#popup [data-field="branch"]')?.innerText ?? ''), null, { timeout: 5000 });
await step('D3', 'Connect Existing: search + select repo + branch (+ granularity, Auto-Push)', /Search repositories.*ML-Projects.*Branch.*main.*Push granularity.*Auto-Push/);

console.log('errors:', errors.join(' | ') || 'none');
console.log('screenshots:', OUT);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
