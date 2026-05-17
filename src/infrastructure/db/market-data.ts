import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Insertable, Selectable } from "kysely";
import type {
  JsonRecord,
  OrderbookEvent,
  OrderbookLevel,
  TimestampInput,
  TradeEvent,
} from "../../domain/index.js";
import type { UpbitPublicPolicySnapshot } from "../upbit/index.js";
import type { Database } from "./database.js";
import type {
  OrderbookMetricsTable,
  OrderbookSnapshotsTable,
  PolicySnapshotsTable,
  TradesTable,
} from "./schema.js";

const orderbookMetricBucketMs = 1_000;
const orderbookSnapshotCadenceMs = 5_000;

/** DB에서 조회한 정책 snapshot row다. */
export type PolicySnapshotRecord = Selectable<PolicySnapshotsTable>;
/** DB에서 조회한 체결 stream row다. */
export type TradeRecord = Selectable<TradesTable>;
/** DB에서 조회한 1초 orderbook metric row다. */
export type OrderbookMetricRecord = Selectable<OrderbookMetricsTable>;
/** DB에서 조회한 5초 orderbook snapshot row다. */
export type OrderbookSnapshotRecord = Selectable<OrderbookSnapshotsTable>;

/** 정책 snapshot 저장 입력이다. */
export interface SavePolicySnapshotInput {
  exchange: string;
  market?: string | null;
  sourceProfile: string;
  payloadJson: JsonRecord;
  effectiveAt: TimestampInput;
  capturedAt?: TimestampInput;
  checksum?: string;
}

/** 정책 snapshot 저장 결과다. */
export interface SavePolicySnapshotResult {
  snapshot: PolicySnapshotRecord;
  created: boolean;
}

/** Upbit public policy snapshot을 DB 저장 입력으로 변환하는 옵션이다. */
export interface UpbitPolicySnapshotPersistenceOptions {
  sourceProfile?: string;
  effectiveAt?: TimestampInput;
  capturedAt?: TimestampInput;
}

/** orderbook metric row 생성 옵션이다. */
export interface OrderbookMetricInputOptions {
  bucketAt?: TimestampInput;
  websocketLagMs?: number;
  reconnectCount?: number;
}

/** orderbook snapshot row 생성 옵션이다. */
export interface OrderbookSnapshotInputOptions {
  capturedAt?: TimestampInput;
}

/**
 * Upbit public policy snapshot을 `policy_snapshots` 저장 입력으로 변환한다.
 *
 * public REST와 orderbook instruments에서 확정한 market status, 호가 정책, rate-limit 근거를 하나의 JSON
 * payload로 보존한다. checksum은 canonical JSON 기준으로 만들어 같은 정책 payload의 중복 저장을 막는다.
 */
export function toPolicySnapshotInput(
  snapshot: UpbitPublicPolicySnapshot,
  options: UpbitPolicySnapshotPersistenceOptions = {},
): SavePolicySnapshotInput {
  const effectiveAt = options.effectiveAt ?? snapshot.capturedAt;
  const capturedAt = options.capturedAt ?? snapshot.capturedAt;
  const payloadJson = {
    kind: "upbit_public_policy_snapshot",
    snapshot,
  };

  return {
    exchange: snapshot.exchangeId,
    market: snapshot.market,
    sourceProfile: options.sourceProfile ?? "PAPER_NO_KEY:UPBIT_PUBLIC_POLICY",
    payloadJson,
    effectiveAt,
    capturedAt,
    checksum: checksumJson(payloadJson),
  };
}

/**
 * 정책 snapshot을 idempotent하게 저장한다.
 *
 * DB unique index는 market별 정책과 거래소 공통 정책의 null market을 분리한다. insert conflict가 나면
 * 기존 row를 다시 조회해 caller가 같은 checksum의 snapshot ID를 안정적으로 참조하게 한다.
 */
export async function savePolicySnapshot(
  database: Database,
  input: SavePolicySnapshotInput,
): Promise<SavePolicySnapshotResult> {
  const values = toPolicySnapshotRow(input);
  const conflict = values.market === null
    ? ["exchange", "source_profile", "checksum"] as const
    : ["exchange", "market", "source_profile", "checksum"] as const;
  const inserted = await database
    .insertInto("policy_snapshots")
    .values(values)
    .onConflict((onConflict) =>
      values.market === null
        ? onConflict.columns(conflict).where("market", "is", null).doNothing()
        : onConflict.columns(conflict).where("market", "is not", null).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();

  if (inserted !== undefined) {
    return {
      snapshot: inserted,
      created: true,
    };
  }

  const existing = await findPolicySnapshotByChecksum(database, values);
  if (existing === undefined) {
    throw new Error("policy snapshot insert conflicted but existing row was not found");
  }

  return {
    snapshot: existing,
    created: false,
  };
}

/**
 * 체결 이벤트를 `trades` 저장 row로 변환한다.
 *
 * Upbit WebSocket의 `BID`/`ASK` 체결 방향은 DB의 거래 방향 contract에 맞춰 `BUY`/`SELL`로 바꾼다.
 * 원천 payload는 trade idempotency와 장애 분석을 위해 `raw_payload_json`에 그대로 보존한다.
 */
export function toTradeRow(event: TradeEvent): Insertable<TradesTable> {
  return {
    exchange: event.exchangeId,
    market: event.market,
    trade_id: event.tradeId,
    side: toTradeRowSide(event.side),
    price: event.price,
    volume: event.quantity,
    exchange_timestamp: event.exchangeTimestamp,
    received_at: event.receivedAt,
    raw_payload_json: event.raw ?? {},
  };
}

/**
 * 체결 이벤트를 idempotent하게 저장한다.
 *
 * `exchange + market + trade_id + exchange_timestamp` primary key가 같은 체결은 다시 저장하지 않고 기존 row를
 * 반환한다. WebSocket 재연결이나 fixture replay가 같은 체결을 반복해도 downstream candle/backtest 입력이
 * 중복되지 않게 하는 경계다.
 */
export async function insertTrade(
  database: Database,
  event: TradeEvent,
): Promise<{
  trade: TradeRecord;
  created: boolean;
}> {
  const row = toTradeRow(event);
  const inserted = await database
    .insertInto("trades")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["exchange", "market", "trade_id", "exchange_timestamp"]).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();

  if (inserted !== undefined) {
    return {
      trade: inserted,
      created: true,
    };
  }

  const existing = await database
    .selectFrom("trades")
    .selectAll()
    .where("exchange", "=", row.exchange)
    .where("market", "=", row.market)
    .where("trade_id", "=", row.trade_id)
    .where("exchange_timestamp", "=", toDate(row.exchange_timestamp))
    .executeTakeFirst();

  if (existing === undefined) {
    throw new Error("trade insert conflicted but existing row was not found");
  }

  return {
    trade: existing,
    created: false,
  };
}

/**
 * 호가 이벤트를 1초 bucket metric row로 변환한다.
 *
 * best bid/ask, spread bps, depth, imbalance를 같은 시점의 orderbook에서 계산한다. bucket 안에 여러 이벤트가
 * 있으면 repository upsert가 최신 row로 갱신하므로, 비용/리스크 모델은 초 단위 최신 호가 상태를 읽는다.
 */
export function toOrderbookMetricRow(
  event: OrderbookEvent,
  options: OrderbookMetricInputOptions = {},
): Insertable<OrderbookMetricsTable> {
  assertOrderbookHasLevels(event);

  const bestBidPrice = event.bids[0]!.price;
  const bestAskPrice = event.asks[0]!.price;
  const bidDepth1 = sumDepth(event.bids, 1);
  const askDepth1 = sumDepth(event.asks, 1);
  const bidDepth5 = sumDepth(event.bids, 5);
  const askDepth5 = sumDepth(event.asks, 5);
  const bidDepth15 = sumDepth(event.bids, 15);
  const askDepth15 = sumDepth(event.asks, 15);

  return {
    exchange: event.exchangeId,
    market: event.market,
    bucket_at: options.bucketAt ?? floorTimestamp(event.exchangeTimestamp, orderbookMetricBucketMs),
    best_bid_price: bestBidPrice,
    best_ask_price: bestAskPrice,
    spread_bps: calculateSpreadBps(bestBidPrice, bestAskPrice),
    bid_depth_1: bidDepth1,
    ask_depth_1: askDepth1,
    bid_depth_5: bidDepth5,
    ask_depth_5: askDepth5,
    bid_depth_15: bidDepth15,
    ask_depth_15: askDepth15,
    imbalance_5: calculateImbalance(bidDepth5, askDepth5),
    imbalance_15: calculateImbalance(bidDepth15, askDepth15),
    websocket_lag_ms: options.websocketLagMs ?? calculateWebSocketLagMs(event),
    reconnect_count: options.reconnectCount ?? 0,
  };
}

/**
 * 1초 orderbook metric row를 upsert한다.
 *
 * 같은 bucket에 들어온 새 WebSocket 이벤트는 기존 metric row를 갱신한다. 이렇게 해야 collector 재시도나
 * 같은 초 안의 추가 tick이 primary key 충돌로 중단되지 않고 최신 비용/리스크 입력으로 반영된다.
 */
export async function upsertOrderbookMetric(
  database: Database,
  event: OrderbookEvent,
  options: OrderbookMetricInputOptions = {},
): Promise<OrderbookMetricRecord> {
  const row = toOrderbookMetricRow(event, options);

  return database
    .insertInto("orderbook_metrics")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["exchange", "market", "bucket_at"]).doUpdateSet({
        best_bid_price: row.best_bid_price,
        best_ask_price: row.best_ask_price,
        spread_bps: row.spread_bps,
        bid_depth_1: row.bid_depth_1,
        ask_depth_1: row.ask_depth_1,
        bid_depth_5: row.bid_depth_5,
        ask_depth_5: row.ask_depth_5,
        bid_depth_15: row.bid_depth_15,
        ask_depth_15: row.ask_depth_15,
        imbalance_5: row.imbalance_5,
        imbalance_15: row.imbalance_15,
        websocket_lag_ms: row.websocket_lag_ms,
        reconnect_count: row.reconnect_count,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * 호가 이벤트를 5초 snapshot row로 변환한다.
 *
 * bid/ask 배열은 `{ levels: [...] }` 형태로 보존한다. DB row가 metric으로 축약하지 못하는 slippage 추정,
 * paper fill model, 장애 분석의 원천 입력이 되도록 raw payload도 함께 저장한다.
 */
export function toOrderbookSnapshotRow(
  event: OrderbookEvent,
  options: OrderbookSnapshotInputOptions = {},
): Insertable<OrderbookSnapshotsTable> {
  assertOrderbookHasLevels(event);

  return {
    exchange: event.exchangeId,
    market: event.market,
    captured_at: options.capturedAt ?? floorTimestamp(event.exchangeTimestamp, orderbookSnapshotCadenceMs),
    bids_json: {
      levels: event.bids,
    },
    asks_json: {
      levels: event.asks,
    },
    raw_payload_json: event.raw ?? {},
  };
}

/**
 * 5초 orderbook snapshot row를 upsert한다.
 *
 * 같은 5초 cadence 안에서 여러 호가 이벤트가 들어오면 최신 snapshot으로 갱신한다. worker가 재연결 후 같은
 * 구간을 replay해도 snapshot table의 row grain을 유지하게 하는 저장 경계다.
 */
export async function upsertOrderbookSnapshot(
  database: Database,
  event: OrderbookEvent,
  options: OrderbookSnapshotInputOptions = {},
): Promise<OrderbookSnapshotRecord> {
  const row = toOrderbookSnapshotRow(event, options);

  return database
    .insertInto("orderbook_snapshots")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["exchange", "market", "captured_at"]).doUpdateSet({
        bids_json: row.bids_json,
        asks_json: row.asks_json,
        raw_payload_json: row.raw_payload_json,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

function toPolicySnapshotRow(input: SavePolicySnapshotInput): Insertable<PolicySnapshotsTable> {
  const payloadJson = input.payloadJson;

  return {
    exchange: input.exchange,
    market: input.market ?? null,
    source_profile: input.sourceProfile,
    checksum: input.checksum ?? checksumJson(payloadJson),
    payload_json: payloadJson,
    effective_at: input.effectiveAt,
    ...(input.capturedAt === undefined ? {} : { captured_at: input.capturedAt }),
  };
}

function findPolicySnapshotByChecksum(
  database: Database,
  row: Insertable<PolicySnapshotsTable>,
): Promise<PolicySnapshotRecord | undefined> {
  const market = row.market ?? null;
  let query = database
    .selectFrom("policy_snapshots")
    .selectAll()
    .where("exchange", "=", row.exchange)
    .where("source_profile", "=", row.source_profile)
    .where("checksum", "=", row.checksum);

  query = market === null ? query.where("market", "is", null) : query.where("market", "=", market);

  return query.executeTakeFirst();
}

function toTradeRowSide(side: TradeEvent["side"]): TradesTable["side"] {
  if (side === "BID") {
    return "BUY";
  }

  if (side === "ASK") {
    return "SELL";
  }

  return "UNKNOWN";
}

function assertOrderbookHasLevels(event: OrderbookEvent): void {
  if (event.bids.length === 0 || event.asks.length === 0) {
    throw new Error("orderbook event requires at least one bid and ask level");
  }
}

function sumDepth(levels: readonly OrderbookLevel[], count: number): string {
  return levels
    .slice(0, count)
    .reduce((sum, level) => sum.plus(level.size), new Decimal(0))
    .toFixed();
}

function calculateSpreadBps(bestBidPrice: string, bestAskPrice: string): string {
  const bid = new Decimal(bestBidPrice);
  const ask = new Decimal(bestAskPrice);
  const mid = bid.plus(ask).div(2);

  if (mid.lte(0) || ask.lt(bid)) {
    throw new Error("orderbook best ask must be greater than or equal to best bid");
  }

  return ask.minus(bid).div(mid).mul(10_000).toFixed(6);
}

function calculateImbalance(bidDepth: string, askDepth: string): string {
  const bid = new Decimal(bidDepth);
  const ask = new Decimal(askDepth);
  const total = bid.plus(ask);

  if (total.eq(0)) {
    return "0.00000000";
  }

  return bid.minus(ask).div(total).toFixed(8);
}

function calculateWebSocketLagMs(event: OrderbookEvent): number {
  const lagMs = timestampToMilliseconds(event.receivedAt) - timestampToMilliseconds(event.exchangeTimestamp);

  if (lagMs < 0) {
    throw new Error(`orderbook receivedAt is earlier than exchangeTimestamp: ${lagMs}`);
  }

  return lagMs;
}

function floorTimestamp(timestamp: TimestampInput, bucketMs: number): string {
  const milliseconds = timestampToMilliseconds(timestamp);
  return new Date(Math.floor(milliseconds / bucketMs) * bucketMs).toISOString();
}

function timestampToMilliseconds(timestamp: TimestampInput): number {
  const milliseconds = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);

  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid timestamp: ${String(timestamp)}`);
  }

  return milliseconds;
}

function toDate(timestamp: Date | string): Date {
  return timestamp instanceof Date ? timestamp : new Date(timestamp);
}

function checksumJson(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    throw new Error("JSON payload cannot contain undefined values");
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
