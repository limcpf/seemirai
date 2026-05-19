import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ExecutionEngine,
  createExecutionRiskApprovalEvidence,
  evaluateRiskGate,
  validateExecutionSubmission,
} from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  evaluateCost,
} from "../../src/domain/index.js";
import type { BrokerPort } from "../../src/application/index.js";
import type { ExecutionRiskApprovalEvidence } from "../../src/application/index.js";
import type {
  BrokerOrder,
  MarketOrderIntent,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
} from "../../src/domain/index.js";

const observedAt = "2026-05-19T09:00:00.000Z";
const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt);

describe("M6 ExecutionEngine contract", () => {
  it("submits a limit order only after cost and RiskGate evidence match the current intent", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const submission = createSubmission();

    const result = await engine.submitOrder(submission);

    expect(result).toMatchObject({
      status: "SUBMITTED",
      brokerOrder: {
        idempotencyKey: "execution-candidate-1",
        status: "SUBMITTED",
        requestedPrice: "10000000",
      },
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(submitOrder).toHaveBeenCalledWith(submission);
  });

  it("rejects submissions without a cost snapshot before calling BrokerPort", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const result = await engine.submitOrder(
      createSubmission({
        costSnapshot: {},
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "cost_snapshot_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects submissions when the cost snapshot did not allow the trade", () => {
    const submission = createSubmission({
      costSnapshot: {
        ...createCostSnapshot(createLimitIntent()),
        trade_allowed: false,
        reason_code: "cost_margin_insufficient",
      },
    });

    expect(validateExecutionSubmission(submission)).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "cost_snapshot_not_allowed",
      },
    });
  });

  it("rejects submissions without RiskGate approval evidence before calling BrokerPort", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const result = await engine.submitOrder(
      createSubmission({
        riskApproval: {},
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("fails closed when RiskGate evidence describes a different order candidate", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const approvedRiskApproval = createRiskApprovalEvidence(createLimitIntent());
    const result = await engine.submitOrder(
      createSubmission({
        riskApproval: {
          ...approvedRiskApproval,
          order_intent: {
            ...approvedRiskApproval.order_intent,
            market: "KRW-ETH",
            idempotency_key: "execution-candidate-eth",
            requested_notional: "7000",
          },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "risk_approval_mismatch",
        metadata: {
          mismatches: {
            market_evidence: "KRW-ETH",
            market_runtime: "KRW-BTC",
            idempotency_key_evidence: "execution-candidate-eth",
            idempotency_key_runtime: "execution-candidate-1",
            requested_notional_evidence: "7000",
            requested_notional_runtime: "5000",
          },
        },
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("rejects blank idempotency keys before cost or broker side effects", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const intent = createLimitIntent({
      idempotencyKey: "   ",
    });
    const result = await engine.submitOrder(createSubmission({ intent }));

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "idempotency_key_missing",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("suppresses duplicate broker submission for the same idempotency key", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const submission = createSubmission();

    const firstResult = await engine.submitOrder(submission);
    const duplicateResult = await engine.submitOrder(submission);

    expect(firstResult.status).toBe("SUBMITTED");
    expect(duplicateResult).toMatchObject({
      status: "DUPLICATE_SUPPRESSED",
      brokerOrder: {
        idempotencyKey: "execution-candidate-1",
      },
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
  });

  it("rejects market orders in the default paper profile", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine({ broker });
    const intent = createMarketIntent();
    const result = await engine.submitOrder(createSubmission({ intent }));

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "market_order_disabled",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("keeps entry market orders disabled even when market order simulation is explicitly enabled", () => {
    const intent = createMarketIntent();

    expect(
      validateExecutionSubmission(createSubmission({ intent }), {
        liveTradingEnabled: false,
        marketOrderEnabled: true,
        entryMarketOrderEnabled: false,
        paperNoKey: true,
      }),
    ).toMatchObject({
      valid: false,
      rejection: {
        reasonCode: "entry_market_order_disabled",
      },
    });
  });

  it("rejects live-trading execution config before BrokerPort side effects", async () => {
    const { broker, submitOrder } = createBrokerPort();
    const engine = new ExecutionEngine(
      { broker },
      {
        safetyConfig: {
          liveTradingEnabled: true,
        },
      },
    );
    const result = await engine.submitOrder(createSubmission());

    expect(result).toMatchObject({
      status: "REJECTED",
      rejection: {
        reasonCode: "live_trading_disabled",
      },
    });
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it("does not import strategy, Upbit, runtime, or DB implementations", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "execution", "execution-engine.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*(strategy|upbit|runtime|infrastructure\/db)/iu);
  });
});

function createBrokerPort() {
  const submitOrder = vi.fn(async (submission: OrderSubmission): Promise<BrokerOrder> => {
    const brokerOrder: BrokerOrder = {
      brokerOrderId: "paper-order-1",
      idempotencyKey: submission.intent.idempotencyKey,
      exchangeId: submission.intent.exchangeId,
      market: submission.intent.market,
      side: submission.intent.side,
      orderType: submission.intent.orderType,
      status: "SUBMITTED",
      requestedQuantity: submission.intent.requestedQuantity,
      remainingQuantity: submission.intent.requestedQuantity,
      updatedAt: observedAt,
    };

    if (submission.intent.orderType === "LIMIT") {
      return {
        ...brokerOrder,
        requestedPrice: submission.intent.requestedPrice,
      };
    }

    return brokerOrder;
  });

  const broker: BrokerPort = {
    submitOrder,
    cancelOrder: async (orderId: string): Promise<BrokerOrder> => ({
      brokerOrderId: orderId,
      idempotencyKey: "execution-candidate-1",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "CANCELED",
      requestedQuantity: "0.0005",
      remainingQuantity: "0",
      requestedPrice: "10000000",
      updatedAt: observedAt,
    }),
    getOrder: async () => undefined,
    listOpenOrders: async () => [],
    getBalances: async () => ({
      exchangeId: "upbit_krw_spot",
      balances: [],
      capturedAt: observedAt,
    }),
  };

  return {
    submitOrder,
    broker,
  };
}

function createSubmission(
  overrides: Partial<OrderSubmission> & { intent?: OrderIntent } = {},
): OrderSubmission {
  const intent = overrides.intent ?? createLimitIntent();
  const submission: OrderSubmission = {
    intent,
    costSnapshot: createCostSnapshot(intent),
    riskApproval: createRiskApprovalEvidence(intent),
    submittedAt: observedAt,
  };

  return {
    ...submission,
    ...overrides,
  };
}

function createCostSnapshot(intent: OrderIntent): OrderSubmission["costSnapshot"] {
  return evaluateCost({
    exchangeId: intent.exchangeId,
    market: intent.market,
    expectedReturnBps: "30",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "1",
    expectedSlippageBpsP95: "1",
    cancelRequotePenaltyBps: "0.5",
  }).snapshot;
}

function createRiskApprovalEvidence(intent: OrderIntent): ExecutionRiskApprovalEvidence {
  const riskContext = createRiskContext(intent);
  return createExecutionRiskApprovalEvidence(evaluateRiskGate(riskContext), riskContext);
}

function createRiskContext(intent: OrderIntent): RiskGateContext {
  return {
    orderIntent: intent,
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "-10",
      weeklyRealizedPnlBps: "-20",
      maxDrawdownBps: "100",
      capturedAt: observedAt,
    },
    positions: [],
    strategy: {
      strategyId: intent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals: [],
    thresholdSnapshot,
    observedAt,
    expectedLossBpsOfEquity: "10",
  };
}

function createLimitIntent(overrides: Partial<Extract<OrderIntent, { orderType: "LIMIT" }>> = {}): Extract<
  OrderIntent,
  { orderType: "LIMIT" }
> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "execution-candidate-1",
    reason: "unit-test",
    ...overrides,
  };
}

function createMarketIntent(overrides: Partial<MarketOrderIntent> = {}): MarketOrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "MARKET",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "execution-market-candidate-1",
    reason: "unit-test-market",
    ...overrides,
  };
}
