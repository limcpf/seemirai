import { describe, expect, it } from "vitest";
import {
  UnsafeUpbitPrivateRequestError,
  UpbitPrivatePayloadMappingError,
  UpbitPrivateRestClientError,
  toBrokerBalanceSnapshot,
  toBrokerOrderFromLookup,
  toBrokerOrdersFromClosedOrders,
  toBrokerOrdersFromOpenOrders,
  toFeePolicyFromOrderChance,
  toOrderChancePolicy,
  toUpbitPrivateUserActionErrorSummary,
} from "../../src/infrastructure/upbit/index.js";
import type { UpbitRateLimitStatus } from "../../src/infrastructure/upbit/index.js";

const capturedAt = "2026-06-01T00:00:00.000Z";

describe("Upbit private account mapper", () => {
  it("maps account balances to broker balance snapshots without secret fields", () => {
    const snapshot = toBrokerBalanceSnapshot(
      [
        {
          currency: "krw",
          balance: "10000.5000",
          locked: "25.25",
          avg_buy_price: "0",
          avg_buy_price_modified: false,
          unit_currency: "KRW",
        },
        {
          currency: "BTC",
          balance: "0.00100000",
          locked: "0.0005",
          avg_buy_price: "140000000",
          avg_buy_price_modified: false,
          unit_currency: "KRW",
        },
      ],
      { capturedAt },
    );

    expect(snapshot).toMatchObject({
      exchangeId: "upbit_krw_spot",
      capturedAt,
      metadata: {
        source: "upbit_private_accounts",
      },
      balances: [
        {
          currency: "KRW",
          available: "10000.5",
          locked: "25.25",
          total: "10025.75",
          updatedAt: capturedAt,
        },
        {
          currency: "BTC",
          available: "0.001",
          locked: "0.0005",
          total: "0.0015",
          updatedAt: capturedAt,
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(JSON.stringify(snapshot)).not.toContain("Authorization");
  });

  it("fails account payload mapping without echoing raw invalid values", () => {
    expect(() =>
      toBrokerBalanceSnapshot(
        [
          {
            currency: "KRW",
            balance: "provider-secret-balance",
            locked: "0",
            avg_buy_price: "0",
            avg_buy_price_modified: false,
            unit_currency: "KRW",
          },
        ],
        { capturedAt },
      ),
    ).toThrow(UpbitPrivatePayloadMappingError);

    try {
      toBrokerBalanceSnapshot(
        [
          {
            currency: "KRW",
            balance: "provider-secret-balance",
            locked: "0",
            avg_buy_price: "0",
            avg_buy_price_modified: false,
            unit_currency: "KRW",
          },
        ],
        { capturedAt },
      );
      throw new Error("expected mapper to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivatePayloadMappingError",
        schema: "ACCOUNTS",
        userMessage: "Upbit private 응답이 예상 schema와 달라 후속 정책/주문 증거로 사용할 수 없습니다.",
        issuePaths: ["0.balance"],
      } satisfies Partial<UpbitPrivatePayloadMappingError>);
      expect(String(error)).not.toContain("provider-secret-balance");
    }
  });
});

describe("Upbit private order chance mapper", () => {
  it("maps orders/chance payloads to policy and fee contracts", () => {
    const payload = [createOrderChancePayload()];

    expect(toOrderChancePolicy(payload, { capturedAt })).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      allowedOrderTypes: ["LIMIT", "MARKET"],
      bidFeeBps: "5",
      askFeeBps: "5",
      makerBidFeeBps: "4",
      makerAskFeeBps: "4",
      bidAvailableBalance: "10000",
      askAvailableBalance: "0.001",
      minimumBidNotional: "5000",
      maximumBidNotional: "1000000000",
      capturedAt,
    });
    expect(toFeePolicyFromOrderChance(payload, { capturedAt })).toEqual({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      bidFeeBps: "5",
      askFeeBps: "5",
      makerBidFeeBps: "4",
      makerAskFeeBps: "4",
      updatedAt: capturedAt,
    });
  });

  it("does not promote best-only order chance types to MARKET", () => {
    const payload = createOrderChancePayload() as Record<string, unknown>;
    const market = payload.market as Record<string, unknown>;

    expect(
      toOrderChancePolicy(
        {
          ...payload,
          market: {
            ...market,
            order_types: ["best"],
            bid_types: ["best_fok", "best_ioc"],
            ask_types: ["best_fok", "best_ioc"],
          },
        },
        { capturedAt },
      ).allowedOrderTypes,
    ).toEqual([]);
  });
});

describe("Upbit private order lookup mapper", () => {
  it("maps read-only order lookup payloads to broker order contracts", () => {
    const order = toBrokerOrderFromLookup(
      {
        market: "KRW-BTC",
        uuid: "3b67e543-8ad3-48d0-8451-0dad315cae73",
        side: "bid",
        ord_type: "limit",
        price: "140000000.0000",
        state: "wait",
        created_at: "2026-06-01T09:00:00+09:00",
        volume: "0.002",
        remaining_volume: "0.0015",
        executed_volume: "0.0005",
        reserved_fee: "140",
        remaining_fee: "105.0000",
        paid_fee: "35",
        locked: "210000",
        time_in_force: "post_only",
        identifier: "m14-smoke-lookup-001",
        trades_count: 1,
        trades: [
          {
            market: "KRW-BTC",
            uuid: "trade-001",
            price: "140000000",
            volume: "0.0005",
            funds: "70000",
            created_at: "2026-06-01T09:00:01.000000+09:00",
            side: "bid",
          },
        ],
      },
      { capturedAt },
    );

    expect(order).toMatchObject({
      brokerOrderId: "3b67e543-8ad3-48d0-8451-0dad315cae73",
      idempotencyKey: "m14-smoke-lookup-001",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "PARTIALLY_FILLED",
      requestedQuantity: "0.002",
      remainingQuantity: "0.0015",
      requestedPrice: "140000000",
      acceptedAt: "2026-06-01T09:00:00+09:00",
      updatedAt: capturedAt,
      metadata: {
        source: "upbit_private_order_lookup",
        upbitOrderType: "limit",
        upbitTimeInForce: "POST_ONLY",
        executedVolume: "0.0005",
        paidFee: "35",
        tradesCount: 1,
      },
    });
  });

  it("keeps Upbit market-style order details in metadata while using broker order primitives", () => {
    const order = toBrokerOrderFromLookup(
      {
        market: "KRW-USDT",
        uuid: "market-order-uuid",
        side: "ask",
        ord_type: "market",
        state: "done",
        created_at: "2026-06-01T09:00:00+09:00",
        volume: "5.5",
        remaining_volume: "0",
        executed_volume: "5.377594",
        reserved_fee: "0",
        remaining_fee: "0",
        paid_fee: "3.697095875",
        locked: "0",
        trades_count: 0,
        trades: [],
      },
      { capturedAt },
    );

    expect(order).toMatchObject({
      brokerOrderId: "market-order-uuid",
      idempotencyKey: "market-order-uuid",
      side: "SELL",
      orderType: "MARKET",
      status: "FILLED",
      requestedQuantity: "5.5",
      remainingQuantity: "0",
      metadata: {
        upbitOrderType: "market",
        upbitState: "done",
      },
    });
  });

  it("fails closed for order lookup types that BrokerOrder cannot represent safely", () => {
    expect(() =>
      toBrokerOrderFromLookup(
        {
          market: "KRW-BTC",
          uuid: "best-order-uuid",
          side: "bid",
          ord_type: "best",
          state: "cancel",
          created_at: "2026-06-01T09:00:00+09:00",
          volume: "0.001",
          remaining_volume: "0.001",
          executed_volume: "0",
          reserved_fee: "0",
          remaining_fee: "0",
          paid_fee: "0",
          locked: "0",
          time_in_force: "ioc",
          trades_count: 0,
          trades: [],
        },
        { capturedAt },
      ),
    ).toThrow(UpbitPrivatePayloadMappingError);

    expect(() =>
      toBrokerOrderFromLookup(
        {
          market: "KRW-BTC",
          uuid: "price-order-uuid",
          side: "bid",
          ord_type: "price",
          price: "5000",
          state: "done",
          created_at: "2026-06-01T09:00:00+09:00",
          remaining_volume: "0",
          executed_volume: "0.000035",
          reserved_fee: "0",
          remaining_fee: "0",
          paid_fee: "2.5",
          locked: "0",
          trades_count: 0,
          trades: [],
        },
        { capturedAt },
      ),
    ).toThrow(UpbitPrivatePayloadMappingError);
  });
});

describe("Upbit private closed orders mapper", () => {
  it("maps closed order list payloads to broker order contracts", () => {
    const orders = toBrokerOrdersFromClosedOrders(
      [
        {
          market: "KRW-BTC",
          uuid: "closed-order-001",
          side: "bid",
          ord_type: "limit",
          price: "140000000.0000",
          state: "done",
          created_at: "2026-06-01T09:00:00+09:00",
          volume: "0.002",
          remaining_volume: "0",
          executed_volume: "0.002",
          executed_funds: "280000",
          reserved_fee: "140",
          remaining_fee: "0",
          paid_fee: "140",
          locked: "0",
          time_in_force: "post_only",
          identifier: "m16-closed-001",
          trades_count: 1,
        },
        {
          market: "KRW-ETH",
          uuid: "closed-order-002",
          side: "ask",
          ord_type: "limit",
          price: "6000000",
          state: "cancel",
          created_at: "2026-06-01T09:01:00+09:00",
          volume: "0.05",
          remaining_volume: "0.05",
          executed_volume: "0",
          reserved_fee: "0",
          remaining_fee: "0",
          paid_fee: "0",
          locked: "0",
          smp_type: "reduce",
          identifier: "m16-closed-002",
          trades_count: 0,
        },
        {
          market: "KRW-BTC",
          uuid: "closed-order-003",
          side: "ask",
          ord_type: "market",
          state: "done",
          created_at: "2026-06-01T09:02:00+09:00",
          volume: "5.5",
          remaining_volume: "0",
          executed_volume: "5.377594",
          reserved_fee: "0",
          remaining_fee: "0",
          paid_fee: "3.697095875",
          locked: "0",
          trades_count: 0,
        },
      ],
      { capturedAt },
    );

    expect(orders).toMatchObject([
      {
        brokerOrderId: "closed-order-001",
        idempotencyKey: "m16-closed-001",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        status: "FILLED",
        requestedQuantity: "0.002",
        remainingQuantity: "0",
        requestedPrice: "140000000",
        metadata: {
          source: "upbit_private_closed_order",
          upbitTimeInForce: "POST_ONLY",
          executedFunds: "280000",
          tradesCount: 1,
        },
      },
      {
        brokerOrderId: "closed-order-002",
        idempotencyKey: "m16-closed-002",
        exchangeId: "upbit_krw_spot",
        market: "KRW-ETH",
        side: "SELL",
        orderType: "LIMIT",
        status: "CANCELED",
        requestedQuantity: "0.05",
        remainingQuantity: "0.05",
        requestedPrice: "6000000",
        metadata: {
          source: "upbit_private_closed_order",
          upbitState: "cancel",
          upbitSmpType: "reduce",
          tradesCount: 0,
        },
      },
      {
        brokerOrderId: "closed-order-003",
        idempotencyKey: "closed-order-003",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "SELL",
        orderType: "MARKET",
        status: "FILLED",
        requestedQuantity: "5.5",
        remainingQuantity: "0",
        metadata: {
          source: "upbit_private_closed_order",
          upbitOrderType: "market",
          upbitState: "done",
        },
      },
    ]);
    expect(JSON.stringify(orders)).not.toContain("Authorization");
    expect(JSON.stringify(orders)).not.toContain('"raw"');
  });

  it("fails closed order mapping without echoing raw invalid values", () => {
    try {
      toBrokerOrdersFromClosedOrders(
        [
          {
            market: "KRW-BTC",
            uuid: "closed-order-secret",
            side: "bid",
            ord_type: "limit",
            price: "provider-secret-price",
            state: "done",
            created_at: "2026-06-01T09:00:00+09:00",
            volume: "0.002",
            remaining_volume: "0",
            executed_volume: "0.002",
            reserved_fee: "140",
            remaining_fee: "0",
            paid_fee: "140",
            locked: "0",
          },
        ],
        { capturedAt },
      );
      throw new Error("expected mapper to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivatePayloadMappingError",
        schema: "CLOSED_ORDERS",
        issuePaths: ["0.price"],
      } satisfies Partial<UpbitPrivatePayloadMappingError>);
      expect(String(error)).not.toContain("provider-secret-price");
    }
  });

  it("uses idempotencyKey fallback to uuid when identifier is missing in closed orders", () => {
    const orders = toBrokerOrdersFromClosedOrders(
      [
        {
          market: "KRW-BTC",
          uuid: "closed-order-no-identifier",
          side: "bid",
          ord_type: "limit",
          price: "50000000.0000",
          state: "done",
          created_at: "2026-06-01T09:00:00+09:00",
          volume: "0.001",
          remaining_volume: "0",
          executed_volume: "0.001",
          reserved_fee: "50",
          remaining_fee: "0",
          paid_fee: "50",
          locked: "0",
          trades_count: 1,
        },
      ],
      { capturedAt },
    );

    expect(orders[0]).toMatchObject({
      brokerOrderId: "closed-order-no-identifier",
      idempotencyKey: "closed-order-no-identifier",
    });
  });
});

describe("Upbit private open orders mapper", () => {
  it("maps open order list payloads to broker order contracts", () => {
    const orders = toBrokerOrdersFromOpenOrders(
      [
        {
          market: "KRW-BTC",
          uuid: "open-order-001",
          side: "bid",
          ord_type: "limit",
          price: "140000000.0000",
          state: "wait",
          created_at: "2026-06-01T09:00:00+09:00",
          volume: "0.002",
          remaining_volume: "0.002",
          executed_volume: "0",
          executed_funds: "0",
          reserved_fee: "140",
          remaining_fee: "140",
          paid_fee: "0",
          locked: "280140",
          time_in_force: "post_only",
          identifier: "m15-open-001",
          trades_count: 0,
        },
        {
          market: "KRW-ETH",
          uuid: "open-order-002",
          side: "ask",
          ord_type: "limit",
          price: "6000000",
          state: "watch",
          created_at: "2026-06-01T09:01:00+09:00",
          volume: "0.05",
          remaining_volume: "0.03",
          executed_volume: "0.02",
          executed_funds: "120000",
          reserved_fee: "0",
          remaining_fee: "0",
          paid_fee: "60",
          locked: "0.03",
          smp_type: "reduce",
          identifier: "m15-open-002",
          prevented_volume: "0",
          prevented_locked: "0",
          trades_count: 1,
        },
      ],
      { capturedAt },
    );

    expect(orders).toMatchObject([
      {
        brokerOrderId: "open-order-001",
        idempotencyKey: "m15-open-001",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        status: "ACCEPTED",
        requestedQuantity: "0.002",
        remainingQuantity: "0.002",
        requestedPrice: "140000000",
        metadata: {
          source: "upbit_private_open_order",
          upbitTimeInForce: "POST_ONLY",
          executedFunds: "0",
          tradesCount: 0,
        },
      },
      {
        brokerOrderId: "open-order-002",
        idempotencyKey: "m15-open-002",
        market: "KRW-ETH",
        side: "SELL",
        status: "PARTIALLY_FILLED",
        requestedQuantity: "0.05",
        remainingQuantity: "0.03",
        requestedPrice: "6000000",
        metadata: {
          source: "upbit_private_open_order",
          upbitSmpType: "reduce",
          executedFunds: "120000",
          tradesCount: 1,
        },
      },
    ]);
    expect(JSON.stringify(orders)).not.toContain("Authorization");
    expect(JSON.stringify(orders)).not.toContain("\"raw\"");
  });

  it("fails open order mapping without echoing raw invalid values", () => {
    try {
      toBrokerOrdersFromOpenOrders(
        [
          {
            market: "KRW-BTC",
            uuid: "open-order-secret",
            side: "bid",
            ord_type: "limit",
            price: "provider-secret-price",
            state: "wait",
            created_at: "2026-06-01T09:00:00+09:00",
            volume: "0.002",
            remaining_volume: "0.002",
            executed_volume: "0",
            reserved_fee: "140",
            remaining_fee: "140",
            paid_fee: "0",
            locked: "280140",
          },
        ],
        { capturedAt },
      );
      throw new Error("expected mapper to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "UpbitPrivatePayloadMappingError",
        schema: "OPEN_ORDERS",
        issuePaths: ["0.price"],
      } satisfies Partial<UpbitPrivatePayloadMappingError>);
      expect(String(error)).not.toContain("provider-secret-price");
    }
  });
});

describe("Upbit private user-action error summary", () => {
  it("separates permission failures into Korean user action and trace fields", () => {
    const summary = toUpbitPrivateUserActionErrorSummary(
      new UpbitPrivateRestClientError({
        status: 401,
        statusText: "Unauthorized",
        kind: "PERMISSION_DENIED",
        userMessage: "provider-secret-body 권한 실패",
        rateLimitStatus: exchangeRateLimitStatus,
        trace: {
          httpStatus: 401,
          upbitErrorName: "out_of_scope",
          rateLimitStatus: exchangeRateLimitStatus,
        },
      }),
      { correlationId: "m14-correlation-001" },
    );

    expect(summary).toEqual({
      title: "Upbit API 권한을 다시 확인해야 합니다.",
      message: "현재 API key 권한으로 요청한 private endpoint를 사용할 수 없어 추가 호출을 중단했습니다.",
      requiredAction:
        "자산조회/주문조회 권한과 저장소 밖 redacted 권한 증거를 확인하고, 출금 권한이 없는 key로 재실행하세요.",
      trace: {
        kind: "PERMISSION_DENIED",
        httpStatus: 401,
        upbitErrorName: "out_of_scope",
        rateLimitStatus: exchangeRateLimitStatus,
        correlationId: "m14-correlation-001",
      },
    });
    expect(JSON.stringify(summary)).not.toContain("provider-secret-body");
  });

  it("summarizes local unsafe request errors without provider side effects", () => {
    const summary = toUpbitPrivateUserActionErrorSummary(
      new UnsafeUpbitPrivateRequestError({
        violations: ["주문 조회에는 uuid 또는 identifier가 필요합니다"],
      }),
    );

    expect(summary).toMatchObject({
      title: "거래소 호출 전에 요청을 중단했습니다.",
      trace: {
        kind: "UNSAFE_REQUEST",
        violations: ["주문 조회에는 uuid 또는 identifier가 필요합니다"],
      },
    });
  });

  it("does not echo unknown raw error messages", () => {
    const summary = toUpbitPrivateUserActionErrorSummary(new Error("raw-secret-provider-message"));

    expect(summary).toMatchObject({
      title: "수동 확인이 필요합니다.",
      trace: {
        kind: "UNKNOWN",
      },
    });
    expect(JSON.stringify(summary)).not.toContain("raw-secret-provider-message");
  });
});

const exchangeRateLimitStatus = {
  kind: "OK",
  remainingReq: {
    group: "exchange",
    sec: 28,
    exhausted: false,
  },
} satisfies UpbitRateLimitStatus;

function createOrderChancePayload(): unknown {
  return {
    bid_fee: "0.0005",
    ask_fee: "0.0005",
    maker_bid_fee: "0.0004",
    maker_ask_fee: "0.0004",
    market: {
      id: "KRW-BTC",
      name: "BTC/KRW",
      order_types: ["limit"],
      order_sides: ["ask", "bid"],
      bid_types: ["best_fok", "best_ioc", "limit", "limit_fok", "limit_ioc", "price"],
      ask_types: ["best_fok", "best_ioc", "limit", "limit_fok", "limit_ioc", "market"],
      bid: {
        currency: "KRW",
        min_total: "5000",
      },
      ask: {
        currency: "BTC",
        min_total: "5000",
      },
      max_total: "1000000000",
      state: "active",
    },
    bid_account: {
      currency: "KRW",
      balance: "10000.0000",
      locked: "0",
      avg_buy_price: "0",
      avg_buy_price_modified: true,
      unit_currency: "KRW",
    },
    ask_account: {
      currency: "BTC",
      balance: "0.00100000",
      locked: "0",
      avg_buy_price: "140000000",
      avg_buy_price_modified: false,
      unit_currency: "KRW",
    },
  };
}
