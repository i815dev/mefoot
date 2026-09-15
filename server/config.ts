import type { AuthConfig } from './auth.ts';

export interface AppConfig { auth: AuthConfig; edgeKey: string; version: string }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.APP_ORIGIN || !env.EDGE_SHARED_KEY || env.EDGE_SHARED_KEY.length < 32)
    throw new Error('APP_ORIGIN and a strong EDGE_SHARED_KEY are required');
  const auth: AuthConfig = {
    appOrigin: env.APP_ORIGIN, termsVersion: env.TERMS_VERSION || 'unpublished',
    privacyNoticeVersion: env.PRIVACY_NOTICE_VERSION || 'unpublished',
  };
  // Do not enable real signups until the product has its actual consent versions.
  if (env.TERMS_VERSION && env.PRIVACY_NOTICE_VERSION) {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
      auth.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
    if (env.KAKAO_CLIENT_ID && env.KAKAO_CLIENT_SECRET)
      auth.kakao = { clientId: env.KAKAO_CLIENT_ID, clientSecret: env.KAKAO_CLIENT_SECRET, openIdEnabled: env.KAKAO_OPENID_ENABLED === 'true' };
    if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY)
      auth.apple = { clientId: env.APPLE_CLIENT_ID, teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY };
  }
  return { auth, edgeKey: env.EDGE_SHARED_KEY, version: env.APP_VERSION || 'local' };
}
