# 런타임 설정

이 문서는 Seemirai runtime을 어떤 안전 경계로 조립하는지 설명한다. `config/paper.json`은 MVP 기본 paper trading profile이며, API key 없이 로딩되어야 한다.

구현 기준:

- schema: `src/runtime/config.ts`
- registry 활성화 schema: `src/runtime/registry-config.ts`
- risk threshold schema: `src/runtime/risk-config.ts`
- 기본 profile: `config/paper.json`

## 책임

`config/paper.json`은 실행 시 켤 exchange, universe, strategy, rule 조합과 안전 toggle을 정의한다. 가능한 exchange, strategy, rule 목록은 코드 registry가 갖고, config는 그중 활성화할 항목만 고른다.

이 파일은 secret 저장소가 아니다. API key, Telegram token, local control token 같은 값은 git에 커밋하지 않는다.

## 최상위 구조

| 필드 | 허용값 또는 기본값 | 역할 |
| --- | --- | --- |
| `exchange` | `UPBIT` | MVP 거래소 제품 범위 |
| `market` | `KRW_SPOT` | MVP 시장 범위 |
| `mode` | `PAPER_TRADING` | 실거래 주문 없이 paper runtime으로 실행 |
| `live_trading_enabled` | `false` 필수 | 실거래 주문 API 경로 차단 |
| `withdrawal_enabled` | `false` 필수 | 출금 권한과 출금 자동화 차단 |
| `cross_exchange_arbitrage_enabled` | `false` 필수 | 거래소 간 송금/환전 차익거래 차단 |
| `futures_enabled` | `false` 필수 | 선물 범위 차단 |
| `leverage_enabled` | `false` 필수 | 레버리지 범위 차단 |
| `market_order_enabled` | `false` 필수 | 시장가 주문 기본 차단 |
| `entry_market_order_enabled` | `false` 필수 | 신규 진입 시장가 주문 차단 |
| `paper_no_key` | `true` 필수 | paper mode가 API key 없이 시작됨을 보장 |
| `universe` | `KRW-BTC`, `KRW-ETH` | MVP 거래 후보 universe |
| `llm` | trade signal 생성 불가 | LLM이 매매 판단을 직접 만들지 못하게 제한 |
| `registry` | 정적 registry id 참조 | exchange, strategy, rule 활성화 조합 |
| `strategyParameters` | strategy별 기본 threshold | 전략 후보 생성과 rule 평가에 쓰는 보수적 기준값 |
| `risk` | M5 리스크 한도 threshold | RiskGate 평가와 상태 전이 audit에 쓰는 보수적 계정/노출/손실 한도 |
| `secrets` | 기본 `{}` | schema shape만 표현하며 실제 secret은 저장하지 않음 |

## 안전 invariant

MVP 기본 profile에서는 다음 값이 켜져 있으면 안 된다.

```json
{
  "live_trading_enabled": true,
  "withdrawal_enabled": true,
  "cross_exchange_arbitrage_enabled": true,
  "futures_enabled": true,
  "leverage_enabled": true,
  "market_order_enabled": true,
  "entry_market_order_enabled": true,
  "paper_no_key": false
}
```

`assertSafeRuntimeConfig`는 위반 값을 발견하면 runtime config 로딩을 실패시킨다.

## M8 HTTP control foundation

구현 기준:

- server/route foundation: `src/interfaces/http-control.ts`
- auth/readiness/status/schema 세부 구현: `src/interfaces/http-control/*.ts`
- 기본 bind: `127.0.0.1`
- 기본 port: `8787`

M8 HTTP control API는 headless worker의 로컬 운영 endpoint다. Sub PR 1에서는 읽기 전용 endpoint와 POST control
endpoint가 공통으로 사용할 인증 guard만 고정한다.

읽기 endpoint:

- `GET /healthz`: process alive만 확인한다. DB, migration, runtime dependency를 확인하지 않는다.
- `GET /readyz`: DB 연결, DB write check, migration version, runtime config loaded 상태를 readiness summary로 반환한다.
  DB write check는 `jobs` 실제 앱 테이블에 rollback 가능한 insert를 수행해 TEMP table 권한만 있는 상태를 ready로 보지 않는다.
- `GET /status`: full config 대신 safe summary만 반환한다.

`/status` safe summary는 다음 필드만 노출한다.

- runtime: `exchange`, `market`, `mode`, phase 1 universe, live trading toggle, `paperNoKey`
- trading state: current kill switch state, blocked reason, 신규 주문 차단 여부, 수동 검토 필요 여부
- market data: connection status, lag ms, updated time
- paper: pending paper order count, open position count
- database: `/readyz`와 같은 readiness summary
- alerts: last sent/skipped timestamp
- daily report: last status, report date, updated time

`/status`는 `secrets`, local control token, Telegram token, raw headers, raw order detail, raw position detail을 반환하지 않는다.
kill switch가 `NEW_ORDERS_BLOCKED` 또는 `HARD_STOP` 같은 active 상태여도 `/readyz` 실패로 표현하지 않고
`/status.tradingState`에만 나타낸다.

POST control endpoint는 후속 PR에서 `/kill-switch`를 등록한다. 이 foundation은 `Authorization: Bearer <token>` 검증
함수와 Fastify `preHandler`를 제공하며, POST control endpoint가 활성화된 상태에서 local control token이 없으면 startup
fail한다. 실제 secret 값은 env 또는 외부 secret 주입으로 전달하고 config/document/status에 기록하지 않는다.

## M6 Execution 안전 설정

구현 기준:

- execution guard: `src/application/execution/execution-engine.ts`
- 기본 profile: `config/paper.json`

M6 `ExecutionEngine`은 runtime config의 실행 관련 안전 toggle을 application layer의 `ExecutionSafetyConfig`로 전달받아
broker 호출 직전에 다시 검증한다. 이 guard는 PaperBroker 구현체가 붙기 전에도 다음 조건을 fail-closed로 유지한다.

- `liveTradingEnabled=false`
- `marketOrderEnabled=false`
- `entryMarketOrderEnabled=false`
- `paperNoKey=true`

`ExecutionEngine`은 비용 snapshot과 RiskGate approval evidence가 현재 주문 intent의 exchange, market, strategy,
side, order type, idempotency key, 수량, 명목 금액, 지정가, limit execution option(`postOnly`, `timeInForce`),
expected loss와 일치할 때만 `BrokerPort.submitOrder`를 호출한다. 비용 snapshot은 `source=cost_model`,
`trade_allowed=true`, `reason_code=cost_margin_ok`이고 `missing_fields`/`invalid_fields`가 없는 증거만 인정한다.
RiskGate approval evidence는 `source=risk_gate`, `approved=true`, `action=ALLOW`, `status=PASS|WARN` 조건을
모두 만족해야 한다. 기본 paper profile에서는 market order와 신규 진입 market order를 broker로 넘기지 않는다. 같은
process 안에서 같은 `idempotencyKey`가 in-flight 상태로 반복 제출되면 fingerprint가 같은 경우에만 broker submit
side effect를 한 번으로 억제하고, fingerprint가 다르면 idempotency key collision으로 fail-closed한다. 성공한 key는
application memory에 계속 보관하지 않는다. DB-backed idempotency와 주문 persistence transaction 경계는
`PostgresExecutionPersistenceRepository`가 담당한다.

## PAPER_NO_KEY execution runtime

구현 기준:

- assembly: `src/runtime/execution-runtime.ts`
- active broker: `src/infrastructure/paper/paper-broker.ts`
- disabled live stub: `src/infrastructure/upbit/disabled-live-broker.ts`
- 기본 worker id: `paper-no-key-execution-worker`

`PAPER_NO_KEY` execution runtime은 `config/paper.json`을 로딩한 뒤 다음 조건을 추가로 검증한다.

- `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이어야 한다.
- `registry.exchangeId=upbit_krw_spot`이어야 한다.
- `paper_no_key=true`이어야 한다.
- `live_trading_enabled=false`, `market_order_enabled=false`, `entry_market_order_enabled=false`이어야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`가 없어야 한다.

runtime assembly는 `ExecutionEngine`에 `PaperBroker`만 연결한다. Upbit live broker는 `DisabledUpbitLiveBroker` stub으로만
노출되며 `submitOrder`, `cancelOrder`, `getOrder`, `listOpenOrders`, `getBalances`가 모두
`UpbitLiveBrokerDisabledError`로 실패한다. 이 stub은 Upbit private REST client를 만들지 않으므로 paper profile에서
실거래 주문/취소/잔고 API 호출이 발생하지 않는다.

hard stop 처리에서 RiskGate가 만든 pending paper order cancel action plan은
`executeHardStopPendingPaperOrderCancels`가 `BrokerPort.cancelOrder`로 실행한다. 이 함수는 action plan의
`autoLiquidateOpenPositions=false`를 다시 확인하고, true가 들어오면 broker side effect 전에 실패한다. 따라서 장애
상황의 자동 조치는 신규 주문 차단과 미체결 paper order 취소에 한정되며, open position 자동 청산은 수행하지 않는다.

## PAPER_NO_KEY market data runtime

구현 기준:

- assembly: `src/runtime/market-data-runtime.ts`
- Upbit public WebSocket endpoint: `wss://api.upbit.com/websocket/v1`
- 기본 consumer id: `paper-no-key-market-data-worker`

`PAPER_NO_KEY` market data runtime은 `config/paper.json`을 로딩한 뒤 다음 조건을 추가로 검증한다.

- `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이어야 한다.
- `registry.exchangeId=upbit_krw_spot`이어야 한다.
- `paper_no_key=true`이어야 한다.
- `secrets.upbit_access_key`, `secrets.upbit_secret_key`가 없어야 한다.
- WebSocket subscription message에는 `Authorization`, `Bearer`, private path, `myOrder`, `myAsset`, `orders/chance`, `/v1/orders` 후보가 없어야 한다.

runtime assembly는 `universe.phase_1`의 `KRW-BTC`, `KRW-ETH`에 대해 공개 `trade`, `orderbook` subscription만 만든다. 이 단계는
실제 주문, 잔고, 인증 API client를 생성하지 않는다.

market data status event는 다음 방식으로 저장 경계를 지난다.

| status | audit_events | risk_events | 신규 주문 차단 입력 |
| --- | --- | --- | --- |
| `CONNECTED` | `MARKET_DATA_STATUS`, `INFO` | 없음 | false |
| `STALE` | `MARKET_DATA_STATUS`, `WARN` | `stale_market_data`, `BLOCK_NEW_ORDERS` | true |
| `RECONNECTING` | `MARKET_DATA_STATUS`, `WARN` | `market_data_reconnecting`, `BLOCK_NEW_ORDERS` | true |
| `DISCONNECTED` | `MARKET_DATA_STATUS`, `ERROR` | `market_data_disconnected`, `BLOCK_NEW_ORDERS` | true |

M3는 실제 RiskGate state machine을 구현하지 않고 위 차단 입력 신호까지만 만든다. M5 Sub PR 1은 state machine과
threshold config foundation을 제공하고, 실제 주문 차단 적용은 M5 runtime integration 범위다.

## 주문 후보 폐기 Audit

M4는 주문 후보가 실행 단계로 넘어가지 못한 이유를 `AuditLogPort`로 남길 수 있는 application contract와
`audit_events` PostgreSQL append adapter를 제공한다.

저장 기준:

- event type: `ORDER_DECISION`
- severity: `WARN`
- payload marker: `audit_kind=ORDER_CANDIDATE_DISCARDED`
- discard stage: `STRATEGY_DECISION`, `INTENT_CONVERSION`, `COST_DECISION`, `RULE_ENGINE`
- payload 주요 필드: `strategy_id`, `reason_code`, `order_intent`, `strategy_decision`, `intent_conversion`, `cost_decision`, `rule_result`

이 audit event는 실제 주문 제출 근거가 아니라, M5 RiskGate와 M6 ExecutionEngine 이전에 후보가 폐기된 이유를 사람이
추적하기 위한 append-only 기록이다.

## Universe 구조

```json
{
  "universe": {
    "phase_1": ["KRW-BTC", "KRW-ETH"],
    "auto_include_new_listing": false,
    "exclude_warning": true,
    "exclude_caution": true
  }
}
```

- `phase_1`: MVP 기본 거래 후보 market. 현재는 `KRW-BTC`, `KRW-ETH`만 허용한다.
- `auto_include_new_listing`: 신규 상장 자동 편입 금지.
- `exclude_warning`, `exclude_caution`: Upbit 시장경보 또는 주의 상태일 때 신규 진입 차단.

## Registry 구조

```json
{
  "registry": {
    "exchangeId": "upbit_krw_spot",
    "strategies": [
      {
        "id": "trend_following",
        "enabled": true,
        "ruleIds": [
          "universe_allowed",
          "market_warning_absent",
          "spread_ok",
          "depth_sufficient",
          "cost_margin_ok",
          "risk_ok",
          "stop_loss",
          "take_profit"
        ]
      }
    ]
  }
}
```

허용 exchange id:

- `upbit_krw_spot`

허용 strategy id:

- `trend_following`
- `mean_reversion`
- `volatility_breakout`
- `orderbook_imbalance_momentum`
- `liquidity_reversion`

허용 rule id:

- `universe_allowed`
- `market_warning_absent`
- `spread_ok`
- `depth_sufficient`
- `cost_margin_ok`
- `risk_ok`
- `stop_loss`
- `take_profit`

규칙:

- 존재하지 않는 exchange, strategy, rule id는 fail-fast한다.
- `registry`와 `strategies[]`의 알 수 없는 키는 오타로 간주해 fail-fast한다.
- `strategies[].enabled=false`인 strategy는 활성 resolution 결과에서 제외된다.
- `strategies[].ruleIds`는 비어 있으면 안 된다.
- 활성 strategy의 `ruleIds`는 `universe_allowed`, `market_warning_absent`, `spread_ok`, `depth_sufficient`, `cost_margin_ok`, `risk_ok` 차단 rule을 모두 포함해야 한다.
- 같은 strategy id를 중복 선언하면 안 된다.

## Strategy Parameters 구조

구현 기준:

- schema: `src/runtime/strategy-parameters.ts`
- 기본 profile: `config/paper.json`

`strategyParameters`는 strategy id별 threshold를 명시한다. 모든 금융 값은 Decimal로 파싱 가능한 string이어야 하며, JS number는 정밀도와 단위 혼동을 피하기 위해 거부한다. 알 수 없는 strategy id나 threshold key는 오타로 간주해 fail-fast한다.

```json
{
  "strategyParameters": {
    "trend_following": {
      "max_spread_bps": "8",
      "min_depth_krw": "50000000",
      "breakout_lookback_buckets": 20,
      "min_trade_strength": "1.2",
      "min_orderbook_imbalance": "0.08",
      "min_volatility_expansion_bps": "18"
    },
    "mean_reversion": {
      "max_spread_bps": "6",
      "min_depth_krw": "70000000",
      "entry_deviation_bps": "25",
      "exit_deviation_bps": "8",
      "stop_loss_bps": "35"
    },
    "volatility_breakout": {
      "max_spread_bps": "8",
      "min_depth_krw": "50000000",
      "breakout_lookback_buckets": 20,
      "min_volatility_expansion_bps": "18"
    },
    "orderbook_imbalance_momentum": {
      "max_spread_bps": "7",
      "min_depth_krw": "60000000",
      "min_trade_strength": "1.25",
      "min_orderbook_imbalance": "0.1"
    },
    "liquidity_reversion": {
      "max_spread_bps": "5",
      "min_depth_krw": "90000000",
      "entry_deviation_bps": "18",
      "stop_loss_bps": "30"
    }
  }
}
```

| strategy | threshold | 기본값 | 단위 | 보수적 조정 방향 |
| --- | --- | ---: | --- | --- |
| `trend_following` | `max_spread_bps` | `8` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `trend_following` | `min_depth_krw` | `50000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `trend_following` | `breakout_lookback_buckets` | `20` | feature bucket 수 | 높일수록 짧은 돌파 신호를 덜 신뢰 |
| `trend_following` | `min_trade_strength` | `1.2` | ratio | 높일수록 약한 체결강도 후보를 더 많이 차단 |
| `trend_following` | `min_orderbook_imbalance` | `0.08` | 0~1 ratio | 높일수록 약한 호가 불균형 후보를 더 많이 차단 |
| `trend_following` | `min_volatility_expansion_bps` | `18` | bps | 높일수록 변동성 확장이 약한 추세 후보를 더 많이 차단 |
| `mean_reversion` | `max_spread_bps` | `6` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `mean_reversion` | `min_depth_krw` | `70000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `mean_reversion` | `entry_deviation_bps` | `25` | bps | 높일수록 진입 신호를 더 드물게 허용 |
| `mean_reversion` | `exit_deviation_bps` | `8` | bps | 낮출수록 더 빨리 평균 복귀 청산 후보를 만든다 |
| `mean_reversion` | `stop_loss_bps` | `35` | bps | 낮출수록 손절 후보를 더 빨리 만든다 |
| `volatility_breakout` | `max_spread_bps` | `8` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `volatility_breakout` | `min_depth_krw` | `50000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `volatility_breakout` | `breakout_lookback_buckets` | `20` | feature bucket 수 | 높일수록 짧은 돌파 신호를 덜 신뢰 |
| `volatility_breakout` | `min_volatility_expansion_bps` | `18` | bps | 높일수록 약한 변동성 확장 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `max_spread_bps` | `7` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_depth_krw` | `60000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_trade_strength` | `1.25` | ratio | 높일수록 약한 체결강도 후보를 더 많이 차단 |
| `orderbook_imbalance_momentum` | `min_orderbook_imbalance` | `0.1` | 0~1 ratio | 높일수록 약한 호가 불균형 후보를 더 많이 차단 |
| `liquidity_reversion` | `max_spread_bps` | `5` | bps | 낮출수록 넓은 spread 후보를 더 많이 차단 |
| `liquidity_reversion` | `min_depth_krw` | `90000000` | KRW | 높일수록 유동성이 부족한 후보를 더 많이 차단 |
| `liquidity_reversion` | `entry_deviation_bps` | `18` | bps | 높일수록 진입 신호를 더 드물게 허용 |
| `liquidity_reversion` | `stop_loss_bps` | `30` | bps | 낮출수록 손절 후보를 더 빨리 만든다 |

M5 runtime integration 이후 `risk_ok` rule은 현재 `riskGateContext`로 RiskGate를 직접 평가한 결과만 실행 승인
근거로 사용한다. `riskGateContext`가 없거나 `RuleContext` 후보와 `riskGateContext.orderIntent`의
exchange/market/idempotency key, 수량, 명목 금액, 지정가, 예상 손실 입력이 다르면 fail-closed 처리하고, 금액 계열
문자열은 Decimal로 정규화해 DB numeric scale 차이를 제거한다. RiskGate가 `approved=true`를 반환할 때만
`risk_gate_approved` PASS가 된다. 후보 fingerprint가 없는 사전 계산 결과는 stale 승인 우회 위험이 있으므로 rule
context와 runtime persistence 입력으로 받지 않는다. M4 `risk_ok_placeholder`는 과거 rule chain 검증용 helper로만
남고, M5 기본 rule 조합은 `createDefaultM5Rules`와 `createRiskOkRule`을 사용한다.

## Risk 구조

구현 기준:

- schema: `src/runtime/risk-config.ts`
- domain contract: `src/domain/risk.ts`
- 기본 profile: `config/paper.json`

`risk.thresholds`는 M5 RiskGate evaluator가 사용할 계정 손실, 주문 크기, 포지션 노출, 연속 손실 기준이다. 모든 금융
비율 값은 bps 단위의 Decimal string이고, 연속 손실 횟수만 양의 정수다.

```json
{
  "risk": {
    "thresholds": {
      "daily_loss_limit_bps": "100",
      "weekly_loss_limit_bps": "300",
      "max_drawdown_bps": "500",
      "max_order_notional_bps_of_equity": "100",
      "max_expected_loss_bps_of_equity": "20",
      "btc_eth_max_position_bps_of_equity": "2000",
      "alt_max_position_bps_of_equity": "500",
      "total_alt_max_position_bps_of_equity": "1500",
      "max_consecutive_strategy_losses": 3
    }
  }
}
```

| threshold | 기본값 | 의미 |
| --- | ---: | --- |
| `daily_loss_limit_bps` | `100` | 일간 손실 -1% 도달 시 신규 주문 차단 |
| `weekly_loss_limit_bps` | `300` | 주간 손실 -3% 도달 시 신규 주문 차단 |
| `max_drawdown_bps` | `500` | MDD -5% 도달 시 신규 주문 차단 |
| `max_order_notional_bps_of_equity` | `100` | 1회 주문 금액을 계정 평가액 1%로 제한 |
| `max_expected_loss_bps_of_equity` | `20` | 1회 예상 손실을 계정 평가액 0.2%로 제한 |
| `btc_eth_max_position_bps_of_equity` | `2000` | BTC/ETH 단일 보유를 계정 평가액 20%로 제한 |
| `alt_max_position_bps_of_equity` | `500` | 단일 알트 보유를 계정 평가액 5%로 제한 |
| `total_alt_max_position_bps_of_equity` | `1500` | 전체 알트 보유를 계정 평가액 15%로 제한 |
| `max_consecutive_strategy_losses` | `3` | 동일 전략 연속 손실 3회에서 전략 중지 후보 |

M5 Sub PR 1은 위 기준을 load 가능한 config와 threshold snapshot contract로 고정했고, Sub PR 3은 실제
RiskGate evaluator를 구현했다. Sub PR 4는 `risk_ok` rule 연결과 `order_events`/`risk_events`/`audit_events`
append 계획을 연결한다. 증거 저장은 주문 상태 전이, kill switch 상태 전이, risk event, audit event를 combined event
store port로 묶어 후속 DB transaction/outbox 구현이 원자성을 보장할 수 있게 한다. `PAUSE_STRATEGY`는 해당 strategy
범위의 정지 계획으로 남기고 전역 kill switch로 승격하지 않는다. `HARD_STOP`은 pending paper order cancel action
plan을 감사 이벤트로 남기지만, 실제 broker cancel 호출과 open position 자동 청산은 M6 이후 별도 실행 경계에서만
다룬다. runtime persistence는 `correlationId`와 `riskGateContext.orderIntent.idempotencyKey`가 같아야 하며,
DB/현재 후보에서 읽은 주문 의도와 `riskGateContext.orderIntent`의 주문 금액/예상 손실 입력도 같아야 한다. 현재 kill
switch action plan이 신규 주문 또는 수동 검토를 요구하면 RiskGate snapshot이 깨끗해도 주문을 승인하지 않는다. 현재
주문 상태에서 RiskGate 승인/거부 상태로 전이할 수 없거나 strategy 손실 snapshot이 주문 strategy와 다르면 runtime은
별도 risk event를 남기고 fail-closed한다. kill switch 전이는 `kill_switch_state` durable snapshot에도 반영해
재시작 후 차단 상태를 복구한다.
strategy 연속 손실 초과는 일간 손실이나 kill switch 같은 더 강한 전역 차단이 함께 발생해도 strategy pause evidence로
함께 남긴다. `STRATEGY_PAUSED` kill switch 상태는 strategy 평가 중지만 표현하고 전역 신규 주문 차단으로 사용하지
않는다. PostgreSQL combined event store는 주문 전이, risk event, audit event를 하나의 transaction으로 저장한다.

## 변경 절차

설정 구조나 허용 id를 바꾸면 다음을 함께 확인한다.

1. `src/runtime/config.ts` 또는 `src/runtime/registry-config.ts`
2. `src/runtime/strategy-parameters.ts` 또는 `src/runtime/risk-config.ts`
3. `src/application/registry.ts`
4. `config/paper.json`
5. 관련 unit test
6. 이 문서와 기준 설계 문서

검증 명령:

```sh
corepack pnpm typecheck
corepack pnpm test
./scripts/verify
```
