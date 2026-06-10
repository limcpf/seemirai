import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ExecutionEngine,
  LiveAutonomousEntryRuntime,
} from "../../src/application/index.js";
import {
  canTransitionLiveAutonomousOrderAttempt,
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../src/domain/index.js";
import { loadRuntimeConfig } from "../../src/runtime/index.js";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  LiveAutonomousBudgetSnapshot,
  OrderSubmission,
} from "../../src/domain/index.js";
import type {
  BrokerPort,
  ExecutionSubmitOrderResult,
  LiveAutonomousBudgetReservationPort,
  LiveAutonomousEntryCandidate,
  LiveAutonomousEntryLossSnapshot,
} from "../../src/application/index.js";

const observedAt = "2026-06-10T12:00:00.000Z";
const deterministicRandomHex = "a".repeat(26);

describe("M22 live autonomous entry state machine", () => {
  it("허용된 entry attempt 전이만 통과시킨다", () => {
    expect(canTransitionLiveAutonomousOrderAttempt(undefined, "CANDIDATE_CREATED")).toBe(true);
    expect(canTransitionLiveAutonomousOrderAttempt("CANDIDATE_CREATED", "COST_APPROVED")).toBe(true);
    expect(canTransitionLiveAutonomousOrderAttempt("COST_APPROVED", "RISK_APPROVED")).toBe(true);
    expect(canTransitionLiveAutonomousOrderAttempt("RISK_APPROVED", "RESERVED")).toBe(true);
    expect(canTransitionLiveAutonomousOrderAttempt("RESERVED", "SUBMITTED")).toBe(true);
    expect(canTransitionLiveAutonomousOrderAttempt("SUBMITTED", "RESERVED")).toBe(false);
  });
});

describe("M22 live autonomous entry runtime", () => {
  it("비용, RiskGate, 예산 reservation 이후 fake broker에 LIMIT + POST_ONLY 주문만 제출한다", async () => {
    const submitted: OrderSubmission[] = [];
    const runtime = createRuntime({
      broker: createFakeBroker({
        submitOrder: async (submission) => {
          submitted.push(submission);
          return createBrokerOrder(submission);
        },
      }),
    });

    const result = await runtime.submitEntryCandidate(createRequest());

    expect(result.status).toBe("SUBMITTED");
    expect(result.idempotencyKey).toBe(`m22a-${deterministicRandomHex}`);
    expect(result.events.map((event) => event.toStatus)).toEqual([
      "CANDIDATE_CREATED",
      "COST_APPROVED",
      "RISK_APPROVED",
      "RESERVED",
      "SUBMITTED",
    ]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.intent).toMatchObject({
      side: "BUY",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
      idempotencyKey: `m22a-${deterministicRandomHex}`,
      requestedNotional: "10000",
    });
    expect(submitted[0]?.costSnapshot).toMatchObject({
      source: "cost_model",
      trade_allowed: true,
      reason_code: "cost_margin_ok",
    });
    expect(submitted[0]?.riskApproval).toMatchObject({
      source: "risk_gate",
      approved: true,
      action: "ALLOW",
    });
  });

  it("MARKET/PRICE/BEST 또는 post_only 해제 후보는 예산 reservation과 broker 제출 전에 차단한다", async () => {
    const cases: Array<Pick<LiveAutonomousEntryCandidate, "orderType" | "postOnly">> = [
      { orderType: "MARKET" },
      { orderType: "PRICE" },
      { orderType: "BEST" },
      { orderType: "LIMIT", postOnly: false },
    ];

    for (const candidateOverride of cases) {
      const reserve = vi.fn<LiveAutonomousBudgetReservationPort["reserve"]>();
      const broker = createFakeBroker();
      const runtime = createRuntime({
        broker,
        budgetReservation: {
          reserve,
        },
      });

      const result = await runtime.submitEntryCandidate(
        createRequest({
          candidate: {
            ...createCandidate(),
            ...candidateOverride,
          },
        }),
      );

      expect(result.status).toBe("BLOCKED");
      expect(result.violations).toContain("M22 자동매매는 LIMIT + post_only 주문만 제출할 수 있습니다.");
      expect(reserve).not.toHaveBeenCalled();
      expect(broker.submitOrder).not.toHaveBeenCalled();
    }
  });

  it("kill switch, stale reconcile, 가격 이탈, 예산 초과는 broker 제출 전에 fail-closed 한다", async () => {
    const reserve = vi.fn<LiveAutonomousBudgetReservationPort["reserve"]>();
    const broker = createFakeBroker();
    const runtime = createRuntime({
      broker,
      budgetReservation: {
        reserve,
      },
    });

    const result = await runtime.submitEntryCandidate(
      createRequest({
        killSwitchActive: true,
        reconcileFresh: false,
        candidate: {
          ...createCandidate(),
          requestedPrice: "110000000",
        },
        budgetSnapshot: createBudgetSnapshot({
          dailyAutonomousNotionalUsedKrw: "25000",
          openPositionNotionalKrw: "25000",
        }),
        lossSnapshot: createLossSnapshot({
          dailyRealizedLossKrw: "10001",
        }),
      }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "kill switch가 활성화되어 M22 자동매매 주문 후보를 제출하지 않습니다.",
        "최신 reconcile 상태가 없어 M22 자동매매 주문 후보를 제출하지 않습니다.",
        "M22 자동매매 일일 예산을 초과해 후보를 제출하지 않습니다.",
        "M22 자동매매 open position 예산을 초과해 후보를 제출하지 않습니다.",
        "M22 자동매매 일일 손실 한도를 초과해 후보를 제출하지 않습니다.",
        "M22 자동매매 가격 이탈 한도를 초과해 후보를 제출하지 않습니다.",
      ]),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(broker.submitOrder).not.toHaveBeenCalled();
  });

  it("requestedNotional이 수량과 가격으로 계산한 지정가 notional과 다르면 차단한다", async () => {
    const reserve = vi.fn<LiveAutonomousBudgetReservationPort["reserve"]>();
    const broker = createFakeBroker();
    const runtime = createRuntime({
      broker,
      budgetReservation: {
        reserve,
      },
    });

    const result = await runtime.submitEntryCandidate(
      createRequest({
        candidate: {
          ...createCandidate(),
          requestedQuantity: "1",
          requestedNotional: "10000",
          requestedPrice: "100000000",
        },
      }),
    );

    expect(result.status).toBe("BLOCKED");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "M22 자동매매 지정가 주문 금액이 수량×가격과 일치하지 않습니다.",
        "M22 자동매매 단일 주문 예산을 초과해 후보를 제출하지 않습니다.",
      ]),
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(broker.submitOrder).not.toHaveBeenCalled();
  });

  it("durable budget reservation이 거부되면 ExecutionEngine을 호출하지 않는다", async () => {
    const broker = createFakeBroker();
    const reserve = vi.fn<LiveAutonomousBudgetReservationPort["reserve"]>(async () => ({
      reserved: false,
      reasonCode: "daily_budget_reserved_elsewhere",
      message: "다른 runtime instance가 일일 예산을 먼저 선점했습니다.",
    }));
    const runtime = createRuntime({
      broker,
      budgetReservation: {
        reserve,
      },
    });

    const result = await runtime.submitEntryCandidate(createRequest());

    expect(result.status).toBe("BLOCKED");
    expect(result.events.map((event) => event.toStatus)).toEqual([
      "CANDIDATE_CREATED",
      "COST_APPROVED",
      "RISK_APPROVED",
      "BLOCKED",
    ]);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(broker.submitOrder).not.toHaveBeenCalled();
  });

  it("durable budget reservation 저장 예외를 manual review 결과로 정규화한다", async () => {
    const broker = createFakeBroker();
    const reserve = vi.fn<LiveAutonomousBudgetReservationPort["reserve"]>(async () => {
      throw new Error("reservation store unavailable");
    });
    const runtime = createRuntime({
      broker,
      budgetReservation: {
        reserve,
      },
    });

    const result = await runtime.submitEntryCandidate(createRequest());

    expect(result.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(result.events.map((event) => event.toStatus)).toEqual([
      "CANDIDATE_CREATED",
      "COST_APPROVED",
      "RISK_APPROVED",
      "MANUAL_REVIEW_REQUIRED",
    ]);
    expect(result.violations).toContain("reservation store unavailable");
    expect(broker.submitOrder).not.toHaveBeenCalled();
  });

  it("ExecutionEngine이 broker 전 단계에서 거부하면 reservation을 release 한다", async () => {
    const release = vi.fn<NonNullable<LiveAutonomousBudgetReservationPort["release"]>>();
    const runtime = new LiveAutonomousEntryRuntime({
      executionEngine: {
        submitOrder: async (submission): Promise<ExecutionSubmitOrderResult> => ({
          status: "REJECTED",
          submission,
          rejection: {
            reasonCode: "risk_approval_mismatch",
            message: "unit test forced rejection",
          },
        }),
      },
      budgetReservation: createBudgetReservation({ release }),
      randomHex: () => deterministicRandomHex,
      clock: () => observedAt,
    });

    const result = await runtime.submitEntryCandidate(createRequest());

    expect(result.status).toBe("REJECTED");
    expect(release).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "reservation-001",
      }),
      "risk_approval_mismatch",
    );
  });

  it("기존 attempt retry는 주입된 idempotency key를 재사용하고 새 random key를 만들지 않는다", async () => {
    const submitted: OrderSubmission[] = [];
    const randomHex = vi.fn(() => deterministicRandomHex);
    const runtime = new LiveAutonomousEntryRuntime({
      executionEngine: new ExecutionEngine({
        broker: createFakeBroker({
          submitOrder: async (submission) => {
            submitted.push(submission);
            return createBrokerOrder(submission);
          },
        }),
      }),
      budgetReservation: createBudgetReservation(),
      randomHex,
      clock: () => observedAt,
    });
    const retryKey = `m22a-${"b".repeat(26)}`;

    const result = await runtime.submitEntryCandidate(createRequest({ idempotencyKey: retryKey }));

    expect(result.status).toBe("SUBMITTED");
    expect(result.idempotencyKey).toBe(retryKey);
    expect(submitted[0]?.intent.idempotencyKey).toBe(retryKey);
    expect(randomHex).not.toHaveBeenCalled();
  });

  it("entry runtime module은 Upbit private client나 REST 주문 endpoint를 직접 만들지 않는다", async () => {
    const files = [
      path.join(process.cwd(), "src", "application", "live-autonomous-entry-runtime.ts"),
      path.join(process.cwd(), "src", "application", "live-autonomous-entry-runtime", "identifier.ts"),
      path.join(process.cwd(), "src", "application", "live-autonomous-entry-runtime", "service.ts"),
      path.join(process.cwd(), "src", "application", "live-autonomous-entry-runtime", "types.ts"),
    ];
    const combinedSource = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    expect(combinedSource).not.toMatch(/UpbitPrivateRestClient|createGuardedUpbitLiveBrokerRuntime/u);
    expect(combinedSource).not.toMatch(/POST \/v1\/orders|DELETE \/v1\/order|Authorization|Bearer/u);
  });
});

function createRuntime(input: {
  broker?: BrokerPort;
  budgetReservation?: LiveAutonomousBudgetReservationPort;
} = {}): LiveAutonomousEntryRuntime {
  const broker = input.broker ?? createFakeBroker();
  return new LiveAutonomousEntryRuntime({
    executionEngine: new ExecutionEngine({ broker }),
    budgetReservation: input.budgetReservation ?? createBudgetReservation(),
    randomHex: () => deterministicRandomHex,
    clock: () => observedAt,
  });
}

function createRequest(
  overrides: Partial<Parameters<LiveAutonomousEntryRuntime["submitEntryCandidate"]>[0]> = {},
): Parameters<LiveAutonomousEntryRuntime["submitEntryCandidate"]>[0] {
  return {
    config: loadRuntimeConfig({
      live_autonomous: {
        enabled: true,
      },
    }).live_autonomous,
    candidate: createCandidate(),
    budgetSnapshot: createBudgetSnapshot(),
    lossSnapshot: createLossSnapshot(),
    killSwitchActive: false,
    reconcileFresh: true,
    observedAt,
    ...overrides,
  };
}

function createCandidate(overrides: Partial<LiveAutonomousEntryCandidate> = {}): LiveAutonomousEntryCandidate {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "m22.autonomous.entry",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    requestedPrice: "100000000",
    referencePrice: "100000000",
    reason: "unit test autonomous entry",
    expectedLossBpsOfEquity: "5",
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
        strategyId: "m22.autonomous.entry",
        consecutiveLosses: 0,
        capturedAt: observedAt,
      },
      infrastructureSignals: [],
      thresholdSnapshot: createRiskThresholdSnapshot(
        defaultRiskLimitThresholds,
        observedAt,
        "live_autonomous_entry_runtime.test",
      ),
    },
    ...overrides,
  };
}

function createLossSnapshot(overrides: Partial<LiveAutonomousEntryLossSnapshot> = {}): LiveAutonomousEntryLossSnapshot {
  return {
    dailyRealizedLossKrw: "0",
    weeklyRealizedLossKrw: "0",
    capturedAt: observedAt,
    ...overrides,
  };
}

function createBudgetSnapshot(overrides: Partial<LiveAutonomousBudgetSnapshot> = {}): LiveAutonomousBudgetSnapshot {
  return {
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    dailyAutonomousNotionalUsedKrw: "0",
    openPositionNotionalKrw: "0",
    maxOpenPositionNotionalKrw: "30000",
    capturedAt: observedAt,
    ...overrides,
  };
}

function createBudgetReservation(input: {
  release?: NonNullable<LiveAutonomousBudgetReservationPort["release"]>;
} = {}): LiveAutonomousBudgetReservationPort {
  return {
    reserve: async (request) => ({
      reserved: true,
      reservation: {
        reservationId: "reservation-001",
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        reservedNotionalKrw: request.requestedNotionalKrw,
        budgetSnapshot: request.budgetSnapshot,
        reservedAt: request.observedAt,
      },
    }),
    ...(input.release === undefined ? {} : { release: input.release }),
  };
}

function createFakeBroker(overrides: Partial<BrokerPort> = {}): BrokerPort {
  const submitOrder = vi.fn(async (submission: OrderSubmission): Promise<BrokerOrder> => createBrokerOrder(submission));
  const getBalances = vi.fn(async (): Promise<BrokerBalanceSnapshot> => ({
    exchangeId: "upbit_krw_spot",
    balances: [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        updatedAt: observedAt,
      },
    ],
    capturedAt: observedAt,
  }));

  return {
    submitOrder,
    cancelOrder: vi.fn(),
    getOrder: vi.fn(),
    listOpenOrders: vi.fn(async () => []),
    getBalances,
    ...overrides,
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
