import {
  canTransitionKillSwitchState,
  getKillSwitchActionPlan,
  transitionKillSwitchState,
  type JsonRecord,
  type KillSwitchActionPlan,
  type KillSwitchState,
  type StateTransitionEventCandidate,
  type StateTransitionDecision,
  type TimestampInput,
} from "../../domain/index.js";

export const killSwitchControlTargetStates = [
  "NEW_ORDERS_BLOCKED",
  "HARD_STOP",
  "MANUAL_REVIEW_REQUIRED",
  "NORMAL",
] as const;

export type KillSwitchControlTargetState = (typeof killSwitchControlTargetStates)[number];

export const hardStopPendingPaperOrderCancelJobType = "hard_stop_pending_paper_order_cancel";

export interface KillSwitchControlRequest {
  targetState: KillSwitchControlTargetState;
  reasonCode: string;
  correlationId: string;
  actor?: string;
  message?: string;
  metadata?: JsonRecord;
  occurredAt?: TimestampInput;
}

export interface KillSwitchControlDecisionInput extends KillSwitchControlRequest {
  currentState: KillSwitchState;
}

export interface HardStopPendingPaperOrderCancelJobPlan {
  jobType: typeof hardStopPendingPaperOrderCancelJobType;
  idempotencyKey: string;
  payloadJson: JsonRecord;
  runAfter: TimestampInput;
  maxAttempts: number;
}

export interface KillSwitchControlResult {
  transition: StateTransitionDecision<KillSwitchState>;
  actionPlan: KillSwitchActionPlan;
  reasonMatchesTarget: boolean;
  recommendedTargetState?: KillSwitchControlTargetState;
  auditEventId?: string;
  riskEventId?: string;
  hardStopCancelJob?: {
    jobType: typeof hardStopPendingPaperOrderCancelJobType;
    idempotencyKey: string;
    jobId?: string;
    created: boolean;
  };
}

export interface KillSwitchControlProvider {
  apply(input: KillSwitchControlRequest): Promise<KillSwitchControlResult>;
}

/**
 * HTTP control에서 직접 받을 수 있는 kill switch target인지 확인한다.
 */
export function isKillSwitchControlTargetState(value: unknown): value is KillSwitchControlTargetState {
  return typeof value === "string" && killSwitchControlTargetStates.includes(value as KillSwitchControlTargetState);
}

/**
 * P0/P1 운영 원인 코드를 kill switch target state로 정규화한다.
 *
 * 이 함수는 HTTP 요청 검증과 자동 가드레일 후보가 같은 mapping을 공유하도록 만드는 순수 경계다.
 */
export function mapKillSwitchReasonToTargetState(
  reasonCode: string,
): KillSwitchControlTargetState | undefined {
  return killSwitchTargetStateByReasonCode[normalizeReasonCode(reasonCode)];
}

/**
 * 현재 durable state와 운영자가 요청한 target을 state machine 기준으로 판정한다.
 */
export function createKillSwitchControlDecision(
  input: KillSwitchControlDecisionInput,
): KillSwitchControlResult {
  const actor = input.actor ?? "http-control";
  const recommendedTargetState = mapKillSwitchReasonToTargetState(input.reasonCode);
  const reasonMatchesTarget =
    recommendedTargetState === undefined || recommendedTargetState === input.targetState;
  const occurredAt = input.occurredAt ?? new Date();
  const stateMachineAllowsTransition = canTransitionKillSwitchState(input.currentState, input.targetState);
  const metadata = createControlTransitionMetadata({
    actor,
    correlationId: input.correlationId,
    requestedReasonCode: input.reasonCode,
    reasonMatchesTarget,
    recommendedTargetState,
    metadata: input.metadata,
  });
  const transition = reasonMatchesTarget
    ? transitionKillSwitchState({
        fromState: input.currentState,
        toState: input.targetState,
        occurredAt,
        ...(stateMachineAllowsTransition ? { reasonCode: input.reasonCode } : {}),
        ...(stateMachineAllowsTransition
          ? {
              message:
                input.message ??
                `HTTP control requested kill switch transition: ${input.currentState} -> ${input.targetState}`,
            }
          : {}),
        metadata,
      })
    : createReasonTargetMismatchDecision({
        fromState: input.currentState,
        toState: input.targetState,
        occurredAt,
        reasonCode: input.reasonCode,
        recommendedTargetState: recommendedTargetState as KillSwitchControlTargetState,
        metadata,
      });

  const result: KillSwitchControlResult = {
    transition,
    actionPlan: getKillSwitchActionPlan(transition.accepted ? input.targetState : input.currentState),
    reasonMatchesTarget,
  };

  if (recommendedTargetState !== undefined) {
    result.recommendedTargetState = recommendedTargetState;
  }

  return result;
}

/**
 * optimistic update 경합을 운영자가 구분할 수 있는 거부 전이 결과로 변환한다.
 */
export function createKillSwitchControlConflictResult(input: {
  attemptedResult: KillSwitchControlResult;
  observedState: KillSwitchState | undefined;
  occurredAt: TimestampInput;
}): KillSwitchControlResult {
  const metadata: JsonRecord = {
    ...(input.attemptedResult.transition.event.metadata ?? {}),
    conflict: true,
  };
  if (input.observedState !== undefined) {
    metadata.observed_state = input.observedState;
  }

  const event: StateTransitionEventCandidate<KillSwitchState> = {
    eventKind: "KILL_SWITCH_STATE_TRANSITION",
    fromState: input.attemptedResult.transition.fromState,
    toState: input.attemptedResult.transition.toState,
    accepted: false,
    reasonCode: "kill_switch_state_conflict",
    message:
      input.observedState === undefined
        ? "Kill switch state changed before control transition could be committed"
        : `Kill switch state changed before control transition could be committed: observed ${input.observedState}`,
    occurredAt: input.occurredAt,
    metadata,
  };

  return {
    transition: {
      accepted: false,
      fromState: event.fromState,
      toState: event.toState,
      reasonCode: event.reasonCode,
      message: event.message,
      event,
    },
    actionPlan: getKillSwitchActionPlan(input.observedState ?? input.attemptedResult.transition.fromState),
    reasonMatchesTarget: input.attemptedResult.reasonMatchesTarget,
    ...(input.attemptedResult.recommendedTargetState === undefined
      ? {}
      : { recommendedTargetState: input.attemptedResult.recommendedTargetState }),
  };
}

/**
 * HARD_STOP 전이 후 pending paper order 취소를 비동기 job 경계로 남긴다.
 */
export function createHardStopPendingPaperOrderCancelJobPlan(input: {
  transition: StateTransitionDecision<KillSwitchState>;
  actionPlan: KillSwitchActionPlan;
  reasonCode: string;
  correlationId: string;
  occurredAt: TimestampInput;
}): HardStopPendingPaperOrderCancelJobPlan {
  const occurredAt = toIsoTimestamp(input.occurredAt);
  return {
    jobType: hardStopPendingPaperOrderCancelJobType,
    idempotencyKey: [
      hardStopPendingPaperOrderCancelJobType,
      input.transition.fromState,
      input.transition.toState,
      occurredAt,
      input.correlationId,
    ].join(":"),
    payloadJson: {
      correlation_id: input.correlationId,
      reason_code: input.reasonCode,
      from_state: input.transition.fromState,
      to_state: input.transition.toState,
      occurred_at: occurredAt,
      action_plan: {
        new_orders_blocked: input.actionPlan.newOrdersBlocked,
        strategy_evaluation_blocked: input.actionPlan.strategyEvaluationBlocked,
        cancel_pending_paper_orders: input.actionPlan.cancelPendingPaperOrders,
        auto_liquidate_open_positions: input.actionPlan.autoLiquidateOpenPositions,
        requires_manual_review: input.actionPlan.requiresManualReview,
      },
    },
    runAfter: input.occurredAt,
    maxAttempts: 3,
  };
}

function createControlTransitionMetadata(input: {
  actor: string;
  correlationId: string;
  requestedReasonCode: string;
  reasonMatchesTarget: boolean;
  recommendedTargetState: KillSwitchControlTargetState | undefined;
  metadata: JsonRecord | undefined;
}): JsonRecord {
  const metadata: JsonRecord = {
    ...(input.metadata ?? {}),
    source: "http_control",
    actor: input.actor,
    correlation_id: input.correlationId,
    requested_reason_code: input.requestedReasonCode,
    reason_matches_target: input.reasonMatchesTarget,
  };

  if (input.recommendedTargetState !== undefined) {
    metadata.recommended_target_state = input.recommendedTargetState;
  }

  return metadata;
}

function createReasonTargetMismatchDecision(input: {
  fromState: KillSwitchState;
  toState: KillSwitchControlTargetState;
  occurredAt: TimestampInput;
  reasonCode: string;
  recommendedTargetState: KillSwitchControlTargetState;
  metadata: JsonRecord;
}): StateTransitionDecision<KillSwitchState> {
  const event: StateTransitionEventCandidate<KillSwitchState> = {
    eventKind: "KILL_SWITCH_STATE_TRANSITION",
    fromState: input.fromState,
    toState: input.toState,
    accepted: false,
    reasonCode: "kill_switch_reason_target_mismatch",
    message: `Kill switch reason ${input.reasonCode} maps to ${input.recommendedTargetState}, not ${input.toState}`,
    occurredAt: input.occurredAt,
    metadata: input.metadata,
  };

  return {
    accepted: false,
    fromState: input.fromState,
    toState: input.toState,
    reasonCode: event.reasonCode,
    message: event.message,
    event,
  };
}

function normalizeReasonCode(reasonCode: string): string {
  return reasonCode.trim().toLowerCase();
}

function toIsoTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}

const killSwitchTargetStateByReasonCode: Readonly<Record<string, KillSwitchControlTargetState>> = {
  audit_persistence_failure: "HARD_STOP",
  db_write_failure: "HARD_STOP",
  duplicate_order_idempotency_key: "HARD_STOP",
  fill_order_accounting_mismatch: "HARD_STOP",
  live_order_api_misuse_detected: "HARD_STOP",
  order_idempotency_violation: "HARD_STOP",
  risk_limit_calculation_unavailable: "HARD_STOP",

  public_websocket_lag: "NEW_ORDERS_BLOCKED",
  quote_freshness_insufficient: "NEW_ORDERS_BLOCKED",
  stale_market_data: "NEW_ORDERS_BLOCKED",
  transient_external_data_gap: "NEW_ORDERS_BLOCKED",

  abnormal_state_operator_review_required: "MANUAL_REVIEW_REQUIRED",
  notification_consecutive_failure: "MANUAL_REVIEW_REQUIRED",
  notification_failure_threshold_exceeded: "MANUAL_REVIEW_REQUIRED",
  report_generation_repeated_failure: "MANUAL_REVIEW_REQUIRED",
};
