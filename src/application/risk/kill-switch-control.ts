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
import type { AlertDispatchResult } from "../alerts/index.js";

/**
 * HTTP control route가 직접 요청할 수 있는 kill switch target 목록이다.
 *
 * `STRATEGY_PAUSED`는 내부 전략 제어 상태라서 이 route에서 열지 않는다. 운영자가 HTTP로 전역 kill switch를 조작할 때는
 * 신규 주문 차단, HARD_STOP, 수동 검토, 정상 복구처럼 audit/risk evidence와 action plan이 분명한 상태만 허용한다.
 */
export const killSwitchControlTargetStates = [
  "NEW_ORDERS_BLOCKED",
  "HARD_STOP",
  "MANUAL_REVIEW_REQUIRED",
  "NORMAL",
] as const;

export type KillSwitchControlTargetState = (typeof killSwitchControlTargetStates)[number];

/**
 * HARD_STOP 이후 paper broker의 pending order 취소를 지연 실행하기 위한 job type이다.
 *
 * 이 상수는 실제 broker cancel을 즉시 호출하지 않고 DB job 경계로 남긴다는 정책을 코드와 DB payload에서 공유한다.
 */
export const hardStopPendingPaperOrderCancelJobType = "hard_stop_pending_paper_order_cancel";

/**
 * 운영자가 `POST /kill-switch`로 요청한 상태 전이 명령이다.
 *
 * 이 요청은 HTTP layer에서 인증과 schema 검증을 통과한 뒤 application layer로 들어온다. `reasonCode`는 저장 전 canonical
 * lowercase로 정규화되어 audit/risk 집계 키가 분산되지 않아야 하며, `correlationId`는 요청, audit event, risk event, 후속
 * job을 같은 운영 사건으로 묶는 추적 키다.
 */
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
  /**
   * durable `kill_switch_state`에서 읽은 현재 전역 상태다.
   *
   * 요청자가 보낸 상태가 아니라 DB snapshot을 기준으로 판정해야 중복 요청과 경합 요청을 같은 state machine 규칙으로 다룰 수 있다.
   */
  currentState: KillSwitchState;
}

/**
 * HARD_STOP 성공 후 생성할 pending paper order cancel job의 계획이다.
 *
 * application layer는 job payload와 idempotency key만 정의하고, 실제 insert와 dedupe는 infrastructure layer가 담당한다.
 * 이 경계를 유지해야 HTTP 요청 처리 중 외부 broker side effect가 즉시 발생하지 않는다.
 */
export interface HardStopPendingPaperOrderCancelJobPlan {
  jobType: typeof hardStopPendingPaperOrderCancelJobType;
  idempotencyKey: string;
  payloadJson: JsonRecord;
  runAfter: TimestampInput;
  maxAttempts: number;
}

/**
 * kill switch control 요청을 판정하고, 필요하면 durable evidence와 후속 job 정보를 붙인 결과다.
 *
 * `transition`은 state machine의 수락/거부 판단이고, `actionPlan`은 해당 상태에서 런타임이 막아야 할 주문/전략/수동 검토
 * 경계를 표현한다. `auditEventId`와 `riskEventId`는 DB provider가 같은 transaction 안에서 저장한 뒤에만 채운다.
 */
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
  /**
   * control 전이가 실제 운영 알림으로 이어졌는지 나타내는 선택 결과다.
   *
   * HTTP 응답은 이 객체를 그대로 노출하지 않고 필요한 안전 필드만 선택해야 한다. retry payload와 provider 결과가 들어갈 수
   * 있으므로 route layer가 secret-free response shape을 별도로 유지한다.
   */
  alertDispatch?: AlertDispatchResult;
  /**
   * post-commit 알림 경계에서 실패했음을 나타내는 안전한 요약이다.
   *
   * kill switch durable state는 이미 commit됐으므로 이 실패는 control 전이 실패로 전파하지 않는다. 원본 exception message나
   * stack trace는 secret 포함 가능성이 있어 결과에 싣지 않는다.
   */
  alertDispatchFailure?: {
    reasonCode: "alert_dispatch_failed";
  };
}

/**
 * HTTP control layer가 의존하는 kill switch 유스케이스 port다.
 *
 * Fastify route는 이 port만 호출하고 DB transaction, audit/risk 저장, job enqueue 방식에는 직접 의존하지 않는다.
 * 이렇게 둬야 같은 route handler를 테스트 provider와 PostgreSQL provider에 모두 연결할 수 있다.
 */
export interface KillSwitchControlProvider {
  apply(input: KillSwitchControlRequest): Promise<KillSwitchControlResult>;
}

/**
 * HTTP control에서 직접 받을 수 있는 kill switch target인지 확인한다.
 *
 * 외부 입력을 domain의 전체 `KillSwitchState`로 바로 취급하지 않고 이 좁은 enum으로 먼저 줄인다. 특히 `STRATEGY_PAUSED`는
 * 향후 `/pause-strategy` 같은 별도 control route에서 다룰 상태라 여기서는 제외된다.
 */
export function isKillSwitchControlTargetState(value: unknown): value is KillSwitchControlTargetState {
  return typeof value === "string" && killSwitchControlTargetStates.includes(value as KillSwitchControlTargetState);
}

/**
 * P0/P1 운영 원인 코드를 kill switch target state로 정규화한다.
 *
 * 이 함수는 HTTP 요청 검증과 자동 가드레일 후보가 같은 mapping을 공유하도록 만드는 순수 경계다. known reason이 아닌 값은
 * 운영자가 임의로 남긴 사유로 허용하되, known reason이 다른 target과 결합되면 별도 mismatch 거부로 처리된다.
 */
export function mapKillSwitchReasonToTargetState(
  reasonCode: string,
): KillSwitchControlTargetState | undefined {
  const canonicalReasonCode = canonicalizeKillSwitchReasonCode(reasonCode);

  // prototype key가 known reason처럼 판정되지 않도록 own mapping만 허용한다.
  if (!isKnownKillSwitchReasonCode(canonicalReasonCode)) {
    return undefined;
  }

  return killSwitchTargetStateByReasonCode[canonicalReasonCode];
}

/**
 * 운영 증거에 저장할 kill switch reason code를 단일 집계 키로 정규화한다.
 *
 * 같은 장애가 `DB_WRITE_FAILURE`, `db_write_failure`처럼 나뉘어 저장되면 risk dashboard와 alert fingerprint가 갈라진다.
 * 따라서 HTTP, state transition, DB job payload가 모두 이 canonical 값을 공유한다.
 */
export function canonicalizeKillSwitchReasonCode(reasonCode: string): string {
  return reasonCode.trim().toLowerCase();
}

/**
 * 현재 durable state와 운영자가 요청한 target을 state machine 기준으로 판정한다.
 *
 * 이 함수는 DB write를 수행하지 않는 순수 decision boundary다. durable state snapshot, 운영자가 요청한 target, canonical
 * reasonCode를 합쳐 state machine 수락 여부와 action plan을 만든다. known P0/P1 reason이 target과 맞지 않으면 실제 상태를
 * 변경하지 않고 `kill_switch_reason_target_mismatch`로 거부해 운영 증거의 원인 분류가 오염되지 않게 한다.
 */
export function createKillSwitchControlDecision(
  input: KillSwitchControlDecisionInput,
): KillSwitchControlResult {
  const actor = input.actor ?? "http-control";
  const reasonCode = canonicalizeKillSwitchReasonCode(input.reasonCode);
  const recommendedTargetState = mapKillSwitchReasonToTargetState(reasonCode);
  const reasonMatchesTarget =
    recommendedTargetState === undefined || recommendedTargetState === input.targetState;
  const occurredAt = input.occurredAt ?? new Date();
  const stateMachineAllowsTransition = canTransitionKillSwitchState(input.currentState, input.targetState);
  // 요청 사유와 추천 target을 metadata에 남겨 거부 전이도 사후 감사에서 재구성할 수 있게 한다.
  const metadata = createControlTransitionMetadata({
    actor,
    correlationId: input.correlationId,
    requestedReasonCode: reasonCode,
    reasonMatchesTarget,
    recommendedTargetState,
    metadata: input.metadata,
  });
  // known P0/P1 reason이 다른 target과 결합되면 state machine 이전에 운영 원인 mismatch로 차단한다.
  const transition = reasonMatchesTarget
    ? transitionKillSwitchState({
        fromState: input.currentState,
        toState: input.targetState,
        occurredAt,
        ...(stateMachineAllowsTransition ? { reasonCode } : {}),
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
        reasonCode,
        recommendedTargetState: recommendedTargetState as KillSwitchControlTargetState,
        metadata,
      });

  // 거부 전이는 실제 상태가 바뀌지 않았으므로 현재 상태 기준 action plan을 유지한다.
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
 *
 * PostgreSQL update가 0건이면 같은 snapshot을 본 다른 요청이 먼저 상태를 바꾼 것이다. 이 경우 서버 오류로 rollback하지 않고
 * conflict metadata를 포함한 거부 전이로 낮춰, audit/risk evidence가 남는 409 성격의 운영 사건으로 처리한다.
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
    // 실제 DB에 남은 상태를 함께 저장해 운영자가 재시도할 target을 판단할 수 있게 한다.
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
 *
 * HTTP 요청 처리 중 broker cancel을 직접 실행하지 않는다. 대신 DB job을 만들어 worker가 별도 재시도/idempotency 정책으로
 * 처리하게 하며, idempotency key는 correlationId 단독이 아니라 상태 전이와 발생 시각을 포함해 별도 HARD_STOP 사건을 구분한다.
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
    // 같은 correlationId가 재사용되어도 별도 HARD_STOP 사건이 dedupe되지 않도록 전이와 시각을 함께 묶는다.
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

/**
 * audit/risk event에 공통으로 들어갈 운영 metadata를 만든다.
 *
 * 요청 actor, correlation id, reason-target 일치 여부를 같은 shape으로 남겨 HTTP 응답, audit log, risk event가 같은 사건을
 * 가리키도록 한다. caller가 넘긴 metadata는 보존하되 control route가 계산한 필드를 덧붙인다.
 */
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
    // known reason의 추천 target은 거부/수락 모두에서 운영자가 원인 mapping을 검증하는 근거다.
    metadata.recommended_target_state = input.recommendedTargetState;
  }

  return metadata;
}

/**
 * known reason code와 요청 target이 어긋난 경우의 거부 전이를 만든다.
 *
 * 예를 들어 `db_write_failure`는 HARD_STOP으로만 이어져야 한다. 이를 NORMAL 복구 요청과 함께 받으면 실제 DB 장애처럼
 * 집계하지 않고 mismatch reason으로 남겨, 자동화나 운영자의 잘못된 요청을 명확히 구분한다.
 */
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

/**
 * reason mapping 조회를 own key로 제한한다.
 *
 * plain object prototype의 `constructor` 같은 키가 known reason처럼 판정되면 unknown reason 허용 정책이 깨지고 감사 증거가
 * 비정상 값으로 오염된다.
 */
function isKnownKillSwitchReasonCode(reasonCode: string): reasonCode is KnownKillSwitchReasonCode {
  return Object.prototype.hasOwnProperty.call(killSwitchTargetStateByReasonCode, reasonCode);
}

/**
 * Date 또는 ISO 문자열 입력을 job idempotency key와 payload에서 사용할 ISO 문자열로 맞춘다.
 */
function toIsoTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * 운영 장애 reason code별 권장 kill switch target mapping이다.
 *
 * HARD_STOP은 주문 회계/DB 영속성/실거래 API 오용처럼 즉시 실행 경계를 멈춰야 하는 P0 사유다. NEW_ORDERS_BLOCKED는
 * market data freshness나 live reconcile mismatch처럼 신규 주문만 막고 관측/복구를 기다릴 수 있는 사유이며,
 * MANUAL_REVIEW_REQUIRED는 알림/리포트 반복 실패나 live reconcile identity 충돌처럼 사람이 상태를 확인해야 하는 사유다.
 */
const killSwitchTargetStateByReasonCode = {
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
  live_reconcile_mismatch: "NEW_ORDERS_BLOCKED",

  abnormal_state_operator_review_required: "MANUAL_REVIEW_REQUIRED",
  live_reconcile_identity_conflict: "MANUAL_REVIEW_REQUIRED",
  notification_consecutive_failure: "MANUAL_REVIEW_REQUIRED",
  notification_failure_threshold_exceeded: "MANUAL_REVIEW_REQUIRED",
  report_generation_repeated_failure: "MANUAL_REVIEW_REQUIRED",
} as const satisfies Readonly<Record<string, KillSwitchControlTargetState>>;

type KnownKillSwitchReasonCode = keyof typeof killSwitchTargetStateByReasonCode;
