# Daily Quiz Battle

Apps in Toss WebView에서 매일 같은 5문제를 풀고 서버 채점 결과와 해설을 확인하는 퀴즈 앱입니다. 현재 **Phase 1: 혼자 오늘 퀴즈 완료** 수직 슬라이스가 로컬에서 구현·검증됐습니다.

> 공개 출시 준비가 끝난 상태는 아닙니다. 실제 Apps in Toss mTLS 자격증명, production appName, 클라우드 인프라, 기기 QR E2E, 콘텐츠·개인정보·운영 하드 게이트가 남아 있습니다.

## 현재 구현 범위

- Apps in Toss Web Framework/Devtools 3.1.1 기반 React WebView
- anonymous key bootstrap과 HMAC-SHA256 fingerprint 저장
- development 전용 mock identity 및 production/staging mock fail-fast
- 실제 Apps in Toss `x-anon-key` mTLS 검증 adapter
- 30분 내부 bearer access token(Web 메모리에만 보관)
- KST 기준 오늘의 published 5문항 조회 및 attempt start/resume
- 1~5번 순차 답안 저장, 수정 방지, 멱등 replay/conflict 처리
- 서버 전용 채점, 완료 상태·streak 갱신, 완료 후 정답/해설 공개
- 홈, 문제 풀이, 오류/재시도, 결과와 5문항 리뷰 UI
- semantic HTML, ARIA live region, safe area, reduced motion, 작은 화면 대응
- PostgreSQL migration, 제약조건/trigger, 로컬 seed

아직 구현하지 않은 주요 범위는 친구 challenge 생성·claim·결과, 알림, 운영 CMS, 신고/삭제 lifecycle, 실제 배포 인프라와 출시 운영입니다.

## 아키텍처

```text
Apps in Toss WebView (React)
  └─ HTTPS/JSON + memory bearer token
       └─ Fastify API
            ├─ Apps in Toss user-key verifier (production: mTLS)
            └─ PostgreSQL 18.6
```

브라우저는 PostgreSQL에 직접 접근하지 않습니다. 정답과 해설은 완료 전 public API payload에 포함되지 않으며 점수는 서버가 저장된 question revision으로 계산합니다.

## Workspace

| 경로                 | 역할                                                  |
| -------------------- | ----------------------------------------------------- |
| `apps/web`           | React 19 UI, Apps in Toss SDK/Devtools, `.ait` 빌드   |
| `apps/api`           | Fastify API, 인증, 도메인 transaction, migration/seed |
| `packages/contracts` | Web/API가 공유하는 Zod wire contract                  |
| `docs/development`   | 로컬 상세 개발 참고 문서(Git 제외)                    |

핵심 버전은 exact pin입니다: Node.js 24+, pnpm 11.24.0, React 19.2.8, Vite 8.2.2, Fastify 5.12.1, Zod 4.5.2, Drizzle ORM 0.45.2, postgres.js 3.4.9, PostgreSQL 18.6.

## 사전 요구사항

- Node.js 24 이상
- Corepack
- Docker Desktop 또는 Docker Engine + Compose
- Git

Windows PowerShell에서 확인:

```powershell
node --version
corepack --version
docker --version
docker compose version
```

## 최초 실행

### 1. 의존성과 환경 파일 준비

```powershell
corepack enable
corepack pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

`.env`는 로컬 전용이며 Git에 포함되지 않습니다. 예제의 pepper/token secret은 개발 placeholder이므로 staging/production에서 사용할 수 없습니다. Web도 workspace 루트 `.env`의 `VITE_*` 값을 읽지만, `VITE_*` 변수는 브라우저 번들에 공개되므로 secret을 넣으면 안 됩니다.

### 2. PostgreSQL과 데이터 준비

```powershell
docker compose up -d postgres
docker compose ps
corepack pnpm db:migrate
corepack pnpm db:seed
```

정상 seed는 서버의 현재 KST 날짜에 맞는 published daily set과 5문항을 만듭니다. migration은 checksum을 확인하며, seed는 같은 날짜에 다시 실행해도 중복 생성을 피합니다.

### 3. 개발 서버 실행

장시간 실행되는 서버이므로 두 PowerShell 터미널에서 각각 실행합니다.

```powershell
corepack pnpm dev:api
```

```powershell
corepack pnpm dev:web
```

기본 주소:

- Web/AIT Devtools: `http://localhost:5173`
- API: `http://127.0.0.1:3000`
- PostgreSQL: `localhost:5432`
- Liveness: `http://127.0.0.1:3000/health/live`
- Readiness: `http://127.0.0.1:3000/health/ready`

Apps in Toss Devtools가 반환하는 고정 mock anonymous key와 `dev-` prefix key는 API의 **development mock mode에서만** 허용됩니다. `APP_ENV`가 staging/production인데 mock mode이면 API가 기동을 거부합니다.

### 4. 종료

API/Web 터미널은 `Ctrl+C`로 종료합니다. PostgreSQL volume을 보존하며 컨테이너만 중지하려면:

```powershell
docker compose stop postgres
```

volume 삭제는 로컬 DB를 모두 제거하는 파괴적 작업이므로 이 문서에서는 자동화하지 않습니다.

## 주요 API 흐름

| Method | Path                                | 설명                                    |
| ------ | ----------------------------------- | --------------------------------------- |
| `GET`  | `/health/live`                      | 프로세스 liveness                       |
| `GET`  | `/health/ready`                     | DB readiness                            |
| `POST` | `/v1/auth/bootstrap`                | anonymous key 검증 후 access token 발급 |
| `POST` | `/v1/daily/start`                   | 오늘 attempt 생성 또는 기존 상태 resume |
| `POST` | `/v1/attempts/{attemptId}/answers`  | 순차 답안 저장; `Idempotency-Key` 필수  |
| `POST` | `/v1/attempts/{attemptId}/complete` | 서버 채점·완료; `Idempotency-Key` 필수  |

Web/API는 `packages/contracts`의 Zod schema로 응답을 다시 검증합니다. 같은 멱등 key와 같은 payload는 저장된 응답을 replay하고, 다른 payload 재사용은 `409 IDEMPOTENCY_KEY_REUSED`로 거부합니다.

## 품질 검증

PostgreSQL을 시작한 뒤 전체 검증을 실행합니다.

```powershell
docker compose up -d --wait postgres
corepack pnpm test:integration
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
```

통합 테스트는 Node.js 내장 test runner와 Fastify `inject()`를 사용하며 실제 PostgreSQL에서 다음 7개 시나리오를 직렬 실행합니다.

1. migration/seed 반복 실행과 readiness
2. start/resume → 답안 5개 → complete, 멱등 replay/conflict
3. 인증·소유권·순서·revision·미완료 오류와 transaction rollback
4. 동시 start와 서로 다른 Idempotency-Key의 answer/complete 요청 수렴
5. KST 자정 set 전환과 다음 날 01:00 grace 경계
6. 핵심 CHECK constraint와 published/answer 불변성 trigger
7. daily set lifecycle 보호와 publication/item mutation 직렬화

테스트 DB 관리자 URL은 `.env`의 `TEST_DATABASE_ADMIN_URL`로 지정할 수 있습니다. 지정하지 않으면 로컬 Compose의 `postgres` maintenance DB를 사용합니다. 이 계정에는 `CREATE DATABASE` 권한이 필요합니다. Harness는 매 실행마다 `daily_quiz_it_<32자리 hex>` 이름의 DB만 생성하고, 이름을 다시 검증한 뒤 해당 DB만 `DROP DATABASE ... WITH (FORCE)`로 제거합니다. 앱 DB, schema, Docker volume은 삭제하지 않으며 최종 검증에서 잔여 임시 DB가 0개인지 확인했습니다.

`build`는 contracts, API, Web을 순서대로 빌드하고 `apps/web/daily-quiz-battle.ait`를 생성합니다. `.ait`, `dist`, local env, DB data, `docs/`는 Git에서 제외됩니다.

2026-08-29 로컬 검증 결과:

- frozen install, format check, lint, typecheck 통과
- 실제 PostgreSQL 통합 테스트 7/7 통과
- 빈 임시 DB에 `0001`+`0002`+`0003` migration/seed 멱등 실행과 기존 개발 DB forward migration 통과
- contracts/API/Web production build와 Apps in Toss `.ait` 패키징 통과
- API bootstrap → start/resume → 답안 5개 → complete 전체 흐름 통과
- answer/complete replay, 다른 payload conflict, 실패 idempotency rollback 확인
- cross-user 권한, 순서/revision 오류, token version 무효화 확인
- 8-way start는 attempt 1개로 수렴했고, 서로 다른 8개 Idempotency-Key의 answer는 200 1건과 `ANSWER_ALREADY_SUBMITTED` 7건이며 processing record는 0개, 서로 다른 8개 key의 complete는 모두 동일한 200을 반환하고 streak는 한 번만 변경됨을 확인
- KST 자정과 정확히 01:00 grace deadline의 완료/abandon 상태 확인
- submitted answer UPDATE/DELETE와 published revision/set item 변경 차단 확인
- `0003`의 published→draft 차단, non-draft parent 삭제 차단, ordered parent `FOR UPDATE` lock을 통한 publication/item mutation 직렬화 확인
- semantic follow-up `APPROVED`, High/Medium finding 0건, supplemental real-PostgreSQL probe 통과
- 브라우저 홈 → 5문제 → 5/5 결과와 다섯 해설 확인
- 재진입 시 저장된 completed result 복구, 현재 콘솔 오류 0건/API 요청 200 확인
- 390px viewport에서 가로 overflow 없음 확인

실제 Toss WebView 기기 QR E2E, real mTLS, 수동 접근성, 전체 DDL constraint 조합과 Challenge 동시 claim 검증은 후속 작업입니다.

## 보안·데이터 원칙

- anonymous key 원문은 DB에 저장하지 않고 pepper를 사용한 HMAC fingerprint만 저장합니다.
- authorization/anonymous key는 Fastify log redaction 대상입니다.
- access token은 Web 메모리에만 두고 기본 1,800초 후 만료합니다.
- API 응답에는 `Cache-Control: no-store`, referrer policy에는 `no-referrer`를 적용합니다.
- CORS는 `.env`의 정확한 origin 목록만 허용하며 wildcard를 거부합니다.
- published question revision과 daily set item은 DB trigger로 변경을 막습니다.
- attempt/answer/idempotency는 unique/check constraint와 row lock transaction으로 보호합니다.
- 실제 인증서, private key, production anon key/token을 저장소나 `VITE_*` 변수에 넣지 않습니다.

## Apps in Toss 배포 전 필수 확인

`apps/web/apps-in-toss.config.ts`의 `appName: "daily-quiz-battle"`은 임시값입니다. 콘솔 등록 후 변경할 수 없는 값이므로 다음을 확정하기 전 임시값으로 등록하지 않습니다.

1. production appName과 앱 상세 정보
2. 실제 mTLS 인증서/키와 Secret 주입 방식
3. production API origin/CORS
4. Apps in Toss QR 기기 E2E
5. 개인정보처리방침, 삭제·보존 정책, 고객지원 책임자
6. 14+ 검토 콘텐츠와 공개 출시 하드 게이트

## 개발 문서와 Git 정책

상세 문서는 `docs/development/00_개발_허브.md`에서 시작합니다. 요구사항, 아키텍처, 상태 머신, DB, API 보안, UX/접근성, 로컬 환경, QA, 운영, 진행 현황을 파일별로 나눴습니다.

사용자 요청에 따라 `/docs/` 전체는 `.gitignore`로 제외됩니다. 로컬 개발 판단에는 사용하되, 팀 공유가 필요한 계약·출시 증거는 별도 접근 제어 저장소를 정해야 합니다.
