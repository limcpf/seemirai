import type { ColumnType, Generated } from "kysely";
import type { KillSwitchState, OrderLifecycleStatus } from "../../domain/index.js";

/**
 * PostgreSQL `timestamptz` 컬럼 타입이다.
 *
 * Kysely 조회 결과는 `Date`로 받고, insert/update 입력은 `Date` 또는 ISO 문자열을 허용한다.
 */
type Timestamp = ColumnType<Date, Date | string, Date | string>;

/**
 * nullable `timestamptz` 컬럼 타입이다.
 *
 * insert 시 생략 가능한 timestamp와 명시적인 `null`을 모두 표현한다.
 */
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

/**
 * DB default로 생성되는 `timestamptz` 컬럼 타입이다.
 *
 * `created_at`, `updated_at`, `captured_at`처럼 insert 시 생략할 수 있는 시간 컬럼에 사용한다.
 */
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

/**
 * DB default가 있는 JSON object 컬럼 타입이다.
 *
 * migration의 기본값은 `{}`이고, application은 구조화된 metadata를 object로 전달한다.
 */
type GeneratedJsonRecord = ColumnType<JsonRecord, JsonRecord | undefined, JsonRecord>;

/**
 * DB default가 있는 numeric 컬럼 타입이다.
 *
 * PostgreSQL `numeric`은 precision 보존을 위해 runtime에서 문자열로 다룬다.
 */
type GeneratedNumericString = ColumnType<NumericString, NumericString | undefined, NumericString>;

/**
 * 금액, 가격, 수량, bps 같은 정밀 숫자 값이다.
 *
 * JavaScript `number` 변환으로 인한 반올림을 피하기 위해 DB boundary에서는 문자열로 둔다.
 */
type NumericString = string;

/**
 * JSONB payload의 기본 object 형태다.
 *
 * 거래소별 원본 payload, 판단 근거, worker metadata처럼 schema가 자주 바뀌는 보조 정보에 사용한다.
 */
type JsonRecord = Record<string, unknown>;

/**
 * Kysely가 참조하는 전체 DB schema map이다.
 *
 * key는 실제 table 이름이고 value는 해당 table의 row interface다. application code는 이 map을 통해
 * 테이블 이름, 컬럼 이름, insert/update 가능 여부, nullable 여부를 type-safe하게 검증받는다.
 */
export interface DatabaseSchema {
  /** raw SQL migration 적용 이력과 checksum guard */
  schema_migrations: SchemaMigrationsTable;
  /** broker 종류와 무관한 주문 요청의 canonical record */
  orders: OrdersTable;
  /** 주문 상태 전이의 canonical append-only event log */
  order_events: OrderEventsTable;
  /** paper trading 전용 주문 실행 metadata */
  paper_orders: PaperOrdersTable;
  /** 주문 체결 record와 비용 계산 입력 */
  fills: FillsTable;
  /** 전략/마켓별 현재 포지션 snapshot */
  positions: PositionsTable;
  /** 운영과 업무 흐름을 사람이 추적하기 위한 감사 로그 */
  audit_events: AuditEventsTable;
  /** 리스크 게이트 판단과 차단 이력 */
  risk_events: RiskEventsTable;
  /** 전역 kill switch의 durable 현재 상태 */
  kill_switch_state: KillSwitchStateTable;
  /** PostgreSQL 기반 scheduler/worker 작업 큐 */
  jobs: JobsTable;
  /** 거래소 정책, 수수료, 호가 단위, market status snapshot */
  policy_snapshots: PolicySnapshotsTable;
  /** 거래소 체결 stream 원천 시계열 */
  trades: TradesTable;
  /** 호가창에서 계산한 spread/depth/imbalance 시계열 */
  orderbook_metrics: OrderbookMetricsTable;
  /** 특정 시점의 호가 원본 JSON snapshot */
  orderbook_snapshots: OrderbookSnapshotsTable;
  /** 전략과 리포트가 쓰는 timeframe별 OHLCV 시계열 */
  candles: CandlesTable;
  /** 전략/마켓 단위 PnL과 drawdown snapshot */
  pnl_snapshots: PnlSnapshotsTable;
  /** 전략이 생성한 BUY/SELL/HOLD/BLOCK 판단 이력 */
  strategy_signals: StrategySignalsTable;
}

/**
 * 적용 완료된 migration 파일을 기록한다.
 *
 * runner는 이 테이블을 기준으로 이미 적용된 migration을 skip하고, filename/checksum이 바뀐 경우
 * 불변 migration 위반으로 중단한다.
 */
export interface SchemaMigrationsTable {
  /** migration 파일명의 6자리 version */
  version: number;
  /** 적용 당시 파일명 */
  filename: string;
  /** 적용 당시 SQL 본문의 sha256 checksum */
  checksum: string;
  /** DB에 migration record가 기록된 시각 */
  applied_at: GeneratedTimestamp;
}

/**
 * 주문 요청의 기준 테이블이다.
 *
 * strategy가 만든 주문 후보가 비용/리스크 게이트를 통과하면 이 테이블에 먼저 기록된다. 이후
 * `paper_orders`, `fills`, `audit_events`, `risk_events`가 `orders.id`를 기준으로 실행 결과와 판단 근거를 연결한다.
 */
export interface OrdersTable {
  /** 주문 record ID */
  id: Generated<string>;
  /** 거래소 식별자. 예: `UPBIT`, future exchange adapter ID */
  exchange: string;
  /** 거래소 adapter가 정규화한 market code. DB는 비어 있지 않은 문자열만 강제한다. */
  market: string;
  /** 주문 후보를 만든 strategy 식별자 */
  strategy_id: string;
  /** 매수/매도 방향 */
  side: "BUY" | "SELL";
  /** 주문 유형. MVP는 지정가 중심이지만 schema는 market order 차단/검증 기록도 표현한다. */
  order_type: "LIMIT" | "MARKET";
  /** application이 관리하는 주문 상태 */
  status: OrderLifecycleStatus;
  /** 동일 주문 의도 중복 생성을 막는 업무 idempotency key */
  idempotency_key: string;
  /** 요청 지정가. market order 또는 가격 미정 후보에서는 null일 수 있다. */
  requested_price: NumericString | null;
  /** 요청 수량 */
  requested_quantity: NumericString;
  /** 요청 명목 금액 */
  requested_notional: NumericString;
  /** 주문 생성 이유, 비용/리스크 계산 근거, strategy payload */
  reason_json: GeneratedJsonRecord;
  /** 주문 record 생성 시각 */
  created_at: GeneratedTimestamp;
  /** 주문 상태 또는 metadata 최종 갱신 시각 */
  updated_at: GeneratedTimestamp;
}

/**
 * 주문 상태 전이 canonical event log다.
 *
 * `orders.status`는 현재 상태 snapshot이고, `order_events`는 허용/거부된 상태 전이 시도 전체를 append-only로
 * 보존한다. 불법 전이도 `accepted=false`로 남겨 사후 감사와 복구 판단에 사용한다.
 */
export interface OrderEventsTable {
  /** 주문 이벤트 ID */
  id: Generated<string>;
  /** 상태 전이가 속한 주문 ID */
  order_id: string;
  /** 주문 event 종류. 현재는 상태 전이만 canonical event로 저장한다. */
  event_type: "ORDER_STATE_TRANSITION";
  /** 전이 전 주문 상태 */
  from_status: OrderLifecycleStatus;
  /** 전이 대상 주문 상태 */
  to_status: OrderLifecycleStatus;
  /** state machine이 전이를 허용했는지 여부 */
  accepted: boolean;
  /** 허용 또는 거부 사유 코드 */
  reason_code: string;
  /** 사람이 읽을 수 있는 상태 전이 설명 */
  message: string;
  /** 여러 이벤트를 하나의 업무 흐름으로 묶는 상관관계 ID */
  correlation_id: string | null;
  /** state machine metadata와 추가 판단 근거 */
  payload_json: GeneratedJsonRecord;
  /** 상태 전이가 발생하거나 거부된 시각 */
  occurred_at: GeneratedTimestamp;
}

/**
 * paper trading 주문 실행 metadata다.
 *
 * `orders`를 broker 공통 record로 유지하기 위해 paper 전용 옵션과 simulation 결과를 companion table에 둔다.
 */
export interface PaperOrdersTable {
  /** `orders.id`를 참조하는 1:1 primary key */
  order_id: string;
  /** maker 중심 체결 시뮬레이션을 위한 post-only 기본값 */
  post_only: Generated<boolean>;
  /** 주문 유효 조건. null이면 broker 기본값을 사용한다. */
  time_in_force: string | null;
  /** 체결 시뮬레이션에 반영한 지연 시간 */
  simulated_latency_ms: number | null;
  /** fill model 설정과 실행 근거 */
  fill_model_json: GeneratedJsonRecord;
  /** paper broker에 제출한 시각 */
  submitted_at: NullableTimestamp;
  /** paper broker가 수락 처리한 시각 */
  accepted_at: NullableTimestamp;
  /** paper 주문이 완료 처리된 시각 */
  completed_at: NullableTimestamp;
}

/**
 * 주문의 체결 record다.
 *
 * 하나의 `orders` row는 여러 `fills`를 가질 수 있다. fill은 position, realized PnL, 수수료 분석의 입력이다.
 */
export interface FillsTable {
  /** 체결 record ID */
  id: Generated<string>;
  /** 체결이 속한 주문 ID */
  order_id: string;
  /** 거래소 식별자 */
  exchange: string;
  /** 정규화 market code */
  market: string;
  /** 체결 방향 */
  side: "BUY" | "SELL";
  /** 체결 가격 */
  price: NumericString;
  /** 체결 수량 */
  quantity: NumericString;
  /** 체결 수수료 */
  fee: NumericString;
  /** 수수료 통화 */
  fee_currency: string;
  /** maker/taker 또는 simulation 체결 구분 */
  liquidity: "MAKER" | "TAKER" | "SIMULATED";
  /** 거래소 또는 simulation 기준 체결 시각 */
  filled_at: Timestamp;
  /** DB record 생성 시각 */
  created_at: GeneratedTimestamp;
}

/**
 * 전략/마켓 단위 현재 포지션 snapshot이다.
 *
 * fill stream을 매번 전체 재계산하지 않고 현재 노출, 평균 단가, 손익을 빠르게 조회하기 위한 상태 테이블이다.
 */
export interface PositionsTable {
  /** 포지션 record ID */
  id: Generated<string>;
  /** 거래소 식별자 */
  exchange: string;
  /** 정규화 market code */
  market: string;
  /** 포지션을 소유한 strategy 식별자 */
  strategy_id: string;
  /** 현재 보유 수량 */
  quantity: NumericString;
  /** 평균 진입 가격 */
  average_entry_price: NumericString;
  /** 청산/매도 등으로 확정된 손익 */
  realized_pnl: GeneratedNumericString;
  /** 현재 가격 기준 미실현 손익 */
  unrealized_pnl: GeneratedNumericString;
  /** 포지션 snapshot 최종 갱신 시각 */
  updated_at: GeneratedTimestamp;
}

/**
 * 감사 로그 테이블이다.
 *
 * 주문 상태 변화, worker action, 외부 호출 결과처럼 사람이 사후 추적해야 하는 업무/운영 이벤트를 기록한다.
 */
export interface AuditEventsTable {
  /** 감사 이벤트 ID */
  id: Generated<string>;
  /** 이벤트 종류 */
  event_type: string;
  /** 로그 심각도 */
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
  /** 관련 주문이 있으면 `orders.id`, 없으면 null */
  order_id: string | null;
  /** 여러 이벤트를 하나의 업무 흐름으로 묶는 상관관계 ID */
  correlation_id: string | null;
  /** 이벤트별 상세 payload */
  payload_json: GeneratedJsonRecord;
  /** 이벤트 발생 시각 */
  occurred_at: GeneratedTimestamp;
}

/**
 * 리스크 판단 이력 테이블이다.
 *
 * 리스크 게이트가 주문을 차단하거나 경고를 발생시킨 이유를 market, strategy, order 맥락과 함께 보존한다.
 */
export interface RiskEventsTable {
  /** 리스크 이벤트 ID */
  id: Generated<string>;
  /** 리스크 종류. 예: spread, drawdown, stale_market_data */
  risk_type: string;
  /** 리스크 심각도 */
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  /** 관련 market. 계정/전략 공통 이벤트면 null일 수 있다. */
  market: string | null;
  /** 관련 strategy. 시스템 공통 이벤트면 null일 수 있다. */
  strategy_id: string | null;
  /** 관련 주문이 있으면 `orders.id`, 없으면 null */
  order_id: string | null;
  /** 리스크 게이트가 취한 조치. 예: BLOCK_ORDER, PAUSE_STRATEGY */
  action: string;
  /** 판단 근거와 threshold snapshot */
  payload_json: GeneratedJsonRecord;
  /** 리스크 이벤트 발생 시각 */
  occurred_at: GeneratedTimestamp;
}

/**
 * 전역 kill switch의 현재 상태 snapshot이다.
 *
 * 상태 전이 감사 로그와 별개로 프로세스 재시작 후에도 신규 주문 차단 상태를 복구할 수 있게 단일 row로 유지한다.
 */
export interface KillSwitchStateTable {
  /** 전역 kill switch row를 고정하는 scope */
  scope: "global";
  /** durable 현재 kill switch 상태 */
  state: KillSwitchState;
  /** 마지막 상태 변경 사유 */
  reason_code: string;
  /** 마지막 상태 변경 correlation id */
  correlation_id: string | null;
  /** 상태 전이 event payload와 추가 판단 근거 */
  payload_json: GeneratedJsonRecord;
  /** durable snapshot 최종 갱신 시각 */
  updated_at: GeneratedTimestamp;
}

/**
 * PostgreSQL 기반 작업 큐 테이블이다.
 *
 * Redis/BullMQ 없이 scheduler와 worker가 작업을 예약, claim, 재시도하기 위한 operational table이다.
 * 업무 결과는 `jobs`에만 남기지 않고 domain table 또는 audit/risk table에 기록한다.
 */
export interface JobsTable {
  /** job record ID */
  id: Generated<string>;
  /** worker가 실행할 작업 종류 */
  job_type: string;
  /** 같은 업무 작업의 중복 생성을 막는 key */
  idempotency_key: string;
  /** 작업 입력 payload */
  payload_json: GeneratedJsonRecord;
  /** worker lifecycle 상태 */
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";
  /** 이 시각 이후 claim 가능한 예약 시간 */
  run_after: GeneratedTimestamp;
  /** worker가 claim한 시각 */
  locked_at: NullableTimestamp;
  /** claim한 worker 식별자 */
  locked_by: string | null;
  /** 현재까지 실행 시도 횟수 */
  attempt_count: Generated<number>;
  /** 최대 재시도 횟수 */
  max_attempts: Generated<number>;
  /** 마지막 실패 원인 */
  last_error: string | null;
  /** job 생성 시각 */
  created_at: GeneratedTimestamp;
  /** job 상태 또는 retry metadata 최종 갱신 시각 */
  updated_at: GeneratedTimestamp;
}

/**
 * 거래소 정책 snapshot 테이블이다.
 *
 * 수수료, 호가 단위, 최소 주문금액, market status 같은 외부 정책 payload를 checksum 기준으로 저장해
 * 주문 전 검증과 사후 감사의 근거로 사용한다.
 */
export interface PolicySnapshotsTable {
  /** 정책 snapshot ID */
  id: Generated<string>;
  /** 정책 출처 거래소 */
  exchange: string;
  /** market별 정책이면 market code, 거래소 공통 정책이면 null */
  market: string | null;
  /** 정책을 수집한 profile 또는 endpoint 묶음 */
  source_profile: string;
  /** payload 중복 저장을 막기 위한 checksum */
  checksum: string;
  /** 거래소 정책 원본 또는 정규화 payload */
  payload_json: JsonRecord;
  /** 이 정책이 유효하다고 보는 기준 시각 */
  effective_at: Timestamp;
  /** snapshot을 캡처한 시각 */
  captured_at: GeneratedTimestamp;
}

/**
 * 거래소 체결 stream 원천 시계열이다.
 *
 * feature 생성, candle aggregate, backtest 보정의 입력이며 TimescaleDB hypertable로 관리한다.
 */
export interface TradesTable {
  /** 거래소 식별자. primary key 일부 */
  exchange: string;
  /** 정규화 market code. primary key 일부 */
  market: string;
  /** 거래소가 제공하는 체결 ID. primary key 일부 */
  trade_id: string;
  /** 체결 방향. 거래소 payload에서 방향을 알 수 없으면 UNKNOWN */
  side: "BUY" | "SELL" | "UNKNOWN";
  /** 체결 가격 */
  price: NumericString;
  /** 체결 수량 */
  volume: NumericString;
  /** 거래소 기준 체결 시각. hypertable time column이자 primary key 일부 */
  exchange_timestamp: Timestamp;
  /** local worker가 수신한 시각 */
  received_at: Timestamp;
  /** 거래소 원본 payload sample */
  raw_payload_json: GeneratedJsonRecord;
}

/**
 * 호가창에서 계산한 metric 시계열이다.
 *
 * 비용 모델과 리스크 게이트가 spread, depth, imbalance, lag를 빠르게 조회할 수 있도록 snapshot에서
 * 필요한 값을 별도 시계열로 정규화한다.
 */
export interface OrderbookMetricsTable {
  /** 거래소 식별자. primary key 일부 */
  exchange: string;
  /** 정규화 market code. primary key 일부 */
  market: string;
  /** metric bucket 시각. hypertable time column이자 primary key 일부 */
  bucket_at: Timestamp;
  /** 최우선 매수 호가 */
  best_bid_price: NumericString;
  /** 최우선 매도 호가 */
  best_ask_price: NumericString;
  /** 최우선 매수/매도 기준 spread bps */
  spread_bps: NumericString;
  /** 1레벨 bid depth */
  bid_depth_1: NumericString;
  /** 1레벨 ask depth */
  ask_depth_1: NumericString;
  /** 5레벨 bid depth */
  bid_depth_5: NumericString;
  /** 5레벨 ask depth */
  ask_depth_5: NumericString;
  /** 15레벨 bid depth */
  bid_depth_15: NumericString;
  /** 15레벨 ask depth */
  ask_depth_15: NumericString;
  /** 5레벨 호가 불균형 */
  imbalance_5: NumericString;
  /** 15레벨 호가 불균형 */
  imbalance_15: NumericString;
  /** WebSocket 수신 지연. 알 수 없으면 null */
  websocket_lag_ms: number | null;
  /** 해당 bucket까지 관찰한 reconnect 횟수 */
  reconnect_count: Generated<number>;
  /** metric row 생성 시각 */
  created_at: GeneratedTimestamp;
}

/**
 * 특정 시점의 호가 원본 snapshot 시계열이다.
 *
 * slippage 추정, 체결 시뮬레이션, 장애 분석처럼 metric으로 축약하기 어려운 작업에서 사용한다.
 */
export interface OrderbookSnapshotsTable {
  /** 거래소 식별자. primary key 일부 */
  exchange: string;
  /** 정규화 market code. primary key 일부 */
  market: string;
  /** snapshot 캡처 시각. hypertable time column이자 primary key 일부 */
  captured_at: Timestamp;
  /** bid side 호가 배열 payload */
  bids_json: JsonRecord;
  /** ask side 호가 배열 payload */
  asks_json: JsonRecord;
  /** 거래소 원본 payload */
  raw_payload_json: GeneratedJsonRecord;
}

/**
 * timeframe별 OHLCV 시계열이다.
 *
 * 전략 feature, 리포트, backtest 입력을 위해 trades를 집계한 candle record를 저장한다.
 */
export interface CandlesTable {
  /** 거래소 식별자. primary key 일부 */
  exchange: string;
  /** 정규화 market code. primary key 일부 */
  market: string;
  /** candle 간격 */
  timeframe: "1m" | "5m" | "1h";
  /** candle bucket 시작 시각. hypertable time column이자 primary key 일부 */
  bucket_at: Timestamp;
  /** 시가 */
  open_price: NumericString;
  /** 고가 */
  high_price: NumericString;
  /** 저가 */
  low_price: NumericString;
  /** 종가 */
  close_price: NumericString;
  /** 거래량 */
  volume: NumericString;
  /** bucket 안의 체결 수 */
  trade_count: Generated<number>;
}

/**
 * 전략 또는 market 단위 PnL snapshot 시계열이다.
 *
 * 리스크 한도, 리포트, drawdown 계산에 필요한 equity와 손익 흐름을 시간별로 남긴다.
 */
export interface PnlSnapshotsTable {
  /** 전략 식별자 */
  strategy_id: string;
  /** market별 snapshot이면 market code, 전략 전체 snapshot이면 null */
  market: string | null;
  /** snapshot 캡처 시각. hypertable time column */
  captured_at: Timestamp;
  /** 평가 자산 */
  equity: NumericString;
  /** 확정 손익 */
  realized_pnl: NumericString;
  /** 미실현 손익 */
  unrealized_pnl: NumericString;
  /** 최대 낙폭 또는 현재 drawdown bps */
  drawdown_bps: NumericString;
  /** PnL 계산에 사용한 보조 payload */
  payload_json: GeneratedJsonRecord;
}

/**
 * 전략 판단 이력 시계열이다.
 *
 * 전략이 특정 시점에 낸 BUY/SELL/HOLD/BLOCK decision과 기대수익률, 계산 payload를 저장해
 * 주문 생성 또는 차단 이유를 사후 추적할 수 있게 한다.
 */
export interface StrategySignalsTable {
  /** 전략 식별자. primary key 일부 */
  strategy_id: string;
  /** 판단 대상 market */
  market: string;
  /** 전략이 생성한 signal ID. primary key 일부 */
  signal_id: string;
  /** 전략 판단 결과 */
  decision: "BUY" | "SELL" | "HOLD" | "BLOCK";
  /** 비용 차감 전 또는 전략 기준 기대수익률 bps. 없으면 null */
  expected_return_bps: NumericString | null;
  /** feature, threshold, model output 등 판단 근거 */
  payload_json: GeneratedJsonRecord;
  /** signal 생성 시각. hypertable time column이자 primary key 일부 */
  generated_at: Timestamp;
}
