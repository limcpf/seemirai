import { describe, expect, it } from "vitest";
import {
  createDefaultM5Rules,
  createRiskGateRuntimeDecisionPlan,
  createRiskOkRule,
  evaluateRiskGate,
  evaluateRules,
  persistRiskGateRuntimeDecision,
} from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  evaluateCost,
} from "../../src/domain/index.js";
import type {
  RiskGateDecisionEvidenceAppendInput,
  RiskGateDecisionEvidenceReceipt,
  RiskGateRuntimeEventPorts,
} from "../../src/application/index.js";
import type {
  BrokerOrder,
  InfrastructureRiskSnapshot,
  OrderIntent,
  PositionRiskSnapshot,
  RiskGateContext,
  RuleContext,
} from "../../src/domain/index.js";

const observedAt = "2026-05-19T04:30:00.000Z";
const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt);
type LimitTestOrderIntent = Extract<OrderIntent, { orderType: "LIMIT" }>;

describe("M5 risk_ok rule integration", () => {
  it("passes only when an active RiskGate result approves the candidate", async () => {
    const result = await Promise.resolve(
      createRiskOkRule().evaluate(
        createRuleContext({
          riskGateContext: createRiskContext(),
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "PASS",
      reasonCode: "risk_gate_approved",
      metadata: {
        active_risk_gate_evaluated: true,
        execution_approval: true,
        risk_gate_action: "ALLOW",
      },
    });
  });

  it("fails closed when RiskGate context is missing or rejects the candidate", async () => {
    const missingContextResult = await Promise.resolve(createRiskOkRule().evaluate(createRuleContext()));
    const rejectedResult = await Promise.resolve(
      createRiskOkRule().evaluate(
        createRuleContext({
          riskGateContext: createRiskContext({
            account: {
              dailyRealizedPnlBps: "-100",
            },
          }),
        }),
      ),
    );

    expect(missingContextResult).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_context_missing",
    });
    expect(rejectedResult).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_rejected",
      metadata: {
        execution_approval: false,
        failed_evaluations: [
          {
            reason_code: "daily_loss_limit_exceeded",
          },
        ],
      },
    });
  });

  it("evaluates the current RiskGate context instead of accepting a stale cached approval", async () => {
    const evaluatedContexts: RiskGateContext[] = [];
    const rejectedContext = createRiskContext({
      account: {
        dailyRealizedPnlBps: "-100",
      },
    });
    const result = await Promise.resolve(
      createRiskOkRule({
        evaluateRiskGate: (context) => {
          evaluatedContexts.push(context);

          return evaluateRiskGate(context);
        },
      }).evaluate(createRuleContext({ riskGateContext: rejectedContext })),
    );

    expect(evaluatedContexts).toEqual([rejectedContext]);
    expect(result).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_rejected",
      metadata: {
        failed_evaluations: [
          {
            reason_code: "daily_loss_limit_exceeded",
          },
        ],
      },
    });
  });

  it("fails closed when the rule candidate and RiskGate context describe different order intents", async () => {
    const result = await Promise.resolve(
      createRiskOkRule().evaluate(
        createRuleContext({
          market: "KRW-ETH",
          orderIntent: createOrderIntent({
            market: "KRW-ETH",
            idempotencyKey: "candidate-eth",
          }),
          riskGateContext: createRiskContext(),
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_context_mismatch",
      metadata: {
        execution_approval: false,
        mismatches: {
          context_market: "KRW-ETH",
          risk_gate_market: "KRW-BTC",
          order_intent_idempotency_key_rule: "candidate-eth",
          order_intent_idempotency_key_risk_gate: "candidate-1",
        },
      },
    });
  });

  it("fails closed when a reused RiskGate approval has different order amount fields", async () => {
    const result = await Promise.resolve(
      createRiskOkRule().evaluate(
        createRuleContext({
          orderIntent: createOrderIntent({
            requestedPrice: "20000000",
            requestedQuantity: "0.001",
            requestedNotional: "20000",
          }),
          riskGateContext: createRiskContext(),
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_context_mismatch",
      metadata: {
        execution_approval: false,
        mismatches: {
          order_intent_requested_quantity_rule: "0.001",
          order_intent_requested_quantity_risk_gate: "0.0005",
          order_intent_requested_notional_rule: "20000",
          order_intent_requested_notional_risk_gate: "5000",
          order_intent_requested_price_rule: "20000000",
          order_intent_requested_price_risk_gate: "10000000",
        },
      },
    });
  });

  it("fails closed when a reused RiskGate approval has different expected loss input", async () => {
    const result = await Promise.resolve(
      createRiskOkRule().evaluate(
        createRuleContext({
          orderIntent: createOrderIntent({
            metadata: {
              expected_loss_bps_of_equity: "25",
            },
          }),
          riskGateContext: createRiskContext(),
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "FAIL",
      reasonCode: "risk_gate_context_mismatch",
      metadata: {
        execution_approval: false,
        mismatches: {
          order_intent_expected_loss_bps_of_equity_rule: "25",
          order_intent_expected_loss_bps_of_equity_risk_gate: "10",
        },
      },
    });
  });

  it("uses the active RiskGate rule in the M5 default rule chain", async () => {
    const result = await evaluateRules(
      createDefaultM5Rules({
        allowedMarkets: ["KRW-BTC", "KRW-ETH"],
        maxSpreadBps: "8",
        minDepthKrw: "50000000",
        stopLossBps: "35",
        takeProfitBps: "40",
      }),
      createRuleContext({
        riskGateContext: createRiskContext(),
      }),
    );

    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
    expect(result.evaluations.map((evaluation) => evaluation.reasonCode)).toContain("risk_gate_approved");
    expect(result.evaluations.map((evaluation) => evaluation.reasonCode)).not.toContain("risk_ok_placeholder");
  });
});

describe("RiskGate runtime event wiring", () => {
  it("plans order/risk/audit events and pending paper order cancellation on hard stop", () => {
    const hardStopContext = createRiskContext({
      infrastructureSignals: [createInfrastructureSignal("DB_WRITE_FAILURE")],
    });
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: hardStopContext,
      actor: "risk-gate",
      correlationId: "candidate-1",
      pendingPaperOrders: [
        createBrokerOrder({
          brokerOrderId: "paper-open-1",
          status: "ACCEPTED",
        }),
        createBrokerOrder({
          brokerOrderId: "paper-filled-1",
          status: "FILLED",
        }),
      ],
    });

    expect(plan.orderStateTransition).toMatchObject({
      accepted: true,
      fromState: "VALIDATED",
      toState: "RISK_REJECTED",
      reasonCode: "risk_gate_order_rejected",
    });
    expect(plan.killSwitchStateTransition).toMatchObject({
      accepted: true,
      fromState: "NORMAL",
      toState: "HARD_STOP",
      reasonCode: "risk_gate_hard_stop",
    });
    expect(plan.riskEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          riskType: "db_write_failure",
          action: "HARD_STOP",
          severity: "CRITICAL",
          orderId: "order-1",
        }),
      ]),
    );
    expect(plan.hardStopActionPlan).toMatchObject({
      actionPlan: {
        cancelPendingPaperOrders: true,
        autoLiquidateOpenPositions: false,
      },
      pendingPaperOrderCancelActions: [
        {
          action: "PLAN_CANCEL_PENDING_PAPER_ORDER",
          brokerOrderId: "paper-open-1",
        },
      ],
    });
    expect(plan.auditEvents.map((event) => event.reasonCode)).toEqual(
      expect.arrayContaining([
        "risk_gate_order_rejected",
        "db_write_failure",
        "risk_gate_hard_stop",
        "hard_stop_action_plan_created",
      ]),
    );
  });

  it("keeps strategy loss pauses scoped to the strategy instead of the global kill switch", () => {
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRiskContext({
        strategy: {
          consecutiveLosses: 3,
        },
      }),
      actor: "risk-gate",
      correlationId: "candidate-1",
    });

    expect(plan.riskGateResult.action).toBe("PAUSE_STRATEGY");
    expect(plan.killSwitchStateTransition).toBeUndefined();
    expect(plan.strategyPauseActionPlan).toEqual({
      action: "PLAN_PAUSE_STRATEGY",
      strategyId: "trend_following",
      newOrdersBlocked: false,
      strategyEvaluationBlocked: true,
    });
    expect(plan.auditEvents.find((event) => event.reasonCode === "strategy_pause_action_plan_created")).toMatchObject({
      metadata: {
        global_new_orders_blocked: false,
        global_kill_switch_unchanged: true,
      },
    });
  });

  it("keeps strategy pause evidence when a stronger account block dominates", () => {
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRiskContext({
        account: {
          dailyRealizedPnlBps: "-100",
        },
        strategy: {
          consecutiveLosses: 3,
        },
      }),
      actor: "risk-gate",
      correlationId: "candidate-1",
    });

    expect(plan.riskGateResult.action).toBe("BLOCK_NEW_ORDER");
    expect(plan.strategyPauseActionPlan).toMatchObject({
      action: "PLAN_PAUSE_STRATEGY",
      strategyId: "trend_following",
    });
    expect(plan.killSwitchStateTransition).toMatchObject({
      toState: "NEW_ORDERS_BLOCKED",
    });
    expect(plan.auditEvents.find((event) => event.reasonCode === "strategy_pause_action_plan_created")).toMatchObject({
      metadata: {
        global_new_orders_blocked: true,
        global_kill_switch_unchanged: false,
      },
    });
  });

  it("rejects candidates when the current kill switch already blocks new orders", () => {
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "HARD_STOP",
      riskGateContext: createRiskContext(),
      actor: "risk-gate",
      correlationId: "candidate-1",
      pendingPaperOrders: [createBrokerOrder()],
    });

    expect(plan.riskGateResult).toMatchObject({
      approved: false,
      action: "HARD_STOP",
      failedEvaluations: [
        expect.objectContaining({
          reasonCode: "current_kill_switch_blocks_new_order",
          action: "HARD_STOP",
        }),
      ],
    });
    expect(plan.orderStateTransition).toMatchObject({
      toState: "RISK_REJECTED",
      reasonCode: "risk_gate_order_rejected",
    });
    expect(plan.riskEvents.map((event) => event.riskType)).toContain(
      "current_kill_switch_blocks_new_order",
    );
    expect(plan.hardStopActionPlan).toMatchObject({
      actionPlan: {
        cancelPendingPaperOrders: true,
        autoLiquidateOpenPositions: false,
      },
    });
  });

  it("rejects persistence plans when the runtime correlation id does not match the RiskGate intent", () => {
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRiskContext(),
      actor: "risk-gate",
      correlationId: "other-candidate",
    });

    expect(plan.riskGateResult).toMatchObject({
      approved: false,
      action: "MANUAL_REVIEW_REQUIRED",
      failedEvaluations: [
        expect.objectContaining({
          reasonCode: "risk_gate_runtime_candidate_mismatch",
          action: "MANUAL_REVIEW_REQUIRED",
        }),
      ],
    });
    expect(plan.orderStateTransition).toMatchObject({
      toState: "RISK_REJECTED",
      reasonCode: "risk_gate_order_rejected",
    });
    expect(plan.riskEvents.map((event) => event.riskType)).toContain(
      "risk_gate_runtime_candidate_mismatch",
    );
  });

  it("fails closed when RiskGate cannot legally transition the current order state", () => {
    const plan = createRiskGateRuntimeDecisionPlan({
      orderId: "order-1",
      orderStatus: "CREATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRiskContext(),
      actor: "risk-gate",
      correlationId: "candidate-1",
    });

    expect(plan.riskGateResult).toMatchObject({
      approved: false,
      action: "MANUAL_REVIEW_REQUIRED",
      failedEvaluations: [
        expect.objectContaining({
          reasonCode: "risk_gate_illegal_order_state_transition",
          action: "MANUAL_REVIEW_REQUIRED",
        }),
      ],
    });
    expect(plan.orderStateTransition).toMatchObject({
      accepted: false,
      fromState: "CREATED",
      toState: "RISK_REJECTED",
      reasonCode: "risk_gate_order_rejected",
    });
    expect(plan.riskEvents.map((event) => event.riskType)).toContain(
      "risk_gate_illegal_order_state_transition",
    );
  });

  it("appends RiskGate evidence through one combined event store port", async () => {
    const appendedEvidence: RiskGateDecisionEvidenceAppendInput[] = [];
    const ports: RiskGateRuntimeEventPorts = {
      eventStore: createEvidenceStorePort(appendedEvidence),
    };

    const result = await persistRiskGateRuntimeDecision(ports, {
      orderId: "order-1",
      orderStatus: "VALIDATED",
      currentKillSwitchState: "NORMAL",
      riskGateContext: createRiskContext({
        infrastructureSignals: [createInfrastructureSignal("DUPLICATE_ORDER_IDEMPOTENCY_KEY")],
      }),
      actor: "risk-gate",
      correlationId: "candidate-1",
      pendingPaperOrders: [createBrokerOrder()],
    });

    expect(result.plan.riskGateResult.action).toBe("HARD_STOP");
    expect(result.killSwitchEventReceipt).toEqual({
      id: "kill-switch-event-1",
    });
    expect(appendedEvidence).toHaveLength(1);
    expect(appendedEvidence[0]?.orderStateTransition).toMatchObject({
      orderId: "order-1",
      correlationId: "candidate-1",
      event: {
        toState: "RISK_REJECTED",
      },
    });
    expect(appendedEvidence[0]?.killSwitchStateTransition).toMatchObject({
      correlationId: "candidate-1",
      event: {
        toState: "HARD_STOP",
      },
    });
    expect(appendedEvidence[0]?.riskEvents.map((event) => event.riskType)).toContain(
      "duplicate_order_idempotency_key",
    );
    expect(appendedEvidence[0]?.auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["STATE_TRANSITION", "RISK_REJECTION"]),
    );
    expect(
      appendedEvidence[0]?.auditEvents.find((event) => event.reasonCode === "hard_stop_action_plan_created"),
    ).toMatchObject({
      metadata: {
        cancel_pending_paper_orders: true,
        auto_liquidate_open_positions: false,
      },
    });
  });
});

function createRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    observedAt,
    orderIntent: createOrderIntent(),
    universe: {
      allowedMarkets: ["KRW-BTC", "KRW-ETH"],
    },
    marketStatus: {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      tradable: true,
      warning: false,
      caution: false,
      reasonCodes: [],
      updatedAt: observedAt,
    },
    features: {
      spread_bps: "4",
      depth_krw: "80000000",
    },
    costDecision: evaluateCost({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      expectedReturnBps: "30",
      entryFeeBps: "5",
      exitFeeBps: "5",
      spreadCostBpsP75: "1",
      expectedSlippageBpsP95: "1",
      cancelRequotePenaltyBps: "0.5",
    }),
    ...overrides,
  };
}

function createRiskContext(
  overrides: {
    orderIntent?: Partial<LimitTestOrderIntent>;
    account?: Partial<RiskGateContext["account"]>;
    positions?: readonly PositionRiskSnapshot[];
    strategy?: Partial<RiskGateContext["strategy"]>;
    infrastructureSignals?: readonly InfrastructureRiskSnapshot[];
  } = {},
): RiskGateContext {
  return {
    orderIntent: createOrderIntent(overrides.orderIntent ?? {}),
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "-10",
      weeklyRealizedPnlBps: "-20",
      maxDrawdownBps: "100",
      capturedAt: observedAt,
      ...overrides.account,
    },
    positions: overrides.positions ?? [],
    strategy: {
      strategyId: "trend_following",
      consecutiveLosses: 0,
      capturedAt: observedAt,
      ...overrides.strategy,
    },
    infrastructureSignals: overrides.infrastructureSignals ?? [],
    thresholdSnapshot,
    observedAt,
  };
}

function createOrderIntent(overrides: Partial<LimitTestOrderIntent> = {}): LimitTestOrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.0005",
    requestedNotional: "5000",
    idempotencyKey: "candidate-1",
    reason: "unit-test",
    metadata: {
      expected_loss_bps_of_equity: "10",
    },
    ...overrides,
  };
}

function createInfrastructureSignal(
  signal: InfrastructureRiskSnapshot["signal"],
): InfrastructureRiskSnapshot {
  return {
    signal,
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    observedAt,
  };
}

function createBrokerOrder(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    brokerOrderId: "paper-open-1",
    idempotencyKey: "candidate-1",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "ACCEPTED",
    requestedQuantity: "0.0005",
    remainingQuantity: "0.0005",
    requestedPrice: "10000000",
    acceptedAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function createEvidenceStorePort(
  appendedEvidence: RiskGateDecisionEvidenceAppendInput[],
): RiskGateRuntimeEventPorts["eventStore"] {
  return {
    appendDecisionEvidence: async (input): Promise<RiskGateDecisionEvidenceReceipt> => {
      appendedEvidence.push(input);

      return {
        orderEventReceipt: {
          id: "order-event-1",
        },
        riskEventReceipts: input.riskEvents.map((_, index) => ({
          id: `risk-event-${index + 1}`,
        })),
        auditEventReceipts: input.auditEvents.map((_, index) => ({
          auditEventId: `audit-${index + 1}`,
          appendedAt: observedAt,
        })),
        ...(input.killSwitchStateTransition === undefined
          ? {}
          : {
              killSwitchEventReceipt: {
                id: "kill-switch-event-1",
              },
            }),
      };
    },
  };
}
