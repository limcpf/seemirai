# Seemirai 아키텍처

Seemirai는 24/7 암호화폐 시장에서 비용 차감 후 기대값이 남는 거래만 실행 후보로 통과시키는 자동매매 시스템이다. 시스템의 중심은 예측 모델이 아니라 비용, 유동성, 리스크, 실행 품질을 일관되게 차감하고 차단하는 거래 게이트다.

상세 MVP 런타임 결정은 [`docs/design-docs/2026-05-13-mvp-runtime-architecture.md`](./docs/design-docs/2026-05-13-mvp-runtime-architecture.md)를 따른다. 현재 production 운영 경계는 [`docs/RUNTIME_CONFIG.md`](./docs/RUNTIME_CONFIG.md)의 `live:ops` 기준을 따른다. M1 DB table 역할과 관계는 [`docs/design-docs/2026-05-15-m1-database-schema.md`](./docs/design-docs/2026-05-15-m1-database-schema.md)를 따른다.

## 현재 Production 기준

현재 운영 주경로는 `live:ops`/`live:ops:daemon`과 `LIVE_AUTONOMOUS_SMALL_BUDGET` 설정이다. Production JSON은 `paper_no_key=false`,
`live_trading_enabled=true`, `KRW-BTC` 단일 universe, 1회 `10000` KRW와 일일 `30000` KRW 소액 예산을 명시해야 한다.
`config/paper.json`은 더 이상 production 설정의 출발점이 아니며, API key 없이 실행되는 legacy simulation/regression profile로만 유지한다.

## 역사적 MVP 확정 기준

MVP는 Upbit KRW 현물 기반 paper trading 시스템이다.

```yaml
mvp:
  exchange: UPBIT
  market: KRW_SPOT
  mode: PAPER_TRADING
  live_trading_enabled: false
  withdrawal_enabled: false
  cross_exchange_arbitrage_enabled: false
  futures_enabled: false
```

기본 runtime은 실거래 주문 API를 호출하지 않는다. Upbit 정책 조회가 필요한 경우에도 주문 실행 권한과 출금 권한을 분리하고, 정책 스냅샷 갱신 또는 통합 검증 프로파일에서만 인증 API를 사용한다.

## 런타임 기준

```yaml
runtime:
  language: TypeScript
  node_major: 24
  package_manager: pnpm
  app_shape: single_process_modular_monolith
  http_api: minimal_fastify
  web_ui: excluded
database:
  primary: PostgreSQL
  timeseries: TimescaleDB
  query_builder: Kysely
  migrations: raw_sql
  redis: excluded_for_mvp
deployment:
  os: Ubuntu_24_04_LTS
  packaging: Docker_Compose
  db_host: same_host_for_mvp
testing:
  runner: Vitest
  soak_test: 24h_paper_trading
```

Node.js 24 LTS와 pnpm을 표준 런타임으로 고정한다. MVP는 단일 Node.js 프로세스 안에 장시간 실행 worker를 두되, port/interface 경계를 통해 추후 collector, executor, notifier를 프로세스로 분리할 수 있게 한다.

## 핵심 경계

```text
Seemirai
 ├─ Runtime
 │  ├─ market-data-worker
 │  ├─ strategy-worker
 │  ├─ paper-execution-worker
 │  ├─ scheduler-worker
 │  ├─ notifier
 │  └─ optional Fastify HTTP server
 ├─ Application Ports
 │  ├─ CollectorPort
 │  ├─ StrategyPort
 │  ├─ BrokerPort
 │  ├─ RiskGatePort
 │  ├─ NotifierPort
 │  └─ AuditLogPort
 ├─ Exchange Adapter
 │  └─ UpbitKrwSpotAdapter: 공개 체결, 호가, 티커, 마켓 정책
 ├─ Storage
 │  ├─ PostgreSQL: 주문, 상태, 설정, 감사 로그, jobs
 │  └─ TimescaleDB: 체결, 호가 지표, 캔들, PnL snapshot
 ├─ Market Data Store
 │  ├─ 원천 이벤트 저장
 │  └─ 정규화된 캔들, 호가, 체결, 계정 이벤트
 ├─ Feature Engine
 │  ├─ 호가 불균형, 체결강도, 거래대금 급증
 │  ├─ 변동성 regime, 스프레드, 예상 슬리피지
 │  └─ UTC/KST 리셋, 거래소별 가격차 후보 피처
 ├─ Model Layer
 │  ├─ Regime Model: 추세장, 박스권, 급락장, 과열장 분류
 │  ├─ Alpha Model: 비용 차감 전 기대수익률과 분포 예측
 │  └─ Execution Model: 체결 가능성, 슬리피지, 취소 타이밍 예측
 ├─ Cost & Risk Engine
 │  ├─ 수수료, 스프레드, 슬리피지, 보유비용 차감
 │  ├─ 계정/종목/전략/유동성/손실 한도 확인
 │  └─ API 지연, 거래소 장애, 이상징후 기반 신규 주문 차단
 ├─ Strategy Layer
 │  ├─ 고유동성 현물 추세 추종
 │  └─ 박스권 평균회귀
 ├─ Execution Engine
 │  ├─ idempotency key 기반 주문 제출
 │  ├─ BrokerPort
 │  ├─ PaperBroker: legacy simulation/regression active
 │  ├─ UpbitLiveBroker: live-ops readiness guard 통과 시 active
 │  └─ 가상 체결 후 비용과 슬리피지 기록
 ├─ Backtest & Paper Trading
 │  ├─ 이벤트 기반 체결 시뮬레이션
 │  └─ 수수료, 호가 깊이, 지연, 부분체결, rate limit 반영
 └─ Monitoring & Reporting
    ├─ Pino JSON log
    ├─ PostgreSQL audit log
    ├─ Telegram outbound alert
    └─ optional Prometheus metrics
```

## 데이터 흐름

```text
Upbit WebSocket/REST
  -> 원천 이벤트 저장
  -> 정규화와 거래소 정책 병합
  -> 피처 생성
  -> 모델 예측 또는 규칙 기반 전략 신호
  -> 비용 차감
  -> 리스크 게이트
  -> 주문 실행
  -> 체결/미체결/취소 이벤트 기록
  -> 모니터링, 백테스트 보정, 리포트
```

Backtest는 runtime core를 재사용한다. `StrategyCore`, `CostModel`, `RiskGate`, `PositionManager`, `PaperExecutionSimulator`, `PnLCalculator`는 공유하고, `EventSource`, `Clock`, `Persistence`, worker lifecycle만 runtime과 backtest에서 분리한다.

## 확장성 원칙

MVP는 기능을 많이 넣는 방식이 아니라, 거래소, 전략, 매수/매도 기준, broker를 독립적으로 늘릴 수 있는 경계를 먼저 고정한다.

핵심 원칙:

- 거래소 구현은 market data, policy, broker 책임으로 나눈다.
- 전략은 주문을 직접 내지 않고 `StrategyDecision` 또는 `OrderIntent` 후보만 만든다.
- 매수/매도 기준은 strategy 내부 하드코딩이 아니라 rule 조합으로 구성한다.
- `CostModel`과 `RiskGate`는 모든 전략에 공통으로 적용되는 필수 gate다.
- `PaperBroker`와 future live broker는 같은 `BrokerPort`를 구현한다.
- MVP에서는 동적 plugin loading을 도입하지 않고 정적 registry + config 기반 활성화로 시작한다.

확장 포트:

```text
MarketDataPort
  - streamTrades()
  - streamOrderbook()
  - streamTicker()
  - getOrderbook()
  - getTicker()

ExchangePolicyPort
  - getMarkets()
  - getMarketStatus()
  - getOrderRules()
  - getOrderChance()
  - getFees()

BrokerPort
  - submitOrder()
  - cancelOrder()
  - getOrder()
  - listOpenOrders()
  - getBalances()

Strategy
  - id
  - version
  - requiredFeatures
  - evaluate()

Rule
  - name
  - evaluate()
```

정적 registry:

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

의존성 방향:

```text
domain -> 외부 시스템 모름
application -> port만 앎
infrastructure -> Upbit, PostgreSQL, Telegram 구현
runtime -> registry와 config로 조립
```

금지:

- `Strategy -> UpbitClient` 직접 호출
- `Strategy -> Broker` 직접 호출
- `RiskGate -> Upbit 전용 payload` 직접 의존
- `CostModel -> 특정 전략` 직접 의존
- `PaperBroker -> Strategy` 직접 의존

## 시간과 시장 기준

- 암호화폐는 24/7 시장이므로 장 마감 청산보다 상시 리스크 관리와 자동 정지장치를 우선한다.
- 일별 데이터와 거래대금 기준은 거래소 정책에 따라 UTC 기준과 KST 리셋을 모두 명시적으로 저장한다.
- Upbit는 일별 데이터, 전일대비 등락률, 24시간 거래대금, 일봉 계산에 UTC 0시를 기준으로 설명하므로 국내 현물 MVP도 UTC/KST 변환을 별도 피처로 다룬다.
- 거래소별 rate limit, 호가 단위, 최소 주문금액, 수수료는 코드에 고정하지 않고 정책 설정 또는 API 응답으로 관리한다.
- Upbit KRW 마켓 최소 주문 가능 금액 5,000 KRW와 가격 구간별 호가 단위는 정책 스냅샷으로 관리한다.

## 주문 후보 판정

모든 전략 신호는 다음 게이트를 통과해야 한다.

```text
거래 가능 조건 =
예상수익률
- 진입 수수료
- 청산 수수료
- 스프레드 비용
- 예상 슬리피지
- 펀딩비 또는 보유비용
- 출금/전송/환전 비용
> 최소 안전마진
```

MVP는 Upbit KRW 현물 paper trading 전용이므로 펀딩비와 출금/전송/환전 비용은 기본 거래 게이트에서 비활성화한다. 다만 데이터 모델에는 향후 글로벌 데이터, 김치프리미엄, 선물 모듈 확장을 위해 필드를 남긴다.

MVP 비용 공식은 다음과 같다.

```text
cost_bps =
  entry_fee_bps
+ exit_fee_bps
+ spread_cost_bps_p75
+ expected_slippage_bps_p95
+ cancel_requote_penalty_bps

trade_allowed =
  expected_return_bps >= cost_bps + safety_buffer_bps
```

기본 safety buffer는 BTC/ETH 10 bps, phase 1.5 상위 알트 20 bps다. 저유동성 알트, 신규 상장, 유의/주의 종목은 거래 금지다.

## 리스크 게이트

리스크 게이트는 전략보다 우선한다.

- 일간 최대 손실과 주간 최대 손실을 넘으면 신규 주문을 차단한다.
- 단일 코인, 알트코인 전체, 저유동성 코인 노출 한도를 확인한다.
- 스프레드, 호가 깊이, 체결 지연, 시세 지연이 기준을 벗어나면 신규 주문을 차단한다.
- 연속 손실 횟수가 기준을 넘으면 전략 또는 계정 단위로 정지한다.
- API 오류나 거래소 장애 상황에서는 자동 청산을 기본 동작으로 두지 않는다. 신규 주문 중지, 기존 미체결 주문 취소, 사람 확인 순서를 기본 복구 흐름으로 둔다.
- MVP 기본 한도는 일간 손실 -1%, 주간 손실 -3%, 전체 최대 낙폭 -5%, 1회 주문 계정 평가액 1%, 1회 거래 예상 손실 0.2%, 동일 전략 연속 손실 3회 중지다.

## 실행 엔진

주문 실행은 다음 순서를 따른다.

```text
1. 신호 발생
2. 비용 계산
3. 호가 깊이 확인
4. 포지션 한도 확인
5. 지정가 주문 제출
6. 제한 시간 동안 미체결이면 취소 또는 재호가
7. 시장 급변 또는 데이터 지연 감지 시 주문 취소
8. 체결 후 손절, 익절, 추적 상태 등록
9. 체결 수수료와 슬리피지 기록
```

시장가 주문은 MVP에서 기본 제외한다. 신규 진입 시장가는 금지한다. Emergency 축소 후보는 paper trading에서 공격적 지정가와 IOC/FOK 방식으로만 검증하고, 실거래 호출은 v0.2 pilot 승인 전까지 제외한다.

PaperBroker 경계:

```text
Strategy
  -> CostModel
  -> RiskGate
  -> ExecutionEngine
  -> BrokerPort
     -> PaperBroker active in MVP
     -> UpbitLiveBroker disabled/stub only
```

Paper fill model은 orderbook depth, latency, partial fill, post-only simulation, aggressive limit simulation을 반영한다. Market order simulation은 기본 비활성이다.

## 상태 전이와 장애 정책

주문, strategy, kill switch는 명시적 state machine으로 관리한다. 모든 상태 전이는 append-only event log에 남긴다.

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

장애 기본값은 신규 주문 차단이다. DB write failure와 duplicate idempotency key는 hard stop, balance/position mismatch는 manual review, notification failure는 audit 후 계속으로 처리한다. Hard stop 시 pending paper order는 취소하지만 open position은 자동 청산하지 않는다.

## 데이터 저장 정책

MVP 저장 정책:

| 데이터 | 정책 | 보관 |
| --- | --- | --- |
| raw payload | stream별 1분 1개 샘플 | 7일 |
| trades | `KRW-BTC`, `KRW-ETH` 전체 저장 | 30일 |
| orderbook metrics | 1초 집계 | 30일 |
| orderbook snapshots | 5초 간격, 15레벨 | 7일 |
| candles | 1m, 5m, 1h | 180일 |

MVP는 Redis와 BullMQ를 필수 구성에서 제외한다. 비동기 작업은 PostgreSQL `jobs` table 기반 DB-backed queue로 시작하며, 모든 job은 idempotency key와 명시적 상태 전이를 가진다.

## AI 사용 경계

LLM은 직접 주문 판단에 사용하지 않는다.

허용되는 LLM 사용:

- Upbit 공지 요약
- Upbit Developer Center changelog 요약
- `market_event.warning`, `market_event.caution` 기반 리스크 분류
- 상장, 상폐, 점검, 입출금 중단 공지 분류
- 이상 시장 이벤트 설명
- 일간 리포트 초안 생성

직접 주문 판단은 수치 모델, 전략 규칙, 비용/리스크 엔진이 담당한다.

## 단계별 확장

1. Upbit KRW paper trading MVP
   - Upbit KRW 현물
   - KRW-BTC, KRW-ETH
   - 추세 추종과 평균회귀
   - PaperBroker 기반 지정가, 비용 차감 후 가상 거래
2. Live Ops 소액 production 운영
   - `LIVE_AUTONOMOUS_SMALL_BUDGET`
   - KRW-BTC 단일, 1회 10000 KRW, 일일 30000 KRW
   - `live:ops`/TUI/Telegram/reconcile/PnL/status를 같은 lifecycle에서 조립
   - 저장소 밖 secret/env와 production JSON으로만 arm
3. 글로벌 데이터 추가
   - Binance, Coinbase, Bybit 등 가격 비교
   - USDT/KRW, 김치프리미엄, 글로벌 거래대금과 변동성 반영
4. 선물 모듈 추가
   - 펀딩비, 베이시스, 현물-선물 시장중립
   - 레버리지 제한과 청산 위험 모델
5. AI 고도화
   - 시장 국면 분류
   - 체결확률 예측
   - 거래하지 않을 구간 탐지
   - 뉴스와 공지 리스크 자동 분류
6. 운영 자동화
   - 일간 손익 리포트
   - 수수료 비중 리포트
   - 전략별 성과 분해
   - 모델 drift 감지
   - 자동 kill switch

## MVP 기술 방향

- 언어: TypeScript strict
- 런타임: Node.js 24 LTS
- 패키지 매니저: pnpm, lockfile 커밋
- HTTP: Headless worker + 최소 Fastify API
- 수집: 앱 내부 WebSocket worker 중심, REST 보조
- 저장소: PostgreSQL + TimescaleDB
- DB 접근: Kysely + node-postgres
- migration: raw SQL
- queue: PostgreSQL `jobs` table 기반 DB-backed queue
- Redis/BullMQ: MVP 제외
- 모델: LightGBM 또는 XGBoost 우선, 충분한 데이터 확보 후 Transformer 검토
- 백테스트: runtime core를 재사용하는 이벤트 기반 orchestrator
- 주문: BrokerPort, PaperBroker는 legacy simulation/regression active, UpbitLiveBroker는 live-ops readiness guard 통과 시 active
- 모니터링: Pino JSON log, PostgreSQL audit log, optional Prometheus `/metrics`
- 알림: Telegram outbound only, Slack adapter는 비활성
- 배포: Ubuntu 24.04 LTS + Docker Compose + same-host PostgreSQL/TimescaleDB
- 테스트: Vitest, fixture/mock, live API block test, 24시간 paper soak test

## 참고 출처

- Kraken: [What makes crypto 24/7/365?](https://www.kraken.com/learn/what-makes-crypto-24-7-365)
- Upbit: [거래 데이터 기준 시간](https://support.upbit.com/hc/ko/articles/900006049666-%EA%B1%B0%EB%9E%98-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EA%B8%B0%EC%A4%80-%EC%8B%9C%EA%B0%84%EC%9D%80-%EC%96%B8%EC%A0%9C%EC%9D%B8%EA%B0%80%EC%9A%94), [요청 수 제한](https://docs.upbit.com/kr/reference/rate-limits), [호가 모아보기](https://docs.upbit.com/kr/reference/websocket-orderbook)
- Binance: [Spot Trading Fee Rate](https://www.binance.com/en/fee/trading), [Futures Fee Structure](https://www.binance.com/en/support/faq/detail/360033544231), [Futures Funding Rates](https://www.binance.com/en/support/faq/detail/360033525031)
- Node.js: [Node.js Releases](https://nodejs.org/en/about/previous-releases)
- Ubuntu: [Ubuntu 24.04 LTS release notes](https://documentation.ubuntu.com/release-notes/24.04/)
- Docker: [Compose](https://docs.docker.com/compose/), [restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
