import { describe, expect, it } from "vitest";
import type {
  MarketDataEvent,
} from "../../src/domain/index.js";
import {
  LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
  defaultLiveOpsConfig,
  resolveLiveOpsDecisionPolicy,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-16T00:00:00.000Z";

describe("production live ops decision policy resolver", () => {
  it("cleanup_probe policy를 정적 strategy 구현체로 조립한다", () => {
    const resolution = resolveLiveOpsDecisionPolicy({ config: defaultLiveOpsConfig });

    expect(resolution).toMatchObject({
      policyId: "cleanup_probe",
      evidence: {
        policyId: "cleanup_probe",
        strategyIds: [LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID],
        dynamicCodeLoading: false,
      },
    });
    expect(resolution.strategies).toHaveLength(1);
  });

  it("cleanup_probe strategy는 최신 KRW-BTC orderbook에서 단일 BUY LIMIT POST_ONLY 후보를 만든다", async () => {
    const [strategy] = resolveLiveOpsDecisionPolicy({ config: defaultLiveOpsConfig }).strategies;
    if (strategy === undefined) throw new Error("expected cleanup strategy");

    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent()],
      features: {},
    });

    expect(decision.kind).toBe("ORDER_INTENT");
    if (decision.kind !== "ORDER_INTENT") throw new Error("expected order intent");
    expect(decision.orderIntents).toHaveLength(1);
    expect(decision.orderIntents[0]).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: "99999000",
      requestedQuantity: "0.0001",
      requestedNotional: "9999.9",
      idempotencyKey: "live_ops_cleanup_probe:upbit_krw_spot:KRW-BTC:BUY:99999000:0.0001:9999.9",
      postOnly: true,
      timeInForce: "POST_ONLY",
      metadata: {
        expected_loss_bps_of_equity: "5",
        policy_id: "cleanup_probe",
      },
    });
  });

  it("cleanup_probe strategy는 orderbook이 없으면 주문 후보 없이 HOLD로 닫는다", async () => {
    const [strategy] = resolveLiveOpsDecisionPolicy({ config: defaultLiveOpsConfig }).strategies;
    if (strategy === undefined) throw new Error("expected cleanup strategy");

    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [],
      features: {},
    });

    expect(decision).toMatchObject({
      kind: "HOLD",
      strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
      reason: "cleanup_probe_orderbook_missing",
    });
  });
});

function orderbookEvent(): Extract<MarketDataEvent, { type: "ORDERBOOK" }> {
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    asks: [{ price: "100001000", size: "0.5" }],
    bids: [{ price: "100000000", size: "0.5" }],
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
  };
}
