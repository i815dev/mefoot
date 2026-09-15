# Mefoot · 미풋

축구·풋살 용병 모집과 팀 연결 서비스의 시작 프로젝트입니다.

현재 포함된 기능은 서비스 소개 화면, 팀 URL 진입 안내, Cloudflare Worker, OCI용 회원·팀 API, 소셜 로그인 서버 코드, 자동 검사·배포 절차입니다. 실제 소셜 로그인은 제공자 앱·키와 약관·가입 완료 화면 준비 후 활성화합니다. 모집·경기 신청 화면은 아직 구현하지 않았습니다.

회원·팀·가입 승인 흐름과 권한은 [데이터 설계 v1](docs/member-team-data-model.md), 적용 전 SQL과 검증 결과는 [database/README.md](database/README.md)에 정리했습니다. 운영 DB에는 정식 마이그레이션 001·002를 적용했습니다. 앱 전용 계정으로 권한·동시 승인·세션 통합 테스트를 통과했습니다. API 목록과 검증 범위는 [API 안내](docs/api.md), 서버 Stack은 [infra/api/README.md](infra/api/README.md)를 참고하세요.

## 실행

Node.js 24를 기준으로 합니다. 저장소 폴더에서 실행하세요.

```sh
npm ci
npm run dev
```

브라우저에서 http://localhost:8787 을 엽니다. 화면 소스를 수정했다면 `npm run build` 후 브라우저를 새로고침합니다. 현재 개발 명령은 처음 시작할 때 화면을 빌드합니다.

```sh
npm run check
npm test
npm run release
```

`release`는 웹 파일과 Worker를 로컬에서 묶고, 버전과 파일 체크섬을 `build/manifest.json`에 기록합니다. 클라우드에 업로드하지 않습니다. 서버를 실행한 상태에서는 별도 터미널에서 `npm run smoke`로 화면과 API를 함께 확인할 수 있습니다.

## 이번에 확인한 범위

- TypeScript 검사와 Worker 테스트 4개 통과.
- 화면 빌드와 Worker 배포 파일 생성 통과.
- 로컬 Worker에서 웹·API 응답 및 버전 일치 확인.
- GitHub Actions 설정 파일 검토 완료. 원격 검사·배포 결과는 저장소 Actions의 해당 커밋 실행 기록에서 확인합니다.
- `/api/health`는 Worker 실행 여부만 확인합니다. DB와 로그인 상태를 보장하지 않습니다.

`public/manifest.webmanifest`는 PWA 준비용입니다. 오프라인 처리, 설치용 PNG 아이콘, 실제 기기 설치·푸시 알림·Android 패키징은 아직 구현·검증하지 않았습니다.

## GitHub 연결

원격 저장소: https://github.com/i815dev/mefoot

이 저장소는 공개 상태입니다. 소스와 설정 예시를 관리하며, 실제 비밀 값은 GitHub Secrets 또는 해당 서비스의 비밀 값 저장소에 넣습니다.

개발 컴퓨터에서 처음 연결할 때는 브라우저 인증을 사용합니다.

```sh
gh auth login --hostname github.com --git-protocol https --web
gh auth switch --hostname github.com --user i815dev
gh api user --jq .login
```

브라우저에서 저장소 쓰기 권한이 있는 계정으로 인증하고 마지막 출력으로 계정을 확인합니다. 위 예시는 저장소 소유자인 `i815dev` 계정입니다. 비밀번호·인증 코드·토큰을 대화에 붙여 넣지 않습니다.

## Cloudflare와 배포

웹 화면과 Worker를 하나의 배포 단위로 사용합니다. PostgreSQL과 Node API는 서울 OCI에서 운영합니다. Worker는 API를 HTTPS로 전달하며 DB 자격 증명은 서버에만 둡니다. 현재 로컬 코드의 비밀 값은 Git에 포함하지 않습니다.

처음에는 Workers 기본 주소에서 검증하고, 운영 주소는 `mefoot.i815.com`을 제안합니다. 이 문서 작성 시점에는 해당 서비스용 도메인 연결을 만들지 않았습니다. `i815.com`의 기존 Cloudflare DNS 관리는 그대로 사용합니다.

GitHub 저장소의 **Settings → Secrets and variables → Actions**에 아래 값을 설정합니다. Cloudflare 계정과 기본 Workers 주소를 확인한 뒤 실제 값으로 입력합니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Variable | `CF_ACCOUNT_ID` | 배포할 Cloudflare 계정 ID |
| Variable | `STAGING_URL` | `https://mefoot-staging.<실제-workers-하위도메인>.workers.dev` |
| Secret | `CF_API_TOKEN` | 해당 계정의 Worker 배포 권한을 가진 API 토큰 |
| Variable | `PRODUCTION_URL` | 처음에는 `https://mefoot.<실제-workers-하위도메인>.workers.dev` |
| Variable | `PRODUCTION_DOMAIN` | 기본 주소 사용 시 생략. 나중에 `mefoot.i815.com` 연결 시 설정 |

API 토큰은 대상 계정과 필요한 권한에 한정해서 만들고 Global API Key를 사용하지 않습니다. 사용자 도메인을 연결할 때는 기존 DNS 기록과 필요한 권한을 확인한 뒤 `PRODUCTION_URL`을 `https://mefoot.i815.com`, `PRODUCTION_DOMAIN`을 `mefoot.i815.com`으로 함께 설정합니다. 이 값이 있으면 배포 스크립트가 Worker의 Custom Domain 설정을 요청합니다.

### 테스트 배포

Wrangler 로그인을 마친 로컬 컴퓨터에서는 초기 테스트 배포에 `--oauth`를 사용할 수 있습니다. 실제 계정 ID와 Workers 주소를 확인한 뒤 실행합니다.

```sh
export RELEASE_SHA="$(git rev-parse HEAD)"
export CLOUDFLARE_ACCOUNT_ID="<실제-Cloudflare-계정-ID>"
export STAGING_URL="https://mefoot-staging.<실제-workers-하위도메인>.workers.dev"
npm run release
npm run deploy:staging -- --oauth
```

이 옵션은 Wrangler가 저장한 로그인 정보를 사용하며 로컬 staging에서만 허용됩니다. 운영 또는 `CI`·`GITHUB_ACTIONS` 환경에서는 거부합니다. GitHub Actions에는 별도 `CF_API_TOKEN` secret이 필요하며, `--oauth`를 생략하면 기존처럼 계정 ID와 API 토큰을 모두 요구합니다.

`main`에 업로드하면 검사 → 배포 파일 생성 → 테스트 환경 배포 → 실제 URL 검사가 실행됩니다. `CF_ACCOUNT_ID` 또는 `STAGING_URL`이 없으면 테스트 배포를 건너뛰고 코드 검사만 합니다. 두 값이 있다면 토큰도 필요합니다.

### 운영 배포

1. Actions의 **CI**에서 `staging`까지 성공한 커밋을 고릅니다.
2. **Deploy production → Run workflow**에서 `main`을 선택합니다.
3. `source_sha`에 해당 커밋의 전체 40자리 SHA를 넣고 실행합니다.

테스트에서 검증된 동일한 웹·Worker 파일을 사용하며, 운영 배포 때 다시 빌드하지 않습니다. 배포 전 SHA·체크섬을 검사하고, 배포 후 실제 운영 주소에서 화면·API 버전이 일치하는지 확인합니다. 파일 업로드 성공만으로 완료 처리하지 않습니다.

산출물 보관 기간은 30일입니다. 이전 성공 커밋으로 되돌릴 때도 그 산출물이 남아 있어야 합니다. 자동 롤백은 아직 없으며 DB 변경을 되돌리는 절차도 포함하지 않습니다.

이 자동화는 공통 웹 서비스의 배포입니다. 앱스토어 심사나 Android 앱 서명·출시를 자동으로 처리하지 않습니다.

## 다음 구현 순서

1. GitHub 계정 연결과 첫 업로드, Actions 검사 확인.
2. Cloudflare 테스트 주소 배포 후 실제 주소에서 확인.
3. 서울 OCI 상태 확인 후 PostgreSQL 설치와 백업·복원 점검.
4. Worker에서 OCI DB로 접근할 경로 확정. DB 포트를 인터넷에 공개하는 명령은 현재 제공하지 않습니다.
5. 카카오·Google 앱 설정과 로그인 연결. Apple 로그인은 해당 개발자 설정과 적용 조건을 별도로 확인합니다.
6. 팀 페이지 → 관심 등록 또는 가입 신청 → 로그인 후 같은 팀·행동으로 복귀하는 흐름 구현.
7. 팀 관리자 QR 생성과 가입 승인, 모집 글·경기 신청 구현.

팀 관심 등록은 바로 반영하고, 정식 팀원 가입은 관리자 승인 후 확정합니다. 경기의 용병 신청과 팀원 가입은 별도로 관리합니다. 공개 QR에는 관리자 권한이나 로그인 비밀 값을 넣지 않습니다.

## OCI 상태 확인

OCI의 관리 기준과 Caddy Stack 설정은 [infra/README.md](infra/README.md)에 정리합니다. Portainer는 최초 구동용 독립 컨테이너로 두고, Caddy와 이후 앱은 Portainer Stacks에서 관리하는 구성을 준비 중입니다. 현재 Caddy Stack 전환은 아직 서버에서 확인되지 않았습니다.

서버 변경은 운영자가 직접 실행합니다. 아래 명령은 **서울 서버에서** 현재 상태만 읽습니다. Docker 사용 권한이 없는 경우 기존 운영 방식에 맞게 실행합니다.

```sh
uname -m
nproc
free -h
docker --version
docker compose version
df -h /
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
docker compose ls
```

결과에서 현재 서비스와 자원 여유를 확인한 뒤 설치 경로·볼륨·네트워크를 정합니다. 기존 컨테이너를 교체하거나 중지하는 명령은 포함하지 않았습니다.
