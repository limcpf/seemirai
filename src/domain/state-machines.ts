import type { OrderLifecycleStatus } from "./orders.js";
import type { JsonRecord, TimestampInput } from "./types.js";

export type KillSwitchState =
  | "NORMAL"
  | "NEW_ORDERS_BLOCKED"
  | "STRATEGY_PAUSED"
  | "HARD_STOP"
  | "MANUAL_REVIEW_REQUIRED";

export type StateTransitionEventKind = "ORDER_STATE_TRANSITION" | "KILL_SWITCH_STATE_TRANSITION";

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

export interface StateTransitionInput<State extends string> {
  fromState: State;
  toState: State;
  occurredAt: TimestampInput;
  reasonCode?: string;
  message?: string;
  metadata?: JsonRecord;
}

export interface KillSwitchActionPlan {
  newOrdersBlocked: boolean;
  strategyEvaluationBlocked: boolean;
  cancelPendingPaperOrders: boolean;
  autoLiquidateOpenPositions: false;
  requiresManualReview: boolean;
}

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

const allowedKillSwitchTransitions: Readonly<Record<KillSwitchState, readonly KillSwitchState[]>> = {
  NORMAL: ["NEW_ORDERS_BLOCKED", "STRATEGY_PAUSED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  NEW_ORDERS_BLOCKED: ["NORMAL", "STRATEGY_PAUSED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  STRATEGY_PAUSED: ["NORMAL", "NEW_ORDERS_BLOCKED", "HARD_STOP", "MANUAL_REVIEW_REQUIRED"],
  HARD_STOP: ["MANUAL_REVIEW_REQUIRED"],
  MANUAL_REVIEW_REQUIRED: ["NORMAL", "NEW_ORDERS_BLOCKED", "STRATEGY_PAUSED", "HARD_STOP"],
};

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

export function canTransitionOrderState(
  fromState: OrderLifecycleStatus,
  toState: OrderLifecycleStatus,
): boolean {
  return allowedOrderTransitions[fromState].includes(toState);
}

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

export function canTransitionKillSwitchState(
  fromState: KillSwitchState,
  toState: KillSwitchState,
): boolean {
  return allowedKillSwitchTransitions[fromState].includes(toState);
}

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

function createTransitionDecision<State extends string>(
  input: CreateTransitionDecisionInput<State>,
): StateTransitionDecision<State> {
  const accepted = input.allowed;
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
  const event =
    input.metadata === undefined
      ? eventInput
      : createTransitionEvent({
          ...eventInput,
          metadata: input.metadata,
        });

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
