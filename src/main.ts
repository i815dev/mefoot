import './style.css';

// Team links remain useful while account and database integration is prepared.
if (location.pathname.startsWith('/t/')) {
  const title = document.querySelector('#hero-title');
  const description = document.querySelector('.description');
  if (title) title.textContent = '팀 안내를 준비하고 있어요.';
  if (description) description.textContent = '미풋이 문을 열면 이곳에서 팀을 만나볼 수 있어요.';
}
