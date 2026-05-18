import { describe, expect, it } from "vitest";
import {
  canTransitionKillSwitchState,
  canTransitionOrderState,
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
  getKillSwitchActionPlan,
  transitionKillSwitchState,
  transitionOrderState,
} from "../../src/domain/index.js";

const occurredAt = "2026-05-19T00:00:00.000Z";

describe("M5 order state machine foundation", () => {
  it("accepts explicit order lifecycle transitions and emits event candidates", () => {
    const decision = transitionOrderState({
      fromState: "CREATED",
      toState: "VALIDATED",
      occurredAt,
      metadata: {
        order_id: "order-1",
      },
    });

    expect(decision).toMatchObject({
      accepted: true,
      reasonCode: "order_state_transition_accepted",
      event: {
        eventKind: "ORDER_STATE_TRANSITION",
        fromState: "CREATED",
        toState: "VALIDATED",
        accepted: true,
        occurredAt,
        metadata: {
          order_id: "order-1",
        },
      },
    });
    expect(canTransitionOrderState("VALIDATED", "RISK_APPROVED")).toBe(true);
  });

  it("rejects illegal order lifecycle transitions with an audit-ready event candidate", () => {
    const decision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "SUBMITTED",
      occurredAt,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reasonCode: "illegal_order_state_transition",
      event: {
        eventKind: "ORDER_STATE_TRANSITION",
        accepted: false,
        fromState: "VALIDATED",
        toState: "SUBMITTED",
      },
    });
    expect(canTransitionOrderState("RISK_REJECTED", "SUBMITTED")).toBe(false);
    expect(canTransitionOrderState("FILLED", "CANCEL_REQUESTED")).toBe(false);
  });
});

describe("M5 kill switch state machine foundation", () => {
  it("blocks new orders for stale-data style transitions before hard stop", () => {
    const decision = transitionKillSwitchState({
      fromState: "NORMAL",
      toState: "NEW_ORDERS_BLOCKED",
      occurredAt,
      reasonCode: "stale_market_data",
    });

    expect(decision).toMatchObject({
      accepted: true,
      reasonCode: "stale_market_data",
      event: {
        eventKind: "KILL_SWITCH_STATE_TRANSITION",
        fromState: "NORMAL",
        toState: "NEW_ORDERS_BLOCKED",
        accepted: true,
      },
    });
    expect(getKillSwitchActionPlan("NEW_ORDERS_BLOCKED")).toEqual({
      newOrdersBlocked: true,
      strategyEvaluationBlocked: false,
      cancelPendingPaperOrders: false,
      autoLiquidateOpenPositions: false,
      requiresManualReview: false,
    });
  });

  it("keeps hard stop conservative and forbids direct recovery to normal", () => {
    expect(getKillSwitchActionPlan("HARD_STOP")).toEqual({
      newOrdersBlocked: true,
      strategyEvaluationBlocked: true,
      cancelPendingPaperOrders: true,
      autoLiquidateOpenPositions: false,
      requiresManualReview: true,
    });
    expect(canTransitionKillSwitchState("HARD_STOP", "NORMAL")).toBe(false);
    expect(canTransitionKillSwitchState("HARD_STOP", "MANUAL_REVIEW_REQUIRED")).toBe(true);

    const decision = transitionKillSwitchState({
      fromState: "HARD_STOP",
      toState: "NORMAL",
      occurredAt,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reasonCode: "illegal_kill_switch_state_transition",
    });
  });
});

describe("M5 risk threshold foundation", () => {
  it("captures the decided MVP risk limits as a reusable threshold snapshot", () => {
    const snapshot = createRiskThresholdSnapshot(defaultRiskLimitThresholds, occurredAt);

    expect(snapshot).toEqual({
      thresholds: {
        dailyLossLimitBps: "100",
        weeklyLossLimitBps: "300",
        maxDrawdownBps: "500",
        maxOrderNotionalBpsOfEquity: "100",
        maxExpectedLossBpsOfEquity: "20",
        btcEthMaxPositionBpsOfEquity: "2000",
        altMaxPositionBpsOfEquity: "500",
        totalAltMaxPositionBpsOfEquity: "1500",
        maxConsecutiveStrategyLosses: 3,
      },
      capturedAt: occurredAt,
      source: "runtime.risk.thresholds",
    });
  });
});
