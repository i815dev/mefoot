import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.ts';

const env = { APP_ENV: 'test', ASSETS: { fetch: async () => new Response('asset') } };

test('unknown API paths return JSON 404 instead of the SPA shell', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/unknown'), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('health only certifies this Worker, and cannot be cached', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).scope, 'worker-only');
});

test('API mutations are unavailable before the business API is implemented', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health', { method: 'POST' }), env);
  assert.equal(response.status, 405);
});

test('team links are passed through to the shared web application', async () => {
  const response = await worker.fetch(new Request('https://example.test/t/example'), env);
  assert.equal(await response.text(), 'asset');
});
