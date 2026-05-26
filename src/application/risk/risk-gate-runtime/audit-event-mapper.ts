import type { AuditEvent } from "../../ports/index.js";
import type {
  KillSwitchState,
  RiskBlockAction,
  RiskGateContext,
  RiskGateResult,
  StateTransitionEventCandidate,
} from "../../../domain/index.js";
import {
  assignIfDefined,
  createRiskGateDecisionMetadata,
  toOrderIntentPayload,
  toStateTransitionPayload,
} from "./payload-mapper.js";
import type {
  CreateRiskGateAuditEventsInput,
  HardStopRuntimeActionPlan,
  StrategyPauseRuntimeActionPlan,
} from "./types.js";
import type { StateTransitionDecision } from "../../../domain/index.js";

/**
 * RiskGate runtime plan을 audit event 배열로 변환한다.
 *
 * order state transition은 항상 남기고, rejection/kill switch/action plan evidence는 조건부로 추가해 운영 복구 기준을
 * append-only audit log에 보존한다.
 */
export function createRiskGateAuditEvents(input: CreateRiskGateAuditEventsInput): AuditEvent[] {
  const events: AuditEvent[] = [
    createStateTransitionAuditEvent({
      input,
      event: input.orderStateTransition.event,
      auditKind: "RISK_GATE_ORDER_STATE_TRANSITION",
    }),
  ];

  if (!input.riskGateResult.approved) {
    events.push(createRiskRejectionAuditEvent(input));
  }

  if (input.killSwitchStateTransition !== undefined) {
    events.push(
      createStateTransitionAuditEvent({
        input,
        event: input.killSwitchStateTransition.event,
        auditKind: "RISK_GATE_KILL_SWITCH_STATE_TRANSITION",
      }),
    );
  }

  if (input.hardStopActionPlan !== undefined) {
    events.push(createHardStopActionPlanAuditEvent(input));
  }

  if (input.strategyPauseActionPlan !== undefined) {
    events.push(createStrategyPauseActionPlanAuditEvent(input));
  }

  return events;
}

function createStateTransitionAuditEvent<State extends string>(options: {
  input: {
    orderId: string;
    riskGateContext: RiskGateContext;
    actor: string;
    correlationId?: string;
    riskGateResult: RiskGateResult;
  };
  event: StateTransitionEventCandidate<State>;
  auditKind: string;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "STATE_TRANSITION",
    severity: options.event.accepted ? "INFO" : "WARN",
    occurredAt: options.event.occurredAt,
    actor: options.input.actor,
    reasonCode: options.event.reasonCode,
    orderId: options.input.orderId,
    strategyId: options.input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: options.auditKind,
      state_transition: toStateTransitionPayload(options.event),
      risk_gate: createRiskGateDecisionMetadata(
        options.input.riskGateResult,
        options.input.riskGateContext.strategy,
      ),
    },
  };

  assignIfDefined(event, "correlationId", options.input.correlationId);

  return event;
}

function createRiskRejectionAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  riskGateResult: RiskGateResult;
}): AuditEvent {
  const firstFailure = input.riskGateResult.failedEvaluations[0];
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: toAuditSeverity(input.riskGateResult.action),
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: firstFailure?.reasonCode ?? "risk_gate_rejected",
    orderId: input.orderId,
    strategyId: input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: "RISK_GATE_REJECTION",
      risk_gate: createRiskGateDecisionMetadata(input.riskGateResult, input.riskGateContext.strategy),
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}

function toAuditSeverity(action: RiskBlockAction): NonNullable<AuditEvent["severity"]> {
  return action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "WARN";
}

function createHardStopActionPlanAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  hardStopActionPlan?: HardStopRuntimeActionPlan;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: "CRITICAL",
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: "hard_stop_action_plan_created",
    orderId: input.orderId,
    strategyId: input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: "HARD_STOP_ACTION_PLAN",
      cancel_pending_paper_orders:
        input.hardStopActionPlan?.actionPlan.cancelPendingPaperOrders ?? false,
      auto_liquidate_open_positions:
        input.hardStopActionPlan?.actionPlan.autoLiquidateOpenPositions ?? false,
      requires_manual_review: input.hardStopActionPlan?.actionPlan.requiresManualReview ?? true,
      pending_paper_order_cancel_actions:
        input.hardStopActionPlan?.pendingPaperOrderCancelActions ?? [],
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}

function createStrategyPauseActionPlanAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  riskGateResult: RiskGateResult;
  killSwitchStateTransition?: StateTransitionDecision<KillSwitchState>;
  strategyPauseActionPlan?: StrategyPauseRuntimeActionPlan;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: "WARN",
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: "strategy_pause_action_plan_created",
    orderId: input.orderId,
    strategyId: input.riskGateContext.strategy.strategyId,
    metadata: {
      audit_kind: "STRATEGY_PAUSE_ACTION_PLAN",
      strategy_pause_action: input.strategyPauseActionPlan,
      global_new_orders_blocked: input.riskGateResult.action !== "PAUSE_STRATEGY",
      global_kill_switch_unchanged: input.killSwitchStateTransition === undefined,
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}
