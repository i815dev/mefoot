# Mefoot 소셜 로그인 연결 준비

현재 개발자 계정 가입만 완료했고, Mefoot용 OAuth 앱·클라이언트 키는 아직 발급하지 않았습니다. 서버의 로그인·세션·가입 API는 구현되어 있지만, 실제 카카오·Google·Apple 계정으로 로그인하고 복귀하는 검증은 아직 하지 않았습니다.

이번 서버 배포에서는 로그인 제공자를 비활성 상태로 둡니다. 다음 순서는 **제공자 앱 생성 → 약관 본문과 가입 완료 화면 준비 → 서버에 키 입력 → 실제 로그인 검증**입니다. 키 발급만으로 회원가입이 열리는 것은 아닙니다.

## 공통 주소

현재 `APP_ORIGIN`은 `https://mefoot-staging.teol79.workers.dev`입니다. 로그인 콜백은 사용자가 보는 Cloudflare 웹 주소로 등록합니다. OCI 서버 주소나 PostgreSQL 주소는 사용하지 않습니다.

| 제공자 | 등록할 Redirect URI / Return URL |
| --- | --- |
| 카카오 | `https://mefoot-staging.teol79.workers.dev/api/auth/kakao/callback` |
| Google | `https://mefoot-staging.teol79.workers.dev/api/auth/google/callback` |
| Apple | `https://mefoot-staging.teol79.workers.dev/api/auth/apple/callback` |

경로 끝에 `/`를 추가하지 않습니다. 나중에 `mefoot.i815.com` 등으로 앱 주소를 바꾸면 제공자 콘솔의 콜백과 서버 `APP_ORIGIN`을 함께 변경하고 다시 검증합니다.

## 1. 카카오 로그인 앱 만들기

1. [Kakao Developers](https://developers.kakao.com/)에서 Mefoot 애플리케이션을 만듭니다.
2. 앱의 카카오 로그인을 활성화하고 **OpenID Connect도 활성화**합니다. 현재 공식 메뉴는 `카카오 로그인 → 일반 → OpenID Connect`입니다.
3. 위 표의 카카오 Redirect URI를 등록합니다. Web 사이트 도메인을 입력하는 항목에는 `https://mefoot-staging.teol79.workers.dev`를 사용합니다.
4. `앱 → 플랫폼 키 → REST API 키`에서 REST API 키와 해당 키의 Client secret을 확인합니다. Client secret 활성 상태를 유지합니다.
5. 아래 세 값을 서버 환경 변수로 준비합니다.

| 변수 | 입력할 값 |
| --- | --- |
| `KAKAO_CLIENT_ID` | REST API 키 |
| `KAKAO_CLIENT_SECRET` | 위 REST API 키의 Client secret |
| `KAKAO_OPENID_ENABLED` | 실제 콘솔에서 OIDC 활성화 후 `true` |

JavaScript 키나 Admin 키를 `KAKAO_CLIENT_ID`에 넣지 않습니다. 초기 구현은 `openid` 범위만 요청하며, 앱 닉네임은 Mefoot 가입 완료 화면에서 직접 정합니다. 이메일·프로필 제공을 필수 가입 조건으로 두지 않았습니다.

설정 기준: [카카오 사전 설정](https://developers.kakao.com/docs/en/kakaologin/prerequisite), [OIDC 활성화](https://developers.kakao.com/docs/en/kakaologin/utilize#oidc), [REST API 키와 Client secret](https://developers.kakao.com/docs/en/app-setting/app), [로그인 REST API](https://developers.kakao.com/docs/en/kakaologin/rest-api).

## 2. Google 웹 클라이언트 만들기

1. [Google Cloud Console](https://console.cloud.google.com/)에서 Mefoot 프로젝트를 선택하거나 만듭니다.
2. Google Auth Platform의 Branding에 앱 이름·지원 이메일·연락 이메일을 설정합니다. Audience는 일반 팀원도 사용할 수 있는 External로 설정합니다.
3. 초기에는 Testing 상태로 두고 Audience의 Test users에 본인과 검증에 참여할 팀원 계정을 추가합니다.
4. Clients에서 OAuth 클라이언트를 만들고 유형을 **Web application**으로 선택합니다.
5. Authorized redirect URIs에 위 표의 Google 콜백을 정확히 등록합니다.
6. Authorized JavaScript origins를 등록한다면 `https://mefoot-staging.teol79.workers.dev`만 입력합니다. 이 항목에는 경로나 콜백을 넣지 않습니다. 현재 구현은 서버 리다이렉트 방식이므로 핵심 설정은 Redirect URI입니다.
7. 발급된 Client ID와 Client secret을 각각 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`으로 준비합니다.

현재 요청 범위는 `openid email profile`입니다. Google 이메일로 기존 카카오 회원을 자동 병합하지 않으며, Google에서 서명한 고유 사용자 ID로 기존 가입 여부를 확인합니다. 공개 전에는 Google 콘솔의 게시·브랜딩 상태와 실제 사용하는 도메인·약관 링크를 다시 확인합니다.

설정 기준: [Google OAuth 동의 화면과 테스트 사용자](https://developers.google.com/workspace/guides/configure-oauth-consent), [웹 서버 OAuth 클라이언트](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred), [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## 3. Apple 로그인 조건 확인 및 설정

Apple은 무료 개발자 계정 생성만으로 필요한 설정이 모두 준비되지는 않습니다. Apple Developer Program의 활성 멤버십과 Certificates, Identifiers & Profiles 관리 권한을 먼저 확인합니다. 웹 로그인에는 Sign in with Apple을 활성화한 **기본 App ID**, 그 App ID에 연결된 **Services ID**, 로그인용 개인 키가 필요합니다. 멤버십이나 연결할 App ID가 준비되지 않았다면 Apple만 비활성으로 두고 카카오·Google을 먼저 연결할 수 있습니다. [Apple 멤버십 제공 기능](https://developer.apple.com/programs/whats-included/), [웹 로그인 구성](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web).

1. 기본 App ID에서 Sign in with Apple을 활성화합니다.
2. 웹용 Services ID를 만들고 Sign in with Apple 설정에서 기본 App ID에 연결합니다.
3. Domains and Subdomains에 `mefoot-staging.teol79.workers.dev`를 입력하고, Return URLs에는 위 표의 Apple 콜백 전체 주소를 입력합니다.
4. Keys에서 Sign in with Apple용 키를 만들고 같은 기본 App ID에 연결합니다. `.p8` 개인 키를 내려받아 별도로 안전하게 보관합니다.
5. 아래 네 값을 준비합니다.

| 변수 | 입력할 값 |
| --- | --- |
| `APPLE_CLIENT_ID` | 웹용 Services ID 식별자 |
| `APPLE_TEAM_ID` | 해당 Apple 개발자 팀의 Team ID |
| `APPLE_KEY_ID` | 내려받은 로그인 키의 Key ID |
| `APPLE_PRIVATE_KEY` | `.p8` 파일의 PEM 개인 키 전체 내용 |

`APPLE_CLIENT_ID`에 Team ID나 기본 App ID를 잘못 넣지 않도록 확인합니다. 서버가 `.p8`로 유효기간 5분의 client secret을 생성하므로 장기간 유효한 client-secret 문자열을 따로 만들어 저장할 필요는 없습니다. PEM의 실제 줄바꿈과 문자 `\n`로 표현한 줄바꿈을 모두 지원합니다. 현재 Apple 콜백은 `form_post`를 받으며, 이 요청에 한해서 교차 사이트 전송이 가능한 짧은 인증 흐름 쿠키를 사용합니다.

설정 기준: [기본 App ID 활성화](https://developer.apple.com/help/account/capabilities/about-sign-in-with-apple), [로그인 개인 키 생성](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key), [웹 인증 요청과 form_post](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms).

## 4. Portainer에 키 전달하기

실제 비밀 값은 채팅·Git 저장소·프런트엔드 환경 변수에 넣지 않습니다. Portainer의 **mefoot-api Stack → Environment variables**에 직접 입력합니다. 이 값은 Portainer 관리자에게 보일 수 있으므로 화면이나 로그를 공유할 때도 비밀 값을 포함하지 않습니다.

현재 [API Stack 원본](../infra/api/compose.yaml)은 OAuth 환경 변수를 컨테이너로 전달하지 않습니다. 설정할 때 `services.api.environment` 아래에 다음 참조를 추가해야 합니다. Portainer의 환경 변수 목록에 값을 입력하는 작업과 아래 참조 추가가 모두 필요합니다. Git에는 참조 이름만 저장하고 실제 값은 저장하지 않습니다.

```yaml
      GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID:-}"
      GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET:-}"
      KAKAO_CLIENT_ID: "${KAKAO_CLIENT_ID:-}"
      KAKAO_CLIENT_SECRET: "${KAKAO_CLIENT_SECRET:-}"
      KAKAO_OPENID_ENABLED: "${KAKAO_OPENID_ENABLED:-false}"
      APPLE_CLIENT_ID: "${APPLE_CLIENT_ID:-}"
      APPLE_TEAM_ID: "${APPLE_TEAM_ID:-}"
      APPLE_KEY_ID: "${APPLE_KEY_ID:-}"
      APPLE_PRIVATE_KEY: "${APPLE_PRIVATE_KEY:-}"
      TERMS_VERSION: "${TERMS_VERSION:-}"
      PRIVACY_NOTICE_VERSION: "${PRIVACY_NOTICE_VERSION:-}"
```

먼저 준비된 제공자 값만 입력하면 됩니다. 새 환경 변수가 반영되도록 Stack을 업데이트하고 컨테이너 상태를 확인합니다. 기존 DB 비밀번호·공유 키·볼륨·네트워크 값은 유지합니다.

## 5. 실제 가입을 열기 전에 필요한 작업

현재 [서버 설정](../server/config.ts)은 `TERMS_VERSION`과 `PRIVACY_NOTICE_VERSION`이 **모두 있어야** 제공자 설정을 읽습니다. 하나라도 비어 있으면 모든 소셜 로그인 제공자를 비활성으로 둡니다. 테스트용 임의 버전을 넣어 이 조건만 통과시키지 않습니다.

다음 제품 작업은 실제 약관·개인정보 처리 안내 본문 게시와 `/auth/complete` 가입 완료 화면 구현입니다. 화면은 서버의 `/api/auth/registration`에서 현재 문서 버전과 제안 닉네임을 받아 보여주고, 사용자가 두 문서에 동의한 뒤 다음 내용을 `POST /api/auth/register`로 보냅니다.

```json
{
  "display_name": "사용자가 정한 닉네임",
  "terms_version": "현재 게시된 약관 버전",
  "privacy_notice_version": "현재 게시된 개인정보 안내 버전",
  "terms_accepted": true,
  "privacy_accepted": true
}
```

OAuth 인증이 끝난 사실만으로 약관에 동의한 것으로 처리하지 않습니다. 가입을 마치면 원래 팀 안내 페이지로 돌아오며, 관심 등록이나 가입 신청은 해당 화면에서 사용자가 확인하여 실행합니다. 로그인 콜백이나 페이지를 여는 동작으로 팀 가입을 승인하지 않습니다.

## 6. 키 연결 후 완료 판정

1. 배포된 웹의 `/api/auth/providers`에서 준비한 제공자의 `enabled`가 `true`인지 확인합니다. 이는 설정 존재 확인이며 실제 로그인 성공 증거는 아닙니다.
2. 팀 QR 주소에서 제공자 로그인 → 콜백 → 가입 완료 화면 → 닉네임·동의 → 원래 팀 복귀까지 직접 진행합니다.
3. `/api/me`에서 같은 회원을 확인하고 새로고침 후에도 세션이 유지되는지 확인합니다.
4. 로그아웃 후 `/api/me`가 401을 반환하고, 같은 소셜 계정으로 재로그인했을 때 회원이 중복 생성되지 않는지 확인합니다.
5. 로그인 취소·만료된 콜백 재사용·다른 브라우저에서 복사한 콜백은 가입이나 로그인으로 이어지지 않아야 합니다.
6. 관심 등록, 가입 신청, 관리자 승인까지 검증합니다. **가입 신청 직후에는 팀원 권한이 없어야 하고, 승인 후에만 권한이 생겨야 합니다.**

2026-09-15 기준 이 문서의 제공자 콘솔 설정 및 실제 계정 로그인 검증은 미완료입니다. 현재 완료된 것은 코드의 서명·nonce·issuer·audience 등 검증과 인증 API 테스트이며, 실제 제공자 로그인·가입 화면·문서 공개 검증과 구분합니다.
