import { describe, expect, it } from "vitest";
import {
  UnsafeUpbitPrivateRequestError,
  UpbitPrivatePayloadMappingError,
  UpbitPrivateRestClientError,
  toBrokerBalanceSnapshot,
  toBrokerOrderFromLookup,
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
