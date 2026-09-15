import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { createPool, databaseFromPool } from './db.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const pool = createPool();
const db = databaseFromPool(pool);
const app = createApp(db, config);
const server = createServer(async (incoming, outgoing) => {
  try {
    if (Number(incoming.headers['content-length'] || 0) > 16_384) {
      outgoing.writeHead(413); outgoing.end(); incoming.resume(); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 16_384) { outgoing.writeHead(413); outgoing.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const method = incoming.method || 'GET';
    const target = new URL(incoming.url || '/', config.auth.appOrigin);
    if (target.origin !== config.auth.appOrigin) { outgoing.writeHead(400); outgoing.end(); return; }
    const response = await app(new Request(target, { method, headers,
      ...(!['GET', 'HEAD'].includes(method) && size ? { body: Buffer.concat(chunks) } : {}) }));
    outgoing.statusCode = response.status;
    for (const [key, value] of response.headers) if (key !== 'set-cookie') outgoing.setHeader(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('set-cookie', cookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    outgoing.end('{"error":"internal_error"}');
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 50;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Mefoot API listening'));

let cleaning = false;
const cleanup = setInterval(async () => {
  if (cleaning) return; cleaning = true;
  try {
    for (const [table, key] of [['oauth_flows', 'state_hash'], ['auth_registrations', 'token_hash'], ['sessions', 'token_hash']])
      await db.query(`DELETE FROM mefoot.${table} WHERE ${key} IN (SELECT ${key} FROM mefoot.${table} WHERE expires_at <= now() LIMIT 1000)`);
  } catch { console.error('Expired authentication state cleanup failed'); }
  finally { cleaning = false; }
}, 60_000);
cleanup.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  clearInterval(cleanup);
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 25_000).unref();
});
