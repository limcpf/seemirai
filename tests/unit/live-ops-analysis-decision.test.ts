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
  resolveLiveOpsDecisionPolicy,
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

function orderbookEvent(): MarketDataEvent {
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
