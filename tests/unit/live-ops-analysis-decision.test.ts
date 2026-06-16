import { describe, expect, it } from "vitest";
import type {
  FeatureCalculationResult,
} from "../../src/application/index.js";
import type {
  OrderIntent,
  Strategy,
  StrategyContext,
} from "../../src/domain/index.js";
import {
  defaultLiveOpsConfig,
  runLiveOpsAnalysisDecisionPipeline,
} from "../../src/runtime/index.js";
import type {
  LiveOpsMarketDataCollectorSummary,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-14T00:00:00.000Z";

describe("production live ops analysis/decision pipeline", () => {
  it("does not evaluate strategies when market data collector is not ready", async () => {
    const strategy = createThrowingStrategy();

    const summary = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary({ ready: false }),
      observedAt,
      marketEvents: [],
      strategies: [strategy],
    });

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
    const summary = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [createThrowingStrategy()],
      featureSnapshot: failedFeatureSnapshot(),
    });

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

    const summary = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [strategy],
      featureSnapshot: okFeatureSnapshot(),
    });

    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionCategory: "ORDER_INTENT",
      featureStatus: "ok",
      evaluatedStrategyCount: 1,
      orderIntentCount: 1,
      recordHoldDecision: false,
    });
    expect(summary.orderIntents).toHaveLength(1);
    expect(summary.orderIntents[0]?.idempotencyKey).toBe("fixture-order-intent");
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
    const summary = await runLiveOpsAnalysisDecisionPipeline({
      config: defaultLiveOpsConfig,
      marketData: marketDataSummary(),
      observedAt,
      marketEvents: [],
      strategies: [createHoldStrategy()],
      featureSnapshot: okFeatureSnapshot(),
    });

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

function okFeatureSnapshot(): FeatureCalculationResult {
  return {
    status: "ok",
    observedAt,
    features: {
      cost_adjusted_margin_bps: "10",
      session_liquidity_state: "normal",
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
    requiredFeatures: [],
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
