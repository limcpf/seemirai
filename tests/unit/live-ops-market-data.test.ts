import { describe, expect, it } from "vitest";
import type {
  MarketDataStatusEvent,
  OrderbookEvent,
  TradeEvent,
} from "../../src/domain/index.js";
import {
  collectLiveOpsMarketData,
  defaultLiveOpsConfig,
} from "../../src/runtime/index.js";
import type {
  MarketDataRuntimeEvent,
  MarketDataRuntimeEventStore,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-14T00:00:00.000Z";

describe("production live ops market data collector", () => {
  it("stores KRW-BTC trade/orderbook/status events through the DB-backed store contract", async () => {
    const store = new RecordingMarketDataStore();

    const summary = await collectLiveOpsMarketData({
      config: defaultLiveOpsConfig,
      sourceProfile: "fixture",
      workerId: "live-ops-market-data-test",
      store,
      events: replayEvents([
        createTradeEvent(),
        createOrderbookEvent(),
        createStatusEvent("CONNECTED"),
      ]),
      orderbook: {
        metric: {
          websocketLagMs: 25,
          reconnectCount: 0,
        },
      },
    });

    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      provider: "UPBIT_PUBLIC",
      market: "KRW-BTC",
      sourceProfile: "fixture",
      latestHeartbeatAt: observedAt,
      persisted: {
        eventCount: 3,
        tradeCount: 1,
        orderbookCount: 1,
        statusCount: 1,
        riskBlockCount: 0,
      },
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_market_data_fresh");
    expect(JSON.stringify(summary)).not.toContain("fake-upbit-secret-key");
    expect(store.writes).toEqual(["trades", "orderbook_metrics", "orderbook_snapshots", "audit_events"]);
    expect(store.orderbookOptions).toMatchObject({
      metric: {
        websocketLagMs: 25,
        reconnectCount: 0,
      },
    });
  });

  it("blocks events outside the production KRW-BTC universe before DB writes", async () => {
    const store = new RecordingMarketDataStore();

    const summary = await collectLiveOpsMarketData({
      config: defaultLiveOpsConfig,
      sourceProfile: "fixture",
      store,
      events: replayEvents([
        {
          ...createTradeEvent(),
          market: "KRW-ETH",
        },
      ]),
    });

    expect(summary.ready).toBe(false);
    expect(summary.persisted.eventCount).toBe(0);
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_market_data_source_invalid");
    expect(store.writes).toEqual([]);
  });

  it("persists stale status evidence but keeps collector blocked for new orders", async () => {
    const store = new RecordingMarketDataStore();

    const summary = await collectLiveOpsMarketData({
      config: defaultLiveOpsConfig,
      sourceProfile: "fixture",
      store,
      events: replayEvents([
        createTradeEvent(),
        createOrderbookEvent(),
        createStatusEvent("STALE"),
      ]),
    });

    expect(summary.ready).toBe(false);
    expect(summary.persisted).toMatchObject({
      tradeCount: 1,
      orderbookCount: 1,
      statusCount: 1,
      riskBlockCount: 1,
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_market_data_risk_block");
    expect(store.writes).toEqual([
      "trades",
      "orderbook_metrics",
      "orderbook_snapshots",
      "audit_events",
      "risk_events",
    ]);
  });
});

async function* replayEvents(
  events: readonly MarketDataRuntimeEvent[],
): AsyncIterable<MarketDataRuntimeEvent> {
  for (const event of events) {
    yield event;
  }
}

function createTradeEvent(): TradeEvent {
  return {
    type: "TRADE",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    tradeId: "live-ops-trade-fixture-1",
    price: "100000000",
    quantity: "0.001",
    side: "BID",
    exchangeTimestamp: "2026-06-14T00:00:00.000Z",
    receivedAt: observedAt,
  };
}

function createOrderbookEvent(): OrderbookEvent {
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    asks: [
      {
        price: "100001000",
        size: "0.2",
      },
    ],
    bids: [
      {
        price: "100000000",
        size: "0.3",
      },
    ],
    exchangeTimestamp: "2026-06-14T00:00:00.000Z",
    receivedAt: observedAt,
  };
}

function createStatusEvent(status: MarketDataStatusEvent["status"]): MarketDataStatusEvent {
  return {
    type: "STATUS",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    status,
    observedAt,
    reasonCode: `${status.toLowerCase()}_fixture`,
    websocketLagMs: status === "CONNECTED" ? 25 : 3_000,
    reconnectCount: status === "RECONNECTING" ? 1 : 0,
  };
}

/**
 * live ops market data collector test에서 DB-backed store를 대신하는 기록용 store다.
 *
 * 책임:
 * - collector가 라우팅한 write target 순서와 orderbook option을 관측한다.
 * - 실제 DB write side effect 없이 persistence contract만 검증한다.
 */
class RecordingMarketDataStore implements MarketDataRuntimeEventStore {
  public readonly writes: string[] = [];
  public orderbookOptions: unknown;

  public async saveTrade(): Promise<void> {
    this.writes.push("trades");
  }

  public async saveOrderbook(_event: OrderbookEvent, options: unknown): Promise<void> {
    this.orderbookOptions = options;
    this.writes.push("orderbook_metrics");
    this.writes.push("orderbook_snapshots");
  }

  public async appendStatusAudit(): Promise<void> {
    this.writes.push("audit_events");
  }

  public async appendStatusRisk(): Promise<void> {
    this.writes.push("risk_events");
  }
}
