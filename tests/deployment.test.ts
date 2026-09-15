import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfig } from '../scripts/deployment-config.mjs';

const release = { target: 'staging', manifest: { workerFile: 'worker/index.js', compatibilityDate: '2026-09-14' } };

test('generated deployment configuration retains the configured API binding', () => {
  const config = deploymentConfig({ ...release, apiOriginText: 'https://api.example.test/' });
  assert.equal(config.vars.API_ORIGIN, 'https://api.example.test');
  assert.deepEqual(config.assets.run_worker_first, ['/api/*']);
});

test('frontend-only deployment leaves the API disabled', () => {
  assert.equal('API_ORIGIN' in deploymentConfig(release).vars, false);
});

test('API destination cannot include plaintext transport, credentials or request data', () => {
  for (const apiOriginText of ['http://api.example.test', 'https://user:secret@api.example.test',
    'https://api.example.test/private', 'https://api.example.test?token=value', 'https://api.example.test#fragment']) {
    assert.throws(() => deploymentConfig({ ...release, apiOriginText }));
  }
});
