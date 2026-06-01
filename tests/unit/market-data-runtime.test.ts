import { describe, expect, it } from "vitest";
import type {
  MarketDataStatusEvent,
  OrderbookEvent,
  Phase15AltApprovalEvidenceCondition,
  Phase15AltApprovalEvidenceSnapshot,
  TradeEvent,
} from "../../src/domain/index.js";
import {
  MARKET_DATA_BLOCK_NEW_ORDERS_ACTION,
  MARKET_DATA_STATUS_AUDIT_EVENT_TYPE,
  PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID,
  UnsafePaperNoKeyMarketDataRuntimeError,
  createPaperNoKeyMarketDataRuntime,
  marketDataStatusBlocksNewOrders,
  persistMarketDataRuntimeEvents,
  planMarketDataRuntimePersistence,
  toMarketDataStatusAuditRow,
  toMarketDataStatusRiskRow,
} from "../../src/runtime/index.js";
import type { MarketDataRuntimeEventStore } from "../../src/runtime/index.js";
import { loadDefaultRuntimeConfig, loadRuntimeConfig } from "../../src/runtime/index.js";

const observedAt = "2026-05-17T10:30:00.000Z";

describe("PAPER_NO_KEY market data runtime", () => {
  it("assembles Upbit public quotation subscriptions without API keys or private paths", async () => {
    const config = await loadDefaultRuntimeConfig();
    const runtime = createPaperNoKeyMarketDataRuntime(config, {
      orderbookLevel: "10000",
    });
    const serialized = [
      runtime.tradeSubscriptionMessage,
      runtime.orderbookSubscriptionMessage,
    ].join("\n");

    expect(runtime.exchangeId).toBe("upbit_krw_spot");
    expect(runtime.markets).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(runtime.publicQuotationEndpoint).toBe("wss://api.upbit.com/websocket/v1");
    expect(runtime.tradeStreamRequest.consumerId).toBe(PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID);
    expect(JSON.parse(runtime.tradeSubscriptionMessage)).toMatchObject([
      { ticket: PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID },
      {
        type: "trade",
        codes: ["KRW-BTC", "KRW-ETH"],
        is_only_realtime: true,
      },
      { format: "DEFAULT" },
    ]);
    expect(JSON.parse(runtime.orderbookSubscriptionMessage)).toMatchObject([
      { ticket: PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID },
      {
        type: "orderbook",
        codes: ["KRW-BTC", "KRW-ETH"],
        is_only_realtime: true,
        level: "10000",
      },
      { format: "DEFAULT" },
    ]);
    expect(serialized).not.toMatch(/authorization|bearer|\/private|myOrder|myAsset|orders\/chance/iu);
    expect(runtime.config.secrets.upbit_access_key).toBeUndefined();
    expect(runtime.config.secrets.upbit_secret_key).toBeUndefined();
  });

  it("subscribes to the resolved phase 1.5 universe when manual approvals are active", () => {
    const runtime = createPaperNoKeyMarketDataRuntime(
      loadRuntimeConfig({
        universe: {
          phase_1_5: {
            enabled: true,
            manual_approvals: [
              {
                market: "KRW-SOL",
                approved_at: "2026-05-31T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      {
        clock: () => "2026-06-01T00:00:00.000Z",
        phase15ApprovalEvidence: [
          createPhase15ApprovalEvidence("KRW-SOL", "APPROVE", "2026-05-31T00:00:00.000Z"),
        ],
      },
    );

    expect(runtime.markets).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(runtime.tradeStreamRequest.markets).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(JSON.parse(runtime.tradeSubscriptionMessage)).toMatchObject([
      { ticket: PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID },
      {
        type: "trade",
        codes: ["KRW-BTC", "KRW-ETH", "KRW-SOL"],
      },
      { format: "DEFAULT" },
    ]);
  });

  it("re-resolves phase 1.5 universe so expired approvals leave stream requests", () => {
    const runtime = createPaperNoKeyMarketDataRuntime(
      loadRuntimeConfig({
        universe: {
          phase_1_5: {
            enabled: true,
            manual_approvals: [
              {
                market: "KRW-SOL",
                approved_at: "2026-05-31T00:00:00.000Z",
                expires_at: "2026-06-01T00:30:00.000Z",
              },
            ],
          },
        },
      }),
      {
        clock: () => "2026-06-01T00:00:00.000Z",
        phase15ApprovalEvidence: [
          createPhase15ApprovalEvidence("KRW-SOL", "APPROVE", "2026-05-31T00:00:00.000Z"),
        ],
      },
    );
    const refreshed = runtime.refreshUniverse({
      clock: () => "2026-06-01T00:31:00.000Z",
    });

    expect(runtime.markets).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(refreshed.markets).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(refreshed.tradeStreamRequest.markets).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(refreshed.universe.phase15ExpiredAltMarkets).toEqual(["KRW-SOL"]);
  });

  it("rejects Upbit API keys in the PAPER_NO_KEY market data runtime", () => {
    expect(() =>
      createPaperNoKeyMarketDataRuntime({
        secrets: {
          upbit_access_key: "fixture-access-key",
        },
      }),
    ).toThrow(UnsafePaperNoKeyMarketDataRuntimeError);
  });

  it.each([
    ["STALE", "stale_market_data", "WARN"],
    ["RECONNECTING", "market_data_reconnecting", "WARN"],
    ["DISCONNECTED", "market_data_disconnected", "ERROR"],
  ] as const)("maps %s status into audit and new-order block risk candidates", (status, riskType, severity) => {
    const event = createStatusEvent(status);
    const plan = planMarketDataRuntimePersistence(event);
    const auditRow = toMarketDataStatusAuditRow(event, {
      workerId: "runtime-test-worker",
    });
    const riskRow = toMarketDataStatusRiskRow(event, {
      workerId: "runtime-test-worker",
    });

    expect(marketDataStatusBlocksNewOrders(status)).toBe(true);
    expect(plan).toEqual({
      eventType: "STATUS",
      writes: ["audit_events", "risk_events"],
      blockNewOrders: true,
    });
    expect(auditRow).toMatchObject({
      event_type: MARKET_DATA_STATUS_AUDIT_EVENT_TYPE,
      severity,
      correlation_id: `market-data:upbit_krw_spot:KRW-BTC:${status}:${observedAt}`,
      occurred_at: observedAt,
      payload_json: {
        kind: "market_data_status",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        status,
        blockNewOrders: true,
        workerId: "runtime-test-worker",
      },
    });
    expect(riskRow).toMatchObject({
      risk_type: riskType,
      severity,
      market: "KRW-BTC",
      action: MARKET_DATA_BLOCK_NEW_ORDERS_ACTION,
      occurred_at: observedAt,
      payload_json: {
        reasonCode: `${status.toLowerCase()}_fixture`,
        blockNewOrders: true,
      },
    });
  });

  it("keeps CONNECTED status as audit-only recovery evidence", () => {
    const event = createStatusEvent("CONNECTED");
    const plan = planMarketDataRuntimePersistence(event);

    expect(marketDataStatusBlocksNewOrders(event.status)).toBe(false);
    expect(plan).toEqual({
      eventType: "STATUS",
      writes: ["audit_events"],
      blockNewOrders: false,
    });
    expect(toMarketDataStatusAuditRow(event)).toMatchObject({
      event_type: MARKET_DATA_STATUS_AUDIT_EVENT_TYPE,
      severity: "INFO",
      payload_json: {
        status: "CONNECTED",
        blockNewOrders: false,
      },
    });
    expect(toMarketDataStatusRiskRow(event)).toBeUndefined();
  });

  it("persists replayed trade, orderbook, and blocking status events through the runtime store", async () => {
    const writes: string[] = [];
    const store: MarketDataRuntimeEventStore = {
      saveTrade: async () => {
        writes.push("trades");
      },
      saveOrderbook: async (_event, options) => {
        expect(options.metric).toMatchObject({
          websocketLagMs: 500,
          reconnectCount: 1,
        });
        writes.push("orderbook_metrics");
        writes.push("orderbook_snapshots");
      },
      appendStatusAudit: async (row) => {
        expect(row.event_type).toBe(MARKET_DATA_STATUS_AUDIT_EVENT_TYPE);
        writes.push("audit_events");
      },
      appendStatusRisk: async (row) => {
        expect(row.action).toBe(MARKET_DATA_BLOCK_NEW_ORDERS_ACTION);
        writes.push("risk_events");
      },
    };
    const summary = await persistMarketDataRuntimeEvents(
      store,
      replayRuntimeEvents(),
      {
        workerId: "runtime-test-worker",
        orderbook: {
          metric: {
            websocketLagMs: 500,
            reconnectCount: 1,
          },
        },
      },
    );

    expect(writes).toEqual([
      "trades",
      "orderbook_metrics",
      "orderbook_snapshots",
      "audit_events",
      "risk_events",
    ]);
    expect(summary).toEqual({
      eventCount: 3,
      tradeCount: 1,
      orderbookCount: 1,
      statusCount: 1,
      riskBlockCount: 1,
    });
  });
});

function createPhase15ApprovalEvidence(
  market: string,
  action: "APPROVE" | "REJECT" | "REVOKE" | "EXPIRE",
  observedAt: string,
): Phase15AltApprovalEvidenceSnapshot {
  return {
    exchangeId: "upbit_krw_spot",
    market,
    action,
    observedAt,
    thresholds: {
      minListingAgeDays: 90,
      minThirtyDayAverageTradeValueKrw: "10000000000",
      maxSevenDaySpreadP95Bps: "15",
      maxExpectedSlippageBps: "20",
      minDepthKrw: "100000000",
    },
    conditions: action === "APPROVE" ? createPassingPhase15Conditions() : [],
  };
}

function createPassingPhase15Conditions(): readonly Phase15AltApprovalEvidenceCondition[] {
  return [
    { key: "listing_age", passed: true, reasonCode: "phase_1_5_listing_age_sufficient" },
    { key: "market_warning", passed: true, reasonCode: "phase_1_5_market_warning_absent" },
    { key: "market_caution", passed: true, reasonCode: "phase_1_5_market_caution_absent" },
    {
      key: "thirty_day_average_trade_value",
      passed: true,
      reasonCode: "phase_1_5_30d_trade_value_sufficient",
    },
    { key: "seven_day_spread_p95", passed: true, reasonCode: "phase_1_5_spread_p95_within_limit" },
    { key: "expected_slippage", passed: true, reasonCode: "phase_1_5_expected_slippage_within_limit" },
    { key: "depth", passed: true, reasonCode: "phase_1_5_depth_sufficient" },
  ];
}

function createStatusEvent(status: MarketDataStatusEvent["status"]): MarketDataStatusEvent {
  return {
    type: "STATUS",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    status,
    observedAt,
    reasonCode: `${status.toLowerCase()}_fixture`,
    websocketLagMs: status === "CONNECTED" ? 10 : 3_000,
    reconnectCount: status === "RECONNECTING" ? 1 : 0,
  };
}

async function* replayRuntimeEvents(): AsyncIterable<TradeEvent | OrderbookEvent | MarketDataStatusEvent> {
  yield {
    type: "TRADE",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    tradeId: "trade-runtime-fixture-1",
    price: "100000000",
    quantity: "0.001",
    side: "BID",
    exchangeTimestamp: "2026-05-17T10:29:59.900Z",
    receivedAt: observedAt,
  };

  yield {
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
    exchangeTimestamp: "2026-05-17T10:29:59.900Z",
    receivedAt: observedAt,
  };

  yield createStatusEvent("STALE");
}
