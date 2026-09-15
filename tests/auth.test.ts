import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuth, consumeOAuthFlow, hashToken } from '../server/auth.ts';
import { authorizationUrl, OAuthError, providerReady, verifyProviderIdToken } from '../server/oauth.ts';
import type { Database, QueryExecutor } from '../server/db.ts';
import type { AuthConfig } from '../server/auth.ts';
import { ApiError } from '../server/http.ts';

const config: AuthConfig = { appOrigin: 'https://mefoot.example', termsVersion: 'v1', privacyNoticeVersion: 'v1',
  google: { clientId: 'google-client', clientSecret: 'only-a-test-secret' },
  kakao: { clientId: 'kakao-client', clientSecret: 'only-a-test-secret', openIdEnabled: true },
  apple: { clientId: 'apple-client', teamId: 'team', keyId: 'key', privateKey: 'only-a-test-key' } };
const nonce = 'n'.repeat(43), state = 's'.repeat(43), binding = 'b'.repeat(43);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
async function idToken(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ sub: 'stable-provider-subject', iss: 'https://accounts.google.com', aud: 'google-client',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce,
    email: 'same-email@example.com', email_verified: true, name: '테스트 회원', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
}
function mockDatabase(query: QueryExecutor['query']): Database {
  return { query, transaction: async fn => fn({ query }) };
}
const noDatabase = mockDatabase(async () => { throw new Error('Unexpected database access'); });

test('verified Google identity uses signed subject and email is only an attribute', async () => {
  assert.deepEqual(await verifyProviderIdToken('google', await idToken(), 'google-client', nonce, keys), {
    provider: 'google', subject: 'stable-provider-subject', email: 'same-email@example.com',
    emailVerified: true, suggestedName: '테스트 회원',
  });
});

for (const [reason, claims] of Object.entries({
  issuer: { iss: 'https://attacker.example' }, audience: { aud: 'another-client' },
  nonce: { nonce: 'wrong-nonce' }, expired: { exp: 1 }, missingExpiry: { exp: undefined },
  missingSubject: { sub: undefined }, futureIssuedAt: { iat: Math.floor(Date.now() / 1000) + 300 },
  wrongAuthorizedParty: { azp: 'another-client' }, ambiguousAudience: { aud: ['google-client', 'other-client'] },
})) {
  test(`rejects signed identity token with ${reason}`, async () => {
    await assert.rejects(() => idToken(claims).then(token => verifyProviderIdToken('google', token, 'google-client', nonce, keys)),
      (error: unknown) => error instanceof OAuthError && error.code === 'invalid_identity_token');
  });
}

test('Google and Kakao require state, nonce and S256 PKCE; Apple uses form_post', () => {
  for (const provider of ['google', 'kakao'] as const) {
    const url = new URL(authorizationUrl(config, provider, `${config.appOrigin}/api/auth/${provider}/callback`,
      state, { nonce, code_verifier: binding }));
    assert.equal(url.searchParams.get('nonce'), nonce);
    assert.equal(url.searchParams.get('state'), state);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(url.searchParams.get('code_challenge'), binding);
    assert.equal(url.searchParams.has('client_secret'), false);
  }
  const apple = new URL(authorizationUrl(config, 'apple', `${config.appOrigin}/api/auth/apple/callback`, state,
    { nonce, code_verifier: binding }));
  assert.equal(apple.searchParams.get('response_mode'), 'form_post');
  assert.equal(apple.searchParams.has('code_challenge'), false);
});

test('Kakao readiness requires explicit OpenID Connect activation', () => {
  assert.equal(providerReady({ kakao: { ...config.kakao!, openIdEnabled: false } }, 'kakao'), false);
  assert.equal(providerReady(config, 'kakao'), true);
  assert.equal(providerReady({}, 'google'), false);
});

test('provider discovery reveals availability but no credentials', async () => {
  const auth = createAuth(noDatabase, { ...config, google: undefined, kakao: undefined, apple: undefined });
  const response = await auth.handle(new Request(`${config.appOrigin}/api/auth/providers`));
  assert.deepEqual((await response!.json()).providers.map((item: { enabled: boolean }) => item.enabled), [false, false, false]);
  assert.equal(response!.headers.get('cache-control'), 'no-store');
  await assert.rejects(() => auth.handle(new Request(`${config.appOrigin}/api/auth/google/start`)),
    (error: unknown) => error instanceof ApiError && error.status === 503);
});

test('oauth state consumption is bound to browser and rejects replay', async () => {
  let rowExists = true;
  const db = mockDatabase(async (sql, params) => {
    assert.match(sql, /DELETE FROM mefoot\.oauth_flows/);
    assert.match(sql, /expires_at > now\(\)/);
    if (!rowExists || params?.[0] !== hashToken(state) || params?.[1] !== hashToken(binding) || params?.[2] !== 'google') {
      return { rows: [], rowCount: 0 };
    }
    rowExists = false;
    return { rows: [{ nonce, code_verifier: binding, team_id: null, intent: 'view' }], rowCount: 1 };
  });
  assert.equal(await consumeOAuthFlow(db, 'google', state, 'x'.repeat(43)), null);
  assert.equal(await consumeOAuthFlow(db, 'kakao', state, binding), null);
  assert.equal((await consumeOAuthFlow(db, 'google', state, binding))?.nonce, nonce);
  assert.equal(await consumeOAuthFlow(db, 'google', state, binding), null);
});

test('flow cookies are browser scoped and Apple cross-site form POST compatible', async () => {
  const db = mockDatabase(async (sql, params) => {
    assert.match(sql, /INSERT INTO mefoot\.oauth_flows/);
    assert.match(String(params![0]), /^[a-f0-9]{64}$/);
    assert.match(String(params![1]), /^[a-f0-9]{64}$/);
    return { rows: [], rowCount: 1 };
  });
  const auth = createAuth(db, config);
  for (const provider of ['google', 'apple']) {
    const response = await auth.handle(new Request(`${config.appOrigin}/api/auth/${provider}/start`));
    const setCookie = response!.headers.get('set-cookie')!;
    assert.match(setCookie, /__Host-mefoot_oauth_/);
    assert.match(setCookie, /Path=\/; HttpOnly; Secure;/);
    assert.match(setCookie, provider === 'apple' ? /SameSite=None/ : /SameSite=Lax/);
    assert.equal(setCookie.includes('Domain='), false);
  }
});

test('no session cookie means unauthenticated without a database lookup', async () => {
  const auth = createAuth(noDatabase, config);
  assert.equal(await auth.getUser(new Request(config.appOrigin)), null);
  assert.equal(await auth.getUser(new Request(config.appOrigin, { headers: { cookie: '__Host-mefoot_session=bad' } })), null);
  assert.equal(await auth.getUser(new Request(config.appOrigin, { headers: {
    cookie: `__Host-mefoot_session=${state}; __Host-mefoot_session=${binding}`,
  } })), null);
});

test('register and logout refuse cross-origin requests before touching credentials or database', async () => {
  const auth = createAuth(noDatabase, config);
  for (const path of ['/api/auth/register', '/api/auth/logout']) {
    await assert.rejects(() => auth.handle(new Request(`${config.appOrigin}${path}`, {
      method: 'POST', headers: { origin: 'https://attacker.example' },
    })), (error: unknown) => error instanceof ApiError && error.status === 403);
  }
});

test('new signup requires explicit current consent after verified OAuth registration', async () => {
  const auth = createAuth(noDatabase, config);
  await assert.rejects(() => auth.handle(new Request(`${config.appOrigin}/api/auth/register`, {
    method: 'POST', headers: { origin: config.appOrigin, 'content-type': 'application/json',
      cookie: `__Host-mefoot_registration=${state}` },
    body: JSON.stringify({ display_name: '테스트', terms_version: 'v1', privacy_notice_version: 'v1' }),
  })), (error: unknown) => error instanceof ApiError && error.code === 'current_consent_required');
});

test('callback cannot skip browser binding even with a seemingly valid state and code', async () => {
  const auth = createAuth(noDatabase, config);
  await assert.rejects(() => auth.handle(new Request(`${config.appOrigin}/api/auth/google/callback?state=${state}&code=test-code`)),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_oauth_state');
});
