import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PaperDecisionRunner,
  StaticPaperDecisionInputSource,
} from "../../src/application/index.js";
import type {
  ExecutionSubmitOrderResult,
  PaperDecisionInputFrame,
  PaperDecisionLedgerWriterPort,
} from "../../src/application/index.js";
import {
  PaperBroker,
} from "../../src/infrastructure/index.js";
import {
  runM9PaperDecisionFixtureSmoke,
} from "../../src/runtime/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import type {
  CostDecision,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
  RiskGateResult,
  Strategy,
} from "../../src/domain/index.js";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "m9", "paper-decision-runner.json");

describe("M9 paper decision runner", () => {
  it("runs controlled fixture through strategy, cost/risk gates, PaperBroker, and metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.framesProcessed).toBe(4);
    expect(result.metrics).toMatchObject({
      strategyEvaluationCount: 4,
      orderCandidateCount: 3,
      orderIntentCount: 3,
      costRejectedCount: 1,
      riskRejectedCount: 1,
      paperOrderSubmittedCount: 1,
      paperFillCount: 1,
      fillRate: 1,
      liveOrderApiCalls: 0,
      holdReasonCounts: {
        fixture_waiting_for_signal: 1,
      },
      blockingReasonCounts: {
        "cost:cost_margin_insufficient": 1,
        "hold:fixture_waiting_for_signal": 1,
        "risk:expected_loss_limit_exceeded": 1,
      },
    });
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 3,
      allowedCount: 2,
      rejectedCount: 1,
      averageCostBps: "13",
      averageRequiredReturnBps: "23",
    });
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 1,
      averageSlippageBps: "0",
      minSlippageBps: "0",
      maxSlippageBps: "0",
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1000000",
      endingCashKrw: "989995",
      positionMarketValueKrw: "9999",
      realizedPnlKrw: "0",
      unrealizedPnlKrw: "-6",
      totalPnlKrw: "-6",
      totalReturnBps: "-0.06",
      totalFeesKrw: "5",
      submittedOrderCount: 1,
      filledOrderCount: 1,
    });
    expect(result.trace.map((record) => record.stage)).toContain("EXECUTION_RESULT");
  });

  it("keeps zero-order runs explainable with hold reason counts", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.frames = [fixture.frames[0]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.paperOrderSubmittedCount).toBe(0);
    expect(result.metrics.paperFillCount).toBe(0);
    expect(result.metrics.fillRate).toBe(0);
    expect(result.metrics.holdReasonCounts).toEqual({
      fixture_waiting_for_signal: 1,
    });
    expect(result.metrics.blockingReasonCounts).toEqual({
      "hold:fixture_waiting_for_signal": 1,
    });
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 0,
      averageCostBps: null,
    });
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 0,
      averageSlippageBps: null,
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1000000",
      endingCashKrw: "1000000",
      positionMarketValueKrw: "0",
      totalPnlKrw: "0",
      totalFeesKrw: "0",
      submittedOrderCount: 0,
      filledOrderCount: 0,
    });
  });

  it("excludes broker-rejected orders from fill and slippage metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.initialBalances = [
      {
        currency: "KRW",
        available: "1",
      },
    ];
    fixture.frames = [fixture.frames[3]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.paperFillCount).toBe(0);
    expect(result.metrics.fillRate).toBe(0);
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 0,
      averageSlippageBps: null,
    });
    expect(result.metrics.discardReasonCounts).toEqual({
      paper_broker_rejected: 1,
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      startingCashKrw: "1",
      endingCashKrw: "1",
      totalPnlKrw: "0",
      submittedOrderCount: 1,
      filledOrderCount: 0,
    });
  });

  it("submits SELL fixture orders only when exit position quantity evidence is present", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.initialBalances = [
      { currency: "KRW", available: "1000000" },
      { currency: "BTC", available: "1" },
    ];
    fixture.frames = [fixture.frames[3]];
    fixture.frames[0].features.side = "SELL";
    fixture.frames[0].features.limit_price = "99990000";
    fixture.frames[0].features.requested_notional = "9999";
    fixture.frames[0].risk.positions = [
      {
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "m9_fixture_boundary_strategy",
        notionalKrw: "99990000",
        notionalBpsOfEquity: "999",
        unrealizedPnlBps: "0",
        capturedAt: fixture.frames[0].observedAt,
        metadata: {
          position_quantity: "1",
        },
      },
    ];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.paperFillCount).toBe(1);
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "EXECUTION_RESULT",
          status: "SUBMITTED",
          metadata: expect.objectContaining({
            intent_side: "SELL",
          }),
        }),
      ]),
    );
  });

  it("uses strategy-specific risk position quantity before aggregate market quantity", async () => {
    const observedAt = "2026-06-06T08:00:00.000Z";
    const strategyId = "strategy.exit-position-scope";
    const intent = createRunnerSellIntent({
      strategyId,
      requestedQuantity: "0.25",
      requestedNotional: "25000000",
      idempotencyKey: "paper-runner-exit-position-scope",
    });
    const frame: PaperDecisionInputFrame = {
      id: "frame-exit-position-scope",
      observedAt,
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      features: {
        position_quantity: "10",
      },
      risk: {
        expectedLossBpsOfEquity: "10",
        thresholdSnapshot: createRiskThresholdSnapshot(
          defaultRiskLimitThresholds,
          observedAt,
          "unit-test.thresholds",
        ),
        positions: [
          {
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            notionalKrw: "1000000000",
            notionalBpsOfEquity: "10000",
            unrealizedPnlBps: "0",
            capturedAt: observedAt,
            metadata: {
              total_quantity: "10",
            },
          },
          {
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            strategyId,
            notionalKrw: "25000000",
            notionalBpsOfEquity: "250",
            unrealizedPnlBps: "0",
            capturedAt: observedAt,
            metadata: {
              total_quantity: "0.25",
            },
          },
        ],
      },
    };
    const capturedSubmissions: OrderSubmission[] = [];
    const submitOrder = vi.fn(async (submission: OrderSubmission): Promise<ExecutionSubmitOrderResult> => {
      capturedSubmissions.push(submission);
      return {
        status: "REJECTED",
        submission,
        rejection: {
          reasonCode: "exit_position_scope_mismatch",
          message: "captured by unit test",
        },
      };
    });
    const runner = new PaperDecisionRunner({
      source: new StaticPaperDecisionInputSource([frame]),
      strategies: [createOrderIntentStrategy(intent)],
      broker: new PaperBroker({
        exchangeId: "upbit_krw_spot",
        initialBalances: [
          {
            currency: "KRW",
            available: "1000000",
          },
        ],
      }),
      costModel: {
        evaluate: () => createAllowedCostDecision(observedAt),
      },
      evaluateRiskGate: createApprovedRiskGateResult,
      executionEngine: { submitOrder },
    });

    await runner.run();

    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(capturedSubmissions[0]?.intent.metadata).toMatchObject({
      position_effect: "EXIT",
      position_scope: {
        strategyId,
        totalQuantity: "0.25",
      },
    });
    expect(capturedSubmissions[0]?.costSnapshot.position_scope).toMatchObject({
      strategy_id: strategyId,
      total_quantity: "0.25",
    });
  });

  it("does not use risk position quantity from a different exchange", async () => {
    const observedAt = "2026-06-06T08:00:00.000Z";
    const strategyId = "strategy.exit-position-scope";
    const intent = createRunnerSellIntent({
      strategyId,
      requestedQuantity: "0.25",
      requestedNotional: "25000000",
      idempotencyKey: "paper-runner-exit-exchange-scope",
    });
    const frame = createExitPositionScopeFrame({
      observedAt,
      strategyId,
      positionExchangeId: "binance_spot",
      positionQuantity: "0.25",
    });
    const capturedSubmissions = await runSingleSellIntentAndCaptureSubmissions(frame, intent, observedAt);

    expect(capturedSubmissions[0]?.intent.metadata).not.toMatchObject({
      position_effect: expect.any(String),
      position_scope: expect.any(Object),
    });
    expect(capturedSubmissions[0]?.costSnapshot).toMatchObject({
      source: "cost_model",
    });
  });

  it("does not use aggregate frame position quantity without strategy-scoped risk evidence", async () => {
    const observedAt = "2026-06-06T08:00:00.000Z";
    const strategyId = "strategy.exit-position-scope";
    const intent = createRunnerSellIntent({
      strategyId,
      requestedQuantity: "0.25",
      requestedNotional: "25000000",
      idempotencyKey: "paper-runner-exit-aggregate-fallback",
    });
    const frame = createExitPositionScopeFrame({
      observedAt,
      strategyId,
      featurePositionQuantity: "10",
      includePosition: false,
    });
    const capturedSubmissions = await runSingleSellIntentAndCaptureSubmissions(frame, intent, observedAt);

    expect(capturedSubmissions[0]?.intent.metadata).not.toMatchObject({
      position_effect: expect.any(String),
      position_scope: expect.any(Object),
    });
    expect(capturedSubmissions[0]?.costSnapshot).toMatchObject({
      source: "cost_model",
    });
  });

  it("uses phase 1.5 approved alt universe evidence for TOP_ALT safety buffer defaults", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const frame = fixture.frames[3];
    fixture.frames = [frame];
    fixture.universe = {
      phase15ApprovedAltMarkets: ["KRW-SOL"],
    };
    frame.market = "KRW-SOL";
    frame.orderbook.market = "KRW-SOL";
    frame.features.expected_return_bps = "35";
    delete frame.features.safety_buffer_bps;
    delete frame.universe;

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.metrics.costRejectedCount).toBe(0);
    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.costSummary).toMatchObject({
      evaluatedCount: 1,
      allowedCount: 1,
      averageRequiredReturnBps: "33",
    });
  });

  it("deduplicates repeated broker order ids in submission and fill metrics", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.frames = [fixture.frames[3], fixture.frames[3]];

    const result = await runM9PaperDecisionFixtureSmoke({ fixture });

    expect(result.framesProcessed).toBe(2);
    expect(result.metrics.orderIntentCount).toBe(2);
    expect(result.metrics.paperOrderSubmittedCount).toBe(1);
    expect(result.metrics.paperFillCount).toBe(1);
    expect(result.metrics.fillRate).toBe(1);
    expect(result.metrics.slippageSummary).toMatchObject({
      observedFillCount: 1,
      averageSlippageBps: "0",
    });
    expect(result.metrics.pnlSummary).toMatchObject({
      submittedOrderCount: 1,
      filledOrderCount: 1,
      totalFeesKrw: "5",
    });
  });

  it("does not yield frames when static source replay limit is zero", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const source = new StaticPaperDecisionInputSource([fixture.frames[0]]);
    const frames = [];

    for await (const frame of source.replay({ limit: 0 })) {
      frames.push(frame);
    }

    expect(frames).toEqual([]);
  });

  it("does not consume a replay frame beyond maxFrames", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    let pulledFrameCount = 0;
    let observedLimit: number | undefined;
    const source = {
      async *replay(request: { limit?: number } = {}) {
        observedLimit = request.limit;
        for (const frame of fixture.frames.slice(0, 2)) {
          pulledFrameCount += 1;
          yield frame;
        }
      },
    };
    const broker = new PaperBroker({
      exchangeId: "upbit_krw_spot",
      initialBalances: fixture.initialBalances,
    });
    const runner = new PaperDecisionRunner({
      source,
      strategies: [],
      broker,
    });

    const result = await runner.run({ maxFrames: 1 });

    expect(result.framesProcessed).toBe(1);
    expect(pulledFrameCount).toBe(1);
    expect(observedLimit).toBe(1);
  });

  it("ledger writer가 주입되면 durable frame id로 evidence를 append한다", async () => {
    const frame = createLedgerWriterTestFrame("ledger-frame-001", "run-ledger-writer-001");
    const appendFrameWithEvidence = vi.fn<PaperDecisionLedgerWriterPort["appendFrameWithEvidence"]>(
      async () => ({
        frame: { inserted: true, durableFrameId: "db-frame-001" },
        evidence: { inserted: 1, skipped: 0 },
      }),
    );
    const runner = createLedgerWriterTestRunner(frame, {
      appendFrameWithEvidence,
    });

    const result = await runner.run({ sourceRequest: { sourceId: "run-ledger-writer-001" } });

    expect(result.ledgerWriteStatus).toBe("RECORDED");
    expect(appendFrameWithEvidence).toHaveBeenCalledTimes(2);
    expect(appendFrameWithEvidence.mock.calls[0]![1]).toHaveLength(1);
    expect(appendFrameWithEvidence.mock.calls[1]![1]).toHaveLength(0);
  });

  it("duplicate frame이어도 기존 durable id로 evidence append를 재시도한다", async () => {
    const frame = createLedgerWriterTestFrame("ledger-frame-duplicate", "run-ledger-writer-duplicate");
    const appendFrameWithEvidence = vi.fn<PaperDecisionLedgerWriterPort["appendFrameWithEvidence"]>(
      async () => ({
        frame: { inserted: false, durableFrameId: "db-frame-existing" },
        evidence: { inserted: 0, skipped: 1 },
      }),
    );
    const runner = createLedgerWriterTestRunner(frame, {
      appendFrameWithEvidence,
    });

    const result = await runner.run({ sourceRequest: { sourceId: "run-ledger-writer-duplicate" } });

    expect(result.ledgerWriteStatus).toBe("RECORDED");
    expect(appendFrameWithEvidence).toHaveBeenCalledTimes(2);
    expect(appendFrameWithEvidence.mock.results[0]!.type).toBe("return");
  });

  it("ledger writer 실패는 broker 재시도 없이 UNAVAILABLE로 격리한다", async () => {
    const frame = createLedgerWriterTestFrame("ledger-frame-failure", "run-ledger-writer-failure");
    const appendFrameWithEvidence = vi.fn<PaperDecisionLedgerWriterPort["appendFrameWithEvidence"]>(async () => {
      throw new Error("ledger unavailable");
    });
    const runner = createLedgerWriterTestRunner(frame, {
      appendFrameWithEvidence,
    });

    const result = await runner.run({ sourceRequest: { sourceId: "run-ledger-writer-failure" } });

    expect(result.framesProcessed).toBe(1);
    expect(result.ledgerWriteStatus).toBe("UNAVAILABLE");
    expect(appendFrameWithEvidence).toHaveBeenCalledTimes(1);
  });

  it("sourceId가 없으면 같은 input frame에 대해 결정론적 ledger dedupe key를 사용한다", async () => {
    const frame = createLedgerWriterTestFrame("ledger-frame-deterministic");
    const firstAppendFrameWithEvidence = vi.fn<PaperDecisionLedgerWriterPort["appendFrameWithEvidence"]>(
      async () => ({
        frame: { inserted: true, durableFrameId: "db-frame-first" },
        evidence: { inserted: 1, skipped: 0 },
      }),
    );
    const secondAppendFrameWithEvidence = vi.fn<PaperDecisionLedgerWriterPort["appendFrameWithEvidence"]>(
      async () => ({
        frame: { inserted: true, durableFrameId: "db-frame-second" },
        evidence: { inserted: 1, skipped: 0 },
      }),
    );

    await createLedgerWriterTestRunner(frame, {
      appendFrameWithEvidence: firstAppendFrameWithEvidence,
    }).run();
    await createLedgerWriterTestRunner(frame, {
      appendFrameWithEvidence: secondAppendFrameWithEvidence,
    }).run();

    const firstDedupeKey = firstAppendFrameWithEvidence.mock.calls[0]![0].dedupeKey;
    const secondDedupeKey = secondAppendFrameWithEvidence.mock.calls[0]![0].dedupeKey;
    expect(firstDedupeKey).toBe(secondDedupeKey);
    expect(firstDedupeKey).toContain("UPBIT:paper-runner:");
    expect(firstDedupeKey).toContain("frame:ledger-frame-deterministic:strategy:strategy.hold-ledger");
  });
});

function createLedgerWriterTestRunner(
  frame: PaperDecisionInputFrame,
  decisionLedgerWriter: PaperDecisionLedgerWriterPort,
): PaperDecisionRunner {
  const source = new StaticPaperDecisionInputSource([frame]);
  const broker = new PaperBroker({
    exchangeId: "upbit_krw_spot",
    initialBalances: [
      {
        currency: "KRW",
        available: "1000000",
      },
    ],
  });

  return new PaperDecisionRunner({
    source,
    strategies: [createHoldStrategy()],
    broker,
    decisionLedgerWriter,
  });
}

function createLedgerWriterTestFrame(id: string, sourceId?: string): PaperDecisionInputFrame {
  const frame: PaperDecisionInputFrame = {
    id,
    observedAt: "2026-06-06T08:00:00.000Z",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    features: {},
  };
  if (sourceId !== undefined) {
    frame.metadata = { source_id: sourceId };
  }
  return frame;
}

function createHoldStrategy(): Strategy {
  return {
    id: "strategy.hold-ledger",
    version: "test",
    requiredFeatures: [],
    evaluate() {
      return {
        kind: "HOLD",
        strategyId: "strategy.hold-ledger",
        reason: "ledger_hold_reason",
      };
    },
  };
}

function createOrderIntentStrategy(intent: OrderIntent): Strategy {
  return {
    id: intent.strategyId,
    version: "test",
    requiredFeatures: [],
    evaluate() {
      return {
        kind: "ORDER_INTENT",
        strategyId: intent.strategyId,
        reason: "unit_test_exit_position_scope",
        orderIntents: [intent],
      };
    },
  };
}

function createExitPositionScopeFrame(input: {
  observedAt: string;
  strategyId: string;
  positionExchangeId?: string;
  positionQuantity?: string;
  featurePositionQuantity?: string;
  includePosition?: boolean;
}): PaperDecisionInputFrame {
  const features: Record<string, unknown> = {};
  if (input.featurePositionQuantity !== undefined) {
    features.position_quantity = input.featurePositionQuantity;
  }

  const frame: PaperDecisionInputFrame = {
    id: `frame-${input.strategyId}`,
    observedAt: input.observedAt,
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    features,
    risk: {
      expectedLossBpsOfEquity: "10",
      thresholdSnapshot: createRiskThresholdSnapshot(
        defaultRiskLimitThresholds,
        input.observedAt,
        "unit-test.thresholds",
      ),
    },
  };

  if (input.includePosition !== false) {
    frame.risk = {
      ...frame.risk,
      positions: [
        {
          exchangeId: input.positionExchangeId ?? "upbit_krw_spot",
          market: "KRW-BTC",
          strategyId: input.strategyId,
          notionalKrw: "25000000",
          notionalBpsOfEquity: "250",
          unrealizedPnlBps: "0",
          capturedAt: input.observedAt,
          metadata: {
            total_quantity: input.positionQuantity ?? "0.25",
          },
        },
      ],
    };
  }

  return frame;
}

async function runSingleSellIntentAndCaptureSubmissions(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  observedAt: string,
): Promise<OrderSubmission[]> {
  const capturedSubmissions: OrderSubmission[] = [];
  const submitOrder = vi.fn(async (submission: OrderSubmission): Promise<ExecutionSubmitOrderResult> => {
    capturedSubmissions.push(submission);
    return {
      status: "REJECTED",
      submission,
      rejection: {
        reasonCode: "exit_position_scope_mismatch",
        message: "captured by unit test",
      },
    };
  });
  const runner = new PaperDecisionRunner({
    source: new StaticPaperDecisionInputSource([frame]),
    strategies: [createOrderIntentStrategy(intent)],
    broker: new PaperBroker({
      exchangeId: "upbit_krw_spot",
      initialBalances: [
        {
          currency: "KRW",
          available: "1000000",
        },
      ],
    }),
    costModel: {
      evaluate: () => createAllowedCostDecision(observedAt),
    },
    evaluateRiskGate: createApprovedRiskGateResult,
    executionEngine: { submitOrder },
  });

  await runner.run();
  return capturedSubmissions;
}

function createRunnerSellIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "strategy.exit-position-scope",
    side: "SELL",
    orderType: "LIMIT",
    requestedPrice: "100000000",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    idempotencyKey: "paper-runner-exit-position-scope",
    reason: "unit-test-exit-position-scope",
    ...overrides,
  };
}

function createAllowedCostDecision(observedAt: string): CostDecision {
  return {
    kind: "ALLOW",
    tradeAllowed: true,
    reasonCode: "cost_margin_ok",
    message: "unit test cost allowed",
    snapshot: {
      exchange_id: "upbit_krw_spot",
      market: "KRW-BTC",
      expected_return_bps: "30",
      entry_fee_bps: "5",
      exit_fee_bps: "5",
      expected_slippage_bps_p95: "2",
      cost_bps: "7",
      trade_allowed: true,
      reason_code: "cost_margin_ok",
      evaluated_at: observedAt,
    },
  };
}

function createApprovedRiskGateResult(context: RiskGateContext): RiskGateResult {
  return {
    status: "PASS",
    approved: true,
    action: "ALLOW",
    evaluations: [],
    failedEvaluations: [],
    warningEvaluations: [],
    thresholdSnapshot: context.thresholdSnapshot,
  };
}
