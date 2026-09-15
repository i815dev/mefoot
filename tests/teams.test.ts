import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTeams } from '../server/teams.ts';
import { ApiError } from '../server/http.ts';
import type { Database, QueryExecutor } from '../server/db.ts';
import type { AuthenticatedUser } from '../server/types.ts';

const TEAM = '10000000-0000-4000-8000-000000000001';
const OTHER_TEAM = '10000000-0000-4000-8000-000000000002';
const OWNER = '20000000-0000-4000-8000-000000000001';
const MEMBER = '20000000-0000-4000-8000-000000000002';
const APPLICANT = '20000000-0000-4000-8000-000000000003';
const REQUEST = '30000000-0000-4000-8000-000000000001';
const user = (id: string): AuthenticatedUser => ({ id, display_name: '테스트 회원', status: 'active' });
const team = { id: TEAM, owner_user_id: OWNER, archived_at: null, join_requests_open: true };
const pending = { id: REQUEST, team_id: TEAM, user_id: APPLICANT, status: 'pending', message: '함께 운동하고 싶어요.' };

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://mefoot.example${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

// This fake only supplies read results for routing and authorization tests.
// Transaction atomicity, constraints, and concurrent requests use PostgreSQL.
function fake(read: (sql: string, params: unknown[]) => any[] = () => []): Database & { writes: string[]; calls: number } {
  const db = {
    writes: [] as string[], calls: 0,
    async query(sql: string, params: unknown[] = []) {
      db.calls += 1;
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) db.writes.push(sql);
      const rows = read(sql, params);
      return { rows, rowCount: rows.length };
    },
    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>) { return fn(db); },
  };
  return db;
}

function fixture(overrides: { request?: any; applicantStatus?: string; actorStatus?: string; owner?: string; admin?: boolean } = {}) {
  return fake((sql, params) => {
    if (sql.includes('FROM mefoot.teams') && sql.includes('FOR UPDATE')) return [{ ...team, owner_user_id: overrides.owner ?? OWNER }];
    if (sql.includes('FROM mefoot.users')) return (params[0] as string[]).map((id) => ({
      id, status: id === APPLICANT ? overrides.applicantStatus ?? 'active' : overrides.actorStatus ?? 'active',
    }));
    if (sql.includes('FROM mefoot.team_join_requests')) return [overrides.request ?? pending];
    if (sql.includes('FROM mefoot.team_memberships')) return overrides.admin ? [{ team_id: TEAM, user_id: params[1], role: 'admin' }] : [];
    return [];
  });
}

async function rejectsCode(action: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ApiError && error.status === status && error.code === code);
}

test('every private team operation requires a session before database access', async () => {
  const privateRoutes: Array<[string, string, unknown?]> = [
    ['/api/teams', 'POST', { name: '팀', sport: 'futsal' }], ['/api/me/teams', 'GET'],
    [`/api/teams/${TEAM}/follow`, 'PUT'], [`/api/teams/${TEAM}/follow`, 'DELETE'],
    [`/api/teams/${TEAM}/join-requests`, 'POST', { request_id: REQUEST }],
    [`/api/teams/${TEAM}/join-requests`, 'GET'],
    ...['approve', 'reject', 'withdraw'].map((action): [string, string] => [`/api/teams/${TEAM}/join-requests/${REQUEST}/${action}`, 'POST']),
    [`/api/teams/${TEAM}/leave`, 'POST'], [`/api/teams/${TEAM}/owner`, 'PUT', { user_id: MEMBER }],
    [`/api/teams/${TEAM}/members/${MEMBER}/role`, 'PUT', { role: 'admin' }], [`/api/teams/${TEAM}/qr`, 'GET'],
  ];
  for (const [path, method, body] of privateRoutes) {
    const db = fake();
    await rejectsCode(handleTeams(request(path, method, body), null, db), 401, 'authentication_required');
    assert.equal(db.calls, 0, path);
  }
});

test('invalid UUID paths and invalid pagination are rejected without querying PostgreSQL', async () => {
  for (const path of ['/api/teams/not-a-uuid', '/api/teams?limit=1000000', '/api/teams?offset=-1', '/api/teams?limit=2.5']) {
    const db = fake();
    await assert.rejects(handleTeams(request(path), null, db), (error: unknown) => error instanceof ApiError && error.status === 400);
    assert.equal(db.calls, 0);
  }
});

test('team creation rejects client-supplied ownership instead of trusting it', async () => {
  const db = fake();
  await rejectsCode(handleTeams(request('/api/teams', 'POST', { name: '팀', sport: 'futsal', owner_user_id: OWNER }), user(MEMBER), db), 400, 'unknown_field');
  assert.equal(db.calls, 0);
});

test('team creation does not coerce arrays or objects into a valid sport', async () => {
  for (const sport of [['futsal'], { value: 'football' }]) {
    const db = fake();
    await rejectsCode(handleTeams(request('/api/teams', 'POST', { name: '팀', sport }), user(OWNER), db), 400, 'invalid_sport');
    assert.equal(db.calls, 0);
  }
});

test('application rejects spoofed applicant, status, or approval fields', async () => {
  for (const extra of [{ user_id: OWNER }, { status: 'approved' }, { resolved_by_user_id: OWNER }]) {
    const db = fake();
    await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests`, 'POST', { request_id: REQUEST, ...extra }), user(APPLICANT), db), 400, 'unknown_field');
    assert.equal(db.calls, 0);
  }
});

test('role updates accept only the two assignable roles', async () => {
  const db = fake();
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/members/${MEMBER}/role`, 'PUT', { role: 'owner' }), user(OWNER), db), 400, 'invalid_role');
  assert.equal(db.calls, 0);
});

test('membership and message validation uses Unicode character limits', async () => {
  const db = fake();
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests`, 'POST', { request_id: REQUEST, message: '⚽'.repeat(501) }), user(APPLICANT), db), 400, 'invalid_text');
  assert.equal(db.calls, 0);
});

test('a suspended account with an older active session cannot mutate teams', async () => {
  const db = fixture({ actorStatus: 'suspended' });
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/follow`, 'PUT'), user(MEMBER), db), 403, 'user_inactive');
  assert.deepEqual(db.writes, []);
});

test('ordinary members cannot approve or reject applications', async () => {
  for (const action of ['approve', 'reject']) {
    const db = fixture();
    await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/${action}`, 'POST'), user(MEMBER), db), 403, 'team_admin_required');
    assert.deepEqual(db.writes, []);
  }
});

test('an operator cannot approve their own request', async () => {
  const db = fixture({ admin: true });
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/approve`, 'POST'), user(APPLICANT), db), 403, 'self_resolution_forbidden');
  assert.deepEqual(db.writes, []);
});

test('an operator cannot withdraw another member’s request', async () => {
  const db = fixture();
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/withdraw`, 'POST'), user(OWNER), db), 403, 'request_owner_required');
  assert.deepEqual(db.writes, []);
});

test('approval rejects an applicant whose account was suspended while pending', async () => {
  const db = fixture({ applicantStatus: 'suspended' });
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/approve`, 'POST'), user(OWNER), db), 409, 'member_inactive');
  assert.deepEqual(db.writes, []);
});

test('a team owner must transfer ownership before leaving', async () => {
  const db = fixture();
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/leave`, 'POST'), user(OWNER), db), 409, 'owner_transfer_required');
  assert.deepEqual(db.writes, []);
});

test('operations users cannot transfer ownership or appoint other operators', async () => {
  for (const [path, body] of [
    [`/api/teams/${TEAM}/owner`, { user_id: APPLICANT }],
    [`/api/teams/${TEAM}/members/${APPLICANT}/role`, { role: 'admin' }],
  ] as const) {
    const db = fixture({ admin: true });
    await rejectsCode(handleTeams(request(path, 'PUT', body), user(MEMBER), db), 403, 'team_owner_required');
    assert.deepEqual(db.writes, []);
  }
});

test('a previously completed request cannot be changed to a different outcome', async () => {
  const db = fixture({ request: { ...pending, status: 'rejected' } });
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/approve`, 'POST'), user(OWNER), db), 409, 'request_already_resolved');
  assert.deepEqual(db.writes, []);
});

test('a matching completed approval is returned unchanged on a valid retry', async () => {
  const approved = { ...pending, status: 'approved', resolved_by_user_id: OWNER };
  const db = fixture({ request: approved });
  const response = await handleTeams(request(`/api/teams/${TEAM}/join-requests/${REQUEST}/approve`, 'POST'), user(OWNER), db);
  assert.equal(response?.status, 200);
  assert.deepEqual(await response?.json(), { request: approved });
  assert.deepEqual(db.writes, []);
});

test('idempotency IDs belonging to another team or person are never reused', async () => {
  for (const existing of [{ ...pending, team_id: OTHER_TEAM }, { ...pending, user_id: MEMBER }]) {
    const db = fixture({ request: existing });
    await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/join-requests`, 'POST', { request_id: REQUEST }), user(APPLICANT), db), 409, 'request_id_conflict');
    assert.deepEqual(db.writes, []);
  }
});

test('the QR endpoint returns only a public team link and requires an operator', async () => {
  const db = fixture();
  const response = await handleTeams(request(`/api/teams/${TEAM}/qr`), user(OWNER), db);
  assert.deepEqual(await response?.json(), { url: `https://mefoot.example/t/${TEAM}` });
  await rejectsCode(handleTeams(request(`/api/teams/${TEAM}/qr`), user(MEMBER), db), 403, 'team_admin_required');
});

test('SQL metacharacters in public search stay in bound parameters', async () => {
  const search = "'; DROP TABLE mefoot.users; --";
  const db = fake((sql, params) => {
    assert.ok(!sql.includes(search));
    assert.equal(params[0], search);
    return [];
  });
  const response = await handleTeams(request(`/api/teams?q=${encodeURIComponent(search)}`), null, db);
  assert.deepEqual(await response?.json(), { teams: [], limit: 20, offset: 0 });
});
