import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  createDatabaseLiveOpsDbBackedFeatureWindowReader,
  loadLiveOpsDbBackedFeatureSnapshot,
} from "../../src/runtime/index.js";
import type {
  LiveOpsDbBackedFeatureWindow,
  LiveOpsDbBackedFeatureWindowQuery,
  LiveOpsDbBackedFeatureWindowReader,
} from "../../src/runtime/index.js";
import type { MarketDataEvent, OrderbookEvent, TradeEvent } from "../../src/domain/index.js";
import type { Database } from "../../src/infrastructure/index.js";

type TestEventOrderFields = {
  sequence: string;
  tieBreakKey: string;
};

describe("live ops DB-backed feature provider", () => {
  it("loads a DB window first and returns autonomous strategy features without fallback filling", async () => {
    const reader = new FakeFeatureWindowReader(createFeatureFixtureEvents());

    const snapshot = await loadLiveOpsDbBackedFeatureSnapshot({
      reader,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-05-25T00:21:00.000Z",
      windowMs: 21 * 60_000,
      minTradeCount: 20,
      minOrderbookCount: 2,
      maxLatestEventLagMs: 30_000,
      cost: createCostInput(),
    });

    expect(reader.queries).toEqual([
      {
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        windowStartAt: "2026-05-25T00:00:00.000Z",
        windowEndAt: "2026-05-25T00:21:00.000Z",
      },
    ]);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.failureReasons).toEqual([]);
    expect(snapshot.features).toMatchObject({
      cost_adjusted_margin_bps: "14.5",
      mean_reversion_discount_bps: "0",
      trend_strength_bps: "1000",
    });
    expect(snapshot.metadata).toMatchObject({
      source: "live_ops_db_window",
      sampleCounts: {
        orderbooks: 21,
        total: 42,
        trades: 21,
      },
      windowEndAt: "2026-05-25T00:21:00.000Z",
      windowStartAt: "2026-05-25T00:00:00.000Z",
    });
  });

  it("fails closed before calculation when DB samples are insufficient", async () => {
    const reader = new FakeFeatureWindowReader([createOrderbook("2026-05-25T00:21:00.000Z", "1")]);

    const snapshot = await loadLiveOpsDbBackedFeatureSnapshot({
      reader,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-05-25T00:21:00.000Z",
      windowMs: 21 * 60_000,
      minTradeCount: 20,
      minOrderbookCount: 2,
      cost: createCostInput(),
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.features).toEqual({});
    expect(snapshot.failureReasons).toHaveLength(15);
    expect(snapshot.failureReasons.every((failure) => failure.reasonCode === "FEATURE_INSUFFICIENT_INPUT")).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      source: "live_ops_db_window",
      sampleCounts: {
        orderbooks: 1,
        total: 1,
        trades: 0,
      },
    });
  });

  it("fails closed when the latest DB event is stale at the decision timestamp", async () => {
    const reader = new FakeFeatureWindowReader(createFeatureFixtureEvents());

    const snapshot = await loadLiveOpsDbBackedFeatureSnapshot({
      reader,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-05-25T00:22:00.000Z",
      windowMs: 21 * 60_000,
      minTradeCount: 20,
      minOrderbookCount: 2,
      maxLatestEventLagMs: 30_000,
      cost: createCostInput(),
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.features).toEqual({});
    expect(snapshot.failureReasons).toHaveLength(15);
    expect(snapshot.failureReasons.every((failure) => failure.reasonCode === "FEATURE_MARKET_DATA_STALE")).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      latestEventAt: "2026-05-25T00:21:00.000Z",
      latestEventLagMs: 60_000,
      source: "live_ops_db_window",
    });
  });

  it("fails closed when trades are stale even if orderbooks are fresh", async () => {
    const events = createFeatureFixtureEvents().filter((event) => event.type !== "TRADE" || event.tradeId !== "trade-21");
    const reader = new FakeFeatureWindowReader(events);

    const snapshot = await loadLiveOpsDbBackedFeatureSnapshot({
      reader,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-05-25T00:21:00.000Z",
      windowMs: 21 * 60_000,
      minTradeCount: 20,
      minOrderbookCount: 2,
      maxLatestEventLagMs: 30_000,
      cost: createCostInput(),
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.features).toEqual({});
    expect(snapshot.failureReasons).toHaveLength(15);
    expect(snapshot.failureReasons.every((failure) => failure.reasonCode === "FEATURE_MARKET_DATA_STALE")).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      latestEventAt: "2026-05-25T00:21:00.000Z",
      latestEventLagMs: 0,
      latestTradeEventAt: "2026-05-25T00:20:00.000Z",
      latestTradeEventLagMs: 60_000,
      source: "live_ops_db_window",
    });
  });

  it("keeps mixed-market DB contamination as an invalid feature snapshot instead of falling back", async () => {
    const events = createFeatureFixtureEvents();
    const firstTradeIndex = events.findIndex((event) => event.type === "TRADE");
    events.splice(firstTradeIndex, 1, {
      ...events[firstTradeIndex]!,
      market: "KRW-ETH",
    } as TradeEvent & TestEventOrderFields);
    const reader = new FakeFeatureWindowReader(events);

    const snapshot = await loadLiveOpsDbBackedFeatureSnapshot({
      reader,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-05-25T00:21:00.000Z",
      windowMs: 21 * 60_000,
      minTradeCount: 20,
      minOrderbookCount: 2,
      maxLatestEventLagMs: 30_000,
      cost: createCostInput(),
    });

    expect(snapshot.status).toBe("failed");
    expect(snapshot.features).toEqual({});
    expect(snapshot.failureReasons).toHaveLength(15);
    expect(snapshot.failureReasons.every((failure) => failure.reasonCode === "FEATURE_INVALID_MARKET_VALUE")).toBe(true);
    expect(snapshot.metadata).toMatchObject({
      source: "live_ops_db_window",
    });
  });

  it("reads trades and orderbook snapshots from the DB window as feature events", async () => {
    const fake = createFakeFeatureWindowDatabase({
      trades: [
        {
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          trade_id: "trade-db-1",
          side: "BUY",
          price: "100",
          volume: "1",
          exchange_timestamp: new Date("2026-05-25T00:20:59.000Z"),
          received_at: new Date("2026-05-25T00:21:00.000Z"),
          raw_payload_json: { source: "db-trade" },
        },
      ],
      orderbook_snapshots: [
        {
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          captured_at: new Date("2026-05-25T00:21:00.000Z"),
          bids_json: { levels: [{ price: "100", size: "2" }] },
          asks_json: { levels: [{ price: "101", size: "3" }] },
          raw_payload_json: { source: "db-orderbook" },
        },
      ],
    });
    const reader = createDatabaseLiveOpsDbBackedFeatureWindowReader(fake.database);

    const window = await reader.loadLiveOpsFeatureWindow({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      windowStartAt: "2026-05-25T00:00:00.000Z",
      windowEndAt: "2026-05-25T00:21:00.000Z",
    });

    expect(fake.calls).toMatchObject([
      {
        orderBys: [["exchange_timestamp", "asc"], ["trade_id", "asc"]],
        table: "trades",
        wheres: [
          ["exchange", "=", "upbit_krw_spot"],
          ["market", "=", "KRW-BTC"],
          ["exchange_timestamp", ">=", new Date("2026-05-25T00:00:00.000Z")],
          ["exchange_timestamp", "<=", new Date("2026-05-25T00:21:00.000Z")],
        ],
      },
      {
        orderBys: [["captured_at", "asc"]],
        table: "orderbook_snapshots",
        wheres: [
          ["exchange", "=", "upbit_krw_spot"],
          ["market", "=", "KRW-BTC"],
          ["captured_at", ">=", new Date("2026-05-25T00:00:00.000Z")],
          ["captured_at", "<=", new Date("2026-05-25T00:21:00.000Z")],
        ],
      },
    ]);
    expect(window.events).toMatchObject([
      {
        exchangeId: "upbit_krw_spot",
        exchangeTimestamp: "2026-05-25T00:20:59.000Z",
        market: "KRW-BTC",
        price: "100",
        quantity: "1",
        receivedAt: "2026-05-25T00:21:00.000Z",
        side: "BID",
        tradeId: "trade-db-1",
        type: "TRADE",
      },
      {
        asks: [{ price: "101", size: "3" }],
        bids: [{ price: "100", size: "2" }],
        exchangeId: "upbit_krw_spot",
        exchangeTimestamp: "2026-05-25T00:21:00.000Z",
        market: "KRW-BTC",
        receivedAt: "2026-05-25T00:21:00.000Z",
        type: "ORDERBOOK",
      },
    ]);
    expect(window.metadata).toMatchObject({
      rowCounts: {
        orderbooks: 1,
        trades: 1,
      },
      source: "live_ops_db_feature_window_reader",
    });
  });
});

class FakeFeatureWindowReader implements LiveOpsDbBackedFeatureWindowReader {
  public readonly queries: LiveOpsDbBackedFeatureWindowQuery[] = [];

  public constructor(private readonly events: readonly MarketDataEvent[]) {}

  public async loadLiveOpsFeatureWindow(
    query: LiveOpsDbBackedFeatureWindowQuery,
  ): Promise<LiveOpsDbBackedFeatureWindow> {
    this.queries.push(query);

    return {
      events: this.events,
      metadata: {
        rowCount: this.events.length,
      },
    };
  }
}

function createFeatureFixtureEvents(): MarketDataEvent[] {
  const events: MarketDataEvent[] = createOrderbookBaselineEvents({ baselineSize: "0.5", currentSize: "1" });

  for (let minute = 1; minute <= 21; minute += 1) {
    const isLatest = minute === 21;
    events.push(
      createTrade({
        tradeId: `trade-${minute}`,
        observedAt: `2026-05-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
        price: isLatest ? "110" : "100",
        quantity: isLatest ? "2" : "1",
        side: "BID",
        sequence: String(minute * 10 + 1),
        tieBreakKey: `trade:${minute}`,
      }),
    );
  }

  return events;
}

function createTrade(input: {
  tradeId: string;
  observedAt: string;
  price: string;
  quantity: string;
  side: TradeEvent["side"];
  sequence?: string;
  tieBreakKey?: string;
}): TradeEvent & TestEventOrderFields {
  return {
    type: "TRADE",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    tradeId: input.tradeId,
    price: input.price,
    quantity: input.quantity,
    side: input.side,
    exchangeTimestamp: input.observedAt,
    receivedAt: input.observedAt,
    sequence: input.sequence ?? input.tradeId,
    tieBreakKey: input.tieBreakKey ?? `trade:${input.tradeId}`,
  };
}

function createOrderbook(
  observedAt: string,
  sizeMultiplier: string,
  bestAskPrice = "101",
  sequence = `orderbook:${observedAt}:${bestAskPrice}`,
  tieBreakKey = `orderbook:${observedAt}:${bestAskPrice}`,
): OrderbookEvent & TestEventOrderFields {
  const multiplier = new Decimal(sizeMultiplier);
  const secondAskPrice = new Decimal(bestAskPrice).plus(1).toFixed();
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    bids: [
      { price: "100", size: multiplier.toFixed() },
      { price: "99", size: multiplier.mul(2).toFixed() },
    ],
    asks: [
      { price: bestAskPrice, size: multiplier.toFixed() },
      { price: secondAskPrice, size: multiplier.mul(2).toFixed() },
    ],
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
    sequence,
    tieBreakKey,
  };
}

function createOrderbookBaselineEvents(input: {
  baselineSize: string;
  currentSize: string;
}): (OrderbookEvent & TestEventOrderFields)[] {
  const events: (OrderbookEvent & TestEventOrderFields)[] = [];

  for (let minute = 1; minute <= 20; minute += 1) {
    events.push(
      createOrderbook(
        formatMinuteTimestamp(minute),
        input.baselineSize,
        "101",
        String(minute * 10),
        `orderbook:${minute}`,
      ),
    );
  }

  events.push(createOrderbook(formatMinuteTimestamp(21), input.currentSize, "101", "210", "orderbook:21"));
  return events;
}

function formatMinuteTimestamp(minute: number): string {
  return `2026-05-25T00:${String(minute).padStart(2, "0")}:00.000Z`;
}

function createCostInput() {
  return {
    cancelRequotePenaltyBps: "0.5",
    entryFeeBps: "5",
    exitFeeBps: "5",
    expectedReturnBps: "40",
    expectedSlippageBpsP95: "3",
    safetyBufferBps: "10",
    spreadCostBpsP75: "2",
  };
}

type FakeFeatureWindowTable = "trades" | "orderbook_snapshots";

interface FakeFeatureWindowDatabaseCall {
  orderBys: unknown[][];
  table: FakeFeatureWindowTable;
  wheres: unknown[][];
}

function createFakeFeatureWindowDatabase(rows: Record<FakeFeatureWindowTable, unknown[]>): {
  calls: FakeFeatureWindowDatabaseCall[];
  database: Database;
} {
  const calls: FakeFeatureWindowDatabaseCall[] = [];
  const database = {
    selectFrom(table: FakeFeatureWindowTable) {
      const call: FakeFeatureWindowDatabaseCall = {
        orderBys: [],
        table,
        wheres: [],
      };
      calls.push(call);
      const builder = {
        execute() {
          return Promise.resolve(rows[table]);
        },
        orderBy(column: string, direction: string) {
          call.orderBys.push([column, direction]);
          return builder;
        },
        selectAll() {
          return builder;
        },
        where(column: string, operator: string, value: unknown) {
          call.wheres.push([column, operator, value]);
          return builder;
        },
      };
      return builder;
    },
  };

  return {
    calls,
    database: database as unknown as Database,
  };
}
