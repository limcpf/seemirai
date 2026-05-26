import type {
  JsonRecord,
  RiskBlockAction,
  RiskEvaluationStatus,
  RiskEventSeverity,
  RiskGateEvaluation,
  RiskThresholdSnapshot,
} from "../../../domain/index.js";

interface EvaluationInput {
  status: RiskEvaluationStatus;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  action: RiskBlockAction;
  thresholdSnapshot?: RiskThresholdSnapshot;
  metadata?: JsonRecord;
}

/**
 * RiskGate PASS evaluation을 만든다.
 *
 * policy 함수가 승인 근거를 동일한 payload shape로 남기기 위한 factory이며, 외부 side effect 없이 metadata만 조건부 보존한다.
 */
export function pass(reasonCode: string, message: string, metadata?: JsonRecord): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "PASS",
    reasonCode,
    message,
    severity: "INFO",
    action: "ALLOW",
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

/**
 * RiskGate WARN evaluation을 만든다.
 *
 * 주문을 직접 차단하지 않는 운영 경고를 `ALLOW` action으로 보존해 result status와 audit metadata가 같은 기준을 쓰게 한다.
 */
export function warn(reasonCode: string, message: string, metadata?: JsonRecord): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "WARN",
    reasonCode,
    message,
    severity: "WARN",
    action: "ALLOW",
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

/**
 * RiskGate FAIL evaluation을 만든다.
 *
 * 차단 action에 따라 severity를 고정해 HARD_STOP/manual review가 audit에서 항상 critical로 보이도록 한다.
 */
export function fail(
  reasonCode: string,
  message: string,
  action: Exclude<RiskBlockAction, "ALLOW">,
  metadata?: JsonRecord,
): RiskGateEvaluation {
  const input: EvaluationInput = {
    status: "FAIL",
    reasonCode,
    message,
    severity: action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "BLOCKING",
    action,
  };
  if (metadata !== undefined) {
    input.metadata = metadata;
  }

  return createEvaluation(input);
}

/**
 * 여러 evaluation에 동일 threshold snapshot을 붙인다.
 *
 * policy가 threshold를 비교한 근거를 각 evaluation에 남기기 위한 순수 변환이며 원본 배열은 변경하지 않는다.
 */
export function withThresholdSnapshots(
  evaluations: readonly RiskGateEvaluation[],
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateEvaluation[] {
  return evaluations.map((item) => ({ ...item, thresholdSnapshot }));
}

/**
 * 단일 evaluation에 threshold snapshot을 붙인다.
 *
 * missing/invalid 입력처럼 한 개 evaluation만 반환하는 policy에서도 결과 payload invariant를 유지하기 위해 사용한다.
 */
export function withThresholdSnapshot(
  evaluation: RiskGateEvaluation,
  thresholdSnapshot: RiskThresholdSnapshot,
): RiskGateEvaluation {
  return {
    ...evaluation,
    thresholdSnapshot,
  };
}

function createEvaluation(input: EvaluationInput): RiskGateEvaluation {
  const evaluation: RiskGateEvaluation = {
    status: input.status,
    reasonCode: input.reasonCode,
    message: input.message,
    severity: input.severity,
    action: input.action,
  };

  if (input.thresholdSnapshot !== undefined) {
    evaluation.thresholdSnapshot = input.thresholdSnapshot;
  }
  if (input.metadata !== undefined) {
    evaluation.metadata = input.metadata;
  }

  return evaluation;
}
