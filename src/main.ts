import './style.css';
import { renderAuthComplete } from './pages/auth-complete';
import { renderTeamPage } from './pages/team';

const homeMarkup = document.body.innerHTML;

function mountApp(): HTMLElement {
  document.body.innerHTML = '<div id="app" class="app-root"></div>';
  return document.querySelector('#app') as HTMLElement;
}

function restoreHome(): void {
  document.body.innerHTML = homeMarkup;
}

async function route(): Promise<void> {
  const path = location.pathname;
  const teamMatch = /^\/t\/([^/]+)\/?$/.exec(path);
  if (teamMatch) {
    const root = mountApp();
    await renderTeamPage(root, decodeURIComponent(teamMatch[1]!));
    return;
  }
  if (path === '/auth/complete') {
    const root = mountApp();
    await renderAuthComplete(root);
    return;
  }
  // Marketing home stays as the original static markup.
  if (!document.querySelector('#hero-title')) restoreHome();
}

void route();
window.addEventListener('popstate', () => {
  void route();
});
