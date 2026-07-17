import { describe, expect, it } from "vitest";
import type {
  MarketDataEvent,
} from "../../src/domain/index.js";
import {
  LIVE_OPS_AUTONOMOUS_24X7_DECISION_POLICY_ID,
  LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
  LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
  defaultLiveOpsConfig,
  loadLiveOpsConfig,
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
      idempotencyKey: "live_ops_cleanup_probe:runtime_preflight_day:upbit_krw_spot:KRW-BTC:BUY:99999000:0.0001:9999.9",
      postOnly: true,
      timeInForce: "POST_ONLY",
      metadata: {
        expected_loss_bps_of_equity: "5",
        idempotency_date_scope: "runtime_preflight_day",
        idempotency_date_source: "live_ops_runtime_preflight",
        strategy_observed_at: observedAt,
        policy_id: "cleanup_probe",
      },
    });
  });

  it("cleanup_probe strategy는 observedAt 날짜가 달라도 runtime preflight 날짜 placeholder를 유지한다", async () => {
    const [strategy] = resolveLiveOpsDecisionPolicy({ config: defaultLiveOpsConfig }).strategies;
    if (strategy === undefined) throw new Error("expected cleanup strategy");

    const firstDecision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-06-16T23:59:59.000Z",
      marketEvents: [orderbookEvent()],
      features: {},
    });
    const nextDecision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt: "2026-06-17T00:00:00.000Z",
      marketEvents: [orderbookEvent()],
      features: {},
    });

    expect(firstDecision.kind).toBe("ORDER_INTENT");
    expect(nextDecision.kind).toBe("ORDER_INTENT");
    if (firstDecision.kind !== "ORDER_INTENT" || nextDecision.kind !== "ORDER_INTENT") {
      throw new Error("expected order intent");
    }
    expect(firstDecision.orderIntents[0]?.idempotencyKey).toContain(":runtime_preflight_day:");
    expect(nextDecision.orderIntents[0]?.idempotencyKey).toContain(":runtime_preflight_day:");
    expect(firstDecision.orderIntents[0]?.idempotencyKey).toBe(nextDecision.orderIntents[0]?.idempotencyKey);
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

  it("autonomous_24x7 policy를 정적 allowlist strategy로 조립하고 동적 코드 경로를 허용하지 않는다", () => {
    const config = loadLiveOpsConfig(autonomousConfig());
    const resolution = resolveLiveOpsDecisionPolicy({ config });

    expect(resolution).toMatchObject({
      policyId: LIVE_OPS_AUTONOMOUS_24X7_DECISION_POLICY_ID,
      evidence: {
        policyId: LIVE_OPS_AUTONOMOUS_24X7_DECISION_POLICY_ID,
        strategyIds: [LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID],
        dynamicCodeLoading: false,
      },
    });
    expect(resolution.strategies).toHaveLength(1);
    expect(resolution.strategies[0]?.requiredFeatures).toEqual([
      "cost_adjusted_margin_bps",
      "trend_strength_bps",
      "mean_reversion_discount_bps",
    ]);
    expect(() => loadLiveOpsConfig({
      ...config,
      analysis: {
        ...config.analysis,
        decision_policy: {
          ...config.analysis.decision_policy,
          strategy_module_path: "/tmp/unsafe-strategy.js",
        },
      },
    })).toThrow();
  });

  it("autonomous_24x7 strategy는 보유 포지션의 take profit 조건에서 SELL LIMIT POST_ONLY 후보를 먼저 만든다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101200000", ask: "101201000" })],
      features: strongEntryFeatures(),
      positions: heldPosition(),
    });

    expect(decision.kind).toBe("ORDER_INTENT");
    if (decision.kind !== "ORDER_INTENT") throw new Error("expected exit order intent");
    expect(decision.reason).toBe("autonomous_24x7_take_profit");
    expect(decision.orderIntents).toHaveLength(1);
    expect(decision.orderIntents[0]).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
      side: "SELL",
      orderType: "LIMIT",
      requestedPrice: "101202000",
      requestedQuantity: "0.00009881",
      requestedNotional: "9999.76962",
      postOnly: true,
      timeInForce: "POST_ONLY",
      reason: "autonomous_24x7_take_profit",
      metadata: {
        position_effect: "REDUCE",
        exit_reason_code: "autonomous_24x7_take_profit",
        exit_rule_id: "take_profit",
        exit_target_quantity: "0.0002",
        exit_chunked: "true",
        max_exit_notional_krw: "10000",
        position_scope: {
          market: "KRW-BTC",
          strategy_id: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
          total_quantity: "0.0002",
        },
      },
    });
  });

  it("autonomous_24x7 strategy는 최소 주문금액보다 작은 SELL 청산을 HOLD로 낮춰 다음 tick에서 재시도한다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101200000", ask: "101201000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({
        quantity: "0.00000023",
        openPositionNotionalKrw: "21.57469",
      }),
    });

    expect(decision).toMatchObject({
      kind: "HOLD",
      strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
      reason: "autonomous_24x7_exit_notional_below_minimum_retry",
      metadata: {
        requested_notional_krw: "23.27646",
        minimum_order_notional_krw: "5000",
        exit_reason_code: "autonomous_24x7_take_profit",
        exit_rule_id: "take_profit",
        retry_after_ms: "5000",
      },
    });
  });

  it("autonomous_24x7 strategy는 stop loss 조건에서 보유 수량 이하 SELL 후보를 만든다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "99190000", ask: "99200000" })],
      features: strongEntryFeatures(),
      positions: heldPosition(),
    });

    expect(decision.kind).toBe("ORDER_INTENT");
    if (decision.kind !== "ORDER_INTENT") throw new Error("expected exit order intent");
    expect(decision.reason).toBe("autonomous_24x7_stop_loss");
    expect(decision.orderIntents[0]).toMatchObject({
      side: "SELL",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
    });
    expect(Number(decision.orderIntents[0]?.requestedQuantity)).toBeLessThanOrEqual(0.0002);
    expect(Number(decision.orderIntents[0]?.requestedNotional)).toBeLessThanOrEqual(10000);
  });

  it("autonomous_24x7 strategy는 trailing stop과 max holding rule을 독립 exit rule로 평가한다", async () => {
    const strategy = resolveAutonomousStrategy();
    const trailing = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101300000", ask: "101301000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({ highWatermarkPrice: "102000000" }),
    });
    const maxHolding = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100100000", ask: "100101000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({ openedAt: "2026-06-14T00:00:00.000Z" }),
    });

    expect(trailing).toMatchObject({ kind: "ORDER_INTENT", reason: "autonomous_24x7_trailing_stop" });
    expect(maxHolding).toMatchObject({ kind: "ORDER_INTENT", reason: "autonomous_24x7_max_holding_time" });
  });

  it("autonomous_24x7 strategy는 risk reduction rule에서 절반 축소 SELL 후보를 만든다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100100000", ask: "100101000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({ highWatermarkPrice: "100200000", openPositionNotionalKrw: "26000" }),
    });

    expect(decision.kind).toBe("ORDER_INTENT");
    if (decision.kind !== "ORDER_INTENT") throw new Error("expected exit order intent");
    expect(decision.reason).toBe("autonomous_24x7_risk_reduction");
    expect(decision.orderIntents[0]).toMatchObject({
      side: "SELL",
      postOnly: true,
      timeInForce: "POST_ONLY",
    });
    expect(Number(decision.orderIntents[0]?.requestedQuantity)).toBeLessThanOrEqual(0.0001);
    expect(Number(decision.orderIntents[0]?.requestedNotional)).toBeLessThanOrEqual(10000);
  });

  it("autonomous_24x7 strategy는 risk reduction보다 익절과 trailing stop exit rule을 우선한다", async () => {
    const strategy = resolveAutonomousStrategy();
    const takeProfit = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101200000", ask: "101201000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({ openPositionNotionalKrw: "26000" }),
    });
    const trailing = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101300000", ask: "101301000" })],
      features: strongEntryFeatures(),
      positions: heldPosition({ highWatermarkPrice: "102000000", openPositionNotionalKrw: "26000" }),
    });

    expect(takeProfit).toMatchObject({
      kind: "ORDER_INTENT",
      reason: "autonomous_24x7_take_profit",
    });
    expect(trailing).toMatchObject({
      kind: "ORDER_INTENT",
      reason: "autonomous_24x7_trailing_stop",
    });
  });

  it("autonomous_24x7 strategy는 보유 중 exit 조건이 약하면 BUY를 만들지 않고 HOLD로 닫는다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100400000", ask: "100401000" })],
      features: strongEntryFeatures(),
      positions: heldPosition(),
    });

    expect(decision).toMatchObject({
      kind: "HOLD",
      strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
      reason: "autonomous_24x7_position_hold",
    });
  });

  it("autonomous_24x7 strategy는 position snapshot 결측을 무포지션으로 보정하지 않고 BLOCK으로 닫는다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: strongEntryFeatures(),
    });

    expect(decision).toMatchObject({
      kind: "BLOCK",
      strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
      reason: "autonomous_24x7_position_snapshot_missing",
      metadata: {
        positions_present: false,
      },
    });
  });

  it("autonomous_24x7 strategy는 음수 포지션과 보유 중 평균단가 결측을 무포지션으로 보정하지 않는다", async () => {
    const strategy = resolveAutonomousStrategy();
    const negativeQuantity = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: strongEntryFeatures(),
      positions: { quantity: "-0.1", averageEntryPrice: "0" },
    });
    const missingAverageEntry = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: strongEntryFeatures(),
      positions: { quantity: "0.0002", averageEntryPrice: "0" },
    });

    expect(negativeQuantity).toMatchObject({
      kind: "BLOCK",
      reason: "autonomous_24x7_position_snapshot_invalid",
      metadata: {
        quantity_non_negative: false,
      },
    });
    expect(missingAverageEntry).toMatchObject({
      kind: "BLOCK",
      reason: "autonomous_24x7_position_snapshot_invalid",
      metadata: {
        average_entry_price_positive: false,
      },
    });
  });

  it("autonomous_24x7 strategy는 미보유 strong signal에서 BUY LIMIT POST_ONLY 후보를 만들고 weak signal에서는 HOLD한다", async () => {
    const strategy = resolveAutonomousStrategy();
    const buy = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: strongEntryFeatures(),
      positions: { quantity: "0", averageEntryPrice: "0" },
    });
    const hold = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: {
        cost_adjusted_margin_bps: "3",
        trend_strength_bps: "5",
        mean_reversion_discount_bps: "4",
      },
      positions: { quantity: "0", averageEntryPrice: "0" },
    });

    expect(buy.kind).toBe("ORDER_INTENT");
    if (buy.kind !== "ORDER_INTENT") throw new Error("expected entry order intent");
    expect(buy.orderIntents[0]).toMatchObject({
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: "99999000",
      requestedQuantity: "0.0001",
      requestedNotional: "9999.9",
      postOnly: true,
      timeInForce: "POST_ONLY",
    });
    expect(hold).toMatchObject({
      kind: "HOLD",
      reason: "autonomous_24x7_entry_signal_weak",
    });
  });

  it("autonomous_24x7 strategy는 required feature 결측을 ready HOLD가 아니라 BLOCK으로 드러낸다", async () => {
    const strategy = resolveAutonomousStrategy();
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      marketEvents: [orderbookEvent({ bid: "100000000", ask: "100001000" })],
      features: {
        cost_adjusted_margin_bps: "18",
      },
      positions: { quantity: "0", averageEntryPrice: "0" },
    });

    expect(decision).toMatchObject({
      kind: "BLOCK",
      reason: "autonomous_24x7_required_feature_missing",
      metadata: {
        missing_features: ["trend_strength_bps", "mean_reversion_discount_bps"],
      },
    });
  });
});

function resolveAutonomousStrategy() {
  const strategies = resolveLiveOpsDecisionPolicy({ config: autonomousConfig() }).strategies;
  if (strategies[0] === undefined) throw new Error("expected autonomous strategy");
  return strategies[0];
}

function autonomousConfig() {
  const config = loadLiveOpsConfig(defaultLiveOpsConfig);
  return {
    ...config,
    analysis: {
      ...config.analysis,
      decision_policy: {
        id: LIVE_OPS_AUTONOMOUS_24X7_DECISION_POLICY_ID,
        autonomous_24x7: {
          max_entry_notional_krw: "10000",
          tick_size_krw: "1000",
          entry_price_offset_ticks: 1,
          exit_price_offset_ticks: 1,
          quantity_scale: 8,
          min_entry_margin_bps: "10",
          trend_confirmation_bps: "20",
          mean_reversion_discount_bps: "30",
          take_profit_bps: "120",
          stop_loss_bps: "80",
          trailing_stop_bps: "60",
          max_holding_ms: 86_400_000,
          risk_reduction_open_notional_krw: "25000",
          risk_reduction_sell_fraction: "0.5",
          expected_loss_bps_of_equity: "5",
        },
      },
    },
  };
}

function heldPosition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    market: "KRW-BTC",
    quantity: "0.0002",
    averageEntryPrice: "100000000",
    openedAt: "2026-06-20T00:00:00.000Z",
    highWatermarkPrice: "101000000",
    openPositionNotionalKrw: "20000",
    ...overrides,
  };
}

function strongEntryFeatures(): Record<string, unknown> {
  return {
    cost_adjusted_margin_bps: "18",
    trend_strength_bps: "25",
    mean_reversion_discount_bps: "12",
  };
}

function orderbookEvent(
  overrides: { bid?: string; ask?: string } = {},
): Extract<MarketDataEvent, { type: "ORDERBOOK" }> {
  const bid = overrides.bid ?? "100000000";
  const ask = overrides.ask ?? "100001000";
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    asks: [{ price: ask, size: "0.5" }],
    bids: [{ price: bid, size: "0.5" }],
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
  };
}
