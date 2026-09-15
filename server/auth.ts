import { createHash, randomBytes } from 'node:crypto';
import type { Database, QueryExecutor } from './db.ts';
import { ApiError, json, readJson } from './http.ts';
import type { AuthenticatedUser } from './types.ts';
import { authorizationUrl, exchangeAuthorizationCode, OAuthError, providerReady } from './oauth.ts';
import type { OAuthConfig, OAuthFlow, ProviderName, VerifiedIdentity } from './oauth.ts';

export type AuthConfig = OAuthConfig & {
  appOrigin: string;
  termsVersion: string;
  privacyNoticeVersion: string;
  sessionDays?: number;
};
type ReturnContext = { team_id: string | null; intent: string };
type FlowRow = OAuthFlow & ReturnContext;
type RegistrationRow = ReturnContext & {
  provider: ProviderName; provider_subject: string; email: string | null;
  email_verified: boolean; suggested_name: string | null;
};

const sessionCookie = '__Host-mefoot_session';
const registrationCookie = '__Host-mefoot_registration';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const providerNames: ProviderName[] = ['kakao', 'google', 'apple'];
const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

function readCookie(request: Request, name: string): string | null {
  const matching = (request.headers.get('cookie') || '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matching.length !== 1) return null;
  const value = matching[0]!.slice(name.length + 1);
  return tokenPattern.test(value) ? value : null;
}
function cookie(name: string, value: string, maxAge: number, sameSite: 'Lax' | 'None' = 'Lax'): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}
function flowCookie(provider: ProviderName): string { return `__Host-mefoot_oauth_${provider}`; }
function flowSameSite(provider: ProviderName): 'Lax' | 'None' { return provider === 'apple' ? 'None' : 'Lax'; }
function redirect(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: path, 'cache-control': 'no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}
function privateJson(data: unknown, status = 200, cookies: string[] = []): Response {
  const response = json(data, status);
  response.headers.set('cache-control', 'no-store');
  for (const value of cookies) response.headers.append('set-cookie', value);
  return response;
}
function nextPath(context: ReturnContext): string {
  // Neither provider responses nor query-string return URLs become a redirect.
  return context.team_id ? `/t/${context.team_id}?intent=${context.intent}` : '/';
}
function requireOrigin(request: Request, origin: string): void {
  if (request.headers.get('origin') !== origin) throw new ApiError(403, 'invalid_origin');
}

// Deletion is the one-use claim. A wrong browser binding cannot burn another
// browser's flow; simultaneous matching callbacks allow exactly one exchange.
export async function consumeOAuthFlow(db: QueryExecutor, provider: ProviderName,
  state: string, binding: string): Promise<FlowRow | null> {
  if (!tokenPattern.test(state) || !tokenPattern.test(binding)) return null;
  const result = await db.query(`DELETE FROM mefoot.oauth_flows
    WHERE state_hash = $1 AND binding_hash = $2 AND provider = $3 AND expires_at > now()
    RETURNING nonce, code_verifier, team_id, intent`, [hashToken(state), hashToken(binding), provider]);
  return (result.rows[0] as FlowRow | undefined) ?? null;
}

export function createAuth(db: Database, config: AuthConfig) {
  const origin = new URL(config.appOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.appOrigin) throw new Error('AUTH_APP_ORIGIN must be an HTTPS origin');
  if (!config.termsVersion || config.termsVersion.length > 40 || !config.privacyNoticeVersion || config.privacyNoticeVersion.length > 40) {
    throw new Error('Current terms and privacy versions are required');
  }
  const sessionDays = config.sessionDays ?? 14;
  if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 30) throw new Error('Session lifetime must be 1–30 days');
  const sessionSeconds = sessionDays * 86400;
  const callbackUri = (provider: ProviderName) => `${config.appOrigin}/api/auth/${provider}/callback`;

  async function getUser(request: Request): Promise<AuthenticatedUser | null> {
    const token = readCookie(request, sessionCookie);
    if (!token) return null;
    const result = await db.query(`SELECT u.id, u.display_name, u.status FROM mefoot.sessions s
      JOIN mefoot.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`, [hashToken(token)]);
    return (result.rows[0] as AuthenticatedUser | undefined) ?? null;
  }

  async function issueSession(tx: QueryExecutor, request: Request, userId: string): Promise<string> {
    const oldToken = readCookie(request, sessionCookie);
    if (oldToken) await tx.query('DELETE FROM mefoot.sessions WHERE token_hash = $1', [hashToken(oldToken)]);
    const token = randomToken();
    await tx.query(`INSERT INTO mefoot.sessions (token_hash, user_id, expires_at)
      VALUES ($1,$2,now() + make_interval(secs => $3))`, [hashToken(token), userId, sessionSeconds]);
    return cookie(sessionCookie, token, sessionSeconds);
  }

  async function findIdentity(tx: QueryExecutor, identity: Pick<VerifiedIdentity, 'provider' | 'subject'>) {
    const result = await tx.query(`SELECT u.id, u.display_name, u.status FROM mefoot.auth_identities i
      JOIN mefoot.users u ON u.id = i.user_id WHERE i.provider = $1 AND i.provider_subject = $2
      FOR UPDATE OF u`, [identity.provider, identity.subject]);
    return result.rows[0] as { id: string; display_name: string; status: string } | undefined;
  }

  async function start(request: Request, provider: ProviderName): Promise<Response> {
    if (!providerReady(config, provider)) throw new ApiError(503, 'provider_not_configured');
    const params = new URL(request.url).searchParams;
    const teamId = params.get('team_id');
    const intent = params.get('intent') ?? 'view';
    if (!['view', 'follow', 'join'].includes(intent) || (intent !== 'view' && !teamId)) throw new ApiError(400, 'invalid_intent');
    if (teamId) {
      if (!uuidPattern.test(teamId)) throw new ApiError(400, 'invalid_team_id');
      const exists = await db.query('SELECT id FROM mefoot.teams WHERE id = $1 AND archived_at IS NULL', [teamId]);
      if (!exists.rows.length) throw new ApiError(404, 'team_not_found');
    }
    const state = randomToken(), binding = randomToken();
    const flow = { nonce: randomToken(), code_verifier: randomToken() };
    await db.query(`INSERT INTO mefoot.oauth_flows
      (state_hash,binding_hash,provider,nonce,code_verifier,team_id,intent,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now() + interval '10 minutes')`,
    [hashToken(state), hashToken(binding), provider, flow.nonce, flow.code_verifier, teamId, intent]);
    return redirect(authorizationUrl(config, provider, callbackUri(provider), state, flow),
      [cookie(flowCookie(provider), binding, 600, flowSameSite(provider))]);
  }

  async function callback(request: Request, provider: ProviderName): Promise<Response> {
    if (!providerReady(config, provider)) throw new ApiError(503, 'provider_not_configured');
    if ((provider === 'apple') !== (request.method === 'POST')) throw new ApiError(405, 'method_not_allowed');
    let params: URLSearchParams;
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new ApiError(415, 'unsupported_media_type');
      const body = await request.text();
      if (Buffer.byteLength(body) > 16_384) throw new ApiError(413, 'request_too_large');
      params = new URLSearchParams(body);
    } else params = new URL(request.url).searchParams;
    const state = params.get('state') ?? '';
    const binding = readCookie(request, flowCookie(provider));
    if (!binding || params.getAll('state').length !== 1) throw new ApiError(400, 'invalid_oauth_state');
    const flow = await consumeOAuthFlow(db, provider, state, binding);
    if (!flow) throw new ApiError(400, 'invalid_oauth_state');
    const clearFlow = cookie(flowCookie(provider), '', 0, flowSameSite(provider));
    if (params.has('error')) return redirect('/auth/complete?error=login_cancelled', [clearFlow]);
    const code = params.get('code');
    if (!code || code.length > 4096 || params.getAll('code').length !== 1) {
      return redirect('/auth/complete?error=invalid_authorization_code', [clearFlow]);
    }
    let identity: VerifiedIdentity;
    try { identity = await exchangeAuthorizationCode(config, provider, callbackUri(provider), code, flow); }
    catch (error) {
      if (error instanceof OAuthError) return redirect(`/auth/complete?error=${error.code}`, [clearFlow]);
      throw error;
    }
    return await db.transaction(async tx => {
      const existing = await findIdentity(tx, identity);
      if (existing) {
        if (existing.status !== 'active') return redirect('/auth/complete?error=account_unavailable', [clearFlow]);
        await tx.query('UPDATE mefoot.auth_identities SET last_login_at = now() WHERE provider = $1 AND provider_subject = $2',
          [provider, identity.subject]);
        const session = await issueSession(tx, request, existing.id);
        return redirect(nextPath(flow), [clearFlow, cookie(registrationCookie, '', 0), session]);
      }
      const token = randomToken();
      await tx.query(`INSERT INTO mefoot.auth_registrations
        (token_hash,provider,provider_subject,email,email_verified,suggested_name,team_id,intent,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '15 minutes')`,
      [hashToken(token), provider, identity.subject, identity.email, identity.emailVerified,
        identity.suggestedName, flow.team_id, flow.intent]);
      return redirect('/auth/complete', [clearFlow, cookie(registrationCookie, token, 900)]);
    });
  }

  async function registrationInfo(request: Request): Promise<Response> {
    const token = readCookie(request, registrationCookie);
    if (!token) throw new ApiError(401, 'registration_required');
    const result = await db.query(`SELECT provider,suggested_name,team_id,intent FROM mefoot.auth_registrations
      WHERE token_hash = $1 AND expires_at > now()`, [hashToken(token)]);
    const row = result.rows[0] as (ReturnContext & { provider: string; suggested_name: string | null }) | undefined;
    if (!row) throw new ApiError(401, 'registration_expired');
    return privateJson({ provider: row.provider, suggested_name: row.suggested_name,
      terms_version: config.termsVersion, privacy_notice_version: config.privacyNoticeVersion, next: nextPath(row) });
  }

  async function register(request: Request): Promise<Response> {
    requireOrigin(request, config.appOrigin);
    const token = readCookie(request, registrationCookie);
    if (!token) throw new ApiError(401, 'registration_required');
    const input = await readJson(request) as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_body');
    const displayName = typeof input.display_name === 'string' ? input.display_name.trim() : '';
    if (!displayName || [...displayName].length > 30 || /[\u0000-\u001f\u007f]/u.test(displayName)) throw new ApiError(400, 'invalid_display_name');
    if (input.terms_accepted !== true || input.privacy_accepted !== true
      || input.terms_version !== config.termsVersion || input.privacy_notice_version !== config.privacyNoticeVersion) {
      throw new ApiError(400, 'current_consent_required');
    }
    return await db.transaction(async tx => {
      const result = await tx.query(`DELETE FROM mefoot.auth_registrations
        WHERE token_hash = $1 AND expires_at > now()
        RETURNING provider,provider_subject,email,email_verified,suggested_name,team_id,intent`, [hashToken(token)]);
      const pending = result.rows[0] as RegistrationRow | undefined;
      if (!pending) throw new ApiError(401, 'registration_expired');
      // Serialize first signups for this provider identity, even across browsers.
      // Email is never an account-merging key.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${pending.provider}:${pending.provider_subject}`]);
      let user = await findIdentity(tx, { provider: pending.provider, subject: pending.provider_subject });
      if (!user) {
        const created = await tx.query(`INSERT INTO mefoot.users
          (display_name,terms_version,privacy_notice_version,consented_at)
          VALUES ($1,$2,$3,now()) RETURNING id,display_name,status`,
        [displayName, config.termsVersion, config.privacyNoticeVersion]);
        user = created.rows[0] as { id: string; display_name: string; status: string };
        await tx.query(`INSERT INTO mefoot.auth_identities (user_id,provider,provider_subject,email,email_verified,last_login_at)
          VALUES ($1,$2,$3,$4,$5,now())`, [user.id,pending.provider,pending.provider_subject,pending.email,pending.email_verified]);
      } else {
        if (user.status !== 'active') throw new ApiError(403, 'account_unavailable');
        await tx.query('UPDATE mefoot.auth_identities SET last_login_at = now() WHERE provider = $1 AND provider_subject = $2',
          [pending.provider, pending.provider_subject]);
      }
      const session = await issueSession(tx, request, user.id);
      return privateJson({ user, next: nextPath(pending) }, 201, [cookie(registrationCookie, '', 0), session]);
    });
  }

  async function handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (path === '/api/auth/providers' && request.method === 'GET') {
      return privateJson({ providers: providerNames.map(provider => ({ id: provider,
        name: ({ kakao: '카카오', google: 'Google', apple: 'Apple' })[provider],
        enabled: providerReady(config, provider) })) });
    }
    if (path === '/api/me' && request.method === 'GET') {
      const user = await getUser(request);
      if (!user) throw new ApiError(401, 'authentication_required');
      return privateJson({ user });
    }
    if (path === '/api/auth/registration' && request.method === 'GET') return registrationInfo(request);
    if (path === '/api/auth/register' && request.method === 'POST') return register(request);
    if (path === '/api/auth/logout' && request.method === 'POST') {
      requireOrigin(request, config.appOrigin);
      const token = readCookie(request, sessionCookie);
      if (token) await db.query('DELETE FROM mefoot.sessions WHERE token_hash = $1', [hashToken(token)]);
      return privateJson({ ok: true }, 200, [cookie(sessionCookie, '', 0), cookie(registrationCookie, '', 0)]);
    }
    const match = /^\/api\/auth\/(google|kakao|apple)\/(start|callback)$/.exec(path);
    if (match) {
      const provider = match[1] as ProviderName;
      if (match[2] === 'start' && request.method === 'GET') return start(request, provider);
      if (match[2] === 'callback' && ['GET', 'POST'].includes(request.method)) return callback(request, provider);
      throw new ApiError(405, 'method_not_allowed');
    }
    return null;
  }
  return { handle, getUser };
}
