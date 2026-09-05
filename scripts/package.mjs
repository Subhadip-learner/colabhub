#!/usr/bin/env node
// scripts/package.mjs — zip extension/ into release/colabhub-<version>.zip for the Chrome Web Store.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = fs.existsSync(path.join(root, 'colabhub-extension', 'manifest.json'))
  ? path.join(root, 'colabhub-extension')
  : path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `colabhub-${manifest.version}.zip`);
if (fs.existsSync(out)) fs.unlinkSync(out);

// Safety net: a distributed build must never contain the OAuth App's client secret.
const configSrc = fs.readFileSync(path.join(sourceDir, 'config.js'), 'utf8');
if (/GITHUB_CLIENT_SECRET:\s*['"][^'"]+['"]/.test(configSrc)) {
  console.error('extension/config.js contains GITHUB_CLIENT_SECRET — never ship the secret. Re-run `npm run configure` with --token-exchange-url and without --github-client-secret.');
  process.exit(1);
}
if (!/TOKEN_EXCHANGE_URL:\s*['"]https?:\/\//.test(configSrc) && !/GITHUB_AUTH_METHOD:\s*['"]device['"]/.test(configSrc)) {
  console.warn('warning: TOKEN_EXCHANGE_URL is empty — users of this build cannot finish "Connect GitHub" (GitHub requires the client secret, which only the Worker has).');
}

// Web Store uploads should NOT contain the "key" field; strip it into a temp copy.
const tmp = fs.mkdtempSync(path.join(outDir, 'tmp-'));
fs.cpSync(sourceDir, tmp, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(tmp, 'LICENSE.txt'));
const m = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
delete m.key;
fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

// Minify release JavaScript so the published archive does not expose the readable source.
async function minifyJavaScript(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await minifyJavaScript(file);
    else if (entry.isFile() && file.endsWith('.js')) {
      const result = await minify(fs.readFileSync(file, 'utf8'), {
        module: true,
        compress: true,
        mangle: true,
        format: { comments: false },
      });
      if (!result.code) throw new Error(`Terser produced no output for ${file}`);
      fs.writeFileSync(file, `${result.code}\n`);
    }
  }
}

try {
  await minifyJavaScript(tmp);
  execSync(`cd "${tmp}" && zip -qr "${out}" .`, { stdio: 'pipe' });
} catch {
  // no `zip` binary → use Python where available, otherwise PowerShell on Windows
  try {
    execSync(`python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1][:-4], 'zip', sys.argv[2])" "${out}" "${tmp}"`, { stdio: 'inherit' });
  } catch {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${tmp}\\*' -DestinationPath '${out}' -Force"`, { stdio: 'inherit' });
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote ${path.relative(root, out)}`);
console.log('Note: the store-assigned ID will differ from the dev ID unless you upload with the same key (see README → Publishing).');
