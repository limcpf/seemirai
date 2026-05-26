import type { JsonRecord, RiskEventSeverity, RiskGateResult } from "../../../domain/index.js";
import {
  assignIfDefined,
  createRiskGateDecisionMetadata,
  toOrderIntentPayload,
  toRiskGateEvaluationPayload,
} from "./payload-mapper.js";
import type {
  PersistedRiskEventSeverity,
  RiskGateRiskEventAppendInput,
  RiskGateRuntimeDecisionInput,
} from "./types.js";

/**
 * RiskGate 실패/경고 evaluation을 durable risk event append 입력으로 변환한다.
 *
 * 평가 payload, RiskGate decision metadata, 주문 intent snapshot을 함께 넣어 audit event 없이도 risk_events만으로 차단 원인을
 * 복구할 수 있게 한다.
 */
export function createRiskEvents(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): RiskGateRiskEventAppendInput[] {
  return [...result.failedEvaluations, ...result.warningEvaluations].map((evaluation) => {
    const payloadJson: JsonRecord = {
      evaluation: toRiskGateEvaluationPayload(evaluation),
      risk_gate: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
      order_intent: toOrderIntentPayload(input.riskGateContext),
    };
    assignIfDefined(payloadJson, "correlation_id", input.correlationId);

    const event: RiskGateRiskEventAppendInput = {
      riskType: evaluation.reasonCode,
      action: evaluation.action,
      occurredAt: input.riskGateContext.observedAt,
      severity: toPersistedRiskEventSeverity(evaluation.severity),
      market: input.riskGateContext.orderIntent.market,
      strategyId: input.riskGateContext.orderIntent.strategyId,
      orderId: input.orderId,
      payloadJson,
    };

    return event;
  });
}

function toPersistedRiskEventSeverity(severity: RiskEventSeverity): PersistedRiskEventSeverity {
  if (severity === "BLOCKING") {
    return "ERROR";
  }

  return severity;
}
