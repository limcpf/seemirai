import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BacktestOrchestrator,
  costMarginOkRule,
  createFixtureHistoricalEventSource,
  evaluateRiskGate,
} from "../../src/application/index.js";
import type { BacktestReplayStateSnapshot } from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import type {
  CostModelInput,
  MarketEvent,
  OrderIntent,
  OrderbookEvent,
  RiskGateContext,
  Rule,
  Strategy,
  StrategyContext,
} from "../../src/domain/index.js";

const exchangeId = "upbit_krw_spot";
const market = "KRW-BTC";
const strategyId = "backtest_fixture_strategy";
const triggerTimestamp = "2026-05-20T00:00:00.050Z";

describe("BacktestOrchestrator", () => {
  it("runs strategy, cost, rule, RiskGate, execution validation, and paper fill in replay order", async () => {
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
    });
    const result = await orchestrator.run(createRunRequest());

    expect(result.events.map((event) => event.kind)).toEqual([
      "POLICY_CANDIDATE",
      "ORDERBOOK_SNAPSHOT",
      "ORDERBOOK_METRIC",
      "ORDERBOOK_SNAPSHOT",
    ]);
    expect(result.strategyEvaluations).toHaveLength(1);
    expect(result.strategyEvaluations[0]).toMatchObject({
      strategyId,
      decision: {
        kind: "ORDER_INTENT",
      },
      conversion: {
        status: "PROMOTED",
      },
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "SIMULATED",
      costDecision: {
        reasonCode: "cost_margin_ok",
      },
      ruleResult: {
        status: "PASS",
      },
      riskGateResult: {
        approved: true,
        action: "ALLOW",
      },
      executionValidation: {
        valid: true,
      },
      submission: {
        costSnapshot: {
          source: "cost_model",
        },
        riskApproval: {
          source: "risk_gate",
          approved: true,
        },
      },
      fillResult: {
        status: "FILLED",
        filledQuantity: "0.5",
        orderbookReceivedAt: "2026-05-20T00:00:00.150Z",
        totalFee: "0.05",
      },
    });
  });

  it("does not expose future orderbook snapshots to decision callbacks", async () => {
    const capturedOrderbooks: Partial<Record<ObservedStatePhase, readonly OrderbookEvent[]>> = {};
    const capturedMarketData: Partial<
      Record<ObservedStatePhase, BacktestReplayStateSnapshot["latestMarketDataEvents"]>
    > = {};
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
    });
    const result = await orchestrator.run(
      createRunRequest({
        observeState: (phase, state) => {
          capturedOrderbooks[phase] = state.orderbookHistory;
          capturedMarketData[phase] = state.latestMarketDataEvents;
        },
      }),
    );

    expect(receivedAtValues(capturedOrderbooks.strategy)).toEqual(["2026-05-20T00:00:00.040Z"]);
    expect(receivedAtValues(capturedOrderbooks.cost)).toEqual(["2026-05-20T00:00:00.040Z"]);
    expect(receivedAtValues(capturedOrderbooks.risk)).toEqual(["2026-05-20T00:00:00.040Z"]);
    expect(marketDataReceivedAtValues(capturedMarketData.strategy)).toEqual(["2026-05-20T00:00:00.040Z"]);
    expect(result.candidates[0]?.fillResult).toMatchObject({
      status: "FILLED",
      orderbookReceivedAt: "2026-05-20T00:00:00.150Z",
    });
  });

  it("uses receivedAt as the backtest submit time for latency-based fill simulation", async () => {
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
      fixture: createLaggedObservationFixture(),
    });
    const result = await orchestrator.run(createRunRequest());

    expect(result.candidates[0]?.submission?.submittedAt).toBe("2026-05-20T00:00:00.200Z");
    expect(result.candidates[0]?.fillResult).toMatchObject({
      status: "UNFILLED",
      reasonCode: "limit_not_crossed",
      metadata: {
        orderbook_received_at: "2026-05-20T00:00:00.300Z",
      },
    });
  });

  it("sorts replay orderbooks by receivedAt before selecting a fill snapshot", async () => {
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
      fixture: createReceivedAtOutOfOrderFixture(),
    });
    const result = await orchestrator.run(
      createRunRequest({
        latencyMs: 5,
      }),
    );

    expect(result.candidates[0]?.fillResult).toMatchObject({
      status: "FILLED",
      filledQuantity: "0.5",
      orderbookReceivedAt: "2026-05-20T00:00:00.035Z",
    });
  });

  it("stops before rules, RiskGate, and fill simulation when the cost model rejects", async () => {
    let riskGateCalls = 0;
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
      evaluateRiskGate: (context) => {
        riskGateCalls += 1;
        return evaluateRiskGate(context);
      },
    });
    const result = await orchestrator.run(
      createRunRequest({
        expectedReturnBps: "10",
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "COST_REJECTED",
      costDecision: {
        reasonCode: "cost_margin_insufficient",
      },
    });
    expect(result.candidates[0]?.ruleResult).toBeUndefined();
    expect(result.candidates[0]?.riskGateResult).toBeUndefined();
    expect(result.candidates[0]?.fillResult).toBeUndefined();
    expect(riskGateCalls).toBe(0);
  });

  it("stops before RiskGate and fill simulation when rules fail", async () => {
    let riskGateCalls = 0;
    const orchestrator = createOrchestrator({
      rules: [
        {
          id: "fixture_fail_rule",
          evaluate: () => ({
            status: "FAIL",
            reasonCode: "fixture_rule_failed",
            message: "fixture rule failed",
          }),
        },
      ],
      evaluateRiskGate: (context) => {
        riskGateCalls += 1;
        return evaluateRiskGate(context);
      },
    });
    const result = await orchestrator.run(createRunRequest());

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "RULE_REJECTED",
      ruleResult: {
        failedEvaluations: [
          {
            reasonCode: "fixture_rule_failed",
          },
        ],
      },
    });
    expect(result.candidates[0]?.riskGateResult).toBeUndefined();
    expect(result.candidates[0]?.fillResult).toBeUndefined();
    expect(riskGateCalls).toBe(0);
  });

  it("stops before fill simulation when RiskGate rejects the approved cost/rule candidate", async () => {
    const orchestrator = createOrchestrator({
      rules: [costMarginOkRule],
    });
    const result = await orchestrator.run(
      createRunRequest({
        expectedLossBpsOfEquity: "25",
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "RISK_REJECTED",
      riskGateResult: {
        approved: false,
        failedEvaluations: [
          expect.objectContaining({
            reasonCode: "expected_loss_limit_exceeded",
          }),
        ],
      },
    });
    expect(result.candidates[0]?.fillResult).toBeUndefined();
  });

  it("keeps the backtest boundary free from live broker imports", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "backtest", "backtest-orchestrator.ts"),
      "utf8",
    );

    expect(source).not.toContain("disabled-live-broker");
    expect(source).not.toContain("upbit");
    expect(source).not.toContain("BrokerPort");
  });
});

function createOrchestrator(options: {
  rules: readonly Rule[];
  evaluateRiskGate?: (context: RiskGateContext) => ReturnType<typeof evaluateRiskGate>;
  fixture?: unknown;
}): BacktestOrchestrator {
  return new BacktestOrchestrator({
    source: createFixtureHistoricalEventSource(options.fixture ?? createBacktestFixture()),
    strategies: [createFixtureStrategy()],
    rules: options.rules,
    ...(options.evaluateRiskGate === undefined ? {} : { evaluateRiskGate: options.evaluateRiskGate }),
  });
}

type ObservedStatePhase = "strategy" | "cost" | "risk";

function createRunRequest(options: {
  expectedReturnBps?: string;
  expectedLossBpsOfEquity?: string;
  latencyMs?: number;
  observeState?: (phase: ObservedStatePhase, state: BacktestReplayStateSnapshot) => void;
} = {}): Parameters<BacktestOrchestrator["run"]>[0] {
  return {
    createStrategyContext: ({ event, strategy, state }) => {
      if (event.kind !== "ORDERBOOK_METRIC") {
        return undefined;
      }

      options.observeState?.("strategy", state);

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
        metadata: {
          latest_orderbook_received_at: state.latestOrderbook?.receivedAt,
          latest_market_tradable: state.latestMarketStatus?.tradable,
        },
      };
    },
    createCostInput: ({ intent, event, state }): CostModelInput => {
      options.observeState?.("cost", state);

      return {
        exchangeId: intent.exchangeId,
        market: intent.market,
        expectedReturnBps: options.expectedReturnBps ?? "30",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "1",
        expectedSlippageBpsP95: "1",
        cancelRequotePenaltyBps: "0",
        evaluatedAt: event.eventTimestamp,
      };
    },
    createRiskGateContext: ({ intent, event, state }) => {
      options.observeState?.("risk", state);

      return createRiskContext(intent, event.eventTimestamp, options.expectedLossBpsOfEquity ?? "1");
    },
    fillOptions: {
      latencyMs: options.latencyMs ?? 100,
      takerFeeBps: "10",
    },
  };
}

function receivedAtValues(orderbooks: readonly OrderbookEvent[] | undefined): readonly string[] {
  return Array.from(orderbooks ?? [], (orderbook) => String(orderbook.receivedAt));
}

function marketDataReceivedAtValues(
  events: BacktestReplayStateSnapshot["latestMarketDataEvents"] | undefined,
): readonly string[] {
  return Array.from(events ?? [], (event) =>
    "receivedAt" in event ? String(event.receivedAt) : String(event.observedAt),
  );
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

function createRiskContext(
  intent: OrderIntent,
  observedAt: MarketEvent["eventTimestamp"],
  expectedLossBpsOfEquity: string,
): RiskGateContext {
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
    thresholdSnapshot: createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt, "backtest.test"),
    observedAt,
    expectedLossBpsOfEquity,
  };
}

function createBacktestFixture(): unknown {
  return {
    schemaVersion: 1,
    events: [
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
    ],
  };
}

function createLaggedObservationFixture(): unknown {
  return createFixtureWithEvents([
    createPolicyCandidateEvent("1"),
    createOrderbookSnapshotEvent({
      eventTimestamp: "2026-05-20T00:00:00.040Z",
      receivedAt: "2026-05-20T00:00:00.040Z",
      sequence: "2",
      tieBreakKey: "orderbook:before-latency",
      askPrice: "101",
    }),
    createMetricEventFixture({
      eventTimestamp: triggerTimestamp,
      receivedAt: "2026-05-20T00:00:00.200Z",
      sequence: "3",
    }),
    createOrderbookSnapshotEvent({
      eventTimestamp: "2026-05-20T00:00:00.150Z",
      receivedAt: "2026-05-20T00:00:00.150Z",
      sequence: "4",
      tieBreakKey: "orderbook:exchange-time-after-trigger",
      askPrice: "100",
    }),
    createOrderbookSnapshotEvent({
      eventTimestamp: "2026-05-20T00:00:00.300Z",
      receivedAt: "2026-05-20T00:00:00.300Z",
      sequence: "5",
      tieBreakKey: "orderbook:observed-latency",
      askPrice: "101",
    }),
  ]);
}

function createReceivedAtOutOfOrderFixture(): unknown {
  return createFixtureWithEvents([
    createPolicyCandidateEvent("1"),
    createOrderbookSnapshotEvent({
      eventTimestamp: "2026-05-20T00:00:00.010Z",
      receivedAt: "2026-05-20T00:00:00.040Z",
      sequence: "2",
      tieBreakKey: "orderbook:later-received",
      askPrice: "101",
    }),
    createOrderbookSnapshotEvent({
      eventTimestamp: "2026-05-20T00:00:00.020Z",
      receivedAt: "2026-05-20T00:00:00.035Z",
      sequence: "3",
      tieBreakKey: "orderbook:earlier-received",
      askPrice: "100",
    }),
    createMetricEventFixture({
      eventTimestamp: "2026-05-20T00:00:00.030Z",
      receivedAt: "2026-05-20T00:00:00.030Z",
      sequence: "4",
    }),
  ]);
}

function createFixtureWithEvents(events: readonly unknown[]): unknown {
  return {
    schemaVersion: 1,
    events,
  };
}

function createPolicyCandidateEvent(sequence: string): unknown {
  return {
    kind: "POLICY_CANDIDATE",
    exchangeId,
    market,
    eventTimestamp: "2026-05-20T00:00:00.000Z",
    sequence,
    tieBreakKey: "policy:healthy",
    source: source(0),
    tradable: true,
    warning: false,
    caution: false,
    reasonCodes: [],
    minimumOrderNotional: "5000",
    bidFeeBps: "5",
    askFeeBps: "5",
  };
}

function createMetricEventFixture(input: {
  eventTimestamp: string;
  receivedAt: string;
  sequence: string;
}): unknown {
  return {
    kind: "ORDERBOOK_METRIC",
    exchangeId,
    market,
    eventTimestamp: input.eventTimestamp,
    receivedAt: input.receivedAt,
    sequence: input.sequence,
    tieBreakKey: "metric:trigger",
    source: source(2),
    bestBidPrice: "99",
    bestAskPrice: "101",
    spreadBps: "2",
    bidDepth1: "100000000",
    askDepth1: "100000000",
  };
}

function createOrderbookSnapshotEvent(input: {
  eventTimestamp: string;
  receivedAt: string;
  sequence: string;
  tieBreakKey: string;
  askPrice: string;
}): unknown {
  return {
    kind: "ORDERBOOK_SNAPSHOT",
    exchangeId,
    market,
    eventTimestamp: input.eventTimestamp,
    receivedAt: input.receivedAt,
    sequence: input.sequence,
    tieBreakKey: input.tieBreakKey,
    source: source(Number(input.sequence)),
    asks: [
      {
        price: input.askPrice,
        size: "0.5",
      },
    ],
    bids: [
      {
        price: "99",
        size: "1",
      },
    ],
  };
}

function source(sourceIndex: number): {
  sourceKind: "FIXTURE";
  sourceId: string;
  sourceIndex: number;
} {
  return {
    sourceKind: "FIXTURE",
    sourceId: "backtest-orchestrator.test.ts",
    sourceIndex,
  };
}
