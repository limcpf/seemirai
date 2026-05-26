import type {
  JsonRecord,
  OrderIntent,
  RiskGateContext,
  RiskGateEvaluation,
  RiskGateResult,
  StateTransitionEventCandidate,
  StrategyRiskSnapshot,
} from "../../../domain/index.js";

/**
 * RiskGateResult를 audit/risk event metadata에 넣을 요약 payload로 변환한다.
 *
 * threshold snapshot과 실패/경고 reason code를 함께 보존해 운영자가 어떤 gate가 주문을 막았는지 event log만으로 추적할 수 있게 한다.
 */
export function createRiskGateDecisionMetadata(
  result: RiskGateResult,
  strategy: StrategyRiskSnapshot,
): JsonRecord {
  return {
    status: result.status,
    approved: result.approved,
    action: result.action,
    threshold_snapshot: result.thresholdSnapshot,
    strategy_id: strategy.strategyId,
    failed_reason_codes: result.failedEvaluations.map((evaluation) => evaluation.reasonCode),
    warning_reason_codes: result.warningEvaluations.map((evaluation) => evaluation.reasonCode),
  };
}

/**
 * 단일 RiskGate evaluation을 durable JSON evidence로 변환한다.
 *
 * threshold snapshot과 metadata는 optional이므로 값이 있을 때만 보존해 payload shape를 기존과 동일하게 유지한다.
 */
export function toRiskGateEvaluationPayload(evaluation: RiskGateEvaluation): JsonRecord {
  const payload: JsonRecord = {
    status: evaluation.status,
    reason_code: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    action: evaluation.action,
  };

  assignIfDefined(payload, "threshold_snapshot", evaluation.thresholdSnapshot);
  assignIfDefined(payload, "metadata", evaluation.metadata);

  return payload;
}

/**
 * state machine event 후보를 audit metadata payload로 변환한다.
 *
 * 주문 상태와 kill switch 상태 전이가 같은 구조를 공유해 audit reader가 event kind 기준으로 복구할 수 있게 한다.
 */
export function toStateTransitionPayload<State extends string>(
  event: StateTransitionEventCandidate<State>,
): JsonRecord {
  const payload: JsonRecord = {
    event_kind: event.eventKind,
    from_state: event.fromState,
    to_state: event.toState,
    accepted: event.accepted,
    reason_code: event.reasonCode,
    message: event.message,
  };

  assignIfDefined(payload, "metadata", event.metadata);

  return payload;
}

/**
 * RiskGateContext의 주문 intent를 audit/risk event에서 재현 가능한 JSON payload로 만든다.
 *
 * LIMIT 가격과 metadata는 optional field로 보존해 기존 이벤트 payload와 호환된다.
 */
export function toOrderIntentPayload(context: RiskGateContext): JsonRecord {
  return toOrderIntentPayloadFromIntent(context.orderIntent);
}

/**
 * OrderIntent 단일 객체를 audit/risk event JSON payload로 변환한다.
 *
 * context가 없는 후보 비교 경계에서도 같은 payload shape를 재사용하며, 외부 저장소 write는 수행하지 않는다.
 */
export function toOrderIntentPayloadFromIntent(intent: OrderIntent): JsonRecord {
  const payload: JsonRecord = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    idempotency_key: intent.idempotencyKey,
    reason: intent.reason,
  };

  if (intent.orderType === "LIMIT") {
    payload.requested_price = intent.requestedPrice;
  }

  assignIfDefined(payload, "metadata", intent.metadata);

  return payload;
}

/**
 * JSON metadata에서 string 값만 읽는다.
 *
 * runtime 후보 대조는 타입이 다른 metadata 값을 mismatch 근거로 쓰지 않아야 하므로 string이 아닌 값은 없는 값으로 취급한다.
 */
export function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

/**
 * optional field를 기존 payload shape와 같이 값이 있을 때만 할당한다.
 *
 * undefined를 명시 저장하지 않아 DB JSON evidence와 PR 이전 snapshot 비교가 흔들리지 않게 한다.
 */
export function assignIfDefined<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
