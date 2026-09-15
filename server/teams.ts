import { randomUUID } from 'node:crypto';
import type { Database, QueryExecutor } from './db.ts';
import { ApiError, json, readJson, requireUser } from './http.ts';
import type { AuthenticatedUser } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_FIELDS = 'id, name, description, sport, region_label, logo_url, join_requests_open, created_at, updated_at';
const REQUEST_FIELDS = 'id, team_id, user_id, status, message, created_at, resolved_at, resolved_by_user_id, resolution_note';

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, 'invalid_id');
  return value.toLowerCase();
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ApiError(400, 'unknown_field');
}

function text(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_text');
  const result = value.trim();
  if ((required && !result) || [...result].length > max) throw new ApiError(400, 'invalid_text');
  return result;
}

function optionalText(value: unknown, max: number): string | null {
  return value === undefined || value === null ? null : text(value, max);
}

function page(url: URL, maximum = 50): { limit: number; offset: number } {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = url.searchParams.get(name);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new ApiError(400, 'invalid_pagination');
    }
    return Number(value);
  };
  return { limit: read('limit', 20, 1, maximum), offset: read('offset', 0, 0, 10000) };
}

async function lockedTeam(tx: QueryExecutor, id: string, allowArchived = false): Promise<any> {
  const result = await tx.query('SELECT * FROM mefoot.teams WHERE id = $1 FOR UPDATE', [id]);
  const team = result.rows[0];
  if (!team) throw new ApiError(404, 'team_not_found');
  if (team.archived_at && !allowArchived) throw new ApiError(409, 'team_archived');
  return team;
}

// All team mutations lock the team first, then involved users in UUID order.
async function lockUsers(tx: QueryExecutor, ids: string[]): Promise<Map<string, any>> {
  const result = await tx.query(
    'SELECT id, status FROM mefoot.users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [[...new Set(ids)].sort()],
  );
  return new Map(result.rows.map((user) => [user.id, user]));
}

function active(users: Map<string, any>, id: string, actor = false): void {
  if (users.get(id)?.status !== 'active') throw new ApiError(actor ? 403 : 409, actor ? 'user_inactive' : 'member_inactive');
}

async function membership(tx: QueryExecutor, teamId: string, userId: string): Promise<any | null> {
  const result = await tx.query(
    'SELECT team_id, user_id, role, joined_at FROM mefoot.team_memberships WHERE team_id = $1 AND user_id = $2',
    [teamId, userId],
  );
  return result.rows[0] ?? null;
}

async function admin(tx: QueryExecutor, team: any, actorId: string): Promise<void> {
  if (team.owner_user_id === actorId) return;
  if ((await membership(tx, team.id, actorId))?.role !== 'admin') throw new ApiError(403, 'team_admin_required');
}

function ownRequest(row: any, teamId: string, userId: string): void {
  if (row.team_id !== teamId || row.user_id !== userId) throw new ApiError(409, 'request_id_conflict');
}

async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  return request.body === null ? {} : readJson(request);
}

async function createTeam(request: Request, user: AuthenticatedUser, db: Database): Promise<Response> {
  const body = await readJson(request);
  fields(body, ['name', 'description', 'sport', 'region_label', 'logo_url', 'join_requests_open']);
  const name = text(body.name, 60, true);
  const description = text(body.description, 2000);
  if (typeof body.sport !== 'string' || !['football', 'futsal', 'both'].includes(body.sport)) throw new ApiError(400, 'invalid_sport');
  const region = optionalText(body.region_label, 100);
  const logo = optionalText(body.logo_url, 2048);
  if (logo) {
    try { if (new URL(logo).protocol !== 'https:') throw new Error(); }
    catch { throw new ApiError(400, 'invalid_logo_url'); }
  }
  if (body.join_requests_open !== undefined && typeof body.join_requests_open !== 'boolean') {
    throw new ApiError(400, 'invalid_join_setting');
  }
  const result = await db.transaction(async (tx) => {
    // A new team has no existing row to lock. Its UUID cannot be used by another
    // request until commit; only the creating user's row needs locking here.
    active(await lockUsers(tx, [user.id]), user.id, true);
    const team = await tx.query(
      `INSERT INTO mefoot.teams (id, owner_user_id, name, description, sport, region_label, logo_url, join_requests_open)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${TEAM_FIELDS}`,
      [randomUUID(), user.id, name, description, body.sport, region, logo, body.join_requests_open ?? true],
    );
    await tx.query("INSERT INTO mefoot.team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')", [team.rows[0].id, user.id]);
    return team.rows[0];
  });
  return json({ team: result, membership: { role: 'owner' } }, 201);
}

async function listTeams(url: URL, db: Database): Promise<Response> {
  const { limit, offset } = page(url);
  const search = text(url.searchParams.get('q') ?? '', 100);
  const result = await db.query(
    `SELECT ${TEAM_FIELDS} FROM mefoot.teams WHERE archived_at IS NULL
     AND ($1 = '' OR strpos(lower(name), lower($1)) > 0)
     ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [search, limit, offset],
  );
  return json({ teams: result.rows, limit, offset });
}

async function detail(teamId: string, user: AuthenticatedUser | null, db: Database): Promise<Response> {
  const result = await db.query(`SELECT ${TEAM_FIELDS} FROM mefoot.teams WHERE id = $1 AND archived_at IS NULL`, [teamId]);
  if (!result.rows[0]) throw new ApiError(404, 'team_not_found');
  let me = null;
  if (user) {
    const current = await db.query(
      `SELECT EXISTS(SELECT 1 FROM mefoot.team_follows WHERE team_id = $1 AND user_id = $2) AS following,
       (SELECT jsonb_build_object('role', CASE WHEN t.owner_user_id = $2 THEN 'owner' ELSE m.role END, 'joined_at', m.joined_at)
        FROM mefoot.team_memberships m JOIN mefoot.teams t ON t.id = m.team_id
        WHERE m.team_id = $1 AND m.user_id = $2) AS membership,
       (SELECT jsonb_build_object('id', id, 'status', status, 'message', message, 'created_at', created_at,
          'resolved_at', resolved_at, 'resolution_note', resolution_note)
        FROM mefoot.team_join_requests WHERE team_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 1) AS join_request`,
      [teamId, user.id],
    );
    me = current.rows[0];
  }
  return json({ team: result.rows[0], me });
}

async function myTeams(url: URL, user: AuthenticatedUser, db: Database): Promise<Response> {
  const { limit, offset } = page(url);
  const result = await db.query(
    `SELECT t.id, t.name, t.description, t.sport, t.region_label, t.logo_url, t.join_requests_open,
       t.archived_at, t.created_at, t.updated_at,
       CASE WHEN t.owner_user_id = $1 THEN 'owner' ELSE m.role END AS role, m.joined_at,
       (f.user_id IS NOT NULL) AS following, r.id AS pending_request_id
     FROM mefoot.teams t
     LEFT JOIN mefoot.team_memberships m ON m.team_id = t.id AND m.user_id = $1
     LEFT JOIN mefoot.team_follows f ON f.team_id = t.id AND f.user_id = $1
     LEFT JOIN mefoot.team_join_requests r ON r.team_id = t.id AND r.user_id = $1 AND r.status = 'pending'
     WHERE m.user_id IS NOT NULL OR f.user_id IS NOT NULL OR r.id IS NOT NULL
     ORDER BY t.created_at DESC, t.id DESC LIMIT $2 OFFSET $3`,
    [user.id, limit, offset],
  );
  return json({ teams: result.rows, limit, offset });
}

async function follow(teamId: string, following: boolean, user: AuthenticatedUser, db: Database): Promise<Response> {
  await db.transaction(async (tx) => {
    await lockedTeam(tx, teamId, !following);
    active(await lockUsers(tx, [user.id]), user.id, true);
    if (following) {
      await tx.query('INSERT INTO mefoot.team_follows (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, user.id]);
    } else {
      await tx.query('DELETE FROM mefoot.team_follows WHERE team_id = $1 AND user_id = $2', [teamId, user.id]);
    }
  });
  return json({ following });
}

async function apply(request: Request, teamId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  const body = await readJson(request);
  fields(body, ['request_id', 'message']);
  const requestId = uuid(body.request_id);
  const message = text(body.message, 500);
  const result = await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId, true);
    active(await lockUsers(tx, [user.id]), user.id, true);
    const existing = await tx.query(`SELECT ${REQUEST_FIELDS} FROM mefoot.team_join_requests WHERE id = $1`, [requestId]);
    if (existing.rows[0]) {
      ownRequest(existing.rows[0], teamId, user.id);
      return { payload: { request: existing.rows[0] }, created: false };
    }
    const member = await membership(tx, teamId, user.id);
    if (member) return { payload: { membership: { ...member, role: team.owner_user_id === user.id ? 'owner' : member.role } }, created: false };
    const pending = await tx.query(`SELECT ${REQUEST_FIELDS} FROM mefoot.team_join_requests WHERE team_id = $1 AND user_id = $2 AND status = 'pending'`, [teamId, user.id]);
    if (pending.rows[0]) return { payload: { request: pending.rows[0] }, created: false };
    if (team.archived_at) throw new ApiError(409, 'team_archived');
    if (!team.join_requests_open) throw new ApiError(409, 'join_requests_closed');
    const inserted = await tx.query(
      `INSERT INTO mefoot.team_join_requests (id, team_id, user_id, message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING RETURNING ${REQUEST_FIELDS}`,
      [requestId, teamId, user.id, message],
    );
    if (inserted.rows[0]) return { payload: { request: inserted.rows[0] }, created: true };
    // Another team can submit the same client UUID while our team is locked.
    const raced = await tx.query(`SELECT ${REQUEST_FIELDS} FROM mefoot.team_join_requests WHERE id = $1`, [requestId]);
    if (!raced.rows[0]) throw new ApiError(409, 'request_id_conflict');
    ownRequest(raced.rows[0], teamId, user.id);
    return { payload: { request: raced.rows[0] }, created: false };
  });
  return json(result.payload, result.created ? 201 : 200);
}

async function queue(url: URL, teamId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  const { limit, offset } = page(url, 100);
  const requests = await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId, true);
    active(await lockUsers(tx, [user.id]), user.id, true);
    await admin(tx, team, user.id);
    const result = await tx.query(
      `SELECT r.id, r.team_id, r.user_id, r.status, r.message, r.created_at,
       jsonb_build_object('id', u.id, 'display_name', u.display_name, 'avatar_url', u.avatar_url, 'status', u.status) AS applicant
       FROM mefoot.team_join_requests r JOIN mefoot.users u ON u.id = r.user_id
       WHERE r.team_id = $1 AND r.status = 'pending' ORDER BY r.created_at, r.id LIMIT $2 OFFSET $3`,
      [teamId, limit, offset],
    );
    return result.rows;
  });
  return json({ requests, limit, offset });
}

async function resolve(request: Request, teamId: string, requestId: string, action: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  const body = await optionalBody(request);
  fields(body, action === 'withdraw' ? [] : ['resolution_note']);
  const note = optionalText(body.resolution_note, 300);
  const desired = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'withdrawn';
  const result = await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId, true);
    // Team locking keeps request identity stable while we collect the users to
    // lock. The request itself is locked only after the ordered user locks.
    const found = await tx.query(`SELECT ${REQUEST_FIELDS} FROM mefoot.team_join_requests WHERE id = $1 AND team_id = $2`, [requestId, teamId]);
    if (!found.rows[0]) throw new ApiError(404, 'join_request_not_found');
    const applicantId = found.rows[0].user_id;
    const users = await lockUsers(tx, [user.id, applicantId]);
    active(users, user.id, true);
    if (action === 'withdraw') {
      if (applicantId !== user.id) throw new ApiError(403, 'request_owner_required');
    } else {
      await admin(tx, team, user.id);
      if (applicantId === user.id) throw new ApiError(403, 'self_resolution_forbidden');
    }
    const locked = await tx.query(`SELECT ${REQUEST_FIELDS} FROM mefoot.team_join_requests WHERE id = $1 AND team_id = $2 FOR UPDATE`, [requestId, teamId]);
    const row = locked.rows[0];
    if (row.status === desired) return row;
    if (row.status !== 'pending') throw new ApiError(409, 'request_already_resolved');
    if (action !== 'withdraw' && team.archived_at) throw new ApiError(409, 'team_archived');
    if (action === 'approve') {
      active(users, applicantId);
      if (await membership(tx, teamId, applicantId)) throw new ApiError(409, 'already_team_member');
      await tx.query("INSERT INTO mefoot.team_memberships (team_id, user_id, role) VALUES ($1, $2, 'member')", [teamId, applicantId]);
    }
    const updated = await tx.query(
      `UPDATE mefoot.team_join_requests SET status = $3, resolved_at = clock_timestamp(), resolved_by_user_id = $4, resolution_note = $5
       WHERE id = $1 AND team_id = $2 RETURNING ${REQUEST_FIELDS}`,
      [requestId, teamId, desired, user.id, note],
    );
    return updated.rows[0];
  });
  return json({ request: result });
}

async function leave(teamId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId, true);
    active(await lockUsers(tx, [user.id]), user.id, true);
    if (team.owner_user_id === user.id) throw new ApiError(409, 'owner_transfer_required');
    await tx.query('DELETE FROM mefoot.team_memberships WHERE team_id = $1 AND user_id = $2', [teamId, user.id]);
  });
  return json({ membership: null });
}

async function transfer(request: Request, teamId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  const body = await readJson(request);
  fields(body, ['user_id']);
  const targetId = uuid(body.user_id);
  await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId);
    const users = await lockUsers(tx, [user.id, targetId]);
    active(users, user.id, true);
    if (team.owner_user_id !== user.id) throw new ApiError(403, 'team_owner_required');
    const target = await membership(tx, teamId, targetId);
    if (!target) throw new ApiError(409, 'target_not_team_member');
    active(users, targetId);
    await tx.query('UPDATE mefoot.teams SET owner_user_id = $2 WHERE id = $1', [teamId, targetId]);
  });
  return json({ owner_user_id: targetId });
}

async function changeRole(request: Request, teamId: string, targetId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  const body = await readJson(request);
  fields(body, ['role']);
  if (body.role !== 'member' && body.role !== 'admin') throw new ApiError(400, 'invalid_role');
  await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId);
    const users = await lockUsers(tx, [user.id, targetId]);
    active(users, user.id, true);
    if (team.owner_user_id !== user.id) throw new ApiError(403, 'team_owner_required');
    if (!(await membership(tx, teamId, targetId))) throw new ApiError(404, 'team_member_not_found');
    active(users, targetId);
    await tx.query('UPDATE mefoot.team_memberships SET role = $3 WHERE team_id = $1 AND user_id = $2', [teamId, targetId, body.role]);
  });
  return json({ user_id: targetId, role: body.role });
}

async function qr(url: URL, teamId: string, user: AuthenticatedUser, db: Database): Promise<Response> {
  await db.transaction(async (tx) => {
    const team = await lockedTeam(tx, teamId);
    active(await lockUsers(tx, [user.id]), user.id, true);
    await admin(tx, team, user.id);
  });
  return json({ url: `${url.origin}/t/${teamId}` });
}

export async function handleTeams(request: Request, user: AuthenticatedUser | null, db: Database): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/me/teams') {
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    return myTeams(url, requireUser(user), db);
  }
  if (path === '/api/teams') {
    if (method === 'GET') return listTeams(url, db);
    if (method === 'POST') return createTeam(request, requireUser(user), db);
    throw new ApiError(405, 'method_not_allowed');
  }
  const match = path.match(/^\/api\/teams\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const teamId = uuid(match[1]);
  const suffix = match[2] ?? '';
  if (!suffix) {
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    return detail(teamId, user, db);
  }
  if (suffix === 'follow') {
    if (method !== 'PUT' && method !== 'DELETE') throw new ApiError(405, 'method_not_allowed');
    return follow(teamId, method === 'PUT', requireUser(user), db);
  }
  if (suffix === 'join-requests') {
    if (method === 'POST') return apply(request, teamId, requireUser(user), db);
    if (method === 'GET') return queue(url, teamId, requireUser(user), db);
    throw new ApiError(405, 'method_not_allowed');
  }
  const resolution = suffix.match(/^join-requests\/([^/]+)\/(approve|reject|withdraw)$/);
  if (resolution) {
    if (method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    return resolve(request, teamId, uuid(resolution[1]), resolution[2], requireUser(user), db);
  }
  if (suffix === 'leave') {
    if (method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    return leave(teamId, requireUser(user), db);
  }
  if (suffix === 'owner') {
    if (method !== 'PUT') throw new ApiError(405, 'method_not_allowed');
    return transfer(request, teamId, requireUser(user), db);
  }
  const role = suffix.match(/^members\/([^/]+)\/role$/);
  if (role) {
    if (method !== 'PUT') throw new ApiError(405, 'method_not_allowed');
    return changeRole(request, teamId, uuid(role[1]), requireUser(user), db);
  }
  if (suffix === 'qr') {
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    return qr(url, teamId, requireUser(user), db);
  }
  return null;
}
