# Seemirai

Seemirai는 Upbit KRW 현물 시장에서 전략 신호를 바로 주문으로 연결하지 않고, 수수료, 스프레드, 슬리피지, 유동성, 포지션 한도, 손실 한도, 운영 readiness를 먼저 차감하고 차단한 뒤에도 기대값이 남는 후보만 실행 경계로 넘기는 비용 우선 자동매매 시스템이다.

이 저장소의 기본값은 API key가 없어도 동작해야 하는 `PAPER_TRADING` profile이다. production
`LIVE_AUTONOMOUS_SMALL_BUDGET` daemon은 2026-06-24부터 16일 이상 연속 실행됐고 Issue #188 구현 기준선을 포함한다. 다만 M23
actual manifest에 필요한 daily report, 일별 decision, restart, backup/restore artifact가 남아 있지 않아 M24 전략, universe,
예산 확대는 계속 별도 승인 범위로 둔다. 실거래 API 호출은 저장소 밖 secret, readiness guard, 소액 예산 설정을 운영자가 명시적으로
arm 한 경우에만 열린다.

## 핵심 원칙

- 기본 `config/paper.json`은 `paper_no_key=true`, `live_trading_enabled=false`를 유지한다.
- 실거래, 출금, 입출금 자동화, 거래소 간 차익거래, 선물, 레버리지, 신규 진입 시장가 주문은 기본 profile에서 모두 닫혀 있다.
- 전략은 주문을 직접 제출하지 않고 `StrategyDecision` 또는 `OrderIntent` 후보만 만든다.
- 모든 후보는 비용 모델, rule, risk gate, budget/exposure guard, idempotency guard를 통과해야 한다.
- LLM은 공지, 리스크 분류, 리포트 초안 같은 보조 경계에만 쓰며 직접 매수/매도 판단을 만들 수 없다.
- 사용자-facing 상태와 알림은 한국어 행동 언어를 먼저 보여주고, 내부 id와 reason code는 `추적 정보`로 분리한다.

## 현재 범위

| 구분 | 현재 기준 |
| --- | --- |
| 거래소 | Upbit |
| 시장 | KRW 현물 |
| 기본 모드 | `PAPER_TRADING` |
| 기본 universe | `KRW-BTC`, `KRW-ETH` |
| 기본 broker | `PaperBroker` |
| 실거래 canary | M23 `LIVE_AUTONOMOUS_SMALL_BUDGET`, 기본 `KRW-BTC` |
| 실거래 예산 | 1회 `10000` KRW, 일일 자동 notional `30000` KRW, open position `30000` KRW |
| 실거래 중지 ceiling | 누적 realized loss + 미체결 노출 합계가 `50000` KRW에 도달하기 전 operator stop 또는 kill switch/manual review |

## 작동 원리

런타임은 단일 Node.js 프로세스 안에서 config와 registry로 필요한 worker, adapter, repository를 조립한다.

```text
config/paper.json
  -> runtime config 검증
  -> exchange, strategy, rule registry 활성화
  -> Upbit public market data와 policy snapshot 수집
  -> 원천/정규화 market event 저장
  -> feature 계산
  -> strategy decision 또는 order intent 생성
  -> 비용 차감과 rule 평가
  -> risk gate, kill switch, readiness, budget/exposure guard 평가
  -> ExecutionEngine이 BrokerPort 호출
  -> PaperBroker 또는 guard로 열린 Upbit live broker 실행
  -> 주문/체결/취소 상태, audit/risk evidence, decision ledger 저장
  -> Telegram alert, `/status`, daily report, closeout artifact 생성
```

중요한 불변식은 “전략보다 리스크와 운영 guard가 우선한다”는 점이다. market data stale, Upbit 장애, 금지 권한, DB write 실패, audit persistence 실패, reconcile mismatch, duplicate idempotency key 같은 조건은 신규 주문 차단, manual review, hard stop 중 하나로 수렴해야 한다.

## 코드 구조

```text
src/
  domain/          외부 시스템을 모르는 도메인 타입, 비용, 주문, 상태 기계
  application/     전략, 리스크, 실행, 알림, 보고서 유스케이스와 port
  infrastructure/  PostgreSQL, Upbit, Telegram, PaperBroker 구현체
  interfaces/      HTTP control API 같은 외부 진입점
  runtime/         config, registry, worker 조립과 startup guard
  shared/          Decimal, logger 같은 공통 기반
```

주요 문서는 [ARCHITECTURE.md](./ARCHITECTURE.md), [docs/ONBOARDING.md](./docs/ONBOARDING.md), [docs/RUNTIME_CONFIG.md](./docs/RUNTIME_CONFIG.md), [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)를 먼저 본다.

## 로컬 개발

필수 런타임은 Node.js 24 LTS와 pnpm 10이다.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```

로컬 PostgreSQL + TimescaleDB는 Docker Compose로 띄운다.

```sh
docker compose up -d postgres
```

로컬 DB 기본 설정은 [config/local-db.json](./config/local-db.json)에 있고 기본 host port는 `127.0.0.1:55432`다. Docker Compose는 `.env` 파일을 읽지만 Node 앱은 `.env` 파일을 자동으로 로드하지 않는다. 앱, 테스트, runner에 필요한 값은 shell, process manager, CI env로 주입한다.

DB migration integration test는 기본 test run에서 skip된다. 로컬 DB가 준비됐을 때만 명시적으로 실행한다.

```sh
SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration
```

## 실행 표면

이 저장소에는 현재 범용 `start` script가 없다. 로컬 개발은 타입 검사, 테스트, 검증 script 중심이고, 운영 검증은 목적별 runner를 직접 실행한다.

| 목적 | 명령 |
| --- | --- |
| 문서, hook, GitHub, 프로젝트 전체 검증 | `./scripts/verify` |
| 문서 구조 검증 | `./scripts/verify docs` |
| deterministic M9 paper decision smoke | `node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke --json` |
| deterministic M9 paper trading soak smoke | `node scripts/run-m9-paper-trading-soak.mjs --fixture-smoke --json` |
| deterministic 24h soak guard smoke | `node scripts/soak-paper-24h.mjs --fixture-smoke --json` |
| M22 운영 파일 scaffold | `node scripts/prepare-m22-live-autonomous-local-files.mjs` |
| M22/M23 live autonomous runner fixture smoke | `node scripts/run-m22-live-autonomous-pilot.mjs --fixture-smoke --json` |
| M23 restart/recovery drill fixture smoke | `node scripts/run-m23-recovery-drill.mjs --fixture-smoke --json` |

실제 24시간 이상 public WebSocket soak, private API smoke, live broker smoke, M22/M23 live autonomous run은 아래 환경변수 guard가 명시적으로 열려야 한다. guard 없이 실행하면 skip artifact를 남기거나 fail-closed 한다.

## 환경변수

`.env.example`은 로컬 개발용 예시다. 실제 secret 값을 저장소에 커밋하지 않는다. 특히 DB URL, Telegram token, Upbit access/secret key, local control token은 문서, PR, artifact, 로그에 원문으로 남기지 않는다.

### 로컬과 상시 설정

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_ENV` | 알림과 운영 summary의 환경명. 없으면 일부 경계에서 `NODE_ENV`, 그다음 `local`을 쓴다. |
| `SEEMIRAI_DATABASE_URL` | PostgreSQL 전체 URL. 설정되면 컴포넌트형 DB env보다 우선한다. |
| `DATABASE_URL` | DB URL legacy/fallback 입력. `SEEMIRAI_DATABASE_URL`이 우선한다. |
| `SEEMIRAI_POSTGRES_HOST` | 컴포넌트형 DB host override. URL 문법과 port 포함은 거부한다. |
| `SEEMIRAI_POSTGRES_PORT` | 컴포넌트형 DB port override. 기본 Compose port는 `55432`다. |
| `SEEMIRAI_POSTGRES_USER` | 컴포넌트형 DB user override. |
| `SEEMIRAI_POSTGRES_PASSWORD` | 컴포넌트형 DB password override. |
| `SEEMIRAI_POSTGRES_DB` | 컴포넌트형 DB database override. |
| `SEEMIRAI_LOCAL_CONTROL_TOKEN` | local HTTP control drill 또는 kill-switch control 인증 token. |
| `SEEMIRAI_TELEGRAM_BOT_TOKEN` | Telegram outbound/inbound bot token. |
| `TELEGRAM_BOT_TOKEN` | Telegram token legacy fallback. |
| `SEEMIRAI_TELEGRAM_CHAT_ID` | Telegram outbound 기본 chat id. |
| `TELEGRAM_CHAT_ID` | Telegram chat id legacy fallback. |

### Telegram inbound polling

기본 `config/paper.json`에서는 Telegram inbound가 꺼져 있다. `SEEMIRAI_TELEGRAM_INBOUND_ENABLED=1` 또는 config enable이 있어야 polling을 시작하며, bot token과 owner chat allowlist가 없으면 startup에서 닫힌다.

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_TELEGRAM_INBOUND_ENABLED` | `1`, `true`, `yes`, `on`이면 inbound polling 활성화. |
| `SEEMIRAI_TELEGRAM_INBOUND_BOT_USERNAME` | 그룹 command mention 검증용 bot username. |
| `SEEMIRAI_TELEGRAM_INBOUND_OWNER_CHAT_IDS` | command 허용 owner chat id CSV. 활성화 시 필수다. |
| `SEEMIRAI_TELEGRAM_INBOUND_OWNER_USER_IDS` | 선택 owner user id CSV. |
| `SEEMIRAI_TELEGRAM_INBOUND_POLLING_INTERVAL_MS` | polling 간격. |
| `SEEMIRAI_TELEGRAM_INBOUND_POLLING_TIMEOUT_SECONDS` | Telegram long polling timeout. 최대 50초로 제한된다. |
| `SEEMIRAI_TELEGRAM_INBOUND_MAX_UPDATES_PER_POLL` | poll batch 상한. 최대 100으로 제한된다. |

### 검증과 smoke guard

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_RUN_DB_INTEGRATION` | `1`일 때 PostgreSQL integration test를 실제 DB에 대해 실행한다. |
| `SEEMIRAI_RESTORE_DATABASE_URL` | DB backup/restore smoke의 disposable restore DB URL. |
| `SEEMIRAI_BACKUP_FILE` | DB backup/restore smoke dump 파일 경로. 없으면 `.local/backups/` 아래에 생성한다. |
| `SEEMIRAI_RUN_SOAK` | `1`일 때 실제 24시간 public WebSocket soak 경로를 연다. |
| `SEEMIRAI_SOAK_LOG_DIR` | 24시간 soak artifact 디렉터리. |
| `SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK` | `1`일 때 실제 M9 multi-day paper trading soak를 연다. |
| `SEEMIRAI_M9_ARTIFACT_DIR` | M9 paper artifact 디렉터리. |
| `SEEMIRAI_RUN_M23_RECOVERY_DRILL` | `1`일 때 M23 recovery drill validator를 실제 artifact 기준으로 실행한다. |
| `SEEMIRAI_M23_RECOVERY_ARTIFACT_DIR` | M23 recovery drill artifact 디렉터리. |
| `SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT` | `1`일 때 M23 7일 closeout manifest 검증을 실행한다. |
| `SEEMIRAI_M23_STABILITY_ARTIFACT_DIR` | M23 closeout artifact 디렉터리. |

### Upbit private API와 live smoke guard

Upbit private API 경계는 env가 하나라도 일부만 들어오면 암묵적으로 열리지 않고 fail-closed 한다.

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_PILOT_PROFILE` | `PILOT_READ_ONLY`, `PILOT_POLICY_SYNC`, `PILOT_ORDER_SMOKE` 중 하나. |
| `SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE` | `1`일 때 private read/policy/order smoke의 기본 private API guard를 연다. |
| `SEEMIRAI_UPBIT_ACCESS_KEY` | Upbit access key. 로그와 status에 원문 노출 금지. |
| `SEEMIRAI_UPBIT_SECRET_KEY` | Upbit secret key. 로그와 status에 원문 노출 금지. |
| `SEEMIRAI_UPBIT_KEY_SCOPE` | 허용 scope는 `자산조회`, `주문조회`, `주문하기`뿐이다. 출금, 입출금, 선물, 레버리지, 마진 scope는 차단된다. |
| `SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID` | 저장소 밖 redacted 권한 확인 evidence id. |
| `SEEMIRAI_UPBIT_POLICY_SYNC_MARKET` | policy sync 대상 KRW market. |
| `SEEMIRAI_UPBIT_LOOKUP_ORDER_UUID` | `PILOT_READ_ONLY`에서만 허용되는 기존 주문 조회 uuid. |
| `SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER` | `PILOT_READ_ONLY`에서만 허용되는 기존 주문 조회 identifier. 최대 32자. |
| `SEEMIRAI_RUN_UPBIT_ORDER_SMOKE` | `1`일 때 `PILOT_ORDER_SMOKE` 주문 생성/취소 smoke guard를 연다. |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET` | order smoke 대상 KRW market. |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW` | order smoke 총액 상한. `5000`~`50000` KRW. |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE` | 실제 order smoke 지정가. |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME` | 실제 order smoke 수량. |
| `SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER` | 실제 order smoke identifier. 32자 이하 고유값. |
| `SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR` | Upbit smoke artifact 디렉터리. 기본값은 `test-results/upbit-smoke`. |
| `SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE` | `1`일 때 live broker smoke guard를 추가로 연다. |
| `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE` | `1`일 때 read-only live reconcile worker/smoke guard를 연다. |
| `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE` | `1`일 때 live private WebSocket reconcile smoke guard를 연다. |
| `SEEMIRAI_UPBIT_API_BASE_URL` | M22 daemon의 Upbit API base URL override. 기본값은 `https://api.upbit.com`. |

### M19 exit pilot guard

M19는 live exit 검증을 위한 추가 guard다. 기본 off이며, 신규 buy smoke는 별도 승인 evidence가 없으면 일반 order smoke로 낮춰 실행하지 않는다.

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_RUN_M19_EXIT_PILOT` | `1`일 때 M19 exit pilot guard 활성화. |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE` | `EXISTING_SMALL_POSITION` 또는 `PAPER_FIXTURE`. |
| `SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID` | 기존 소액 포지션을 쓰는 경우 필요한 M16 reconcile 또는 운영자 position evidence id. |
| `SEEMIRAI_M19_EXIT_PILOT_MAX_KRW` | M19 소액 한도. `5000`~`50000` KRW. |
| `SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID` | 저장소 밖 redacted 운영자 확인 evidence id. |
| `SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE` | `1`일 때 신규 진입 guarded buy smoke guard 활성화. |
| `SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID` | guarded buy smoke 실행에 필요한 운영자 승인 evidence id. |

### M22/M23 live autonomous 운영

M22/M23 운영 env와 key 파일은 저장소 밖 디렉터리에 둔다. 기본 준비 위치는 `~/vaults/99_운영/seemirai-m22-live-autonomous`이며, `scripts/prepare-m22-live-autonomous-local-files.mjs`가 `m22.env`, `m22.keys.env`, `m22-live-autonomous.config.json`, evidence template, candidate JSONL, wrapper script를 만든다.

| 환경변수 | 용도 |
| --- | --- |
| `SEEMIRAI_M22_HOME` | 저장소 밖 M22/M23 운영 home. |
| `SEEMIRAI_M22_ARTIFACT_DIR` | M22/M23 runner artifact 디렉터리. |
| `SEEMIRAI_M22_EVIDENCE_DIR` | 저장소 밖 redacted evidence 디렉터리. |
| `SEEMIRAI_M22_PILOT_DURATION_MS` | pilot wrapper 실행 시간. 기본 24시간. |
| `SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT` | `1`일 때 live autonomous wrapper 실행 허가. |
| `SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON` | `1`일 때 daemon의 live autonomous preflight 허가. |
| `SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID` | 운영자 arm evidence id. |
| `SEEMIRAI_M22_BUDGET_EVIDENCE_ID` | 예산과 손실 ceiling evidence id. |
| `SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID` | M21 1주 gate evidence id. |
| `SEEMIRAI_M22_TELEGRAM_INBOUND_READY` | M20 inbound readiness. `1`이어야 한다. |
| `SEEMIRAI_M22_RECONCILE_FRESH` | M16 reconcile freshness. `1`이어야 한다. |
| `SEEMIRAI_M22_PNL_STATUS_READY` | M17 PnL/status readiness. `1`이어야 한다. |
| `SEEMIRAI_M22_DECISION_LEDGER_READY` | M18 decision ledger readiness. `1`이어야 한다. |
| `SEEMIRAI_M22_EXIT_ENGINE_READY` | M19 exit engine readiness. `1`이어야 한다. |
| `SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW` | segment 시작 시점의 일일 자동 주문 사용액 safe summary. |
| `SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW` | segment 시작 시점의 open position notional safe summary. |
| `SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW` | segment 시작 시점의 일간 realized loss safe summary. |
| `SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW` | segment 시작 시점의 주간 realized loss safe summary. |
| `SEEMIRAI_M22_PILOT_EVENT_LOG` | runner가 daemon에 주입하는 JSONL event evidence path. |
| `SEEMIRAI_M22_PILOT_RUN_ID` | runner run id override 또는 추적값. |
| `SEEMIRAI_M23_SYSTEMD_SEGMENT` | systemd segment 실행 표식. |
| `SEEMIRAI_M23_SEGMENT_ENV` | systemd wrapper가 source할 segment env 파일 경로. |
| `SEEMIRAI_M23_SEGMENT_CANDIDATE_FILE` | M23 24시간 segment candidate JSONL path. |
| `SEEMIRAI_M23_SEGMENT_CANDIDATE_START` | candidate tail 시작점. `end` 또는 `beginning`. |

실제 M23 7일 운영 절차는 [docs/runbooks/m23-live-small-budget-operations.md](./docs/runbooks/m23-live-small-budget-operations.md)와 [deploy/systemd/seemirai-m23-live-small-budget.service.example](./deploy/systemd/seemirai-m23-live-small-budget.service.example)를 따른다.

## 안전한 기본 설정

[config/paper.json](./config/paper.json)은 다음 안전 invariant를 유지해야 한다.

```json
{
  "mode": "PAPER_TRADING",
  "live_trading_enabled": false,
  "withdrawal_enabled": false,
  "cross_exchange_arbitrage_enabled": false,
  "futures_enabled": false,
  "leverage_enabled": false,
  "market_order_enabled": false,
  "entry_market_order_enabled": false,
  "paper_no_key": true
}
```

이 값이 깨지면 기본 runtime config 로딩은 실패해야 한다. live 운영용 config는 저장소 밖에서 별도로 만들며, 기본 paper profile을 실거래 profile로 바꾸지 않는다.

## 문서

- [아키텍처](./ARCHITECTURE.md)
- [온보딩과 프로그램 흐름](./docs/ONBOARDING.md)
- [PRD](./docs/PRD.md)
- [기능 요구사항](./docs/FEATURE_REQUIREMENTS.md)
- [런타임 설정 기준](./docs/RUNTIME_CONFIG.md)
- [개발 환경](./docs/DEVELOPMENT.md)
- [신뢰성과 복구 기준](./docs/RELIABILITY.md)
- [보안 기준](./docs/SECURITY.md)
- [M23 live small-budget 7일 운영 runbook](./docs/runbooks/m23-live-small-budget-operations.md)
- [Issue #188 M23 구현 closeout과 24/7 운영 회고 감사](./docs/exec-plans/completed/2026-07-10-issue-188-m23-live-ops-retrospective-closeout.md)
- [문서 시스템](./docs/README.md)

## 참고 출처

- Kraken: [What makes crypto 24/7/365?](https://www.kraken.com/learn/what-makes-crypto-24-7-365)
- Upbit: [거래 데이터 기준 시간](https://support.upbit.com/hc/ko/articles/900006049666-%EA%B1%B0%EB%9E%98-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EA%B8%B0%EC%A4%80-%EC%8B%9C%EA%B0%84%EC%9D%80-%EC%96%B8%EC%A0%9C%EC%9D%B8%EA%B0%80%EC%9A%94), [거래 수수료](https://support.upbit.com/hc/ko/articles/900006143046-%EA%B1%B0%EB%9E%98-%EC%88%98%EC%88%98%EB%A3%8C%EB%8A%94-%EC%96%BC%EB%A7%88%EC%9D%B8%EA%B0%80%EC%9A%94), [요청 수 제한](https://docs.upbit.com/kr/reference/rate-limits)
