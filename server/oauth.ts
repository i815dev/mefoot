import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export type ProviderName = 'google' | 'kakao' | 'apple';
export type OAuthConfig = {
  google?: { clientId: string; clientSecret: string };
  kakao?: { clientId: string; clientSecret: string; openIdEnabled: boolean };
  apple?: { clientId: string; teamId: string; keyId: string; privateKey: string };
};
export type VerifiedIdentity = {
  provider: ProviderName;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  suggestedName: string | null;
};
export type OAuthFlow = { nonce: string; code_verifier: string };

const providers = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    scope: 'openid email profile',
  },
  kakao: {
    authorize: 'https://kauth.kakao.com/oauth/authorize',
    token: 'https://kauth.kakao.com/oauth/token',
    jwks: 'https://kauth.kakao.com/.well-known/jwks.json',
    issuer: ['https://kauth.kakao.com'],
    scope: 'openid',
  },
  apple: {
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    issuer: ['https://appleid.apple.com'],
    scope: 'email',
  },
} as const;

export class OAuthError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export function providerReady(config: OAuthConfig, provider: ProviderName): boolean {
  const value = config[provider];
  if (!value?.clientId?.trim()) return false;
  if (provider === 'apple') {
    const apple = config.apple!;
    return Boolean(apple.teamId?.trim() && apple.keyId?.trim() && apple.privateKey?.trim());
  }
  if (provider === 'kakao' && !config.kakao?.openIdEnabled) return false;
  return Boolean(config[provider]?.clientSecret?.trim());
}

export function authorizationUrl(config: OAuthConfig, provider: ProviderName, redirectUri: string,
  state: string, flow: OAuthFlow): string {
  if (!providerReady(config, provider)) throw new OAuthError('provider_not_configured');
  const url = new URL(providers[provider].authorize);
  const parameters: Record<string, string> = {
    client_id: config[provider]!.clientId,
    redirect_uri: redirectUri,
    response_type: 'code', scope: providers[provider].scope,
    state, nonce: flow.nonce,
  };
  if (provider === 'apple') parameters.response_mode = 'form_post';
  else {
    parameters.code_challenge = createHash('sha256').update(flow.code_verifier).digest('base64url');
    parameters.code_challenge_method = 'S256';
  }
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.href;
}

const keySets = new Map<ProviderName, JWTVerifyGetKey>();
function providerKeys(provider: ProviderName): JWTVerifyGetKey {
  let keys = keySets.get(provider);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(providers[provider].jwks), { timeoutDuration: 8_000 });
    keySets.set(provider, keys);
  }
  return keys;
}

// The optional key resolver lets tests verify real signatures with local keys.
// The HTTP routes never accept a resolver, issuer or key URL from a request.
export async function verifyProviderIdToken(provider: ProviderName, idToken: string,
  clientId: string, nonce: string, keys: JWTVerifyGetKey = providerKeys(provider)): Promise<VerifiedIdentity> {
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      algorithms: ['RS256'], issuer: [...providers[provider].issuer], audience: clientId,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'], clockTolerance: 30,
    });
    const expected = Buffer.from(nonce);
    const received = typeof payload.nonce === 'string' ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('nonce');
    if (!payload.sub || payload.sub.length > 255 || !Number.isFinite(payload.iat) || payload.iat! > Date.now() / 1000 + 30) {
      throw new Error('claims');
    }
    if ((payload.azp !== undefined && payload.azp !== clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('azp');
    const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : null;
    const name = typeof payload.name === 'string' ? payload.name : typeof payload.nickname === 'string' ? payload.nickname : null;
    return { provider, subject: payload.sub, email,
      emailVerified: email !== null && (payload.email_verified === true || payload.email_verified === 'true'),
      suggestedName: name?.trim().slice(0, 30) || null };
  } catch {
    throw new OAuthError('invalid_identity_token');
  }
}

export async function exchangeAuthorizationCode(config: OAuthConfig, provider: ProviderName,
  redirectUri: string, code: string, flow: OAuthFlow): Promise<VerifiedIdentity> {
  if (!providerReady(config, provider)) throw new OAuthError('provider_not_configured');
  let clientSecret: string;
  if (provider === 'apple') {
    const apple = config.apple!;
    const privateKey = await importPKCS8(apple.privateKey.replace(/\\n/g, '\n'), 'ES256');
    clientSecret = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
      .setIssuer(apple.teamId).setSubject(apple.clientId).setAudience('https://appleid.apple.com')
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  } else clientSecret = config[provider]!.clientSecret;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code,
    client_id: config[provider]!.clientId, client_secret: clientSecret, redirect_uri: redirectUri });
  if (provider !== 'apple') body.set('code_verifier', flow.code_verifier);
  try {
    const response = await fetch(providers[provider].token, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body, signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new OAuthError('provider_exchange_failed');
    const tokenResponse = await response.json() as { id_token?: unknown };
    if (typeof tokenResponse.id_token !== 'string' || tokenResponse.id_token.length > 20_000) {
      throw new OAuthError('missing_identity_token');
    }
    // Access and refresh tokens are deliberately neither persisted nor returned.
    return await verifyProviderIdToken(provider, tokenResponse.id_token, config[provider]!.clientId, flow.nonce);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('provider_exchange_failed');
  }
}
