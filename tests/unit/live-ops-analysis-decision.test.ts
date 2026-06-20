import { describe, expect, it } from "vitest";
import type {
  FeatureCalculationResult,
} from "../../src/application/index.js";
import type {
  MarketDataEvent,
  OrderIntent,
  Strategy,
  StrategyContext,
} from "../../src/domain/index.js";
import {
  LIVE_OPS_AUTONOMOUS_24X7_DECISION_POLICY_ID,
  resolveLiveOpsDecisionPolicy,
  defaultLiveOpsConfig,
  loadLiveOpsConfig,
  runLiveOpsAnalysisDecisionPipeline,
} from "../../src/runtime/index.js";
import type {
  LiveOpsMarketDataCollectorSummary,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-14T00:00:00.000Z";

describe("production live ops analysis/decision pipeline", () => {
  it("does not evaluate strategies when market data collector is not ready", async () => {
    const strategy = createThrowingStrategy();

    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary({ ready: false }),
      observedAt,
      marketEvents: [],
      strategies: [strategy],
    });
    const { summary } = result;

    expect(summary).toMatchObject({
      status: "blocked",
      ready: false,
      decisionCategory: "HOLD",
      featureStatus: "not_run",
      evaluatedStrategyCount: 0,
      orderIntentCount: 0,
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_market_data_not_ready");
  });

  it("records a HOLD boundary when feature snapshot fails", async () => {
    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [createThrowingStrategy()],
      featureSnapshot: failedFeatureSnapshot(),
    });
    const { summary } = result;

    expect(summary).toMatchObject({
      status: "blocked",
      ready: false,
      decisionCategory: "HOLD",
      featureStatus: "failed",
      recordHoldDecision: true,
      orderIntentCount: 0,
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_feature_snapshot_failed");
  });

  it("evaluates strategies with production KRW-BTC context and counts order intents", async () => {
    const capturedContexts: StrategyContext[] = [];
    const strategy = createOrderIntentStrategy(capturedContexts);

    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [strategy],
      featureSnapshot: okFeatureSnapshot(),
    });
    const { summary } = result;

    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionCategory: "ORDER_INTENT",
      featureStatus: "ok",
      evaluatedStrategyCount: 1,
      orderIntentCount: 1,
      recordHoldDecision: false,
    });
    expect(result.orderIntents).toHaveLength(1);
    expect(result.orderIntents[0]?.idempotencyKey).toBe("fixture-order-intent");
    expect(JSON.stringify(result)).not.toContain("fixture-order-intent");
    expect(capturedContexts[0]).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      observedAt,
      metadata: {
        source: "live_ops_analysis_decision",
      },
    });
    expect(JSON.stringify(summary)).not.toContain("fake-upbit-secret-key");
  });

  it("keeps all-HOLD strategy results as recorded HOLD with zero order intents", async () => {
    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [createHoldStrategy()],
      featureSnapshot: okFeatureSnapshot(),
    });
    const { summary } = result;

    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionCategory: "HOLD",
      evaluatedStrategyCount: 1,
      holdCount: 1,
      orderIntentCount: 0,
      recordHoldDecision: true,
    });
    expect(summary.message).toContain("HOLD");
  });

  it("required feature가 없는 cleanup probe는 feature snapshot 실패와 독립적으로 같은 tick order intent를 반환한다", async () => {
    const [strategy] = resolveLiveOpsDecisionPolicy({ config: defaultLiveOpsConfig }).strategies;
    if (strategy === undefined) throw new Error("expected cleanup strategy");

    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [orderbookEvent()],
      strategies: [strategy],
      featureSnapshot: failedFeatureSnapshot(),
    });

    expect(result.summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionCategory: "ORDER_INTENT",
      featureStatus: "failed",
      orderIntentCount: 1,
    });
    expect(result.summary.checks.map((check) => check.code)).toContain("live_ops_feature_snapshot_not_required");
    expect(result.orderIntents).toHaveLength(1);
    expect(result.orderIntents[0]?.strategyId).toBe("live_ops_cleanup_probe");
    expect(JSON.stringify(result.summary)).not.toContain("idempotencyKey");
    expect(JSON.stringify(result)).not.toContain("live_ops_cleanup_probe:upbit_krw_spot");
  });

  it("BLOCK strategy result는 idle이 아니라 blocked analysis로 닫는다", async () => {
    const result = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [createBlockStrategy()],
      featureSnapshot: okFeatureSnapshot(),
    });

    expect(result.summary).toMatchObject({
      status: "blocked",
      ready: false,
      decisionCategory: "BLOCKED",
      blockCount: 1,
      orderIntentCount: 0,
    });
    expect(result.summary.checks.map((check) => check.code)).toContain("live_ops_strategy_decision_blocked");
    expect(result.orderIntents).toHaveLength(0);
  });

  it("position snapshot을 strategy context로 넘겨 보유 중 exit-before-entry SELL 후보를 만든다", async () => {
    const config = autonomousConfig();
    const [strategy] = resolveLiveOpsDecisionPolicy({ config }).strategies;
    if (strategy === undefined) throw new Error("expected autonomous strategy");

    const result = await runLiveOpsAnalysisDecisionPipeline({
      config,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [orderbookEvent({ bid: "101200000", ask: "101201000" })],
      strategies: [strategy],
      featureSnapshot: okFeatureSnapshot({
        trend_strength_bps: "25",
        mean_reversion_discount_bps: "12",
      }),
      positions: {
        quantity: "0.0002",
        averageEntryPrice: "100000000",
        openedAt: "2026-06-14T00:00:00.000Z",
        highWatermarkPrice: "101000000",
        openPositionNotionalKrw: "20000",
      },
    });

    expect(result.summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionCategory: "ORDER_INTENT",
      orderIntentCount: 1,
    });
    expect(result.orderIntents[0]).toMatchObject({
      side: "SELL",
      orderType: "LIMIT",
      reason: "autonomous_24x7_take_profit",
      postOnly: true,
      timeInForce: "POST_ONLY",
    });
  });
});

function marketDataSummary(
  overrides: Partial<LiveOpsMarketDataCollectorSummary> = {},
): LiveOpsMarketDataCollectorSummary {
  return {
    status: overrides.ready === false ? "blocked" : "ready",
    ready: true,
    provider: "UPBIT_PUBLIC",
    market: "KRW-BTC",
    sourceProfile: "fixture",
    message: "market data fixture ready",
    latestHeartbeatAt: observedAt,
    persisted: {
      eventCount: 3,
      tradeCount: 1,
      orderbookCount: 1,
      statusCount: 1,
      riskBlockCount: 0,
    },
    checks: [],
    ...overrides,
  };
}

function okFeatureSnapshot(features: Record<string, unknown> = {}): FeatureCalculationResult {
  return {
    status: "ok",
    observedAt,
    features: {
      cost_adjusted_margin_bps: "10",
      session_liquidity_state: "normal",
      ...features,
    },
    results: [],
    failureReasons: [],
  };
}

function failedFeatureSnapshot(): FeatureCalculationResult {
  return {
    status: "failed",
    observedAt,
    features: {},
    results: [],
    failureReasons: [
      {
        status: "failed",
        key: "candle_momentum_bps",
        reasonCode: "FEATURE_INSUFFICIENT_INPUT",
        message: "fixture failure",
        observedAt,
        windowEndAt: observedAt,
      },
    ],
  };
}

function createHoldStrategy(): Strategy {
  return {
    id: "fixture_hold_strategy",
    version: "1",
    requiredFeatures: [],
    evaluate: () => ({
      kind: "HOLD",
      strategyId: "fixture_hold_strategy",
      reason: "fixture_hold",
    }),
  };
}

function createBlockStrategy(): Strategy {
  return {
    id: "fixture_block_strategy",
    version: "1",
    requiredFeatures: [],
    evaluate: () => ({
      kind: "BLOCK",
      strategyId: "fixture_block_strategy",
      reason: "fixture_block",
      reasonCode: "fixture_block",
    }),
  };
}

function createOrderIntentStrategy(capturedContexts: StrategyContext[]): Strategy {
  return {
    id: "fixture_order_strategy",
    version: "1",
    requiredFeatures: [],
    evaluate: (context) => {
      capturedContexts.push(context);
      return {
        kind: "ORDER_INTENT",
        strategyId: "fixture_order_strategy",
        reason: "fixture_order",
        orderIntents: [createOrderIntent()],
      };
    },
  };
}

function createThrowingStrategy(): Strategy {
  return {
    id: "throwing_strategy",
    version: "1",
    requiredFeatures: ["cost_adjusted_margin_bps"],
    evaluate: () => {
      throw new Error("strategy should not be evaluated");
    },
  };
}

function createOrderIntent(): OrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "fixture_order_strategy",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    requestedPrice: "100000000",
    idempotencyKey: "fixture-order-intent",
    reason: "fixture_order",
    postOnly: true,
    timeInForce: "POST_ONLY",
  };
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

function orderbookEvent(overrides: { bid?: string; ask?: string } = {}): MarketDataEvent {
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
