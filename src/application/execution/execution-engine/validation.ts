import { parseFinancialDecimal } from "../../../shared/index.js";
import type { JsonRecord, OrderIntent, OrderSubmission } from "../../../domain/index.js";
import {
  compareOrderIntentEvidence,
  createOrderIntentEvidence,
  isEntryMarketOrderIntent,
  readStringMetadata,
  readSubmissionExpectedLossBps,
} from "./evidence-fingerprint.js";
import { defaultPaperExecutionSafetyConfig } from "./safety-config.js";
import type {
  ExecutionRejectionReasonCode,
  ExecutionSafetyConfig,
  ExecutionSubmissionValidationResult,
} from "./types.js";

/**
 * 주문 제출 요청이 broker side effect를 실행해도 되는지 순수 함수로 검증한다.
 *
 * 검증 순서는 저렴하고 전역적인 차단 조건에서 시작해, 주문 금액, 비용 snapshot, RiskGate approval 순서로 좁혀 간다.
 * 이 함수는 broker port나 DB를 호출하지 않으므로 테스트와 runtime mapper에서 같은 fail-closed 판단을 재사용할 수 있다.
 */
export function validateExecutionSubmission(
  submission: OrderSubmission,
  safetyConfig: ExecutionSafetyConfig = defaultPaperExecutionSafetyConfig,
): ExecutionSubmissionValidationResult {
  const idempotencyKey = submission.intent.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    // idempotency key가 없으면 broker/repository 어느 쪽에서도 중복 방지 기준을 만들 수 없으므로 즉시 거부한다.
    return reject("idempotency_key_missing", "Execution submission requires a non-empty idempotency key");
  }

  if (safetyConfig.liveTradingEnabled) {
    // MVP execution boundary는 paper-only이므로 live trading toggle이 열린 구성 자체를 실행 불가로 본다.
    return reject("live_trading_disabled", "Live trading is disabled for the MVP execution boundary");
  }

  if (!safetyConfig.paperNoKey) {
    // paper runtime은 API key 없이도 동작해야 하므로 key 의존 실행 경로가 섞인 설정을 차단한다.
    return reject("paper_no_key_required", "Paper execution must be able to run without API keys");
  }

  const marketOrderRejection = validateMarketOrderSafety(submission.intent, safetyConfig);
  if (marketOrderRejection !== undefined) {
    return marketOrderRejection;
  }

  const amountRejection = validateOrderAmounts(submission.intent);
  if (amountRejection !== undefined) {
    return amountRejection;
  }

  const costSnapshotRejection = validateCostSnapshot(submission);
  if (costSnapshotRejection !== undefined) {
    return costSnapshotRejection;
  }

  const riskApprovalRejection = validateRiskApproval(submission);
  if (riskApprovalRejection !== undefined) {
    return riskApprovalRejection;
  }

  return {
    valid: true,
  };
}

function validateMarketOrderSafety(
  intent: OrderIntent,
  safetyConfig: ExecutionSafetyConfig,
): ExecutionSubmissionValidationResult | undefined {
  if (intent.orderType !== "MARKET") {
    return undefined;
  }

  if (!safetyConfig.marketOrderEnabled) {
    // 기본 paper profile은 시장가 체결 시뮬레이션을 닫아 둔다.
    return reject("market_order_disabled", "Market order execution is disabled in the paper profile", {
      order_type: intent.orderType,
    });
  }

  if (isEntryMarketOrderIntent(intent) && !safetyConfig.entryMarketOrderEnabled) {
    // 청산/축소 목적 시장가는 별도 toggle로 허용할 수 있지만, 신규 진입 시장가는 더 보수적으로 다시 막는다.
    return reject(
      "entry_market_order_disabled",
      "Entry market order execution is disabled by the MVP execution boundary",
      {
        order_type: intent.orderType,
        position_effect: readStringMetadata(intent.metadata, "position_effect"),
      },
    );
  }

  return undefined;
}

function validateOrderAmounts(intent: OrderIntent): ExecutionSubmissionValidationResult | undefined {
  const invalidFields: string[] = [];

  // broker가 해석할 금융 숫자는 모두 양수 Decimal 문자열이어야 하며, JS number 정밀도 손실 경로는 받지 않는다.
  appendInvalidPositiveDecimalField(invalidFields, "requested_quantity", intent.requestedQuantity);
  appendInvalidPositiveDecimalField(invalidFields, "requested_notional", intent.requestedNotional);
  if (intent.orderType === "LIMIT") {
    appendInvalidPositiveDecimalField(invalidFields, "requested_price", intent.requestedPrice);
  }

  if (invalidFields.length === 0) {
    return undefined;
  }

  return reject("order_amount_invalid", "Execution order amount fields must be positive decimal strings", {
    invalid_fields: invalidFields,
  });
}

function validateCostSnapshot(
  submission: OrderSubmission,
): ExecutionSubmissionValidationResult | undefined {
  const snapshot = submission.costSnapshot;
  if (!isNonEmptyRecord(snapshot)) {
    // 비용 검증 없이 들어온 주문은 기대수익이 비용과 safety buffer를 넘는지 알 수 없으므로 broker에 넘기지 않는다.
    return reject("cost_snapshot_missing", "Execution submission requires a cost snapshot");
  }

  if (
    snapshot.source !== "cost_model" ||
    snapshot.trade_allowed !== true ||
    snapshot.reason_code !== "cost_margin_ok" ||
    hasProblemFieldList(snapshot.missing_fields) ||
    hasProblemFieldList(snapshot.invalid_fields)
  ) {
    // 비용 snapshot은 allow flag뿐 아니라 정상 판정 사유와 입력 상태까지 execution 승인 조건으로 삼는다.
    return reject("cost_snapshot_not_allowed", "Cost snapshot must allow the trade with an OK margin reason", {
      source: snapshot.source,
      trade_allowed: snapshot.trade_allowed,
      reason_code: snapshot.reason_code,
      missing_fields: snapshot.missing_fields,
      invalid_fields: snapshot.invalid_fields,
    });
  }

  const mismatches: JsonRecord = {};
  appendStringMismatch(mismatches, "cost_snapshot_exchange_id", snapshot.exchange_id, submission.intent.exchangeId);
  appendStringMismatch(mismatches, "cost_snapshot_market", snapshot.market, submission.intent.market);

  const costOrderIntent = snapshot.order_intent;
  if (!isNonEmptyRecord(costOrderIntent)) {
    // 비용 snapshot이 어떤 주문 후보를 평가했는지 모르면 같은 market의 오래된 allow 결과를 재사용할 수 있다.
    return reject("cost_snapshot_mismatch", "Cost snapshot requires order intent fingerprint");
  }

  Object.assign(mismatches, compareCostSnapshotOrderIntent(submission, costOrderIntent));

  if (Object.keys(mismatches).length > 0) {
    // exchange/market만 같아도 수량, 방향, idempotency key가 다르면 비용 승인 근거가 다른 후보의 것이다.
    return reject("cost_snapshot_mismatch", "Cost snapshot does not match the execution order intent", {
      mismatches,
    });
  }

  return undefined;
}

function validateRiskApproval(
  submission: OrderSubmission,
): ExecutionSubmissionValidationResult | undefined {
  const riskApproval = submission.riskApproval;
  if (!isNonEmptyRecord(riskApproval)) {
    // RiskGate 승인 근거가 없으면 주문 한도, 손실 한도, kill switch 조건을 통과했는지 증명할 수 없다.
    return reject("risk_approval_missing", "Execution submission requires RiskGate approval evidence");
  }

  if (
    riskApproval.source !== "risk_gate" ||
    riskApproval.approved !== true ||
    riskApproval.action !== "ALLOW" ||
    !isApprovalCapableRiskStatus(riskApproval.status) ||
    hasProblemFieldList(riskApproval.failed_evaluation_reason_codes)
  ) {
    // RiskGate 승인은 출처, 상태, action, 실패 평가 목록이 모두 실행 가능 상태일 때만 유효하다.
    return reject("risk_approval_not_approved", "RiskGate evidence must be an approval-capable ALLOW result", {
      source: riskApproval.source,
      approved: riskApproval.approved,
      action: riskApproval.action,
      status: riskApproval.status,
      failed_evaluation_reason_codes: riskApproval.failed_evaluation_reason_codes,
    });
  }

  const riskOrderIntent = riskApproval.order_intent;
  if (!isNonEmptyRecord(riskOrderIntent)) {
    // RiskGate approval은 반드시 당시 주문 후보 fingerprint와 함께 저장되어야 현재 submission과 대조할 수 있다.
    return reject("risk_approval_missing", "RiskGate evidence requires order intent fingerprint");
  }

  const mismatches = compareRiskApprovalOrderIntent(submission, riskOrderIntent);
  if (Object.keys(mismatches).length > 0) {
    // RiskGate 승인 후 후보가 바뀌면 이전 approval을 재사용하지 않고 broker 직전에서 차단한다.
    return reject("risk_approval_mismatch", "RiskGate evidence does not match the execution order intent", {
      mismatches,
    });
  }

  return undefined;
}

function compareCostSnapshotOrderIntent(
  submission: OrderSubmission,
  costOrderIntent: JsonRecord,
): JsonRecord {
  // 비용 snapshot에 붙은 후보 fingerprint와 현재 submission fingerprint를 같은 비교 규칙으로 맞춘다.
  return compareOrderIntentEvidence(
    costOrderIntent,
    createOrderIntentEvidence(submission.intent, readSubmissionExpectedLossBps(submission)),
  );
}

function compareRiskApprovalOrderIntent(
  submission: OrderSubmission,
  riskOrderIntent: JsonRecord,
): JsonRecord {
  // RiskGate approval에 붙은 후보 fingerprint와 현재 submission fingerprint를 같은 비교 규칙으로 맞춘다.
  return compareOrderIntentEvidence(
    riskOrderIntent,
    createOrderIntentEvidence(submission.intent, readSubmissionExpectedLossBps(submission)),
  );
}

function appendInvalidPositiveDecimalField(
  target: string[],
  fieldName: string,
  value: string,
): void {
  try {
    if (!parseFinancialDecimal(value).greaterThan(0)) {
      target.push(fieldName);
    }
  } catch {
    target.push(fieldName);
  }
}

function appendStringMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue = typeof evidenceValue === "string" ? evidenceValue : undefined;
  if (normalizedEvidenceValue !== runtimeValue) {
    target[`${fieldName}_evidence`] = normalizedEvidenceValue;
    target[`${fieldName}_runtime`] = runtimeValue;
  }
}

function isApprovalCapableRiskStatus(value: unknown): boolean {
  return value === "PASS" || value === "WARN";
}

function hasProblemFieldList(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function isNonEmptyRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function reject(
  reasonCode: ExecutionRejectionReasonCode,
  message: string,
  metadata?: JsonRecord,
): ExecutionSubmissionValidationResult {
  return {
    valid: false,
    rejection: metadata === undefined ? { reasonCode, message } : { reasonCode, message, metadata },
  };
}
