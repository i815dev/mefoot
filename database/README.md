# 회원·팀 데이터베이스

운영 PostgreSQL 18.6의 `mefoot` 스키마에 정식 마이그레이션 `001`, `002`를 적용했습니다. 서비스 테이블 9개와 적용 이력 테이블 `schema_migrations` 1개가 있습니다. 현재 CI/CD와 API 컨테이너 시작 과정은 SQL을 자동 적용하지 않습니다.

- 제품 흐름·권한·상태 전이: [설계 문서](../docs/member-team-data-model.md)
- 회원·팀 6개 테이블·제약·트리거: [정식 001](migrations/001_members_teams.sql)
- OAuth 시도·가입 대기·세션 3개 테이블: [정식 002](migrations/002_auth_sessions.sql)
- 트랜잭션·적용 이력 실행기: [migrate.ts](../server/migrate.ts)
- API와 운영 설정: [API 문서](../docs/api.md)
- 원래 설계 기록: [SQL 초안](drafts/001_members_teams.sql)
- 상태와 제약 검사 25개: [검증 SQL](tests/001_members_teams.sql)
- psql에서 생성과 검사를 모두 되돌리는 실행 파일: [validate-draft.sql](validate-draft.sql)

운영 앱 역할 `mefoot_app`으로 TLS 1.3 접속과 서비스 데이터 DML을 확인했습니다. 이 역할에는 스키마 CREATE와 `schema_migrations` SELECT 권한이 없습니다. DDL 적용은 별도의 개발·마이그레이션 역할로 수행합니다.

## 적용과 검증 상태

전체 단위 검사 53개가 통과했습니다. [실제 DB 통합 검사](../tests/integration.test.ts)는 `mefoot_app`으로 세션·권한 경계·중복 관심/신청·동시 승인·승인과 취소의 경합·대표 이관·일회용 OAuth/가입 토큰·로그아웃을 검증했고, 실행에서 만든 테스트 데이터가 정리된 것도 확인했습니다. 실제 소셜 제공자 로그인과 원격 API/Worker 배포는 아직 확인 전입니다.

마이그레이션 실행기는 파일 이름과 SHA-256을 `schema_migrations`에 기록합니다. 이미 적용한 파일의 내용이 달라지면 오류를 내므로 **적용된 001·002는 수정하지 않고 다음 변경을 003 이후 파일로 추가**합니다. 실행 전체를 한 트랜잭션과 마이그레이션용 advisory lock으로 묶으며, 완료되지 않으면 변경과 이력 모두 롤백합니다.

서버 인증서와 마이그레이션 역할의 접속 설정이 들어 있는 별도 비밀 파일을 준비한 뒤, 저장소 루트에서 실행합니다. `/absolute/path/to/`는 실제 로컬 경로로 바꾸며 파일을 Git에 넣지 않습니다.

```sh
node --env-file=/absolute/path/to/mefoot-migration.env server/migrate.ts
```

필요한 연결 변수는 `PGHOST`, `PGPORT`, `PGDATABASE=mefoot`, 마이그레이션용 `PGUSER`, `PGPASSWORD`, `PGSSLROOTCERT`입니다. 접속 호스트와 인증서 검증 이름이 다를 때는 `PGTLS_SERVERNAME`도 지정합니다. 실행 결과의 `applied`가 빈 배열이면 모든 파일이 이미 같은 내용으로 적용된 상태입니다.

단위 검사와 실제 DB 검사는 분리되어 있습니다. `npm test`는 별도 활성화가 없으면 통합 검사를 건너뜁니다. 실제 DB 검사는 허용된 접속 위치에서 앱 역할용 비밀 파일을 사용합니다. 임의의 관리자 계정으로 바꾸어 통과시키지 않습니다.

```sh
npm run check
npm test
MEFOOT_INTEGRATION=1 node --env-file=/absolute/path/to/mefoot-app.env --test tests/integration.test.ts
```

## 최초 초안 검사 기록

2026-09-15 최초 설계 검증에서는 OCI PostgreSQL 18.6에 DBHub MCP로 접속해 초안과 검증 SQL을 한 트랜잭션에서 실행했습니다. 제약 검사 25개가 통과한 뒤 당시 DDL과 데이터를 모두 되돌렸습니다. 이후 사용자 승인으로 정식 마이그레이션을 적용했으므로, 당시 확인한 테이블 0개 상태는 현재 상태가 아닙니다.

MCP는 여러 SQL문을 한 트랜잭션에 묶으므로, 이번 검증은 SQL문 앞에 SAVEPOINT를 만들고 DDL·검사·지연 FK 확인 후 그 SAVEPOINT까지 ROLLBACK하는 방식으로 실행했습니다. psql 실행 파일은 위와 같은 SQL 본문을 사용하되 자체 BEGIN/ROLLBACK을 사용합니다. psql 실행 파일 자체는 이 Mac에 psql이 없어 실행하지 않았습니다.

연결 설정과 신뢰 인증서를 외부에서 설정한 psql 환경에서는 저장소 루트에서 다음 명령으로 재현할 수 있습니다. 반드시 신규 테이블 이름이 없는 개발·검증 DB에서 실행합니다.

```sh
psql -X -v ON_ERROR_STOP=1 -f database/validate-draft.sql
```

초안은 기존 `mefoot` 스키마와 CREATE 권한을 전제로 합니다. 테이블이 이미 있으면 오류를 내며 기존 데이터를 삭제하거나 덮어쓰지 않습니다. 오류 발생 시 psql 연결이 종료되며 열린 트랜잭션은 롤백됩니다. **초안 검증 파일을 현재 운영 스키마에 다시 실행하지 않습니다.** 이후 운영 변경은 `migrations/`와 실행기를 사용합니다. 역방향 DROP 스크립트는 포함하지 않습니다.
