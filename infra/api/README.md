# Mefoot API 배포

이 폴더는 OCI 서울 서버에 API를 배포하는 Portainer Stack 원본입니다. 파일 준비만으로 배포된 상태를 의미하지 않습니다. 배포 완료 여부는 실행 중인 이미지, HTTPS 응답, 앱 계정의 DB 접속을 확인해 판정합니다.

연결 경로는 브라우저 → Cloudflare Worker → Caddy → API → PostgreSQL입니다. API는 `caddy-net`에서 Caddy 요청을 받고, `mefoot-db`에서 PostgreSQL에 연결합니다. API의 3000번 포트는 호스트에 공개하지 않습니다.

| 항목 | 설정 |
| --- | --- |
| Portainer Stack / 컨테이너 | `mefoot-api` |
| 이미지 | `ghcr.io/i815dev/mefoot-api:<전체 commit SHA>` |
| 실행 환경 | Node.js 24, `linux/arm64`, 비루트 `node` 사용자 |
| API 원본 주소 | `https://oci-seoul-a1.i815.com` |
| 초기 웹 주소 | `https://mefoot-staging.teol79.workers.dev` |
| DB / 계정 / 내부 호스트 | `mefoot` / `mefoot_app` / `mefoot-postgres` |
| CPU / 메모리 | 0.5 CPU / 512MB |

API 원본 도메인은 배포 전에 다른 웹 서비스가 사용 중인지 확인합니다. Caddy 라벨은 DNS 레코드를 만들지 않습니다. Worker에서 사용하는 원본 API 주소도 이 주소로 맞춥니다.

## 이미지 만들기

`main`에 API·DB·의존성·Dockerfile 변경을 푸시하면 [Build API image](../../.github/workflows/api-image.yml)가 실행됩니다. GitHub Actions 화면에서 수동 실행할 수도 있으며, `main`에서 실행한 작업만 이미지를 만듭니다.

순서는 `npm ci` → 타입 검사 → 테스트 → ARM64 이미지 빌드 → GHCR 업로드입니다. 태그는 짧게 줄이지 않은 전체 commit SHA입니다. Portainer의 `API_IMAGE_TAG`에도 같은 값을 사용합니다. 이미지 게시와 서버 Stack 업데이트는 별도 단계이며, 이 워크플로는 서버에 자동 접속하거나 DB 마이그레이션을 실행하지 않습니다.

이미지 안에는 서버 코드, DB SQL, 운영 의존성이 들어갑니다. 비밀 값은 빌드 인자에 넣지 않습니다. Node.js 24의 TypeScript 타입 제거 기능으로 `node server/index.ts`를 실행하고, 타입 검사는 앞선 CI 단계에서 수행합니다.

GHCR 패키지가 비공개라면 Portainer의 Registries에 `ghcr.io` 읽기 권한을 가진 인증을 등록해야 합니다. 공개 패키지라면 별도 읽기 인증 없이 내려받을 수 있습니다. GitHub Actions는 내장 `GITHUB_TOKEN`의 `packages: write` 권한으로 게시합니다.

## 처음 배포하기

1. `mefoot-postgres`가 정상 동작하고 `caddy-net`, `mefoot-db` 네트워크가 존재하는지 확인합니다.
2. 필요한 DB 마이그레이션, 제한된 앱 역할 `mefoot_app`, `mefoot-db`의 실제 CIDR에서 해당 역할로 접속하는 `hostssl` 규칙을 먼저 적용합니다. `mefoot_dev`나 관리자 계정으로 앱을 실행하지 않습니다.
3. `/home/ubuntu/docker/postgres/data/.access/tls/server.crt`가 존재하고 컨테이너의 `node` 사용자가 읽을 수 있어야 합니다. 이 파일은 서버 공개 인증서이며 개인 키는 API에 마운트하지 않습니다.
4. GitHub의 이미지 빌드 성공과 대상 commit SHA를 확인합니다.
5. Portainer에서 Stack 이름을 `mefoot-api`로 지정하고 [compose.yaml](compose.yaml)을 넣습니다. 아래 환경 변수를 입력한 뒤 배포합니다.
6. 컨테이너 상태, 이미지 SHA, HTTPS 응답, DB 접속을 확인하고 Worker의 API 연결을 검증합니다.

| Stack 환경 변수 | 값 |
| --- | --- |
| `API_IMAGE_TAG` | 빌드가 성공한 전체 commit SHA, 필수 |
| `PGPASSWORD` | 별도로 만든 `mefoot_app`의 비밀번호, 필수 |
| `EDGE_SHARED_KEY` | Worker와 API가 공유하는 충분히 긴 무작위 값, 필수 |
| `APP_ORIGIN` | 사용자에게 보이는 웹 주소, 기본값은 위 staging 주소 |

`EDGE_SHARED_KEY`는 서버 사이에서만 사용합니다. 동일 값을 Worker 비밀 설정에도 넣고 프런트엔드 코드나 공개 환경 변수에 포함하지 않습니다. Portainer 관리자에게는 Stack 환경 변수가 보일 수 있으므로 해당 값을 문서·로그·Git에 복사하지 않습니다.

API의 HTTPS 및 DB 연결을 확인한 다음 GitHub Actions의 저장소 변수 `API_ORIGIN`을 `https://oci-seoul-a1.i815.com`으로, 저장소 Secret `API_EDGE_SHARED_KEY`를 Stack과 같은 공유 키로 설정합니다. 이후 staging 배포는 공유 키를 Worker의 `EDGE_SHARED_KEY`에 저장하고, 생성하는 배포 설정에도 API 주소를 전달합니다. 실제 비밀값 저장은 지정된 서비스에 대한 승인을 받은 후 진행합니다.

`API_ORIGIN`이 비어 있는 동안에는 기존 웹·Worker만 배포합니다. 이 변수가 설정되면 배포 후 `/api/health/db` 응답까지 검사하므로 Worker·API·DB 연결 실패가 배포 성공으로 표시되지 않습니다. API 이미지 버전까지 비교하려면 검사 실행 시 `EXPECTED_API_VERSION`에 실행 중이어야 하는 전체 이미지 SHA를 지정합니다. `wrangler.jsonc`만 수정하는 것으로는 자동 배포 설정이 바뀌지 않습니다.

DB 접속은 내부 Docker 이름으로 연결하면서 TLS 서버 이름을 `postgre.i815.com`으로 검증합니다. 따라서 `PGHOST=mefoot-postgres`와 `PGTLS_SERVERNAME=postgre.i815.com`이 달라도 정상입니다. 인증서 검증을 끄는 옵션은 사용하지 않습니다.

## 소셜 로그인 설정

개발자 계정만 생성된 초기 상태에서는 OAuth 값을 비워 둡니다. 각 제공자에서 로그인 앱과 클라이언트를 만든 뒤, 실제 서버 구현이 사용하는 환경 변수와 콜백 주소에 맞춰 Stack의 `environment` 항목에 추가합니다. Portainer의 환경 변수 목록에만 값을 추가하면 컨테이너에 자동 전달되지는 않습니다.

| 제공자 / 기능 | 추후 추가할 환경 변수 |
| --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| 카카오 | `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`, `KAKAO_OPENID_ENABLED` |
| Apple | 서버의 Apple 로그인 구현에서 정의한 `APPLE_*` 항목 |
| 약관·개인정보 동의 | 실제 게시한 문서 버전에 맞춘 `TERMS_VERSION`, `PRIVACY_NOTICE_VERSION` |

아직 발급하지 않은 클라이언트 키나 약관 버전을 임의로 만들어 넣지 않습니다. OAuth 설정 완료와 실제 제공자 로그인 검증은 DB 및 API 배포와 구분해서 확인합니다.

## 상태 확인과 업데이트

Docker healthcheck는 `http://127.0.0.1:3000/healthz`를 호출합니다. 이는 프로세스가 응답하는지 보는 검사이므로 `healthy`만으로 DB 연결이나 로그인이 검증되지는 않습니다. `/healthz`에는 공유 키가 필요하지 않고 업무 API에는 Worker가 넣는 공유 키와 해당 요청에 필요한 사용자 권한 검사가 적용됩니다.

다음 배포에서는 새 이미지의 검사가 끝난 뒤 Stack의 `API_IMAGE_TAG`를 해당 commit SHA로 바꾸고 업데이트합니다. 데이터베이스 마이그레이션은 적용 이력과 호환성을 확인해 별도로 처리합니다. 컨테이너 시작 시마다 자동 적용하지 않습니다. 장애 시 이전 이미지 SHA로 되돌릴 수 있지만, SQL 변경까지 자동으로 되돌아가지는 않습니다.

서버 인증서를 갱신할 때는 새 인증서의 이름·유효성을 확인하고 이 Stack도 다시 배포합니다. 개별 파일 bind mount가 이전 파일을 계속 바라보는 상황을 피하고 새 신뢰 인증서로 DB 연결을 재검증합니다.

공식 자료: [Docker GitHub Actions ARM64 빌드](https://docs.docker.com/build/ci/github-actions/multi-platform/), [Node.js TypeScript 실행](https://nodejs.org/api/typescript.html), [GitHub Container Registry 인증](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [Docker Compose 서비스 설정](https://docs.docker.com/reference/compose-file/services/).
