import type {
  RiskBlockAction,
  RiskEvaluationStatus,
  RiskGateEvaluation,
  RiskGateResult,
  RiskThresholdSnapshot,
} from "../../../domain/index.js";

/**
 * 개별 RiskGate evaluation 배열을 최종 RiskGateResult로 합성한다.
 *
 * 실패/경고 목록과 가장 강한 action을 동시에 계산하며, 외부 side effect 없이 threshold snapshot을 결과 루트에 보존한다.
 */
export function createRiskGateResult(
  evaluations: readonly RiskGateEvaluation[],
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateResult {
  const failedEvaluations = evaluations.filter((evaluation) => evaluation.status === "FAIL");
  const warningEvaluations = evaluations.filter((evaluation) => evaluation.status === "WARN");
  const action = selectMostRestrictiveAction(evaluations);
  const status: RiskEvaluationStatus =
    failedEvaluations.length > 0 ? "FAIL" : warningEvaluations.length > 0 ? "WARN" : "PASS";

  return {
    status,
    approved: failedEvaluations.length === 0 && action === "ALLOW",
    action,
    evaluations,
    failedEvaluations,
    warningEvaluations,
    thresholdSnapshot,
  };
}

function selectMostRestrictiveAction(evaluations: readonly RiskGateEvaluation[]): RiskBlockAction {
  return evaluations.reduce<RiskBlockAction>((selected, evaluation) => {
    // 여러 위반이 동시에 발생하면 운영 복구 비용이 가장 큰 action을 전체 결과로 선택한다.
    return actionPriority[evaluation.action] > actionPriority[selected] ? evaluation.action : selected;
  }, "ALLOW");
}

const actionPriority: Readonly<Record<RiskBlockAction, number>> = {
  ALLOW: 0,
  PAUSE_STRATEGY: 1,
  BLOCK_NEW_ORDER: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};
