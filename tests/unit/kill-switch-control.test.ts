import { describe, expect, it } from "vitest";
import {
  createHardStopPendingPaperOrderCancelJobPlan,
  createKillSwitchControlDecision,
  createKillSwitchControlConflictResult,
  hardStopPendingPaperOrderCancelJobType,
  mapKillSwitchReasonToTargetState,
} from "../../src/application/index.js";

describe("kill switch control decision", () => {
  it("maps P0/P1 operational reasons to kill switch target states", () => {
    expect(mapKillSwitchReasonToTargetState("db_write_failure")).toBe("HARD_STOP");
    expect(mapKillSwitchReasonToTargetState("DB_WRITE_FAILURE")).toBe("HARD_STOP");
    expect(mapKillSwitchReasonToTargetState("live_order_api_misuse_detected")).toBe("HARD_STOP");
    expect(mapKillSwitchReasonToTargetState("stale_market_data")).toBe("NEW_ORDERS_BLOCKED");
    expect(mapKillSwitchReasonToTargetState("quote_freshness_insufficient")).toBe("NEW_ORDERS_BLOCKED");
    expect(mapKillSwitchReasonToTargetState("live_reconcile_mismatch")).toBe("NEW_ORDERS_BLOCKED");
    expect(mapKillSwitchReasonToTargetState("LIVE_RECONCILE_MISMATCH")).toBe("NEW_ORDERS_BLOCKED");
    expect(mapKillSwitchReasonToTargetState("live_reconcile_identity_conflict")).toBe(
      "MANUAL_REVIEW_REQUIRED",
    );
    expect(mapKillSwitchReasonToTargetState("notification_consecutive_failure")).toBe(
      "MANUAL_REVIEW_REQUIRED",
    );
    expect(mapKillSwitchReasonToTargetState("operator_recovered")).toBeUndefined();
    expect(mapKillSwitchReasonToTargetState("constructor")).toBeUndefined();
  });

  it("canonicalizes reason codes before creating durable evidence", () => {
    const decision = createKillSwitchControlDecision({
      currentState: "NORMAL",
      targetState: "HARD_STOP",
      reasonCode: "DB_WRITE_FAILURE",
      correlationId: "corr-canonical",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    expect(decision.transition).toMatchObject({
      accepted: true,
      reasonCode: "db_write_failure",
    });
    expect(decision.transition.event.metadata).toMatchObject({
      requested_reason_code: "db_write_failure",
    });
  });

  it("rejects direct HARD_STOP to NORMAL recovery through the state machine", () => {
    const decision = createKillSwitchControlDecision({
      currentState: "HARD_STOP",
      targetState: "NORMAL",
      reasonCode: "operator_recovered",
      correlationId: "corr-hard-stop-normal",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    expect(decision.transition).toMatchObject({
      accepted: false,
      fromState: "HARD_STOP",
      toState: "NORMAL",
      reasonCode: "illegal_kill_switch_state_transition",
    });
    expect(decision.actionPlan).toMatchObject({
      newOrdersBlocked: true,
      cancelPendingPaperOrders: true,
      requiresManualReview: true,
    });
  });

  it("rejects requests whose known reason maps to a different target state", () => {
    const decision = createKillSwitchControlDecision({
      currentState: "NORMAL",
      targetState: "NORMAL",
      reasonCode: "db_write_failure",
      correlationId: "corr-mismatch",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    expect(decision.transition).toMatchObject({
      accepted: false,
      reasonCode: "kill_switch_reason_target_mismatch",
      message: "Kill switch reason db_write_failure maps to HARD_STOP, not NORMAL",
    });
    expect(decision.reasonMatchesTarget).toBe(false);
    expect(decision.recommendedTargetState).toBe("HARD_STOP");
  });

  it("converts stale durable updates to conflict results that preserve observed state", () => {
    const attempted = createKillSwitchControlDecision({
      currentState: "NORMAL",
      targetState: "HARD_STOP",
      reasonCode: "db_write_failure",
      correlationId: "corr-conflict",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    const conflict = createKillSwitchControlConflictResult({
      attemptedResult: attempted,
      observedState: "NEW_ORDERS_BLOCKED",
      occurredAt: "2026-05-21T00:00:01.000Z",
    });

    expect(conflict.transition).toMatchObject({
      accepted: false,
      reasonCode: "kill_switch_state_conflict",
      fromState: "NORMAL",
      toState: "HARD_STOP",
    });
    expect(conflict.actionPlan).toMatchObject({
      newOrdersBlocked: true,
      cancelPendingPaperOrders: false,
    });
    expect(conflict.transition.event.metadata).toMatchObject({
      conflict: true,
      observed_state: "NEW_ORDERS_BLOCKED",
      requested_reason_code: "db_write_failure",
    });
  });

  it("creates a HARD_STOP pending paper order cancel job boundary without liquidation", () => {
    const decision = createKillSwitchControlDecision({
      currentState: "NORMAL",
      targetState: "HARD_STOP",
      reasonCode: "db_write_failure",
      correlationId: "corr-hard-stop",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });
    const jobPlan = createHardStopPendingPaperOrderCancelJobPlan({
      transition: decision.transition,
      actionPlan: decision.actionPlan,
      reasonCode: "db_write_failure",
      correlationId: "corr-hard-stop",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    expect(jobPlan).toMatchObject({
      jobType: hardStopPendingPaperOrderCancelJobType,
      idempotencyKey: `${hardStopPendingPaperOrderCancelJobType}:NORMAL:HARD_STOP:2026-05-21T00:00:00.000Z:corr-hard-stop`,
      maxAttempts: 3,
      payloadJson: {
        reason_code: "db_write_failure",
        from_state: "NORMAL",
        to_state: "HARD_STOP",
        action_plan: {
          cancel_pending_paper_orders: true,
          auto_liquidate_open_positions: false,
          requires_manual_review: true,
        },
      },
    });
  });
});
