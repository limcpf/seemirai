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

  it("fails closed before provider calls when idempotency keys exceed the Upbit identifier limit", async () => {
    const longIdempotencyKey = "trend_following:upbit_krw_spot:KRW-BTC:BUY:2026-06-02T00:00:00.000Z";
    const client = createFakePrivateClient();
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ idempotencyKey: longIdempotencyKey }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker identifier는 32자 이하여야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("preserves the original idempotency key when submitting provider-accepted identifiers", async () => {
    const idempotencyKey = "m15-identifier-32-chars-000001";
    const client = createFakePrivateClient({
      createLimitOrder: vi.fn(async (input) => ({
        payload: createCommandOrderPayload({ identifier: input.identifier }),
        rateLimitStatus: orderRateLimitStatus,
      })),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    const order = await broker.submitOrder(
      createSubmission({
        intent: createLimitIntent({ idempotencyKey }),
      }),
    );

    expect(client.createLimitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: idempotencyKey,
      }),
    );
    expect(order).toMatchObject({
      idempotencyKey,
      metadata: {
        upbitIdentifier: idempotencyKey,
        upbitLiveBrokerIntentIdempotencyKey: idempotencyKey,
        upbitLiveBrokerIdentifierSource: "intent",
      },
    });
  });

  it("fails closed before private client calls for unsupported orders and unsafe inputs", async () => {
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
          intent: createLimitIntent({ exchangeId: "other_exchange" }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker 주문 exchangeId가 broker exchangeId와 일치해야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ postOnly: true, timeInForce: "IOC" }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker postOnly 주문은 IOC/FOK timeInForce와 함께 사용할 수 없습니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ side: "HOLD" as "BUY" }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker 주문 방향은 BUY 또는 SELL이어야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ requestedPrice: "abc" }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker LIMIT 주문 가격은 0보다 큰 decimal 문자열이어야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    await expect(
      broker.submitOrder(
        createSubmission({
          intent: createLimitIntent({ requestedQuantity: "0" }),
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker 주문 수량은 0보다 큰 decimal 문자열이어야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(client.createLimitOrder).not.toHaveBeenCalled();
  });

  it("recovers duplicate identifier submit retries by looking up the existing order", async () => {
    const client = createFakePrivateClient({
      createLimitOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 400,
          statusText: "Bad Request",
          kind: "REQUEST_FAILED",
          userMessage: "이미 사용한 주문 식별자입니다.",
          rateLimitStatus: orderRateLimitStatus,
          trace: {
            httpStatus: 400,
            upbitErrorName: "identifier_already_used",
            rateLimitStatus: orderRateLimitStatus,
          },
        });
      }),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(broker.submitOrder(createSubmission())).resolves.toMatchObject({
      brokerOrderId: "upbit-order-001",
      metadata: {
        upbitLiveBrokerOperation: "submitOrder",
        upbitLiveBrokerRecovery: "duplicate_identifier_lookup",
        rateLimitStatus: defaultRateLimitStatus,
      },
    });
    expect(client.getOrder).toHaveBeenCalledWith({ identifier: "m15-live-identifier-001" });
  });

  it("rejects duplicate identifier recovery when the looked-up order differs from the current intent", async () => {
    const client = createFakePrivateClient({
      createLimitOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 400,
          statusText: "Bad Request",
          kind: "REQUEST_FAILED",
          userMessage: "이미 사용한 주문 식별자입니다.",
          rateLimitStatus: orderRateLimitStatus,
          trace: {
            httpStatus: 400,
            upbitErrorName: "duplicate_identifier",
            rateLimitStatus: orderRateLimitStatus,
          },
        });
      }),
      getOrder: vi.fn(async () => ({
        payload: createLookupOrderPayload({ price: "130000000.0000" }),
        rateLimitStatus: defaultRateLimitStatus,
      })),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(broker.submitOrder(createSubmission())).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker duplicate identifier 조회 결과의 가격이 현재 주문과 일치해야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
    expect(client.getOrder).toHaveBeenCalledWith({ identifier: "m15-live-identifier-001" });
  });

  it("rejects duplicate identifier recovery when execution conditions differ", async () => {
    const client = createFakePrivateClient({
      createLimitOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 400,
          statusText: "Bad Request",
          kind: "REQUEST_FAILED",
          userMessage: "이미 사용한 주문 식별자입니다.",
          rateLimitStatus: orderRateLimitStatus,
          trace: {
            httpStatus: 400,
            upbitErrorName: "duplicate_identifier",
            rateLimitStatus: orderRateLimitStatus,
          },
        });
      }),
      getOrder: vi.fn(async () => ({
        payload: createLookupOrderPayload({ time_in_force: "ioc" }),
        rateLimitStatus: defaultRateLimitStatus,
      })),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(broker.submitOrder(createSubmission())).rejects.toMatchObject({
      name: "UnsafeUpbitPrivateRequestError",
      violations: ["Upbit live broker duplicate identifier 조회 결과의 실행 조건이 현재 주문과 일치해야 합니다"],
    } satisfies Partial<UnsafeUpbitPrivateRequestError>);
  });

  it("maps cancel, get, list open orders, and balances through safe broker contracts", async () => {
    const { broker, client } = createBroker();

    await expect(broker.cancelOrder("upbit-order-001")).resolves.toMatchObject({
      brokerOrderId: "upbit-order-001",
      status: "CANCEL_REQUESTED",
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
    expect(client.listOpenOrders).toHaveBeenCalledWith({
      market: "KRW-BTC",
      page: 1,
      limit: 100,
      orderBy: "asc",
    });
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

  it("continues open order pagination until the last short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) =>
      createCommandOrderPayload({
        uuid: `open-order-${index.toString().padStart(3, "0")}`,
        identifier: `m15-open-${index.toString().padStart(3, "0")}`,
      }),
    );
    const client = createFakePrivateClient({
      listOpenOrders: vi.fn(async (input) => ({
        payload:
          input?.page === 2
            ? [createCommandOrderPayload({ uuid: "open-order-100", identifier: "m15-open-100" })]
            : firstPage,
        rateLimitStatus: defaultRateLimitStatus,
      })),
    });
    const broker = new UpbitLiveBroker({ privateClient: client, clock: () => capturedAt });

    await expect(broker.listOpenOrders("KRW-BTC")).resolves.toHaveLength(101);
    expect(client.listOpenOrders).toHaveBeenNthCalledWith(1, {
      market: "KRW-BTC",
      page: 1,
      limit: 100,
      orderBy: "asc",
    });
    expect(client.listOpenOrders).toHaveBeenNthCalledWith(2, {
      market: "KRW-BTC",
      page: 2,
      limit: 100,
      orderBy: "asc",
    });
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
            upbitErrorName: "order_not_found",
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

    const ambiguousNotFoundClient = createFakePrivateClient({
      getOrder: vi.fn(async () => {
        throw new UpbitPrivateRestClientError({
          status: 404,
          statusText: "Not Found",
          kind: "REQUEST_FAILED",
          userMessage: "라우팅된 endpoint를 찾지 못했습니다.",
          rateLimitStatus: defaultRateLimitStatus,
          trace: {
            httpStatus: 404,
            rateLimitStatus: defaultRateLimitStatus,
          },
        });
      }),
    });
    const ambiguousBroker = new UpbitLiveBroker({ privateClient: ambiguousNotFoundClient, clock: () => capturedAt });

    await expect(ambiguousBroker.getOrder("upbit-order-001")).rejects.toMatchObject({
      name: "UpbitPrivateRestClientError",
      status: 404,
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
        state: "wait",
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

function createLookupOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createCommandOrderPayload({
      executed_volume: "0.0004",
      remaining_volume: "0.0006",
      trades_count: 1,
      ...overrides,
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
