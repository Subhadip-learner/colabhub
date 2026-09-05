// tests/e2e/demo.e2e.mjs — drives the demo page (real popup + service worker code) through the full
// product flow with Playwright, both as a normal page and inside a sandboxed iframe (as the Arena
// file viewer renders it). Not part of `npm test` because it needs a Chromium binary:
//
//   npm i -D playwright-core && npx playwright-core install chromium
//   node tests/e2e/demo.e2e.mjs [--sandboxed]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO = path.join(ROOT, 'demo', 'colabhub-demo.html');
const HOST = path.join(os.tmpdir(), 'colabhub-e2e-host.html');
const SANDBOXED = process.argv.includes('--sandboxed');
const exe = process.env.CHROME_PATH || path.join(os.homedir(), '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

if (SANDBOXED) {
  const demo = fs.readFileSync(DEMO, 'utf8');
  const attr = demo.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  fs.writeFileSync(HOST, `<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts" style="width:1200px;height:860px;border:0" srcdoc="${attr}"></iframe></body></html>`);
  await page.goto('file://' + HOST);
} else {
  await page.goto('file://' + DEMO);
}
await page.waitForTimeout(1000);
const f = SANDBOXED ? page.frames()[1] : page.mainFrame();
const popup = (sel) => f.locator('#popup ' + sel);
const text = async () => (await popup('#view').innerText()).replace(/\s+/g, ' ');
const expect = async (label, re) => { const t = await text(); const ok = re.test(t); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  → ' + t.slice(0, 160)}`); if (!ok) process.exitCode = 1; };
const ctl = (label) => f.locator(`#controls button:has-text("${label}")`).click();
const wait = (ms) => page.waitForTimeout(ms);

console.log(((await f.locator('#demo-status').innerText()).startsWith('✅') ? 'PASS' : 'FAIL') + '  bundle booted (status line)');
await expect('boot → overview (GitHub card + Connect GitHub)', /GitHub connection.*Connect GitHub.*Current notebook/);
await popup('[data-action="oauth"]').click(); await f.locator('.auth-modal .ok').click(); await wait(400);
await expect('overview after OAuth (connected as …)', /@subhadip-medya.*Create New Repository.*Connect Existing Repo/);
await popup('[data-action="create"]').click(); await wait(300);
await expect('create form', /Create GitHub Repository.*Owner/);
await popup('[data-field="public"]').check(); await wait(100);
console.log((await popup('[data-slot="public-warning"]').isVisible() ? 'PASS' : 'FAIL') + '  public warning shows');
await popup('[data-field="private"]').check();
await popup('[data-field="name"]').fill('bad name!'); await wait(100);
await expect('name validation', /Only letters, numbers/);
await popup('[data-field="name"]').fill('ML-Projects');
await popup('[data-field="name"]').press('Enter');           // Enter submits
await f.locator('.auth-modal .ok').click(); await wait(900);
await expect('dashboard after create (Enter key)', /ML-Projects.*Private.*Repository created/);
await popup('[data-action="sync"]').click(); await wait(500);
await expect('no-op sync', /Synced ✓.*Up to date/);
await ctl('Edit notebook'); await wait(150); await popup('[data-action="sync"]').click(); await wait(600);
await expect('update commit', /Synced ✓/);
await ctl('Paste an API key'); await wait(150); await popup('[data-action="sync"]').click(); await wait(600);
await expect('secrets block', /Possible secrets found.*OpenAI API key/);
await ctl('Remove the API key'); await wait(150); await popup('[data-action="sync"]').click(); await wait(600);
await expect('clean again', /Synced ✓/);
await ctl('Someone edits'); await wait(200); await ctl('Edit notebook'); await wait(150); await popup('[data-action="sync"]').click(); await wait(600);
await expect('conflict', /Conflict.*Overwrite GitHub/);
await popup('[data-action="overwrite"]').click(); await wait(600);
await expect('force overwrite', /Synced ✓/);
await ctl('Edit notebook'); await ctl('Press Ctrl+S'); await wait(200);
await expect('pending after Ctrl+S', /Changes pending/);
await wait(1500);
await expect('debounced auto-sync', /Synced ✓/);
await f.locator('.tab:has-text("Untitled3")').click(); await wait(400);
await popup('[data-action="existing"]').click(); await wait(500);
await popup('[data-field="filter"]').fill('research'); await wait(300);
await popup('[data-action="submit"]').click(); await wait(900);
await expect('existing repo connected', /research-2026.*Synced ✓/);
await f.locator('.tab:has-text("GitHub")').click(); await wait(400);
await expect('non-Colab tab', /Not Colab.*Open a Colab notebook/);
await f.locator('#popup #btn-settings').click(); await wait(300);
await expect('settings', /Settings.*@subhadip-medya/);
const commits = (await f.locator('#github-view').innerText()).match(/via ColabHub/g)?.length ?? 0;
console.log(`${commits >= 5 ? 'PASS' : 'FAIL'}  ${commits} ColabHub commits in simulated GitHub`);
console.log('ERRORS:', errors.join('\n') || 'none');
if (errors.length) process.exitCode = 1;
await browser.close();
