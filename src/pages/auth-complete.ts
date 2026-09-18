import { api, ApiError } from '../api';
import { errorMessage } from '../labels';
import type { Provider, User } from '../types';

type RegistrationInfo = {
  provider: string;
  suggested_name: string | null;
  terms_version: string;
  privacy_notice_version: string;
  next: string;
};

function shell(title: string, body: string): string {
  return `<header class="site-header app-bar">
    <a class="wordmark" href="/" aria-label="미풋 홈">mefoot<span>미풋</span></a>
    <span class="chip">로그인</span>
  </header>
  <main class="app-main">${body}</main>`;
}

export async function renderAuthComplete(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.search);
  const oauthError = params.get('error');
  if (oauthError) {
    root.innerHTML = shell(
      '로그인',
      `<section class="panel">
        <p class="eyebrow">로그인</p>
        <h1>로그인을 마치지 못했어요</h1>
        <p class="muted">${errorMessage(oauthError)}</p>
        <a class="button" href="/">홈으로</a>
      </section>`,
    );
    return;
  }

  root.innerHTML = shell('가입', `<section class="panel"><p class="muted">가입 정보를 불러오는 중…</p></section>`);
  try {
    const info = await api<RegistrationInfo>('/api/auth/registration');
    root.innerHTML = shell(
      '첫 방문',
      `<section class="panel">
        <p class="eyebrow">회원 정보</p>
        <h1>어떻게 불러드릴까요?</h1>
        <p class="muted">닉네임과 필수 동의만 받아요.</p>
        <form id="register-form" class="stack-form">
          <label class="field">
            <span>닉네임</span>
            <input name="display_name" maxlength="30" required value="${escapeAttr(info.suggested_name ?? '')}" />
          </label>
          <label class="check"><input type="checkbox" name="terms" required /> (필수) 서비스 이용약관에 동의합니다</label>
          <label class="check"><input type="checkbox" name="privacy" required /> (필수) 개인정보 안내에 동의합니다</label>
          <p class="tiny">약관 버전 ${escapeHtml(info.terms_version)} · 개인정보 안내 ${escapeHtml(info.privacy_notice_version)}</p>
          <p id="register-error" class="form-error" hidden></p>
          <button class="button" type="submit">동의하고 계속</button>
        </form>
      </section>`,
    );
    const form = root.querySelector('#register-form') as HTMLFormElement;
    const errorEl = root.querySelector('#register-error') as HTMLElement;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      const data = new FormData(form);
      const displayName = String(data.get('display_name') ?? '').trim();
      try {
        const result = await api<{ user: User; next: string }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            display_name: displayName,
            terms_accepted: data.get('terms') === 'on',
            privacy_accepted: data.get('privacy') === 'on',
            terms_version: info.terms_version,
            privacy_notice_version: info.privacy_notice_version,
          }),
        });
        location.assign(result.next || '/');
      } catch (error) {
        errorEl.hidden = false;
        errorEl.textContent = error instanceof ApiError ? errorMessage(error.code) : '가입에 실패했어요.';
      }
    });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'unknown';
    root.innerHTML = shell(
      '가입',
      `<section class="panel">
        <p class="eyebrow">가입</p>
        <h1>이어갈 가입 정보가 없어요</h1>
        <p class="muted">${errorMessage(code)}</p>
        <a class="button" href="/">홈으로</a>
      </section>`,
    );
  }
}

export async function renderLoginChooser(
  root: HTMLElement,
  opts: { teamId: string; intent: 'follow' | 'join'; title?: string },
): Promise<void> {
  let providers: Provider[] = [];
  try {
    const data = await api<{ providers: Provider[] }>('/api/auth/providers');
    providers = data.providers;
  } catch {
    providers = [
      { id: 'kakao', name: '카카오', enabled: false },
      { id: 'google', name: 'Google', enabled: false },
      { id: 'apple', name: 'Apple', enabled: false },
    ];
  }
  const intentLabel = opts.intent === 'follow' ? '관심 등록' : '가입 신청';
  root.innerHTML = shell(
    '로그인',
    `<section class="panel">
      <p class="eyebrow">이어서 하려면</p>
      <h1>로그인하고<br />팀으로 돌아가요</h1>
      <p class="muted">${escapeHtml(opts.title ?? '팀')} · ${intentLabel}을 이어서 진행해요.</p>
      <div class="provider-stack">
        ${providers
          .map((provider) => {
            const href = `/api/auth/${provider.id}/start?team_id=${encodeURIComponent(opts.teamId)}&intent=${opts.intent}`;
            const disabled = provider.enabled ? '' : ' aria-disabled="true"';
            const cls = `provider ${provider.id}${provider.enabled ? '' : ' disabled'}`;
            return provider.enabled
              ? `<a class="${cls}" href="${href}">${escapeHtml(provider.name)}로 계속</a>`
              : `<span class="${cls}"${disabled}>${escapeHtml(provider.name)} (준비 중)</span>`;
          })
          .join('')}
      </div>
      <p class="tiny">로그인만으로는 관심·신청이 만들어지지 않아요.</p>
      <a class="text-link" href="/t/${encodeURIComponent(opts.teamId)}">팀으로 돌아가기</a>
    </section>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
function escapeAttr(value: string): string {
  return escapeHtml(value);
}
