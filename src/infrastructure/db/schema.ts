import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type GeneratedJsonRecord = ColumnType<JsonRecord, JsonRecord | undefined, JsonRecord>;
type GeneratedNumericString = ColumnType<NumericString, NumericString | undefined, NumericString>;
type NumericString = string;
type JsonRecord = Record<string, unknown>;

export interface DatabaseSchema {
  schema_migrations: SchemaMigrationsTable;
  orders: OrdersTable;
  paper_orders: PaperOrdersTable;
  fills: FillsTable;
  positions: PositionsTable;
  audit_events: AuditEventsTable;
  risk_events: RiskEventsTable;
  jobs: JobsTable;
  policy_snapshots: PolicySnapshotsTable;
  trades: TradesTable;
  orderbook_metrics: OrderbookMetricsTable;
  orderbook_snapshots: OrderbookSnapshotsTable;
  candles: CandlesTable;
  pnl_snapshots: PnlSnapshotsTable;
  strategy_signals: StrategySignalsTable;
}

export interface SchemaMigrationsTable {
  version: number;
  filename: string;
  checksum: string;
  applied_at: GeneratedTimestamp;
}

export interface OrdersTable {
  id: Generated<string>;
  exchange: string;
  market: string;
  strategy_id: string;
  side: "BUY" | "SELL";
  order_type: "LIMIT" | "MARKET";
  status: string;
  idempotency_key: string;
  requested_price: NumericString | null;
  requested_quantity: NumericString;
  requested_notional: NumericString;
  reason_json: GeneratedJsonRecord;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PaperOrdersTable {
  order_id: string;
  post_only: Generated<boolean>;
  time_in_force: string | null;
  simulated_latency_ms: number | null;
  fill_model_json: GeneratedJsonRecord;
  submitted_at: NullableTimestamp;
  accepted_at: NullableTimestamp;
  completed_at: NullableTimestamp;
}

export interface FillsTable {
  id: Generated<string>;
  order_id: string;
  exchange: string;
  market: string;
  side: "BUY" | "SELL";
  price: NumericString;
  quantity: NumericString;
  fee: NumericString;
  fee_currency: string;
  liquidity: "MAKER" | "TAKER" | "SIMULATED";
  filled_at: Timestamp;
  created_at: GeneratedTimestamp;
}

export interface PositionsTable {
  id: Generated<string>;
  exchange: string;
  market: string;
  strategy_id: string;
  quantity: NumericString;
  average_entry_price: NumericString;
  realized_pnl: GeneratedNumericString;
  unrealized_pnl: GeneratedNumericString;
  updated_at: GeneratedTimestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  event_type: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
  order_id: string | null;
  correlation_id: string | null;
  payload_json: GeneratedJsonRecord;
  occurred_at: GeneratedTimestamp;
}

export interface RiskEventsTable {
  id: Generated<string>;
  risk_type: string;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  market: string | null;
  strategy_id: string | null;
  order_id: string | null;
  action: string;
  payload_json: GeneratedJsonRecord;
  occurred_at: GeneratedTimestamp;
}

export interface JobsTable {
  id: Generated<string>;
  job_type: string;
  idempotency_key: string;
  payload_json: GeneratedJsonRecord;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";
  run_after: GeneratedTimestamp;
  locked_at: NullableTimestamp;
  locked_by: string | null;
  attempt_count: Generated<number>;
  max_attempts: Generated<number>;
  last_error: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PolicySnapshotsTable {
  id: Generated<string>;
  exchange: string;
  market: string | null;
  source_profile: string;
  checksum: string;
  payload_json: JsonRecord;
  effective_at: Timestamp;
  captured_at: GeneratedTimestamp;
}

export interface TradesTable {
  exchange: string;
  market: string;
  trade_id: string;
  side: "BUY" | "SELL" | "UNKNOWN";
  price: NumericString;
  volume: NumericString;
  exchange_timestamp: Timestamp;
  received_at: Timestamp;
  raw_payload_json: GeneratedJsonRecord;
}

export interface OrderbookMetricsTable {
  exchange: string;
  market: string;
  bucket_at: Timestamp;
  best_bid_price: NumericString;
  best_ask_price: NumericString;
  spread_bps: NumericString;
  bid_depth_1: NumericString;
  ask_depth_1: NumericString;
  bid_depth_5: NumericString;
  ask_depth_5: NumericString;
  bid_depth_15: NumericString;
  ask_depth_15: NumericString;
  imbalance_5: NumericString;
  imbalance_15: NumericString;
  websocket_lag_ms: number | null;
  reconnect_count: Generated<number>;
  created_at: GeneratedTimestamp;
}

export interface OrderbookSnapshotsTable {
  exchange: string;
  market: string;
  captured_at: Timestamp;
  bids_json: JsonRecord;
  asks_json: JsonRecord;
  raw_payload_json: GeneratedJsonRecord;
}

export interface CandlesTable {
  exchange: string;
  market: string;
  timeframe: "1m" | "5m" | "1h";
  bucket_at: Timestamp;
  open_price: NumericString;
  high_price: NumericString;
  low_price: NumericString;
  close_price: NumericString;
  volume: NumericString;
  trade_count: Generated<number>;
}

export interface PnlSnapshotsTable {
  strategy_id: string;
  market: string | null;
  captured_at: Timestamp;
  equity: NumericString;
  realized_pnl: NumericString;
  unrealized_pnl: NumericString;
  drawdown_bps: NumericString;
  payload_json: GeneratedJsonRecord;
}

export interface StrategySignalsTable {
  strategy_id: string;
  market: string;
  signal_id: string;
  decision: "BUY" | "SELL" | "HOLD" | "BLOCK";
  expected_return_bps: NumericString | null;
  payload_json: GeneratedJsonRecord;
  generated_at: Timestamp;
}
