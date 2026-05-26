import type {
  CostSnapshot,
  OrderIntent,
  RiskGateContext,
  RiskGateResult,
} from "../../../domain/index.js";
import {
  createOrderIntentEvidence,
  readRiskGateExpectedLossBps,
} from "./evidence-fingerprint.js";
import type {
  ExecutionCostSnapshotEvidence,
  ExecutionRiskApprovalEvidence,
} from "./types.js";

/**
 * RiskGate 평가 결과를 ExecutionEngine이 대조할 수 있는 JSON evidence로 고정한다.
 *
 * RiskGate가 승인한 당시의 주문 후보와 expected loss를 함께 snapshot으로 남긴다. 이후 submission boundary에서
 * 같은 후보인지 다시 비교하므로, RiskGate 이후 수량/가격/손실 입력이 바뀐 주문은 broker 직전에 거부된다.
 */
export function createExecutionRiskApprovalEvidence(
  result: RiskGateResult,
  context: RiskGateContext,
): ExecutionRiskApprovalEvidence {
  const evidence: ExecutionRiskApprovalEvidence = {
    source: "risk_gate",
    approved: result.approved,
    status: result.status,
    action: result.action,
    order_intent: createOrderIntentEvidence(
      context.orderIntent,
      readRiskGateExpectedLossBps(context),
    ),
    threshold_snapshot: context.thresholdSnapshot,
    failed_evaluation_reason_codes: result.failedEvaluations.map((evaluation) => evaluation.reasonCode),
    warning_evaluation_reason_codes: result.warningEvaluations.map((evaluation) => evaluation.reasonCode),
  };

  return evidence;
}

/**
 * CostModel snapshot에 ExecutionEngine이 현재 주문과 대조할 order intent fingerprint를 붙인다.
 *
 * CostModel 자체는 수수료와 기대수익 중심의 계산 결과를 만들기 때문에 strategy, side, idempotency key 같은
 * execution 후보 식별자를 알지 않는다. 이 adapter는 비용 snapshot을 broker 제출 승인 증거로 쓰기 전에 후보
 * fingerprint를 추가하는 좁은 adapter 역할만 한다.
 */
export function createExecutionCostSnapshotEvidence(
  snapshot: CostSnapshot,
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
): ExecutionCostSnapshotEvidence {
  return {
    ...snapshot,
    source: "cost_model",
    order_intent: createOrderIntentEvidence(intent, expectedLossBpsOfEquity),
  };
}
