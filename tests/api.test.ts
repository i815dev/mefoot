import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import type { Database, QueryExecutor } from '../server/db.ts';
import worker from '../worker/index.ts';

const APP_ORIGIN = 'https://mefoot.example';
const API_ORIGIN = 'https://api.mefoot.example';
const EDGE_KEY = 'test-edge-secret-at-least-32-characters';
const settings = { APP_ORIGIN, EDGE_SHARED_KEY: EDGE_KEY, APP_VERSION: 'test-version' };

function fakeDatabase(): Database & { calls: string[] } {
  const db = {
    calls: [] as string[],
    async query(sql: string) { db.calls.push(sql); return { rows: [], rowCount: 0 }; },
    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>) { return fn(db); },
  };
  return db;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, init);
}

function workerEnvironment() {
  return {
    APP_ENV: 'test', API_ORIGIN, EDGE_SHARED_KEY: EDGE_KEY,
    ASSETS: { fetch: async () => { throw new Error('API request reached static assets'); } },
  };
}

test('API rejects missing and forged edge keys before reading sessions or the database', async () => {
  const db = fakeDatabase();
  const app = createApp(db, loadConfig(settings));
  for (const key of [undefined, 'forged-client-key']) {
    const response = await app(request('/api/me', { headers: {
      cookie: `__Host-mefoot_session=${'s'.repeat(43)}`,
      ...(key ? { 'x-mefoot-edge-key': key } : {}),
    } }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'edge_access_required' });
  }
  assert.deepEqual(db.calls, []);
});

test('API mutations reject absent or foreign Origin before database access', async () => {
  const db = fakeDatabase();
  const app = createApp(db, loadConfig(settings));
  for (const origin of [undefined, 'https://attacker.example']) {
    const response = await app(request('/api/teams', {
      method: 'POST', headers: {
        'x-mefoot-edge-key': EDGE_KEY, 'content-type': 'application/json',
        cookie: `__Host-mefoot_session=${'s'.repeat(43)}`,
        ...(origin ? { origin } : {}),
      }, body: JSON.stringify({ name: '테스트 팀', sport: 'futsal' }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'invalid_origin' });
  }
  assert.deepEqual(db.calls, []);
});

test('process health works without edge authentication and does not certify PostgreSQL', async () => {
  const db = fakeDatabase();
  const app = createApp(db, loadConfig(settings));
  const response = await app(request('/healthz'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', scope: 'process', version: 'test-version' });
  assert.deepEqual(db.calls, []);
});

test('database health requires the edge key and actually queries the application table', async () => {
  const db = fakeDatabase();
  const app = createApp(db, loadConfig(settings));
  const denied = await app(request('/api/health/db'));
  assert.equal(denied.status, 403);
  assert.deepEqual(db.calls, []);
  const response = await app(request('/api/health/db', { headers: { 'x-mefoot-edge-key': EDGE_KEY } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scope, 'api-and-database');
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]!, /FROM mefoot\.users/);
});

test('missing OAuth or unpublished consent configuration keeps the API running with login disabled', async () => {
  const configurations = [
    settings,
    { ...settings, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' },
    { ...settings, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', TERMS_VERSION: 'terms-v1' },
  ];
  for (const env of configurations) {
    const db = fakeDatabase();
    const app = createApp(db, loadConfig(env));
    const response = await app(request('/api/auth/providers', { headers: { 'x-mefoot-edge-key': EDGE_KEY } }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.providers.length, 3);
    assert.ok(result.providers.every((provider: { enabled: boolean }) => provider.enabled === false));
    const start = await app(request('/api/auth/google/start', { headers: { 'x-mefoot-edge-key': EDGE_KEY } }));
    assert.equal(start.status, 503);
    assert.deepEqual(await start.json(), { error: 'provider_not_configured' });
    assert.deepEqual(db.calls, []);
  }
});

test('auth requests stop at 30 per client IP before another OAuth flow is inserted', async () => {
  const db = fakeDatabase();
  const app = createApp(db, loadConfig({
    ...settings, TERMS_VERSION: 'terms-v1', PRIVACY_NOTICE_VERSION: 'privacy-v1',
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  }));
  const start = (ip: string) => app(request('/api/auth/google/start', {
    headers: { 'x-mefoot-edge-key': EDGE_KEY, 'x-mefoot-client-ip': ip },
  }));
  for (let i = 0; i < 30; i++) assert.equal((await start('192.0.2.1')).status, 303);
  assert.equal(db.calls.length, 30);
  const limited = await start('192.0.2.1');
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'too_many_requests' });
  assert.equal(db.calls.length, 30);
  assert.equal((await start('192.0.2.2')).status, 303);
  assert.equal(db.calls.length, 31);
});

test('Worker replaces untrusted edge headers while preserving browser cookie and Origin', async (t) => {
  let forwarded: { url: URL; init: RequestInit } | undefined;
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    forwarded = { url: new URL(input), init };
    return new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
    });
  });
  const response = await worker.fetch(request('/api/teams?q=MIT&limit=5', { headers: {
    host: 'attacker.example', origin: APP_ORIGIN,
    cookie: '__Host-mefoot_session=browser-session', accept: 'application/json',
    'content-type': 'application/json', 'x-mefoot-edge-key': 'attacker-key',
    'x-mefoot-client-ip': '198.51.100.200', 'cf-connecting-ip': '192.0.2.9',
    'x-forwarded-host': 'attacker.example', authorization: 'Bearer unwanted-client-token',
  } }), workerEnvironment());
  assert.ok(forwarded);
  assert.equal(forwarded.url.href, `${API_ORIGIN}/api/teams?q=MIT&limit=5`);
  assert.equal(forwarded.init.redirect, 'manual');
  const headers = new Headers(forwarded.init.headers);
  assert.equal(headers.get('x-mefoot-edge-key'), EDGE_KEY);
  assert.equal(headers.get('x-mefoot-client-ip'), '192.0.2.9');
  assert.equal(headers.get('host'), null);
  assert.equal(headers.get('x-forwarded-host'), null);
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), '__Host-mefoot_session=browser-session');
  assert.equal(headers.get('origin'), APP_ORIGIN);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { ok: true });
});

test('Worker preserves redirects and separate session cookies without following the provider', async (t) => {
  const cookies = [
    '__Host-mefoot_oauth_google=; Path=/; HttpOnly; Secure; Max-Age=0',
    '__Host-mefoot_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax',
  ];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_input: URL, init: RequestInit) => {
    assert.equal(init.redirect, 'manual');
    const headers = new Headers({ location: '/t/example-team', 'cache-control': 'public' });
    for (const value of cookies) headers.append('set-cookie', value);
    return new Response(null, { status: 303, headers });
  });
  const response = await worker.fetch(request('/api/auth/google/callback?code=test&state=test'), workerEnvironment());
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/t/example-team');
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('Worker preserves an Apple callback POST body and content type', async (t) => {
  const body = 'code=apple-test-code&state=apple-test-state';
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_input: URL, init: RequestInit) => {
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(new Headers(init.headers).get('origin'), 'https://appleid.apple.com');
    assert.equal(await new Response(init.body).text(), body);
    return new Response(null, { status: 303, headers: { location: '/auth/complete' } });
  });
  const response = await worker.fetch(request('/api/auth/apple/callback', {
    method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://appleid.apple.com' },
  }), workerEnvironment());
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(response.status, 303);
});

test('Worker reports unavailable API without leaking upstream error details', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private upstream diagnostic'); });
  const response = await worker.fetch(request('/api/teams'), workerEnvironment());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'api_unavailable' });
});

test('Worker health remains worker-only even when the origin API is configured and unavailable', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No origin call expected'); });
  const response = await worker.fetch(request('/api/health'), workerEnvironment());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'mefoot', scope: 'worker-only' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const mutation = await worker.fetch(request('/api/health', { method: 'POST' }), workerEnvironment());
  assert.equal(mutation.status, 405);
  assert.equal(fetchMock.mock.calls.length, 0);
});
