import { describe, expect, it, vi } from "vitest";
import type {
  LiveAutonomousEntryAttemptResult,
  LiveAutonomousEntryRuntimeRequest,
} from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import type {
  BrokerOrder,
  OrderIntent,
  OrderSubmission,
} from "../../src/domain/index.js";
import {
  defaultLiveOpsConfig,
  runLiveOpsLiveExecution,
} from "../../src/runtime/index.js";
import type {
  LiveOpsAnalysisDecisionSummary,
  LiveOpsLiveExecutionInput,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-14T00:00:00.000Z";
const explicitIdempotencyKey = `ops-${"a".repeat(26)}`;

describe("production live ops live execution adapter", () => {
  it("HOLD decision은 broker/runtime 호출 없이 idle summary로 닫는다", async () => {
    const entryRuntime = createEntryRuntimeRecorder();

    const summary = await runLiveOpsLiveExecution(createInput({
      analysisDecision: analysisSummary({ orderIntentCount: 0, decisionCategory: "HOLD" }),
      orderIntents: [],
      entryRuntime,
    }));

    expect(summary).toMatchObject({
      status: "idle",
      ready: true,
      liveOrderCapable: false,
      orderIntentCount: 0,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_no_order_intent");
    expect(entryRuntime.submitEntryCandidate).not.toHaveBeenCalled();
  });

  it("analysis/decision이 blocked이면 전달된 후보가 있어도 live execution으로 전진하지 않는다", async () => {
    const entryRuntime = createEntryRuntimeRecorder();

    const summary = await runLiveOpsLiveExecution(createInput({
      analysisDecision: analysisSummary({
        ready: false,
        status: "blocked",
        orderIntentCount: 1,
        decisionCategory: "ORDER_INTENT",
      }),
      orderIntents: [createOrderIntent()],
      entryRuntime,
    }));

    expect(summary).toMatchObject({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      attemptedOrderCount: 0,
    });
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_analysis_not_ready");
    expect(entryRuntime.submitEntryCandidate).not.toHaveBeenCalled();
  });

  it("단일 LIMIT + post-only 후보를 live autonomous entry runtime 요청으로 변환한다", async () => {
    const entryRuntime = createEntryRuntimeRecorder();
    const intent = createOrderIntent();

    const summary = await runLiveOpsLiveExecution(createInput({
      analysisDecision: analysisSummary({ orderIntentCount: 1, decisionCategory: "ORDER_INTENT" }),
      orderIntents: [intent],
      entryRuntime,
      idempotencyKey: explicitIdempotencyKey,
    }));

    expect(summary).toMatchObject({
      status: "submitted",
      ready: true,
      liveOrderCapable: true,
      attemptedOrderCount: 1,
      submittedOrderCount: 1,
      attemptId: explicitIdempotencyKey,
      brokerOrderId: "fake-live-order-001",
    });
    expect(entryRuntime.submitEntryCandidate).toHaveBeenCalledTimes(1);
    const request = entryRuntime.submitEntryCandidate.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      observedAt,
      killSwitchActive: false,
      reconcileFresh: true,
      idempotencyKey: explicitIdempotencyKey,
      config: {
        enabled: true,
        allowed_markets: ["KRW-BTC"],
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
        max_daily_loss_krw: "10000",
        max_weekly_loss_krw: "30000",
        max_price_deviation_bps: "30",
        identifier_prefix: "ops-",
        identifier_max_length: 32,
      },
      candidate: {
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "fixture_order_strategy",
        requestedQuantity: "0.0001",
        requestedNotional: "10000",
        requestedPrice: "100000000",
        referencePrice: "100000000",
        orderType: "LIMIT",
        postOnly: true,
        expectedLossBpsOfEquity: "5",
        metadata: {
          source: "live_ops_live_execution",
          decision_idempotency_key: "decision-fixture-order-intent",
        },
      },
    });
    expect(JSON.stringify(summary)).not.toContain("fake-upbit-secret-key");
  });

  it("시장가나 post-only가 아닌 후보는 하위 runtime 호출 전에 fail-closed 한다", async () => {
    const entryRuntime = createEntryRuntimeRecorder();

    const summary = await runLiveOpsLiveExecution(createInput({
      analysisDecision: analysisSummary({ orderIntentCount: 1, decisionCategory: "ORDER_INTENT" }),
      orderIntents: [
        {
          ...createOrderIntent(),
          orderType: "MARKET",
          requestedPrice: undefined,
          postOnly: undefined,
          timeInForce: undefined,
        } as OrderIntent,
      ],
      entryRuntime,
    }));

    expect(summary.status).toBe("blocked");
    expect(summary.ready).toBe(false);
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_order_intent_blocked");
    expect(entryRuntime.submitEntryCandidate).not.toHaveBeenCalled();
  });

  it("expected loss 입력이 없는 후보는 RiskGate 연결 전에 차단한다", async () => {
    const entryRuntime = createEntryRuntimeRecorder();
    const intent = createOrderIntent();

    const summary = await runLiveOpsLiveExecution(createInput({
      analysisDecision: analysisSummary({ orderIntentCount: 1, decisionCategory: "ORDER_INTENT" }),
      orderIntents: [
        {
          ...intent,
          metadata: {},
        },
      ],
      entryRuntime,
    }));

    expect(summary.status).toBe("blocked");
    expect(summary.checks.map((check) => check.code)).toContain("live_ops_order_intent_blocked");
    expect(JSON.stringify(summary.checks)).toContain("expected loss");
    expect(entryRuntime.submitEntryCandidate).not.toHaveBeenCalled();
  });
});

function createInput(
  overrides: Partial<LiveOpsLiveExecutionInput> = {},
): LiveOpsLiveExecutionInput {
  return {
    config: defaultLiveOpsConfig,
    analysisDecision: analysisSummary({ orderIntentCount: 1, decisionCategory: "ORDER_INTENT" }),
    orderIntents: [createOrderIntent()],
    observedAt,
    budgetSnapshot: {
      maxOrderKrw: "10000",
      dailyAutonomousNotionalLimitKrw: "30000",
      dailyAutonomousNotionalUsedKrw: "0",
      openPositionNotionalKrw: "0",
      maxOpenPositionNotionalKrw: "30000",
      capturedAt: observedAt,
    },
    lossSnapshot: {
      dailyRealizedLossKrw: "0",
      weeklyRealizedLossKrw: "0",
      capturedAt: observedAt,
    },
    costInput: {
      expectedReturnBps: "40",
      entryFeeBps: "5",
      exitFeeBps: "5",
      spreadCostBpsP75: "2",
      expectedSlippageBpsP95: "2",
      cancelRequotePenaltyBps: "1",
      safetyBufferBps: "10",
    },
    risk: {
      account: {
        equityKrw: "1000000",
        dailyRealizedPnlBps: "0",
        weeklyRealizedPnlBps: "0",
        maxDrawdownBps: "0",
        capturedAt: observedAt,
      },
      positions: [],
      strategy: {
        strategyId: "fixture_order_strategy",
        consecutiveLosses: 0,
        capturedAt: observedAt,
      },
      infrastructureSignals: [],
      thresholdSnapshot: createRiskThresholdSnapshot(
        defaultRiskLimitThresholds,
        observedAt,
        "live-ops-live-execution.test",
      ),
    },
    killSwitchActive: false,
    reconcileFresh: true,
    entryRuntime: createEntryRuntimeRecorder(),
    ...overrides,
  };
}

function analysisSummary(
  overrides: Partial<LiveOpsAnalysisDecisionSummary> = {},
): LiveOpsAnalysisDecisionSummary {
  const orderIntentCount = overrides.orderIntentCount ?? 0;
  return {
    status: overrides.ready === false ? "blocked" : "ready",
    ready: true,
    market: "KRW-BTC",
    observedAt,
    latestDecisionAt: observedAt,
    decisionCategory: orderIntentCount > 0 ? "ORDER_INTENT" : "HOLD",
    featureStatus: "ok",
    evaluatedStrategyCount: 1,
    holdCount: orderIntentCount > 0 ? 0 : 1,
    blockCount: 0,
    orderIntentCount,
    recordHoldDecision: orderIntentCount === 0,
    message: "analysis fixture",
    checks: [],
    trace: {
      source: "live_ops_analysis_decision",
    },
    ...overrides,
  };
}

function createOrderIntent(): Extract<OrderIntent, { orderType: "LIMIT" }> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "fixture_order_strategy",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    requestedPrice: "100000000",
    idempotencyKey: "decision-fixture-order-intent",
    reason: "fixture order",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      expected_loss_bps_of_equity: "5",
    },
  };
}

function createEntryRuntimeRecorder() {
  return {
    submitEntryCandidate: vi.fn(async (request: LiveAutonomousEntryRuntimeRequest): Promise<LiveAutonomousEntryAttemptResult> => {
      const submission = createSubmission(request);
      return {
        attemptId: request.idempotencyKey ?? explicitIdempotencyKey,
        idempotencyKey: request.idempotencyKey ?? explicitIdempotencyKey,
        status: "SUBMITTED",
        message: "fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          source: "live_autonomous_entry_runtime",
          reason: "broker_submitted",
        },
        intent: submission.intent,
        submission,
        executionResult: {
          status: "SUBMITTED",
          submission,
          brokerOrder: createBrokerOrder(submission),
        },
      };
    }),
  };
}

function createSubmission(request: LiveAutonomousEntryRuntimeRequest): OrderSubmission {
  return {
    intent: {
      exchangeId: request.candidate.exchangeId,
      market: request.candidate.market,
      strategyId: request.candidate.strategyId,
      side: "BUY",
      orderType: "LIMIT",
      requestedQuantity: request.candidate.requestedQuantity,
      requestedNotional: request.candidate.requestedNotional,
      requestedPrice: request.candidate.requestedPrice,
      idempotencyKey: request.idempotencyKey ?? explicitIdempotencyKey,
      reason: request.candidate.reason,
      postOnly: true,
      timeInForce: "POST_ONLY",
    },
    costSnapshot: {},
    riskApproval: {},
    submittedAt: request.observedAt ?? observedAt,
  };
}

function createBrokerOrder(submission: OrderSubmission): BrokerOrder {
  const order: BrokerOrder = {
    brokerOrderId: "fake-live-order-001",
    idempotencyKey: submission.intent.idempotencyKey,
    exchangeId: submission.intent.exchangeId,
    market: submission.intent.market,
    side: submission.intent.side,
    orderType: submission.intent.orderType,
    status: "ACCEPTED",
    requestedQuantity: submission.intent.requestedQuantity,
    remainingQuantity: submission.intent.requestedQuantity,
    acceptedAt: observedAt,
    updatedAt: observedAt,
  };

  if (submission.intent.requestedPrice !== undefined) {
    order.requestedPrice = submission.intent.requestedPrice;
  }

  return order;
}
