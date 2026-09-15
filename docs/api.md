# Mefoot 회원·팀 API

회원·팀 6개 테이블과 인증 상태 3개 테이블을 운영 DB에 적용했고, Node API와 Worker 게이트웨이를 구현했다. 단위 검사 53개와 실제 `mefoot_app` 계정의 통합 검사를 통과했다. 현재 문서 시점에는 원격 API 이미지와 Worker 변경을 아직 배포하지 않았다. 실제 OAuth 키·게시한 약관·가입 UI가 준비되지 않아 소셜 제공자는 비활성 상태다.

배포 구성은 [OCI API Stack](../infra/api/README.md), DB 적용과 검증 명령은 [데이터베이스 문서](../database/README.md), 제공자별 준비는 [소셜 로그인 설정](social-login-setup.md)을 따른다.

## 접속과 인증

브라우저는 웹과 같은 출처의 `/api/`를 호출한다. Worker가 OCI API에 공유 키와 클라이언트 IP를 붙이고, 브라우저가 보낸 동일 이름의 헤더는 덮어쓴다. 브라우저에는 DB 비밀번호나 공유 키를 전달하지 않는다.

서버는 `__Host-mefoot_session` 쿠키에서 세션을 확인한다. 쿠키는 `HttpOnly; Secure; Path=/; SameSite=Lax`이며 기본 수명은 14일이다. DB에는 토큰 원문 대신 SHA-256을 저장한다. 일반 변경 요청은 `Origin`이 `APP_ORIGIN`과 정확히 일치해야 한다. Apple의 외부 폼 콜백은 예외로 두고, 대신 일회용 state와 브라우저 연결 쿠키를 검증한다.

JSON 응답에는 `Cache-Control: no-store`를 붙인다. 오류는 `{"error":"오류_코드"}` 형태다. 인증 없음은 401, 권한·출처·공유 키 거부는 403, 입력 오류는 400, 이미 끝난 신청에 다른 결과를 적용하려는 경우는 409다. DB 잠금 시간 초과·교착·쿼리 시간 초과는 재시도 가능한 503으로 응답한다.

단일 API 프로세스에서 클라이언트 IP별 60초 동안 인증 경로는 30회, 그 외 API 경로는 180회까지 허용한다. 초과하면 429다. 만료된 로그인 시도·가입 대기·세션은 1분마다 테이블별 최대 1,000개씩 정리한다. 이 제한은 컨테이너 재시작 시 초기화된다.

## 상태 확인

| 요청 | 확인하는 범위 |
| --- | --- |
| `GET /api/health` | Worker 자체, `scope=worker-only` |
| `GET /api/version` | Worker 환경과 배포 버전 |
| `GET /healthz` | OCI API 프로세스, `scope=process`; DB 조회·공유 키 불필요 |
| `GET /api/health/db` | API의 앱 계정으로 서비스 테이블 조회, `scope=api-and-database` |

`/healthz`는 OCI API 원본 주소 또는 컨테이너 내부에서 확인한다. Worker의 `/api/health` 성공이나 Docker `healthy`만으로 DB·로그인까지 정상이라고 판단하지 않는다.

## 회원과 소셜 로그인

아래 `{provider}`는 `google`, `kakao`, `apple` 중 하나다.

| 메서드·경로 | 동작 |
| --- | --- |
| `GET /api/auth/providers` | 제공자별 사용 가능 여부; 비밀 값은 반환하지 않음 |
| `GET /api/auth/{provider}/start` | 로그인 시작, 제공자 주소로 303 이동 |
| `GET /api/auth/google/callback` | Google 인증 코드 교환·ID 토큰 검증 |
| `GET /api/auth/kakao/callback` | 카카오 인증 코드 교환·ID 토큰 검증 |
| `POST /api/auth/apple/callback` | Apple `form_post` 콜백 검증 |
| `GET /api/auth/registration` | 일회용 가입 쿠키로 닉네임 제안·필수 동의 버전·복귀 경로 조회 |
| `POST /api/auth/register` | 검증된 가입 쿠키와 닉네임·동의로 회원 생성 및 세션 발급 |
| `GET /api/me` | 현재 로그인 회원 |
| `POST /api/auth/logout` | 현재 세션 폐기 및 쿠키 삭제 |

로그인 시작에는 `team_id=<팀 UUID>&intent=view|follow|join`을 붙일 수 있다. `follow`와 `join`에는 팀 ID가 필요하다. OAuth 시도는 10분, 가입 대기는 15분 동안 유효하다. 서명·issuer·audience·nonce를 검증하고 이메일이 같다는 이유로 다른 제공자 계정을 합치지 않는다.

최초 가입 요청의 형태는 다음과 같다. 버전 값은 `/api/auth/registration`이 반환한 실제 게시 버전으로 바꾼다. 클라이언트에서 회원 ID나 소셜 식별자를 정해 보내지 않는다.

```json
{
  "display_name": "운동하는 사람",
  "terms_accepted": true,
  "privacy_accepted": true,
  "terms_version": "<게시한 약관 버전>",
  "privacy_notice_version": "<게시한 개인정보 안내 버전>"
}
```

회원가입 완료는 `{user, next}`를 반환한다. `next`는 `/t/<팀 UUID>?intent=join`과 같은 앱 내부 경로이며, 로그인 자체가 팀 관심 등록이나 가입 신청을 실행하지는 않는다. 같은 가입 토큰의 동시 사용은 한 번만 성공한다.

## 팀과 가입 승인

`{team}`·`{request}`·`{user}`는 UUID다. 회원 ID는 세션에서 얻고, 역할·승인 결과·처리자는 해당 API가 결정한다.

| 메서드·경로 | 권한·입력 |
| --- | --- |
| `GET /api/teams` | 공개 목록; `q`, `limit`, `offset` |
| `POST /api/teams` | 로그인 회원; `name`, `sport`, 선택 소개·지역·로고·신청 허용 여부 |
| `GET /api/teams/{team}` | 공개 소개와 로그인한 본인의 관심·멤버십·최근 신청 |
| `GET /api/me/teams` | 본인의 관심·소속·대기 신청 팀 |
| `PUT /api/teams/{team}/follow` | 본인 관심 등록 |
| `DELETE /api/teams/{team}/follow` | 본인 관심 해제 |
| `POST /api/teams/{team}/join-requests` | 본인 신청; `request_id`, 선택 `message` |
| `GET /api/teams/{team}/join-requests` | 대표·운영진의 대기 목록; `limit`, `offset` |
| `POST /api/teams/{team}/join-requests/{request}/approve` | 대표·운영진 승인; 선택 `resolution_note` |
| `POST /api/teams/{team}/join-requests/{request}/reject` | 대표·운영진 거절; 선택 `resolution_note` |
| `POST /api/teams/{team}/join-requests/{request}/withdraw` | 신청자 취소 |
| `POST /api/teams/{team}/leave` | 본인 탈퇴; 대표는 이관 선행 |
| `PUT /api/teams/{team}/owner` | 대표 이관; 현재 팀원인 대상의 `user_id` |
| `PUT /api/teams/{team}/members/{user}/role` | 대표만 `role=member|admin` 변경 |
| `GET /api/teams/{team}/qr` | 대표·운영진에게 공개 팀 URL 반환 |

목록 기본 크기는 20, 일반 최대는 50, 대기 목록 최대는 100이며 `offset`은 0~10,000이다. 종목은 `football`, `futsal`, `both` 중 하나다. 팀 이름은 60자, 설명은 2,000자, 지역은 100자, 가입 인사는 500자, 처리 사유는 300자까지다.

```json
{
  "name": "우리 풋살팀",
  "sport": "futsal",
  "description": "함께 운동할 팀원을 모집합니다.",
  "region_label": "서울",
  "join_requests_open": true
}
```

```json
{
  "request_id": "<클라이언트에서 새로 만든 UUID>",
  "message": "함께 운동하고 싶어요."
}
```

네트워크 재시도에는 같은 `request_id`를 사용하고 거절·취소 후 재신청에는 새 UUID를 사용한다. 같은 관심 등록·해제와 동일한 승인 결과의 재시도는 중복 데이터를 만들지 않는다. 승인은 팀원 추가와 신청 완료를 한 트랜잭션에서 처리한다. 승인과 취소가 경합하면 먼저 처리한 결과만 확정되고 반대 결과는 409를 받는다.

QR API는 URL을 반환하며 이미지 생성은 화면에서 별도로 수행한다. 팀 소개 수정, 회원 계정 탈퇴, 다른 소셜 계정 추가 연결, 모집 경기 API는 현재 구현 목록에 포함하지 않는다.

## 환경 변수

비밀 값은 Portainer·Worker 비밀 설정 또는 Git에서 제외한 별도 파일로 주입한다. 아래 표의 이름과 역할만 저장소에 둔다.

| 위치 | 변수 | 용도 |
| --- | --- | --- |
| API | `APP_ORIGIN` | 사용자 웹의 HTTPS 출처; 경로·끝 슬래시 없이 지정 |
| API·Worker | `EDGE_SHARED_KEY` | 동일한 무작위 공유 값; API는 최소 32문자 요구 |
| API | `APP_VERSION`, `PORT` | 이미지 commit SHA, 기본 3000 |
| API | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL 접속; 앱 역할은 `mefoot_app` |
| API | `PGSSLROOTCERT`, `PGTLS_SERVERNAME` | 신뢰 인증서 파일과 검증할 서버 이름 |
| API | `TERMS_VERSION`, `PRIVACY_NOTICE_VERSION` | 실제 게시한 필수 동의 문서 버전 |
| API | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google 웹 클라이언트 |
| API | `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`, `KAKAO_OPENID_ENABLED` | 카카오 앱; OIDC 활성화 값은 `true` |
| API | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple Services ID와 서명 키 |
| Worker | `API_ORIGIN` | OCI API의 HTTPS 원본 출처; 사용자 인증 정보·경로·쿼리 불가 |

필수 동의 버전 중 하나라도 없으면 제공자 키가 있어도 모든 제공자를 비활성화한다. 키가 모두 없는 초기 상태에서도 API 프로세스와 공개 팀 조회는 실행할 수 있다. `unpublished`는 내부 비활성 구성 값이며 게시한 약관 버전으로 사용하지 않는다.

## 검증 범위

`npm run check`와 `npm test`로 타입·단위 검사를 실행한다. `tests/api.test.ts`는 공유 키·Origin 차단, IP별 요청 제한, 제공자 미설정, Worker 헤더 전달·쿠키·리디렉션·실패 응답을 검사한다. `tests/auth.test.ts`는 로컬 서명 키로 ID 토큰 조건과 일회용 상태를 검증한다.

`tests/integration.test.ts`는 별도로 활성화했을 때 실제 PostgreSQL 앱 역할을 사용한다. 권한·동시 상태 변경·가입 토큰의 일회성을 검사하고 이번 실행에서 만든 데이터만 정리한다. 실행 방법은 [DB 문서](../database/README.md#적용과-검증-상태)에 있다. 이 검사는 실제 제공자 인증 서버에 로그인하거나 원격 Worker→OCI 경로를 검증한 결과를 대신하지 않는다.
