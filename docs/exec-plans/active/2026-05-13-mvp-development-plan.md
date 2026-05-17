# Seemirai MVP 개발 실행 계획

- 상태: active
- 작성일: 2026-05-13
- 목표: Upbit KRW 현물 paper trading 기반의 자동 주문 엔진 검증 MVP를 구현한다.

## 기준 문서

- [`../../../ARCHITECTURE.md`](../../../ARCHITECTURE.md)
- [`../../design-docs/2026-05-13-mvp-runtime-architecture.md`](../../design-docs/2026-05-13-mvp-runtime-architecture.md)
- [`../../product-specs/upbit-krw-paper-trading-mvp.md`](../../product-specs/upbit-krw-paper-trading-mvp.md)
- [`../../PRD.md`](../../PRD.md)
- [`../../FEATURE_REQUIREMENTS.md`](../../FEATURE_REQUIREMENTS.md)

## 목표

MVP는 수익률 최적화 봇이 아니라 실거래 전환 가능한 주문·체결·비용·리스크 검증 런타임이다.

완료 시점에는 다음을 만족해야 한다.

- Upbit `KRW-BTC`, `KRW-ETH` 실시간 market data 수집
- 비용 기반 동적 안전마진 적용
- 리스크 게이트 기반 신규 주문 차단
- PaperBroker 기반 가상 주문, 부분체결, 취소, 재호가
- 주문 판단 근거와 상태 전이 audit log
- Telegram outbound P0 알림
- live order API 호출 0회 보장
- 24시간 paper trading soak test 통과

## 확장성 원칙

MVP부터 다음 경계를 고정한다.

- 거래소는 `MarketDataPort`, `ExchangePolicyPort`, `BrokerPort`로 나눈다.
- 전략은 주문을 직접 제출하지 않고 `StrategyDecision` 또는 `OrderIntent` 후보만 만든다.
- 매수/매도 기준은 `Rule` 조합으로 구성한다.
- 모든 주문 후보는 `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort` 순서를 통과한다.
- `PaperBroker`와 future live broker는 같은 `BrokerPort`를 구현한다.
- 동적 plugin loading은 MVP에서 제외하고, 정적 registry와 config 기반 활성화를 사용한다.

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

## 범위

포함:

- Node.js 24 LTS, pnpm, TypeScript strict 기반 단일 package
- Fastify 최소 HTTP API
- PostgreSQL + TimescaleDB Docker Compose
- Kysely + raw SQL migration
- DB-backed `jobs` queue
- Upbit public market data adapter
- policy snapshot
- universe manager
- feature/orderbook metric 저장
- cost model
- rule engine
- strategy registry
- risk gate
- state machine
- PaperBroker
- backtest bridge
- Pino JSON log
- PostgreSQL audit log
- Telegram outbound alert
- Vitest unit/integration/fixture/soak 테스트

제외:

- 실거래 주문 API 호출
- 출금/송금/거래소 간 차익거래
- Redis/BullMQ
- 웹 대시보드
- Telegram command 수신
- 동적 plugin loading
- 선물/레버리지
- 외부 뉴스/SNS 기반 자동 주문

## 작업 단계

### M0. 프로젝트 스캐폴딩

- [x] `package.json`, `.nvmrc`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts` 생성
- [x] TypeScript strict, `allowJs=false` 설정
- [x] 기본 폴더 구조 생성: `domain`, `application`, `infrastructure`, `interfaces`, `runtime`, `shared`
- [x] config validation, Decimal, Pino logger 기반 생성
- [x] live trading 기본 비활성 guard 추가

검증:

- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] 기본 config 로딩 실패/성공 테스트

### M1. DB와 migration 기반

- [x] Docker Compose로 PostgreSQL + TimescaleDB 구성
- [x] raw SQL migration runner 생성
- [x] Kysely + node-postgres 연결
- [x] `orders`, `paper_orders`, `fills`, `positions`, `audit_events`, `risk_events`, `jobs`, `policy_snapshots` schema 작성
- [x] `trades`, `orderbook_metrics`, `orderbook_snapshots`, `candles`, `pnl_snapshots`, `strategy_signals` hypertable 작성

검증:

- [x] migration integration test
- [x] backup/restore smoke test 초안
- [x] `jobs` idempotency key 중복 차단 테스트

### M2. Port와 registry 기반 확장성 골격

- [x] `MarketDataPort`, `ExchangePolicyPort`, `BrokerPort`, `NotifierPort`, `AuditLogPort` 정의
- [x] `Strategy` interface 정의
- [x] `Rule` interface 정의
- [x] `exchangeRegistry`, `strategyRegistry`, `ruleRegistry` 구현
- [x] registry 활성화 config schema 작성
- [x] 의존성 방향 테스트 또는 lint 규칙 후보 작성

검증:

- [x] strategy가 broker 구현체를 직접 import하지 않는지 확인
- [x] rule 조합 config가 잘못된 rule id를 거부하는지 테스트
- [x] registry에서 비활성 전략이 실행되지 않는지 테스트

### M3. Upbit market data와 policy snapshot

- [ ] Upbit public REST market list client
- [ ] Upbit WebSocket trades/orderbook client
- [ ] Upbit payload Zod schema
- [ ] `market_event.warning`, `market_event.caution` 저장과 universe 차단
- [ ] rate limit 상태 모델
- [ ] raw payload sampling, trades 저장, orderbook metric 1초 집계, snapshot 5초 저장

검증:

- [ ] Upbit REST fixture contract test
- [ ] Upbit WebSocket fixture replay test
- [ ] stale data와 reconnect event 기록 테스트

### M4. Cost, rule, strategy core

- [ ] Decimal 기반 비용 계산
- [ ] `cost_bps + safety_buffer_bps` 판정
- [ ] 기본 buy/sell rule 구현
- [ ] `trend_following` strategy skeleton
- [ ] `mean_reversion` strategy skeleton
- [ ] `StrategyDecision -> OrderIntent` 변환
- [ ] 폐기 사유 audit log 연결

검증:

- [ ] 비용 항목 증가 시 거래 가능성이 높아지지 않는 속성 테스트
- [ ] 저유동성/주의/유의 종목 rule 차단 테스트
- [ ] 전략이 직접 주문을 제출하지 않는 테스트

### M5. RiskGate와 상태 전이

- [ ] 주문 state machine 구현
- [ ] kill switch state machine 구현
- [ ] 일간/주간/MDD/1회 주문/1회 손실/연속 손실 한도 구현
- [ ] stale market data, DB write failure, duplicate idempotency key 장애 정책 구현
- [ ] append-only `order_events`와 `audit_events` 저장

검증:

- [ ] 각 risk limit 차단 테스트
- [ ] hard stop 시 pending paper order 취소 테스트
- [ ] open position 자동 청산 금지 테스트

### M6. ExecutionEngine과 PaperBroker

- [ ] `ExecutionEngine -> BrokerPort -> PaperBroker` 구현
- [ ] idempotency key 필수화
- [ ] depth 기반 paper fill
- [ ] latency, partial fill, post-only simulation
- [ ] aggressive limit simulation
- [ ] market order simulation 기본 비활성
- [ ] live broker disabled/stub 구현

검증:

- [ ] PaperBroker 부분체결 테스트
- [ ] 중복 주문 차단 테스트
- [ ] live order API 호출 0회 테스트
- [ ] market order 생성 불가 테스트

### M7. Backtest bridge

- [ ] `MarketEvent` 공통 포맷 정의
- [ ] `HistoricalEventSource`
- [ ] runtime core 재사용 backtest orchestrator
- [ ] paper trading 결과와 backtest 결과 비교 리포트

검증:

- [ ] 동일 fixture에서 runtime core와 backtest core 판정 일치 테스트
- [ ] 비용 0/비용 반영 결과 차이 리포트 테스트

### M8. 운영 가드레일과 soak test

- [ ] Fastify `/healthz`, `/readyz`, `/status`, optional `/metrics`
- [ ] local token 기반 kill switch endpoint
- [ ] Telegram outbound notifier
- [ ] alert fingerprint + cooldown
- [ ] 일간 리포트
- [ ] 24시간 paper trading soak test script

검증:

- [ ] P0 알림 시 신규 주문 차단 테스트
- [ ] Telegram command 수신 경로 없음 확인
- [ ] 24시간 paper soak test: crash 없음, live order API 0회, audit 누락 0건

## 결정 로그

- 2026-05-13: 확장성은 동적 plugin loading이 아니라 정적 registry + config 기반 활성화로 처리한다.
- 2026-05-13: 거래소 확장은 `MarketDataPort`, `ExchangePolicyPort`, `BrokerPort`로 책임을 나눈다.
- 2026-05-13: 전략은 주문을 직접 내지 않고 `StrategyDecision` 또는 `OrderIntent` 후보만 만든다.
- 2026-05-13: 매수/매도 기준은 `Rule` 조합으로 구성한다.
- 2026-05-13: `CostModel`과 `RiskGate`는 모든 전략 공통 gate로 고정한다.
- 2026-05-13: issue #1은 M0 foundation 범위로 `single PR mode`에서 진행한다. `package.json`, lockfile, TypeScript/Vitest 설정, config guard, verification harness가 서로 얽혀 있어 sub PR 분할보다 단일 PR 리뷰가 충돌 위험이 낮다.
- 2026-05-15: issue #3은 M1 DB foundation 범위가 dependency/lockfile, Docker Compose, Kysely connection, migration/schema, integration 검증을 함께 포함하므로 `sub PR mode`에서 순차 진행한다. 공통 lockfile과 migration 순서 충돌을 피하기 위해 병렬 sub PR은 만들지 않는다.
- 2026-05-15: issue #3 Sub PR 2는 raw SQL migration runner, `schema_migrations`, 초기 일반 테이블, TimescaleDB hypertable migration, DB integration test harness 범위로 진행한다. Docker가 없는 환경에서는 DB integration test를 기본 skip하고 `SEEMIRAI_RUN_DB_INTEGRATION=1`일 때 실제 DB에 적용한다.
- 2026-05-16: issue #3 Sub PR 3은 `jobs` queue repository, idempotency duplicate guard 검증, `FOR UPDATE SKIP LOCKED` claim integration test, backup/restore smoke script 초안으로 M1 DB foundation 잔여 검증을 닫는다.
- 2026-05-16: issue #8은 M2 port/interface와 registry activation config가 서로 강하게 연결된 type boundary 작업이므로 `single PR mode`에서 진행한다. sub PR로 나누면 registry id, contract type, config schema가 순차 충돌할 가능성이 커 리뷰 이점보다 재작업 비용이 크다.
- 2026-05-17: issue #10은 M3 Upbit market data와 policy snapshot 범위가 REST policy, WebSocket 수집, fixture replay, DB persistence, runtime 검증을 함께 포함하므로 `sub PR mode`에서 진행한다. `issue-10/01-upbit-contracts`가 Upbit public REST schema, fixture, policy mapper, `Remaining-Req` parser를 먼저 고정한 뒤, WebSocket과 persistence PR을 후속으로 진행한다.
- 2026-05-17: issue #10 Sub PR 2는 `issue-10/02-upbit-websocket`에서 공개 quotation WebSocket `trade`/`orderbook` subscription, DEFAULT payload schema/mapper, fixture replay, stale/reconnect/disconnect status event contract를 고정한다. DB 저장소와 runtime worker 최종 wiring은 후속 sub PR에서 처리한다.

issue #3 sub PR 계획:

| 순서 | branch | 목표 | 제외 범위 | 파일 소유권 | 검증 |
| --- | --- | --- | --- | --- | --- |
| 1 | `issue-3/01-db-foundation` | `kysely`, `pg`, `@types/pg` dependency, Docker Compose, local DB config, Kysely + node-postgres connection boundary, dependency 승인 근거 | migration runner, schema migration, jobs repository, integration DB 검증 | `package.json`, `pnpm-lock.yaml`, `docker-compose.yml`, `.env.example`, `config/local-db.json`, `src/infrastructure/db/**`, DB foundation 관련 unit test, M1 관련 문서 | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |
| 2 | `issue-3/02-migration-schema` | raw SQL migration runner, `schema_migrations`, 일반 테이블, TimescaleDB hypertable migration | job queue repository, backup/restore smoke script 최종화 | `migrations/**`, migration runner, schema 관련 integration test | `corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |
| 3 | `issue-3/03-jobs-integration` | `jobs.idempotency_key` 중복 차단 검증, migration checksum mismatch test, backup/restore smoke test 초안, M1 문서 최종 상태 | M2 port/registry, Upbit adapter, risk/cost/strategy | jobs repository/test, backup/restore smoke script 또는 문서, M1 최종 문서 | `corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |

## 남은 이슈

- Node.js 24와 pnpm 실제 설치/CI 환경 구성은 구현 단계에서 확인한다.
- Upbit policy sync에 필요한 최소 API 권한은 pilot 전 별도 검토한다.
- `trend_following`, `mean_reversion`의 초기 feature threshold는 paper data 축적 후 조정한다.
- Phase 1.5 알트 편입은 MVP core 완료 후 별도 작업으로 유지한다.

## 완료 기준

- [ ] M0~M8 acceptance criteria가 모두 통과한다.
- [ ] `./scripts/verify docs`가 통과한다.
- [ ] 프로젝트 test/lint/typecheck/build가 정의되고 통과한다.
- [ ] 24시간 paper soak test 결과가 문서화된다.
- [ ] 실거래 주문 API 호출 0회가 테스트와 로그로 확인된다.
