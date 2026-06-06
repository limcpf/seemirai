import {
  DECISION_LEDGER_VERSION,
  DecisionFrameCategoryValue,
  EvidenceKindValue,
  SummaryStatusValue,
} from "../../../application/decision-ledger.js";
import type {
  DecisionEvidenceItem,
  DecisionLedgerFrame,
} from "../../../application/decision-ledger.js";

const sensitiveKeyFragments = [
  "authorization",
  "apikey",
  "accesskey",
  "secretkey",
  "queryhash",
  "privatekey",
  "password",
  "cookie",
  "session",
  "token",
  "secret",
  "jwt",
  "rawproviderpayload",
  "providerpayload",
  "rawpayload",
  "raworderdetail",
  "orderdetail",
] as const;

const sensitiveStringPatterns = [
  /\bAuthorization\s*:\s*[^\r\n,;]+/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{10,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:access[_-]?token|api[_-]?key|token|session|secret)[=/][^/?&#\s]+/giu,
  /(?<![A-Za-z0-9_-])["']?(?:access[_-]?token|token|secret|password|api[_-]?key|access[_-]?key|secret[_-]?key|authorization|cookie|session)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
] as const;

/**
 * decision ledger persistence 경계의 입력 검증 오류다.
 *
 * 이 오류는 DB write 전에 JSONB-safe, secret-safe, category 조합 invariant 위반을 차단하기 위한 신호다.
 * 메시지에는 secret 원문을 포함하지 않고 field path와 위반 종류만 남긴다.
 */
export class DecisionLedgerPersistenceValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecisionLedgerPersistenceValidationError";
  }
}

/**
 * frame row로 변환하기 전에 decision ledger frame의 durable 저장 invariant를 검증한다.
 *
 * 이 함수는 외부 side effect 없이 입력 shape만 검사한다. repository는 이 검증을 통과한 frame만 insert해
 * TypeScript 단언이나 fixture cast가 DB contract를 우회하지 못하게 한다.
 *
 * @param frame DB에 저장할 decision ledger frame
 */
export function assertValidDecisionLedgerFrame(frame: DecisionLedgerFrame): void {
  if (frame.ledgerVersion !== DECISION_LEDGER_VERSION) {
    throw validationError("ledger_version", "지원하는 decision ledger contract version이 아닙니다.");
  }

  assertSecretSafeNonEmptyString("source_frame_id", frame.sourceFrameId);
  assertSecretSafeNonEmptyString("exchange", frame.exchange);
  assertNullableSecretSafeNonEmptyString("source_run_id", frame.sourceRunId);
  assertNullableSecretSafeNonEmptyString("market", frame.market);
  assertNullableSecretSafeNonEmptyString("strategy_id", frame.strategyId);
  assertNullableSecretSafeNonEmptyString("correlation_id", frame.correlationId);
  assertSecretSafeNonEmptyString("dedupe_key", frame.dedupeKey);
  assertAllowedValue(
    "category",
    frame.category,
    Object.values(DecisionFrameCategoryValue),
  );
  assertAllowedValue("summary_status", frame.summaryStatus, Object.values(SummaryStatusValue));
  assertValidDate("observed_at", frame.observedAt);
  assertValidDate("decision_at", frame.decisionAt);
  assertReasonCounts(frame.reasonCounts);
  assertDecisionLedgerJsonRecord("trace_json", frame.trace);

  if (frame.sourceRunId === null) {
    assertTraceReason("trace_json.sourceRunUnavailableReason", frame.trace.sourceRunUnavailableReason);
  }

  if (frame.correlationId === null) {
    assertTraceReason(
      "trace_json.correlationUnavailableReason",
      frame.trace.correlationUnavailableReason,
    );
  }
}

/**
 * evidence row로 변환하기 전에 evidence item의 durable 저장 invariant를 검증한다.
 *
 * EXPLANATION_FAILURE와 EXPLANATION_FAILED 전용 조합, JSONB-safe payload/trace, secret 후보 차단을
 * DB insert 직전 경계에서 강제해 잘못된 evidence가 append-only ledger에 남지 않게 한다.
 *
 * @param frameId evidence가 연결될 frame DB id
 * @param item DB에 저장할 evidence item
 */
export function assertValidDecisionLedgerEvidenceItem(
  frameId: string,
  item: DecisionEvidenceItem,
): void {
  assertSecretSafeNonEmptyString("frame_id", frameId);
  assertAllowedValue("evidence_kind", item.evidenceKind, Object.values(EvidenceKindValue));
  assertSecretSafeNonEmptyString("user_message", item.userMessage);
  assertNullableSecretSafeNonEmptyString("reason_code", item.reasonCode);
  assertNullableSecretSafeNonEmptyString("impact", item.impact);
  assertNullableSecretSafeNonEmptyString("action", item.action);
  assertSecretSafeNonEmptyString("source", item.source);
  assertNullableSecretSafeNonEmptyString("source_id", item.sourceId);
  assertSecretSafeNonEmptyString("evidence_fingerprint", item.evidenceFingerprint);
  assertValidDate("occurred_at", item.occurredAt);
  assertDecisionLedgerJsonRecord("payload_json", item.payload);
  assertDecisionLedgerJsonRecord("trace_json", item.trace);

  const isExplanationFailure = item.evidenceKind === "EXPLANATION_FAILURE";
  const isExplanationFailedCategory = item.category === "EXPLANATION_FAILED";
  if (isExplanationFailure !== isExplanationFailedCategory) {
    throw validationError(
      "category",
      "EXPLANATION_FAILURE evidence는 EXPLANATION_FAILED category와만 함께 저장할 수 있습니다.",
    );
  }

  if (!isExplanationFailure) {
    assertAllowedValue(
      "category",
      item.category,
      Object.values(DecisionFrameCategoryValue),
    );
  }
}

/**
 * ledger JSONB root 값이 secret 후보 없는 JSON object인지 검증한다.
 *
 * Date, BigInt, function, class instance, circular reference는 JSONB 저장 경계에서 의미가 바뀌거나 실패할 수 있으므로
 * repository 입력으로 허용하지 않는다.
 *
 * @param path 오류 메시지에 남길 field path
 * @param value 검사할 JSON root 값
 */
export function assertDecisionLedgerJsonRecord(path: string, value: unknown): void {
  assertPlainObject(path, value);
  assertJsonValue(path, value, new WeakSet<object>());
}

function assertJsonValue(path: string, value: unknown, visiting: WeakSet<object>): void {
  if (value === null) {
    return;
  }

  if (typeof value === "string") {
    assertSecretSafeString(path, value);
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError(path, "유한한 number 값만 JSONB payload에 저장할 수 있습니다.");
    }
    return;
  }

  if (typeof value === "boolean") {
    return;
  }

  if (typeof value !== "object") {
    throw validationError(path, "JSONB-safe primitive, array, object만 허용합니다.");
  }

  if (value instanceof Date) {
    throw validationError(path, "Date 객체는 ISO 문자열로 정규화한 뒤 저장해야 합니다.");
  }

  if (visiting.has(value)) {
    throw validationError(path, "circular reference는 JSONB payload에 저장할 수 없습니다.");
  }

  visiting.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(`${path}[${index}]`, item, visiting);
    }
    visiting.delete(value);
    return;
  }

  assertPlainObject(path, value);

  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    assertSecretSafeKey(path, key);
    assertJsonValue(toSafeObjectPath(path, key), entryValue, visiting);
  }

  visiting.delete(value);
}

function assertReasonCounts(reasonCounts: unknown): void {
  assertPlainObject("reason_counts_json", reasonCounts);

  for (const [reasonCode, count] of Object.entries(reasonCounts as Record<string, unknown>)) {
    assertSecretSafeNonEmptyString("reason_counts_json key", reasonCode);
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw validationError(
        toSafeObjectPath("reason_counts_json", reasonCode),
        "reason count는 0 이상의 안전한 정수여야 합니다.",
      );
    }
  }
}

function assertTraceReason(path: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(path, "식별자가 null이면 한국어 누락 사유를 trace에 남겨야 합니다.");
  }
  assertSecretSafeString(path, value);
}

function assertNonEmptyString(path: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(path, "빈 문자열은 저장할 수 없습니다.");
  }
}

function assertSecretSafeNonEmptyString(path: string, value: unknown): void {
  assertNonEmptyString(path, value);
  assertSecretSafeString(path, value as string);
}

function assertNullableSecretSafeNonEmptyString(path: string, value: unknown): void {
  if (value === null) {
    return;
  }

  assertSecretSafeNonEmptyString(path, value);
}

function assertAllowedValue(path: string, value: unknown, allowedValues: readonly string[]): void {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw validationError(path, "허용된 decision ledger contract 값이 아닙니다.");
  }
}

function assertValidDate(path: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError(path, "유효한 Date 객체여야 합니다.");
  }
}

function assertPlainObject(path: string, value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw validationError(path, "JSONB root와 nested object는 plain object여야 합니다.");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(path, "class instance는 JSONB payload에 저장할 수 없습니다.");
  }
}

function assertSecretSafeKey(parentPath: string, key: string): void {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (sensitiveKeyFragments.some((fragment) => normalized.includes(fragment))) {
    throw validationError(
      `${parentPath}.[redacted_key]`,
      "secret 또는 raw payload 후보 key는 ledger JSONB에 저장할 수 없습니다.",
    );
  }
}

function assertSecretSafeString(path: string, value: string): void {
  for (const pattern of sensitiveStringPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      throw validationError(path, "secret 후보 문자열은 ledger JSONB에 저장할 수 없습니다.");
    }
  }
}

function validationError(path: string, reason: string): DecisionLedgerPersistenceValidationError {
  return new DecisionLedgerPersistenceValidationError(`decision ledger ${path}: ${reason}`);
}

/**
 * validation error에 사용할 JSON object path를 만든다.
 *
 * key 자체가 secret 후보이면 운영 로그에 원문이 남지 않도록 안정적인 redacted segment만 반환한다.
 */
function toSafeObjectPath(parentPath: string, key: string): string {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (sensitiveKeyFragments.some((fragment) => normalized.includes(fragment))) {
    return `${parentPath}.[redacted_key]`;
  }
  return `${parentPath}.${key}`;
}
