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

### FR-COMMON-003: 사용자에게 보이는 문구는 행동 가능한 한국어여야 한다

설명:

- user-facing 문구는 운영자나 사용자가 즉시 판단할 수 있는 한국어를 우선한다.
- 내부 enum, 상태 machine code, reason code, fingerprint, idempotency key 같은 안정 식별자는 저장·추적·debug 경계에는 필요하지만, 사용자가 처음 보는 제목이나 핵심 본문에 그대로 노출하지 않는다.
- HTTP 응답, Telegram 알림, daily report, CLI 출력, status payload처럼 사람이 직접 읽는 표면은 상태, 원인, 영향, 필요 조치를 사용자 행동 언어로 먼저 설명하고 내부 식별자는 `추적 정보`, `details`, `debug`, `metadata` 같은 분리된 영역에 보존한다.
- 새 도메인 코드나 운영 reason code를 추가할 때는 해당 code가 사용자에게 어떤 말로 보일지 매핑을 함께 정의한다.

Acceptance Criteria:

- [ ] user-facing 제목과 첫 본문은 한국어 상태/원인/영향/필요 조치 중 필요한 정보를 포함한다.
- [ ] 내부 enum/code/reason code/fingerprint가 첫 화면의 주요 설명을 대체하지 않는다.
- [ ] 내부 식별자가 복구나 감사에 필요하면 추적 전용 영역에 분리해 남긴다.
- [ ] 새 user-facing formatter나 response shape에는 대표 케이스 테스트 또는 fixture가 있다.
- [ ] 문구 변경이 운영 판단이나 사용자 행동을 바꾸면 관련 PRD, 기능 요구사항, 런타임/신뢰성 문서 중 해당 기준 문서를 갱신한다.

테스트 요구사항:

- 단위 테스트: 새 formatter 또는 response mapper가 raw code만 반환하지 않고 사용자 문구와 추적 정보를 분리하는지 확인한다.
- 문서 리뷰: 새 도메인 code가 추가될 때 user-facing 매핑 누락이 없는지 확인한다.

문서 요구사항:

- 채널별 세부 문구 정책은 해당 기준 문서에 둔다. 예를 들어 Telegram 알림은 `docs/RUNTIME_CONFIG.md`와 `docs/RELIABILITY.md`의 alert delivery 기준을 따른다.
- 전역 규칙이 바뀌면 루트 `AGENTS.md`와 이 요구사항을 함께 갱신한다.

제외 범위:

- machine-to-machine API의 안정 contract, DB column 값, audit metadata, log field name은 user-facing 문구로 번역하지 않는다.
- 내부 식별자를 숨기기 위해 감사·복구에 필요한 추적 정보를 제거하지 않는다.

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
- [x] phase 1.5 상위 알트 safety buffer 기본값은 20 bps다.
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
- [x] phase 1.5 알트는 상장 후 90일 이상, `warning=false`, `caution=false`, 스프레드 p95와 예상 슬리피지 기준 통과, 최대 3개 수동 승인 조건을 모두 만족해야 한다.

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
  예상 손실 입력까지 포함하며 Decimal 정규화 후 비교한다. 거부 판단은 append-only `order_events`, `risk_events`,
  `audit_events`와 kill switch 전이 증거에 원자적으로 기록된다.
- RiskGate runtime은 현재 주문 상태에서 RiskGate 승인/거부 상태로 전이할 수 없거나 strategy 손실 snapshot이 주문
  strategy와 다르면 승인하지 않고 fail-closed 리스크 이벤트를 남긴다.
- 허용된 주문 상태 전이는 DB의 현재 주문 상태가 event의 `fromState`와 같을 때만 현재 snapshot을 갱신하고, strategy
  pause는 더 강한 전역 차단 action이 함께 있어도 별도 evidence로 남긴다.
- PostgreSQL runtime event store는 주문 전이, risk event, audit event, `kill_switch_state` durable snapshot을 하나의
  transaction으로 저장하며, `STRATEGY_PAUSED` kill switch 상태는 전역 신규 주문 차단으로 해석하지 않는다.

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
- [x] 24시간 paper soak 결과는 crash 0회, unhandled rejection 0회, 실거래 주문 API 0회, audit 누락 0건, stale data 신규 주문
  차단, DB write failure 0건, notification failure 0건, daily report 생성 여부를 summary로 남긴다.

테스트 요구사항:

- 통합 테스트: paper trading 모드에서 주문 API client가 호출되지 않는지 확인한다.
- smoke 테스트: `SEEMIRAI_RUN_SOAK=1`이 없는 기본 실행은 장시간 soak를 skip하고, fixture smoke는 stale data 차단과 live order
  API 0회 evidence를 검증한다.
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
- [ ] 일간 리포트는 KST 기준일과 UTC 조회 window를 함께 표시하고, realized PnL과 estimated/unrealized PnL을 분리한다.
- [ ] 일간 리포트는 값이 없는 체결 품질 metric을 0으로 꾸미지 않고 `unavailable`로 표시한다.
- [ ] 일간 리포트의 주문 상태별 집계는 현재 `orders.status`가 아니라 `order_events` 기준의 기준일 종료 시점 상태를 사용한다.
- [ ] 일간 리포트의 PnL은 snapshot이 있는 scope는 snapshot을 쓰고, snapshot이 없는 scope만 positions fallback을 사용한다.
- [ ] 일간 리포트의 체결 품질 평균은 `fills.filled_at`이 기준일에 속한 실제 체결 주문만 대상으로 한다.
- [ ] Telegram P0 알림은 신규 주문 중지 이벤트와 함께 기록된다.
- [ ] Slack adapter는 정의만 하고 MVP 기본 설정에서는 비활성이다.

테스트 요구사항:

- 단위 테스트: 거래 이벤트 fixture에서 전략별 집계값을 검증한다.
- 단위 테스트: P0 kill switch 알림은 신규 주문 차단 action plan과 같은 evidence로 전송되는지 확인한다.
- 통합 테스트: API 오류 fixture에서 알림 후보 이벤트가 생성되는지 확인한다.
- 수동 테스트: 일간 리포트에 수수료 비중과 주문 차단 사유가 표시되는지 확인한다.

문서 요구사항:

- 알림 심각도나 채널 변경 시 업무 명세를 갱신한다.

제외 범위:

- MVP에서 고객용 투자 리포트나 유료 리포트 배포는 제외한다.

### FR-OPS-001: Telegram inbound 명령은 기본 비활성과 owner allowlist를 기준으로 열어야 한다

설명:

- 운영자는 Telegram에서 현재 상태와 판단 이유를 조회하고 제한된 control 명령을 실행할 수 있어야 한다.
- M20 inbound transport는 `getUpdates` polling을 우선 사용하며 public webhook endpoint는 만들지 않는다.
- 조회 명령과 control 명령은 parser 단계에서 scope가 분리되어야 한다.
- control 명령은 인증, 확인 절차, idempotency, audit evidence를 통과한 뒤에만 durable control provider로 전달되어야 한다.

Acceptance Criteria:

- [ ] Telegram inbound는 기본 비활성이고, 명시 config/env 없이는 polling을 시작하지 않는다.
- [ ] 허용되지 않은 chat id/user id의 명령은 실행되지 않고 audit evidence만 남는다.
- [ ] `/status`, `/positions`, `/pnl`, `/why <market|cash>`, `/orders`, `/risk`는 read-only scope로 분류된다.
- [ ] read-only 명령은 주문 제출, 주문 취소, live broker 호출 같은 trading side effect를 만들지 않는다.
- [ ] `/pause`, `/resume`, `/kill`은 control scope로 분류된다.
- [ ] control 명령은 인증, durable dedupe, audit append, 동일 명령 2단계 확인을 통과한 경우에만 kill switch control provider로 전달된다.
- [ ] unknown/malformed command는 한국어 안내와 audit evidence로 수렴한다.
- [ ] 같은 Telegram update/message/command 재전달은 중복 control 실행을 만들지 않는다.
- [ ] Telegram token, raw provider body, raw update 원문, raw message text는 log/audit/status/응답에 저장되지 않는다.
- [ ] M20 완료 후에도 기본 `PAPER_NO_KEY` runtime에서 live order API 호출 0회가 유지된다.
- [ ] `/approve`, `/reject`, approval workflow, 승인된 주문의 live broker 제출 경로가 생성되지 않았음을 source scan으로 확인한다.

테스트 요구사항:

- 단위 테스트: inbound config 기본 비활성, enabled guard, parser, allowlist, dedupe, audit redaction을 검증한다.
- 단위 테스트: unauthorized/unknown/malformed command negative path가 handler dispatch 전에 닫히는지 확인한다.
- 통합 테스트: fake Telegram polling provider와 durable dedupe store를 사용해 같은 update가 한 번만 처리되는지 확인한다.
- 통합 테스트: fake polling batch에서 control confirmation, duplicate 차단, unauthorized audit-only, safe summary를 함께 검증한다.
- source scan: M20 diff에서 webhook public endpoint, `/approve`/`/reject`, live broker submit/cancel 신규 경로가 없는지 확인한다.

문서 요구사항:

- Telegram inbound guard, owner allowlist, raw provider payload 금지, dedupe 기준이 바뀌면 `docs/RUNTIME_CONFIG.md`,
  `docs/SECURITY.md`, `docs/RELIABILITY.md`를 함께 갱신한다.

제외 범위:

- M20에서는 `/approve`, `/reject`, 주문 승인 workflow, 승인된 주문의 live broker 제출, Telegram webhook public endpoint를 제외한다.

### FR-OPS-002: M21 live 주문은 Telegram 수동 승인 proposal만 제출되어야 한다

설명:

- 자동 주문 후보는 proposal로 만들 수 있지만, live broker 제출은 운영자가 Telegram에서 명시 승인한 proposal에만 허용한다.
- M21은 M22 무승인 자동매매 전 마지막 안전 단계이며, 승인 없는 live 주문 0건과 proposal부터 broker submission까지의 evidence
  chain을 기계적으로 증명해야 한다.
- 기본 runtime config는 비활성이며, M20 inbound와 최신 reconcile 상태가 준비되지 않으면 fail-closed 한다.

Acceptance Criteria:

- [x] M21 기본 config는 `live_manual_approval.enabled=false`이며 명시 설정 없이는 proposal 생성과 approval submission이 시작되지 않는다.
- [x] 기본 허용 market은 `KRW-BTC`, `KRW-ETH`, `KRW-ETC`이고 config로 축소/확장 후보를 조정할 수 있다.
- [x] 1회 주문 상한, 일일 승인 주문 예산, proposal TTL, price deviation guard가 config에서 조정 가능하다.
- [x] proposal 없이 `/approve`만으로 live order가 생성되지 않는다.
- [x] 승인되지 않은 proposal은 `UpbitLiveBroker.submitOrder`로 전달되지 않는다.
- [x] expired/rejected/submitted proposal 재승인은 broker 호출 전에 fail-closed 한다.
- [x] 같은 Telegram update/message/command 재전달은 중복 승인 또는 중복 주문을 만들지 않는다.
- [x] 승인 직후 제출 전에 risk gate, kill switch, reconcile status, budget, order type, market allowlist, price deviation을 재검증한다.
- [x] 제출 직전 주문 금액은 Upbit KRW 최소 주문금액 이상이어야 하며, 일일 승인 예산 사용액 snapshot은 음수가 아니어야 한다.
- [x] 같은 proposal 제출이 이미 broker 직전 reservation을 선점한 경우 추가 broker 호출 없이 진행 중인 제출 확인으로 안내한다.
- [x] M20 inbound readiness와 reconcile freshness는 필수 startup guard이며 config 값으로 비활성화할 수 없다.
- [x] 모든 제출 주문은 proposal, approval, risk decision, broker submission evidence를 가진다.
- [x] approval/reject audit에는 raw Telegram text, raw provider body, token, API key, JWT가 저장되지 않는다.
- [x] 기본 `PAPER_NO_KEY` runtime은 live order API 호출 0회를 유지한다.
- [x] M22 autonomous loop 또는 승인 없는 live order path가 없음을 source scan으로 확인한다.

테스트 요구사항:

- 단위 테스트: M21 config 기본 비활성, allowed market, 예산/TTL/price deviation guard를 검증한다.
- 단위 테스트: proposal fingerprint와 상태 전이가 stale/duplicate approval을 차단하는지 확인한다.
- 단위 테스트: approval/reject audit projection이 raw Telegram text와 secret-like metadata를 저장하지 않는지 확인한다.
- 통합 테스트: fake Telegram approval runtime에서 duplicate/expired/rejected/submitted proposal이 broker 호출 전에 닫히고, recheck
  통과 approval만 fake broker로 제출되는지 확인한다.
- source scan: `/approve`, `/reject`, `submitOrder(`, `POST /v1/orders`, `DELETE /v1/order`, `LIVE_AUTONOMOUS` 경로가 M21 범위와
  증거 chain 밖에서 열리지 않았는지 확인한다.

문서 요구사항:

- M21 guard, proposal/evidence contract, approval 보안 경계가 바뀌면 `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`,
  `docs/RELIABILITY.md`, `docs/product-specs/upbit-live-autonomous-trading.md`를 함께 갱신한다.

제외 범위:

- M22 무승인 자동 실거래, Telegram public webhook endpoint, 신규 진입 시장가, best order 기본 허용, 자동 budget 확대, 출금,
  입출금 자동화, 선물, 레버리지, 마진은 제외한다.

### FR-OPS-003: M22 제한적 완전 자동매매는 명시 arm, 소액 budget, 모든 safety gate를 통과한 주문만 제출해야 한다

설명:

- M22는 `LIVE_AUTONOMOUS_SMALL_BUDGET` runtime에서 운영자가 명시적으로 arm 한 소액 예산 안에서만 자동 entry와 exit를 허용한다.
- 목표는 수익 보장이 아니라 24시간 live autonomous pilot에서 crash, unhandled rejection, risk gate 우회 주문, reconcile mismatch가
  0건임을 기계적으로 증명하는 것이다.
- 기본 `PAPER_NO_KEY` runtime은 M22 구현 후에도 live order API 호출 0회를 유지해야 한다.

Acceptance Criteria:

- [x] M22 기본 config는 `live_autonomous.enabled=false`이며 명시 설정 없이는 private client, live broker, autonomous loop가 시작되지 않는다.
- [x] M21 1주 gate evidence, operator arm evidence, budget evidence, key scope evidence 없이는 autonomous runtime이 fail-closed 한다.
- [x] M20 inbound readiness, M16 reconcile freshness, M17 PnL status, M18 decision ledger, M19 exit engine readiness가 startup guard로 확인된다.
- [x] 첫 활성 market 기본값은 `KRW-BTC` 단일이고, 첫 예산 기본값은 1회 `10000` KRW, 일일 `30000` KRW다.
- [x] Upbit identifier/idempotency key는 현재 32자 보수 제한을 유지하고, 권장 랜덤 생성 패턴은 32자를 넘지 않는다.
- [x] 자동 entry는 `LIMIT + post_only`만 허용하고 시장가/최유리 주문은 거래소 호출 전 fail-closed 한다.
- [x] `post_only + smp_type` 조합은 거래소 호출 전 fail-closed 한다.
- [x] 제출 직전 risk gate, kill switch, reconcile freshness, budget, market allowlist, order type, price deviation, Upbit KRW 최소 주문금액을 재검증한다.
- [x] 같은 idempotency key 또는 같은 order attempt 재시도는 중복 live order를 만들지 않는다.
- [x] 모든 제출 주문은 strategy decision, cost decision, risk decision, kill switch/reconcile/budget evidence, broker submission evidence를 가진다.
- [x] broker submit 예외 또는 불확실 결과는 duplicate 재시도 없이 reconcile/manual review로 수렴한다.
- [x] reconcile mismatch, duplicate order, untracked fill, persistence failure는 신규 주문 중지와 manual review evidence로 수렴한다.
- [x] M19 exit engine 기반 자동 매도/축소가 live position scope와 risk gate를 초과하지 않는다.
- [x] Telegram/status/report는 M22 상태와 필요한 조치를 한국어로 보여주고 secret/raw provider payload를 노출하지 않는다.
- [x] 24시간 live autonomous pilot에서 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건을 증명한다.
- [x] source scan으로 시장가/best 주문, 출금/입출금, 승인 없는 기존 submit path, raw secret 노출 경로가 열리지 않았음을 확인한다.

24시간 live autonomous pilot은 저장소 밖 운영 env/evidence를 주입한 2026-06-10T23:30Z run에서 통과했다. 해당 run은 주문 후보 없는
heartbeat-only pilot이며 crash, unhandled rejection, risk gate 우회 주문, reconcile mismatch, duplicate order, untracked fill이 모두
0건이었다. 이후 2026-06-12T04:11Z dry-run candidate canary에서 `brokerSubmissionCount=1`, `orderSubmittedCount=1`,
`DRY_RUN_SUBMITTED`를 확인했다. 2026-06-12T04:33Z 실제 live canary에서는 `--cancel-after-submit`으로 10,000 KRW post-only 주문
제출 후 같은 uuid/identifier 취소를 요청했고, 2번째 조회에서 terminal `cancel` 상태와 open notional 0을 확인했다.

테스트 요구사항:

- 단위 테스트: M22 config 기본 비활성, KRW-BTC 단일 기본값, 예산 상한, readiness guard opt-out 차단, 32자 identifier 제한을 검증한다.
- 단위 테스트: M21 1주 gate, operator arm, budget, key scope, M20/M16/M17/M18/M19 readiness 누락이 private client 조립 전에 닫히는지 확인한다.
- 단위 테스트: autonomous order attempt 상태 전이, durable reservation, idempotency key 중복 차단, broker 불확실 결과 정규화를 검증한다.
- 통합 테스트: fake broker와 fake status providers로 cost/risk/reconcile/budget/order type 재검증을 통과한 주문만 제출되는지 확인한다.
- 통합 테스트: M19 exit engine이 live position scope를 초과하지 않고 partial fill, cancel/requote 실패, reconcile mismatch를 manual review로 수렴시키는지 확인한다.
- source scan: `POST /v1/orders`, `DELETE /v1/order`, `submitOrder(`, `cancelOrder(`, `ord_type.*market`, `ord_type.*best`,
  `withdraw`, `입금`, `출금`, secret/raw payload 후보가 M22 guard 밖에서 열리지 않았는지 확인한다.
- local file preparer: `scripts/prepare-m22-live-autonomous-local-files.mjs`는 저장소 밖에 env/key/config/evidence/wrapper 파일을 만들고,
  기존 secret 파일을 기본적으로 덮어쓰지 않으며, 저장소 내부 생성은 명시 override 없이는 차단한다.
- daemon: `scripts/run-m22-live-autonomous-daemon.mjs`는 candidate JSONL이 비어 있으면 주문 없이 heartbeat/daily report evidence만 남기고,
  후보가 있으면 `KRW-BTC`, `BUY`, `LIMIT + post_only`, 1회 `10000` KRW, 일일/open `30000` KRW, key scope/readiness/evidence
  guard를 통과한 경우에만 Upbit 주문 제출 경계로 전진한다. live canary에서는 `--cancel-after-submit`을 사용해 제출 직후 같은
  uuid/identifier로 취소 요청과 terminal cancel 확인 event를 남긴다.
- gated pilot: `scripts/run-m22-live-autonomous-pilot.mjs`는 명시 env guard와 redacted evidence가 있을 때만 운영자가 지정한 live
  autonomous command를 실행하고, 실행하지 못하면 guard skip 또는 preflight failure artifact와 운영 blocker를 기록한다.

문서 요구사항:

- M22 guard, order attempt/evidence contract, Telegram/status/report safe summary, source scan, pilot 결과가 바뀌면
  `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, `docs/product-specs/upbit-live-autonomous-trading.md`,
  active/completed exec plan을 함께 갱신한다.

제외 범위:

- M23 7일 운영 안정화, M24 strategy/universe/budget 확대, BTC 외 다중 market 기본 활성화, 자동 budget 확대, 시장가/최유리 주문 기본 허용,
  hard stop 자동 시장가 청산, Telegram public webhook endpoint, 출금/입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매,
  LLM 직접 매수/매도 판단은 제외한다.

### FR-OPS-004: M23 24/7 live small-budget 운영은 live-armed 상태와 실시간 가시성을 증명해야 한다

설명:

- M23은 `LIVE_AUTONOMOUS_SMALL_BUDGET`를 dry-run이나 heartbeat-only가 아니라 실제 주문 API를 호출할 수 있는 live-armed 상태로 24/7 운영 가능하게 만드는 단계다.
- 완료 기준은 수익 검증이 아니라 운영자가 Telegram, CLI, status, report에서 현재 runtime이 살아 있는지, dry-run인지 live인지, 주문 가능한 상태인지, 최근 왜 주문했거나 하지 않았는지, 주문/취소/체결/차단이 있었는지를 secret 없이 확인할 수 있는지다.
- 7일 안정화는 실제 주문 가능 설정으로 arm 한 상태에서 수행한다. 시장 조건이 gate를 통과하지 않아 주문이 없어도 되지만, 후보 없음, gate 차단, 시장 조건 미충족 같은 이유가 decision evidence와 daily report에 남아야 한다.
- M24 전략 확장, universe 확대, budget 확대는 M23 closeout PASS 이후 별도 issue로 진행한다.

Acceptance Criteria:

- [ ] 운영자가 현재 runtime이 실제 주문 가능 `LIVE_AUTONOMOUS_SMALL_BUDGET` 상태인지 dry-run 또는 heartbeat-only 상태인지 즉시 확인할 수 있다.
- [ ] status 표면은 live enabled, key scope, readiness, latest reconcile, latest heartbeat, latest candidate, latest decision, latest order attempt, latest fill/cancel, budget used, open exposure, risk block, alert retry 상태를 secret 없이 보여준다.
- [ ] Telegram 또는 CLI에서 "지금 돌고 있는가 / 매매 가능한가 / 최근 왜 주문했거나 안 했는가 / 현재 포지션과 현금은 어떤가"를 확인할 수 있다.
- [ ] Telegram 연결 성공 알림과 실제 주문 가능 상태 시작 알림은 분리되어 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여준다.
- [ ] 정상 종료, operator stop, kill switch, manual review, crash/restart 감지, Telegram 장애 지속은 종료/중지/주의 알림과 audit evidence로 남는다.
- [ ] 주문 제출, 취소 요청, 취소 확인, 체결, 부분체결, risk/cost/reconcile 차단 이벤트는 운영자가 현재 매매 상태를 이해할 수 있게 요약된다.
- [ ] Telegram 알림 실패는 P0/P1 retry evidence와 manual review 수렴 상태로 남긴다.
- [ ] 7일 운영 runbook은 실제 매매 가능 상태 arm 절차, 사전 점검, 중지/kill switch, restart 복구, daily artifact 확인, 수동 점검 절차를 포함한다.
- [ ] M23 7일 closeout은 dry-run이 아니라 live order API를 호출할 수 있는 설정으로 실행한 redacted evidence를 요구한다.
- [ ] 실제 주문이 없었던 날도 후보 없음, gate 차단, 시장 조건 미충족, operator stop, kill switch 같은 이유가 daily report와 decision evidence에 남는다.
- [ ] 7일 연속 live small-budget daily report가 생성된다.
- [ ] process 재시작 후 reconcile과 status가 정상 복구된다.
- [ ] DB backup/restore smoke drill이 disposable restore DB에서 통과하거나, 실행 불가 시 blocker와 필요한 외부 조건이 closeout에 기록된다.
- [ ] Upbit 장애, 점검, market warning, stale data, API 오류는 신규 entry fail-closed와 alert/manual review evidence를 남긴다.
- [ ] 7일 동안 crash 0회, unhandled rejection 0회, risk gate 우회 주문 0건, reconcile mismatch 0건, duplicate order 0건, untracked fill 0건, live order cleanup failure 0건을 증명한다.
- [ ] live canary 1회 성공, dry-run, heartbeat-only만으로 M23 완료를 선언하지 않는다.

테스트 요구사항:

- 단위 테스트: live ops safe summary가 mode, live armed/order capable, readiness, latest heartbeat/reconcile/decision/order, budget/exposure, alert retry를 secret 없이 반환하는지 확인한다.
- 단위 테스트: user-facing formatter가 내부 enum/code만 노출하지 않고 한국어 상태, 원인, 영향, 필요 조치를 먼저 보여주며 내부 식별자는 `추적 정보`로 분리하는지 확인한다.
- 단위 테스트: Telegram lifecycle/trade event mapper가 연결 성공, live order capable start, stop/manual review/crash/restart, 주문/취소/체결/차단 이벤트를 안전한 알림 payload로 낮추는지 확인한다.
- 통합 테스트: restart 후 기존 order attempt/reconcile/status를 읽어 duplicate live order 없이 복구되는지 확인한다.
- smoke/drill: `scripts/run-m23-recovery-drill.mjs --fixture-smoke`로 validator contract를 검증하고, 운영 closeout 전에는 restart 전후
  redacted event log와 DB backup/restore 결과 또는 blocker evidence로 같은 validator를 실행한다.
- smoke/drill: `scripts/run-m23-stability-closeout.mjs --fixture-smoke`로 7일 closeout manifest contract를 검증하고, 운영 closeout 전에는
  7개 이상 24시간 segment summary, recovery drill summary, DB backup/restore 결과 또는 blocker, source scan evidence를 같은
  validator로 집계한다.
- smoke/drill: DB backup/restore를 disposable restore DB에서 실행하거나, 외부 DB 조건 미충족 시 blocker evidence를 남긴다.
- source scan: live order API, market/best order, 출금/입금, raw secret 노출 후보가 M23 guard 밖에서 열리지 않았는지 확인한다.
- gated 운영 검증: 저장소 밖 env/key/config/evidence가 준비된 환경에서 24시간 post-cleanup preflight와 7일 live-armed stability artifact를 생성한다.

문서 요구사항:

- M23 guard, live ops status, lifecycle alert, restart/recovery drill, 7일 closeout 기준이 바뀌면 `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`, `docs/product-specs/upbit-live-autonomous-trading.md`, `docs/runbooks/m23-live-small-budget-operations.md`, active/completed exec plan을 함께 갱신한다.
- M23 전용 runbook을 추가하거나 이동하면 `docs/README.md`, `docs/runbooks/README.md`, `docs/generated/context-map.json`을 함께 갱신한다.

제외 범위:

- M24 전략 확장과 예산 확대, BTC 외 market 기본 활성화, 자동 budget 확대.
- 신규 진입 시장가, 시장가 매도, 최유리 주문 기본 허용.
- hard stop 시 open position 자동 시장가 청산.
- Telegram public webhook endpoint.
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매.
- LLM 직접 매수/매도 판단.
- secret 원문을 issue, PR, log, artifact에 기록하는 작업.
- 기본 `PAPER_NO_KEY` runtime의 실거래 profile 승격.

### FR-OPS-005: Live Ops 원클릭 앱은 production 운영 경로와 TUI 필수 콘솔을 분리해 제공해야 한다

설명:

- Issue #196 production live ops는 M22/M23 pilot runner를 대체하는 운영 주경로다.
- 운영자는 저장소 루트에서 `corepack pnpm live:ops -- --config <운영-json-path> --env-file <운영-env-path> --tui` 한 줄로 boot
  sequence와 foreground TUI를 시작할 수 있어야 한다.
- JSON config는 secret이 아닌 운영 정책만 담고, env file은 DB/Upbit/Telegram/TUI credential만 담는다.
- production path는 `SEEMIRAI_RUN_M22_AUTONOMOUS_*`, `SEEMIRAI_RUN_UPBIT_*_SMOKE`, `SEEMIRAI_PILOT_PROFILE`,
  `SEEMIRAI_M22_*_READY` 같은 milestone/test env를 readiness로 사용하지 않는다.
- TUI는 이 issue의 1차 백오피스이며 Web UI나 HTTP dashboard만으로 완료를 대체할 수 없다.

Acceptance Criteria:

- [x] `package.json`에 `live:ops`와 `live:ops:tui` 실행 script skeleton이 있다.
- [x] `LiveOpsConfig` 또는 동등 schema가 production live ops JSON 정책과 secret env를 분리한다.
- [x] safe fixture env/config는 provider 호출 없이 contract 검증을 통과한다.
- [x] legacy milestone env가 production live ops 실행 환경에 있으면 fail-closed 한다.
- [x] secret-like key가 JSON config에 들어오면 validation이 실패한다.
- [x] `PAPER_NO_KEY` raw code는 production user-facing 첫 화면 문구로 노출되지 않는다.
- [x] DB/migration readiness는 env boolean이 아니라 schema와 migration state로 계산된다.
- [x] foreground TUI 첫 화면은 운영 dashboard이며 secret 원문과 raw provider payload를 노출하지 않는다.
- [x] market data, analysis/decision, live execution, reconcile/PnL/status, Telegram, TUI가 같은 lifecycle 안에서 시작된다.
- [x] 조건 통과 시 manual JSONL 없이 strategy/cost/risk/decision 결과가 live autonomous execution adapter로 연결된다.
- [x] production package script는 `corepack pnpm build` 후 `dist/runtime/*-cli.js`를 실행한다.
- [x] Live Ops foreground/TUI app core와 runtime adapter orchestration은 TypeScript typecheck 대상이다.
- [x] `scripts/run-live-ops-support.mjs`는 production dist app core가 호출하는 side-effect port와 compatibility shim으로 남는다.

테스트 요구사항:

- build contract: `corepack pnpm build`가 `dist/runtime/live-ops-cli.js`, `dist/runtime/live-ops-tui-cli.js`,
  `dist/runtime/live-ops-pnl-closeout-cli.js`를 생성해야 한다.
- 단위 테스트: production live ops config schema, secret env loader, legacy env detector, user-facing mode formatter를 검증한다.
- 단위 테스트: TypeScript app core가 boot lifecycle 순서와 CLI/TUI mode별 output contract를 보존하는지 검증한다.
- 단위 테스트: TypeScript runtime adapter가 config/env/provider/readiness/market data/decision/execution/reconcile/PnL/status/Telegram/TUI 입력을
  support shim의 side-effect port와 같은 의미로 조립하는지 검증한다.
- 단위 테스트: production live ops DB readiness가 `schema_migrations` 최신 version, pending migration, missing table, checksum drift,
  DB connection failure를 secret 없이 분류하는지 검증한다.
- 단위 테스트: production live ops market data collector가 KRW-BTC event만 DB-backed store 경계로 저장하고, stale/reconnect/disconnect를
  신규 주문 차단 summary로 분류하는지 검증한다.
- 단위 테스트: production live ops analysis/decision pipeline이 market data 미준비, feature 실패, HOLD, order intent 생성을
  secret-safe summary로 분류하는지 검증한다.
- 단위 테스트: production live ops live execution adapter가 HOLD/analysis 차단/위험한 후보에서는 broker runtime 호출 0회를 유지하고,
  단일 `LIMIT + post-only` 후보만 live autonomous entry runtime 요청으로 변환하는지 검증한다.
- 단위 테스트: production live ops Telegram alert mapper가 startup, live order capable, 주문 제출, 차단/manual review event를
  `LiveOpsAlertInput`과 dispatch request로 낮추고 fake notifier dispatch 결과를 secret 없이 요약하는지 검증한다.
- 단위 테스트: production live ops script/runtime source scan이 direct Upbit order API, raw Authorization/Bearer header, direct Telegram
  provider 호출을 만들지 않는지 검증한다.
- script smoke: `corepack pnpm live:ops -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --tui`
  가 provider 호출 없이 TUI 운영 dashboard를 출력해야 한다.
- script smoke: `corepack pnpm live:ops:tui -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --attach fixture`
  가 attach 대상에 같은 TUI 운영 dashboard를 출력해야 한다.
- 후속 provider arm 범위에서는 fake Upbit integration evidence를 별도 issue/PR에서 추가한다.

문서 요구사항:

- config/env contract가 바뀌면 `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`,
  `docs/product-specs/upbit-live-autonomous-trading.md`, active exec plan을 함께 갱신한다.
- production live ops runbook을 추가하면 `docs/README.md`, `docs/runbooks/README.md`, `docs/generated/context-map.json`을 갱신한다.

제외 범위:

- Web 백오피스, hosted dashboard, multi-user RBAC, 모바일 앱.
- BTC 외 market 기본 활성화, 자동 budget 확대, M24 scaled 운영.
- 신규 진입 시장가, 시장가 매도, best order 기본 허용, hard stop open position 자동 시장가 청산.
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매.

### FR-OPS-006: Live Ops production 경로는 실제 주문 가능한 provider arm과 cleanup evidence로 닫혀야 한다

설명:

- Issue #206은 #196에서 만든 production `live:ops`/TUI 경로를 실제 DB, 실제 Upbit public/private API, 실제 Telegram과 같은
  lifecycle로 조립하는 단계다.
- 완료 상태는 fixture smoke, heartbeat-only, dashboard readiness, 가짜 provider summary가 아니라 실제 `KRW-BTC` 소액 주문
  submit/cancel terminal evidence다.
- production path는 조건을 통과한 단일 `BUY + LIMIT + post_only` 후보만 `LiveAutonomousEntryRuntime`과 `UpbitLiveBroker` 경계로
  전진시킨다.
- 주문이 없거나 차단되는 날도 후보 없음, market data stale, cost/risk/reconcile/budget/kill switch 차단 이유가 DB/TUI/Telegram/status에
  secret 없이 남아야 한다.

Acceptance Criteria:

- [ ] `live:ops` 운영 실행이 실제 DB와 실제 Upbit/Telegram provider lifecycle을 시작한다.
- [ ] 운영 실행에서 fixture provider summary나 주문 없는 dashboard 출력만으로 ready를 표시하지 않는다.
- [ ] Upbit public market data가 DB에 지속 적재되고 TUI에 freshness가 표시된다.
- [ ] decision pipeline이 실제 market frame을 읽고 HOLD 또는 order intent evidence를 남긴다.
- [ ] production `analysis.decision_policy`는 정적 allowlist policy id만 허용하고, `cleanup_probe` policy가 검증된 strategy 구현체로
  조립된다.
- [ ] order intent가 조건을 통과하면 `LiveAutonomousEntryRuntime`을 거쳐 `UpbitLiveBroker.submitOrder` 경계까지 도달한다.
- [ ] `BUY + LIMIT + post_only` 외 주문은 provider 호출 전에 fail-closed 된다.
- [ ] 같은 order attempt/idempotency key 재시작은 duplicate live order를 만들지 않는다.
- [ ] broker submit 불확실 결과는 재주문이 아니라 reconcile/manual review로 수렴한다.
- [ ] private read reconcile이 account/order/balance 상태를 읽고 status/TUI/Telegram에 secret 없이 표시한다.
- [ ] clean-start DB에 완료된 reconcile run이 없으면 production `live:ops`가 계정 전체 미체결 주문과 actual private read 결과를
  `LIVE_OPS_PRIVATE_READ_PREFLIGHT` DB evidence로 저장하고, 기존 mismatch/manual review 상태는 덮어쓰지 않는다.
- [ ] PnL snapshot이 없거나 stale이면 production `live:ops`가 fresh clean reconcile/balance source로
  `live_ops_cleanup_probe` `CALCULATED` PnL snapshot을 append-only 생성하고 다시 읽는다. PARTIAL/manual-review/status 미완료 PnL row,
  open order, mismatch, stale reconcile, position/reference price 결측은 새 0원 snapshot으로 덮지 않고 broker 제출 전 fail-closed 한다.
- [ ] 기존 clean reconcile 뒤 현재 private read에서 계정 전체 미체결 주문이 발견되면 가격 또는 원 주문 수량이 없는 주문까지
  `remaining_volume` 기반 manual-review evidence로 저장하고 신규 cleanup 주문을 차단한다.
- [ ] submitted/cancel_requested 상태의 open order는 현재 live execution identity와 일치하는 1건만 tracked로 인정하며, preflight
  manual-review 차단은 노출 금액과 Telegram owner alert를 보존한다.
- [ ] Telegram startup/live order capable/order submitted/cancel confirmed/manual review 알림이 실제 owner chat으로 전송된다.
- [ ] TUI가 실제 live armed/order capable 상태와 주문/취소/차단 상태, preflight/reconcile 차단 사유를 secret 없이 보여준다.
- [ ] 실제 KRW-BTC 소액 실거래 cleanup run이 `submit -> cancel requested -> terminal cancel 확인 -> open exposure 0`으로 닫힌다.
- [ ] crash 0회, unhandled rejection 0회, duplicate order 0건, reconcile mismatch 0건, untracked fill 0건, live order cleanup failure 0건을
  증명한다.
- [ ] dry-run, heartbeat-only, fixture-only, 주문 없는 dashboard 출력만으로 완료 선언하지 않는다.

테스트 요구사항:

- 단위 테스트: production boot sequence가 실제 provider arm에서 config/env validation, DB readiness, public market data, private probe,
  Telegram startup, reconcile/PnL/status readiness, decision, live execution 순서를 지키는지 확인한다.
- 단위 테스트: decision policy resolver가 임의 code path 없이 `cleanup_probe`를 정적 strategy로 조립하고, 최신 orderbook에서 단일
  `BUY + LIMIT + POST_ONLY` order intent 또는 HOLD/BLOCK evidence를 만든다.
- 단위 테스트: 단일 `BUY + LIMIT + post_only` 후보만 live autonomous runtime으로 전달되고 나머지 주문 유형은 fail-closed 되는지 확인한다.
- 통합 테스트: fake Upbit public/private provider와 fake Telegram dispatch로 submit/cancel/reconcile summary contract를 검증한다.
- script smoke: fixture smoke는 외부 DB/provider 호출 0회를 유지하고, 실제 provider arm flag 없이는 live order side effect를 만들지
  않는지 확인한다.
- 실제 운영 검증: 저장소 밖 credential/evidence가 준비된 환경에서 `docs/runbooks/live-ops-real-arm-cleanup.md` 절차로 submit/cancel
  terminal artifact를 생성한다.
- closeout validator: `node scripts/run-live-ops-real-arm-closeout.mjs --fixture-smoke --json`은 live/API side effect 없이 contract를
  검증하고, 운영 guard 없는 실행은 credential/evidence 부재 blocker를 skipped summary로 남긴다.
- closeout validator: guarded manifest는 실제 존재하는 저장소 밖 config/env 파일, `자산조회`/`주문조회`/`주문하기`만 허용된 key scope
  safe summary, `rg -n` 기반 금지 주문/secret scan 명령, 미래가 아닌 submit/cancel timestamp, placeholder가 아닌 같은 주문 suffix
  evidence를 요구한다.
- closeout validator: guarded manifest의 command는 추가/중복 인자 없는 정확한 foreground 실행이어야 하며, config/env/artifact는
  symlink를 따라간 실제 경로도 저장소 밖이어야 한다. artifact safe summary가 실패 상태, 미취소 terminal state, 남은 exposure/counter를
  보고하면 manifest 값과 충돌하므로 실패해야 한다.
- closeout validator: guarded manifest 파일 자체도 realpath 기준 저장소 밖이어야 하며, source/security scan 명령은 `src scripts config docs`
  전체 범위를 실제 `rg -n`으로 스캔해야 한다. 중첩 artifact 값과 `raw_provider_payload`/`raw_order_detail` 형태도 검증 대상이다.
- closeout validator: 저장소 경계는 validator 실행 위치가 아니라 repository root 기준이며, 배열 안 artifact record와 `skipped`/`blocked`
  status도 closeout 충돌로 본다. JSON redaction placeholder 뒤에 원문이 붙은 값은 secret leak으로 실패해야 한다.
- source/security scan: 시장가/best order, 출금/입금, 선물/레버리지, raw secret, raw provider payload 후보가 production 경로에서
  열리지 않았는지 확인한다.

문서 요구사항:

- `docs/exec-plans/active/2026-06-15-issue-206-live-ops-real-arm.md`가 sub PR 순서, DnD, 검증 방법, closeout 기준을 추적한다.
- 실제 cleanup 절차는 `docs/runbooks/live-ops-real-arm-cleanup.md`를 따른다.
- provider arm, decision policy, Telegram, reconcile, cleanup 기준이 바뀌면 `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`, `docs/SECURITY.md`,
  `docs/product-specs/upbit-live-autonomous-trading.md`, 관련 runbook과 active/completed exec plan을 함께 갱신한다.

제외 범위:

- BTC 외 market 기본 활성화, 자동 budget 확대, M24 scaled 운영.
- 신규 진입 시장가, 시장가 매도, best order 기본 허용.
- hard stop 시 open position 자동 시장가 청산.
- 출금, 입출금 자동화, 선물, 레버리지, 마진, 타인 계정, 신호 판매.
- Web 백오피스와 Telegram public webhook endpoint.
- LLM 직접 매수/매도 판단.
- secret 원문이나 raw provider payload를 issue, PR, log, artifact에 기록하는 작업.

### FR-OPS-007: Live Ops는 24/7 자동 매수/보유/매도 loop를 제공해야 한다

설명:

- Issue #206 real-arm cleanup은 실거래 경계 검증을 닫았지만, 운영자가 기대한 24/7 자동매매는 entry와 exit가 모두 있어야 한다.
- production `live:ops`는 cleanup canary와 별개로 장시간 daemon loop를 제공하고, 보유 포지션이 있으면 매도/축소 판단을 entry보다
  먼저 수행해야 한다.
- 실행 전에 수동 fixture manifest, hand-written evidence, JSONL 후보 파일을 요구하지 않는다. config/env만으로 시작하고, 필요한
  artifact와 decision evidence는 runtime이 자동 생성한다.
- 전략은 정적 allowlist registry와 config parameter로 조립한다. 임의 코드 경로, 동적 import, 원격 plugin, 저장소 밖 strategy 코드는
  허용하지 않는다.

Acceptance Criteria:

- [x] `corepack pnpm live:ops:daemon -- --config <운영-json-path> --env-file <운영-env-path> --tui`가 24/7 loop를 시작한다.
- [x] `live:ops:daemon` production 실행은 fixture manifest, hand-written evidence, 수동 JSONL 후보 파일을 요구하지 않는다.
- [x] loop tick은 config/env validation, DB readiness, market data freshness, private read reconcile, PnL/status, decision, live execution,
  Telegram/status summary 순서를 지킨다.
- [x] 보유 포지션이 있으면 exit policy가 entry policy보다 먼저 평가된다.
- [x] exit policy는 take profit, stop loss, trailing stop, max holding time, risk reduction rule을 독립 rule로 조립한다.
- [x] exit policy는 strategy reservation 기록으로 확인된 자동 전략 소유 수량만 SELL 대상으로 삼고, 수동 보유 BTC는 자동 축소하지 않는다.
- [x] exit 체결 closeout은 runtime이 저장소 밖 artifact로 자동 기록하고, FILLED SELL 수량은 strategy-owned 수량에서 차감한다.
- [x] trailing stop은 tick마다 새 entry/current price만 보지 않고, runtime position state에 저장된 high-water price를 보존한다.
- [x] risk-reduction 기준보다 작은 소액 보유분도 take profit, stop loss, trailing stop, max holding time 조건이면 exit intent를 만들 수 있다.
- [x] exit intent는 보유 수량 이하의 `SELL + LIMIT + POST_ONLY`만 허용하고, 시장가 매도와 hard-stop 자동 시장가 청산은 금지한다.
- [x] entry strategy는 조건이 약하면 주문을 만들지 않고 HOLD evidence를 남긴다.
- [x] feature provider가 아직 붙지 않은 production tick도 fresh public tick의 reference-price edge로 entry feature를 산출하되, tight spread만으로는 BUY 후보를 만들지 않는다.
- [x] entry intent는 `KRW-BTC`, `BUY`, `LIMIT`, `POST_ONLY`, 10,000 KRW 이하만 허용한다.
- [x] autonomous preflight PnL/status와 preflight PnL closeout은 `live_ops_cleanup_probe`가 아니라 활성 autonomous strategy scope를 사용한다.
- [x] strategy registry는 `cleanup_probe`와 production 24/7 strategy를 분리하고, 새 strategy를 나중에 allowlist로 추가/교체할 수 있다.
- [x] strategy는 broker, Upbit client, DB connection, Telegram dispatcher를 직접 호출하지 않는다.
- [x] stale market data, stale PnL, reconcile mismatch, open order, budget 초과, kill switch, Telegram owner alert 불능은 broker 호출 전에
  fail-closed 된다.
- [x] 미체결 entry/exit order는 bounded cancel/requote 또는 manual review로 닫히고, terminal 확인 실패는 성공으로 표시하지 않는다.
- [x] TUI/Telegram/status는 한국어로 현재 상태, 보유/현금 판단 이유, 최근 entry/exit decision, open exposure, PnL, 필요한 조치를
  보여준다.
- [x] `live:ops:tui --attach`는 daemon top-level `transient_failure`를 stale `latestSummary`보다 우선해 차단 상태로 표시한다.
- [x] 24시간 run summary는 crash 0회, unhandled rejection 0회, duplicate order 0건, reconcile mismatch 0건, untracked fill 0건,
  live order cleanup failure 0건을 자동 산출한다.

테스트 요구사항:

- 단위 테스트: strategy registry가 허용 strategy만 조립하고 동적 코드 경로를 거부한다.
- 단위 테스트: 보유 포지션이 있으면 exit evaluation이 entry evaluation보다 먼저 실행된다.
- 단위 테스트: take profit, stop loss, trailing stop, max holding time, risk reduction rule이 각각 SELL intent 또는 HOLD/BLOCK을 만든다.
- 단위 테스트: strategy 소유 기록 없는 지갑 BTC는 자동 SELL이 아니라 BLOCK으로 닫힌다.
- 단위 테스트: risk-reduction 기준보다 작은 strategy-owned 포지션도 take-profit 조건이면 SELL intent를 만든다.
- 단위 테스트: FILLED autonomous SELL cleanup은 strategy-owned 수량에서 차감되고, 이전 reservation만으로 수동 BTC를 자동 소유로 보지 않는다.
- 단위 테스트: position state가 trailing stop high-water를 tick 간 보존한다.
- 단위 테스트: 외부 feature 주입 없이 fresh public tick reference edge가 있으면 entry 후보를 만들고, tight spread만 있으면 HOLD한다.
- 단위 테스트: autonomous order intent의 PnL provider/closeout 호출이 autonomous strategy scope로 수행된다.
- 단위 테스트: daemon attach는 top-level transient failure를 stale ready latestSummary보다 우선 표시한다.
- 단위 테스트: exit intent가 보유 수량을 초과하거나 시장가/best order이면 broker 호출 전에 차단된다.
- 단위 테스트: daemon loop가 success, HOLD, BLOCK, manual review, transient failure에 대해 각각 다른 sleep/backoff 정책을 적용한다.
- 통합 테스트: fake provider/fake broker/fake Telegram으로 entry 체결, 보유, exit 제출, cancel/requote, terminal close summary를 검증한다.
- script smoke: `corepack pnpm live:ops:daemon -- --config config/live-ops.example.json --env-file tests/fixtures/live-ops/fake.env --fixture-smoke --duration-ms 1000 --tui`
  가 외부 DB/provider/order side effect 없이 loop contract를 검증한다.

문서 요구사항:

- `docs/runbooks/live-ops-24x7-autonomous.md`가 실행 명령, strategy 교체성, entry/exit DnD, 중지 기준을 설명한다.
- provider arm, strategy registry, daemon loop, exit execution 기준이 바뀌면 `docs/RUNTIME_CONFIG.md`, `docs/RELIABILITY.md`,
  `docs/SECURITY.md`, `docs/product-specs/upbit-live-autonomous-trading.md`, active plan을 함께 갱신한다.

제외 범위:

- 수익 보장, 투자 자문, 타인 자금 운용, 신호 판매.
- BTC 외 market 기본 활성화, 자동 budget 확대, M24 scaled 운영.
- 신규 진입 시장가, 시장가 매도, best order 기본 허용.
- hard stop open position 자동 시장가 청산.
- LLM 직접 매수/매도 판단.

### FR-LLM-001: LLM은 직접 매매 판단에 사용하지 않는다

설명:

- LLM은 공식 Upbit 공지 요약, 개발자 changelog 요약, 시장경보 분류, 상장/상폐/점검 분류, 이상 이벤트 설명, 일간 리포트 초안에만 사용한다.
- LLM 출력은 주문 후보 생성이나 주문 제출로 직접 연결될 수 없다.
- provider는 `noop`과 `codex_oauth`를 같은 port 뒤에 두며, 기본 구현은 로컬 owner-operated Codex OAuth 세션을 사용하는 `codex_oauth`다.
- provider timeout, invalid JSON, free-form output, output size 초과는 모두 fail-closed로 수렴하고 거래 신호를 만들지 않는다.
- 일간 리포트 초안은 deterministic daily report 옆의 보조 결과일 뿐이며, LLM 실패가 report 생성 성공을 실패로 바꾸지 않는다.

Acceptance Criteria:

- [ ] LLM 입력 소스는 `exchange_notice`, `developer_changelog`, `market_event`로 제한된다.
- [ ] LLM 결과 타입은 `notice_summary`, `notice_risk_classification`, `event_explanation`, `daily_report_draft` 같은 보조 목적에 한정된다.
- [ ] LLM `recommended_action`은 `NO_ACTION`, `BLOCK_NEW_ENTRY`, `CANCEL_PENDING`, `PAUSE_STRATEGY`, `ALERT_ONLY`만 허용한다.
- [ ] `BUY`, `SELL`, `INCREASE_POSITION` 같은 주문 허용 또는 포지션 확대 액션은 스키마 검증에서 거부된다.
- [ ] LLM 결과만으로 전략 주문 후보를 만들 수 없다.
- [ ] LLM 결과가 리스크 게이트에 전달될 경우 주문 허용이 아니라 차단 또는 사람 확인 신호로만 사용된다.
- [ ] LLM 입력과 출력은 감사 가능하도록 저장되며 민감정보를 포함하지 않는다.
- [ ] provider를 `codex_oauth`에서 `noop`으로 바꿔도 application contract가 바뀌지 않는다.
- [ ] Codex timeout, invalid output, free-form output은 실패 evidence만 남기고 주문 신호 없이 끝난다.
- [ ] deterministic daily report는 LLM draft 실패와 독립적으로 성공/실패가 결정된다.

테스트 요구사항:

- 단위 테스트: LLM 결과만 있는 경우 주문 후보가 생성되지 않는지 확인한다.
- 단위 테스트: LLM 리스크 분류가 주문 허용 신호로 변환되지 않는지 확인한다.
- 단위 테스트: 금지 액션이 포함된 LLM 출력이 거부되는지 확인한다.
- 단위 테스트: provider timeout, invalid JSON, free-form output, output size 초과가 fail-closed로 정규화되는지 확인한다.
- 단위 테스트: LLM daily report draft 실패가 deterministic report payload를 바꾸지 않는지 확인한다.
- gated smoke: `SEEMIRAI_RUN_CODEX_LLM_SMOKE=1`일 때만 실제 Codex OAuth provider smoke를 실행한다.
- 수동 테스트: 공지 요약이 리포트에 포함되더라도 주문 실행 로그와 직접 연결되지 않는지 확인한다.

문서 요구사항:

- LLM 입력 소스가 확대되면 업무 명세와 PRD 비범위를 먼저 갱신한다.
- `docs/RUNTIME_CONFIG.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`는 provider 교체성, secret redaction, fail-closed 동작, smoke gate를 함께 설명해야 한다.

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
