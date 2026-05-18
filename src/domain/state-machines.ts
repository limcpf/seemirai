import type { OrderLifecycleStatus } from "./orders.js";
import type { JsonRecord, TimestampInput } from "./types.js";

/**
 * 런타임 전체의 신규 주문 허용 상태를 표현하는 kill switch 상태다.
 */
export type KillSwitchState =
  | "NORMAL"
  | "NEW_ORDERS_BLOCKED"
  | "STRATEGY_PAUSED"
  | "HARD_STOP"
  | "MANUAL_REVIEW_REQUIRED";

/**
 * append-only event log에 남길 상태 전이 이벤트의 업무 종류다.
 */
export type StateTransitionEventKind = "ORDER_STATE_TRANSITION" | "KILL_SWITCH_STATE_TRANSITION";

/**
 * 상태 전이를 저장소에 append하기 전 domain layer가 만드는 canonical event 후보 payload다.
 */
export interface StateTransitionEventCandidate<State extends string> {
  eventKind: StateTransitionEventKind;
  fromState: State;
  toState: State;
  accepted: boolean;
  reasonCode: string;
  message: string;
  occurredAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 상태 전이 요청을 허용할지 거부할지와, 그 판단을 audit/order event로 남기기 위한 결과다.
 */
export type StateTransitionDecision<State extends string> =
  | {
      accepted: true;
      fromState: State;
      toState: State;
      reasonCode: string;
      message: string;
      event: StateTransitionEventCandidate<State>;
    }
  | {
      accepted: false;
      fromState: State;
      toState: State;
      reasonCode: string;
      message: string;
      event: StateTransitionEventCandidate<State>;
    };

/**
 * 상태 전이 평가에 필요한 최소 입력이다.
 */
export interface StateTransitionInput<State extends string> {
  fromState: State;
  toState: State;
  occurredAt: TimestampInput;
  reasonCode?: string;
  message?: string;
  metadata?: JsonRecord;
}

/**
 * kill switch 상태가 runtime에 요구하는 후속 조치 계획이다.
 */
export interface KillSwitchActionPlan {
  newOrdersBlocked: boolean;
  strategyEvaluationBlocked: boolean;
  cancelPendingPaperOrders: boolean;
  autoLiquidateOpenPositions: false;
  requiresManualReview: boolean;
}

/**
 * 주문 상태 machine의 허용 전이를 정의한다.
 */
// 주문은 RiskGate 승인 없이 SUBMITTED로 건너뛰지 못하게 닫힌 전이표로 관리한다.
const allowedOrderTransitions: Readonly<Record<OrderLifecycleStatus, readonly OrderLifecycleStatus[]>> = {
  CREATED: ["VALIDATED", "REJECTED", "FAILED", "MANUAL_REVIEW_REQUIRED"],
  VALIDATED: ["RISK_APPROVED", "RISK_REJECTED", "FAILED", "MANUAL_REVIEW_REQUIRED"],
  RISK_APPROVED: ["SUBMITTED", "FAILED", "MANUAL_REVIEW_REQUIRED"],
  RISK_REJECTED: ["MANUAL_REVIEW_REQUIRED"],
  SUBMITTED: ["ACCEPTED", "REJECTED", "FAILED", "CANCEL_REQUESTED", "MANUAL_REVIEW_REQUIRED"],
  ACCEPTED: [
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "EXPIRED",
    "FAILED",
    "MANUAL_REVIEW_REQUIRED",
  ],
  PARTIALLY_FILLED: [
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "EXPIRED",
    "FAILED",
    "MANUAL_REVIEW_REQUIRED",
  ],
  FILLED: [],
  CANCEL_REQUESTED: ["CANCELED", "FAILED", "MANUAL_REVIEW_REQUIRED"],
  CANCELED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
  MANUAL_REVIEW_REQUIRED: [],
};

/**
 * kill switch 상태 machine의 허용 전이를 정의한다.
 */
// HARD_STOP은 직접 NORMAL로 복구하지 않고 반드시 사람 검토 상태를 거치게 한다.
const allowedKillSwitchTransitions: Readonly<Record<KillSwitchState, readonly KillSwitchState[]>> = {
  NORMAL: ["NEW_ORDERS_BLOCKED", "STRATEGY_PAUSED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  NEW_ORDERS_BLOCKED: ["NORMAL", "STRATEGY_PAUSED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  STRATEGY_PAUSED: ["NORMAL", "NEW_ORDERS_BLOCKED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  HARD_STOP: ["MANUAL_REVIEW_REQUIRED"],
  MANUAL_REVIEW_REQUIRED: ["NORMAL", "NEW_ORDERS_BLOCKED", "STRATEGY_PAUSED", "HARD_STOP"],
};

/**
 * kill switch 상태별 runtime 차단과 복구 action plan을 정의한다.
 */
// HARD_STOP은 pending paper order 취소 계획만 만들고 open position 자동 청산은 금지한다.
const killSwitchActionPlans: Readonly<Record<KillSwitchState, KillSwitchActionPlan>> = {
  NORMAL: {
    newOrdersBlocked: false,
    strategyEvaluationBlocked: false,
    cancelPendingPaperOrders: false,
    autoLiquidateOpenPositions: false,
    requiresManualReview: false,
  },
  NEW_ORDERS_BLOCKED: {
    newOrdersBlocked: true,
    strategyEvaluationBlocked: false,
    cancelPendingPaperOrders: false,
    autoLiquidateOpenPositions: false,
    requiresManualReview: false,
  },
  STRATEGY_PAUSED: {
    newOrdersBlocked: true,
    strategyEvaluationBlocked: true,
    cancelPendingPaperOrders: false,
    autoLiquidateOpenPositions: false,
    requiresManualReview: false,
  },
  HARD_STOP: {
    newOrdersBlocked: true,
    strategyEvaluationBlocked: true,
    cancelPendingPaperOrders: true,
    autoLiquidateOpenPositions: false,
    requiresManualReview: true,
  },
  MANUAL_REVIEW_REQUIRED: {
    newOrdersBlocked: true,
    strategyEvaluationBlocked: true,
    cancelPendingPaperOrders: false,
    autoLiquidateOpenPositions: false,
    requiresManualReview: true,
  },
};

/**
 * 주문 상태 전이가 현재 state machine에서 허용되는지 확인한다.
 */
export function canTransitionOrderState(
  fromState: OrderLifecycleStatus,
  toState: OrderLifecycleStatus,
): boolean {
  return allowedOrderTransitions[fromState].includes(toState);
}

/**
 * 주문 상태 전이 요청을 판단하고 append-only event 후보까지 함께 만든다.
 */
export function transitionOrderState(
  input: StateTransitionInput<OrderLifecycleStatus>,
): StateTransitionDecision<OrderLifecycleStatus> {
  return createTransitionDecision({
    ...input,
    eventKind: "ORDER_STATE_TRANSITION",
    allowed: canTransitionOrderState(input.fromState, input.toState),
    defaultAcceptedReasonCode: "order_state_transition_accepted",
    defaultRejectedReasonCode: "illegal_order_state_transition",
    defaultAcceptedMessage: `Order state transition accepted: ${input.fromState} -> ${input.toState}`,
    defaultRejectedMessage: `Illegal order state transition rejected: ${input.fromState} -> ${input.toState}`,
  });
}

/**
 * kill switch 상태 전이가 현재 state machine에서 허용되는지 확인한다.
 */
export function canTransitionKillSwitchState(
  fromState: KillSwitchState,
  toState: KillSwitchState,
): boolean {
  return allowedKillSwitchTransitions[fromState].includes(toState);
}

/**
 * kill switch 상태 전이 요청을 판단하고 append-only event 후보까지 함께 만든다.
 */
export function transitionKillSwitchState(
  input: StateTransitionInput<KillSwitchState>,
): StateTransitionDecision<KillSwitchState> {
  return createTransitionDecision({
    ...input,
    eventKind: "KILL_SWITCH_STATE_TRANSITION",
    allowed: canTransitionKillSwitchState(input.fromState, input.toState),
    defaultAcceptedReasonCode: "kill_switch_state_transition_accepted",
    defaultRejectedReasonCode: "illegal_kill_switch_state_transition",
    defaultAcceptedMessage: `Kill switch state transition accepted: ${input.fromState} -> ${input.toState}`,
    defaultRejectedMessage: `Illegal kill switch state transition rejected: ${input.fromState} -> ${input.toState}`,
  });
}

/**
 * 현재 kill switch state가 runtime에 요구하는 차단/취소/검토 계획을 반환한다.
 */
export function getKillSwitchActionPlan(state: KillSwitchState): KillSwitchActionPlan {
  return killSwitchActionPlans[state];
}

interface CreateTransitionDecisionInput<State extends string> extends StateTransitionInput<State> {
  eventKind: StateTransitionEventKind;
  allowed: boolean;
  defaultAcceptedReasonCode: string;
  defaultRejectedReasonCode: string;
  defaultAcceptedMessage: string;
  defaultRejectedMessage: string;
}

/**
 * 주문과 kill switch에 공통으로 쓰는 상태 전이 판단기다.
 */
function createTransitionDecision<State extends string>(
  input: CreateTransitionDecisionInput<State>,
): StateTransitionDecision<State> {
  const accepted = input.allowed;
  // 호출자가 업무 사유를 넘기면 기본 state machine 사유보다 우선한다.
  const reasonCode =
    input.reasonCode ??
    (accepted ? input.defaultAcceptedReasonCode : input.defaultRejectedReasonCode);
  const message =
    input.message ?? (accepted ? input.defaultAcceptedMessage : input.defaultRejectedMessage);
  const eventInput: StateTransitionEventCandidate<State> = {
    eventKind: input.eventKind,
    fromState: input.fromState,
    toState: input.toState,
    accepted,
    reasonCode,
    message,
    occurredAt: input.occurredAt,
  };
  // exact optional property 규칙을 지키기 위해 metadata가 있을 때만 event에 싣는다.
  const event =
    input.metadata === undefined
      ? eventInput
      : createTransitionEvent({
          ...eventInput,
          metadata: input.metadata,
        });

  // 허용 전이와 거부 전이는 같은 event shape을 공유하되 discriminated union으로 구분한다.
  if (accepted) {
    return {
      accepted: true,
      fromState: input.fromState,
      toState: input.toState,
      reasonCode,
      message,
      event,
    };
  }

  return {
    accepted: false,
    fromState: input.fromState,
    toState: input.toState,
    reasonCode,
    message,
    event,
  };
}

/**
 * undefined optional field를 제거한 상태 전이 event 후보를 만든다.
 */
function createTransitionEvent<State extends string>(
  input: StateTransitionEventCandidate<State>,
): StateTransitionEventCandidate<State> {
  if (input.metadata === undefined) {
    return {
      eventKind: input.eventKind,
      fromState: input.fromState,
      toState: input.toState,
      accepted: input.accepted,
      reasonCode: input.reasonCode,
      message: input.message,
      occurredAt: input.occurredAt,
    };
  }

  return input;
}
