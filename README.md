# Daily Quiz Battle

Apps in Toss WebView에서 매일 같은 5문제를 풀고 친구와 결과를 비교하는 퀴즈 앱입니다. 현재 working tree에는 **Phase 1~4의 로컬 기능 수직 슬라이스**(오늘 퀴즈, Challenge, 신고·콘텐츠 운영 API, 계정 삭제·알림 outbox·cleanup)가 구현되어 있습니다.

> 기준 commit은 `72dd2da`이며, 아래 신규 신고 triage·kill switch·외부 API 계약 보강은 2026-09-05 KST의 미커밋 working tree 증거입니다. 공개 출시 준비 완료를 뜻하지 않습니다. 실제 Apps in Toss mTLS identity/알림 발송, 콘솔 appName·알림 템플릿, 클라우드 인프라, 실제 기기 QR·접근성 QA, 콘텐츠·개인정보·운영 하드 게이트가 남아 있습니다.

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
- 신고 queue 조회·상태 triage·문항 correction 연결과 전용 admin scope
- 독립 CMS의 memory-only admin JWT, revision lifecycle, daily set 편성·publish·void/correction, 최소 audit log
- 확인 문구가 필요한 계정 삭제, 인증 무효화, 개인 기록 삭제와 과거 Challenge redaction
- 암호화된 알림 preference, consent-gated outbox, dedupe/retry/terminal worker
- advisory lock 기반 operations scheduler, 만료·보존기간 cleanup, 실행 ledger
- Redis 공유 rate limit, 보호된 Prometheus metrics, local alert/dashboard profile
- Daily/Challenge drain-aware write, notification delivery, Analytics publish kill switch
- Apps in Toss HTTP 200 business envelope 및 `errorCode` 계약 검증
- semantic HTML, ARIA live region, safe area, reduced motion, 작은 화면 대응
- PostgreSQL migration `0001`~`0017`, 제약조건/trigger, 로컬 seed
- pull request/main용 CI 정적 검사·PostgreSQL 통합 테스트·build와 별도 gitleaks job

로컬 구현과 외부 연동 완료는 구분합니다. identity와 notification에는 mTLS adapter가 있지만 실제 자격증명·콘솔 템플릿을 사용한 성공 호출은 확인하지 않았습니다. development는 in-memory rate limit fallback을 허용하지만 staging/production은 Redis URL이 없으면 시작하지 않습니다. CMS는 별도 Vite bundle로 구현됐지만 production IAM/SSO와 배포 공급자는 아직 정해지지 않았습니다.

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

## Docker 로컬 API 패키지

`local-app` Compose profile은 공급자 결정 전 로컬에서만 API image, migration, health를 확인하기 위한 opt-in 경로입니다. 기본 `docker compose up -d postgres` 사용법은 그대로 유지되며, profile을 지정하지 않으면 API와 migration 서비스는 실행되지 않습니다.

이 image는 Node.js 24와 pnpm 11.24.0으로 contracts/API를 multi-stage build하고, runtime에서는 비root `node` 사용자로 실행합니다. `.env`, 인증서, `docs`, `node_modules`, `dist`, `.git`은 build context에서 제외되며 image에 실제 자격증명을 넣지 않습니다. Compose가 주입하는 secret 형태의 값은 모두 development 전용 local placeholder입니다.

### Image build

저장소 루트에서 local image를 build합니다.

```powershell
docker compose --profile local-app build api
```

### PostgreSQL, migration, API 실행과 health 확인

다음 명령은 PostgreSQL health를 기다리고 migration이 성공한 뒤 API를 시작하며 API readiness까지 기다립니다. migration은 checksum 기반으로 이미 적용한 파일을 다시 적용하지 않으며 seed는 실행하지 않습니다.

```powershell
docker compose --profile local-app up -d --build --wait api
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

API와 PostgreSQL port는 각각 `127.0.0.1:3000`, `127.0.0.1:5432`에만 bind됩니다.

기존 API가 3000을 사용 중이면 PowerShell에서 `$env:LOCAL_API_PORT="3001"`로 설정한 뒤 실행합니다. 이 경우 health 확인 주소도 `http://127.0.0.1:3001/health/ready`입니다. 기존 프로세스를 종료할 필요는 없습니다.

### 일회성 작업

Migration을 명시적으로 다시 실행:

```powershell
docker compose --profile local-app run --rm migrate
```

현재 KST 날짜의 로컬 seed를 명시적으로 실행:

```powershell
docker compose --profile local-app run --rm api node apps/api/dist/db/seed.js
```

보존기간 cleanup을 명시적으로 실행:

```powershell
docker compose --profile local-app run --rm api node apps/api/dist/maintenance/run-cleanup.js
```

알림 outbox worker를 명시적으로 실행:

```powershell
docker compose --profile local-app run --rm api node apps/api/dist/notification/run-worker.js
```

위 일회성 seed, cleanup, worker 명령은 계속 독립적으로 사용할 수 있으며 기존 DB나 volume을 초기화하거나 삭제하지 않습니다. `local-app` profile 자체는 migration 외 작업을 자동 실행하지 않습니다.

### Operations scheduler

API와 별도 process로 notification worker와 cleanup을 반복 실행하는 opt-in `operations` profile을 시작합니다. 이 profile은 같은 API image를 사용하고 PostgreSQL health와 Redis, migration 완료를 기다리지만 API server는 시작하지 않습니다.

```powershell
docker compose --profile operations up -d --build operations
docker compose logs -f operations
```

개발 기본값은 notification worker 30초, cleanup 24시간입니다. `OPERATIONS_NOTIFICATION_INTERVAL_SECONDS`는 15~~300의 정수, `OPERATIONS_CLEANUP_INTERVAL_HOURS`는 1~~24의 정수만 허용합니다. 각 task는 이전 batch가 끝난 뒤 다음 interval을 기다리며, PostgreSQL advisory lock으로 여러 scheduler replica 중 하나만 같은 task를 실행합니다. 실패 시 raw error나 secret 없이 task와 정적 status만 기록하고 최대 5분의 지수 backoff를 적용합니다. 성공 log에는 처리 count와 duration만 추가합니다.

실제 Apps in Toss 알림 template set code와 mTLS certificate/key가 없는 development 구성에서는 notification task를 실행하지 않고 `disabled_unconfigured`를 한 번 기록합니다. cleanup은 계속 실행됩니다. 로컬 Node.js에서 같은 scheduler를 실행할 때는 다음 script를 사용합니다.

```powershell
corepack pnpm --filter @daily-quiz-battle/api operations:schedule
```

Scheduler만 중지하려면 다음 명령을 사용합니다. Compose가 SIGTERM을 보내면 새 batch를 시작하지 않고 진행 중인 batch와 DB close를 기다리며, local DB volume은 보존됩니다.

```powershell
docker compose --profile operations stop operations
```

staging/production에서는 올바른 interval 설정과 함께 `OPERATIONS_SCHEDULER_ENABLED=true`를 명시해야 scheduler가 시작됩니다. production은 이 development Compose profile이 아니라 별도 외부 orchestrator에서 `node apps/api/dist/operations/scheduler.js`를 API와 분리해 실행해야 합니다. Advisory lock은 replica 중복 실행만 막으며 배포, restart/health monitoring, alerting, secret·mTLS certificate 주입, Apps in Toss template 설정을 제공하지 않습니다. 현재 저장소에는 cloud 공급자 설정이나 실제 template/certificate가 없으므로 production scheduler 실행 또는 실제 알림 발송 완료를 검증한 상태가 아닙니다.

### Scale-to-zero 배포 준비

Cloud Run처럼 요청이 없으면 중지되는 API 안에서 상시 scheduler를 실행하면 안 됩니다.
예약 container job에는 아래의 단일 실행 명령을 사용합니다. 실제 cloud job이나 trigger를
생성한 상태는 아니며, 주기·재시도·IAM·비용 한도는 배포 시 별도로 구성해야 합니다.

```powershell
corepack pnpm --filter @daily-quiz-battle/api operations:once
# 빌드된 API image의 job command
node apps/api/dist/operations/scheduler.js --once
```

`--once`는 활성 task를 순차적으로 한 번 실행하고 DB를 닫습니다. 중복 lock은 건너뛰며,
task·ledger·인프라 실패나 실행 중 종료 신호는 nonzero exit로 재시도 대상이 됩니다.
staging/production은 이 모드도 `OPERATIONS_SCHEDULER_ENABLED=true`가 필요합니다.
알림은 `NOTIFICATION_DELIVERY_ENABLED=false`를 유지해도 cleanup은 실행됩니다.

- `DATABASE_POOL_MAX`는 기본 5, 허용 범위 3~20입니다. 상시 scheduler의 두 lock session과
  실제 task query가 경쟁하므로 3 미만은 허용하지 않습니다. API replica와 job을 합산해
  provider의 연결 한도 및 migration/admin 여유를 확보해야 합니다.
- operations는 PostgreSQL **direct 또는 session pooler**를 사용합니다. Transaction
  pooler는 session advisory lock을 보장하지 않으며 `prepare:false`만으로 해결되지 않습니다.
- 외부 PostgreSQL URL에는 `sslmode=verify-full`을 사용하고, 필요한 CA를 신뢰 저장소에
  제공해야 합니다. 현재 postgres.js의 `sslmode=require`는 인증서를 검증하지 않습니다.
  외부 Redis는 REST URL이 아니라 native `rediss://` URL을 사용합니다.
- Cloud Run은 container port 3000과 `API_PORT=3000`, `API_HOST=0.0.0.0`을 맞춥니다.
  플랫폼의 `PORT`만 설정하면 현재 API 설정에 반영되지 않습니다.
- readiness와 보호된 metrics는 DB를 조회합니다. Scale-to-zero DB에 로컬의 15초 scrape를
  그대로 적용하지 말고, process liveness와 실제 dependency 점검 주기를 구분해야 합니다.
- 실제 mTLS/secret 주입, 정확한 CORS, Supabase Data API를 통한 무권한 접근 차단,
  외부 backup/restore 및 토스 실기기 검증은 여전히 출시 게이트입니다.
  무료 한도나 예산 알림은 무제한 사용 또는 초과 과금 차단을 보장하지 않습니다.

단일 실행 배포 준비의 로컬 검증: focused CLI/DB 설정 **23/23**, 전체 PostgreSQL·Redis
회귀 **114/114** 통과. lint/typecheck/전체 build/format check와 Docker image build를
통과했고, 빌드된 image의 `--once`를 격리 DB에서 실행해 cleanup 성공 ledger와 종료를
확인했습니다. 임시 테스트 DB는 0개이며 실제 managed DB TLS/mTLS·cloud 배포 증거는 아닙니다.

### Netlify Free 배포 구성

루트 `netlify.toml`은 API Functions와 별도 운영자 CMS를 빌드합니다. 사용자용
Apps in Toss Web은 이 publish 대상이 아니며 기존 `.ait` 배포 절차를 유지합니다.
CMS는 동일 origin의 API를 사용합니다. `/v1/*`, `/health/*`, `/internal/metrics`는
API function으로 연결되고 기존 인증·CORS·metrics token 검증을 유지합니다.

- Netlify 환경 변수에 `APP_ENV=production`, 실제 인증 mTLS, 독립적인 production
  secret, 검증된 PostgreSQL TLS URL, native `rediss://` URL과 정확한 CORS origin을
  설정합니다. 루트 `.env`를 업로드하거나 secret을 `VITE_*`에 넣지 않습니다.
- API는 `DATABASE_URL`, 예약 작업은 별도 `OPERATIONS_DATABASE_URL`을 사용합니다.
  후자는 `sslmode=verify-full`인 direct/session 연결이어야 합니다.
- 예약 function은 매일 UTC 00:00(KST 09:00)에 단일 실행합니다.
  `OPERATIONS_SCHEDULER_ENABLED=true`가 필요하며 출시 전에는
  `NOTIFICATION_DELIVERY_ENABLED=false`를 유지합니다. 이 일일 실행은 30초 간격의
  알림 worker를 대체하지 않습니다.
- 배포 전에 migration과 콘텐츠 준비, Supabase Data API 무권한 접근 차단,
  실제 DB/Redis TLS 연결, 예약 작업의 플랫폼 실행 시간 제한과 실패 감시,
  무료 한도 소진 시 동작을 검증해야 합니다.

이 설정 파일과 로컬 테스트는 실제 Netlify 배포·운영 검증의 증거가 아닙니다.

### Local monitoring

공급자 선택 전 metrics scrape, alert rule, dashboard를 로컬에서 확인하는 opt-in `monitoring` profile입니다. 다음 명령은 Grafana의 dependency인 Prometheus와 API, migration, Redis, PostgreSQL을 함께 시작하지만 operations scheduler는 시작하지 않습니다.

```powershell
docker compose --profile monitoring up -d --build --wait grafana
```

Prometheus는 Docker internal network에서 `http://api:3000/internal/metrics`를 15초마다 scrape합니다. API와 Prometheus가 공유하는 `METRICS_ACCESS_TOKEN`은 repository에 명시된 development placeholder일 뿐 실제 secret이 아니며 production에서 재사용할 수 없습니다. Prometheus와 Grafana host port도 각각 `127.0.0.1:9090`, `127.0.0.1:3002`에만 bind되고 metrics 전용 public port는 노출하지 않습니다.

Prometheus 상태와 alert evaluation은 다음 local URL에서 확인합니다.

- targets: `http://127.0.0.1:9090/targets`
- alert rules: `http://127.0.0.1:9090/alerts`

Alert rules는 API target down, 5분 동안 최소 20 request가 있는 경우의 5xx 비율 5% 초과, 1초를 넘는 p95 latency release-stop 기준, notification outbox pending 100개 초과, oldest pending age 5분 초과, failed count 증가를 포함합니다. 이 profile에는 Alertmanager나 production notification routing이 없으므로 Prometheus에서 상태를 평가하고 표시할 뿐 외부로 alert를 전송하지 않습니다.

Grafana는 `http://127.0.0.1:3002`에서 `admin` / `local-only-grafana-admin`으로 로그인합니다. Grafana provisioning은 포함하지 않습니다. **Connections → Data sources**에서 Prometheus data source를 추가하고 server URL을 `http://prometheus:9090`으로 저장한 뒤, **Dashboards → New → Import**에서 `ops/monitoring/grafana-dashboard.json`을 upload하고 그 data source를 선택합니다. Dashboard에는 request rate, 5xx ratio, p95 latency, outbox pending/oldest age/failed gauge와 API target health가 있습니다.

기본 port가 이미 사용 중이면 실행 전에 override합니다.

```powershell
$env:LOCAL_PROMETHEUS_PORT="19090"
$env:LOCAL_GRAFANA_PORT="13002"
docker compose --profile monitoring up -d --build --wait grafana
```

이 구성은 local development 패키지이며 production monitoring 완료를 뜻하지 않습니다. Production provider, durable storage/retention, authentication, TLS, Alertmanager routing, notification destination과 on-call 운영 절차는 아직 결정·구성·검증되지 않았습니다. 외부 interface에 port를 bind하거나 development token과 Grafana password를 staging/production에서 사용하면 안 됩니다.

### 종료

local-app profile의 API, migration, PostgreSQL container와 network를 내리되 named volume은 보존합니다.

```powershell
docker compose --profile local-app down
```

`down -v`는 기존 로컬 DB를 삭제하므로 사용하지 않습니다.

이 profile은 `APP_ENV=development`, `IDENTITY_VERIFICATION_MODE=mock`, HTTP, local placeholder secret을 사용하는 **mock/local-only** 구성입니다. Apps in Toss 콘솔 등록, 실제 mTLS identity, 실제 알림 template/발송, TLS termination, production secret 관리, cloud 배포·과금 환경을 구성하거나 검증하지 않습니다. 외부에서 접근 가능한 배포 또는 production image로 사용하면 안 됩니다.

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

테스트는 Node.js 내장 runner와 Fastify `inject()`로 직렬 실행합니다. 실제 PostgreSQL·Redis 통합 검증과 외부 연결 없는 adapter/CLI 검증을 포함합니다. Daily의 날짜·동시성·`choice_order`·streak·retire/void와 drain switch, Challenge의 token·quota·20-way claim·결과·만료·attempt provenance·void privacy와 create/claim switch, 신고 제출·triage·scope·audit, Apps in Toss 응답 envelope, Analytics capability, 삭제/redaction race, cleanup, 암호화 알림 preference, outbox worker, 보호된 metrics와 실제 Redis 다중 인스턴스 rate limit을 검증합니다. 예약 작업의 단일 실행·중복 lock·실패 exit와 DB pool 설정도 회귀 검증 대상입니다.

테스트 DB 관리자 URL은 `.env`의 `TEST_DATABASE_ADMIN_URL`로 지정할 수 있습니다. 지정하지 않으면 로컬 Compose의 `postgres` maintenance DB를 사용합니다. 이 계정에는 `CREATE DATABASE` 권한이 필요합니다. Harness는 매 실행마다 `daily_quiz_it_<32자리 hex>` 이름의 DB만 생성하고, 이름을 다시 검증한 뒤 해당 DB만 `DROP DATABASE ... WITH (FORCE)`로 제거합니다. 앱 DB, schema, Docker volume은 삭제하지 않으며 최종 검증에서 잔여 임시 DB가 0개인지 확인했습니다.

`build`는 contracts, API, Web, Admin CMS를 순서대로 빌드하고 `apps/web/daily-quiz-battle-anlee.ait`를 생성합니다. `.ait`, `dist`, local env, DB data, `docs/`는 Git에서 제외됩니다.

2026-09-05 KST working tree 로컬 검증 기록:

- format check, lint, typecheck, contracts/API/Web/Admin build 통과
- 실제 PostgreSQL·Redis 통합 테스트 **87 tests, 87 pass, 0 fail**
- 빈 임시 DB에 `0001`~`0017` migration/seed 적용과 teardown 통과
- contracts/API/Web/Admin production build와 Apps in Toss `.ait` 패키징 통과
- Daily full flow와 `choice_order` 채점, 과거 Challenge 지연 완료 시 streak 비회귀, retired revision의 기존 attempt resume/new start 차단 확인
- Challenge create/claim/result, 20-way claim 1명 수렴, same-set attempt 재사용, win/loss/draw, expiry와 참여자 권한 확인
- report 최소 저장·dedupe·queue/triage, admin scope/lifecycle/daily publish/void/audit, Apps in Toss business envelope, split kill switch, 삭제/redaction, cleanup scheduler ledger, notification preference/outbox/worker 확인
- 390×844 브라우저에서 Challenge 양측 무승부 결과와 raw token 제거를 확인했고, 320×640/200%에서 void 결과 privacy·reflow·focus, CMS memory-only 인증·void/correction focus를 실제 Chromium으로 확인
- Web과 CMS의 WCAG 2 A/AA axe 검사에서 제품 DOM serious/critical 위반 0건 확인(AIT development overlay 제외)
- local Prometheus target `up`, 13개 alert rule과 확장 dashboard 검증, migration 17개 backup/restore rehearsal 약 2초 및 잔여 restore DB 0개 확인
- `corepack pnpm audit` 결과 알려진 취약점 0건. 취약한 transitive `esbuild`는 workspace override로 `0.25.12`에 고정

2026-09-06 KST 승인안 후속 검증:

- 전체 회귀 **97 tests, 97 pass, 0 fail, 0 skip**.
- 신규 자동 별명의 허용 형식, 기존 사용자 재접속·동시 bootstrap 안정성 확인.
- 출시 알림 기본 off, 단독 CLI 조기 종료, enabled template/identity 검증 유지 확인.
- 발송 off에서도 저장 동의는 보존하고 활성화는 거부하며 철회 시 암호문을 제거하는 API 검증.
- 격리 DB에 연결한 실제 Chromium에서 미제공 안내와 disabled 켜기 버튼 확인.
- 320×640 화면·200% 글자 설정에서 가로 overflow 0, 계정 설정 제품 DOM axe A/AA 위반 0.
  삭제 확인 문구에서 발견한 대비 결함은 공통 danger 색상을 어둡게 바꾸고 재검증했다.

`.github/workflows/ci.yml`은 pull request/main 및 수동 실행에서 install, format, lint, typecheck, high-severity dependency audit, PostgreSQL·Redis integration test, build, Docker/Compose·Prometheus·backup script 정적 검사와 별도 gitleaks job을 실행하도록 commit `72dd2da`에 구성됐습니다. 후속 working tree와 같은 SHA의 원격 CI 성공 증거는 아직 없으며, 위 결과는 각 날짜에 수행한 로컬 실행 증거입니다.

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

2026-09-06 앱인토스 콘솔에 `오늘의 상식대결` 게임 앱 초안을 생성했습니다.
기존 `daily-quiz-battle`은 이미 사용 중이어서 `daily-quiz-battle-anlee`로 등록했습니다.
Web bundle과 공유·알림 deep link가 등록된 식별자를 사용합니다. 앱 상세 정보 검토,
게임 등급정보와 출시 승인은 아직 완료되지 않았습니다.

1. production appName, 앱 상세 정보와 알림 template/templateSet code
2. 실제 mTLS 인증서/키로 identity와 notification send 성공 경로 검증
3. production API origin/CORS와 다중 인스턴스 shared rate-limit store
4. 실제 iOS/Android Apps in Toss QR E2E
5. VoiceOver/TalkBack, keyboard-only, 200% 확대 수동 QA
6. 150개+ 검수 콘텐츠와 14+ 적합성 증거
7. production monitoring/alert, backup/restore, 개인정보처리방침·법무·검수

### 승인된 출시 기준과 외부 실행 경계

2026-09-06 권장안 승인 기준입니다. 아래 선택은 실제 인프라 구성이나 법무 승인을 뜻하지 않습니다.

| 항목      | 선택                                       | 구현·외부 게이트                                                                                                       |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 앱 식별자 | `daily-quiz-battle-anlee`                  | 콘솔 앱 초안 생성 확인; 상세 정보·등급정보·출시 검토 필요                                                              |
| 닉네임    | 서버가 비식별 별명 자동 생성               | 신규 사용자에만 적용; 기존 사용자·Challenge snapshot 보존                                                              |
| 알림      | 첫 공개 버전 off                           | `NOTIFICATION_DELIVERY_ENABLED=false`; SDK 동의/신규 enqueue/모든 CLI·scheduler 발송 차단, 기존 동의 철회 허용         |
| Cloud     | AWS Seoul (`ap-northeast-2`) managed stack | PostgreSQL·Redis·Secret Manager·private network, API/scheduler 분리; AWS 계정·예산·도메인·DPA 확인 전 리소스 생성 없음 |
| CMS 인증  | reverse proxy OIDC/SSO + short admin JWT   | IdP issuer/client·운영자 그룹·callback domain 필요; 현재 CLI JWT는 로컬용                                              |
| 복구 목표 | RPO 1시간 / RTO 4시간                      | 운영 목표이며 현재 보장 아님; PITR·격리 복구·page 수신 및 책임자 증거 필요                                             |
| 콘텐츠    | 30일분 150개 + 예비 약 15개                | 출처·권리·검수자·14+ 적합성 확인 필요; 생성 초안을 검수 재고로 계산하지 않음                                           |
| CI        | PR에서 실행                                | 현재 변경은 미커밋; 해당 변경의 커밋·push 후 PR 및 같은 SHA의 CI 성공 확인 필요                                        |

보존기간의 **검토 기준**은 attempts/answers 90일, report detail 30일,
report metadata 180일, published outbox 30일, failed outbox 90일,
admin audit/void reason 180일, deleted-user tombstone 90일,
Challenge detail 30일 redaction/90일 purge입니다.
이는 법무 승인 전 기준안이며 이 선택만으로 실제 삭제 cleanup을 활성화하지 않습니다.
참조 무결성·삭제 계정 재등록 방지·불변 audit/void 정책과의 충돌도 함께 검토해야 합니다.
기존 cleanup 보존 정책은 변경하지 않았습니다.

알림 off 상태에서는 preference의 `enabled`가 저장된 동의,
`deliveryAvailable`이 현재 제공 여부를 나타냅니다. 동의가 남아 있어도 발송하지 않으며
사용자가 철회할 수 있습니다. 재활성화는 승인 template·실제 mTLS·실기기 검증 후
환경변수를 명시적으로 true로 바꾸고 API와 worker를 재시작하는 방식입니다.

## 개발 문서와 Git 정책

상세 문서는 `docs/development/00_개발_허브.md`에서 시작합니다. 요구사항, 아키텍처, 상태 머신, DB, API 보안, UX/접근성, 로컬 환경, QA, 운영, 진행 현황을 파일별로 나눴습니다.

사용자 요청에 따라 `/docs/` 전체는 `.gitignore`로 제외됩니다. 로컬 개발 판단에는 사용하되, 팀 공유가 필요한 계약·출시 증거는 별도 접근 제어 저장소를 정해야 합니다.
