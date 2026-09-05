#!/usr/bin/env node
// scripts/extension-id.mjs — print the extension ID derived from manifest.json's "key",
// plus the redirect URLs you must register with GitHub and Google.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (!manifest.key) {
  console.error('manifest.json has no "key" — run scripts/generate-key.mjs first');
  process.exit(1);
}
const der = Buffer.from(manifest.key, 'base64');
const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

console.log(`Extension ID:            ${id}`);
console.log(`GitHub OAuth callback:   https://${id}.chromiumapp.org/github`);
console.log(`Google redirect URI:     https://${id}.chromiumapp.org/google`);
console.log(`Extension origin:        chrome-extension://${id}`);
