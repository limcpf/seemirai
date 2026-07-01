import type { JsonRecord, MarketDataEvent, OrderbookEvent, OrderbookLevel, TradeEvent } from "../../domain/index.js";
import type { Database, OrderbookSnapshotRecord, TradeRecord } from "../../infrastructure/index.js";
import type {
  LiveOpsDbBackedFeatureWindow,
  LiveOpsDbBackedFeatureWindowQuery,
  LiveOpsDbBackedFeatureWindowReader,
} from "./service.js";

const DB_FEATURE_WINDOW_READER_SOURCE = "live_ops_db_feature_window_reader";

/**
 * PostgreSQL market-data table을 읽는 live ops DB-backed feature window reader를 만든다.
 *
 * 호출 경계는 runtime provider와 Kysely DB handle 사이이며, `trades`와 `orderbook_snapshots`만 durable source로
 * 조회한다. public tick fallback, broker read, DB write side effect는 수행하지 않고, 조회된 row는 domain
 * `MarketDataEvent`로 복원해 feature calculator가 기존 검증 경계를 그대로 쓰게 한다.
 */
export function createDatabaseLiveOpsDbBackedFeatureWindowReader(
  database: Database,
): LiveOpsDbBackedFeatureWindowReader {
  return {
    async loadLiveOpsFeatureWindow(query: LiveOpsDbBackedFeatureWindowQuery): Promise<LiveOpsDbBackedFeatureWindow> {
      const windowStartAt = new Date(query.windowStartAt);
      const windowEndAt = new Date(query.windowEndAt);
      // feature source는 durable DB window로 고정해 runtime public tick fallback과 암묵적으로 섞이지 않게 한다.
      const [tradeRows, orderbookRows] = await Promise.all([
        database
          .selectFrom("trades")
          .selectAll()
          .where("exchange", "=", query.exchangeId)
          .where("market", "=", query.market)
          .where("exchange_timestamp", ">=", windowStartAt)
          .where("exchange_timestamp", "<=", windowEndAt)
          .orderBy("exchange_timestamp", "asc")
          .orderBy("trade_id", "asc")
          .execute(),
        database
          .selectFrom("orderbook_snapshots")
          .selectAll()
          .where("exchange", "=", query.exchangeId)
          .where("market", "=", query.market)
          .where("captured_at", ">=", windowStartAt)
          .where("captured_at", "<=", windowEndAt)
          .orderBy("captured_at", "asc")
          .execute(),
      ]);
      const events = [
        ...tradeRows.map(toLiveOpsDbFeatureWindowTradeEvent),
        ...orderbookRows.map(toLiveOpsDbFeatureWindowOrderbookEvent),
      ].sort(compareMarketDataEvents);

      return {
        events,
        metadata: {
          rowCounts: {
            orderbooks: orderbookRows.length,
            trades: tradeRows.length,
          },
          source: DB_FEATURE_WINDOW_READER_SOURCE,
        },
      };
    },
  };
}

function toLiveOpsDbFeatureWindowTradeEvent(row: TradeRecord): TradeEvent {
  const exchangeTimestamp = timestampToIso(row.exchange_timestamp);
  const receivedAt = timestampToIso(row.received_at);

  return {
    type: "TRADE",
    exchangeId: row.exchange,
    market: row.market,
    tradeId: row.trade_id,
    price: row.price,
    quantity: row.volume,
    side: toTradeEventSide(row.side),
    exchangeTimestamp,
    receivedAt,
    raw: row.raw_payload_json,
    sequence: `trade:${exchangeTimestamp}:${row.trade_id}`,
    tieBreakKey: `db:trade:${row.exchange}:${row.market}:${exchangeTimestamp}:${row.trade_id}`,
  };
}

function toLiveOpsDbFeatureWindowOrderbookEvent(row: OrderbookSnapshotRecord): OrderbookEvent {
  const capturedAt = timestampToIso(row.captured_at);

  return {
    type: "ORDERBOOK",
    exchangeId: row.exchange,
    market: row.market,
    asks: readOrderbookLevels(row.asks_json, "asks_json"),
    bids: readOrderbookLevels(row.bids_json, "bids_json"),
    exchangeTimestamp: capturedAt,
    receivedAt: capturedAt,
    raw: row.raw_payload_json,
    sequence: `orderbook:${capturedAt}`,
    tieBreakKey: `db:orderbook:${row.exchange}:${row.market}:${capturedAt}`,
  };
}

function toTradeEventSide(side: TradeRecord["side"]): TradeEvent["side"] {
  if (side === "BUY") {
    return "BID";
  }

  if (side === "SELL") {
    return "ASK";
  }

  return "UNKNOWN";
}

function readOrderbookLevels(payload: JsonRecord, columnName: string): readonly OrderbookLevel[] {
  if (!isRecord(payload) || !Array.isArray(payload.levels)) {
    throw new Error(`${columnName} must contain levels array`);
  }

  return payload.levels.map((level, index) => {
    if (!isRecord(level) || typeof level.price !== "string" || typeof level.size !== "string") {
      throw new Error(`${columnName}.levels[${index}] must contain price and size strings`);
    }

    return {
      price: level.price,
      size: level.size,
    };
  });
}

function compareMarketDataEvents(left: MarketDataEvent, right: MarketDataEvent): number {
  const leftTimestamp = Date.parse(readEventTimestamp(left));
  const rightTimestamp = Date.parse(readEventTimestamp(right));

  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  return (left.tieBreakKey ?? "").localeCompare(right.tieBreakKey ?? "");
}

function readEventTimestamp(event: MarketDataEvent): string {
  const timestamp = event.type === "STATUS" ? event.observedAt : event.exchangeTimestamp;
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function timestampToIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid DB feature window timestamp: ${String(value)}`);
  }

  return date.toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
