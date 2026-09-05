# Daily Quiz Battle

Apps in Toss WebView에서 매일 같은 5문제를 풀고 친구와 결과를 비교하는 퀴즈 앱입니다. 현재 working tree에는 **Phase 1~4의 로컬 기능 수직 슬라이스**(오늘 퀴즈, Challenge, 신고·콘텐츠 운영 API, 계정 삭제·알림 outbox·cleanup)가 구현되어 있습니다.

> 아래 현황과 검증은 2026-09-05 KST의 미커밋 working tree 증거입니다. commit 완료나 공개 출시 준비 완료를 뜻하지 않습니다. 실제 Apps in Toss mTLS identity/알림 발송, 콘솔 appName·알림 템플릿, 클라우드 인프라, 실제 기기 QR·접근성 QA, 콘텐츠·개인정보·운영 하드 게이트가 남아 있습니다.

## 현재 구현 범위

- Apps in Toss Web Framework/Devtools 3.1.1 기반 React WebView
- anonymous key bootstrap과 HMAC-SHA256 fingerprint 저장
- development 전용 mock identity 및 production/staging mock fail-fast
- 실제 Apps in Toss `x-anon-key` mTLS 검증 adapter
- 30분 내부 bearer access token(Web 메모리에만 보관)
- KST 기준 오늘의 published 5문항 조회 및 attempt start/resume
- 1~5번 순차 답안 저장, 수정 방지, 멱등 replay/conflict 처리
- `choice_order`를 반영한 서버 채점·리뷰, 단조로운 streak 갱신, retired revision 기존 attempt resume
- 홈, 문제 풀이, 오류/재시도, 결과와 5문항 리뷰 UI
- Challenge 생성·safe landing·원자 claim·참여자 전용 결과와 win/loss/draw
- Web deep link token 즉시 URL 제거, 공유/취소, claim/resume, visibility-aware 결과 polling
- 문제 신고 UI/API, 사용자·사유·시간 bucket dedupe와 최소 정보 저장
- admin JWT scope 경계, 문제 revision lifecycle, daily set 편성·publish, 최소 audit log
- 확인 문구가 필요한 계정 삭제, 인증 무효화, 개인 기록 삭제와 과거 Challenge redaction
- 암호화된 알림 preference, consent-gated outbox, dedupe/retry/terminal worker
- 만료·보존기간 기반 cleanup job
- semantic HTML, ARIA live region, safe area, reduced motion, 작은 화면 대응
- PostgreSQL migration `0001`~`0013`, 제약조건/trigger, 로컬 seed
- pull request/main용 CI 정적 검사·PostgreSQL 통합 테스트·build와 별도 gitleaks job

로컬 구현과 외부 연동 완료는 구분합니다. identity와 notification에는 mTLS adapter가 있지만 실제 자격증명·콘솔 템플릿을 사용한 성공 호출은 확인하지 않았습니다. rate limit은 단일 인스턴스 메모리 store이므로 다중 인스턴스 production 전 shared store가 필요합니다. 운영자가 사용하는 CMS 화면도 아직 없으며 admin content API만 구현되어 있습니다.

## 아키텍처

```text
Apps in Toss WebView (React)
  └─ HTTPS/JSON + memory bearer token
       └─ Fastify API
            ├─ Apps in Toss user-key verifier (production: mTLS)
            ├─ admin JWT content API
            ├─ notification outbox worker / cleanup job
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

- Health: `GET /health/live`, `GET /health/ready`
- Identity: `POST /v1/auth/bootstrap`
- Daily: `POST /v1/daily/start`, `POST /v1/attempts/{attemptId}/answers`, `POST /v1/attempts/{attemptId}/complete`
- Challenge: `POST /v1/challenges`, `GET /v1/challenges/{token}`, `POST /v1/challenges/{token}/claim`, `GET /v1/challenges/{token}/result`
- Report: `POST /v1/reports/questions`
- Notification preference: `GET|PUT /v1/notifications/result-preference`
- Account deletion: `DELETE /v1/me`
- Admin content: `POST|PATCH /v1/admin/content/*`

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

통합 테스트는 Node.js 내장 test runner와 Fastify `inject()`를 사용하며 실제 PostgreSQL에서 8개 suite, 47 tests를 직렬 실행합니다. Daily의 날짜·동시성·`choice_order`·streak·retire resume, Challenge의 token·quota·20-way claim·결과·만료·attempt provenance, 신고 dedupe, admin lifecycle/publish/audit, 삭제/redaction race, cleanup, 암호화 알림 preference, outbox worker의 재시도·동의 철회 동시성을 검증합니다.

테스트 DB 관리자 URL은 `.env`의 `TEST_DATABASE_ADMIN_URL`로 지정할 수 있습니다. 지정하지 않으면 로컬 Compose의 `postgres` maintenance DB를 사용합니다. 이 계정에는 `CREATE DATABASE` 권한이 필요합니다. Harness는 매 실행마다 `daily_quiz_it_<32자리 hex>` 이름의 DB만 생성하고, 이름을 다시 검증한 뒤 해당 DB만 `DROP DATABASE ... WITH (FORCE)`로 제거합니다. 앱 DB, schema, Docker volume은 삭제하지 않으며 최종 검증에서 잔여 임시 DB가 0개인지 확인했습니다.

`build`는 contracts, API, Web을 순서대로 빌드하고 `apps/web/daily-quiz-battle.ait`를 생성합니다. `.ait`, `dist`, local env, DB data, `docs/`는 Git에서 제외됩니다.

2026-09-05 KST working tree 로컬 검증 기록:

- format check, lint, typecheck, contracts/API/Web build 통과
- 실제 PostgreSQL 통합 테스트 **47 tests, 47 pass, 0 fail**
- 빈 임시 DB에 `0001`~`0013` migration/seed 적용과 teardown 통과
- contracts/API/Web production build와 Apps in Toss `.ait` 패키징 통과
- Daily full flow와 `choice_order` 채점, 과거 Challenge 지연 완료 시 streak 비회귀, retired revision의 기존 attempt resume/new start 차단 확인
- Challenge create/claim/result, 20-way claim 1명 수렴, same-set attempt 재사용, win/loss/draw, expiry와 참여자 권한 확인
- report 최소 저장·dedupe, admin JWT scope/lifecycle/daily publish/audit, 삭제/redaction, cleanup, notification preference/outbox/worker 확인
- 390×844 브라우저에서 Challenge 양측 무승부 결과, raw token이 제거된 `/challenge` URL, 문항 신고, 알림 preference, 계정 삭제 terminal 화면 확인
- `corepack pnpm audit` 결과 알려진 취약점 0건. 취약한 transitive `esbuild`는 workspace override로 `0.25.12`에 고정

`.github/workflows/ci.yml`은 pull request/main에서 install, format, lint, typecheck, high-severity dependency audit, PostgreSQL integration test, build와 별도 gitleaks job을 실행하도록 구성됐습니다. 현행 미커밋 workflow의 원격 CI 성공 증거는 아직 없으며, 위 결과는 2026-09-05 KST 로컬 실행 증거입니다.

## 보안·데이터 원칙

- anonymous key 원문은 DB에 저장하지 않고 pepper를 사용한 HMAC fingerprint만 저장합니다.
- authorization/anonymous key는 Fastify log redaction 대상입니다.
- access token은 Web 메모리에만 두고 기본 1,800초 후 만료합니다.
- API 응답에는 `Cache-Control: no-store`, referrer policy에는 `no-referrer`를 적용합니다.
- CORS는 `.env`의 정확한 origin 목록만 허용하며 wildcard를 거부합니다.
- published question revision과 daily set item은 DB trigger로 변경을 막습니다.
- attempt/answer/idempotency는 unique/check constraint와 row lock transaction으로 보호합니다.
- Challenge public token 원문은 DB에 저장하지 않고 hash만 저장하며 deep link 진입 즉시 주소에서 제거합니다.
- 알림 대상 anonymous key는 application-level 암호화 후 저장하고 철회/삭제 시 제거합니다.
- 계정 삭제는 token version을 올리고 개인 attempt/answer/report/idempotency/notification 데이터를 삭제하며 과거 Challenge 상대에게 삭제 사용자 점수·nickname을 노출하지 않습니다.
- 실제 인증서, private key, production anon key/token을 저장소나 `VITE_*` 변수에 넣지 않습니다.

## Apps in Toss 배포 전 필수 확인

`apps/web/apps-in-toss.config.ts`의 `appName: "daily-quiz-battle"`은 임시값입니다. 콘솔 등록 후 변경할 수 없는 값이므로 다음을 확정하기 전 임시값으로 등록하지 않습니다.

1. production appName, 앱 상세 정보와 알림 template/templateSet code
2. 실제 mTLS 인증서/키로 identity와 notification send 성공 경로 검증
3. production API origin/CORS와 다중 인스턴스 shared rate-limit store
4. 실제 iOS/Android Apps in Toss QR E2E
5. VoiceOver/TalkBack, keyboard-only, 200% 확대 수동 QA
6. 150개+ 검수 콘텐츠와 14+ 적합성 증거
7. production monitoring/alert, backup/restore, 개인정보처리방침·법무·검수

## 개발 문서와 Git 정책

상세 문서는 `docs/development/00_개발_허브.md`에서 시작합니다. 요구사항, 아키텍처, 상태 머신, DB, API 보안, UX/접근성, 로컬 환경, QA, 운영, 진행 현황을 파일별로 나눴습니다.

사용자 요청에 따라 `/docs/` 전체는 `.gitignore`로 제외됩니다. 로컬 개발 판단에는 사용하되, 팀 공유가 필요한 계약·출시 증거는 별도 접근 제어 저장소를 정해야 합니다.
