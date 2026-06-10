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
 * M22 autonomous budget snapshot이다.
 *
 * 주문 후보 생성 시점과 broker 제출 직전 재검증에서 같은 예산 축을 사용하기 위한 값이다. 모든 금액은 Decimal 정밀도 보존을 위해
 * 문자열로 유지하며, 이 구조는 저장과 전송을 위한 contract일 뿐 예산 선점 side effect는 별도 store가 담당한다.
 */
export interface LiveAutonomousBudgetSnapshot {
  maxOrderKrw: NumericString;
  dailyAutonomousNotionalLimitKrw: NumericString;
  dailyAutonomousNotionalUsedKrw: NumericString;
  maxOpenPositionNotionalKrw: NumericString;
  capturedAt: TimestampInput;
}
