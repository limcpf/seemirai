import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { simulatePaperFill } from "../../src/application/index.js";
import type { OrderIntent, OrderbookEvent } from "../../src/domain/index.js";

const observedAt = "2026-05-19T10:00:00.000Z";
type OrderbookLevelTuple = readonly [string, string];
type CreateOrderbookOverrides = Omit<Partial<OrderbookEvent>, "asks" | "bids"> & {
  asks?: readonly OrderbookLevelTuple[];
  bids?: readonly OrderbookLevelTuple[];
};

describe("paper fill simulator", () => {
  it("fills a BUY limit order across executable ask depth", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent({
        requestedPrice: "101",
        requestedQuantity: "0.5",
        requestedNotional: "50.5",
      }),
      orderbooks: createOrderbook({
        asks: [
          ["100", "0.3"],
          ["101", "0.2"],
          ["102", "1"],
        ],
      }),
      options: {
        takerFeeBps: "10",
      },
    });

    expect(result).toMatchObject({
      status: "FILLED",
      orderStatus: "FILLED",
      reasonCode: "limit_crossed_full",
      filledQuantity: "0.5",
      openQuantity: "0",
      canceledQuantity: "0",
      totalFillNotional: "50.2",
      averageFillPrice: "100.4",
      totalFee: "0.0502",
      fills: [
        {
          price: "100",
          quantity: "0.3",
          liquidity: "TAKER",
        },
        {
          price: "101",
          quantity: "0.2",
          liquidity: "TAKER",
        },
      ],
    });
  });

  it("leaves a GTC SELL limit order partially filled when bid depth is insufficient", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent({
        side: "SELL",
        requestedPrice: "100",
        requestedQuantity: "1",
        requestedNotional: "100",
      }),
      orderbooks: createOrderbook({
        bids: [
          ["101", "0.25"],
          ["100", "0.15"],
          ["99", "1"],
        ],
      }),
    });

    expect(result).toMatchObject({
      status: "PARTIALLY_FILLED",
      orderStatus: "PARTIALLY_FILLED",
      reasonCode: "limit_crossed_partial",
      filledQuantity: "0.4",
      openQuantity: "0.6",
      canceledQuantity: "0",
      totalFillNotional: "40.25",
      averageFillPrice: "100.625",
    });
  });

  it("keeps a non-crossing limit order open without fills", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent({
        requestedPrice: "99",
      }),
      orderbooks: createOrderbook({
        asks: [["100", "1"]],
      }),
    });

    expect(result).toMatchObject({
      status: "UNFILLED",
      orderStatus: "ACCEPTED",
      reasonCode: "limit_not_crossed",
      filledQuantity: "0",
      openQuantity: "0.5",
      canceledQuantity: "0",
      fills: [],
    });
  });

  it("uses the first orderbook snapshot after configured latency", () => {
    const afterLatency = "2026-05-19T10:00:00.150Z";
    const result = simulatePaperFill({
      intent: createLimitIntent({
        requestedPrice: "100",
      }),
      orderbooks: [
        createOrderbook({
          receivedAt: "2026-05-19T10:00:00.050Z",
          asks: [["101", "1"]],
        }),
        createOrderbook({
          receivedAt: afterLatency,
          asks: [["100", "1"]],
        }),
      ],
      options: {
        submittedAt: observedAt,
        latencyMs: 100,
      },
    });

    expect(result).toMatchObject({
      status: "FILLED",
      orderbookReceivedAt: afterLatency,
      filledQuantity: "0.5",
    });
  });

  it("does not fabricate fills when no latency-eligible snapshot exists", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent(),
      orderbooks: [
        createOrderbook({
          receivedAt: "2026-05-19T10:00:00.050Z",
          asks: [["100", "1"]],
        }),
      ],
      options: {
        submittedAt: observedAt,
        latencyMs: 100,
      },
    });

    expect(result).toMatchObject({
      status: "UNFILLED",
      orderStatus: "ACCEPTED",
      reasonCode: "latency_snapshot_missing",
      openQuantity: "0.5",
      fills: [],
    });
  });

  it("rejects or keeps post-only orders pending when they would immediately take liquidity", () => {
    const postOnlyIntent = createLimitIntent({
      requestedPrice: "100",
      postOnly: true,
    });
    const crossingOrderbook = createOrderbook({
      asks: [["99", "1"]],
    });

    expect(
      simulatePaperFill({
        intent: postOnlyIntent,
        orderbooks: crossingOrderbook,
      }),
    ).toMatchObject({
      status: "POST_ONLY_REJECTED",
      orderStatus: "REJECTED",
      reasonCode: "post_only_would_take_rejected",
      canceledQuantity: "0.5",
    });

    expect(
      simulatePaperFill({
        intent: postOnlyIntent,
        orderbooks: crossingOrderbook,
        options: {
          postOnlyTakerPolicy: "PENDING",
        },
      }),
    ).toMatchObject({
      status: "POST_ONLY_PENDING",
      orderStatus: "ACCEPTED",
      reasonCode: "post_only_would_take_pending",
      openQuantity: "0.5",
      fills: [],
    });
  });

  it("fills IOC aggressive limit orders immediately and cancels the residual quantity", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent({
        requestedPrice: "101",
        requestedQuantity: "1",
        requestedNotional: "101",
        timeInForce: "IOC",
      }),
      orderbooks: createOrderbook({
        asks: [
          ["100", "0.3"],
          ["101", "0.2"],
          ["102", "1"],
        ],
      }),
    });

    expect(result).toMatchObject({
      status: "IOC_CANCELED",
      orderStatus: "CANCELED",
      reasonCode: "ioc_filled_and_canceled",
      filledQuantity: "0.5",
      openQuantity: "0",
      canceledQuantity: "0.5",
      fills: [
        {
          price: "100",
          quantity: "0.3",
        },
        {
          price: "101",
          quantity: "0.2",
        },
      ],
    });
  });

  it("cancels FOK aggressive limit orders without partial fills when depth is insufficient", () => {
    const result = simulatePaperFill({
      intent: createLimitIntent({
        requestedPrice: "101",
        requestedQuantity: "1",
        requestedNotional: "101",
        timeInForce: "FOK",
      }),
      orderbooks: createOrderbook({
        asks: [
          ["100", "0.3"],
          ["101", "0.2"],
        ],
      }),
    });

    expect(result).toMatchObject({
      status: "FOK_CANCELED",
      orderStatus: "CANCELED",
      reasonCode: "fok_not_filled",
      filledQuantity: "0",
      openQuantity: "0",
      canceledQuantity: "1",
      fills: [],
    });
  });

  it("keeps market order simulation disabled at the fill boundary", () => {
    const result = simulatePaperFill({
      intent: createMarketIntent(),
      orderbooks: createOrderbook({
        asks: [["100", "1"]],
      }),
    });

    expect(result).toMatchObject({
      status: "REJECTED",
      orderStatus: "REJECTED",
      reasonCode: "market_order_simulation_disabled",
      fills: [],
    });
  });

  it("does not import strategy, Upbit, runtime, or DB implementations", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "execution", "paper-fill-simulator.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*(strategy|upbit|runtime|infrastructure\/db)/iu);
  });
});

function createOrderbook(overrides: CreateOrderbookOverrides = {}): OrderbookEvent {
  const { asks, bids, ...eventOverrides } = overrides;

  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    asks: (asks ?? [["100", "1"]]).map(([price, size]) => ({ price, size })),
    bids: (bids ?? [["99", "1"]]).map(([price, size]) => ({ price, size })),
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
    ...eventOverrides,
  };
}

function createLimitIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "100",
    requestedQuantity: "0.5",
    requestedNotional: "50",
    idempotencyKey: "paper-fill-candidate-1",
    reason: "paper fill unit test",
    ...overrides,
  };
}

function createMarketIntent(overrides: Partial<Extract<OrderIntent, { orderType: "MARKET" }>> = {}): Extract<
  OrderIntent,
  { orderType: "MARKET" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "MARKET",
    requestedQuantity: "0.5",
    requestedNotional: "50",
    idempotencyKey: "paper-fill-market-candidate-1",
    reason: "paper fill market unit test",
    ...overrides,
  };
}
