# MVP 런타임 아키텍처 결정

- 상태: accepted
- 날짜: 2026-05-13
- 관련 문서:
  - [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)
  - [`../product-specs/upbit-krw-paper-trading-mvp.md`](../product-specs/upbit-krw-paper-trading-mvp.md)
  - [`../PRD.md`](../PRD.md)
  - [`../FEATURE_REQUIREMENTS.md`](../FEATURE_REQUIREMENTS.md)

## 배경

Seemirai MVP는 `Upbit KRW 현물 + paper trading + 자동 주문 엔진 검증`이다. 목표는 수익률 최적화가 아니라 실거래 전환 전에 주문, 체결, 비용, 리스크, 알림, 감사 로그의 경계를 안전하게 고정하는 것이다.

따라서 MVP 아키텍처는 다음을 우선한다.

- 실거래 주문 API가 호출되지 않는 구조
- 비용 모델과 리스크 게이트의 일관성
- paper trading과 backtest의 core 로직 재사용
- 모든 주문 판단과 상태 전이의 감사 가능성
- 운영 복잡도를 낮춘 단일 배포 단위

## 결정

### AD-001: 프로세스 구조

MVP는 `single-process modular monolith`로 시작한다.

- 하나의 Node.js 프로세스 안에 market data worker, strategy worker, paper execution worker, scheduler, notifier, optional HTTP server를 둔다.
- 내부 모듈은 port/interface 경계로 분리해 추후 프로세스 분리가 가능하게 한다.
- 핵심 port는 `CollectorPort`, `StrategyPort`, `BrokerPort`, `RiskGatePort`, `NotifierPort`, `AuditLogPort`, `MarketDataRepository`, `OrderRepository`다.

### AD-002: 애플리케이션 인터페이스

Headless worker를 기본으로 하고, 최소 Fastify HTTP API를 포함한다.

- 포함 endpoint: `GET /healthz`, `GET /readyz`, `GET /status`, optional `GET /metrics`, `POST /kill-switch`, `POST /pause-strategy`, `POST /resume-strategy`
- 기본 bind는 `127.0.0.1`이다.
- POST endpoint는 local token을 요구한다.
- 웹 대시보드와 Telegram command 수신은 MVP에서 제외한다.
- Telegram은 outbound alert만 허용한다.

### AD-003: Node.js와 패키지 매니저

Node.js 24 LTS와 pnpm을 사용한다.

- `.nvmrc`에 `24`를 기록한다.
- `package.json`에 `engines.node: >=24 <25`, `packageManager: pnpm@10.x`를 둔다.
- `pnpm-lock.yaml`을 커밋한다.
- Volta는 선택사항이다.

### AD-004: TypeScript, 검증, decimal

TypeScript strict, Zod, Decimal 정책을 적용한다.

- `strict`, `noImplicitAny`, `exactOptionalPropertyTypes`를 활성화한다.
- JavaScript 파일은 허용하지 않는다.
- Zod로 config, Upbit API 응답, WebSocket payload, LLM output, HTTP request body를 검증한다.
- 금액, 수량, 가격, 수수료 계산은 Decimal로 처리한다.
- DB는 `numeric`, JSON log와 외부 API boundary는 string을 사용한다.
- `number`는 표시용 percentage와 정밀도가 중요하지 않은 metric gauge에만 허용한다.

### AD-005: DB 접근과 migration

Kysely + node-postgres + raw SQL migration을 사용한다.

- ORM은 사용하지 않는다.
- schema naming은 `snake_case`로 둔다.
- timestamp는 `timestamptz`, 금액은 `numeric`, ID는 `uuid`를 사용한다.
- enum은 `text + check constraint`를 기본으로 한다.
- TimescaleDB hypertable, compression, retention, continuous aggregate는 raw SQL migration에서 관리한다.

초기 migration 후보:

```text
migrations/
  000001_init_extensions.sql
  000002_orders.sql
  000003_market_data_hypertables.sql
  000004_jobs.sql
  000005_audit_events.sql
  000006_order_events.sql
```

### AD-006: 큐와 스케줄러

MVP는 PostgreSQL `jobs` table 기반 DB-backed queue를 사용한다.

- Redis와 BullMQ는 MVP에서 제외한다.
- 모든 job은 `idempotency_key`, `status`, `attempt_count`, `max_attempts`, `last_error`, `run_after`, `locked_at`, `locked_by`를 가진다.
- worker는 `FOR UPDATE SKIP LOCKED` 패턴으로 job을 가져온다.
- scheduler는 앱 내부 scheduler로 시작한다.

### AD-007: Market Data 수집과 저장

WebSocket collector는 앱 내부 worker로 둔다.

저장 정책:

| 데이터 | 정책 | 보관 |
| --- | --- | --- |
| raw payload | stream별 1분 1개 샘플 | 7일 |
| trades | `KRW-BTC`, `KRW-ETH` 전체 저장 | 30일 |
| orderbook metrics | 1초 집계 | 30일 |
| orderbook snapshots | 5초 간격, 15레벨 | 7일 |
| candles | 1m, 5m, 1h | 180일 |

필수 orderbook metric:

- best bid/ask
- spread bps
- bid/ask depth 1, 5, 15
- imbalance 5, 15
- WebSocket lag와 reconnect event

### AD-008: PaperBroker 경계

`ExecutionEngine -> BrokerPort -> PaperBroker` 구조를 사용한다.

```text
Strategy
  -> CostModel
  -> RiskGate
  -> ExecutionEngine
  -> BrokerPort
     -> PaperBroker active in MVP
     -> UpbitLiveBroker disabled/stub only
```

- `Strategy`는 broker 구현체를 몰라야 한다.
- `CostModel`, `RiskGate`, idempotency는 broker 앞단에서 동일하게 적용된다.
- `UpbitLiveBroker`는 MVP에서 호출 불가능해야 한다.
- paper fill model은 orderbook depth, latency, partial fill, post-only simulation, aggressive limit simulation을 반영한다.
- market order simulation은 기본 비활성이다.

### AD-009: Backtest와 runtime 재사용

Backtest는 별도 orchestrator로 두되 core는 runtime과 공유한다.

공유:

- `StrategyCore`
- `CostModel`
- `RiskGate`
- `PositionManager`
- `PaperExecutionSimulator`
- `PnLCalculator`

분리:

- `EventSource`
- `Clock`
- `Persistence`
- runtime worker lifecycle

`MarketEvent` 포맷은 runtime과 backtest에서 동일하게 사용한다.

### AD-010: 설정과 secret

설정은 versioned YAML 또는 TypeScript config로 두고 Zod로 검증한다.

- 환경: `local`, `paper`, `policy-sync`, `pilot`
- `paper`는 API key 없이 실행되어야 한다.
- local secret은 `.env.local`을 사용하고 git에 포함하지 않는다.
- pilot secret은 Docker Compose secrets를 후보로 둔다.
- secret 원문 로그와 raw env dump는 금지한다.

기본값:

```yaml
live_trading_enabled: false
withdrawal_enabled: false
market_order_enabled: false
paper_no_key: true
```

### AD-011: 상태 전이와 장애 정책

주문, strategy, kill switch는 명시적 state machine으로 관리한다.

Order state:

```text
CREATED
VALIDATED
RISK_APPROVED
RISK_REJECTED
SUBMITTED
ACCEPTED
PARTIALLY_FILLED
FILLED
CANCEL_REQUESTED
CANCELED
REJECTED
EXPIRED
FAILED
MANUAL_REVIEW_REQUIRED
```

Kill switch state:

```text
NORMAL
NEW_ORDERS_BLOCKED
STRATEGY_PAUSED
HARD_STOP
MANUAL_REVIEW_REQUIRED
```

장애 정책:

| 장애 | 조치 |
| --- | --- |
| stale market data | 신규 주문 차단 |
| WebSocket disconnected | 복구 전까지 신규 주문 차단 |
| DB write failure | hard stop |
| duplicate idempotency key | hard stop |
| balance/position mismatch | manual review required |
| notification failure | audit 후 계속 |
| hard stop의 pending paper order | pending order 취소 |
| hard stop의 open position | 자동 청산 금지 |

모든 상태 전이는 append-only event log에 남긴다.

### AD-012: Observability와 알림

Pino JSON structured log와 PostgreSQL audit log를 사용한다.

- 주문 판단, risk rejection, cost snapshot, state transition은 DB audit log에 남긴다.
- Prometheus `/metrics`는 optional but recommended로 둔다.
- Grafana는 MVP에서 제외한다.
- Telegram은 outbound alert만 허용한다.
- 알림은 fingerprint와 cooldown으로 중복 억제한다.

알림 cooldown:

| 등급 | cooldown |
| --- | --- |
| P0 | 1분 |
| P1 | 5분 |
| P2 | 1시간 |

### AD-013: 배포와 운영

Ubuntu 24.04 LTS + Docker Compose + same-host DB로 시작한다.

- app과 PostgreSQL/TimescaleDB는 MVP에서 같은 host에 둔다.
- image tag는 `latest`를 사용하지 않고 고정한다.
- restart policy는 `unless-stopped`를 기본으로 한다.
- Ubuntu 26.04 LTS는 26.04.1 이후 또는 pilot 단계에서 재검토한다.

백업:

```yaml
backup:
  method: pg_dump
  schedule: daily
  retention:
    daily: 7
    weekly: 4
    monthly: 3
  include:
    - schema
    - orders
    - order_events
    - fills
    - audit_events
    - risk_events
    - positions
    - configs
  exclude_or_limit:
    - raw_payload_large_tables
```

### AD-014: 테스트 전략

Vitest를 사용한다.

필수 테스트 계층:

- Unit: cost model, decimal calculation, risk gate, state machine, idempotency
- Integration: DB repositories, migration, job queue, audit log append
- Contract fixture: Upbit REST response schema, Upbit WebSocket payload schema
- Runtime simulation: fixture replay, paper fill, kill switch, stale data
- Soak: 24시간 paper trading

MVP 완료 조건:

- 24시간 paper trading 중 crash 없음
- live order API 호출 0회
- audit event 누락 0건
- stale data 상황에서 신규 주문 차단 확인
- kill switch 작동 확인
- DB backup/restore smoke test 통과

### AD-015: 프로젝트 구조

MVP는 단일 package로 시작한다.

```text
seemirai/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
  config/
    default.yaml
    paper.yaml
  migrations/
    000001_init.sql
    000002_orders.sql
    000003_market_data.sql
    000004_jobs.sql
    000005_audit.sql
  src/
    domain/
      market/
      orders/
      risk/
      cost/
      strategy/
      portfolio/
    application/
      ports/
      paper-trading/
      backtest/
      policy-sync/
      schedulers/
      state-machines/
    infrastructure/
      upbit/
      postgres/
      timescale/
      telegram/
      config/
      logging/
    interfaces/
      cli/
      http/
    runtime/
      app.ts
      workers/
    shared/
      decimal/
      time/
      ids/
      errors/
      result/
      schema/
  tests/
    unit/
    integration/
    fixtures/
    soak/
```

CLI 후보:

```text
pnpm seemirai paper:start
pnpm seemirai backtest:run
pnpm seemirai db:migrate
pnpm seemirai status
pnpm seemirai kill-switch
```

### AD-016: 확장성 경계

MVP는 동적 plugin loading을 도입하지 않는다. 대신 TypeScript interface, 정적 registry, config 기반 활성화로 거래소, 전략, 매수/매도 rule을 확장한다.

거래소 책임은 세 port로 나눈다.

```text
MarketDataPort
ExchangePolicyPort
BrokerPort
```

전략은 주문을 직접 제출하지 않고 `StrategyDecision` 또는 `OrderIntent` 후보만 만든다. 모든 후보는 항상 `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort` 순서를 통과한다.

매수/매도 기준은 `Rule` 조합으로 구성한다.

```text
Rule
  - name
  - evaluate(context): PASS | FAIL | WARN
  - reason
```

초기 registry:

```text
exchangeRegistry
  - upbit_krw_spot

strategyRegistry
  - trend_following
  - mean_reversion

ruleRegistry
  - universe_allowed
  - market_warning_absent
  - spread_ok
  - depth_sufficient
  - cost_margin_ok
  - risk_ok
  - stop_loss
  - take_profit
```

금지 의존성:

- `Strategy -> UpbitClient` 직접 호출
- `Strategy -> Broker` 직접 호출
- `RiskGate -> Upbit 전용 payload` 직접 의존
- `CostModel -> 특정 전략` 직접 의존
- `PaperBroker -> Strategy` 직접 의존

## 대안

- 다중 프로세스 또는 마이크로서비스: 장애 격리는 좋지만 MVP에서 큐, IPC, 배포 복잡도가 커진다.
- Redis/BullMQ: 고성능 queue에는 좋지만 MVP에서는 추가 장애 지점이다.
- Prisma: 일반 CRUD 생산성은 좋지만 TimescaleDB 기능과 raw SQL migration 중심 운영에 덜 맞다.
- 웹 대시보드: 운영 가시성에는 도움이 되지만 MVP의 주문/리스크 경계 검증에 직접 필요하지 않다.
- 동적 plugin loading: 확장성은 좋지만 MVP에서는 보안, 버전 호환성, 로딩 실패 처리 부담이 크다.
- Ubuntu 26.04 LTS: 최신 LTS지만 2026-05-13 기준 출시 직후라 MVP 운영 기준으로는 24.04 LTS를 우선한다.

## 영향

- `ARCHITECTURE.md`의 MVP 기술 방향은 Node.js 24 LTS, TypeScript, Kysely, PostgreSQL/TimescaleDB, DB-backed queue, Fastify minimal API 기준으로 갱신한다.
- Redis는 MVP 필수 구성에서 제외한다.
- 실거래 broker는 disabled/stub으로만 허용한다.
- 향후 구현 issue는 AD-001~AD-015를 기준으로 파일 경계와 acceptance criteria를 잡는다.
- 문서 변경 후 `./scripts/verify docs`를 실행한다.

## 구현 이정표

1. 프로젝트 런타임 기반
   - Node.js 24, pnpm, TypeScript strict, Vitest, config validation
2. DB 기반
   - PostgreSQL/TimescaleDB compose, raw SQL migration, Kysely, audit/jobs schema
3. Market data runtime
   - Upbit WebSocket worker, schema validation, TimescaleDB 저장, lag/reconnect 기록
4. Core engine
   - StrategyCore, Rule engine, CostModel, RiskGate, PositionManager, PnLCalculator
5. Paper execution
   - ExecutionEngine, BrokerPort, PaperBroker, state machine, idempotency
6. Backtest bridge
   - HistoricalEventSource, shared MarketEvent, paper execution simulator 재사용
7. 운영 가드레일
   - Fastify health/status/kill-switch, Pino log, DB audit, Telegram outbound alert
8. 검증
   - fixture/mock 테스트, live API block test, DB migration test, 24h paper soak test

## 참고 출처

- Node.js: [Node.js Releases](https://nodejs.org/en/about/previous-releases), [Release schedule](https://github.com/nodejs/Release)
- Ubuntu: [Ubuntu 24.04 LTS release notes](https://documentation.ubuntu.com/release-notes/24.04/)
- Docker: [Compose](https://docs.docker.com/compose/), [secrets](https://docs.docker.com/reference/compose-file/secrets/), [restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- TypeScript: [strict option](https://www.typescriptlang.org/tsconfig/strict.html)
- Fastify: [Fastify](https://fastify.dev/)
- Kysely: [Kysely](https://www.kysely.dev/)
- Zod: [Zod](https://zod.dev/)
- Pino: [Pino](https://github.com/pinojs/pino)
- Vitest: [Vitest](https://vitest.dev/)
