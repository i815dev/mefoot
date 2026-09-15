import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const origin = new URL(process.env.SMOKE_URL || 'http://127.0.0.1:8787');
const expected = process.env.EXPECTED_VERSION || 'local';
const expectedEnv = process.env.EXPECTED_ENV || 'staging';
async function get(path) {
  const url = new URL(path, origin);
  url.searchParams.set('verify', `${Date.now()}`);
  return fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(7000) });
}
async function verify() {
  const healthResponse = await get('/api/health');
  assert.equal(healthResponse.status, 200, 'Worker health HTTP status');
  assert.deepEqual(await healthResponse.json(), { status: 'ok', service: 'mefoot', scope: 'worker-only' });
  const versionResponse = await get('/api/version');
  assert.equal(versionResponse.status, 200);
  const version = await versionResponse.json();
  assert.equal(version.version, expected, 'Deployed Worker SHA');
  assert.equal(version.environment, expectedEnv, 'Deployment environment');
  const pageResponse = await get('/');
  assert.equal(pageResponse.status, 200, 'Home page HTTP status');
  const html = await pageResponse.text();
  assert.ok(html.includes(`name="mefoot-version" content="${expected}"`), 'Web assets must match the Worker version');
  const scriptPath = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(scriptPath, 'Built frontend script must exist');
  const script = await get(scriptPath);
  assert.equal(script.status, 200, 'Frontend script HTTP status');
  assert.match(script.headers.get('content-type') || '', /javascript/);
  const missing = await get('/api/not-implemented');
  assert.equal(missing.status, 404, 'Unknown API must not return the SPA page');
  if (process.env.EXPECT_API === '1') {
    const dbResponse = await get('/api/health/db');
    assert.equal(dbResponse.status, 200, 'Worker must reach the API and database');
    const db = await dbResponse.json();
    assert.equal(db.status, 'ok');
    assert.equal(db.scope, 'api-and-database');
    assert.match(db.version, /^[a-f0-9]{40}$/, 'API must report its deployed image SHA');
    if (process.env.EXPECTED_API_VERSION) assert.equal(db.version, process.env.EXPECTED_API_VERSION, 'Deployed API SHA');
  }
}

let lastError;
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    await verify();
    console.log(`Verified web + Worker ${expected} on ${origin.origin} (${expectedEnv}). ${process.env.EXPECT_API === '1' ? 'API and database connection verified.' : 'Database connection was not checked.'} Real social login was not checked.`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 5) await setTimeout(2000);
  }
}
throw lastError;
