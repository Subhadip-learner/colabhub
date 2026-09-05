// Module resolve hook: redirects imports of extension/config.js to the test fixture.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixture = new URL('./config.test.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (r.url.startsWith('file:') && /[\\/]extension[\\/]config\.js$/.test(fileURLToPath(r.url))) {
    return { ...r, url: fixture };
  }
  return r;
}
