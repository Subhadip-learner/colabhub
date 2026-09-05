// backend/dev-server.mjs — run the Worker locally with plain Node (no wrangler needed):
//   GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… node backend/dev-server.mjs
// then set TOKEN_EXCHANGE_URL = 'http://localhost:8787' in extension/config.js.
import http from 'node:http';
import worker from './worker.js';

const env = {
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID ?? '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? '',
  ALLOWED_EXTENSION_IDS: process.env.ALLOWED_EXTENSION_IDS ?? '',
};
const port = Number(process.env.PORT ?? 8787);

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  })
  .listen(port, '0.0.0.0', () => console.log(`colabhub-auth dev server on http://localhost:${port}`));
