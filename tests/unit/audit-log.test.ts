import { describe, expect, it } from "vitest";
import {
  appendOrderCandidateDiscardAudit,
  isOrderCandidateDiscarded,
  toOrderCandidateDiscardAuditEvent,
} from "../../src/application/index.js";
import { toAuditEventRow } from "../../src/infrastructure/index.js";
import type {
  AuditEvent,
  AuditLogPort,
  OrderCandidateDiscardAuditInput,
  RuleEngineResult,
  StrategyDecisionIntentConversion,
} from "../../src/application/index.js";
import type { CostDecision, OrderIntent, StrategyDecision } from "../../src/domain/index.js";

const occurredAt = "2026-05-18T12:00:00.000Z";

describe("order candidate discard audit", () => {
  it("creates an ORDER_DECISION audit event with strategy, cost, rule, and conversion evidence", () => {
    const event = toOrderCandidateDiscardAuditEvent(discardAuditInput());

    expect(event).toMatchObject({
      eventType: "ORDER_DECISION",
      severity: "WARN",
      occurredAt,
      actor: "strategy-worker",
      reasonCode: "spread_too_wide",
      strategyId: "trend_following",
      correlationId: "candidate-1",
    });
    expect(event.metadata).toMatchObject({
      audit_kind: "ORDER_CANDIDATE_DISCARDED",
      discard_stage: "STRATEGY_DECISION",
      exchange_id: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
      intent_conversion: {
        status: "REJECTED",
        rejection_count: 1,
      },
      cost_decision: {
        reason_code: "cost_margin_insufficient",
        snapshot: {
          margin_bps: "-3",
        },
      },
      rule_result: {
        status: "FAIL",
        failed_evaluations: [
          {
            reasonCode: "spread_too_wide",
          },
        ],
      },
      order_intent: {
        order_type: "LIMIT",
        requested_price: "10000000",
        post_only: true,
        time_in_force: "GTC",
      },
    });
  });

  it("appends discarded candidates through AuditLogPort and skips clean candidates", async () => {
    const appended: AuditEvent[] = [];
    const auditLog: AuditLogPort = {
      appendEvent: async (event) => {
        appended.push(event);

        return {
          auditEventId: "audit-1",
          appendedAt: occurredAt,
        };
      },
    };

    await expect(appendOrderCandidateDiscardAudit(auditLog, discardAuditInput())).resolves.toEqual({
      auditEventId: "audit-1",
      appendedAt: occurredAt,
    });
    await expect(
      appendOrderCandidateDiscardAudit(auditLog, cleanAuditInput()),
    ).resolves.toBeUndefined();

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      reasonCode: "spread_too_wide",
    });
    expect(isOrderCandidateDiscarded(cleanAuditInput())).toBe(false);
  });

  it("records non-passing WARN rule results with the warning reason code", () => {
    const event = toOrderCandidateDiscardAuditEvent({
      ...cleanAuditInput(),
      ruleResult: warningRuleResult(),
    });

    expect(event).toMatchObject({
      reasonCode: "risk_ok_placeholder",
      metadata: {
        discard_stage: "RULE_ENGINE",
        rule_result: {
          status: "WARN",
          passed: false,
          warning_evaluations: [
            {
              reasonCode: "risk_ok_placeholder",
            },
          ],
        },
      },
    });
    expect(isOrderCandidateDiscarded({ ...cleanAuditInput(), ruleResult: warningRuleResult() })).toBe(true);
  });

  it("uses the original strategy decision intent when rejected conversion has no promoted intents", () => {
    const event = toOrderCandidateDiscardAuditEvent({
      occurredAt,
      actor: "strategy-worker",
      strategyDecision: {
        kind: "ORDER_INTENT",
        strategyId: "trend_following",
        reason: "fixture_signal",
        orderIntents: [limitIntent()],
      },
      intentConversion: rejectedIntentConversion(),
    });

    expect(event.metadata).toMatchObject({
      discard_stage: "INTENT_CONVERSION",
      exchange_id: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
      order_intent: {
        requested_price: "10000000",
      },
    });
  });

  it("uses the rejected original intent index when a decision has multiple candidates", () => {
    const firstIntent = limitIntent({
      market: "KRW-BTC",
      requestedPrice: "10000000",
      idempotencyKey: "candidate-1",
    });
    const secondIntent = limitIntent({
      market: "KRW-ETH",
      requestedPrice: "3000000",
      idempotencyKey: "candidate-2",
    });
    const event = toOrderCandidateDiscardAuditEvent({
      occurredAt,
      actor: "strategy-worker",
      strategyDecision: {
        kind: "ORDER_INTENT",
        strategyId: "trend_following",
        reason: "fixture_signal",
        orderIntents: [firstIntent, secondIntent],
      },
      intentConversion: {
        ...rejectedIntentConversion(),
        rejections: [
          {
            index: 1,
            reasonCode: "requested_price_invalid",
            message: "LIMIT requestedPrice must be a positive decimal string",
          },
        ],
      },
    });

    expect(event.metadata).toMatchObject({
      market: "KRW-ETH",
      order_intent: {
        market: "KRW-ETH",
        requested_price: "3000000",
        idempotency_key: "candidate-2",
      },
    });
  });

  it("uses cost snapshot market when only cost rejection evidence is provided", () => {
    const event = toOrderCandidateDiscardAuditEvent({
      occurredAt,
      actor: "cost-model",
      costDecision: rejectedCostDecision({
        exchangeId: "upbit_krw_spot",
        market: "KRW-ETH",
      }),
    });

    expect(event.metadata).toMatchObject({
      discard_stage: "COST_DECISION",
      exchange_id: "upbit_krw_spot",
      market: "KRW-ETH",
      cost_decision: {
        snapshot: {
          market: "KRW-ETH",
        },
      },
    });
  });

  it("uses the intent matching the rejected cost snapshot when promoted intents contain multiple markets", () => {
    const firstIntent = limitIntent({
      market: "KRW-BTC",
      requestedPrice: "10000000",
      idempotencyKey: "candidate-1",
    });
    const secondIntent = limitIntent({
      market: "KRW-ETH",
      requestedPrice: "3000000",
      idempotencyKey: "candidate-2",
    });
    const event = toOrderCandidateDiscardAuditEvent({
      occurredAt,
      actor: "cost-model",
      intentConversion: {
        status: "PROMOTED",
        orderIntents: [firstIntent, secondIntent],
        reasonCode: "order_intent_promoted",
        message: "fixture_signal",
        rejections: [],
      },
      costDecision: rejectedCostDecision({
        exchangeId: "upbit_krw_spot",
        market: "KRW-ETH",
      }),
    });

    expect(event.metadata).toMatchObject({
      discard_stage: "COST_DECISION",
      market: "KRW-ETH",
      order_intent: {
        market: "KRW-ETH",
        requested_price: "3000000",
        idempotency_key: "candidate-2",
      },
    });
  });
});

describe("PostgreSQL audit row mapper", () => {
  it("maps AuditLogPort event fields into audit_events insert row", () => {
    const row = toAuditEventRow({
      eventType: "ORDER_DECISION",
      severity: "WARN",
      occurredAt,
      actor: "strategy-worker",
      reasonCode: "spread_too_wide",
      strategyId: "trend_following",
      correlationId: "candidate-1",
      metadata: {
        audit_kind: "ORDER_CANDIDATE_DISCARDED",
      },
    });

    expect(row).toMatchObject({
      event_type: "ORDER_DECISION",
      severity: "WARN",
      order_id: null,
      correlation_id: "candidate-1",
      occurred_at: occurredAt,
      payload_json: {
        audit_kind: "ORDER_CANDIDATE_DISCARDED",
        actor: "strategy-worker",
        reason_code: "spread_too_wide",
        strategy_id: "trend_following",
      },
    });
  });
});

function discardAuditInput(): OrderCandidateDiscardAuditInput {
  return {
    occurredAt,
    actor: "strategy-worker",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    correlationId: "candidate-1",
    strategyDecision: blockStrategyDecision(),
    intentConversion: rejectedIntentConversion(),
    costDecision: rejectedCostDecision(),
    ruleResult: failedRuleResult(),
    orderIntent: limitIntent(),
  };
}

function cleanAuditInput(): OrderCandidateDiscardAuditInput {
  return {
    occurredAt,
    actor: "strategy-worker",
    strategyDecision: {
      kind: "ORDER_INTENT",
      strategyId: "trend_following",
      reason: "fixture_signal",
      orderIntents: [limitIntent()],
    },
    intentConversion: {
      status: "PROMOTED",
      orderIntents: [limitIntent()],
      reasonCode: "order_intent_promoted",
      message: "fixture_signal",
      rejections: [],
    },
    costDecision: {
      ...rejectedCostDecision(),
      kind: "ALLOW",
      tradeAllowed: true,
      reasonCode: "cost_margin_ok",
      message: "Cost margin is sufficient",
      snapshot: {
        ...rejectedCostDecision().snapshot,
        trade_allowed: true,
        reason_code: "cost_margin_ok",
        margin_bps: "3",
      },
    },
    ruleResult: {
      status: "PASS",
      passed: true,
      evaluations: [
        {
          status: "PASS",
          reasonCode: "spread_ok",
          message: "Spread is ok",
        },
      ],
      failedEvaluations: [],
      warningEvaluations: [],
    },
    orderIntent: limitIntent(),
  };
}

function blockStrategyDecision(): StrategyDecision {
  return {
    kind: "BLOCK",
    strategyId: "trend_following",
    reason: "Spread exceeds the strategy threshold",
    reasonCode: "spread_too_wide",
    metadata: {
      spread_bps: "10",
    },
  };
}

function rejectedIntentConversion(): StrategyDecisionIntentConversion {
  return {
    status: "REJECTED",
    orderIntents: [],
    reasonCode: "order_intent_validation_failed",
    message: "Strategy order intents failed validation",
    rejections: [
      {
        index: 0,
        reasonCode: "requested_price_invalid",
        message: "LIMIT requestedPrice must be a positive decimal string",
      },
    ],
  };
}

function rejectedCostDecision(
  overrides: {
    exchangeId?: string;
    market?: string;
  } = {},
): CostDecision {
  const exchangeId = overrides.exchangeId ?? "upbit_krw_spot";
  const market = overrides.market ?? "KRW-BTC";

  return {
    kind: "REJECT",
    tradeAllowed: false,
    reasonCode: "cost_margin_insufficient",
    message: "Expected return is below required return",
    snapshot: {
      exchange_id: exchangeId,
      market,
      expected_return_bps: "10",
      cost_bps: "3",
      safety_buffer_bps: "10",
      required_return_bps: "13",
      margin_bps: "-3",
      trade_allowed: false,
      reason_code: "cost_margin_insufficient",
    },
  };
}

function failedRuleResult(): RuleEngineResult {
  return {
    status: "FAIL",
    passed: false,
    evaluations: [
      {
        status: "FAIL",
        reasonCode: "spread_too_wide",
        message: "Spread exceeds threshold",
      },
    ],
    failedEvaluations: [
      {
        status: "FAIL",
        reasonCode: "spread_too_wide",
        message: "Spread exceeds threshold",
      },
    ],
    warningEvaluations: [],
  };
}

function warningRuleResult(): RuleEngineResult {
  return {
    status: "WARN",
    passed: false,
    evaluations: [
      {
        status: "WARN",
        reasonCode: "risk_ok_placeholder",
        message: "Active RiskGate approval is not implemented until M5",
      },
    ],
    failedEvaluations: [],
    warningEvaluations: [
      {
        status: "WARN",
        reasonCode: "risk_ok_placeholder",
        message: "Active RiskGate approval is not implemented until M5",
      },
    ],
  };
}

function limitIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.001",
    requestedNotional: "10000",
    requestedPrice: "10000000",
    postOnly: true,
    timeInForce: "GTC",
    idempotencyKey: "candidate-1",
    reason: "fixture",
    ...overrides,
  } as OrderIntent;
}
