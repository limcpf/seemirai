import {
  getKillSwitchActionPlan,
  transitionKillSwitchState,
  transitionOrderState,
} from "../../../domain/index.js";
import type {
  KillSwitchActionPlan,
  KillSwitchState,
  OrderLifecycleStatus,
  RiskBlockAction,
  RiskEventSeverity,
  RiskGateEvaluation,
  RiskGateResult,
  StateTransitionDecision,
} from "../../../domain/index.js";
import { createRiskGateDecisionMetadata, toOrderIntentPayload } from "./payload-mapper.js";
import type { RiskGateRuntimeDecisionInput } from "./types.js";

/**
 * 현재 kill switch 상태가 신규 주문을 막는지 RiskGate fail-closed evaluation으로 변환한다.
 *
 * RiskGate evaluator가 주문 자체를 승인해도 runtime 전역 상태가 차단 상태이면 같은 evidence 묶음 안에서 주문 승인을 막는다.
 */
export function createCurrentKillSwitchBlockingEvaluation(
  input: RiskGateRuntimeDecisionInput,
): RiskGateEvaluation | undefined {
  const actionPlan = getKillSwitchActionPlan(input.currentKillSwitchState);

  if (!actionPlan.newOrdersBlocked && !actionPlan.requiresManualReview) {
    return undefined;
  }

  const action = toCurrentKillSwitchRiskAction(input.currentKillSwitchState, actionPlan);

  return {
    status: "FAIL",
    reasonCode: "current_kill_switch_blocks_new_order",
    message: `Current kill switch state blocks new order approval: ${input.currentKillSwitchState}`,
    severity: toCurrentKillSwitchRiskSeverity(action),
    action,
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      kill_switch_state: input.currentKillSwitchState,
      action_plan: actionPlan,
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };
}

/**
 * 여러 RiskGate action 중 가장 강한 차단 action을 선택한다.
 *
 * 호출자는 최소 한 개 이상의 action을 넘겨야 하며, 같은 evidence 묶음 안의 fail-closed 평가가 기존 RiskGate 결과보다
 * 약하게 반영되지 않도록 우선순위만 계산하고 side effect는 만들지 않는다.
 */
export function selectDominantRiskAction(actions: readonly RiskBlockAction[]): RiskBlockAction {
  return actions.reduce((selected, action) =>
    riskActionPriority[action] > riskActionPriority[selected] ? action : selected,
  );
}

/**
 * RiskGate 결과를 주문 state machine transition으로 변환한다.
 *
 * transitionOrderState가 거부하면 호출자는 별도 fail-closed evaluation으로 승격해야 하며, 이 함수는 DB write를 수행하지 않는다.
 */
export function createRiskOrderStateTransition(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): StateTransitionDecision<OrderLifecycleStatus> {
  const toState: OrderLifecycleStatus = result.approved ? "RISK_APPROVED" : "RISK_REJECTED";

  return transitionOrderState({
    fromState: input.orderStatus,
    toState,
    occurredAt: input.riskGateContext.observedAt,
    reasonCode: result.approved ? "risk_gate_order_approved" : "risk_gate_order_rejected",
    message: result.approved
      ? "RiskGate approved order candidate"
      : "RiskGate rejected order candidate",
    metadata: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
  });
}

/**
 * RiskGate dominant action을 전역 kill switch transition으로 변환한다.
 *
 * 현재 상태보다 약한 상태로 낮추지는 않으며, 실제 transition append는 event store port에서 한 번에 처리된다.
 */
export function createKillSwitchTransition(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): StateTransitionDecision<KillSwitchState> | undefined {
  const targetState = selectTargetKillSwitchState(input.currentKillSwitchState, result.action);

  if (targetState === input.currentKillSwitchState) {
    return undefined;
  }

  return transitionKillSwitchState({
    fromState: input.currentKillSwitchState,
    toState: targetState,
    occurredAt: input.riskGateContext.observedAt,
    reasonCode: `risk_gate_${result.action.toLowerCase()}`,
    message: `RiskGate action moves kill switch to ${targetState}`,
    metadata: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
  });
}

function toCurrentKillSwitchRiskAction(
  state: KillSwitchState,
  actionPlan: KillSwitchActionPlan,
): RiskBlockAction {
  if (state === "HARD_STOP") {
    return "HARD_STOP";
  }
  if (state === "MANUAL_REVIEW_REQUIRED" || actionPlan.requiresManualReview) {
    return "MANUAL_REVIEW_REQUIRED";
  }
  if (state === "STRATEGY_PAUSED") {
    return "PAUSE_STRATEGY";
  }

  return "BLOCK_NEW_ORDER";
}

function toCurrentKillSwitchRiskSeverity(action: RiskBlockAction): RiskEventSeverity {
  return action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "BLOCKING";
}

const riskActionPriority: Readonly<Record<RiskBlockAction, number>> = {
  ALLOW: 0,
  PAUSE_STRATEGY: 1,
  BLOCK_NEW_ORDER: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};

function selectTargetKillSwitchState(
  currentState: KillSwitchState,
  action: RiskBlockAction,
): KillSwitchState {
  const targetState = killSwitchStateByAction[action];

  // 이미 더 강한 차단 상태라면 RiskGate 경고나 약한 차단으로 상태를 낮추지 않는다.
  return killSwitchStatePriority[targetState] > killSwitchStatePriority[currentState]
    ? targetState
    : currentState;
}

const killSwitchStateByAction: Readonly<Record<RiskBlockAction, KillSwitchState>> = {
  ALLOW: "NORMAL",
  BLOCK_NEW_ORDER: "NEW_ORDERS_BLOCKED",
  PAUSE_STRATEGY: "NORMAL",
  HARD_STOP: "HARD_STOP",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
};

const killSwitchStatePriority: Readonly<Record<KillSwitchState, number>> = {
  NORMAL: 0,
  STRATEGY_PAUSED: 1,
  NEW_ORDERS_BLOCKED: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};
