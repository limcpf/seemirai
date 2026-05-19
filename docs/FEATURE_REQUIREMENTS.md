# 기능 요구사항

이 문서는 PRD를 구현 가능한 요구사항, acceptance criteria, 테스트 요구사항으로 분해한다. MVP 범위는 Upbit KRW 현물, paper trading, `KRW-BTC`/`KRW-ETH`, deterministic strategy variants, 비용 기반 동적 안전마진, 리스크 게이트, 가상 지정가 중심 실행, 이벤트 기반 백테스트다.

## 용어

| 용어 | 의미 |
| --- | --- |
| 비용 차감 후 기대값 | 예상수익률에서 진입/청산 수수료, 스프레드, 예상 슬리피지, 보유비용, 전송/환전 비용을 차감한 값 |
| 최소 안전마진 | 비용 차감 후 기대값이 거래 허용을 위해 초과해야 하는 기준값 |
| 메이커 주문 | 오더북에 유동성을 공급하는 지정가 주문 |
| 테이커 주문 | 기존 호가를 즉시 체결시켜 유동성을 제거하는 주문 |
| 리스크 게이트 | 주문 제출 전에 계정, 종목, 유동성, 손실, 장애 조건을 검증하는 차단 계층 |
| paper trading | 실거래 주문 없이 실시간 데이터와 동일한 정책으로 주문과 체결을 모의 기록하는 운영 모드 |
| kill switch | 신규 주문 중지, 미체결 주문 취소, 사람 확인 상태 전환을 수행하는 자동 정지장치 |

## 확정 MVP 결정

| 항목 | 결정 |
| --- | --- |
| 거래소 | Upbit KRW 현물 |
| 완료 기준 | paper trading |
| 1차 universe | `KRW-BTC`, `KRW-ETH` |
| 알트 편입 | phase 1.5에서 최대 3개 수동 편입 |
| 안전마진 | 비용 기반 동적 공식, BTC/ETH 10 bps, 상위 알트 20 bps |
| 리스크 | 일간 -1%, 주간 -3%, MDD -5%, 1회 주문 1%, 1회 손실 0.2%, 연속 손실 3회 중지 |
| 주문 | 신규 진입 시장가 금지, paper broker 기반 가상 지정가 |
| 저장소 | PostgreSQL + TimescaleDB, Redis/BullMQ MVP 제외 |
| LLM | 공식 Upbit 공지/정책/시장경보 리스크 분류만 허용 |
| 알림 | Telegram 우선, Slack adapter 비활성 |
| 보안 경계 | 출금, 송금, 거래소 간 차익거래, 선물, 레버리지, 타인계정 제외 |

상세 업무 명세는 `docs/product-specs/upbit-krw-paper-trading-mvp.md`를 기준으로 한다.

## 공통 요구사항

### FR-COMMON-001: 요구사항은 검증 가능한 형태여야 한다

설명:

- 모든 기능 요구사항은 acceptance criteria를 가져야 한다.
- acceptance criteria는 사람이 읽을 수 있고 가능하면 테스트나 명령으로 확인 가능해야 한다.
- 모호한 요구사항은 구현 범위에 넣지 않고 open question으로 남긴다.

Acceptance Criteria:

- [ ] 각 기능 항목에 완료 판정 조건이 있다.
- [ ] 테스트 또는 수동 검증 방법이 명시되어 있다.
- [ ] 제외 범위가 분명하다.

테스트 요구사항:

- 문서 리뷰에서 각 FR 항목에 `Acceptance Criteria`, `테스트 요구사항`, `문서 요구사항`, `제외 범위`가 있는지 확인한다.

문서 요구사항:

- 새 기능 범위가 생기면 `docs/PRD.md`와 이 문서를 함께 갱신한다.

제외 범위:

- acceptance criteria가 없는 아이디어를 구현 issue로 전환하지 않는다.

### FR-COMMON-002: 문서와 구현은 함께 갱신되어야 한다

설명:

- 기능 동작, 운영 규칙, 보안 경계, 신뢰성 기준이 바뀌면 관련 문서를 갱신한다.
- 새 문서를 추가하면 `docs/generated/context-map.json`과 인덱스를 함께 갱신한다.

Acceptance Criteria:

- [ ] 문서 라우터가 새 기준을 찾을 수 있다.
- [ ] `./scripts/verify docs`가 통과한다.

테스트 요구사항:

- `./scripts/verify docs`를 실행한다.

문서 요구사항:

- 문서 구조가 바뀌면 `docs/README.md` 또는 관련 인덱스를 갱신한다.

제외 범위:

- 생성 산출물이나 임시 작업 파일을 문서 라우팅 대상으로 등록하지 않는다.

## MVP 기능 요구사항

### FR-CONFIG-001: MVP 기본 설정은 안전한 paper trading 프로파일이어야 한다

설명:

- MVP 기본 설정은 Upbit KRW 현물 paper trading이다.
- 실거래, 출금, 거래소 간 차익거래, 선물은 설정상 비활성이어야 한다.

Acceptance Criteria:

- [ ] 기본 설정은 `exchange=UPBIT`, `market=KRW_SPOT`, `mode=PAPER_TRADING`이다.
- [ ] `live_trading_enabled=false`가 기본값이다.
- [ ] `withdrawal_enabled=false`가 기본값이다.
- [ ] `cross_exchange_arbitrage_enabled=false`가 기본값이다.
- [ ] `futures_enabled=false`가 기본값이다.
- [ ] 기본 설정으로 실행할 때 실거래 주문 API client가 생성되지 않거나 호출 불가능한 상태다.

테스트 요구사항:

- 단위 테스트: 기본 설정 로딩 결과가 안전 프로파일과 일치하는지 확인한다.
- 통합 테스트: 기본 설정에서 주문 API 호출 mock이 호출되지 않는지 확인한다.

문서 요구사항:

- 기본 설정 변경 시 `docs/product-specs/upbit-krw-paper-trading-mvp.md`를 갱신한다.

제외 범위:

- v0.2 pilot 실거래 설정은 MVP 기본 설정에 포함하지 않는다.

### FR-MKT-001: Upbit KRW 현물 어댑터는 정책을 설정 또는 API에서 읽어야 한다

설명:

- MVP 거래소는 Upbit KRW 현물로 확정한다.
- 실제 구현은 `UpbitKrwSpotAdapter`만 먼저 만든다.
- 어댑터는 마켓 목록, 수수료, 호가 단위, 최소 주문금액, rate limit, 주문 가능 상태를 주문 전 검증에 제공해야 한다.
- 정책 수치는 이벤트나 거래소 공지로 바뀔 수 있으므로 코드 상수로 고정하지 않는다.

Acceptance Criteria:

- [ ] 거래소별 정책 값은 설정 파일, DB, 또는 거래소 API 응답으로 주입된다.
- [ ] `get_markets`, `get_orderbook`, `stream_trades`, `stream_orderbook`, `get_order_chance`, `place_limit_order`, `cancel_order`, `get_order`, `get_balances` contract가 정의된다.
- [ ] MVP paper runtime에서 주문/취소/잔고 관련 메서드는 실제 Upbit 호출이 아니라 `PaperBroker`로 대체된다.
- [ ] 주문 생성 전 대상 마켓의 호가 단위와 최소 주문금액을 검증한다.
- [ ] 주문 생성 전 현재 적용 가능한 수수료 정책을 조회하거나 캐시된 정책의 유효성을 확인한다.
- [ ] REST와 WebSocket rate limit 기준이 요청 스케줄러에 전달된다.
- [ ] 지원하지 않는 마켓 또는 정책 조회 실패 시 신규 주문을 차단한다.

테스트 요구사항:

- 단위 테스트: 호가 단위 위반 주문, 최소 주문금액 미달 주문, 지원하지 않는 마켓 주문이 거부되는지 확인한다.
- 단위 테스트: rate limit 잔여량이 0인 경우 신규 REST 요청이 대기 또는 차단되는지 확인한다.
- 수동 테스트: 거래소 정책 fixture를 변경했을 때 주문 검증 결과가 함께 바뀌는지 확인한다.

문서 요구사항:

- Upbit 정책 필드가 바뀌면 `docs/product-specs/upbit-krw-paper-trading-mvp.md`와 이 문서를 갱신한다.

제외 범위:

- MVP에서 다중 거래소 주문 실행은 제외한다.
- 거래소 약관과 규제 해석 자동화는 제외한다.

### FR-DATA-001: 시장 데이터는 WebSocket 중심으로 수집해야 한다

설명:

- Upbit 체결, 호가, 티커는 WebSocket을 우선 사용한다.
- 마켓 목록과 정책 조회는 REST를 보조로 사용한다.
- 원천 이벤트와 정규화 이벤트를 분리해 저장한다.

Acceptance Criteria:

- [ ] 체결, 호가, 티커 이벤트가 원천 payload와 수신 시각을 포함해 저장된다.
- [ ] 정규화 이벤트는 거래소, 마켓, 이벤트 타입, exchange timestamp, local received timestamp를 가진다.
- [ ] WebSocket 지연, 단절, 재연결 이벤트가 별도 상태로 기록된다.
- [ ] REST 보조 조회는 rate limit 정책을 따른다.
- [ ] 데이터 지연이 기준을 넘으면 리스크 게이트에 신규 주문 차단 신호를 보낸다.
- [ ] `market_event.warning` 또는 `market_event.caution`이 감지되면 universe manager와 리스크 게이트에 차단 신호를 보낸다.

테스트 요구사항:

- 단위 테스트: 원천 이벤트를 정규화 이벤트로 변환하는 매핑을 검증한다.
- 통합 테스트: WebSocket 단절 fixture에서 재연결 상태와 신규 주문 차단 신호가 발생하는지 확인한다.
- 수동 테스트: 동일 이벤트가 중복 수신되어도 idempotency 기준으로 중복 처리되지 않는지 확인한다.

문서 요구사항:

- 거래소별 이벤트 필드 매핑 문서를 추가할 경우 `docs/generated/context-map.json` 또는 관련 인덱스를 갱신한다.

제외 범위:

- MVP에서 온체인, 소셜, 뉴스 원천 데이터의 자동 수집은 제외한다.

### FR-STORAGE-001: MVP 저장소는 PostgreSQL + TimescaleDB와 DB-backed queue를 기준으로 설계한다

설명:

- 주문, 체결, 잔고, 포지션, 리스크 이벤트, 알림, 정책 스냅샷은 PostgreSQL 일반 테이블에 저장한다.
- 체결, 캔들, 호가 스냅샷, 호가 지표, 전략 신호, PnL 스냅샷은 TimescaleDB hypertable 후보로 설계한다.
- Redis와 BullMQ는 MVP 필수 구성에서 제외한다.
- 비동기 작업은 PostgreSQL `jobs` table 기반 DB-backed queue로 처리한다.

Acceptance Criteria:

- [ ] `orders`, `order_events`, `fills`, `balances`, `positions`, `strategy_configs`, `risk_events`, `alerts`, `policy_snapshots` 저장 책임이 정의된다.
- [ ] `trades`, `candles`, `orderbook_snapshots`, `orderbook_metrics`, `strategy_signals`, `pnl_snapshots` 시계열 저장 책임이 정의된다.
- [ ] `jobs` table은 `idempotency_key`, `status`, `attempt_count`, `max_attempts`, `last_error`, `run_after`, `locked_at`, `locked_by`를 가진다.
- [ ] Redis와 BullMQ 없이 MVP runtime이 동작한다.
- [ ] ClickHouse는 MVP 구현 의존성에서 제외된다.

테스트 요구사항:

- 단위 테스트: `jobs` table 기반 queue가 중복 `idempotency_key`를 차단하는지 확인한다.
- 통합 테스트: `FOR UPDATE SKIP LOCKED` 기반 job claim이 중복 실행을 만들지 않는지 확인한다.
- 수동 테스트: 주문과 리스크 이벤트가 감사 로그 기준으로 조회되는지 확인한다.

문서 요구사항:

- 저장소 테이블 설계가 구체화되면 별도 설계 문서를 추가하고 인덱스를 갱신한다.

제외 범위:

- MVP에서 ClickHouse 운영, 다거래소 tick 원천 장기 저장은 제외한다.

### FR-TIME-001: UTC/KST 기준 시간을 명시적으로 처리해야 한다

설명:

- 거래소의 일별 데이터 계산 기준과 한국 운영 기준이 다를 수 있으므로 UTC와 KST를 모두 보존한다.
- 24시간 거래대금, UTC 0시 일봉, KST 09:00 리셋 여부를 피처로 사용할 수 있어야 한다.

Acceptance Criteria:

- [ ] 모든 이벤트는 UTC timestamp를 기본 저장 기준으로 가진다.
- [ ] 운영 리포트는 KST 표시를 지원한다.
- [ ] UTC 일봉 기준과 KST 리셋 기준이 혼동되지 않도록 피처 이름에 기준 시간을 포함한다.
- [ ] 백테스트와 paper trading이 같은 시간 기준 변환 함수를 사용한다.

테스트 요구사항:

- 단위 테스트: UTC 0시와 KST 09:00 변환 경계값을 검증한다.
- 단위 테스트: 일봉 집계와 24시간 거래대금 집계가 서로 다른 기준을 사용해도 필드명이 충돌하지 않는지 확인한다.

문서 요구사항:

- 거래소 확정 후 해당 거래소의 시간 기준 출처를 운영 문서에 링크한다.

제외 범위:

- 국가별 세무 신고용 기준 시간 계산은 MVP에서 제외한다.

### FR-COST-001: 비용 엔진은 주문 후보의 비용 차감 후 기대값을 계산해야 한다

설명:

- 모든 주문 후보는 예상수익률에서 비용 항목을 차감한 값을 가져야 한다.
- Upbit KRW 현물 MVP에서는 펀딩비와 출금/전송/환전 비용을 비활성화하지만 필드 자체는 보존한다.
- 고정 안전마진이 아니라 비용 기반 동적 안전마진을 적용한다.

Acceptance Criteria:

- [ ] 주문 후보는 예상수익률, 진입 수수료, 청산 수수료, 스프레드 p75, 예상 슬리피지 p95, 취소/재호가 패널티, safety buffer를 포함한다.
- [ ] `expected_return_bps >= cost_bps + safety_buffer_bps` 조건을 만족하지 못하면 주문 후보가 폐기된다.
- [ ] BTC/ETH safety buffer 기본값은 10 bps다.
- [ ] phase 1.5 상위 알트 safety buffer 기본값은 20 bps다.
- [ ] 저유동성 알트, 신규 상장, 유의/주의 종목은 비용 계산 전 거래 금지 상태로 처리된다.
- [ ] 폐기된 주문 후보는 폐기 사유와 차감 항목을 감사 로그에 남긴다.
- [ ] 실제 체결 후 수수료와 슬리피지를 예상값과 비교해 기록한다.
- [ ] 수수료 정책이 불명확하면 신규 주문을 차단한다.

테스트 요구사항:

- 단위 테스트: 비용 항목별 차감 계산을 검증한다.
- 단위 테스트: 최소 안전마진 이하 주문 후보가 주문 실행 단계로 넘어가지 않는지 확인한다.
- 속성 기반 테스트 후보: 비용 항목이 증가하면 비용 차감 후 기대값이 증가하지 않아야 한다.
- 수동 테스트: 체결 후 실제 비용과 예상 비용의 차이가 리포트에 표시되는지 확인한다.

문서 요구사항:

- safety buffer 또는 비용 공식이 바뀌면 업무 명세와 PRD 결정 기록을 갱신한다.

제외 범위:

- MVP에서 펀딩비 기반 전략의 실거래 비용 정산은 제외한다.

### FR-FEATURE-001: 피처 엔진은 유동성과 실행 품질 피처를 우선 생성해야 한다

설명:

- 방향 예측 피처보다 거래해도 되는 상태인지 판단하는 피처를 우선한다.
- MVP 피처는 호가 불균형, 체결강도, 거래대금 급증, 변동성 regime, 스프레드, 예상 슬리피지, UTC/KST 리셋을 포함한다.

Acceptance Criteria:

- [ ] 피처는 계산 시점, 입력 데이터 범위, 기준 시간을 가진다.
- [ ] 스프레드와 예상 슬리피지는 비용 엔진에서 사용할 수 있는 단위로 제공된다.
- [ ] 호가 깊이가 부족한 경우 저유동성 신호를 리스크 게이트에 전달한다.
- [ ] 피처 계산 실패 또는 입력 데이터 부족 시 주문 후보 생성을 중지한다.
- [ ] 피처 값은 백테스트와 paper trading에서 동일한 정의로 재사용된다.

테스트 요구사항:

- 단위 테스트: 고정 orderbook fixture에서 스프레드, 호가 불균형, 슬리피지 추정값을 검증한다.
- 단위 테스트: 입력 데이터 누락 시 피처 계산이 명시적 실패 상태를 반환하는지 확인한다.
- 회귀 테스트: 동일 fixture에 대해 백테스트와 paper trading 피처 값이 동일한지 확인한다.

문서 요구사항:

- 피처 정의가 바뀌면 기능 요구사항 또는 설계 문서를 갱신한다.

제외 범위:

- MVP에서 온체인, 소셜 감성, 뉴스 감성 피처는 자동 주문 피처로 사용하지 않는다.

### FR-STRATEGY-001: MVP 전략은 고유동성 현물 deterministic variants로 제한한다

설명:

- 전략은 주문을 직접 내지 않고 주문 후보만 생성한다.
- 주문 후보는 비용 엔진과 리스크 게이트를 통과해야 실행 엔진으로 전달된다.
- 1차 universe는 `KRW-BTC`, `KRW-ETH`로 제한한다.
- M4 기본 전략 id는 `trend_following`, `mean_reversion`, `volatility_breakout`, `orderbook_imbalance_momentum`, `liquidity_reversion`으로 제한한다.

Acceptance Criteria:

- [ ] 추세 추종 전략은 고유동성 종목, 낮은 스프레드, 변동성 증가, 호가 불균형, 고점 돌파, 비용 차감 후 기대값 조건을 입력으로 사용한다.
- [ ] 평균회귀 전략은 대형 코인, 낮은 스프레드, 충분한 호가 깊이, 명확한 손절폭, 공지 리스크 부재 조건을 입력으로 사용한다.
- [ ] 변동성 돌파 전략은 변동성 확장과 돌파 방향을 함께 확인한다.
- [ ] 호가 불균형 모멘텀 전략은 호가 불균형과 체결강도를 함께 확인한다.
- [ ] 유동성 회귀 전략은 충분한 depth와 낮은 spread 조건에서만 회귀 신호를 사용한다.
- [ ] 전략별 활성화 여부와 파라미터는 설정으로 제어된다.
- [ ] 전략은 LLM 출력만으로 주문 후보를 만들 수 없다.
- [ ] 전략 후보가 폐기되면 strategy id, reason code, cost snapshot, rule evaluation 결과가 가능한 범위에서 감사 로그에 기록된다.
- [ ] 신규 상장 자동 편입은 비활성이다.
- [ ] phase 1.5 알트는 상장 후 90일 이상, `warning=false`, `caution=false`, 스프레드 p95와 예상 슬리피지 기준 통과, 최대 3개 수동 승인 조건을 모두 만족해야 한다.

테스트 요구사항:

- 단위 테스트: 조건을 만족하지 않는 fixture에서 주문 후보가 생성되지 않는지 확인한다.
- 단위 테스트: LLM 분류 결과만 있는 경우 주문 후보가 생성되지 않는지 확인한다.
- 단위 테스트: 폐기된 주문 후보가 `AuditLogPort` fake 또는 audit repository에 append되는지 확인한다.
- 백테스트: 추세 추종과 평균회귀 전략을 같은 비용 모델로 평가한다.

문서 요구사항:

- 전략 조건의 숫자 기준이 바뀌면 업무 명세와 PRD 결정 기록을 갱신한다.

제외 범위:

- MVP에서 김치프리미엄 기반 실제 거래, 선물 펀딩비 전략, 레버리지 전략은 제외한다.

### FR-RISK-001: 리스크 엔진은 전략보다 먼저 주문 실행을 차단할 수 있어야 한다

설명:

- 리스크 엔진은 계정 전체, 종목, 전략, 유동성, 손실, 장애 상태를 기준으로 신규 주문을 승인하거나 거부한다.
- 장애 상황에서 자동 청산은 기본 동작이 아니다.
- M5 runtime에서는 `risk_ok` rule이 현재 주문 후보와 일치하는 RiskGate context를 직접 평가한 결과를 실행 승인 근거로
  사용한다. 후보 일치성은 exchange, market, strategy, side, order type, idempotency key, 수량, 명목 금액, 지정가,
  예상 손실 입력까지 포함하며, 거부 판단은 append-only `order_events`, `risk_events`, `audit_events`와 kill switch
  전이 증거에 원자적으로 기록된다.
- RiskGate runtime은 현재 주문 상태에서 RiskGate 승인/거부 상태로 전이할 수 없거나 strategy 손실 snapshot이 주문
  strategy와 다르면 승인하지 않고 fail-closed 리스크 이벤트를 남긴다.
- 허용된 주문 상태 전이는 DB의 현재 주문 상태가 event의 `fromState`와 같을 때만 현재 snapshot을 갱신하고, strategy
  pause는 더 강한 전역 차단 action이 함께 있어도 별도 evidence로 남긴다.

Acceptance Criteria:

- [ ] 일간 손실 -1% 기준을 넘으면 신규 주문을 차단한다.
- [ ] 주간 손실 -3% 기준을 넘으면 신규 주문을 차단한다.
- [ ] 전체 최대 낙폭 -5% 기준을 넘으면 신규 주문을 차단한다.
- [ ] 1회 주문 금액이 계정 평가액의 1%를 넘으면 신규 주문을 차단한다.
- [ ] 1회 거래 예상 손실이 계정 평가액의 0.2%를 넘으면 신규 주문을 차단한다.
- [ ] 단일 코인 비중 기준을 넘으면 해당 코인 신규 주문을 차단한다.
- [ ] 알트코인 전체 비중 기준을 넘으면 알트코인 신규 주문을 차단한다.
- [ ] 저유동성 코인은 신규 주문을 차단하거나 극소 한도만 허용한다.
- [ ] 동일 전략 연속 손실 3회 기준을 넘으면 전략 또는 계정 단위로 신규 주문을 중지한다.
- [ ] API 오류, WebSocket 지연, 시세 지연 상황에서는 신규 주문을 중지한다.
- [ ] 장애 상황에서 자동 청산 대신 사람 확인 상태로 전환한다.
- [ ] `market_event.warning` 또는 `market_event.caution` 종목은 신규 진입을 차단한다.

테스트 요구사항:

- 단위 테스트: 각 한도 위반 조건에서 주문이 거부되는지 확인한다.
- 단위 테스트: `risk_ok`가 RiskGate 승인 없이 PASS가 되지 않고, stale RiskGate 결과나 후보 불일치 RiskGate context를 재사용하지 않으며, 현재 kill switch 차단 상태에서 주문을 승인하지 않고, 전략 손실 정지가 전역 kill switch로 승격되지 않고, hard stop action plan이 open position 자동 청산을 만들지 않는지 확인한다.
- 통합 테스트: 데이터 지연 이벤트가 리스크 게이트의 신규 주문 차단으로 이어지는지 확인한다.
- 수동 테스트: kill switch 작동 시 신규 주문 중지, 미체결 주문 취소, 알림 발송 상태가 기록되는지 확인한다.

문서 요구사항:

- 손실 한도와 노출 한도 변경 시 업무 명세와 PRD 결정 기록을 갱신한다.

제외 범위:

- MVP에서 자동 청산 로직은 제외한다.
- 규제나 세무 기준을 자동 판단하지 않는다.

### FR-EXEC-001: 실행 엔진은 paper broker 기반 지정가, 부분체결, 취소, 재호가를 지원해야 한다

설명:

- 시장가 주문은 MVP 기본 실행 방식에서 제외한다.
- 실행 엔진은 주문 idempotency key를 사용해 중복 주문을 방지한다.
- MVP에서는 실거래 주문 API를 호출하지 않는다.

Acceptance Criteria:

- [ ] PaperBroker 주문 제출 전 비용 엔진과 리스크 게이트 승인 ID를 요구한다.
- [ ] 모든 주문은 idempotency key를 가진다.
- [ ] 지정가 주문 제출 후 제한 시간 동안 미체결이면 취소 또는 재호가 정책을 적용한다.
- [ ] 부분체결은 체결 수량, 잔량, 평균 체결가, 실제 수수료를 기록한다.
- [ ] 시장 급변 또는 데이터 지연 감지 시 미체결 주문을 취소할 수 있다.
- [ ] 주문 생성, 제출, 체결, 부분체결, 취소, 실패 이벤트가 감사 로그에 남는다.
- [ ] 신규 진입 시장가 주문은 생성할 수 없다.
- [ ] Emergency 축소는 paper trading에서 공격적 지정가와 IOC/FOK 정책으로만 검증한다.

테스트 요구사항:

- 단위 테스트: 같은 idempotency key의 중복 주문이 한 번만 제출되는지 확인한다.
- 통합 테스트: 부분체결 fixture에서 잔량과 평균 체결가가 올바르게 계산되는지 확인한다.
- 통합 테스트: 미체결 제한 시간 초과 시 취소 또는 재호가 이벤트가 발생하는지 확인한다.
- 통합 테스트: paper trading 모드에서 Upbit 주문 생성 API가 호출되지 않는지 확인한다.
- 수동 테스트: 시장가 주문 설정과 신규 진입 시장가가 기본 비활성 상태인지 확인한다.

문서 요구사항:

- 시장가 또는 실거래 예외를 허용하려면 v0.2 pilot 문서를 별도로 작성한다.

제외 범위:

- MVP에서 거래소 간 자금 이동, 자동 출금, 자동 환전은 제외한다.

### FR-BACKTEST-001: 백테스트는 이벤트 기반으로 비용과 체결 제약을 반영해야 한다

설명:

- 분봉 종가만 사용하는 백테스트는 MVP 완료 기준으로 인정하지 않는다.
- 백테스트는 수수료, bid/ask 스프레드, 호가 깊이 기반 슬리피지, 부분체결, 주문 취소 실패, 체결 지연, 최소 주문금액, 호가 단위, rate limit을 반영해야 한다.

Acceptance Criteria:

- [ ] 백테스트 입력은 시간순 이벤트 스트림으로 재생된다.
- [ ] 주문 후보는 실거래와 같은 비용 엔진과 리스크 게이트를 통과한다.
- [ ] 체결 시뮬레이션은 bid/ask와 호가 깊이를 사용한다.
- [ ] 부분체결, 미체결, 취소 실패, 체결 지연 시나리오를 표현할 수 있다.
- [ ] 수수료와 슬리피지를 차감한 손익을 전략별로 산출한다.
- [ ] label은 미래가격 변화에서 왕복수수료, 예상스프레드, 예상슬리피지를 차감한 값으로 만들 수 있다.

테스트 요구사항:

- 단위 테스트: 고정 이벤트 fixture에서 체결, 부분체결, 미체결 결과를 검증한다.
- 회귀 테스트: 비용을 0으로 둔 결과와 비용을 반영한 결과의 차이를 확인한다.
- 수동 테스트: 동일 전략을 분봉 종가 백테스트와 이벤트 기반 백테스트로 비교해 차이가 리포트되는지 확인한다.

문서 요구사항:

- 백테스트 엔진 설계가 구체화되면 설계 문서로 분리하고 라우팅 인덱스를 갱신한다.

제외 범위:

- MVP에서 선물 펀딩비 정산과 청산 가격 시뮬레이션은 제외한다.

### FR-PAPER-001: paper trading은 실시간 운영과 같은 게이트를 사용해야 한다

설명:

- paper trading은 실거래 전 운영 검증 단계다.
- 실시간 데이터, 비용 엔진, 리스크 게이트, 실행 정책을 실거래와 동일하게 사용하되 실제 주문은 제출하지 않는다.

Acceptance Criteria:

- [ ] paper trading 주문 후보는 실거래와 같은 비용 엔진과 리스크 게이트를 통과한다.
- [ ] 모의 주문은 주문 생성, 체결 가정, 취소, 재호가 이벤트를 기록한다.
- [ ] 모의 체결가는 당시 bid/ask와 호가 깊이에 근거한다.
- [ ] 실거래 전환 가능 여부를 판단할 수 있도록 수수료, 슬리피지, 체결률, 전략별 손익을 리포트한다.
- [ ] paper trading 모드에서는 거래소 주문 API가 호출되지 않는다.
- [ ] 기본 모드에서는 실거래 API Key가 없거나 주문 권한이 비활성인 상태로 실행된다.

테스트 요구사항:

- 통합 테스트: paper trading 모드에서 주문 API client가 호출되지 않는지 확인한다.
- 회귀 테스트: 동일 이벤트 fixture에서 백테스트와 paper trading의 주문 후보 생성 결과가 일관되는지 확인한다.
- 수동 테스트: 일간 리포트에 paper trading 성과가 표시되는지 확인한다.

문서 요구사항:

- 소액 실거래 전환 기준은 v0.2 pilot 문서에서 별도로 정의한다.

제외 범위:

- paper trading 결과만으로 실거래 전환을 자동 승인하지 않는다.

### FR-MONITOR-001: 모니터링은 비용과 실행 품질을 전략별로 분해해야 한다

설명:

- 운영자는 전략 수익률뿐 아니라 수수료 비중, 슬리피지, 체결률, 미체결 취소, 데이터 지연을 확인할 수 있어야 한다.

Acceptance Criteria:

- [ ] 실현손익, 미실현손익, 수수료, 슬리피지, 체결률이 전략별로 집계된다.
- [ ] 비용이 총 손익에서 차지하는 비중을 볼 수 있다.
- [ ] 데이터 지연, API 오류, rate limit 접근, WebSocket 재연결이 알림 후보 이벤트로 기록된다.
- [ ] 모델 drift 후보 지표를 기록할 수 있다.
- [ ] 일간 리포트는 거래 횟수, 폐기된 주문 후보, 차단 사유, 비용 비중을 포함한다.
- [ ] Telegram P0 알림은 신규 주문 중지 이벤트와 함께 기록된다.
- [ ] Slack adapter는 정의만 하고 MVP 기본 설정에서는 비활성이다.

테스트 요구사항:

- 단위 테스트: 거래 이벤트 fixture에서 전략별 집계값을 검증한다.
- 통합 테스트: API 오류 fixture에서 알림 후보 이벤트가 생성되는지 확인한다.
- 수동 테스트: 일간 리포트에 수수료 비중과 주문 차단 사유가 표시되는지 확인한다.

문서 요구사항:

- 알림 심각도나 채널 변경 시 업무 명세를 갱신한다.

제외 범위:

- MVP에서 고객용 투자 리포트나 유료 리포트 배포는 제외한다.

### FR-LLM-001: LLM은 직접 매매 판단에 사용하지 않는다

설명:

- LLM은 공식 Upbit 공지 요약, 개발자 changelog 요약, 시장경보 분류, 상장/상폐/점검 분류, 이상 이벤트 설명, 일간 리포트 초안에만 사용한다.
- LLM 출력은 주문 후보 생성이나 주문 제출로 직접 연결될 수 없다.

Acceptance Criteria:

- [ ] LLM 입력 소스는 `exchange_notice`, `developer_changelog`, `market_event`로 제한된다.
- [ ] LLM 결과 타입은 `notice_summary`, `notice_risk_classification`, `event_explanation`, `daily_report_draft` 같은 보조 목적에 한정된다.
- [ ] LLM `recommended_action`은 `NO_ACTION`, `BLOCK_NEW_ENTRY`, `CANCEL_PENDING`, `PAUSE_STRATEGY`, `ALERT_ONLY`만 허용한다.
- [ ] `BUY`, `SELL`, `INCREASE_POSITION` 같은 주문 허용 또는 포지션 확대 액션은 스키마 검증에서 거부된다.
- [ ] LLM 결과만으로 전략 주문 후보를 만들 수 없다.
- [ ] LLM 결과가 리스크 게이트에 전달될 경우 주문 허용이 아니라 차단 또는 사람 확인 신호로만 사용된다.
- [ ] LLM 입력과 출력은 감사 가능하도록 저장되며 민감정보를 포함하지 않는다.

테스트 요구사항:

- 단위 테스트: LLM 결과만 있는 경우 주문 후보가 생성되지 않는지 확인한다.
- 단위 테스트: LLM 리스크 분류가 주문 허용 신호로 변환되지 않는지 확인한다.
- 단위 테스트: 금지 액션이 포함된 LLM 출력이 거부되는지 확인한다.
- 수동 테스트: 공지 요약이 리포트에 포함되더라도 주문 실행 로그와 직접 연결되지 않는지 확인한다.

문서 요구사항:

- LLM 입력 소스가 확대되면 업무 명세와 PRD 비범위를 먼저 갱신한다.

제외 범위:

- MVP에서 LLM 기반 매수/매도 추천, 목표가 산정, 포지션 크기 결정을 제공하지 않는다.

### FR-SECURITY-001: API 키와 주문 권한은 최소 권한으로 운영해야 한다

설명:

- 자동매매 시스템은 API 키 유출과 과도한 권한이 직접 손실로 이어질 수 있다.
- MVP 기본 모드는 실거래 API Key 없이 실행한다.
- 정책 동기화나 pilot 검증에 API Key가 필요해도 출금 권한은 절대 포함하지 않는다.

Acceptance Criteria:

- [ ] secret 값은 저장소, 로그, 리포트, LLM 입력에 원문으로 남지 않는다.
- [ ] 실거래 API 키는 출금 권한을 갖지 않는다.
- [ ] paper trading 모드와 실거래 모드는 설정으로 명확히 분리된다.
- [ ] 실거래 활성화에는 명시적 설정과 운영자 확인이 필요하다.
- [ ] 주문 실패와 인증 실패는 민감정보 없이 기록된다.
- [ ] 출금, 송금, 거래소 간 차익거래, 해외 거래소 자동 연동, 선물, 레버리지, 타인 계정 연결, 신호 판매 경로가 MVP 코드 경로에 없다.

테스트 요구사항:

- 단위 테스트: 로그 redaction 함수가 API 키, secret, JWT 후보 문자열을 마스킹하는지 확인한다.
- 수동 테스트: paper trading 설정에서 실거래 주문 API가 호출되지 않는지 확인한다.
- 수동 테스트: 실거래 설정 파일 예시에 출금 권한이 필요하지 않다는 설명이 있는지 확인한다.

문서 요구사항:

- 보안 정책 변경 시 `docs/SECURITY.md`를 갱신한다.

제외 범위:

- 거래소 계정 생성, KYC, 법률 자문, 세무 신고 자동화는 제외한다.

## 결정 기록

| ID | 상태 | 구현 처리 |
| --- | --- | --- |
| OQ-001 | decided | `UpbitKrwSpotAdapter` 우선 구현 |
| OQ-002 | decided | MVP 완료 기준은 paper trading |
| OQ-003 | decided | 비용 기반 동적 안전마진과 종목군별 buffer 적용 |
| OQ-004 | decided | 보수적 손실·노출 한도 선적용 |
| OQ-005 | decided | `KRW-BTC`, `KRW-ETH` phase 1 universe 적용 |
| OQ-006 | decided | PostgreSQL + TimescaleDB, DB-backed queue 적용, Redis/BullMQ MVP 제외 |
| OQ-007 | decided | 시장가 기본 비활성, 신규 진입 시장가 금지 |
| OQ-008 | decided | LLM은 공식 Upbit 입력 기반 리스크 분류기로 제한 |
| OQ-009 | decided | Telegram 우선, Slack adapter 비활성 |
| OQ-010 | decided | 출금·송금·차익거래·타인계정·신호판매 제외 |

상세 업무 명세는 `docs/product-specs/upbit-krw-paper-trading-mvp.md`에 둔다.

## 문서 검증 요구사항

- 문서 변경 후 `./scripts/verify docs`를 실행한다.
- README, 아키텍처, PRD, 기능 요구사항의 링크가 유효한지 확인한다.
- 신규 product spec을 추가하거나 이동하면 `docs/product-specs/index.md`와 `docs/generated/context-map.json`을 함께 갱신한다.

## 참고 출처

- Kraken: [What makes crypto 24/7/365?](https://www.kraken.com/learn/what-makes-crypto-24-7-365)
- Upbit: [거래 데이터 기준 시간](https://support.upbit.com/hc/ko/articles/900006049666-%EA%B1%B0%EB%9E%98-%EB%8D%B0%EC%9D%B4%ED%84%B0-%EA%B8%B0%EC%A4%80-%EC%8B%9C%EA%B0%84%EC%9D%80-%EC%96%B8%EC%A0%9C%EC%9D%B8%EA%B0%80%EC%9A%94), [거래 수수료](https://support.upbit.com/hc/ko/articles/900006143046-%EA%B1%B0%EB%9E%98-%EC%88%98%EC%88%98%EB%A3%8C%EB%8A%94-%EC%96%BC%EB%A7%88%EC%9D%B8%EA%B0%80%EC%9A%94), [요청 수 제한](https://docs.upbit.com/kr/reference/rate-limits), [호가 모아보기](https://docs.upbit.com/kr/reference/websocket-orderbook)
- Binance: [Spot Trading Fee Rate](https://www.binance.com/en/fee/trading), [Futures Fee Structure](https://www.binance.com/en/support/faq/detail/360033544231), [Futures Funding Rates](https://www.binance.com/en/support/faq/detail/360033525031)
