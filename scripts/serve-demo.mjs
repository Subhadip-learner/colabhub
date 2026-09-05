#!/usr/bin/env node
// scripts/serve-demo.mjs — serve the demo (and the repo) over HTTP. Zero dependencies.
//   node scripts/serve-demo.mjs [port]     → http://0.0.0.0:8080/  (demo page)
//                                            http://0.0.0.0:8080/files/…  (any repo file)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file;
    if (url.pathname === '/' || url.pathname === '/demo') file = path.join(root, 'demo', 'colabhub-demo.html');
    else if (url.pathname.startsWith('/files/')) file = path.join(root, decodeURIComponent(url.pathname.slice(7)));
    else { res.writeHead(404); return res.end('not found'); }
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '0.0.0.0', () => console.log(`ColabHub demo: http://0.0.0.0:${port}/`));
