import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  OrderSubmission,
  Phase15AltApprovalEvidenceCondition,
  Phase15AltApprovalEvidenceSnapshot,
} from "../../src/domain/index.js";
import type { BrokerPort, HardStopRuntimeActionPlan } from "../../src/application/index.js";
import {
  DisabledUpbitLiveBroker,
  UpbitLiveBrokerDisabledError,
  createDisabledUpbitLiveBroker,
} from "../../src/infrastructure/index.js";
import {
  PAPER_NO_KEY_EXECUTION_WORKER_ID,
  UnsafeHardStopCancelPlanError,
  UnsafePaperNoKeyExecutionRuntimeError,
  createPaperNoKeyExecutionRuntime,
  executeHardStopPendingPaperOrderCancels,
  listPendingPaperOrdersForHardStop,
  loadDefaultRuntimeConfig,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";

const observedAt = "2026-05-20T01:00:00.000Z";

describe("PAPER_NO_KEY execution runtime", () => {
  it("assembles ExecutionEngine with PaperBroker and a disabled live broker", async () => {
    const config = await loadDefaultRuntimeConfig();
    const runtime = createPaperNoKeyExecutionRuntime(config, {
      initialBalances: [
        {
          currency: "KRW",
          available: "1000000",
        },
      ],
      brokerOrderIdPrefix: "runtime-test-order",
      clock: () => observedAt,
    });

    expect(PAPER_NO_KEY_EXECUTION_WORKER_ID).toBe("paper-no-key-execution-worker");
    expect(runtime.exchangeId).toBe("upbit_krw_spot");
    expect(runtime.markets).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(runtime.executionSafetyConfig).toEqual({
      liveTradingEnabled: false,
      marketOrderEnabled: false,
      entryMarketOrderEnabled: false,
      paperNoKey: true,
    });
    expect(runtime.disabledLiveBroker).toBeInstanceOf(DisabledUpbitLiveBroker);
    await expect(runtime.broker.getBalances()).resolves.toMatchObject({
      exchangeId: "upbit_krw_spot",
      balances: [
        {
          currency: "KRW",
          available: "1000000",
        },
      ],
    });
  });

  it("exposes resolved phase 1.5 approved markets to execution runtime callers", () => {
    const runtime = createPaperNoKeyExecutionRuntime(
      loadRuntimeConfig({
        universe: {
          phase_1_5: {
            enabled: true,
            manual_approvals: [
              {
                market: "KRW-SOL",
                approved_at: "2026-05-31T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      {
        clock: () => "2026-06-01T00:00:00.000Z",
        phase15ApprovalEvidence: [
          createPhase15ApprovalEvidence("KRW-SOL", "APPROVE", "2026-05-31T00:00:00.000Z"),
        ],
      },
    );

    expect(runtime.markets).toEqual(["KRW-BTC", "KRW-ETH", "KRW-SOL"]);
    expect(runtime.universe.phase15ApprovedAltMarkets).toEqual(["KRW-SOL"]);
  });

  it("rejects API keys in the PAPER_NO_KEY execution runtime", () => {
    expect(() =>
      createPaperNoKeyExecutionRuntime({
        secrets: {
          upbit_access_key: "fixture-access-key",
        },
      }),
    ).toThrow(UnsafePaperNoKeyExecutionRuntimeError);
  });

  it("keeps execution runtime assembly free of Upbit private order clients", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "runtime", "execution-runtime.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/UpbitPublicRestClient|orders\/chance|\/v1\/orders|Authorization|Bearer/iu);
  });
});

function createPhase15ApprovalEvidence(
  market: string,
  action: "APPROVE" | "REJECT" | "REVOKE" | "EXPIRE",
  observedAt: string,
): Phase15AltApprovalEvidenceSnapshot {
  return {
    exchangeId: "upbit_krw_spot",
    market,
    action,
    observedAt,
    thresholds: {
      minListingAgeDays: 90,
      minThirtyDayAverageTradeValueKrw: "10000000000",
      maxSevenDaySpreadP95Bps: "15",
      maxExpectedSlippageBps: "20",
      minDepthKrw: "100000000",
    },
    conditions: action === "APPROVE" ? createPassingPhase15Conditions() : [],
  };
}

function createPassingPhase15Conditions(): readonly Phase15AltApprovalEvidenceCondition[] {
  return [
    { key: "listing_age", passed: true, reasonCode: "phase_1_5_listing_age_sufficient" },
    { key: "market_warning", passed: true, reasonCode: "phase_1_5_market_warning_absent" },
    { key: "market_caution", passed: true, reasonCode: "phase_1_5_market_caution_absent" },
    {
      key: "thirty_day_average_trade_value",
      passed: true,
      reasonCode: "phase_1_5_30d_trade_value_sufficient",
    },
    { key: "seven_day_spread_p95", passed: true, reasonCode: "phase_1_5_spread_p95_within_limit" },
    { key: "expected_slippage", passed: true, reasonCode: "phase_1_5_expected_slippage_within_limit" },
    { key: "depth", passed: true, reasonCode: "phase_1_5_depth_sufficient" },
  ];
}

describe("hard stop pending paper order cancel execution", () => {
  it("executes planned paper order cancels without auto-liquidating open positions", async () => {
    const broker = createBrokerPort();
    const plan = createHardStopPlan();

    const summary = await executeHardStopPendingPaperOrderCancels({
      broker,
      plan,
    });

    expect(broker.cancelOrder).toHaveBeenCalledTimes(2);
    expect(broker.cancelOrder).toHaveBeenNthCalledWith(1, "paper-open-1");
    expect(broker.cancelOrder).toHaveBeenNthCalledWith(2, "paper-partial-1");
    expect(broker.submitOrder).not.toHaveBeenCalled();
    expect(broker.getBalances).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      state: "HARD_STOP",
      cancelPendingPaperOrders: true,
      openPositionLiquidationAttempted: false,
      attemptedCancelCount: 2,
      canceledCount: 2,
      failedCount: 0,
    });
    expect(summary.results.map((result) => result.status)).toEqual(["CANCELED", "CANCELED"]);
  });

  it("fails closed before broker side effects when a hard stop plan asks for auto-liquidation", async () => {
    const broker = createBrokerPort();
    const unsafePlan = {
      ...createHardStopPlan(),
      actionPlan: {
        ...createHardStopPlan().actionPlan,
        autoLiquidateOpenPositions: true,
      },
    } as unknown as HardStopRuntimeActionPlan;

    await expect(
      executeHardStopPendingPaperOrderCancels({
        broker,
        plan: unsafePlan,
      }),
    ).rejects.toBeInstanceOf(UnsafeHardStopCancelPlanError);
    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(broker.submitOrder).not.toHaveBeenCalled();
  });

  it("turns malformed replayed hard stop action plans into domain errors before broker side effects", async () => {
    const broker = createBrokerPort();
    const malformedPlanCases = [
      {
        plan: {
          ...createHardStopPlan(),
          actionPlan: undefined,
        } as unknown as HardStopRuntimeActionPlan,
        expectedViolation: "hard stop cancel execution requires actionPlan object",
      },
      {
        plan: {
          ...createHardStopPlan(),
          actionPlan: {
            cancelPendingPaperOrders: "true",
            autoLiquidateOpenPositions: false,
          },
        } as unknown as HardStopRuntimeActionPlan,
        expectedViolation: "hard stop cancel execution requires cancelPendingPaperOrders=true",
      },
    ];

    for (const { plan, expectedViolation } of malformedPlanCases) {
      await expect(
        executeHardStopPendingPaperOrderCancels({
          broker,
          plan,
        }),
      ).rejects.toMatchObject({
        name: "UnsafeHardStopCancelPlanError",
        violations: expect.arrayContaining([expectedViolation]),
      });
    }

    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(broker.submitOrder).not.toHaveBeenCalled();
    expect(broker.getBalances).not.toHaveBeenCalled();
  });

  it("validates pending cancel action arrays before broker side effects", async () => {
    const broker = createBrokerPort();
    const [validAction] = createHardStopPlan().pendingPaperOrderCancelActions;
    const malformedPlanCases = [
      {
        plan: {
          ...createHardStopPlan(),
          pendingPaperOrderCancelActions: undefined,
        } as unknown as HardStopRuntimeActionPlan,
        expectedViolation: "hard stop cancel execution requires pendingPaperOrderCancelActions array",
      },
      {
        plan: {
          ...createHardStopPlan(),
          pendingPaperOrderCancelActions: [{}],
        } as unknown as HardStopRuntimeActionPlan,
        expectedViolation: "hard stop cancel action[0] requires brokerOrderId string",
      },
      {
        plan: {
          ...createHardStopPlan(),
          pendingPaperOrderCancelActions: [
            {
              ...validAction,
              status: "FILLED",
            },
          ],
        } as unknown as HardStopRuntimeActionPlan,
        expectedViolation: "hard stop cancel action[0] requires pending order status",
      },
    ];

    for (const { plan, expectedViolation } of malformedPlanCases) {
      await expect(
        executeHardStopPendingPaperOrderCancels({
          broker,
          plan,
        }),
      ).rejects.toMatchObject({
        name: "UnsafeHardStopCancelPlanError",
        violations: expect.arrayContaining([expectedViolation]),
      });
    }

    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(broker.submitOrder).not.toHaveBeenCalled();
    expect(broker.getBalances).not.toHaveBeenCalled();
  });

  it("collects only currently open broker orders as hard stop cancel candidates", async () => {
    const broker = createBrokerPort({
      openOrders: [
        createBrokerOrder({
          brokerOrderId: "paper-open-1",
          status: "ACCEPTED",
        }),
        createBrokerOrder({
          brokerOrderId: "paper-filled-1",
          status: "FILLED",
          remainingQuantity: "0",
        }),
      ],
    });

    await expect(listPendingPaperOrdersForHardStop(broker)).resolves.toEqual([
      expect.objectContaining({
        brokerOrderId: "paper-open-1",
      }),
    ]);
  });
});

describe("disabled Upbit live broker", () => {
  it("rejects every private broker method before any live API can be called", async () => {
    const broker = createDisabledUpbitLiveBroker({
      reason: "unit-test-paper-mode",
    });

    await expect(broker.submitOrder(createSubmission())).rejects.toBeInstanceOf(UpbitLiveBrokerDisabledError);
    await expect(broker.cancelOrder("live-order-1")).rejects.toBeInstanceOf(UpbitLiveBrokerDisabledError);
    await expect(broker.getOrder("live-order-1")).rejects.toBeInstanceOf(UpbitLiveBrokerDisabledError);
    await expect(broker.listOpenOrders()).rejects.toBeInstanceOf(UpbitLiveBrokerDisabledError);
    await expect(broker.getBalances()).rejects.toBeInstanceOf(UpbitLiveBrokerDisabledError);
  });
});

function createBrokerPort(options: { openOrders?: readonly BrokerOrder[] } = {}) {
  const openOrders = options.openOrders ?? [];
  const cancelOrder = vi.fn(async (orderId: string): Promise<BrokerOrder> =>
    createBrokerOrder({
      brokerOrderId: orderId,
      status: "CANCELED",
      remainingQuantity: "0",
    }),
  );
  const submitOrder = vi.fn(async (_submission: OrderSubmission): Promise<BrokerOrder> => createBrokerOrder());
  const getBalances = vi.fn(async (): Promise<BrokerBalanceSnapshot> => ({
    exchangeId: "upbit_krw_spot",
    balances: [],
    capturedAt: observedAt,
  }));

  return {
    submitOrder,
    cancelOrder,
    getOrder: vi.fn(async () => undefined),
    listOpenOrders: vi.fn(async () => openOrders),
    getBalances,
  };
}

function createHardStopPlan(): HardStopRuntimeActionPlan {
  return {
    state: "HARD_STOP",
    actionPlan: {
      newOrdersBlocked: true,
      strategyEvaluationBlocked: true,
      cancelPendingPaperOrders: true,
      autoLiquidateOpenPositions: false,
      requiresManualReview: true,
    },
    pendingPaperOrderCancelActions: [
      {
        action: "PLAN_CANCEL_PENDING_PAPER_ORDER",
        brokerOrderId: "paper-open-1",
        idempotencyKey: "execution-candidate-1",
        market: "KRW-BTC",
        status: "ACCEPTED",
      },
      {
        action: "PLAN_CANCEL_PENDING_PAPER_ORDER",
        brokerOrderId: "paper-partial-1",
        idempotencyKey: "execution-candidate-2",
        market: "KRW-BTC",
        status: "PARTIALLY_FILLED",
      },
    ],
  };
}

function createBrokerOrder(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    brokerOrderId: "paper-open-1",
    idempotencyKey: "execution-candidate-1",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "ACCEPTED",
    requestedQuantity: "0.002",
    remainingQuantity: "0.001",
    requestedPrice: "10000000",
    acceptedAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function createSubmission(): OrderSubmission {
  return {
    intent: {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: "10000000",
      requestedQuantity: "0.001",
      requestedNotional: "10000",
      idempotencyKey: "execution-candidate-1",
      reason: "disabled-live-broker-test",
    },
    costSnapshot: {},
    riskApproval: {},
    submittedAt: observedAt,
  };
}
