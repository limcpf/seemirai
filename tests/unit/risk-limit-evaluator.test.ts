import { describe, expect, it } from "vitest";
import { evaluateRiskGate } from "../../src/application/index.js";
import {
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  type InfrastructureRiskSnapshot,
  type PositionRiskSnapshot,
  type RiskGateContext,
} from "../../src/domain/index.js";

const observedAt = "2026-05-19T02:00:00.000Z";
const thresholdSnapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, observedAt);

describe("M5 risk limit evaluator", () => {
  it("approves a candidate when loss, exposure, strategy, and infrastructure limits are clear", () => {
    const result = evaluateRiskGate(createRiskContext());

    expect(result).toMatchObject({
      status: "PASS",
      approved: true,
      action: "ALLOW",
      thresholdSnapshot,
      failedEvaluations: [],
      warningEvaluations: [],
    });
    expect(result.evaluations.map((evaluation) => evaluation.reasonCode)).toEqual(
      expect.arrayContaining([
        "daily_loss_limit_clear",
        "weekly_loss_limit_clear",
        "max_drawdown_limit_clear",
        "order_notional_limit_clear",
        "expected_loss_limit_clear",
        "btc_eth_position_limit_clear",
        "consecutive_strategy_loss_limit_clear",
        "infrastructure_signals_clear",
      ]),
    );
  });

  it("blocks candidates at daily, weekly, and max drawdown loss thresholds", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        account: {
          dailyRealizedPnlBps: "-100",
          weeklyRealizedPnlBps: "-300",
          maxDrawdownBps: "500",
        },
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.action).toBe("BLOCK_NEW_ORDER");
    expect(failedReasonCodes(result)).toEqual(
      expect.arrayContaining([
        "daily_loss_limit_exceeded",
        "weekly_loss_limit_exceeded",
        "max_drawdown_limit_exceeded",
      ]),
    );
    expect(result.failedEvaluations[0]?.thresholdSnapshot).toEqual(thresholdSnapshot);
  });

  it("blocks oversized order notional and expected loss", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          requestedNotional: "12000",
          requestedQuantity: "0.0012",
        },
        expectedLossBpsOfEquity: "21",
      }),
    );

    expect(result.approved).toBe(false);
    expect(failedReasonCodes(result)).toEqual(
      expect.arrayContaining([
        "order_notional_limit_exceeded",
        "expected_loss_limit_exceeded",
      ]),
    );
  });

  it("blocks BTC/ETH, single alt, and total alt exposure breaches", () => {
    const btcResult = evaluateRiskGate(
      createRiskContext({
        positions: [
          createPosition({
            market: "KRW-BTC",
            notionalBpsOfEquity: "1995",
          }),
        ],
      }),
    );
    const singleAltResult = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          market: "KRW-XRP",
        },
        positions: [
          createPosition({
            market: "KRW-XRP",
            notionalBpsOfEquity: "495",
          }),
        ],
      }),
    );
    const totalAltResult = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          market: "KRW-XRP",
        },
        positions: [
          createPosition({
            market: "KRW-SOL",
            notionalBpsOfEquity: "900",
          }),
          createPosition({
            market: "KRW-ADA",
            notionalBpsOfEquity: "595",
          }),
        ],
      }),
    );

    expect(failedReasonCodes(btcResult)).toContain("btc_eth_position_limit_exceeded");
    expect(failedReasonCodes(singleAltResult)).toContain("single_alt_position_limit_exceeded");
    expect(failedReasonCodes(totalAltResult)).toContain("total_alt_position_limit_exceeded");
  });

  it("blocks a candidate when a non-target BTC/ETH position already exceeds the cap", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          market: "KRW-XRP",
        },
        positions: [
          createPosition({
            market: "KRW-BTC",
            notionalBpsOfEquity: "2001",
          }),
        ],
      }),
    );

    expect(result.approved).toBe(false);
    expect(failedReasonCodes(result)).toContain("btc_eth_position_limit_exceeded");
    expect(
      result.failedEvaluations.find((evaluation) => evaluation.reasonCode === "btc_eth_position_limit_exceeded"),
    ).toMatchObject({
      metadata: {
        breached_markets: [
          {
            market: "KRW-BTC",
            bps_of_equity: "2001",
          },
        ],
      },
    });
  });

  it("allows SELL candidates that reduce an already oversized position exposure", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          side: "SELL",
          requestedNotional: "10000",
          requestedQuantity: "0.001",
        },
        positions: [
          createPosition({
            market: "KRW-BTC",
            notionalBpsOfEquity: "2050",
          }),
        ],
      }),
    );

    expect(result.approved).toBe(true);
    expect(failedReasonCodes(result)).not.toContain("btc_eth_position_limit_exceeded");
    expect(
      result.evaluations.find((evaluation) => evaluation.reasonCode === "btc_eth_position_limit_clear"),
    ).toMatchObject({
      metadata: {
        projected_position_bps_of_equity: "1950",
      },
    });
  });

  it("caps SELL exposure reduction at the current target position for total alt checks", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          market: "KRW-XRP",
          side: "SELL",
          requestedNotional: "10000",
          requestedQuantity: "0.001",
        },
        positions: [
          createPosition({
            market: "KRW-XRP",
            notionalBpsOfEquity: "10",
          }),
          createPosition({
            market: "KRW-SOL",
            notionalBpsOfEquity: "400",
          }),
          createPosition({
            market: "KRW-ADA",
            notionalBpsOfEquity: "400",
          }),
          createPosition({
            market: "KRW-DOGE",
            notionalBpsOfEquity: "400",
          }),
          createPosition({
            market: "KRW-DOT",
            notionalBpsOfEquity: "340",
          }),
        ],
      }),
    );

    expect(result.approved).toBe(false);
    expect(failedReasonCodes(result)).toContain("total_alt_position_limit_exceeded");
    expect(
      result.failedEvaluations.find((evaluation) => evaluation.reasonCode === "total_alt_position_limit_exceeded"),
    ).toMatchObject({
      metadata: {
        projected_total_alt_position_bps_of_equity: "1540",
      },
    });
  });

  it("rejects LIMIT candidates when requested notional does not match price multiplied by quantity", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          requestedNotional: "1",
          requestedQuantity: "0.0005",
        },
      }),
    );

    expect(result.approved).toBe(false);
    expect(failedReasonCodes(result)).toContain("order_notional_mismatch");
  });

  it("pauses a strategy when consecutive losses reach the configured threshold", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        strategy: {
          consecutiveLosses: 3,
        },
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.action).toBe("PAUSE_STRATEGY");
    expect(failedReasonCodes(result)).toContain("consecutive_strategy_loss_limit_exceeded");
  });

  it("fails closed when the strategy loss snapshot belongs to another strategy", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        strategy: {
          strategyId: "other_strategy",
          consecutiveLosses: 0,
        },
      }),
    );

    expect(result.approved).toBe(false);
    expect(result.action).toBe("MANUAL_REVIEW_REQUIRED");
    expect(failedReasonCodes(result)).toContain("strategy_snapshot_mismatch");
    expect(
      result.failedEvaluations.find((evaluation) => evaluation.reasonCode === "strategy_snapshot_mismatch"),
    ).toMatchObject({
      metadata: {
        order_strategy_id: "trend_following",
        snapshot_strategy_id: "other_strategy",
      },
    });
  });

  it("chooses an account-wide new-order block over a strategy-only pause", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        account: {
          dailyRealizedPnlBps: "-100",
        },
        strategy: {
          consecutiveLosses: 3,
        },
      }),
    );

    expect(result.action).toBe("BLOCK_NEW_ORDER");
    expect(failedReasonCodes(result)).toEqual(
      expect.arrayContaining([
        "daily_loss_limit_exceeded",
        "consecutive_strategy_loss_limit_exceeded",
      ]),
    );
  });

  it("maps infrastructure signals to new-order block, hard stop, manual review, and audit-only warn", () => {
    const staleResult = evaluateRiskGate(
      createRiskContext({
        infrastructureSignals: [createInfrastructureSignal("STALE_MARKET_DATA")],
      }),
    );
    const hardStopResult = evaluateRiskGate(
      createRiskContext({
        infrastructureSignals: [
          createInfrastructureSignal("DB_WRITE_FAILURE"),
          createInfrastructureSignal("DUPLICATE_ORDER_IDEMPOTENCY_KEY"),
        ],
      }),
    );
    const manualReviewResult = evaluateRiskGate(
      createRiskContext({
        infrastructureSignals: [createInfrastructureSignal("BALANCE_POSITION_MISMATCH")],
      }),
    );
    const notificationResult = evaluateRiskGate(
      createRiskContext({
        infrastructureSignals: [createInfrastructureSignal("NOTIFICATION_FAILURE")],
      }),
    );

    expect(staleResult.action).toBe("BLOCK_NEW_ORDER");
    expect(failedReasonCodes(staleResult)).toContain("stale_market_data");
    expect(hardStopResult.action).toBe("HARD_STOP");
    expect(failedReasonCodes(hardStopResult)).toEqual(
      expect.arrayContaining(["db_write_failure", "duplicate_order_idempotency_key"]),
    );
    expect(manualReviewResult.action).toBe("MANUAL_REVIEW_REQUIRED");
    expect(failedReasonCodes(manualReviewResult)).toContain("balance_position_mismatch");
    expect(notificationResult).toMatchObject({
      status: "WARN",
      approved: true,
      action: "ALLOW",
    });
    expect(notificationResult.warningEvaluations.map((evaluation) => evaluation.reasonCode)).toContain(
      "notification_failure",
    );
  });

  it("does not approve a candidate when expected loss input is missing", () => {
    const result = evaluateRiskGate(
      createRiskContext({
        orderIntent: {
          metadata: {},
        },
      }),
    );

    expect(result.approved).toBe(false);
    expect(failedReasonCodes(result)).toContain("expected_loss_missing");
  });
});

function failedReasonCodes(result: ReturnType<typeof evaluateRiskGate>): string[] {
  return result.failedEvaluations.map((evaluation) => evaluation.reasonCode);
}

function createRiskContext(
  overrides: {
    account?: Partial<RiskGateContext["account"]>;
    orderIntent?: Partial<Extract<RiskGateContext["orderIntent"], { orderType: "LIMIT" }>>;
    positions?: readonly PositionRiskSnapshot[];
    strategy?: Partial<RiskGateContext["strategy"]>;
    infrastructureSignals?: readonly InfrastructureRiskSnapshot[];
    expectedLossBpsOfEquity?: RiskGateContext["expectedLossBpsOfEquity"];
  } = {},
): RiskGateContext {
  const orderIntent: Extract<RiskGateContext["orderIntent"], { orderType: "LIMIT" }> = {
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
    ...overrides.orderIntent,
  };

  const context: RiskGateContext = {
    orderIntent,
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

  if (overrides.expectedLossBpsOfEquity !== undefined) {
    context.expectedLossBpsOfEquity = overrides.expectedLossBpsOfEquity;
  }

  return context;
}

function createPosition(overrides: Partial<PositionRiskSnapshot> = {}): PositionRiskSnapshot {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    notionalKrw: "100000",
    notionalBpsOfEquity: "1000",
    unrealizedPnlBps: "0",
    capturedAt: observedAt,
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
