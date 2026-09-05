#!/usr/bin/env node
// scripts/generate-key.mjs — generate a fresh RSA key and pin it in manifest.json so the
// extension ID (and therefore the OAuth redirect URLs) stay stable across machines/reloads.
// Run once per project. The private key is saved to keys/ (git-ignored) in case you later
// want to pack a .crx with the same identity.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (manifest.key && !process.argv.includes('--force')) {
  console.log('manifest.json already has a key. Use --force to replace it (this CHANGES the extension ID).');
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
manifest.key = der.toString('base64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

fs.mkdirSync(path.join(root, 'keys'), { recursive: true });
fs.writeFileSync(path.join(root, 'keys', 'dev-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const hash = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
console.log(`New extension ID: ${id}`);
console.log('Update ALLOWED_EXTENSION_IDS in backend/wrangler.toml and re-register the OAuth redirect URLs.');
