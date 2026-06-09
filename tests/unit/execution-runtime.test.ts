import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  ExitDecision,
  ExitPolicySnapshot,
  ExitPositionScope,
  ExitRuleEvaluation,
  ExitSizing,
  OrderSubmission,
  Phase15AltApprovalEvidenceCondition,
  Phase15AltApprovalEvidenceSnapshot,
  RiskGateContext,
} from "../../src/domain/index.js";
import {
  createExecutionRiskApprovalEvidence,
  createExitSubmission,
  evaluateRiskGate,
} from "../../src/application/index.js";
import type { BrokerPort, HardStopRuntimeActionPlan } from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import {
  DisabledUpbitLiveBroker,
  UpbitLiveBrokerDisabledError,
  UpbitPrivateRestClientError,
  createDisabledUpbitLiveBroker,
} from "../../src/infrastructure/index.js";
import type {
  UpbitLiveBrokerPrivateClient,
  UpbitRateLimitStatus,
} from "../../src/infrastructure/index.js";
import {
  PAPER_NO_KEY_EXECUTION_WORKER_ID,
  UnsafeHardStopCancelPlanError,
  UnsafePaperNoKeyExecutionRuntimeError,
  UnsafeUpbitLiveBrokerRuntimeError,
  createGuardedUpbitLiveBrokerRuntime,
  createPaperNoKeyExecutionRuntime,
  createUpbitLiveBrokerRuntimeSafeSummary,
  executeHardStopPendingPaperOrderCancels,
  listPendingPaperOrdersForHardStop,
  loadDefaultRuntimeConfig,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";
import type { EnabledPilotRuntimeConfig } from "../../src/runtime/index.js";

const observedAt = "2026-05-20T01:00:00.000Z";
const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt);
const defaultUpbitRateLimitStatus = {
  kind: "OK",
  remainingReq: {
    group: "default",
    sec: 30,
    exhausted: false,
  },
} satisfies UpbitRateLimitStatus;

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

  it("wires exit runtime to PaperBroker, execution persistence, and evidence writer ports", async () => {
    const config = await loadDefaultRuntimeConfig();
    const appendExitEvidence = vi.fn(async () => undefined);
    const persistPaperExecution = vi.fn(async () => undefined);
    const decision = createExitDecisionFixture();
    const sizing = createExitSizingFixture();
    const positionScope = createExitPositionScopeFixture();
    const policySnapshot = createExitPolicySnapshotFixture();
    const seedSubmission = createExitSubmission({
      decision,
      sizing,
      positionScope,
      policySnapshot,
      currentPrice: "10000000",
      riskApproval: {},
      idempotencyKey: "exit-runtime-001",
      expectedLossBpsOfEquity: "10",
      submittedAt: observedAt,
    });
    expect(seedSubmission).not.toBeNull();
    const riskContext = createExitRiskContext(seedSubmission!.exitOrderIntent, "10");
    const runtime = createPaperNoKeyExecutionRuntime(config, {
      initialBalances: [
        {
          currency: "BTC",
          available: "0.005",
        },
      ],
      brokerOrderIdPrefix: "exit-runtime-order",
      clock: () => observedAt,
      exitExecutionPersistence: { persistPaperExecution },
      exitEvidenceWriter: { appendExitEvidence },
    });

    const result = await runtime.runExit({
      decision,
      sizing,
      positionScope,
      policySnapshot,
      currentPrice: "10000000",
      riskApproval: createExecutionRiskApprovalEvidence(evaluateRiskGate(riskContext), riskContext),
      idempotencyKey: "exit-runtime-001",
      expectedLossBpsOfEquity: "10",
      submittedAt: observedAt,
    });

    expect(result.status).toBe("REMAINING_CANCEL_REQUOTE_CREATED");
    expect(result.executionPersistenceStatus).toBe("RECORDED");
    expect(persistPaperExecution).toHaveBeenCalledWith({
      submission: result.submission,
      brokerOrder: expect.objectContaining({
        status: "CANCELED",
        remainingQuantity: "0",
      }),
      correlationId: expect.stringMatching(/^exit-runtime-order-/u),
    });
    expect(appendExitEvidence).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ evidenceKind: "STRATEGY_DECISION" }),
        expect.objectContaining({ evidenceKind: "EXECUTION_RESULT" }),
        expect.objectContaining({ evidenceKind: "PNL_STATUS_CONTEXT" }),
      ]),
    );
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
    expect(source).not.toMatch(/createGuardedUpbitLiveBrokerRuntime|UpbitPrivateRestClient|createUpbitLiveBroker/iu);
  });
});

describe("guarded Upbit live broker runtime factory", () => {
  it("rejects disabled or incomplete guards before creating a private client", () => {
    const privateClientFactory = vi.fn(() => createFakeUpbitLiveBrokerPrivateClient());

    expect(() =>
      createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: false,
        pilotConfig: {
          enabled: false,
          privateSmokeEnabled: false,
          orderSmokeEnabled: false,
        },
        privateClientFactory,
      }),
    ).toThrow(UnsafeUpbitLiveBrokerRuntimeError);
    expect(() =>
      createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: true,
        pilotConfig: {
          ...createEnabledOrderSmokePilotConfig(),
          orderSmokeEnabled: false,
        },
        privateClientFactory,
      }),
    ).toThrow(UnsafeUpbitLiveBrokerRuntimeError);
    expect(() =>
      createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: true,
        pilotConfig: createEnabledOrderSmokePilotConfig({
          keyScopes: ["자산조회", "주문조회", "주문하기", "출금하기"] as unknown as EnabledPilotRuntimeConfig["keyScopes"],
        }),
        privateClientFactory,
      }),
    ).toThrow(UnsafeUpbitLiveBrokerRuntimeError);
    expect(() =>
      createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: true,
        pilotConfig: createEnabledOrderSmokePilotConfig(),
        privateClientFactory,
        exchangeId: "paper" as never,
      }),
    ).toThrow(UnsafeUpbitLiveBrokerRuntimeError);
    expect(() =>
      createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: true,
        pilotConfig: {
          ...createEnabledOrderSmokePilotConfig(),
          orderSmokeMarket: undefined,
          orderSmokeMaxKrw: undefined,
        } as unknown as EnabledPilotRuntimeConfig,
        privateClientFactory,
      }),
    ).toThrow(UnsafeUpbitLiveBrokerRuntimeError);
    expect(privateClientFactory).not.toHaveBeenCalled();
  });

  it("creates a live broker only with explicit order-smoke guard and secret-safe summary", async () => {
    const privateClient = createFakeUpbitLiveBrokerPrivateClient();
    const privateClientFactory = vi.fn((credentials) => {
      expect(credentials).toEqual({
        accessKey: "fixture-upbit-access-key",
        secretKey: "fixture-upbit-secret-key",
      });

      return privateClient;
    });

    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory,
      clock: () => observedAt,
    });

    expect(privateClientFactory).toHaveBeenCalledTimes(1);
    expect(runtime.summary).toMatchObject({
      enabled: true,
      profile: "PILOT_ORDER_SMOKE",
      privateSmokeEnabled: true,
      orderSmokeEnabled: true,
      credentialsConfigured: true,
      keyScopeEvidenceId: "evidence-live-broker-001",
      orderSmokeMarket: "KRW-BTC",
      orderSmokeMaxKrw: "5000",
      statusLabel: "live broker 조립 가능",
    });
    expect(JSON.stringify(runtime.summary)).not.toContain("fixture-upbit-access-key");
    expect(JSON.stringify(runtime.summary)).not.toContain("fixture-upbit-secret-key");
    await expect(runtime.broker.getBalances()).resolves.toMatchObject({
      exchangeId: "upbit_krw_spot",
      balances: [
        {
          currency: "KRW",
          available: "10000",
        },
      ],
    });
    expect(privateClient.getAccounts).toHaveBeenCalledTimes(1);
  });

  it("blocks submitOrder outside the explicit order-smoke invariant", async () => {
    const privateClient = createFakeUpbitLiveBrokerPrivateClient();
    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory: vi.fn(() => privateClient),
      clock: () => observedAt,
    });

    await expect(runtime.broker.submitOrder(createSubmission({ market: "KRW-ETH" }))).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke market은 KRW-BTC만 허용합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(runtime.broker.submitOrder(createSubmission({ exchangeId: "paper" }))).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke exchangeId는 upbit_krw_spot만 허용합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(runtime.broker.submitOrder(createSubmission({ side: "SELL" }))).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke는 지정가 매수만 허용합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(runtime.broker.submitOrder(createSubmission({ timeInForce: "IOC" }))).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke는 post-only 지정가만 허용합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(runtime.broker.submitOrder(createSubmission({ idempotencyKey: "x".repeat(33) }))).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke identifier는 1자 이상 32자 이하여야 합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(
      runtime.broker.submitOrder(
        createSubmission({
          requestedPrice: "4000000",
          requestedQuantity: "0.001",
          requestedNotional: "4000",
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke 주문 금액은 5000 KRW 이상이어야 합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    await expect(
      runtime.broker.submitOrder(
        createSubmission({
          requestedPrice: "6000000",
          requestedQuantity: "0.001",
          requestedNotional: "6000",
        }),
      ),
    ).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: expect.arrayContaining(["Upbit live broker order smoke 주문 금액은 5000 KRW 이하여야 합니다"]),
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    expect(privateClient.createLimitOrder).not.toHaveBeenCalled();
  });

  it("cancels only orders submitted by the same guarded smoke runtime", async () => {
    const privateClient = createFakeUpbitLiveBrokerPrivateClient();
    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory: vi.fn(() => privateClient),
      clock: () => observedAt,
    });

    await expect(runtime.broker.cancelOrder("other-live-order")).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: ["Upbit live broker order smoke는 같은 runtime이 생성한 주문만 취소할 수 있습니다"],
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);

    const submittedOrder = await runtime.broker.submitOrder(createSubmission());
    await expect(runtime.broker.cancelOrder(submittedOrder.brokerOrderId)).resolves.toMatchObject({
      brokerOrderId: "upbit-order-001",
    });
    expect(privateClient.createLimitOrder).toHaveBeenCalledTimes(1);
    expect(privateClient.cancelOrder).toHaveBeenCalledWith({ uuid: "upbit-order-001" });
  });

  it("does not treat duplicate-identifier recovery as same-run cancel evidence", async () => {
    const privateClient = createFakeUpbitLiveBrokerPrivateClient();
    vi.mocked(privateClient.createLimitOrder).mockRejectedValueOnce(createDuplicateIdentifierError());
    vi.mocked(privateClient.getOrder).mockResolvedValueOnce({
      payload: createUpbitLookupOrderPayload(),
      rateLimitStatus: defaultUpbitRateLimitStatus,
    });
    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory: vi.fn(() => privateClient),
      clock: () => observedAt,
    });

    const recoveredOrder = await runtime.broker.submitOrder(createSubmission());
    expect(recoveredOrder).toMatchObject({
      brokerOrderId: "upbit-order-001",
      metadata: {
        upbitLiveBrokerRecovery: "duplicate_identifier_lookup",
      },
    });
    await expect(runtime.broker.cancelOrder(recoveredOrder.brokerOrderId)).rejects.toMatchObject({
      name: "UnsafeUpbitLiveBrokerRuntimeError",
      violations: ["Upbit live broker order smoke는 같은 runtime이 생성한 주문만 취소할 수 있습니다"],
    } satisfies Partial<UnsafeUpbitLiveBrokerRuntimeError>);
    expect(privateClient.cancelOrder).not.toHaveBeenCalled();
  });

  it("summarizes blocked live broker guards without leaking credentials", () => {
    const summary = createUpbitLiveBrokerRuntimeSafeSummary({
      liveBrokerEnabled: false,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
    });

    expect(summary).toMatchObject({
      enabled: false,
      credentialsConfigured: true,
      statusLabel: "live broker guard 미충족",
      trace: {
        reason: "guard_blocked",
        violations: ["Upbit live broker runtime에는 liveBrokerEnabled=true guard가 필요합니다"],
      },
    });
    expect(JSON.stringify(summary)).not.toContain("fixture-upbit-access-key");
    expect(JSON.stringify(summary)).not.toContain("fixture-upbit-secret-key");
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

function createExitDecisionFixture(): ExitDecision {
  const triggeredRule: ExitRuleEvaluation = {
    ruleId: "risk_reduction_exit",
    status: "TRIGGERED",
    exitIntention: "REDUCE",
    reasonCode: "daily_loss_limit_approaching",
    message: "일간 손실 한도 접근, 포지션 축소",
  };

  return {
    kind: "REDUCE",
    ruleEvaluations: [triggeredRule],
    triggeredRules: [triggeredRule],
    blockedRules: [],
    reasonCode: "daily_loss_limit_approaching",
    userMessage: "일간 손실 한도에 접근하여 포지션을 일부 축소합니다.",
    observedAt,
  };
}

function createExitSizingFixture(): ExitSizing {
  return {
    requestedQuantity: "0.001",
    requestedPrice: "10000000",
    executableQuantity: "0.001",
    dustQuantity: "0",
    belowMinOrderNotional: false,
    exceedsPosition: false,
    valid: true,
  };
}

function createExitPositionScopeFixture(): ExitPositionScope {
  return {
    market: "KRW-BTC",
    strategyId: "trend_following",
    totalQuantity: "0.005",
    observedAt,
  };
}

function createExitPolicySnapshotFixture(): ExitPolicySnapshot {
  return {
    minOrderNotional: "5000",
    tickSize: "1000",
    dustThreshold: "0.0001",
    exitCostBps: "5",
    exitSlippageBps: "2",
    source: "execution-runtime.test",
    capturedAt: observedAt,
  };
}

function createExitRiskContext(orderIntent: OrderSubmission["intent"], expectedLossBpsOfEquity: string): RiskGateContext {
  return {
    orderIntent,
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "-10",
      weeklyRealizedPnlBps: "-20",
      maxDrawdownBps: "100",
      capturedAt: observedAt,
    },
    positions: [],
    strategy: {
      strategyId: orderIntent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals: [],
    thresholdSnapshot,
    expectedLossBpsOfEquity,
    observedAt,
  };
}

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

function createFakeUpbitLiveBrokerPrivateClient(): UpbitLiveBrokerPrivateClient {
  return {
    createLimitOrder: vi.fn(async () => ({
      payload: createUpbitCommandOrderPayload(),
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
    cancelOrder: vi.fn(async () => ({
      payload: createUpbitCommandOrderPayload({ state: "wait" }),
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
    getOrder: vi.fn(async () => ({
      payload: {},
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
    listOpenOrders: vi.fn(async () => ({
      payload: [],
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
    getAccounts: vi.fn(async () => ({
      payload: [
        {
          currency: "KRW",
          balance: "10000",
          locked: "0",
          avg_buy_price: "0",
          avg_buy_price_modified: false,
          unit_currency: "KRW",
        },
      ],
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
  };
}

function createUpbitCommandOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: "KRW-BTC",
    uuid: "upbit-order-001",
    side: "bid",
    ord_type: "limit",
    price: "5000000",
    state: "wait",
    created_at: observedAt,
    volume: "0.001",
    remaining_volume: "0.001",
    executed_volume: "0",
    reserved_fee: "2.5",
    remaining_fee: "2.5",
    paid_fee: "0",
    locked: "5002.5",
    time_in_force: "post_only",
    identifier: "execution-candidate-1",
    prevented_volume: "0",
    prevented_locked: "0",
    trades_count: 0,
    ...overrides,
  };
}

function createUpbitLookupOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createUpbitCommandOrderPayload(overrides),
    trades: [],
  };
}

function createDuplicateIdentifierError(): UpbitPrivateRestClientError {
  return new UpbitPrivateRestClientError({
    status: 400,
    statusText: "Bad Request",
    kind: "REQUEST_FAILED",
    userMessage: "이미 사용한 주문 식별자입니다.",
    rateLimitStatus: defaultUpbitRateLimitStatus,
    trace: {
      httpStatus: 400,
      upbitErrorName: "duplicate_identifier",
      rateLimitStatus: defaultUpbitRateLimitStatus,
    },
  });
}

function createEnabledOrderSmokePilotConfig(
  overrides: Partial<EnabledPilotRuntimeConfig> = {},
): EnabledPilotRuntimeConfig {
  return {
    enabled: true,
    profile: "PILOT_ORDER_SMOKE",
    privateSmokeEnabled: true,
    orderSmokeEnabled: true,
    upbitAccessKey: "fixture-upbit-access-key",
    upbitSecretKey: "fixture-upbit-secret-key",
    keyScopes: ["자산조회", "주문조회", "주문하기"],
    keyScopeEvidenceId: "evidence-live-broker-001",
    policySyncMarket: "KRW-BTC",
    orderSmokeMarket: "KRW-BTC",
    orderSmokeMaxKrw: "5000",
    ...overrides,
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

function createSubmission(
  overrides: Partial<Extract<OrderSubmission["intent"], { orderType: "LIMIT" }>> = {},
): OrderSubmission {
  return {
    intent: {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: "5000000",
      requestedQuantity: "0.001",
      requestedNotional: "5000",
      idempotencyKey: "execution-candidate-1",
      reason: "disabled-live-broker-test",
      postOnly: true,
      timeInForce: "POST_ONLY",
      ...overrides,
    },
    costSnapshot: {},
    riskApproval: {},
    submittedAt: observedAt,
  };
}
