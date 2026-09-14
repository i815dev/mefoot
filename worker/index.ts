declare const RELEASE_SHA: string;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ENV: string;
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
      }
      if (pathname === '/api/health') {
        return json({ status: 'ok', service: 'mefoot', scope: 'worker-only' });
      }
      if (pathname === '/api/version') {
        return json({
          service: 'mefoot',
          environment: env.APP_ENV,
          version: typeof RELEASE_SHA === 'string' ? RELEASE_SHA : 'local',
        });
      }
      return json({ error: 'not_found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
