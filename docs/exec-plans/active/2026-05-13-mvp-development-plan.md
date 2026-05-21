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

- [x] Upbit public REST market list client
- [x] Upbit WebSocket trades/orderbook client
- [x] Upbit payload Zod schema
- [x] `market_event.warning`, `market_event.caution` 저장과 universe 차단
- [x] rate limit 상태 모델
- [x] raw payload sampling, trades 저장, orderbook metric 1초 집계, snapshot 5초 저장

검증:

- [x] Upbit REST fixture contract test
- [x] Upbit WebSocket fixture replay test
- [x] stale data와 reconnect event 기록 테스트

### M4. Cost, rule, strategy core

- [x] Decimal 기반 비용 계산
- [x] `cost_bps + safety_buffer_bps` 판정
- [x] 기본 buy/sell rule 구현
- [x] `trend_following` strategy skeleton
- [x] `mean_reversion` strategy skeleton
- [x] `StrategyDecision -> OrderIntent` 변환
- [x] 폐기 사유 audit log 연결

검증:

- [x] 비용 항목 증가 시 거래 가능성이 높아지지 않는 속성 테스트
- [x] 저유동성/주의/유의 종목 rule 차단 테스트
- [x] 전략이 직접 주문을 제출하지 않는 테스트

### M5. RiskGate와 상태 전이

- [x] 주문 state machine 구현
- [x] kill switch state machine 구현
- [x] M5 리스크 threshold config와 snapshot contract 구현
- [x] 주문 상태값 `as const` 중앙 목록화와 `order_events` persistence foundation 구현
- [x] 일간/주간/MDD/1회 주문/1회 손실/연속 손실 한도 evaluator 구현
- [x] stale market data, DB write failure, duplicate idempotency key 장애 정책 evaluator 구현
- [x] append-only `order_events`, `audit_events`, `risk_events` runtime 연결

검증:

- [x] 주문/kill switch 상태 전이 단위 테스트
- [x] 상태 목록과 transition map coverage 테스트
- [x] `order_events` migration/schema/repository 테스트
- [x] 각 risk limit 차단 테스트
- [x] hard stop 시 pending paper order 취소 테스트
- [x] open position 자동 청산 금지 테스트

### M6. ExecutionEngine과 PaperBroker

- [x] `ExecutionEngine` application service contract와 broker submit 전 guard 구현
- [x] idempotency key 필수화와 process-local in-flight 중복 broker submit 억제
- [x] `PaperBroker implements BrokerPort` 구현
- [x] depth 기반 paper fill simulator 구현
- [x] latency, partial fill, post-only simulation
- [x] aggressive limit IOC/FOK simulation
- [x] market order simulation 기본 비활성
- [x] live broker disabled/stub 구현
- [x] hard stop pending paper order cancel 실행 연결
- [x] PAPER_NO_KEY execution runtime assembly guard

검증:

- [x] PaperBroker 부분체결 테스트
- [x] `ExecutionEngine` 중복 주문 차단 테스트
- [x] live order API 호출 0회 테스트
- [x] market order 생성 불가 테스트

M6 완료 근거:

- 구현 PR: #29 `execution-contracts`, #30 `paper-fill-simulator`, #31 `paper-broker-port`, #32 `execution-persistence`, #33 `runtime-cancel-and-live-guard`
- 실행 경계: `CostModel -> RiskGate -> ExecutionEngine -> BrokerPort -> PaperBroker` 순서를 유지하고, `PAPER_NO_KEY` runtime에서는 `PaperBroker`만 active broker로 조립한다.
- 안전 경계: Upbit live broker는 disabled/stub으로만 노출하고, 기본 paper profile에서는 실거래 주문 API client 생성/호출 경로를 테스트로 차단한다.
- 복구 경계: `HARD_STOP` pending paper order cancel은 `BrokerPort.cancelOrder`로 실행하되, open position 자동 청산은 실행 직전 guard에서도 금지한다.
- 저장소 경계: `orders`/`paper_orders`/`fills`/`positions`와 `order_events`는 execution persistence adapter가 transaction 안에서 기록하며, durable idempotency는 `orders.idempotency_key` upsert로 처리한다.
- Sub PR 6 검증: 신규 기능 없이 문서 기준과 전체 검증 증거를 정리한다. M7 Backtest bridge와 M8 운영 가드레일은 후속 milestone으로 유지한다.

### M7. Backtest bridge

- [x] `MarketEvent` 공통 포맷 정의
- [x] `HistoricalEventSource`
- [x] runtime core 재사용 backtest orchestrator
- [x] paper trading 결과와 backtest 결과 비교 리포트

M7 진행 근거:

- issue #36은 backtest input contract, fixture/source, orchestrator, reporting/verification 경계가 나뉘어 리뷰 위험이 크므로 `sub PR mode`에서 순차 진행한다.
- Sub PR 1은 `issue-36/01-market-event-foundation`에서 replay/backtest용 공용 `MarketEvent`, `HistoricalEventSource` port, fixture schema, deterministic ordering rule을 고정한다.
- Sub PR 2는 `issue-36/02-historical-event-source`에서 fixture 기반 deterministic `HistoricalEventSource` 구현, replay request filtering, 반복 replay 검증을 고정한다.
- Sub PR 3은 `issue-36/03-backtest-orchestrator`에서 `HistoricalEventSource -> Strategy -> CostModel -> RuleEngine -> RiskGate -> Execution evidence validation -> paper fill simulator` 순서의 backtest application orchestrator를 고정한다.
- Sub PR 4는 `issue-36/04-backtest-reporting-verification`에서 비용 0/비용 반영 차이 리포트, PaperBroker 후보 일관성 리포트, M7 최종 검증을 고정한다.

검증:

- [x] 동일 fixture에서 runtime core와 backtest core 판정 일치 테스트
- [x] 비용 0/비용 반영 결과 차이 리포트 테스트

### M8. 운영 가드레일과 soak test

- [ ] Fastify `/healthz`, `/readyz`, `/status`, optional `/metrics`
  - [x] issue #42 Sub PR 1: Fastify dependency, HTTP server foundation, `/healthz`, `/readyz`, `/status`, safe status summary, bearer guard foundation
  - [ ] optional `/metrics`
- [ ] local token 기반 kill switch endpoint
  - [x] issue #42 Sub PR 1: POST control endpoint용 bearer guard와 token 누락 startup fail foundation
  - [x] issue #42 Sub PR 2: `POST /kill-switch` 상태 전이 실행, target enum, illegal transition 처리, P0 원인 mapping, HARD_STOP pending cancel job 경계
- [x] Telegram outbound notifier
- [x] issue #42 Sub PR 3: Telegram outbound adapter, plain text format, 4096자 전송 제한, provider timeout/failure, alert fingerprint, P0/P1 durable cooldown, delivery reservation, P2/P3 memory cooldown, severity escalation bypass, notification failure threshold reason code
- [x] alert fingerprint + cooldown
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
- 2026-05-17: issue #10 Sub PR 3은 `issue-10/03-market-data-persistence`에서 `policy_snapshots`, `trades`, `orderbook_metrics`, `orderbook_snapshots` repository와 idempotent insert/upsert 경계를 고정한다. runtime worker 연결과 M3 최종 완료 체크는 후속 Sub PR 4에서 처리한다.
- 2026-05-17: issue #10 Sub PR 4는 `issue-10/04-runtime-verification`에서 `PAPER_NO_KEY` Upbit public quotation runtime assembly, market data event persistence routing, status event의 audit/risk 차단 후보 매핑을 고정하고 M3 체크리스트를 완료 처리한다. 실제 RiskGate state machine과 주문 차단 적용은 M5 범위로 유지한다.
- 2026-05-18: issue #16은 M4 Cost/rule/strategy core 범위가 cost model, strategy config/rules, strategy variants, audit persistence/docs로 나뉘어 `sub PR mode`에서 순차 진행됐다. Sub PR 4는 `AuditLogPort -> audit_events` append adapter와 주문 후보 폐기 audit helper로 폐기 사유 추적 경계를 고정하고 M4 체크리스트를 완료 처리한다.
- 2026-05-19: issue #22는 M5 RiskGate와 상태 전이 범위가 state machine, `order_events` persistence, risk limit evaluator, runtime `risk_ok` 연결로 나뉘어 리뷰 위험이 크므로 `sub PR mode`에서 순차 진행한다. 공통 RiskGate result type, migration 순서, runtime rule 연결이 서로 맞물려 기본 운영은 병렬이 아니라 선행 PR merge 후 다음 PR을 만드는 방식으로 유지한다.
- 2026-05-19: issue #22 Sub PR 2는 `issue-22/02-risk-persistence`에서 상태값을 `as const` 목록과 union type으로 중앙화하고, `orders.status`/`order_events` migration check, `order_events` repository, `audit_events`/`risk_events` row mapper, append persistence test를 고정한다.
- 2026-05-19: issue #22 Sub PR 3은 `issue-22/03-risk-limit-evaluator`에서 손실/노출/인프라 risk evaluator와 threshold snapshot payload를 구현한다. runtime `risk_ok` 연결, hard stop pending order action event, append-only 저장소 wiring은 Sub PR 4 범위로 유지한다.
- 2026-05-19: issue #22 Sub PR 4는 `issue-22/04-runtime-rule-integration`에서 `risk_ok`를 현재 후보와 일치하는 context 기반 RiskGate 평가에 연결하고, RiskGate 판단을 주문 상태 전이/kill switch 전이/`risk_events`/`audit_events` combined evidence append 계획으로 변환한다. 현재 kill switch가 신규 주문 차단 상태이면 RiskGate snapshot이 깨끗해도 주문을 거부한다. `HARD_STOP`은 pending paper order 취소 계획 event만 만들며, 실제 broker cancel 호출과 open position 자동 청산은 수행하지 않는다.
- 2026-05-19: issue #28은 M6 ExecutionEngine과 PaperBroker 범위가 execution contract, fill simulation, broker port, DB persistence, runtime cancel/live guard로 나뉘어 리뷰 위험이 크므로 `sub PR mode`에서 순차 진행한다. Sub PR 1은 `ExecutionEngine`이 비용 snapshot, RiskGate evidence, expected loss fingerprint, idempotency key, market/live order safety guard를 통과한 주문만 `BrokerPort`로 넘기는 contract를 먼저 고정한다. process-local idempotency 중복 억제는 in-flight 요청으로 제한하고 durable 중복 처리는 후속 DB persistence 범위로 남긴다.
- 2026-05-19: issue #28 Sub PR 2는 `issue-28/02-paper-fill-simulator`에서 `OrderIntent + OrderbookEvent`만 입력으로 받는 순수 paper fill simulator를 고정한다. DB persistence, PaperBroker state, runtime assembly는 후속 PR로 남기고, depth 기반 full/partial/unfilled, latency snapshot 선택, post-only maker 보호, IOC/FOK aggressive limit, market order simulation disabled 결과를 Decimal 문자열 경계로 계산한다.
- 2026-05-19: issue #28 Sub PR 3은 `issue-28/03-paper-broker-port`에서 in-memory `PaperBroker implements BrokerPort`를 고정한다. 주문 제출은 기존 fill simulator 결과를 broker 주문 상태로 변환하고, idempotency key 재제출 억제, open 주문 조회, 취소 시 가상 잔고 lock 해제, 부분체결 잔고 mutation을 같은 memory state에서 처리한다. DB persistence wiring, runtime worker 최종 조립, live broker disabled/stub은 후속 PR 범위로 유지한다.
- 2026-05-20: issue #28 Sub PR 4는 `issue-28/04-execution-persistence`에서 paper broker 실행 결과를 `orders`/`paper_orders`/`fills`/`positions`와 `order_events`에 같은 DB transaction으로 저장하는 경계를 고정한다. durable idempotency는 `orders.idempotency_key` upsert로 처리하고, 재시도는 기존 주문을 반환하되 fill/position side effect를 반복하지 않는다.
- 2026-05-20: issue #28 Sub PR 5는 `issue-28/05-runtime-cancel-and-live-guard`에서 `PAPER_NO_KEY` execution runtime assembly를 `ExecutionEngine -> PaperBroker`로 고정하고, Upbit live broker는 모든 `BrokerPort` 메서드가 실패하는 disabled/stub으로만 노출한다. `HARD_STOP`의 pending paper order cancel action plan은 `BrokerPort.cancelOrder`로 실행하되, open position 자동 청산은 실행 직전 guard에서도 금지한다.
- 2026-05-20: issue #28 Sub PR 6은 `issue-28/06-m6-verification-docs`에서 M6 구현 PR #29~#33의 완료 근거와 전체 검증 범위를 문서화한다. 신규 기능 구현이나 schema 변경은 하지 않고, M7 Backtest bridge와 M8 운영 가드레일은 다음 milestone의 남은 범위로 유지한다.
- 2026-05-20: issue #36은 M7 Backtest bridge 범위가 공용 event contract, historical source, orchestrator, reporting/verification으로 나뉘어 리뷰 위험이 크므로 `sub PR mode`에서 순차 진행한다. Sub PR 1은 replay/backtest용 `MarketEvent`와 `HistoricalEventSource` port, fixture schema, deterministic ordering rule만 고정하고, 실제 fixture source와 orchestrator/reporting은 후속 PR로 남긴다.
- 2026-05-20: issue #36 Sub PR 2는 `issue-36/02-historical-event-source`에서 fixture JSON을 검증한 뒤 deterministic `HistoricalEventSource`로 replay하는 source를 구현한다. replay filtering은 `exchangeId`, `markets`, `from/to`, `sourceId`, `limit`을 지원하고, marketless `STATUS`는 연결 단위 shared event로 market filter가 있어도 유지한다. DB-backed source와 orchestrator는 후속 PR로 유지한다.
- 2026-05-20: issue #36 Sub PR 3은 `issue-36/03-backtest-orchestrator`에서 fixture/historical replay 이벤트를 기존 strategy, cost model, rule engine, RiskGate, execution evidence validation, paper fill simulator에 순서대로 연결하는 backtest application orchestrator를 고정한다. paper/backtest consistency 리포트와 M7 최종 문서화는 Sub PR 4로 유지한다.
- 2026-05-20: issue #36 Sub PR 4는 `issue-36/04-backtest-reporting-verification`에서 `BacktestRunResult`를 전략별 거래 수, fill rate, fee, slippage, 추정 PnL 후보로 집계하는 리포트와 비용 0/비용 반영 비교 리포트를 고정한다. 같은 fixture에서 Backtest 제출 후보와 `PaperBroker` 주문 결과를 같은 record로 정규화해 idempotency key 기준 일치 여부를 검증하고 M7 체크리스트를 완료 처리한다.
- 2026-05-20: issue #42는 M8 운영 가드레일 범위가 HTTP control API, kill switch control, Telegram/cooldown, daily report, soak verification으로 나뉘어 리뷰 위험이 크므로 `sub PR mode`에서 순차 진행한다. Sub PR 1은 `issue-42/01-http-control-foundation`에서 Fastify 5.8.5 runtime dependency와 최소 HTTP server, `/healthz`, `/readyz`, `/status`, safe status response, 공통 error/correlation id, POST control bearer guard foundation을 고정한다. 실제 `/kill-switch` 상태 전이 실행, Telegram delivery, daily report, soak script는 후속 PR 범위로 유지한다.
- 2026-05-21: issue #42 Sub PR 2는 `issue-42/02-kill-switch-control`에서 `POST /kill-switch`를 local bearer token 보호 route로 등록하고, target state enum, `HARD_STOP -> NORMAL` 직접 복구 거부, `kill_switch_state` durable snapshot 갱신, `audit_events`/`risk_events` evidence, `HARD_STOP` pending paper order cancel job 예약 경계를 고정한다. broker cancel 실행, Telegram delivery, daily report, soak script는 후속 PR 범위로 유지한다.
- 2026-05-21: issue #42 Sub PR 3은 `issue-42/03-alerts-telegram-cooldown`에서 Telegram `sendMessage` outbound adapter, plain text formatter, 4096자 전송 제한, provider timeout/failure reason, alert fingerprint, P0/P1 durable cooldown과 atomic delivery reservation, P2/P3 memory cooldown, severity escalation bypass, P0/P1 retry job 후보와 notification failure threshold reason code를 고정한다. Telegram inbound command, daily report aggregator, retry worker 실행, 24시간 soak script는 후속 PR 범위로 유지한다.

issue #42 sub PR 계획:

| 순서 | branch | 목표 | 제외 범위 | 파일 소유권 | 검증 |
| --- | --- | --- | --- | --- | --- |
| 1 | `issue-42/01-http-control-foundation` | Fastify dependency, 최소 HTTP server, `/healthz`, `/readyz`, `/status`, safe status response, 공통 error/correlation id, POST control bearer guard foundation | kill switch state transition 실행, Telegram, alert cooldown, daily report, soak, `/metrics` | `package.json`, `pnpm-lock.yaml`, `src/interfaces/**`, HTTP control tests, M8 관련 docs | `corepack pnpm typecheck`, `corepack pnpm exec vitest run tests/unit/http-control.test.ts`, `corepack pnpm test`, `./scripts/verify`, `git diff --check` |
| 2 | `issue-42/02-kill-switch-control` | `POST /kill-switch`, target state enum, illegal transition handling, P0 원인별 mapping, HARD_STOP action plan/job boundary | Telegram delivery, daily report, 24h soak | HTTP control route extension, domain/application kill switch mapping, 관련 unit tests | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify`, `git diff --check` |
| 3 | `issue-42/03-alerts-telegram-cooldown` | Telegram outbound adapter with `fetch`, plain text formatting, provider timeout/failure, alert fingerprint, P0/P1 durable cooldown, P2/P3 memory cooldown, severity escalation bypass | Telegram inbound webhook/polling/command, daily report aggregator | notifier adapter/cooldown modules, alert tests, 필요 시 DB migration | `corepack pnpm typecheck`, `corepack pnpm test`, DB migration 시 `SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |
| 4 | `issue-42/04-daily-reporting` | deterministic daily report aggregator, KST 기준일과 UTC query window, realized/estimated PnL 분리, 비용/폐기/차단 사유 집계, jobs idempotency | LLM report draft, soak script | reporting module/tests, jobs integration 필요분 | `corepack pnpm typecheck`, `corepack pnpm test`, `SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |
| 5 | `issue-42/05-soak-verification-docs` | fixture smoke와 24h soak script, `SEEMIRAI_RUN_SOAK=1` guard, live API 0회/audit/stale/status 요약, M8 문서 최종화 | 신규 운영 기능 구현, raw soak log 커밋 | `scripts/**`, `tests/soak/**` 또는 관련 smoke tests, M8 docs | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify`, `git diff --check`, 별도 `SEEMIRAI_RUN_SOAK=1 ...` |

issue #36 sub PR 계획:

| 순서 | branch | 목표 | 제외 범위 | 파일 소유권 | 검증 |
| --- | --- | --- | --- | --- | --- |
| 1 | `issue-36/01-market-event-foundation` | replay/backtest용 공용 `MarketEvent`, `HistoricalEventSource` port, fixture schema, deterministic ordering rule | fixture source 구현, orchestrator, DB-backed source, reporting | `src/domain/market-event.ts`, `src/application/ports/historical-event-source-port.ts`, `src/application/backtest/**`, backtest fixture/test, M7 계획 문서 | `corepack pnpm typecheck`, `corepack pnpm exec vitest run tests/unit/backtest-market-event.test.ts`, `corepack pnpm test`, `./scripts/verify`, `git diff --check` |
| 2 | `issue-36/02-historical-event-source` | fixture 기반 deterministic `HistoricalEventSource`, 필요 시 DB-backed source contract 보강, replay filtering 테스트 | strategy/cost/risk orchestrator, result reporting | `src/application/backtest/**`, `src/infrastructure/**` source adapter 필요분, fixtures/tests | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |
| 3 | `issue-36/03-backtest-orchestrator` | strategy/rule/cost/RiskGate와 paper fill simulator를 재사용하는 backtest orchestrator | 최종 비교 리포트, 운영 endpoint, Telegram | `src/application/backtest/**`, 필요한 runtime core adapter, orchestrator tests | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |
| 4 | `issue-36/04-backtest-reporting-verification` | 비용 0 vs 비용 반영 비교 리포트, paper/backtest consistency test, M7 문서 최종화 | 신규 runtime endpoint, 24h soak, Telegram | reporting module/tests, M7 docs | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify`, `git diff --check` |

issue #28 sub PR 계획:

| 순서 | branch | 목표 | 제외 범위 | 파일 소유권 | 검증 |
| --- | --- | --- | --- | --- | --- |
| 1 | `issue-28/01-execution-contracts` | `ExecutionEngine` contract, 비용 snapshot/RiskGate evidence/idempotency guard, market/live order fail-closed, execution config 기본값 확인 | PaperBroker fill simulation, DB persistence, hard stop cancel 실행, live broker stub | `src/application/execution/**`, `src/application/index.ts`, `tests/unit/execution-engine.test.ts`, `tests/unit/config.test.ts`, M6 실행 계획 문서 | `corepack pnpm typecheck`, `corepack pnpm exec vitest run tests/unit/execution-engine.test.ts tests/unit/config.test.ts`, `corepack pnpm test`, `./scripts/verify`, `git diff --check` |
| 2 | `issue-28/02-paper-fill-simulator` | orderbook depth 기반 full/partial/unfilled, latency, post-only, IOC/FOK aggressive limit paper simulation | DB repository, runtime assembly, live broker stub | `src/application/execution/**` 또는 `src/domain/execution/**`, fill simulator tests/fixtures | `corepack pnpm typecheck`, `corepack pnpm test -- paper-fill`, `./scripts/verify` |
| 3 | `issue-28/03-paper-broker-port` | `PaperBroker implements BrokerPort`, in-memory broker state, order/balance query, import boundary test | PostgreSQL persistence wiring, runtime worker 최종 조립 | `src/infrastructure/paper/**`, 필요한 port 보강, `tests/unit/paper-broker*.test.ts` | `corepack pnpm typecheck`, `corepack pnpm test -- paper-broker`, `./scripts/verify` |
| 4 | `issue-28/04-execution-persistence` | `orders`/`paper_orders`/`fills`/`positions` repository, idempotency upsert, state event/fill/position transaction 경계 | live broker 구현, Telegram/Fastify endpoint | `src/infrastructure/db/**`, execution persistence port, integration tests, DB schema docs 필요분 | `corepack pnpm typecheck`, `corepack pnpm test`, `SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |
| 5 | `issue-28/05-runtime-cancel-and-live-guard` | hard stop pending paper order cancel 실행 연결, open position 자동 청산 금지, live broker disabled/stub, PAPER_NO_KEY runtime assembly guard | Telegram alert endpoint, 24h soak test | `src/runtime/**`, `src/application/execution/**`, live stub 필요 시 `src/infrastructure/upbit/**`, runtime/live tests, `docs/RELIABILITY.md`, `docs/RUNTIME_CONFIG.md` | `corepack pnpm typecheck`, `corepack pnpm test`, live API 호출 0회 테스트, `./scripts/verify` |
| 6 | `issue-28/06-m6-verification-docs` | M6 체크리스트 완료, 결정 로그와 남은 리스크 갱신, 전체 verify와 review drain 준비 | 신규 기능 구현 | M6 관련 docs, 필요 시 generated index | `corepack pnpm typecheck`, `corepack pnpm test`, DB touched 시 integration, `./scripts/verify`, `git diff --check` |

issue #22 sub PR 계획:

| 순서 | branch | 목표 | 제외 범위 | 파일 소유권 | 검증 |
| --- | --- | --- | --- | --- | --- |
| 1 | `issue-22/01-risk-state-foundation` | 주문 state machine, kill switch state machine, RiskGate 타입, M5 threshold config, 상태 전이 단위 테스트 | DB migration/repository, risk limit evaluator, `risk_ok` runtime 연결, broker cancel 호출 | `src/domain/risk.ts`, `src/domain/state-machines.ts`, `src/runtime/risk-config.ts`, `src/runtime/config.ts`, `config/paper.json`, state/config unit test, M5 관련 문서 | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |
| 2 | `issue-22/02-risk-persistence` | 상태값 `as const` 중앙 목록화, `order_events` migration/schema/repository, state transition event mapper, append persistence integration test | risk limit evaluator, `risk_ok` runtime 연결, PaperBroker 실행 | `migrations/**`, `src/domain/orders.ts`, `src/domain/state-machines.ts`, `src/infrastructure/db/**`, persistence tests, DB schema docs | `corepack pnpm typecheck`, `corepack pnpm test`, `SEEMIRAI_RUN_DB_INTEGRATION=1 corepack pnpm exec vitest run tests/integration`, `./scripts/verify` |
| 3 | `issue-22/03-risk-limit-evaluator` | 손실/노출/인프라 risk evaluator, threshold snapshot payload, risk limit 단위 테스트 | persistence migration 변경, runtime rule 최종 연결 | `src/domain/risk.ts`, `src/application/risk/**`, risk evaluator tests | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |
| 4 | `issue-22/04-runtime-rule-integration` | `risk_ok` 실제 RiskGate 결과 연결, hard stop pending paper order cancel action plan/event, M5 문서 최종화 | ExecutionEngine, PaperBroker 체결/부분체결/재호가, Telegram endpoint | runtime/rule integration, audit/risk/order event wiring, M5 docs | `corepack pnpm typecheck`, `corepack pnpm test`, `./scripts/verify` |

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
