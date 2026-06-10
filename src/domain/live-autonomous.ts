import type { NumericString, TimestampInput } from "./types.js";

export const LIVE_AUTONOMOUS_SMALL_BUDGET_MODE = "LIVE_AUTONOMOUS_SMALL_BUDGET";

/**
 * M22 live autonomous runtime이 주문 시도를 추적할 때 사용하는 canonical 상태 목록이다.
 *
 * `CANDIDATE_CREATED`부터 broker 제출 또는 차단/수동 점검까지 append-only evidence로만 전진해야 한다. 이 값은 domain,
 * runtime, audit 저장소가 공유하는 안정 contract이며 자체적으로 외부 API 호출이나 DB write side effect를 만들지 않는다.
 */
export const liveAutonomousOrderAttemptStatuses = [
  "CANDIDATE_CREATED",
  "COST_APPROVED",
  "RISK_APPROVED",
  "RESERVED",
  "SUBMITTED",
  "REJECTED",
  "BLOCKED",
  "RECONCILE_REQUIRED",
  "MANUAL_REVIEW_REQUIRED",
] as const;

/**
 * M22 autonomous order attempt의 상태 code다.
 *
 * 사용자-facing status/report는 한국어 상태와 필요한 조치를 먼저 보여주고, 이 code는 audit/debug 추적 정보로만 보존한다.
 */
export type LiveAutonomousOrderAttemptStatus = (typeof liveAutonomousOrderAttemptStatuses)[number];

/**
 * M22 autonomous order attempt 상태 전이 event다.
 *
 * entry runtime은 이 event를 append-only evidence로 남겨야 한다. `metadata`에는 내부 추적값만 두고 사용자-facing 문구는
 * `message`와 `action`에 한국어로 분리해야 하며, 이 타입 자체는 저장소나 broker side effect를 만들지 않는다.
 */
export interface LiveAutonomousOrderAttemptEvent {
  attemptId: string;
  fromStatus?: LiveAutonomousOrderAttemptStatus;
  toStatus: LiveAutonomousOrderAttemptStatus;
  reasonCode: string;
  message: string;
  action: string;
  observedAt: TimestampInput;
  metadata?: Record<string, unknown>;
}

/**
 * M22 autonomous order attempt event 생성 입력이다.
 *
 * caller는 이전 상태와 다음 상태를 함께 넘겨 state machine helper가 전이 가능성을 검증하게 해야 한다. 이 입력은 event 생성
 * contract일 뿐 저장소 append나 broker 호출 side effect를 직접 수행하지 않는다.
 */
export interface CreateLiveAutonomousOrderAttemptEventInput {
  attemptId: string;
  fromStatus?: LiveAutonomousOrderAttemptStatus;
  toStatus: LiveAutonomousOrderAttemptStatus;
  reasonCode: string;
  message: string;
  action: string;
  observedAt: TimestampInput;
  metadata?: Record<string, unknown>;
}

/**
 * M22 autonomous order attempt 상태 전이 오류다.
 *
 * 잘못된 전이는 durable audit chain을 왜곡할 수 있으므로 runtime은 이 오류를 발견하면 broker 제출보다 먼저 중단해야 한다.
 */
export class InvalidLiveAutonomousOrderAttemptTransitionError extends Error {
  public readonly fromStatus: LiveAutonomousOrderAttemptStatus | undefined;
  public readonly toStatus: LiveAutonomousOrderAttemptStatus;

  public constructor(
    fromStatus: LiveAutonomousOrderAttemptStatus | undefined,
    toStatus: LiveAutonomousOrderAttemptStatus,
  ) {
    super(`Invalid live autonomous order attempt transition: ${fromStatus ?? "START"} -> ${toStatus}`);
    this.name = "InvalidLiveAutonomousOrderAttemptTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

const liveAutonomousOrderAttemptTerminalStatuses = new Set<LiveAutonomousOrderAttemptStatus>([
  "SUBMITTED",
  "REJECTED",
  "BLOCKED",
  "RECONCILE_REQUIRED",
  "MANUAL_REVIEW_REQUIRED",
]);

const liveAutonomousOrderAttemptTransitions: Readonly<
  Record<LiveAutonomousOrderAttemptStatus, readonly LiveAutonomousOrderAttemptStatus[]>
> = {
  CANDIDATE_CREATED: [
    "COST_APPROVED",
    "BLOCKED",
    "RECONCILE_REQUIRED",
    "MANUAL_REVIEW_REQUIRED",
  ],
  COST_APPROVED: ["RISK_APPROVED", "BLOCKED", "RECONCILE_REQUIRED", "MANUAL_REVIEW_REQUIRED"],
  RISK_APPROVED: ["RESERVED", "BLOCKED", "RECONCILE_REQUIRED", "MANUAL_REVIEW_REQUIRED"],
  RESERVED: ["SUBMITTED", "REJECTED", "RECONCILE_REQUIRED", "MANUAL_REVIEW_REQUIRED", "BLOCKED"],
  SUBMITTED: [],
  REJECTED: [],
  BLOCKED: [],
  RECONCILE_REQUIRED: [],
  MANUAL_REVIEW_REQUIRED: [],
};

/**
 * M22 autonomous order attempt가 다음 상태로 전이할 수 있는지 확인한다.
 *
 * 시작 상태는 반드시 `CANDIDATE_CREATED`여야 하며 terminal 상태 이후 전이는 거부한다. 이 함수는 순수 검증이며 audit write나
 * broker 호출 side effect를 수행하지 않는다.
 */
export function canTransitionLiveAutonomousOrderAttempt(
  fromStatus: LiveAutonomousOrderAttemptStatus | undefined,
  toStatus: LiveAutonomousOrderAttemptStatus,
): boolean {
  if (fromStatus === undefined) {
    return toStatus === "CANDIDATE_CREATED";
  }

  if (liveAutonomousOrderAttemptTerminalStatuses.has(fromStatus)) {
    return false;
  }

  return liveAutonomousOrderAttemptTransitions[fromStatus].includes(toStatus);
}

/**
 * M22 autonomous order attempt 상태 전이를 검증하고 event를 만든다.
 *
 * runtime은 이 helper로 state machine 순서를 고정한 뒤 저장소 adapter에 event를 넘겨야 한다. 잘못된 전이는 예외로 차단하며,
 * 이 helper 자체는 외부 side effect 없이 event 객체만 반환한다.
 */
export function createLiveAutonomousOrderAttemptEvent(
  input: CreateLiveAutonomousOrderAttemptEventInput,
): LiveAutonomousOrderAttemptEvent {
  if (!canTransitionLiveAutonomousOrderAttempt(input.fromStatus, input.toStatus)) {
    throw new InvalidLiveAutonomousOrderAttemptTransitionError(input.fromStatus, input.toStatus);
  }

  const event: LiveAutonomousOrderAttemptEvent = {
    attemptId: input.attemptId,
    toStatus: input.toStatus,
    reasonCode: input.reasonCode,
    message: input.message,
    action: input.action,
    observedAt: input.observedAt,
  };

  if (input.fromStatus !== undefined) {
    event.fromStatus = input.fromStatus;
  }
  if (input.metadata !== undefined) {
    event.metadata = input.metadata;
  }

  return event;
}

/**
 * M22 autonomous budget snapshot이다.
 *
 * 주문 후보 생성 시점과 broker 제출 직전 재검증에서 같은 예산 축을 사용하기 위한 값이다. 모든 금액은 Decimal 정밀도 보존을 위해
 * 문자열로 유지하며, 이 구조는 저장과 전송을 위한 contract일 뿐 예산 선점 side effect는 별도 store가 담당한다.
 */
export interface LiveAutonomousBudgetSnapshot {
  maxOrderKrw: NumericString;
  dailyAutonomousNotionalLimitKrw: NumericString;
  dailyAutonomousNotionalUsedKrw: NumericString;
  openPositionNotionalKrw: NumericString;
  maxOpenPositionNotionalKrw: NumericString;
  capturedAt: TimestampInput;
}
