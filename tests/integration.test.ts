import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { consumeOAuthFlow, hashToken } from '../server/auth.ts';
import { createPool, databaseFromPool } from '../server/db.ts';
import type { AppConfig } from '../server/config.ts';

const enabled = process.env.MEFOOT_INTEGRATION === '1';
const origin = 'https://example.test';
const config: AppConfig = {
  edgeKey: 'integration-test-edge-key-never-use-in-production',
  version: 'integration-test',
  auth: { appOrigin: origin, termsVersion: 'integration-v1', privacyNoticeVersion: 'integration-v1' },
};
const token = () => randomBytes(32).toString('base64url');

test('PostgreSQL API: real sessions, permission boundaries, concurrent approvals, and one-use auth state',
  { skip: enabled ? false : 'Set MEFOOT_INTEGRATION=1 with PostgreSQL application credentials', timeout: 120_000 },
  async () => {
    const pool = createPool();
    const db = databaseFromPool(pool);
    const app = createApp(db, config);
    const runId = randomUUID();
    const owner = randomUUID(), applicant = randomUUID(), stranger = randomUUID();
    const userIds: string[] = [owner, applicant, stranger];
    const teamIds: string[] = [];
    const oauthHashes: string[] = [];
    const registrationHashes: string[] = [];
    const providerSubject = `integration:${runId}`;
    const sessions = new Map(userIds.map((id) => [id, token()]));

    async function call(path: string, method = 'GET', actor?: string, body?: unknown,
      extra: Record<string, string> = {}): Promise<Response> {
      const headers = new Headers({ 'x-mefoot-edge-key': config.edgeKey, 'x-mefoot-client-ip': runId, origin, ...extra });
      if (actor) headers.set('cookie', `__Host-mefoot_session=${sessions.get(actor)}`);
      if (body !== undefined) headers.set('content-type', 'application/json');
      return app(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    }

    async function body(response: Response, status: number): Promise<any> {
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result;
    }

    try {
      const identity = await db.query(`SELECT current_user AS name, r.rolsuper, r.rolcreatedb, r.rolcreaterole
        FROM pg_roles r WHERE r.rolname = current_user`);
      assert.equal(identity.rows[0]?.name, 'mefoot_app', 'Integration must exercise the application role');
      assert.equal(identity.rows[0]?.rolsuper, false);
      assert.equal(identity.rows[0]?.rolcreatedb, false);
      assert.equal(identity.rows[0]?.rolcreaterole, false);
      await db.transaction(async (tx) => {
        for (const [index, id] of userIds.entries()) {
          await tx.query(`INSERT INTO mefoot.users (id, display_name, terms_version, privacy_notice_version, consented_at)
            VALUES ($1,$2,$3,$3,now())`, [id, `통합검증 ${index}`, config.auth.termsVersion]);
          await tx.query(`INSERT INTO mefoot.sessions (token_hash,user_id,expires_at)
            VALUES ($1,$2,now()+interval '1 hour')`, [hashToken(sessions.get(id)!), id]);
        }
      });

      // Session identity must come from a stored cookie, and writes must pass
      // the same edge key and browser-origin checks used by the deployed API.
      assert.equal((await call('/api/me')).status, 401);
      assert.equal((await call('/api/me', 'GET', owner, undefined, { 'x-mefoot-edge-key': 'wrong' })).status, 403);
      assert.equal((await body(await call('/api/me', 'GET', owner), 200)).user.id, owner);
      assert.equal((await call('/api/teams', 'POST', owner, { name: '차단 테스트', sport: 'futsal' }, { origin: 'https://attacker.example' })).status, 403);

      const created = await body(await call('/api/teams', 'POST', owner, {
        name: `통합검증 ${runId}`, sport: 'futsal', description: '자동 검증 후 삭제되는 팀', region_label: '검증 지역',
      }), 201);
      const teamId: string = created.team.id;
      teamIds.push(teamId);
      assert.equal(created.membership.role, 'owner');
      const publicDetail = await body(await call(`/api/teams/${teamId}`), 200);
      assert.equal(publicDetail.me, null);
      assert.equal(Object.hasOwn(publicDetail.team, 'owner_user_id'), false);
      assert.equal(Object.hasOwn(publicDetail, 'members'), false);

      const follows = await Promise.all([call(`/api/teams/${teamId}/follow`, 'PUT', applicant), call(`/api/teams/${teamId}/follow`, 'PUT', applicant)]);
      assert.deepEqual(follows.map((response) => response.status), [200, 200]);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.team_follows WHERE team_id=$1 AND user_id=$2', [teamId, applicant])).rows[0].n), 1);

      const firstRequest = randomUUID(), duplicateRequest = randomUUID();
      const applications = await Promise.all([
        call(`/api/teams/${teamId}/join-requests`, 'POST', applicant, { request_id: firstRequest, message: '첫 신청' }),
        call(`/api/teams/${teamId}/join-requests`, 'POST', applicant, { request_id: duplicateRequest, message: '중복 신청' }),
      ]);
      assert.deepEqual(applications.map((response) => response.status).sort(), [200, 201]);
      const applied = await Promise.all(applications.map((response) => response.json()));
      assert.equal(applied[0].request.id, applied[1].request.id);
      const joinId: string = applied[0].request.id;
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM mefoot.team_join_requests WHERE team_id=$1 AND user_id=$2 AND status='pending'", [teamId, applicant])).rows[0].n), 1);

      assert.equal((await call(`/api/teams/${teamId}/join-requests/${joinId}/approve`, 'POST', stranger)).status, 403);
      assert.equal((await call(`/api/teams/${teamId}/join-requests`, 'GET', applicant)).status, 403);
      const queue = await body(await call(`/api/teams/${teamId}/join-requests`, 'GET', owner), 200);
      assert.equal(queue.requests.length, 1);
      assert.equal(queue.requests[0].applicant.id, applicant);
      assert.equal(Object.hasOwn(queue.requests[0].applicant, 'email'), false);

      const approvals = await Promise.all([
        call(`/api/teams/${teamId}/join-requests/${joinId}/approve`, 'POST', owner),
        call(`/api/teams/${teamId}/join-requests/${joinId}/approve`, 'POST', owner),
      ]);
      assert.deepEqual(approvals.map((response) => response.status), [200, 200]);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.team_memberships WHERE team_id=$1 AND user_id=$2', [teamId, applicant])).rows[0].n), 1);
      const approved = (await db.query('SELECT status,resolved_by_user_id FROM mefoot.team_join_requests WHERE id=$1', [joinId])).rows[0];
      assert.equal(approved.status, 'approved');
      assert.equal(approved.resolved_by_user_id, owner);

      assert.equal((await call(`/api/teams/${teamId}/leave`, 'POST', owner)).status, 409);
      assert.equal((await call(`/api/teams/${teamId}/owner`, 'PUT', applicant, { user_id: stranger })).status, 403);
      await body(await call(`/api/teams/${teamId}/owner`, 'PUT', owner, { user_id: applicant }), 200);
      await body(await call(`/api/teams/${teamId}/leave`, 'POST', owner), 200);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.team_memberships WHERE team_id=$1 AND user_id=$2', [teamId, owner])).rows[0].n), 0);
      assert.equal((await db.query('SELECT status FROM mefoot.team_join_requests WHERE id=$1', [joinId])).rows[0].status, 'approved');
      assert.equal((await call(`/api/teams/${teamId}/join-requests`, 'GET', owner)).status, 403);
      const qr = await body(await call(`/api/teams/${teamId}/qr`, 'GET', applicant), 200);
      assert.equal(qr.url, `${origin}/t/${teamId}`);

      // Whichever team-row lock is acquired first wins. The opposite outcome
      // must receive 409, and current membership must match the final outcome.
      const raceId = randomUUID();
      await body(await call(`/api/teams/${teamId}/join-requests`, 'POST', stranger, { request_id: raceId }), 201);
      const raced = await Promise.all([
        call(`/api/teams/${teamId}/join-requests/${raceId}/approve`, 'POST', applicant),
        call(`/api/teams/${teamId}/join-requests/${raceId}/withdraw`, 'POST', stranger),
      ]);
      assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409]);
      const raceStatus = (await db.query('SELECT status FROM mefoot.team_join_requests WHERE id=$1', [raceId])).rows[0].status;
      assert.ok(raceStatus === 'approved' || raceStatus === 'withdrawn');
      const raceMemberships = Number((await db.query('SELECT count(*) AS n FROM mefoot.team_memberships WHERE team_id=$1 AND user_id=$2', [teamId, stranger])).rows[0].n);
      assert.equal(raceMemberships, raceStatus === 'approved' ? 1 : 0);
      if (raceStatus === 'approved') {
        await body(await call(`/api/teams/${teamId}/leave`, 'POST', stranger), 200);
        assert.equal((await db.query('SELECT status FROM mefoot.team_join_requests WHERE id=$1', [raceId])).rows[0].status, 'approved');
      }

      const state = token(), binding = token(), wrongBinding = token();
      oauthHashes.push(hashToken(state));
      await db.query(`INSERT INTO mefoot.oauth_flows
        (state_hash,binding_hash,provider,nonce,code_verifier,team_id,intent,expires_at)
        VALUES ($1,$2,'google',$3,$4,$5,'join',now()+interval '9 minutes')`,
      [hashToken(state), hashToken(binding), token(), token(), teamId]);
      assert.equal(await consumeOAuthFlow(db, 'google', state, wrongBinding), null);
      const consumed = await Promise.all([consumeOAuthFlow(db, 'google', state, binding), consumeOAuthFlow(db, 'google', state, binding)]);
      assert.equal(consumed.filter(Boolean).length, 1);
      assert.equal(consumed.find(Boolean)?.team_id, teamId);
      assert.equal(await consumeOAuthFlow(db, 'google', state, binding), null);

      const registration = token();
      registrationHashes.push(hashToken(registration));
      await db.query(`INSERT INTO mefoot.auth_registrations
        (token_hash,provider,provider_subject,email,email_verified,suggested_name,team_id,intent,expires_at)
        VALUES ($1,'google',$2,NULL,false,'신규 회원',$3,'join',now()+interval '14 minutes')`,
      [hashToken(registration), providerSubject, teamId]);
      const registrationCookie = { cookie: `__Host-mefoot_registration=${registration}` };
      const info = await body(await call('/api/auth/registration', 'GET', undefined, undefined, registrationCookie), 200);
      assert.equal(info.next, `/t/${teamId}?intent=join`);
      assert.equal(info.terms_version, config.auth.termsVersion);
      assert.equal((await call('/api/auth/register', 'POST', undefined, { display_name: '신규 회원' }, registrationCookie)).status, 400);
      const input = { display_name: '신규 회원', terms_accepted: true, privacy_accepted: true,
        terms_version: config.auth.termsVersion, privacy_notice_version: config.auth.privacyNoticeVersion };
      const registrations = await Promise.all([
        call('/api/auth/register', 'POST', undefined, input, registrationCookie),
        call('/api/auth/register', 'POST', undefined, input, registrationCookie),
      ]);
      assert.deepEqual(registrations.map((response) => response.status).sort(), [201, 401]);
      const successful = registrations.find((response) => response.status === 201)!;
      const registered = await successful.json();
      userIds.push(registered.user.id);
      assert.equal(registered.next, `/t/${teamId}?intent=join`);
      const sessionHeader = successful.headers.getSetCookie().find((value) => value.startsWith('__Host-mefoot_session='));
      assert.ok(sessionHeader);
      assert.match(sessionHeader, /; HttpOnly;/);
      assert.match(sessionHeader, /; Secure;/);
      const newCookie = { cookie: sessionHeader.split(';')[0]! };
      assert.equal((await body(await call('/api/me', 'GET', undefined, undefined, newCookie), 200)).user.id, registered.user.id);
      assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.team_join_requests WHERE user_id=$1', [registered.user.id])).rows[0].n), 0,
        'Registration returns to the selected team without implicitly submitting a join request');
      await body(await call('/api/auth/logout', 'POST', undefined, undefined, newCookie), 200);
      assert.equal((await call('/api/me', 'GET', undefined, undefined, newCookie)).status, 401);
      assert.equal(Number((await db.query("SELECT count(*) AS n FROM mefoot.auth_identities WHERE provider='google' AND provider_subject=$1", [providerSubject])).rows[0].n), 1);
    } finally {
      try {
        // Resolve the exact test identity even if an assertion failed before
        // its generated user ID could be recorded. No broad table cleanup.
        const registered = await db.query("SELECT user_id FROM mefoot.auth_identities WHERE provider='google' AND provider_subject=$1", [providerSubject]);
        for (const row of registered.rows) if (!userIds.includes(row.user_id)) userIds.push(row.user_id);
        await db.transaction(async (tx) => {
          await tx.query('DELETE FROM mefoot.oauth_flows WHERE state_hash = ANY($1::text[])', [oauthHashes]);
          await tx.query('DELETE FROM mefoot.auth_registrations WHERE token_hash = ANY($1::text[])', [registrationHashes]);
          await tx.query('DELETE FROM mefoot.sessions WHERE user_id = ANY($1::uuid[])', [userIds]);
          await tx.query('DELETE FROM mefoot.auth_identities WHERE user_id = ANY($1::uuid[])', [userIds]);
          await tx.query('DELETE FROM mefoot.team_join_requests WHERE team_id = ANY($1::uuid[])', [teamIds]);
          await tx.query('DELETE FROM mefoot.team_follows WHERE team_id = ANY($1::uuid[])', [teamIds]);
          await tx.query('DELETE FROM mefoot.team_memberships WHERE team_id = ANY($1::uuid[])', [teamIds]);
          // The owner-membership FK is deferred until this transaction commits.
          await tx.query('DELETE FROM mefoot.teams WHERE id = ANY($1::uuid[])', [teamIds]);
          await tx.query('DELETE FROM mefoot.users WHERE id = ANY($1::uuid[])', [userIds]);
        });
        assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.users WHERE id = ANY($1::uuid[])', [userIds])).rows[0].n), 0);
        assert.equal(Number((await db.query('SELECT count(*) AS n FROM mefoot.teams WHERE id = ANY($1::uuid[])', [teamIds])).rows[0].n), 0);
      } finally {
        await pool.end();
      }
    }
  });
