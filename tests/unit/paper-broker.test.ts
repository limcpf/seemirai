import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokerPort } from "../../src/application/index.js";
import type {
  BrokerBalance,
  BrokerBalanceSnapshot,
  MarketOrderIntent,
  OrderIntent,
  OrderSubmission,
  OrderbookEvent,
} from "../../src/domain/index.js";
import {
  PaperBroker,
  PaperBrokerIdempotencyConflictError,
  PaperBrokerOrderNotFoundError,
} from "../../src/infrastructure/index.js";

const observedAt = "2026-05-19T10:00:00.000Z";
const exchangeId = "upbit_krw_spot";
type OrderbookLevelTuple = readonly [string, string];
type CreateOrderbookOverrides = Omit<Partial<OrderbookEvent>, "asks" | "bids"> & {
  asks?: readonly OrderbookLevelTuple[];
  bids?: readonly OrderbookLevelTuple[];
};

describe("PaperBroker", () => {
  it("implements BrokerPort and turns a full BUY paper fill into order and balance state", async () => {
    const broker: BrokerPort = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "KRW",
          available: "1000",
        },
        {
          currency: "BTC",
          available: "0",
        },
      ],
      orderbookSnapshots: createOrderbook({
        asks: [
          ["100", "0.3"],
          ["101", "0.2"],
          ["102", "1"],
        ],
      }),
      fillOptions: {
        takerFeeBps: "10",
      },
      clock: () => observedAt,
    });

    const order = await broker.submitOrder(
      createSubmission({
        intent: createLimitIntent({
          requestedPrice: "101",
          requestedQuantity: "0.5",
          requestedNotional: "50.5",
        }),
      }),
    );
    const balances = await broker.getBalances();

    expect(order).toMatchObject({
      brokerOrderId: "paper-order-1",
      idempotencyKey: "paper-broker-candidate-1",
      status: "FILLED",
      remainingQuantity: "0",
      requestedPrice: "101",
      acceptedAt: observedAt,
      metadata: {
        paper_fill_simulation: {
          status: "FILLED",
          reasonCode: "limit_crossed_full",
          filledQuantity: "0.5",
          totalFillNotional: "50.2",
          totalFee: "0.0502",
        },
        balance_mutation: {
          quote_currency: "KRW",
          base_currency: "BTC",
          quote_available_delta: "-50.2502",
          base_available_delta: "0.5",
        },
      },
    });
    expect(findBalance(balances, "KRW")).toMatchObject({
      available: "949.7498",
      locked: "0",
      total: "949.7498",
    });
    expect(findBalance(balances, "BTC")).toMatchObject({
      available: "0.5",
      locked: "0",
      total: "0.5",
    });
    await expect(broker.listOpenOrders()).resolves.toEqual([]);
  });

  it("uses the latest pre-submit orderbook when no broker latency is configured", async () => {
    const broker = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "KRW",
          available: "1000",
        },
      ],
      orderbookSnapshots: createOrderbook({
        receivedAt: "2026-05-19T09:59:59.900Z",
        asks: [["100", "1"]],
      }),
      clock: () => observedAt,
    });

    const order = await broker.submitOrder(createSubmission());

    expect(order).toMatchObject({
      status: "FILLED",
      remainingQuantity: "0",
      metadata: {
        paper_fill_simulation: {
          reasonCode: "limit_crossed_full",
          orderbookReceivedAt: "2026-05-19T09:59:59.900Z",
        },
      },
    });
  });

  it("rejects orders that would make available paper balances negative", async () => {
    const broker = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "KRW",
          available: "25",
        },
        {
          currency: "BTC",
          available: "0",
        },
      ],
      orderbookSnapshots: createOrderbook({
        asks: [["100", "1"]],
      }),
      clock: () => observedAt,
    });

    const order = await broker.submitOrder(createSubmission());
    const balances = await broker.getBalances();

    expect(order).toMatchObject({
      status: "REJECTED",
      remainingQuantity: "0",
      metadata: {
        balance_mutation_applied: false,
        paper_balance_rejection: {
          reason_code: "paper_balance_insufficient",
          currency: "KRW",
          required_quantity: "50",
          available_quantity: "25",
          shortage_quantity: "25",
        },
      },
    });
    expect(await broker.listOpenOrders()).toEqual([]);
    expect(findBalance(balances, "KRW")).toMatchObject({
      available: "25",
      locked: "0",
      total: "25",
    });
    expect(findBalance(balances, "BTC")).toMatchObject({
      available: "0",
      locked: "0",
      total: "0",
    });
  });

  it("keeps a partially filled SELL order open and releases the base lock on cancel", async () => {
    const broker = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "BTC",
          available: "2",
        },
        {
          currency: "KRW",
          available: "0",
        },
      ],
      orderbookSnapshots: createOrderbook({
        bids: [
          ["101", "0.25"],
          ["100", "0.15"],
          ["99", "1"],
        ],
      }),
      fillOptions: {
        takerFeeBps: "10",
      },
      clock: () => observedAt,
    });

    const order = await broker.submitOrder(
      createSubmission({
        intent: createLimitIntent({
          side: "SELL",
          requestedPrice: "100",
          requestedQuantity: "1",
          requestedNotional: "100",
        }),
      }),
    );
    const openOrders = await broker.listOpenOrders("KRW-BTC");
    const balancesAfterSubmit = await broker.getBalances();

    expect(order).toMatchObject({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.6",
      metadata: {
        paper_fill_simulation: {
          reasonCode: "limit_crossed_partial",
          filledQuantity: "0.4",
          openQuantity: "0.6",
        },
      },
    });
    expect(openOrders).toHaveLength(1);
    expect(openOrders[0]).toMatchObject({
      brokerOrderId: order.brokerOrderId,
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.6",
    });
    expect(findBalance(balancesAfterSubmit, "BTC")).toMatchObject({
      available: "1",
      locked: "0.6",
      total: "1.6",
    });
    expect(findBalance(balancesAfterSubmit, "KRW")).toMatchObject({
      available: "40.20975",
      locked: "0",
      total: "40.20975",
    });

    const canceledOrder = await broker.cancelOrder(order.brokerOrderId);
    const balancesAfterCancel = await broker.getBalances();

    expect(canceledOrder).toMatchObject({
      status: "CANCELED",
      remainingQuantity: "0",
      metadata: {
        paper_cancel: {
          balance_mutation: {
            released_currency: "BTC",
            released_quantity: "0.6",
            canceled_quantity: "0.6",
          },
        },
      },
    });
    expect(await broker.listOpenOrders()).toEqual([]);
    expect(findBalance(balancesAfterCancel, "BTC")).toMatchObject({
      available: "1.6",
      locked: "0",
      total: "1.6",
    });
  });

  it("returns the same order for repeated idempotency keys without moving balances twice", async () => {
    const broker = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "KRW",
          available: "1000",
        },
      ],
      orderbookSnapshots: createOrderbook({
        asks: [["100", "1"]],
      }),
      clock: () => observedAt,
    });
    const submission = createSubmission();

    const firstOrder = await broker.submitOrder(submission);
    const secondOrder = await broker.submitOrder(submission);
    const balances = await broker.getBalances();

    expect(secondOrder).toEqual(firstOrder);
    expect(findBalance(balances, "KRW")).toMatchObject({
      available: "950",
      total: "950",
    });
  });

  it("rejects an idempotency key reused for a different order fingerprint", async () => {
    const broker = new PaperBroker({
      exchangeId,
      orderbookSnapshots: createOrderbook(),
      clock: () => observedAt,
    });

    await broker.submitOrder(createSubmission());

    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({
            requestedPrice: "101",
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(PaperBrokerIdempotencyConflictError);
  });

  it("keeps non-crossing orders open and filters open orders by market", async () => {
    const broker = new PaperBroker({
      exchangeId,
      initialBalances: [
        {
          currency: "KRW",
          available: "1000",
        },
      ],
      clock: () => observedAt,
    });
    broker.recordOrderbookSnapshot(
      createOrderbook({
        asks: [["100", "1"]],
      }),
    );
    broker.recordOrderbookSnapshot(
      createOrderbook({
        market: "KRW-ETH",
        asks: [["200", "1"]],
      }),
    );

    const btcOrder = await broker.submitOrder(
      createSubmission({
        intent: createLimitIntent({
          requestedPrice: "99",
          idempotencyKey: "paper-broker-open-btc",
        }),
      }),
    );
    await broker.submitOrder(
      createSubmission({
        intent: createLimitIntent({
          market: "KRW-ETH",
          requestedPrice: "199",
          requestedNotional: "99.5",
          idempotencyKey: "paper-broker-open-eth",
        }),
      }),
    );

    await expect(broker.getOrder(btcOrder.brokerOrderId)).resolves.toMatchObject({
      status: "ACCEPTED",
      remainingQuantity: "0.5",
    });
    await expect(broker.listOpenOrders("KRW-BTC")).resolves.toMatchObject([
      {
        brokerOrderId: btcOrder.brokerOrderId,
        market: "KRW-BTC",
      },
    ]);
    await expect(broker.listOpenOrders("KRW-XRP")).resolves.toEqual([]);
  });

  it("rejects market order simulation at the paper broker boundary", async () => {
    const broker = new PaperBroker({
      exchangeId,
      orderbookSnapshots: createOrderbook({
        asks: [["100", "1"]],
      }),
      clock: () => observedAt,
    });

    const order = await broker.submitOrder(
      createSubmission({
        intent: createMarketIntent(),
      }),
    );

    expect(order).toMatchObject({
      status: "REJECTED",
      remainingQuantity: "0",
      metadata: {
        paper_fill_simulation: {
          status: "REJECTED",
          reasonCode: "market_order_simulation_disabled",
        },
      },
    });
    expect(order.acceptedAt).toBeUndefined();
  });

  it("fails unknown cancel requests instead of fabricating a canceled order", async () => {
    const broker = new PaperBroker({
      exchangeId,
      clock: () => observedAt,
    });

    await expect(broker.cancelOrder("missing-paper-order")).rejects.toBeInstanceOf(PaperBrokerOrderNotFoundError);
  });

  it("does not import strategy, live exchange clients, runtime, or DB implementations", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "infrastructure", "paper", "paper-broker.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*(strategy|upbit|runtime|infrastructure\/db)/iu);
  });
});

function createSubmission(overrides: Partial<OrderSubmission> = {}): OrderSubmission {
  const intent = overrides.intent ?? createLimitIntent();
  return {
    intent,
    costSnapshot: {
      source: "unit_test_cost_snapshot",
    },
    riskApproval: {
      source: "unit_test_risk_approval",
      approved: true,
    },
    expectedLossBpsOfEquity: "10",
    submittedAt: observedAt,
    ...overrides,
  };
}

function createOrderbook(overrides: CreateOrderbookOverrides = {}): OrderbookEvent {
  const { asks, bids, ...eventOverrides } = overrides;

  return {
    type: "ORDERBOOK",
    exchangeId,
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
    exchangeId,
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "100",
    requestedQuantity: "0.5",
    requestedNotional: "50",
    idempotencyKey: "paper-broker-candidate-1",
    reason: "paper broker unit test",
    ...overrides,
  };
}

function createMarketIntent(overrides: Partial<MarketOrderIntent> = {}): MarketOrderIntent {
  return {
    exchangeId,
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "MARKET",
    requestedQuantity: "0.5",
    requestedNotional: "50",
    idempotencyKey: "paper-broker-market-candidate-1",
    reason: "paper broker market order unit test",
    ...overrides,
  };
}

function findBalance(snapshot: BrokerBalanceSnapshot, currency: string): BrokerBalance {
  const balance = snapshot.balances.find((candidate) => candidate.currency === currency);
  if (balance === undefined) {
    throw new Error(`Missing ${currency} balance`);
  }

  return balance;
}
