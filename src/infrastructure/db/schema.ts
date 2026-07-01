import type { ColumnType, Generated } from "kysely";
import type { KillSwitchState, OrderLifecycleStatus } from "../../domain/index.js";
import type { AlertSeverity } from "../../application/ports/notifier-port.js";
import type {
  DecisionCategory,
  DecisionFrameCategory,
  DecisionLedgerVersion,
  EvidenceKind,
  SummaryStatus,
} from "../../application/decision-ledger.js";

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
  /** P0/P1 alert 중복 전송 억제를 위한 durable cooldown state */
  alert_cooldowns: AlertCooldownsTable;
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
  /** live ops daemon/CLI decision tick 이력과 HOLD bucket dedupe evidence */
  live_decision_ticks: LiveDecisionTicksTable;

  // ── M16 실계좌 상태 Reconcile append-only tables ──

  /** reconcile 실행 단위. 같은 idempotency_key 재실행은 중복 row를 만들지 않는다. */
  live_reconcile_runs: LiveReconcileRunsTable;
  /** reconcile 시점의 통화별 잔고 snapshot. 같은 run/currency/captured_at/source 중복 insert 불가 */
  live_reconcile_balance_snapshots: LiveReconcileBalanceSnapshotsTable;
  /** reconcile 시점의 거래소 주문 상태 snapshot. 같은 run/exchange_order_id 중복 insert 불가 */
  live_reconcile_exchange_order_snapshots: LiveReconcileExchangeOrderSnapshotsTable;
  /** reconcile에서 발견한 불일치 증거. 같은 run/evidence_fingerprint 중복 저장 불가 */
  live_reconcile_mismatch_evidence: LiveReconcileMismatchEvidenceTable;
  /** 복구 후보 포지션과 평균단가 근거 snapshot. 같은 run/position/time/source 중복 insert 불가 */
  live_reconcile_position_snapshots: LiveReconcilePositionSnapshotsTable;
  /** fill 복구 전 durable unique key 선점 기록. order_id FK와 같은 exchange fill 또는 fingerprint 중복 insert 불가 */
  live_reconcile_fill_recovery_keys: LiveReconcileFillRecoveryKeysTable;

  // ── M18 판단 이유 ledger append-only tables ──

  /** 판단 이유 ledger의 frame 단위 append-only 기록. dedupe_key unique constraint로 중복 append를 차단한다. */
  decision_ledger_frames: DecisionLedgerFramesTable;
  /** frame 아래 append-only evidence. evidence_fingerprint unique constraint로 중복 append를 차단한다. */
  decision_ledger_evidence: DecisionLedgerEvidenceTable;
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
 * alert fingerprint별 cooldown snapshot이다.
 *
 * P0/P1 알림은 프로세스 재시작 후에도 중복 전송을 억제해야 하므로 DB에 마지막 전송/skip 시각을 남긴다.
 * delivery reservation은 provider 호출 직전 atomic gate로 사용해 동시 알림이 같은 fingerprint로 중복 전송되지 않게 한다.
 * P2/P3은 memory cooldown으로 시작하지만 schema는 공통 severity 값을 허용해 필요 시 승격할 수 있게 한다.
 */
export interface AlertCooldownsTable {
  /** 중복 억제 기준이 되는 canonical fingerprint */
  fingerprint: string;
  /** alert severity */
  severity: AlertSeverity;
  /** 장애 또는 운영 알림 유형 */
  alert_type: string;
  /** market별 알림이면 market code, 전역 알림이면 null */
  market: string | null;
  /** strategy별 알림이면 strategy id, 전역 알림이면 null */
  strategy_id: string | null;
  /** 운영 원인 코드 */
  reason_code: string;
  /** provider 전송이 성공한 마지막 시각 */
  last_sent_at: NullableTimestamp;
  /** cooldown hit로 provider 호출을 건너뛴 마지막 시각 */
  last_skipped_at: NullableTimestamp;
  /** provider 호출 경합을 막는 delivery lease 만료 시각 */
  delivery_reserved_until: NullableTimestamp;
  /** title, correlation id, 기타 운영 metadata */
  payload_json: GeneratedJsonRecord;
  /** cooldown row 생성 시각 */
  created_at: GeneratedTimestamp;
  /** cooldown row 최종 갱신 시각 */
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

/**
 * live ops decision tick 이력 table interface다.
 *
 * `strategy_signals`가 전략 signal 시계열의 일반 contract라면, 이 table은 production live ops/daemon tick의 운영 판단
 * 이력을 feature snapshot, threshold, 주문 후보 수와 함께 저장한다. HOLD는 1분 reason bucket dedupe로 폭주를 줄이고,
 * retention은 repository의 명시 cutoff delete로만 수행한다.
 */
export interface LiveDecisionTicksTable {
  /** decision tick record ID */
  id: Generated<string>;
  /** 거래소 식별자. 예: `"UPBIT"` */
  exchange: string;
  /** 정규화 market code */
  market: string;
  /** 판단을 만든 strategy 식별자 */
  strategy_id: string;
  /** live tick 판단 종류 */
  decision_kind: "HOLD" | "BUY" | "SELL" | "BLOCK";
  /** 판단 reason code. 사용자-facing 문구는 status formatter가 별도로 낮춘다. */
  reason_code: string;
  /** strategy에 전달된 feature snapshot의 secret-free projection */
  feature_snapshot_json: GeneratedJsonRecord;
  /** 해당 tick 판단에 적용된 threshold/config projection */
  threshold_json: GeneratedJsonRecord;
  /** 같은 tick에서 live execution으로 넘어간 주문 후보 수 */
  order_intent_count: number;
  /** 저장 폭주와 재실행 중복을 접는 dedupe 정책 */
  dedupe_policy: "HOLD_REASON_1M_BUCKET" | "SOURCE_TICK";
  /** dedupe policy가 적용된 bucket 시작 시각 */
  dedupe_bucket_started_at: Timestamp;
  /** 같은 tick 또는 HOLD bucket 재실행을 차단하는 stable key */
  dedupe_key: string;
  /** market/feature frame 관측 시각 */
  observed_at: Timestamp;
  /** strategy decision이 확정된 시각 */
  decision_at: Timestamp;
  /** 주문/risk/execution과 연결할 correlation id. 없으면 null */
  correlation_id: string | null;
  /** 내부 추적 정보. raw provider payload, Authorization/JWT, secret은 포함하지 않는다. */
  trace_json: GeneratedJsonRecord;
  /** DB row 생성 시각 */
  created_at: GeneratedTimestamp;
}

// ── M16 실계좌 상태 Reconcile append-only tables ──

/**
 * reconcile 실행 단위 table interface.
 *
 * 같은 `idempotency_key` 재실행은 중복 row를 만들지 않고 기존 run row를 재사용한다.
 * `status`만 RUNNING->COMPLETED/FAILED/MANUAL_REVIEW_REQUIRED로 전이하고 row 자체는 삭제/덮어쓰기하지 않는다.
 */
export interface LiveReconcileRunsTable {
  /** run record ID */
  id: Generated<string>;
  /** 중복 실행을 막는 idempotency key */
  idempotency_key: string;
  /** reconcile 실행 상태 */
  status: "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW_REQUIRED";
  /** run 시작 시각 */
  started_at: GeneratedTimestamp;
  /** run 완료 시각. null이면 아직 실행 중 */
  finished_at: NullableTimestamp;
  /** reconcile을 시작한 guard 또는 profile 식별자 */
  guard_profile: string | null;
  /** reconcile이 참조한 source 요약. 예: "REST: accounts+open, WS: myOrder" */
  source_summary: string | null;
  /** 여러 event를 하나의 업무 흐름으로 묶는 상관관계 ID */
  correlation_id: string | null;
  /** run metadata. raw provider payload, Authorization/JWT, access key, secret key를 넣지 않는다. */
  metadata_json: GeneratedJsonRecord;
}

/**
 * reconcile 시점의 통화별 잔고 snapshot table interface.
 *
 * 같은 run에서 같은 `currency` + `captured_at` + `source` 조합은 중복 insert되지 않는다.
 * `total = available + locked` invariant가 유지된다.
 */
export interface LiveReconcileBalanceSnapshotsTable {
  /** balance snapshot record ID */
  id: Generated<string>;
  /** 소속 run ID */
  run_id: string;
  /** 통화 코드. 예: "KRW", "BTC", "ETH" */
  currency: string;
  /** 사용 가능 잔고 */
  available: NumericString;
  /** 주문 lock 잔고 */
  locked: NumericString;
  /** 총 잔고 (available + locked) */
  total: NumericString;
  /** 거래소 기준 snapshot 시각 */
  captured_at: Timestamp;
  /** snapshot 출처. REST API 조회 또는 WebSocket 이벤트 */
  source: "REST" | "WS";
  /** balance metadata. raw provider payload, Authorization/JWT, access key, secret key를 넣지 않는다. */
  metadata_json: GeneratedJsonRecord;
}

/**
 * reconcile 시점의 거래소 주문 상태 snapshot table interface.
 *
 * 같은 run에서 같은 `exchange_order_id`는 한 번만 저장된다.
 * uuid-only, identifier-only, bridge snapshot은 각각 같은 row grain의 중복 insert를 차단한다.
 * 두 식별자가 모두 없는 snapshot은 identity_fingerprint만 저장하되, 충돌 가능성이 있어 row를 접지 않는다.
 * 두 식별자가 모두 있는 bridge snapshot은 append-only로 보존하고, summary count에서 canonical identity로 collapse한다.
 */
export interface LiveReconcileExchangeOrderSnapshotsTable {
  /** order snapshot record ID */
  id: Generated<string>;
  /** 소속 run ID */
  run_id: string;
  /** 거래소 주문 UUID. identifier만 있는 주문은 null일 수 있다. */
  exchange_order_id: string | null;
  /** 거래소 주문 identifier(idempotency key). uuid가 없을 때도 관측되지 않을 수 있다. */
  identifier: string | null;
  /** uuid/identifier가 없는 주문을 감사 로그에 남기기 위한 immutable 주문 fingerprint */
  identity_fingerprint: string | null;
  /** 정규화 market code */
  market: string;
  /** 주문 방향 */
  side: "BUY" | "SELL";
  /** 거래소 주문 상태 */
  status: string;
  /** 요청 수량 */
  requested_quantity: NumericString;
  /** 미체결 수량. null이면 알 수 없음 */
  remaining_quantity: NumericString | null;
  /** 요청 가격. 시장가 주문이면 null */
  requested_price: NumericString | null;
  /** snapshot 출처: open(미체결 목록), closed(체결/취소 목록), lookup(개별 조회), ws(WebSocket) */
  source: "open" | "closed" | "lookup" | "ws";
  /** 거래소 기준 snapshot 시각 */
  captured_at: Timestamp;
  /** order snapshot metadata. raw provider payload, Authorization/JWT, access key, secret key를 넣지 않는다. */
  metadata_json: GeneratedJsonRecord;
}

/**
 * reconcile에서 발견한 불일치 증거 table interface.
 *
 * 같은 run 안의 `evidence_fingerprint`는 중복 저장되지 않는다.
 * 다음 run에서 반복 관측된 mismatch는 최신 summary에 남아야 하므로 run 범위 unique만 적용한다.
 * `message`와 `action`은 한국어 사용자 문구로 저장하고, 안정적인 내부 코드는 `trace_json`에 분리한다.
 */
export interface LiveReconcileMismatchEvidenceTable {
  /** mismatch evidence record ID */
  id: Generated<string>;
  /** 소속 run ID */
  run_id: string;
  /** 불일치 유형 */
  mismatch_type:
    | "UNTRACKED_EXCHANGE_OPEN_ORDER"
    | "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE"
    | "PARTIAL_FILL_MISMATCH"
    | "CANCEL_FAILURE_RETRY_NEEDED"
    | "EXCHANGE_CANCEL_STATE_MISMATCH"
    | "ORDER_STATE_ADVANCEMENT_BLOCKED"
    | "ORDER_IDENTITY_CONFLICT"
    | "BALANCE_LOCK_MISMATCH"
    | "BALANCE_SNAPSHOT_UNAVAILABLE"
    | "CLOSED_ORDER_WINDOW_EXCEEDED"
    | "WEBSOCKET_GAP_MANUAL_REVIEW";
  /** 불일치 심각도 */
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  /** 관련 market. 전역 불일치면 null */
  market: string | null;
  /** 관련 주문 식별자(Upbit uuid 또는 identifier). 주문과 무관한 불일치면 null */
  order_identity: string | null;
  /** 관련 통화. 잔고 불일치인 경우 null이 아닌 값 */
  currency: string | null;
  /** 사용자-facing 한국어 메시지 */
  message: string;
  /** 사용자-facing 한국어 필요 조치 */
  action: string;
  /** 중복 저장을 막는 stable evidence fingerprint */
  evidence_fingerprint: string;
  /** 추적 metadata. 안정적인 내부 reason code, correlation id, debug 정보를 분리 보존 */
  trace_json: GeneratedJsonRecord;
  /** 불일치 발견 시각 */
  occurred_at: Timestamp;
}

/**
 * reconcile 기반 포지션 복구 후보 snapshot table interface.
 *
 * `positions` 현재 상태를 바로 덮어쓰지 않고, 같은 run에서 관측한 수량과 평균단가 산출 근거를 append-only로 남긴다.
 * 평균단가를 계산할 수 없는 후보는 `MANUAL_REVIEW_REQUIRED`로만 저장해 근거 없는 포지션 갱신을 차단한다.
 * `RECOVERABLE`은 fill 기반 source에서만 허용하고, 양수 수량을 `RECOVERABLE`로 저장하려면 평균단가도 양수여야 한다.
 */
export interface LiveReconcilePositionSnapshotsTable {
  /** position snapshot record ID */
  id: Generated<string>;
  /** 소속 run ID */
  run_id: string;
  /** 거래소 식별자 */
  exchange: string;
  /** 정규화 market code */
  market: string;
  /** 포지션을 소유한 strategy 식별자 */
  strategy_id: string;
  /** 복구 후보 수량 */
  quantity: NumericString;
  /** authoritative fill price/volume으로 계산한 평균단가. 근거가 없으면 null */
  average_entry_price: NumericString | null;
  /** domain `positions` 갱신 가능 여부 */
  recovery_status: "RECOVERABLE" | "MANUAL_REVIEW_REQUIRED";
  /** snapshot 근거 출처 */
  source: "fills" | "balances" | "local" | "manual_review";
  /** 거래소 또는 reconcile 기준 snapshot 시각 */
  captured_at: Timestamp;
  /** 평균단가 산출에 사용한 구조화 근거. raw provider payload와 secret은 저장하지 않는다. */
  evidence_json: GeneratedJsonRecord;
  /** position snapshot metadata. raw provider payload, Authorization/JWT, access key, secret key를 넣지 않는다. */
  metadata_json: GeneratedJsonRecord;
}

/**
 * reconcile fill 복구 unique key 선점 table interface.
 *
 * `fills` insert 전에 거래소 체결 ID와 정규화 fingerprint를 durable key로 선점해 같은 체결이 재시도나 중복 reconcile에서
 * 다시 insert되지 않게 한다. `order_id`가 있으면 `orders.id` FK로 검증해 잘못된 주문 ID가 key를 선점하지 못하게 한다.
 * 이 table은 복구 가능성 판단의 선행 side effect이며 domain table을 직접 갱신하지 않는다.
 */
export interface LiveReconcileFillRecoveryKeysTable {
  /** recovery key record ID */
  id: Generated<string>;
  /** 소속 run ID */
  run_id: string;
  /** 거래소 식별자 */
  exchange: string;
  /** 정규화 market code */
  market: string;
  /** 매칭된 로컬 주문 ID. 아직 확정하지 못했으면 null */
  order_id: string | null;
  /** 거래소 주문 UUID */
  exchange_order_id: string | null;
  /** 거래소 체결 ID. provider가 노출하지 않으면 null */
  exchange_fill_id: string | null;
  /** 정규화 fill fingerprint */
  fill_fingerprint: string;
  /** 체결 방향 */
  side: "BUY" | "SELL";
  /** 체결 가격 */
  price: NumericString;
  /** 체결 수량 */
  quantity: NumericString;
  /** 거래소 기준 체결 시각 */
  filled_at: Timestamp;
  /** durable key를 선점한 시각 */
  reserved_at: GeneratedTimestamp;
  /** recovery key metadata. raw provider payload, Authorization/JWT, access key, secret key를 넣지 않는다. */
  metadata_json: GeneratedJsonRecord;
}

// ── M18 판단 이유 ledger append-only tables ──

/**
 * 판단 이유 ledger의 frame 단위 append-only 기록 table interface.
 *
 * runner가 한 번의 feature → strategy → gate → broker 흐름을 평가한 뒤 남기는 최상위 단위로,
 * `dedupe_key` unique constraint로 같은 frame/source/correlation 재실행 중복 append를 차단한다.
 * 모든 column은 append-only이며 update/delete를 허용하지 않는다.
 */
export interface DecisionLedgerFramesTable {
  /** frame record ID */
  id: Generated<string>;
  /** M18 contract version literal. 예: `"m18.decision_ledger.v1"` */
  ledger_version: DecisionLedgerVersion;
  /** runner 또는 runtime 실행 단위 식별자. 알 수 없으면 null */
  source_run_id: string | null;
  /** `PaperDecisionInputFrame.id`. runner 입력 frame 식별자 */
  source_frame_id: string;
  /** 거래소 식별자. 예: `"UPBIT"` */
  exchange: string;
  /** market code. cash/global 판단이면 null */
  market: string | null;
  /** strategy 식별자. cash/global 판단이면 null */
  strategy_id: string | null;
  /** 안정 판단 범주. LLM 장애 전용 EXPLANATION_FAILED는 포함하지 않는다. */
  category: DecisionFrameCategory;
  /** frame 기록/조회 상태 */
  summary_status: SummaryStatus;
  /** 시장/feature frame 관측 시각 */
  observed_at: Timestamp;
  /** 판단이 확정된 시각 */
  decision_at: Timestamp;
  /** 주문, risk, execution evidence와 연결하는 stable id. 없으면 null */
  correlation_id: string | null;
  /** hold/discard/cost/risk/execution reason count. key는 reason code, value는 count */
  reason_counts_json: GeneratedJsonRecord;
  /** frame summary metadata. Category, 최신 evidence 요약, trace link */
  summary_json: GeneratedJsonRecord;
  /** 내부 id, fingerprint, source table 같은 JSON-safe 추적 정보 */
  trace_json: GeneratedJsonRecord;
  /** 같은 frame/source/correlation 재실행 중복 append를 차단하는 deterministic key */
  dedupe_key: string;
  /** DB record 생성 시각 */
  created_at: GeneratedTimestamp;
}

/**
 * frame 아래 append-only evidence table interface.
 *
 * `evidence_fingerprint` unique constraint로 중복 append를 차단한다.
 * EXPLANATION_FAILURE evidence는 category EXPLANATION_FAILED와만 조합하고,
 * 다른 evidence kind는 EXPLANATION_FAILED category를 가질 수 없다.
 */
export interface DecisionLedgerEvidenceTable {
  /** evidence record ID */
  id: Generated<string>;
  /** 상위 frame ID */
  frame_id: string;
  /** 근거 종류. STRATEGY_DECISION, ORDER_INTENT, DISCARD_REASON, COST_BREAKDOWN, RISK_DECISION, EXECUTION_RESULT, PNL_STATUS_CONTEXT, EXPLANATION_SUMMARY, EXPLANATION_FAILURE 중 하나 */
  evidence_kind: EvidenceKind;
  /** 연관 판단 범주. EXPLANATION_FAILURE evidence는 EXPLANATION_FAILED만 허용 */
  category: DecisionCategory;
  /** 내부 reason code. 사용자-facing 문구는 user_message에 분리 */
  reason_code: string | null;
  /** 사용자-facing 한국어 상태 메시지 */
  user_message: string;
  /** 한국어 영향 설명. 없으면 null */
  impact: string | null;
  /** 한국어 필요 조치. 없으면 null */
  action: string | null;
  /** 근거 출처 시스템/모듈명 */
  source: string;
  /** 근거 출처 내부 식별자. 없으면 null */
  source_id: string | null;
  /** 근거 상세 payload. raw provider payload, secret, token을 포함하지 않는다. */
  payload_json: GeneratedJsonRecord;
  /** 내부 id, 상위 frame id, correlation id 같은 JSON-safe 추적 정보 */
  trace_json: GeneratedJsonRecord;
  /** evidence 중복 append를 차단하는 deterministic fingerprint */
  evidence_fingerprint: string;
  /** 근거가 발생한 시각 */
  occurred_at: Timestamp;
  /** DB record 생성 시각 */
  created_at: GeneratedTimestamp;
}
