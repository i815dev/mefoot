declare const RELEASE_SHA: string;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  APP_ENV: string;
  API_ORIGIN?: string;
  EDGE_SHARED_KEY?: string;
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
      if (['/api/health', '/api/version'].includes(pathname) && request.method !== 'GET') {
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
      if (env.API_ORIGIN && env.EDGE_SHARED_KEY) {
        let upstream: URL;
        try {
          upstream = new URL(env.API_ORIGIN);
          if (upstream.protocol !== 'https:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash)
            throw new Error('Invalid API origin');
        } catch { return json({ error: 'api_configuration_invalid' }, 503); }
        const incoming = new URL(request.url);
        upstream.pathname = incoming.pathname;
        upstream.search = incoming.search;
        const headers = new Headers();
        for (const name of ['accept', 'content-type', 'cookie', 'origin']) {
          const value = request.headers.get(name); if (value) headers.set(name, value);
        }
        headers.set('x-mefoot-edge-key', env.EDGE_SHARED_KEY);
        headers.set('x-mefoot-client-ip', request.headers.get('cf-connecting-ip') || 'unknown');
        try {
          const response = await fetch(upstream, {
            method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
            redirect: 'manual', signal: AbortSignal.timeout(15_000),
          });
          const result = new Response(response.body, response);
          result.headers.set('cache-control', 'no-store');
          result.headers.set('x-content-type-options', 'nosniff');
          return result;
        } catch { return json({ error: 'api_unavailable' }, 503); }
      }
      return json({ error: 'not_found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};
