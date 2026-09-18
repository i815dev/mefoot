import { api, ApiError, newRequestId } from '../api';
import { errorMessage, sportLabel } from '../labels';
import { renderLoginChooser } from './auth-complete';
import type { Intent, PendingApplicant, TeamDetail, User } from '../types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function bar(chip: string, user: User | null): string {
  return `<header class="site-header app-bar">
    <a class="wordmark" href="/" aria-label="미풋 홈">mefoot<span>미풋</span></a>
    <div class="bar-right">
      ${user ? `<span class="chip user">${escapeHtml(user.display_name)}</span>` : '<span class="chip">팀</span>'}
    </div>
  </header>`;
}

async function loadMe(): Promise<User | null> {
  try {
    const data = await api<{ user: User }>('/api/me');
    return data.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    return null;
  }
}

export async function renderTeamPage(root: HTMLElement, teamId: string): Promise<void> {
  const intent = (new URLSearchParams(location.search).get('intent') || 'view') as Intent;
  root.innerHTML = `${bar('팀', null)}<main class="app-main"><p class="muted pad">팀 정보를 불러오는 중…</p></main>`;

  const user = await loadMe();
  let detail: TeamDetail;
  try {
    detail = await api<TeamDetail>(`/api/teams/${encodeURIComponent(teamId)}`);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'unknown';
    root.innerHTML = `${bar('팀', user)}<main class="app-main"><section class="panel">
      <h1>팀을 열 수 없어요</h1>
      <p class="muted">${errorMessage(code)}</p>
      <a class="button" href="/">홈으로</a>
    </section></main>`;
    return;
  }

  const me = detail.me;
  const membership = me?.membership ?? null;
  const joinRequest = me?.join_request ?? null;
  const following = Boolean(me?.following);
  const isAdmin = membership?.role === 'owner' || membership?.role === 'admin';

  // After login return with intent=follow|join, continue once then clean URL.
  if (user && (intent === 'follow' || intent === 'join') && !membership) {
    if (intent === 'follow') {
      if (!following) {
        try {
          await api(`/api/teams/${encodeURIComponent(teamId)}/follow`, { method: 'PUT' });
        } catch (error) {
          root.dataset.lastError = error instanceof ApiError ? error.code : 'follow_failed';
        }
      }
      history.replaceState({}, '', `/t/${teamId}`);
      return renderTeamPage(root, teamId);
    }
    if (intent === 'join' && joinRequest?.status !== 'pending') {
      history.replaceState({}, '', `/t/${teamId}`);
      return showJoinConfirm(root, teamId, detail, user);
    }
    if (intent === 'join' && joinRequest?.status === 'pending') {
      history.replaceState({}, '', `/t/${teamId}`);
    }
  }

  if (user && isAdmin) {
    await showMemberOrAdmin(root, teamId, detail, user, true);
    return;
  }
  if (user && membership) {
    await showMemberOrAdmin(root, teamId, detail, user, false);
    return;
  }
  if (user && joinRequest?.status === 'pending') {
    showPendingApplicant(root, teamId, detail, user);
    return;
  }

  showPublic(root, teamId, detail, user);
}

function teamHero(detail: TeamDetail): string {
  const team = detail.team;
  const region = team.region_label ? escapeHtml(team.region_label) : '지역 미정';
  const sport = sportLabel[team.sport];
  const desc = team.description?.trim()
    ? escapeHtml(team.description)
    : '팀 소개가 아직 없어요.';
  return `<div class="pitch-mini" aria-hidden="true"></div>
    <p class="eyebrow">팀 소개</p>
    <h1>${escapeHtml(team.name)}</h1>
    <p class="muted">${region} · ${sport}</p>
    <p class="muted">${desc}</p>`;
}

function showPublic(root: HTMLElement, teamId: string, detail: TeamDetail, user: User | null): void {
  const following = Boolean(detail.me?.following);
  const open = detail.team.join_requests_open;
  root.innerHTML = `${bar('팀', user)}<main class="app-main"><section class="panel">
    ${teamHero(detail)}
    <div class="card soft">
      <h2>다음에 할 수 있어요</h2>
      <p class="meta">관심은 바로, 정식 가입은 관리자 승인 후예요.</p>
    </div>
    <div id="team-actions" class="stack-actions">
      <button type="button" class="button secondary" data-action="follow">${following ? '관심 해제' : '관심 등록'}</button>
      <button type="button" class="button" data-action="join" ${open ? '' : 'disabled'}>${open ? '팀 가입 신청' : '지금은 신청 마감'}</button>
      ${user ? '<button type="button" class="text-button" data-action="logout">로그아웃</button>' : '<p class="tiny">로그인 없이 팀 소개만 볼 수 있어요.</p>'}
    </div>
    <p id="team-error" class="form-error" hidden></p>
  </section></main>`;

  bindPublicActions(root, teamId, detail, user, following);
}

function bindPublicActions(
  root: HTMLElement,
  teamId: string,
  detail: TeamDetail,
  user: User | null,
  following: boolean,
): void {
  const errorEl = root.querySelector('#team-error') as HTMLElement;
  root.querySelector('[data-action="follow"]')?.addEventListener('click', async () => {
    if (!user) {
      await renderLoginChooser(root, { teamId, intent: 'follow', title: detail.team.name });
      return;
    }
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/follow`, { method: following ? 'DELETE' : 'PUT' });
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '관심 등록에 실패했어요.';
    }
  });
  root.querySelector('[data-action="join"]')?.addEventListener('click', async () => {
    if (!user) {
      await renderLoginChooser(root, { teamId, intent: 'join', title: detail.team.name });
      return;
    }
    await showJoinConfirm(root, teamId, detail, user);
  });
  root.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch { /* ignore */ }
    location.assign(`/t/${teamId}`);
  });
}

async function showJoinConfirm(root: HTMLElement, teamId: string, detail: TeamDetail, user: User): Promise<void> {
  root.innerHTML = `${bar('신청', user)}<main class="app-main"><section class="panel">
    <div class="toast">팀으로 돌아왔어요</div>
    <p class="eyebrow">가입 신청</p>
    <h1>간단한 인사만<br />남겨 주세요</h1>
    <form id="join-form" class="stack-form">
      <label class="field">
        <span>가입 인사 (선택)</span>
        <textarea name="message" maxlength="500" placeholder="함께 뛰고 싶어요."></textarea>
      </label>
      <p id="join-error" class="form-error" hidden></p>
      <button class="button" type="submit">가입 신청하기</button>
      <button class="text-button" type="button" data-action="follow-only">관심만 등록하고 나가기</button>
      <button class="text-button" type="button" data-action="cancel">취소</button>
    </form>
  </section></main>`;

  const errorEl = root.querySelector('#join-error') as HTMLElement;
  root.querySelector('#join-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = String(new FormData(event.target as HTMLFormElement).get('message') ?? '').trim();
    const requestId = sessionStorage.getItem(`mefoot:join:${teamId}`) || newRequestId();
    sessionStorage.setItem(`mefoot:join:${teamId}`, requestId);
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/join-requests`, {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, message }),
      });
      sessionStorage.removeItem(`mefoot:join:${teamId}`);
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '신청에 실패했어요.';
    }
  });
  root.querySelector('[data-action="follow-only"]')?.addEventListener('click', async () => {
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/follow`, { method: 'PUT' });
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '관심 등록에 실패했어요.';
    }
  });
  root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
    void renderTeamPage(root, teamId);
  });
}

function showPendingApplicant(root: HTMLElement, teamId: string, detail: TeamDetail, user: User): void {
  const req = detail.me!.join_request!;
  const following = Boolean(detail.me?.following);
  root.innerHTML = `${bar('내 상태', user)}<main class="app-main"><section class="panel">
    ${teamHero(detail)}
    <span class="status pending">승인 대기</span>
    <p class="muted">관리자가 신청을 확인하면 알려 드릴게요.</p>
    <div class="card">
      <h2>보낸 인사</h2>
      <p class="meta">${req.message?.trim() ? escapeHtml(req.message) : '인사 없음'}</p>
    </div>
    <div class="card row-card">
      <div>
        <h2>관심 등록</h2>
        <p class="meta">관심과 가입은 서로 독립이에요</p>
      </div>
      <span class="chip">${following ? '등록됨' : '안 함'}</span>
    </div>
    <p id="pending-error" class="form-error" hidden></p>
    <button type="button" class="button danger" data-action="withdraw">신청 취소</button>
    <button type="button" class="text-button" data-action="back">팀으로</button>
  </section></main>`;

  const errorEl = root.querySelector('#pending-error') as HTMLElement;
  root.querySelector('[data-action="withdraw"]')?.addEventListener('click', async () => {
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/join-requests/${encodeURIComponent(req.id)}/withdraw`, {
        method: 'POST',
        body: '{}',
      });
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '취소에 실패했어요.';
    }
  });
  root.querySelector('[data-action="back"]')?.addEventListener('click', () => {
    void renderTeamPage(root, teamId);
  });
}

async function showMemberOrAdmin(
  root: HTMLElement,
  teamId: string,
  detail: TeamDetail,
  user: User,
  loadQueue: boolean,
): Promise<void> {
  const membership = detail.me!.membership!;
  const following = Boolean(detail.me?.following);
  const roleLabel =
    membership.role === 'owner' ? '대표' : membership.role === 'admin' ? '운영진' : '팀원';
  let queueHtml = '';
  if (loadQueue) {
    try {
      const data = await api<{ requests: PendingApplicant[] }>(
        `/api/teams/${encodeURIComponent(teamId)}/join-requests?limit=50`,
      );
      queueHtml = `<section class="queue">
        <p class="eyebrow">${escapeHtml(detail.team.name)}</p>
        <h2>가입 대기 ${data.requests.length}</h2>
        <p class="muted">대표·운영진만 볼 수 있어요.</p>
        ${
          data.requests.length === 0
            ? '<p class="meta">대기 중인 신청이 없어요.</p>'
            : data.requests
                .map((item) => {
                  const initial = [...item.applicant.display_name][0] ?? '?';
                  return `<article class="card request" data-request-id="${escapeHtml(item.id)}">
                    <div class="row-card">
                      <div class="avatar">${escapeHtml(initial)}</div>
                      <div>
                        <h3>${escapeHtml(item.applicant.display_name)}</h3>
                        <p class="meta">${item.message?.trim() ? escapeHtml(item.message) : '인사 없음'}</p>
                      </div>
                    </div>
                    <div class="actions-2">
                      <button type="button" class="button" data-resolve="approve">승인</button>
                      <button type="button" class="button secondary" data-resolve="reject">거절</button>
                    </div>
                  </article>`;
                })
                .join('')
        }
      </section>`;
    } catch (error) {
      queueHtml = `<p class="form-error">${error instanceof ApiError ? errorMessage(error.code) : '대기 목록을 불러오지 못했어요.'}</p>`;
    }
  }

  root.innerHTML = `${bar('팀원', user)}<main class="app-main"><section class="panel">
    <span class="status member">정식 팀원</span>
    ${teamHero(detail)}
    <div class="card">
      <h2>내 역할</h2>
      <p class="meta">${roleLabel} · ${escapeHtml(membership.joined_at.slice(0, 10))} 가입</p>
    </div>
    ${queueHtml}
    <p id="member-error" class="form-error" hidden></p>
    <div class="stack-actions">
      ${loadQueue ? '<button type="button" class="button secondary" data-action="qr">팀 QR URL 보기</button>' : ''}
      <button type="button" class="button secondary" data-action="follow">${following ? '관심 해제' : '관심 등록'}</button>
      ${
        membership.role === 'owner'
          ? '<p class="tiny">대표는 권한을 넘긴 뒤에 탈퇴할 수 있어요.</p>'
          : '<button type="button" class="text-button" data-action="leave">팀 탈퇴</button>'
      }
      <button type="button" class="text-button" data-action="logout">로그아웃</button>
    </div>
    <pre id="qr-box" class="qr-box" hidden></pre>
  </section></main>`;

  const errorEl = root.querySelector('#member-error') as HTMLElement;
  root.querySelectorAll('[data-resolve]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = (button as HTMLElement).dataset.resolve!;
      const card = button.closest('[data-request-id]') as HTMLElement;
      const requestId = card.dataset.requestId!;
      try {
        await api(
          `/api/teams/${encodeURIComponent(teamId)}/join-requests/${encodeURIComponent(requestId)}/${action}`,
          { method: 'POST', body: '{}' },
        );
        await renderTeamPage(root, teamId);
      } catch (error) {
        errorEl.hidden = false;
        errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '처리에 실패했어요.';
      }
    });
  });
  root.querySelector('[data-action="qr"]')?.addEventListener('click', async () => {
    const box = root.querySelector('#qr-box') as HTMLElement;
    try {
      const data = await api<{ url: string }>(`/api/teams/${encodeURIComponent(teamId)}/qr`);
      box.hidden = false;
      box.textContent = data.url;
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : 'QR URL을 가져오지 못했어요.';
    }
  });
  root.querySelector('[data-action="follow"]')?.addEventListener('click', async () => {
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/follow`, { method: following ? 'DELETE' : 'PUT' });
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '관심 변경에 실패했어요.';
    }
  });
  root.querySelector('[data-action="leave"]')?.addEventListener('click', async () => {
    if (!confirm('정말 이 팀에서 탈퇴할까요?')) return;
    try {
      await api(`/api/teams/${encodeURIComponent(teamId)}/leave`, { method: 'POST', body: '{}' });
      await renderTeamPage(root, teamId);
    } catch (error) {
      errorEl.hidden = false;
      errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '탈퇴에 실패했어요.';
    }
  });
  root.querySelector('[data-action="logout"]')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch { /* ignore */ }
    location.assign(`/t/${teamId}`);
  });
}
