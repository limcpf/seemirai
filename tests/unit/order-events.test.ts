import { describe, expect, it } from "vitest";
import {
  type AppendOrderStateTransitionEventInput,
  toOrderEventRow,
  toRiskEventRow,
  toStateTransitionAuditRow,
} from "../../src/infrastructure/index.js";
import { transitionKillSwitchState, transitionOrderState } from "../../src/domain/index.js";

const occurredAt = "2026-05-19T01:00:00.000Z";

describe("state transition persistence mappers", () => {
  it("maps order state transitions to canonical order_events rows", () => {
    const decision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "RISK_APPROVED",
      occurredAt,
      metadata: {
        risk_gate_result_id: "risk-result-1",
      },
    });

    const row = toOrderEventRow({
      orderId: "00000000-0000-4000-8000-000000000001",
      correlationId: "candidate-1",
      event: decision.event,
    });

    expect(row).toEqual({
      order_id: "00000000-0000-4000-8000-000000000001",
      event_type: "ORDER_STATE_TRANSITION",
      from_status: "VALIDATED",
      to_status: "RISK_APPROVED",
      accepted: true,
      reason_code: "order_state_transition_accepted",
      message: "Order state transition accepted: VALIDATED -> RISK_APPROVED",
      correlation_id: "candidate-1",
      payload_json: {
        event_kind: "ORDER_STATE_TRANSITION",
        from_state: "VALIDATED",
        to_state: "RISK_APPROVED",
        accepted: true,
        reason_code: "order_state_transition_accepted",
        message: "Order state transition accepted: VALIDATED -> RISK_APPROVED",
        metadata: {
          risk_gate_result_id: "risk-result-1",
        },
      },
      occurred_at: occurredAt,
    });
  });

  it("rejects kill switch transitions for order_events and maps them to audit_events", () => {
    const decision = transitionKillSwitchState({
      fromState: "NORMAL",
      toState: "HARD_STOP",
      occurredAt,
      reasonCode: "db_write_failure",
    });

    const invalidOrderEventInput = {
      orderId: "00000000-0000-4000-8000-000000000001",
      event: decision.event,
    } as unknown as AppendOrderStateTransitionEventInput;

    expect(() => toOrderEventRow(invalidOrderEventInput)).toThrow(
      "order_events only accepts ORDER_STATE_TRANSITION events",
    );

    expect(
      toStateTransitionAuditRow({
        event: decision.event,
        actor: "risk-gate",
        correlationId: "kill-switch-1",
      }),
    ).toMatchObject({
      event_type: "STATE_TRANSITION",
      severity: "INFO",
      order_id: null,
      correlation_id: "kill-switch-1",
      payload_json: {
        actor: "risk-gate",
        event_kind: "KILL_SWITCH_STATE_TRANSITION",
        reason_code: "db_write_failure",
      },
    });
  });

  it("maps risk event input to append-only risk_events rows", () => {
    expect(
      toRiskEventRow({
        riskType: "duplicate_order_idempotency_key",
        severity: "CRITICAL",
        action: "HARD_STOP",
        orderId: "00000000-0000-4000-8000-000000000001",
        occurredAt,
        payloadJson: {
          idempotency_key: "candidate-1",
        },
      }),
    ).toMatchObject({
      risk_type: "duplicate_order_idempotency_key",
      severity: "CRITICAL",
      order_id: "00000000-0000-4000-8000-000000000001",
      action: "HARD_STOP",
      payload_json: {
        risk_type: "duplicate_order_idempotency_key",
        action: "HARD_STOP",
        idempotency_key: "candidate-1",
      },
      occurred_at: occurredAt,
    });
  });
});
