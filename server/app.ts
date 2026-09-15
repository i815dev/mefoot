import { createHash, timingSafeEqual } from 'node:crypto';
import { createAuth } from './auth.ts';
import { handleTeams } from './teams.ts';
import { ApiError, json } from './http.ts';
import type { AppConfig } from './config.ts';
import type { Database } from './db.ts';

export function createApp(db: Database, config: AppConfig) {
  const auth = createAuth(db, config.auth);
  const expectedKey = createHash('sha256').update(config.edgeKey).digest();
  const buckets = new Map<string, { count: number; resets: number }>();
  return async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/healthz' && request.method === 'GET') return json({ status: 'ok', scope: 'process', version: config.version });
      const key = createHash('sha256').update(request.headers.get('x-mefoot-edge-key') || '').digest();
      if (!timingSafeEqual(key, expectedKey)) throw new ApiError(403, 'edge_access_required');
      const now = Date.now();
      const bucketKey = `${request.headers.get('x-mefoot-client-ip') || 'unknown'}:${path.startsWith('/api/auth/') ? 'auth' : 'api'}`;
      if (buckets.size >= 10000) for (const [name, bucket] of buckets) if (bucket.resets <= now) buckets.delete(name);
      if (!buckets.has(bucketKey) && buckets.size >= 10000) throw new ApiError(429, 'too_many_requests');
      let bucket = buckets.get(bucketKey);
      if (!bucket || bucket.resets <= now) { bucket = { count: 0, resets: now + 60_000 }; buckets.set(bucketKey, bucket); }
      if (++bucket.count > (path.startsWith('/api/auth/') ? 30 : 180)) throw new ApiError(429, 'too_many_requests');
      if (!['GET', 'HEAD'].includes(request.method) && path !== '/api/auth/apple/callback') {
        if (request.headers.get('origin') !== config.auth.appOrigin) throw new ApiError(403, 'invalid_origin');
      }
      if (path === '/api/health/db' && request.method === 'GET') {
        await db.query('SELECT id FROM mefoot.users LIMIT 0');
        return json({ status: 'ok', scope: 'api-and-database', version: config.version });
      }
      const authResponse = await auth.handle(request);
      if (authResponse) return authResponse;
      const user = await auth.getUser(request);
      const teamResponse = await handleTeams(request, user, db);
      return teamResponse || json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.code }, error.status);
      const code = (error as { code?: string }).code;
      if (code === '23505') return json({ error: 'conflict' }, 409);
      if (code === '55P03' || code === '40P01' || code === '57014') return json({ error: 'retry_request' }, 503);
      // Do not log SQL, authorization codes, cookies, or provider responses.
      console.error(JSON.stringify({ event: 'request_failed', category: code || 'internal' }));
      return json({ error: 'internal_error' }, 500);
    }
  };
}
