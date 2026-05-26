import type { RiskGateEvaluation, RiskGateResult } from "../../../domain/index.js";
import { createRuntimeCandidateMismatchEvaluation } from "./candidate-mismatch.js";
import { createCurrentKillSwitchBlockingEvaluation, selectDominantRiskAction } from "./kill-switch-policy.js";
import type { RiskGateRuntimeDecisionInput } from "./types.js";

/**
 * dominant action이 더 강한 전역 차단으로 승격돼도 strategy pause evidence가 필요한지 판단한다.
 *
 * 연속 손실 초과는 전역 신규 주문 차단과 독립적으로 해당 strategy의 평가 중지 근거가 되므로, 최종 action이
 * `BLOCK_NEW_ORDER`/`MANUAL_REVIEW_REQUIRED`/`HARD_STOP`이어도 failed evaluation에 남은 pause 신호를 보존한다.
 */
export function shouldCreateStrategyPauseActionPlan(result: RiskGateResult): boolean {
  return result.failedEvaluations.some((evaluation) => evaluation.action === "PAUSE_STRATEGY");
}

/**
 * runtime 경계에서만 알 수 있는 fail-closed evaluation을 RiskGateResult에 병합한다.
 *
 * stale order intent mismatch나 현재 kill switch 차단은 evaluator의 순수 입력 밖에 있으므로 runtime evidence 생성 전에
 * 같은 결과 구조로 승격한다.
 */
export function applyRuntimeFailClosedEvaluations(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): RiskGateResult {
  const failClosedEvaluations = [
    createRuntimeCandidateMismatchEvaluation(input),
    createCurrentKillSwitchBlockingEvaluation(input),
  ].filter((evaluation): evaluation is RiskGateEvaluation => evaluation !== undefined);

  if (failClosedEvaluations.length === 0) {
    return result;
  }

  return appendFailClosedEvaluations(result, failClosedEvaluations);
}

/**
 * runtime에서 발견한 일관성 위반을 RiskGate 실패 평가로 병합한다.
 *
 * RiskGate evaluator 자체가 PASS를 반환했더라도 persistence 경계에서 후보 불일치, kill switch 차단, 불법 상태 전이가
 * 확인되면 현재 주문은 승인하지 않고 같은 evidence 묶음에 실패 원인을 남긴다.
 */
export function appendFailClosedEvaluations(
  result: RiskGateResult,
  failClosedEvaluations: readonly RiskGateEvaluation[],
): RiskGateResult {
  if (failClosedEvaluations.length === 0) {
    return result;
  }

  // runtime 경계의 일관성 위반은 RiskGate snapshot이 깨끗해도 주문 승인을 막는다.
  return {
    ...result,
    status: "FAIL",
    approved: false,
    action: selectDominantRiskAction([
      result.action,
      ...failClosedEvaluations.map((evaluation) => evaluation.action),
    ]),
    evaluations: [...result.evaluations, ...failClosedEvaluations],
    failedEvaluations: [...result.failedEvaluations, ...failClosedEvaluations],
  };
}
