import { describe, expect, it, vi } from "vitest";
import {
  UnsafeUpbitPrivateRequestError,
  UpbitLiveBroker,
  UpbitPrivateRestClientError,
} from "../../src/infrastructure/upbit/index.js";
import type {
  BrokerOrder,
  OrderIntent,
  OrderSubmission,
} from "../../src/domain/index.js";
import type {
  UpbitLiveBrokerPrivateClient,
  UpbitRateLimitStatus,
} from "../../src/infrastructure/upbit/index.js";

const capturedAt = "2026-06-02T00:00:00.000Z";

describe("UpbitLiveBroker core", () => {
  it("submits LIMIT orders with the intent idempotency key as Upbit identifier", async () => {
    const { broker, client } = createBroker();

    const order = await broker.submitOrder(createSubmission());

    expect(client.createLimitOrder).toHaveBeenCalledWith({
      market: "KRW-BTC",
      side: "bid",
      volume: "0.001",
      price: "140000000",
      identifier: "m15-live-identifier-001",
      timeInForce: "post_only",
    });
    expect(order).toMatchObject({
      brokerOrderId: "upbit-order-001",
      idempotencyKey: "m15-live-identifier-001",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "ACCEPTED",
      requestedQuantity: "0.001",
      remainingQuantity: "0.001",
      requestedPrice: "140000000",
      metadata: {
        source: "upbit_private_order_command",
        upbitLiveBrokerOperation: "submitOrder",
        rateLimitStatus: orderRateLimitStatus,
      },
    });
    expect(JSON.stringify(order)).not.toContain("provider-secret");
    expect(JSON.stringify(order)).not.toContain("\"raw\"");
  });

  it("fails closed before private client calls for unsupported orders and unsafe identifiers", async () => {
    const { broker, client } = createBroker();

    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createMarketIntent(),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker는 LIMIT 주문만 제출할 수 있습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ idempotencyKey: "x".repeat(33) }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker identifier는 32자 이하여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("maps cancel, get, list open orders, and balances through safe broker contracts", async () => {
    const { broker, client } = createBroker();

    await expect(broker.cancelOrder("upbit-order-001")).resolves.toMatchObject({
      brokerOrderId: "upbit-order-001",
      status: "CANCELED",
      metadata: {
        upbitLiveBrokerOperation: "cancelOrder",
        rateLimitStatus: orderRateLimitStatus,
      },
    });
    await expect(broker.getOrder("upbit-order-001")).resolves.toMatchObject({
      brokerOrderId: "upbit-order-001",
      status: "PARTIALLY_FILLED",
      metadata: {
        upbitLiveBrokerOperation: "getOrder",
        rateLimitStatus: defaultRateLimitStatus,
      },
    });
    await expect(broker.listOpenOrders("KRW-BTC")).resolves.toMatchObject([
      {
        brokerOrderId: "open-order-001",
        status: "ACCEPTED",
        metadata: {
          upbitLiveBrokerOperation: "listOpenOrders",
          rateLimitStatus: defaultRateLimitStatus,
        },
      },
    ]);
    const balances = await broker.getBalances();

    expect(client.cancelOrder).toHaveBeenCalledWith({ uuid: "upbit-order-001" });
    expect(client.getOrder).toHaveBeenCalledWith({ uuid: "upbit-order-001" });
    expect(client.listOpenOrders).toHaveBeenCalledWith({ market: "KRW-BTC" });
    expect(balances).toMatchObject({
      exchangeId: "upbit_krw_spot",
      metadata: {
        source: "upbit_private_accounts",
        upbitLiveBrokerOperation: "getBalances",
        rateLimitStatus: defaultRateLimitStatus,
      },
      balances: [
        {
          currency: "KRW",
          available: "10000",
          locked: "0",
          total: "10000",
          metadata: {
            source: "upbit_private_accounts",
          },
        },
      ],
    });
    expect(JSON.stringify(balances)).not.toContain("provider-secret");
    expect(JSON.stringify(balances)).not.toContain("\"raw\"");
  });

  it("returns undefined for not found order lookups without hiding other private errors", async () => {
    const client = createFakePrivateClient({
      getOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 404,
          statusText: "Not Found",
          kind: "REQUEST_FAILED",
          userMessage: "주문을 찾지 못했습니다.",
          rateLimitStatus: defaultRateLimitStatus,
          trace: {
            httpStatus: 404,
            rateLimitStatus: defaultRateLimitStatus,
          },
        });
      }),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(broker.getOrder("missing-order")).resolves.toBeUndefined();
    expect(client.getOrder).toHaveBeenCalledWith({ uuid: "missing-order" });

    const unavailableClient = createFakePrivateClient({
      getOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 500,
          statusText: "Internal Server Error",
          kind: "PROVIDER_UNAVAILABLE",
          userMessage: "Upbit 응답이 일시적으로 불안정합니다.",
          rateLimitStatus: defaultRateLimitStatus,
          trace: {
            httpStatus: 500,
            rateLimitStatus: defaultRateLimitStatus,
          },
        });
      }),
    });
    const unavailableBroker = new UpbitLiveBroker({ privateClient: unavailableClient, clock: () => capturedAt });

    await expect(unavailableBroker.getOrder("upbit-order-001")).rejects.toMatchObject({
      name: "UpbitPrivateRestClientError",
      kind: "PROVIDER_UNAVAILABLE",
    } satisfies Partial<UpbitPrivateRestClientError>);
  });
});

function createBroker(): {
  broker: UpbitLiveBroker;
  client: ReturnType<typeof createFakePrivateClient>;
} {
  const client = createFakePrivateClient();
  const broker = new UpbitLiveBroker({
    privateClient: client,
    clock: () => capturedAt,
  });

  return { broker, client };
}

function createFakePrivateClient(
  overrides: Partial<UpbitLiveBrokerPrivateClient> = {},
): UpbitLiveBrokerPrivateClient {
  return {
    createLimitOrder: vi.fn(async () => ({
      payload: createCommandOrderPayload(),
      rateLimitStatus: orderRateLimitStatus,
    })),
    cancelOrder: vi.fn(async () => ({
      payload: createCommandOrderPayload({
        state: "cancel",
        remaining_volume: "0.001",
      }),
      rateLimitStatus: orderRateLimitStatus,
    })),
    getOrder: vi.fn(async () => ({
      payload: createLookupOrderPayload(),
      rateLimitStatus: defaultRateLimitStatus,
    })),
    listOpenOrders: vi.fn(async () => ({
      payload: [
        createCommandOrderPayload({
          uuid: "open-order-001",
          identifier: "m15-open-001",
          executed_volume: "0",
          remaining_volume: "0.001",
        }),
      ],
      rateLimitStatus: defaultRateLimitStatus,
    })),
    getAccounts: vi.fn(async () => ({
      payload: [
        {
          currency: "KRW",
          balance: "10000.0000",
          locked: "0",
          avg_buy_price: "0",
          avg_buy_price_modified: false,
          unit_currency: "KRW",
          raw_secret_like_field: "provider-secret",
        },
      ],
      rateLimitStatus: defaultRateLimitStatus,
    })),
    ...overrides,
  };
}

function createSubmission(overrides: Partial<OrderSubmission> = {}): OrderSubmission {
  return {
    intent: createLimitIntent(),
    costSnapshot: { source: "test_cost" },
    riskApproval: { source: "test_risk", status: "APPROVED" },
    submittedAt: capturedAt,
    ...overrides,
  };
}

function createLimitIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "test-strategy",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.001",
    requestedPrice: "140000000",
    requestedNotional: "140000",
    idempotencyKey: "m15-live-identifier-001",
    reason: "unit test",
    postOnly: true,
    timeInForce: "POST_ONLY",
    ...overrides,
  };
}

function createMarketIntent(): Extract<OrderIntent, { orderType: "MARKET" }> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "test-strategy",
    side: "BUY",
    orderType: "MARKET",
    requestedQuantity: "0.001",
    requestedNotional: "140000",
    idempotencyKey: "m15-live-market-001",
    reason: "unit test",
  };
}

function createCommandOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: "KRW-BTC",
    uuid: "upbit-order-001",
    side: "bid",
    ord_type: "limit",
    price: "140000000.0000",
    state: "wait",
    created_at: "2026-06-02T00:00:00+09:00",
    volume: "0.001",
    remaining_volume: "0.001",
    executed_volume: "0",
    reserved_fee: "70",
    remaining_fee: "70",
    paid_fee: "0",
    locked: "140070",
    time_in_force: "post_only",
    identifier: "m15-live-identifier-001",
    prevented_volume: "0",
    prevented_locked: "0",
    trades_count: 0,
    raw_secret_like_field: "provider-secret",
    ...overrides,
  };
}

function createLookupOrderPayload(): Record<string, unknown> {
  return {
    ...createCommandOrderPayload({
      executed_volume: "0.0004",
      remaining_volume: "0.0006",
      trades_count: 1,
    }),
    trades: [
      {
        market: "KRW-BTC",
        uuid: "trade-001",
        price: "140000000",
        volume: "0.0004",
        funds: "56000",
        created_at: "2026-06-02T00:00:01+09:00",
        side: "bid",
      },
    ],
  };
}

const defaultRateLimitStatus = {
  kind: "OK",
  remainingReq: {
    group: "default",
    sec: 28,
    exhausted: false,
  },
} satisfies UpbitRateLimitStatus;

const orderRateLimitStatus = {
  kind: "OK",
  remainingReq: {
    group: "order",
    sec: 7,
    exhausted: false,
  },
} satisfies UpbitRateLimitStatus;
