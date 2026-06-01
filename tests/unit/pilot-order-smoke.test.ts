import { describe, expect, it } from "vitest";
import {
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UnsafePilotOrderSmokeRequestError,
  createPilotOrderSmokeRequestPlan,
  loadPilotRuntimeConfigFromEnv,
} from "../../src/runtime/index.js";

describe("pilot order smoke guard", () => {
  it("creates same-identifier create/cancel/lookup request plans for small post-only KRW bids", () => {
    const plan = createPilotOrderSmokeRequestPlan({
      pilotConfig: orderSmokeConfig(),
      intent: {
        market: "KRW-BTC",
        side: "bid",
        volume: "0.0001",
        price: "50000000",
        identifier: "m14smoke000000000000000001",
        timeInForce: "post_only",
      },
    });

    expect(plan).toEqual({
      createOrder: {
        market: "KRW-BTC",
        side: "bid",
        volume: "0.0001",
        price: "50000000",
        identifier: "m14smoke000000000000000001",
        timeInForce: "post_only",
      },
      cancelOrder: {
        identifier: "m14smoke000000000000000001",
      },
      lookupOrder: {
        identifier: "m14smoke000000000000000001",
      },
      notionalKrw: "5000",
    });
  });

  it("fails closed before order side effects when profile or explicit guards are missing", () => {
    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: loadPilotRuntimeConfigFromEnv({}),
        intent: safeIntent(),
      }),
    ).toThrow(UnsafePilotOrderSmokeRequestError);

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: loadPilotRuntimeConfigFromEnv({
          SEEMIRAI_PILOT_PROFILE: "PILOT_POLICY_SYNC",
          SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
          SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
          SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
        }),
        intent: safeIntent(),
      }),
    ).toThrow("PILOT_ORDER_SMOKE profile이 필요합니다");
  });

  it("rejects non-KRW markets, market mismatch, non-bid sides, and non-post-only intents", () => {
    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          market: "BTC-ETH",
        },
      }),
    ).toThrow("order smoke market은 KRW- 로 시작하는 현물 market이어야 합니다");

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          market: "KRW-ETH",
        },
      }),
    ).toThrow("SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET");

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          side: "ask",
        } as unknown as ReturnType<typeof safeIntent>,
      }),
    ).toThrow("지정가 매수");

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          timeInForce: "ioc",
        } as unknown as ReturnType<typeof safeIntent>,
      }),
    ).toThrow("time_in_force=post_only");
  });

  it("rejects identifier length and KRW notional outside the configured smoke budget", () => {
    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          identifier: "x".repeat(UPBIT_PILOT_IDENTIFIER_MAX_LENGTH + 1),
        },
      }),
    ).toThrow(`${UPBIT_PILOT_IDENTIFIER_MAX_LENGTH}자 이하`);

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          volume: "0.00009",
        },
      }),
    ).toThrow("5000 KRW 이상");

    expect(() =>
      createPilotOrderSmokeRequestPlan({
        pilotConfig: orderSmokeConfig(),
        intent: {
          ...safeIntent(),
          volume: "0.00021",
        },
      }),
    ).toThrow("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 이하");
  });
});

function orderSmokeConfig() {
  return loadPilotRuntimeConfigFromEnv({
    SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
    SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
    SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
    SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
    SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
    SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-BTC",
    SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "10000",
  });
}

function safeIntent() {
  return {
    market: "KRW-BTC",
    side: "bid",
    volume: "0.0001",
    price: "50000000",
    identifier: "m14smoke000000000000000001",
    timeInForce: "post_only",
  } as const;
}
