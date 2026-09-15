import type { AuthenticatedUser } from './types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code); this.status = status; this.code = code;
  }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
export function requireUser(user: AuthenticatedUser | null): AuthenticatedUser {
  if (!user || user.status !== 'active') throw new ApiError(401, 'authentication_required');
  return user;
}
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new ApiError(415, 'json_required');
  const text = await request.text();
  if (Buffer.byteLength(text) > 16_384) throw new ApiError(413, 'body_too_large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ApiError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_json');
  return value as Record<string, unknown>;
}
