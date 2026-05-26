import { parseFinancialDecimal } from "../../../shared/index.js";
import type {
  JsonRecord,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
} from "../../../domain/index.js";
import type { ExecutionOrderIntentEvidence } from "./types.js";

/**
 * 저장된 evidence fingerprint와 runtime fingerprint의 차이를 JSON-safe mismatch map으로 만든다.
 *
 * 금융 숫자는 Decimal 정규화 후 비교해 `"1.0"`과 `"1"` 같은 표현 차이를 제거한다. expected loss는 RiskGate 한도
 * 판단의 필수 입력이므로 양쪽에 정규화 가능한 값이 없으면 mismatch로 기록한다.
 */
export function compareOrderIntentEvidence(
  evidence: JsonRecord,
  runtime: JsonRecord,
): JsonRecord {
  const mismatches: JsonRecord = {};

  appendStringMismatch(mismatches, "exchange_id", evidence.exchange_id, readStringRecordValue(runtime, "exchange_id"));
  appendStringMismatch(mismatches, "market", evidence.market, readStringRecordValue(runtime, "market"));
  appendStringMismatch(
    mismatches,
    "strategy_id",
    evidence.strategy_id,
    readStringRecordValue(runtime, "strategy_id"),
  );
  appendStringMismatch(mismatches, "side", evidence.side, readStringRecordValue(runtime, "side"));
  appendStringMismatch(mismatches, "order_type", evidence.order_type, readStringRecordValue(runtime, "order_type"));
  appendStringMismatch(
    mismatches,
    "idempotency_key",
    evidence.idempotency_key,
    readStringRecordValue(runtime, "idempotency_key"),
  );
  appendStringMismatch(
    mismatches,
    "position_effect",
    evidence.position_effect,
    readStringRecordValue(runtime, "position_effect"),
  );
  appendBooleanMismatch(mismatches, "post_only", evidence.post_only, readBooleanRecordValue(runtime, "post_only"));
  appendStringMismatch(
    mismatches,
    "time_in_force",
    evidence.time_in_force,
    readStringRecordValue(runtime, "time_in_force"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_quantity",
    evidence.requested_quantity,
    readStringRecordValue(runtime, "requested_quantity"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_notional",
    evidence.requested_notional,
    readStringRecordValue(runtime, "requested_notional"),
  );
  appendDecimalMismatch(
    mismatches,
    "requested_price",
    evidence.requested_price,
    readStringRecordValue(runtime, "requested_price"),
  );
  appendRequiredDecimalMismatch(
    mismatches,
    "expected_loss_bps_of_equity",
    evidence.expected_loss_bps_of_equity,
    readStringRecordValue(runtime, "expected_loss_bps_of_equity"),
  );

  return mismatches;
}

/**
 * OrderIntent와 expected loss를 execution evidence에서 쓰는 canonical JSON fingerprint로 변환한다.
 *
 * 이 함수가 CostModel/RiskGate/idempotency guard의 공통 비교 기준이다. 시장가 주문의 entry/reduce 분기와 지정가
 * 주문의 post-only/time-in-force는 체결/취소 side effect를 바꾸므로 fingerprint에 포함한다.
 */
export function createOrderIntentEvidence(
  intent: OrderIntent,
  expectedLossBpsOfEquity?: string,
): ExecutionOrderIntentEvidence {
  const evidence: ExecutionOrderIntentEvidence = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: normalizeFinancialDecimalString(intent.requestedQuantity),
    requested_notional: normalizeFinancialDecimalString(intent.requestedNotional),
    idempotency_key: intent.idempotencyKey,
  };

  const positionEffect = readOrderIntentPositionEffect(intent);
  if (positionEffect !== undefined) {
    // position effect는 시장가 신규 진입 차단 여부를 바꾸므로 approval 이후 metadata 변경도 mismatch로 잡는다.
    evidence.position_effect = positionEffect;
  }

  if (intent.orderType === "LIMIT") {
    // LIMIT option은 후속 PaperBroker fill simulation 결과를 바꾸는 실행 조건이므로 승인 증거에 고정한다.
    evidence.requested_price = normalizeFinancialDecimalString(intent.requestedPrice);
    evidence.post_only = intent.postOnly === true;
    // PaperBroker/fill simulator의 기본 LIMIT 유효시간과 같은 의미가 되도록 누락값을 GTC로 정규화한다.
    evidence.time_in_force = intent.timeInForce ?? "GTC";
  }

  if (expectedLossBpsOfEquity !== undefined) {
    // expected loss는 RiskGate 단일 주문 손실 한도 입력이므로 주문 후보 fingerprint와 함께 보존한다.
    evidence.expected_loss_bps_of_equity = normalizeFinancialDecimalString(expectedLossBpsOfEquity);
  }

  return evidence;
}

/**
 * 시장가 주문이 신규 진입 성격인지 판정한다.
 *
 * REDUCE/EXIT metadata만 축소 주문으로 보고, metadata가 없거나 다른 값이면 보수적으로 entry로 취급해 시장가 진입 toggle을 적용한다.
 */
export function isEntryMarketOrderIntent(intent: OrderIntent): boolean {
  const positionEffect = readOrderIntentPositionEffect(intent);

  return positionEffect !== "REDUCE" && positionEffect !== "EXIT";
}

/**
 * RiskGateContext에서 execution fingerprint에 넣을 expected loss 값을 읽는다.
 *
 * runtime path는 top-level RiskGateContext 입력을 우선하고, legacy metadata 중복 저장 값은 fallback으로만 쓴다.
 */
export function readRiskGateExpectedLossBps(context: RiskGateContext): string | undefined {
  return context.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(context.orderIntent);
}

/**
 * OrderSubmission에서 execution fingerprint에 넣을 expected loss 값을 읽는다.
 *
 * submission boundary에서도 top-level 값을 우선해 metadata를 쓰지 않는 runtime 경로와 같은 fingerprint를 만든다.
 */
export function readSubmissionExpectedLossBps(submission: OrderSubmission): string | undefined {
  return submission.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(submission.intent);
}

/**
 * JSON metadata에서 string 값만 읽는다.
 *
 * 실행 안전 분기는 타입이 다른 metadata를 신뢰하지 않고, string이 아니면 없는 값으로 취급한다.
 */
export function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
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

function appendBooleanMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: boolean | undefined,
): void {
  const normalizedEvidenceValue = typeof evidenceValue === "boolean" ? evidenceValue : undefined;
  if (normalizedEvidenceValue !== runtimeValue) {
    target[`${fieldName}_evidence`] = normalizedEvidenceValue;
    target[`${fieldName}_runtime`] = runtimeValue;
  }
}

function appendDecimalMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue =
    typeof evidenceValue === "string" ? normalizeFinancialDecimalString(evidenceValue) : undefined;
  const normalizedRuntimeValue =
    runtimeValue === undefined ? undefined : normalizeFinancialDecimalString(runtimeValue);

  if (normalizedEvidenceValue !== normalizedRuntimeValue) {
    target[`${fieldName}_evidence`] = normalizedEvidenceValue;
    target[`${fieldName}_runtime`] = normalizedRuntimeValue;
  }
}

function appendRequiredDecimalMismatch(
  target: JsonRecord,
  fieldName: string,
  evidenceValue: unknown,
  runtimeValue: string | undefined,
): void {
  const normalizedEvidenceValue = readNormalizedFinancialDecimalString(evidenceValue);
  const normalizedRuntimeValue = readNormalizedFinancialDecimalString(runtimeValue);

  if (
    normalizedEvidenceValue === undefined ||
    normalizedRuntimeValue === undefined ||
    normalizedEvidenceValue !== normalizedRuntimeValue
  ) {
    // 필수 Decimal evidence는 누락도 mismatch로 남겨 손실 한도 입력이 사라진 승인 재사용을 막는다.
    target[`${fieldName}_evidence`] = normalizedEvidenceValue ?? null;
    target[`${fieldName}_runtime`] = normalizedRuntimeValue ?? null;
  }
}

function normalizeFinancialDecimalString(value: string): string {
  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return value;
  }
}

function readNormalizedFinancialDecimalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return undefined;
  }
}

function readStringRecordValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" ? value : undefined;
}

function readBooleanRecordValue(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];

  return typeof value === "boolean" ? value : undefined;
}

function readOrderIntentExpectedLossBps(intent: OrderIntent): string | undefined {
  return (
    readStringMetadata(intent.metadata, "expected_loss_bps_of_equity") ??
    readStringMetadata(intent.metadata, "expectedLossBpsOfEquity")
  );
}

function readOrderIntentPositionEffect(intent: OrderIntent): string | undefined {
  return (
    readStringMetadata(intent.metadata, "position_effect") ??
    readStringMetadata(intent.metadata, "positionEffect")
  );
}
