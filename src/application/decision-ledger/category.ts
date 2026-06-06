/**
 * M18 판단 범주 상수 — decision ledger와 why summary가 공유하는 안정 분류 체계다.
 *
 * 각 범주는 시스템이 내린 판단의 결과를 분류하며, 사용자-facing 한국어 문구로 직접 노출되지 않는다.
 * 사용자 문구는 별도 user-facing mapper가 category, reasonCode, context를 조합해 생성한다.
 *
 * ## 불변식 (invariant)
 *
 * - 새 범주를 추가할 때는 기존 범주 enum 값을 변경하지 않고 append한다.
 * - `CASH_HOLD`는 주문 후보 0건 frame도 설명 가능해야 하는 이유 분류이므로 `HOLD`와 분리한다.
 * - `EXPLANATION_FAILED`는 LLM 장애 evidence 전용이며 주문 판단을 대체하지 않는다.
 * - `EXECUTED`는 paper/live broker를 통한 실제 주문 제출 성공을 의미하며, 결정만 내린 상태와 구분한다.
 */

/**
 * 판단 결과를 나타내는 안정 범주다.
 *
 * - `BUY`: 매수 판단으로 주문이 생성되어 제출됨
 * - `SELL`: 매도 판단으로 주문이 생성되어 제출됨
 * - `HOLD`: 전략이 현재 가격/조건에서 진입 또는 청산하지 않기로 판단
 * - `CASH_HOLD`: 모든 전략이 현금 보유를 선택했거나 주문 후보가 0건인 frame
 * - `DISCARD`: 전략 판단 이후 order intent 변환 단계에서 폐기됨
 * - `COST_REJECTED`: 비용 모델이 기대 수익 대비 비용 부족으로 차단
 * - `RISK_REJECTED`: RiskGate가 리스크 한도를 초과해 차단
 * - `EXECUTION_REJECTED`: 실행 엔진이 주문 제출을 거부함
 * - `EXECUTED`: 주문이 broker에 제출되어 접수됨
 * - `EXPLANATION_FAILED`: 설명 생성(LLM)이 실패했으나 주문 판단과 무관
 */
export type DecisionCategory =
  | "BUY"
  | "SELL"
  | "HOLD"
  | "CASH_HOLD"
  | "DISCARD"
  | "COST_REJECTED"
  | "RISK_REJECTED"
  | "EXECUTION_REJECTED"
  | "EXECUTED"
  | "EXPLANATION_FAILED";

/**
 * ledger frame의 판단 결과 범주다.
 *
 * frame은 실제 전략/비용/리스크/실행 판단을 대표하므로, LLM 설명 장애 전용인
 * `EXPLANATION_FAILED`를 포함하지 않는다. 설명 실패는 evidence 또는 summary status로만
 * 보존해 최신 frame 조회가 실제 주문 판단을 잃지 않게 한다.
 */
export type DecisionFrameCategory = Exclude<DecisionCategory, "EXPLANATION_FAILED">;

/**
 * DecisionCategory 상수 객체 — 코드에서 오타 없이 참조하기 위한 안정 참조값이다.
 */
export const DecisionCategoryValue = {
  BUY: "BUY",
  SELL: "SELL",
  HOLD: "HOLD",
  CASH_HOLD: "CASH_HOLD",
  DISCARD: "DISCARD",
  COST_REJECTED: "COST_REJECTED",
  RISK_REJECTED: "RISK_REJECTED",
  EXECUTION_REJECTED: "EXECUTION_REJECTED",
  EXECUTED: "EXECUTED",
  EXPLANATION_FAILED: "EXPLANATION_FAILED",
} as const satisfies Record<string, DecisionCategory>;

/**
 * DecisionLedgerFrame에서 사용할 수 있는 category 상수 객체다.
 */
export const DecisionFrameCategoryValue = {
  BUY: "BUY",
  SELL: "SELL",
  HOLD: "HOLD",
  CASH_HOLD: "CASH_HOLD",
  DISCARD: "DISCARD",
  COST_REJECTED: "COST_REJECTED",
  RISK_REJECTED: "RISK_REJECTED",
  EXECUTION_REJECTED: "EXECUTION_REJECTED",
  EXECUTED: "EXECUTED",
} as const satisfies Record<string, DecisionFrameCategory>;

/**
 * ledger frame 또는 why summary의 읽기/조회 상태다.
 *
 * - `RECORDED`: 정상 기록됨
 * - `PARTIAL`: 일부 evidence만 기록됨 (예: frame은 있으나 evidence 수집 중)
 * - `UNAVAILABLE`: 조회 가능한 데이터가 없음
 * - `EXPLANATION_FAILED`: 설명 생성은 실패했으나 frame/evidence는 정상 기록됨
 */
export type SummaryStatus = "RECORDED" | "PARTIAL" | "UNAVAILABLE" | "EXPLANATION_FAILED";

/**
 * SummaryStatus 상수 객체.
 */
export const SummaryStatusValue = {
  RECORDED: "RECORDED",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE",
  EXPLANATION_FAILED: "EXPLANATION_FAILED",
} as const satisfies Record<string, SummaryStatus>;

/**
 * decision ledger에 append-only로 저장되는 단일 근거의 종류다.
 *
 * 각 evidence kind는 pipeline의 특정 단계에서 생성된 판단 근거를 분류한다.
 *
 * - `STRATEGY_DECISION`: 전략이 BUY/SELL/HOLD/BLOCK 판단을 내림
 * - `ORDER_INTENT`: 전략 판단을 주문 후보로 변환한 결과
 * - `DISCARD_REASON`: 전략 차단 또는 변환 단계 폐기 사유
 * - `COST_BREAKDOWN`: 비용 모델의 수수료/스프레드/슬리피지/요구수익률 평가
 * - `RISK_DECISION`: RiskGate 승인/거부 판단
 * - `EXECUTION_RESULT`: paper/live 실행 결과 요약
 * - `PNL_STATUS_CONTEXT`: M17 PnL/포지션 safe summary 연결
 * - `EXPLANATION_SUMMARY`: 결정론적 또는 LLM 보조 설명 요약
 * - `EXPLANATION_FAILURE`: LLM 장애로 설명 생성 실패
 */
export type EvidenceKind =
  | "STRATEGY_DECISION"
  | "ORDER_INTENT"
  | "DISCARD_REASON"
  | "COST_BREAKDOWN"
  | "RISK_DECISION"
  | "EXECUTION_RESULT"
  | "PNL_STATUS_CONTEXT"
  | "EXPLANATION_SUMMARY"
  | "EXPLANATION_FAILURE";

/**
 * EvidenceKind 상수 객체.
 */
export const EvidenceKindValue = {
  STRATEGY_DECISION: "STRATEGY_DECISION",
  ORDER_INTENT: "ORDER_INTENT",
  DISCARD_REASON: "DISCARD_REASON",
  COST_BREAKDOWN: "COST_BREAKDOWN",
  RISK_DECISION: "RISK_DECISION",
  EXECUTION_RESULT: "EXECUTION_RESULT",
  PNL_STATUS_CONTEXT: "PNL_STATUS_CONTEXT",
  EXPLANATION_SUMMARY: "EXPLANATION_SUMMARY",
  EXPLANATION_FAILURE: "EXPLANATION_FAILURE",
} as const satisfies Record<string, EvidenceKind>;

/**
 * lantern이 올바른 category 값인지 런타임에 검사한다.
 *
 * 호출자는 string 값을 안전하게 `DecisionCategory`로 좁히기 전에 이 함수로 확인한다.
 * type predicate가 아니므로, 통과 후 `as DecisionCategory` 단언이 필요하다.
 */
export function isValidDecisionCategory(value: string): value is DecisionCategory {
  return Object.values(DecisionCategoryValue).includes(value as DecisionCategory);
}

/**
 * 주어진 문자열이 frame category로 유효한지 런타임에 검사한다.
 */
export function isValidDecisionFrameCategory(value: string): value is DecisionFrameCategory {
  return Object.values(DecisionFrameCategoryValue).includes(value as DecisionFrameCategory);
}

/**
 * 주어진 문자열이 유효한 EvidenceKind인지 런타임에 검사한다.
 */
export function isValidEvidenceKind(value: string): value is EvidenceKind {
  return Object.values(EvidenceKindValue).includes(value as EvidenceKind);
}
