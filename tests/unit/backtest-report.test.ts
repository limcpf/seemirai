import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BacktestOrchestrator,
  costMarginOkRule,
  createBacktestCostComparisonReport,
  createBacktestPaperCandidateRecords,
  createBacktestPaperConsistencyReport,
  createBacktestRunReport,
  createFixtureHistoricalEventSource,
  createPaperBrokerCandidateRecords,
} from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import type {
  BacktestOrderCandidateResult,
  BacktestPaperCandidateRecord,
  BacktestRunResult,
  PaperFillSimulationResult,
} from "../../src/application/index.js";
import type {
  BrokerOrder,
  CostDecision,
  CostModelInput,
  MarketEvent,
  OrderIntent,
  OrderSubmission,
  OrderbookEvent,
  RiskGateContext,
  Strategy,
  StrategyContext,
} from "../../src/domain/index.js";
import { PaperBroker } from "../../src/infrastructure/index.js";

const exchangeId = "upbit_krw_spot";
const market = "KRW-BTC";
const strategyId = "backtest_report_strategy";
const triggerTimestamp = "2026-05-20T00:00:00.050Z";

describe("Backtest report and verification", () => {
  it("reports cost-zero versus cost-aware differences", async () => {
    const zeroCostResult = await runBacktest("zero_cost_allow");
    const costAwareResult = await runBacktest("cost_aware_reject");
    const zeroCostReport = createBacktestRunReport({
      label: "zero_cost",
      result: zeroCostResult,
    });
    const costAwareReport = createBacktestRunReport({
      label: "cost_aware",
      result: costAwareResult,
    });
    const comparison = createBacktestCostComparisonReport({
      zeroCost: zeroCostReport,
      costAware: costAwareReport,
    });

    expect(zeroCostReport.totals).toMatchObject({
      candidateCount: 1,
      simulatedCount: 1,
      filledCount: 1,
      rejectedCount: 0,
      totalFillNotional: "50",
      totalFee: "0",
      estimatedGrossPnlKrw: "0.075",
      estimatedCostKrw: "0",
      estimatedNetPnlKrw: "0.075",
      fillRate: "1",
      averageSlippageBps: "0",
    });
    expect(costAwareReport.totals).toMatchObject({
      candidateCount: 1,
      simulatedCount: 0,
      filledCount: 0,
      rejectedCount: 1,
      estimatedNetPnlKrw: "0",
    });
    expect(costAwareReport.rejectionReasonCounts).toEqual({
      cost_margin_insufficient: 1,
    });
    expect(comparison).toMatchObject({
      totalsDelta: {
        candidateCountDelta: 0,
        simulatedCountDelta: -1,
        rejectedCountDelta: 1,
        filledCountDelta: -1,
        totalFillNotionalDelta: "-50",
        totalFeeDelta: "0",
        estimatedNetPnlKrwDelta: "-0.075",
      },
      statusCountDelta: {
        COST_REJECTED: 1,
        SIMULATED: -1,
      },
      fillStatusCountDelta: {
        FILLED: -1,
      },
      rejectionReasonCountDelta: {
        cost_margin_insufficient: 1,
      },
    });
  });

  it("counts partial IOC fills and canceled no-fill results in fill metrics", () => {
    const report = createBacktestRunReport({
      label: "fill_status_edges",
      result: createBacktestResult([
        createSimulatedCandidate({
          idempotencyKey: "candidate:partial-ioc",
          fillResult: createFillResult({
            status: "IOC_CANCELED",
            orderStatus: "CANCELED",
            reasonCode: "ioc_filled_and_canceled",
            requestedQuantity: "1",
            filledQuantity: "0.5",
            openQuantity: "0",
            canceledQuantity: "0.5",
          }),
        }),
        createSimulatedCandidate({
          idempotencyKey: "candidate:fok-canceled",
          fillResult: createFillResult({
            status: "FOK_CANCELED",
            orderStatus: "CANCELED",
            reasonCode: "fok_not_filled",
            requestedQuantity: "1",
            filledQuantity: "0",
            openQuantity: "0",
            canceledQuantity: "1",
          }),
        }),
      ]),
    });

    expect(report.totals).toMatchObject({
      simulatedCount: 2,
      filledCount: 0,
      partiallyFilledCount: 1,
      unfilledCount: 1,
      fillRate: "0.5",
    });
    expect(report.fillStatusCounts).toEqual({
      FOK_CANCELED: 1,
      IOC_CANCELED: 1,
    });
  });

  it("verifies backtest candidates against PaperBroker results from the same fixture", async () => {
    const result = await runBacktest("cost_aware_allow");
    const submission = result.candidates[0]?.submission;
    expect(submission).toBeDefined();
    const paperOrder = await submitPaperOrder(submission!);
    const consistency = createBacktestPaperConsistencyReport({
      backtestCandidates: createBacktestPaperCandidateRecords(result),
      paperCandidates: createPaperBrokerCandidateRecords([paperOrder]),
    });

    expect(consistency).toEqual({
      matches: true,
      backtestCandidateCount: 1,
      paperCandidateCount: 1,
      matchedCandidateCount: 1,
      mismatches: [],
    });
  });

  it("normalizes numeric fields before comparing backtest and PaperBroker candidate records", () => {
    const intent = createIntent({
      idempotencyKey: "candidate:normalized",
      requestedPrice: "100.0",
      requestedQuantity: "1.0",
      requestedNotional: "100.0",
    });
    const result = createBacktestResult([
      createSimulatedCandidate({
        intent,
        fillResult: createFillResult({
          status: "FILLED",
          orderStatus: "FILLED",
          reasonCode: "limit_crossed_full",
          requestedQuantity: "1.0",
          filledQuantity: "1.00",
          openQuantity: "0.0",
          canceledQuantity: "0.0",
          totalFee: "0.0500",
          orderbookReceivedAt: new Date(triggerTimestamp),
          slippageBps: "0.0",
        }),
      }),
    ]);
    const paperOrder: BrokerOrder = {
      brokerOrderId: "paper:normalized",
      idempotencyKey: intent.idempotencyKey,
      exchangeId: intent.exchangeId,
      market: intent.market,
      side: intent.side,
      orderType: intent.orderType,
      status: "FILLED",
      requestedQuantity: "1",
      remainingQuantity: "0",
      requestedPrice: "100",
      updatedAt: triggerTimestamp,
      metadata: {
        paper_fill_simulation: createFillResult({
          status: "FILLED",
          orderStatus: "FILLED",
          reasonCode: "limit_crossed_full",
          requestedQuantity: "1",
          filledQuantity: "1",
          openQuantity: "0",
          canceledQuantity: "0",
          totalFee: "0.05",
          orderbookReceivedAt: triggerTimestamp,
          slippageBps: "0",
        }),
      },
    };

    const consistency = createBacktestPaperConsistencyReport({
      backtestCandidates: createBacktestPaperCandidateRecords(result),
      paperCandidates: createPaperBrokerCandidateRecords([paperOrder]),
    });

    expect(consistency).toMatchObject({
      matches: true,
      mismatches: [],
    });
  });

  it("marks duplicate idempotency keys as consistency mismatches", () => {
    const backtestRecord = createCandidateRecord("candidate:duplicate");
    const paperRecord = createCandidateRecord("candidate:duplicate");

    const consistency = createBacktestPaperConsistencyReport({
      backtestCandidates: [backtestRecord, { ...backtestRecord }],
      paperCandidates: [paperRecord, { ...paperRecord }],
    });

    expect(consistency).toMatchObject({
      matches: false,
      backtestCandidateCount: 2,
      paperCandidateCount: 2,
      matchedCandidateCount: 1,
    });
    expect(consistency.mismatches).toEqual([
      {
        idempotencyKey: "candidate:duplicate",
        field: "backtest_duplicate_idempotency_key",
        backtestValue: 2,
      },
      {
        idempotencyKey: "candidate:duplicate",
        field: "paper_duplicate_idempotency_key",
        paperValue: 2,
      },
    ]);
  });

  it("keeps reporting free from live broker imports", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "backtest", "backtest-report.ts"),
      "utf8",
    );

    expect(source).not.toContain("disabled-live-broker");
    expect(source).not.toContain("upbit");
    expect(source).not.toContain("BrokerPort");
  });
});

type CostProfile = "zero_cost_allow" | "cost_aware_allow" | "cost_aware_reject";

async function runBacktest(costProfile: CostProfile) {
  const orchestrator = new BacktestOrchestrator({
    source: createFixtureHistoricalEventSource(createBacktestFixture()),
    strategies: [createFixtureStrategy()],
    rules: [costMarginOkRule],
  });

  return orchestrator.run(createRunRequest(costProfile));
}

function createRunRequest(costProfile: CostProfile): Parameters<BacktestOrchestrator["run"]>[0] {
  return {
    createStrategyContext: ({ event, strategy, state }) => {
      if (event.kind !== "ORDERBOOK_METRIC") {
        return undefined;
      }

      return {
        strategyId: strategy.id,
        exchangeId: event.exchangeId,
        market: event.market,
        observedAt: event.eventTimestamp,
        marketEvents: state.latestMarketDataEvents,
        features: {
          limit_price: "100",
          requested_quantity: "0.5",
          requested_notional: "50",
        },
      };
    },
    createCostInput: ({ intent, event }): CostModelInput => ({
      exchangeId: intent.exchangeId,
      market: intent.market,
      expectedReturnBps: costProfile === "cost_aware_allow" ? "30" : "15",
      entryFeeBps: costProfile === "zero_cost_allow" ? "0" : "5",
      exitFeeBps: costProfile === "zero_cost_allow" ? "0" : "5",
      spreadCostBpsP75: costProfile === "zero_cost_allow" ? "0" : "1",
      expectedSlippageBpsP95: costProfile === "zero_cost_allow" ? "0" : "1",
      cancelRequotePenaltyBps: "0",
      ...(costProfile === "zero_cost_allow" ? { safetyBufferBps: "0" } : {}),
      evaluatedAt: event.eventTimestamp,
    }),
    createRiskGateContext: ({ intent, event }) => createRiskContext(intent, event.eventTimestamp),
    fillOptions: {
      latencyMs: 100,
      takerFeeBps: costProfile === "zero_cost_allow" ? "0" : "10",
    },
  };
}

function createFixtureStrategy(): Strategy {
  return {
    id: strategyId,
    version: "1",
    requiredFeatures: ["limit_price", "requested_quantity", "requested_notional"],
    evaluate(context: StrategyContext) {
      const intent: OrderIntent = {
        exchangeId,
        market,
        strategyId: context.strategyId,
        side: "BUY",
        orderType: "LIMIT",
        requestedPrice: String(context.features.limit_price),
        requestedQuantity: String(context.features.requested_quantity),
        requestedNotional: String(context.features.requested_notional),
        idempotencyKey: `${context.strategyId}:${context.observedAt}`,
        reason: "fixture_signal",
        timeInForce: "GTC",
      };

      return {
        kind: "ORDER_INTENT",
        strategyId: context.strategyId,
        reason: "fixture_signal",
        orderIntents: [intent],
      };
    },
  };
}

function createBacktestResult(candidates: readonly BacktestOrderCandidateResult[]): BacktestRunResult {
  return {
    events: [],
    strategyEvaluations: [],
    candidates,
  };
}

function createSimulatedCandidate(input: {
  idempotencyKey?: string;
  intent?: OrderIntent;
  fillResult: PaperFillSimulationResult;
}): BacktestOrderCandidateResult {
  const intent =
    input.intent ?? createIntent({ idempotencyKey: input.idempotencyKey ?? "candidate:simulated" });
  return {
    status: "SIMULATED",
    event: createMetricEvent(),
    strategyId,
    intent,
    costDecision: createCostDecision(),
    submission: {
      intent,
      costSnapshot: createCostDecision().snapshot,
      riskApproval: {
        source: "backtest-report.test",
        status: "APPROVED",
      },
      submittedAt: triggerTimestamp,
    },
    executionValidation: {
      valid: true,
    },
    fillResult: input.fillResult,
  };
}

function createIntent(input: {
  idempotencyKey: string;
  requestedPrice?: string;
  requestedQuantity?: string;
  requestedNotional?: string;
}): OrderIntent {
  const requestedQuantity = input.requestedQuantity ?? "1";
  return {
    exchangeId,
    market,
    strategyId,
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: input.requestedPrice ?? "100",
    requestedQuantity,
    requestedNotional: input.requestedNotional ?? requestedQuantity,
    idempotencyKey: input.idempotencyKey,
    reason: "fixture_signal",
    timeInForce: "GTC",
  };
}

function createFillResult(input: Omit<PaperFillSimulationResult, "fills">): PaperFillSimulationResult {
  return {
    ...input,
    fills: [],
    orderbookReceivedAt: input.orderbookReceivedAt ?? triggerTimestamp,
  };
}

function createCostDecision(): CostDecision {
  return {
    kind: "ALLOW",
    tradeAllowed: true,
    reasonCode: "cost_margin_ok",
    message: "fixture cost decision",
    snapshot: {
      exchange_id: exchangeId,
      market,
      expected_return_bps: "10",
      cost_bps: "1",
      trade_allowed: true,
      reason_code: "cost_margin_ok",
    },
  };
}

function createMetricEvent(): MarketEvent {
  return {
    kind: "ORDERBOOK_METRIC",
    exchangeId,
    market,
    eventTimestamp: triggerTimestamp,
    receivedAt: triggerTimestamp,
    sequence: "metric",
    tieBreakKey: "metric:test",
    source: source(99),
    bestBidPrice: "99",
    bestAskPrice: "101",
    spreadBps: "2",
    bidDepth1: "100000000",
    askDepth1: "100000000",
  };
}

function createCandidateRecord(idempotencyKey: string): BacktestPaperCandidateRecord {
  return {
    idempotencyKey,
    exchangeId,
    market,
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "1",
    requestedPrice: "100",
    lifecycleStatus: "FILLED",
    fillStatus: "FILLED",
    fillReasonCode: "limit_crossed_full",
    filledQuantity: "1",
    remainingQuantity: "0",
    totalFee: "0.05",
  };
}

function createRiskContext(intent: OrderIntent, observedAt: MarketEvent["eventTimestamp"]): RiskGateContext {
  return {
    orderIntent: intent,
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "0",
      weeklyRealizedPnlBps: "0",
      maxDrawdownBps: "0",
      capturedAt: observedAt,
    },
    positions: [],
    strategy: {
      strategyId: intent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals: [],
    thresholdSnapshot: createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt, "backtest-report.test"),
    observedAt,
    expectedLossBpsOfEquity: "1",
  };
}

async function submitPaperOrder(submission: OrderSubmission) {
  const broker = new PaperBroker({
    exchangeId,
    initialBalances: [
      {
        currency: "KRW",
        available: "1000000",
      },
      {
        currency: "BTC",
        available: "0",
      },
    ],
    orderbookSnapshots: createPaperOrderbooks(),
    fillOptions: {
      latencyMs: 100,
      takerFeeBps: "10",
    },
    clock: () => triggerTimestamp,
  });

  return broker.submitOrder(submission);
}

function createBacktestFixture(): unknown {
  return {
    schemaVersion: 1,
    events: [
      {
        kind: "POLICY_CANDIDATE",
        exchangeId,
        market,
        eventTimestamp: "2026-05-20T00:00:00.000Z",
        sequence: "1",
        tieBreakKey: "policy:healthy",
        source: source(0),
        tradable: true,
        warning: false,
        caution: false,
        reasonCodes: [],
        minimumOrderNotional: "5000",
        bidFeeBps: "5",
        askFeeBps: "5",
      },
      {
        kind: "ORDERBOOK_SNAPSHOT",
        exchangeId,
        market,
        eventTimestamp: "2026-05-20T00:00:00.040Z",
        receivedAt: "2026-05-20T00:00:00.040Z",
        sequence: "2",
        tieBreakKey: "orderbook:before-latency",
        source: source(1),
        asks: [
          {
            price: "101",
            size: "1",
          },
        ],
        bids: [
          {
            price: "99",
            size: "1",
          },
        ],
      },
      {
        kind: "ORDERBOOK_METRIC",
        exchangeId,
        market,
        eventTimestamp: triggerTimestamp,
        receivedAt: triggerTimestamp,
        sequence: "3",
        tieBreakKey: "metric:trigger",
        source: source(2),
        bestBidPrice: "99",
        bestAskPrice: "101",
        spreadBps: "2",
        bidDepth1: "100000000",
        askDepth1: "100000000",
      },
      {
        kind: "ORDERBOOK_SNAPSHOT",
        exchangeId,
        market,
        eventTimestamp: "2026-05-20T00:00:00.150Z",
        receivedAt: "2026-05-20T00:00:00.150Z",
        sequence: "4",
        tieBreakKey: "orderbook:after-latency",
        source: source(3),
        asks: [
          {
            price: "100",
            size: "0.5",
          },
        ],
        bids: [
          {
            price: "99",
            size: "1",
          },
        ],
      },
    ],
  };
}

function createPaperOrderbooks(): readonly OrderbookEvent[] {
  return [
    {
      type: "ORDERBOOK",
      exchangeId,
      market,
      exchangeTimestamp: "2026-05-20T00:00:00.040Z",
      receivedAt: "2026-05-20T00:00:00.040Z",
      asks: [
        {
          price: "101",
          size: "1",
        },
      ],
      bids: [
        {
          price: "99",
          size: "1",
        },
      ],
    },
    {
      type: "ORDERBOOK",
      exchangeId,
      market,
      exchangeTimestamp: "2026-05-20T00:00:00.150Z",
      receivedAt: "2026-05-20T00:00:00.150Z",
      asks: [
        {
          price: "100",
          size: "0.5",
        },
      ],
      bids: [
        {
          price: "99",
          size: "1",
        },
      ],
    },
  ];
}

function source(sourceIndex: number): {
  sourceKind: "FIXTURE";
  sourceId: string;
  sourceIndex: number;
} {
  return {
    sourceKind: "FIXTURE",
    sourceId: "backtest-report.test.ts",
    sourceIndex,
  };
}
