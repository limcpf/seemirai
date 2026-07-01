import type { LiveDecisionHistoryTick } from "../../../application/live-decision-history.js";
import {
  DecisionLedgerPersistenceValidationError,
  assertDecisionLedgerJsonRecord,
} from "../decision-ledger/validation.js";

const liveDecisionHistorySensitiveKeyPattern = /(?:database[_-]?url|databaseUrl|db[_-]?url|dbUrl|pg[_-]?url|pgUrl)/u;
const liveDecisionHistorySensitiveValuePattern = /postgres(?:ql)?:\/\/[^:<\s"']+:[^@<\s"']+@/u;

/**
 * live decision history persistence 검증 오류다.
 *
 * DB write 전에 secret/raw payload, JSONB 비호환 값, 허용되지 않은 decision kind를 차단하기 위한 오류이며,
 * 메시지에는 secret 원문 대신 field path와 위반 종류만 남긴다.
 */
export class LiveDecisionHistoryPersistenceValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LiveDecisionHistoryPersistenceValidationError";
  }
}

/**
 * live decision tick row 변환 전 저장 invariant를 검증한다.
 *
 * decision history는 장기 calibration evidence가 되므로 raw provider payload, Authorization/JWT, DB URL, Telegram token 같은
 * secret 후보를 JSONB와 문자열 필드 모두에서 차단한다.
 *
 * @param tick 저장할 live decision tick
 */
export function assertValidLiveDecisionHistoryTick(tick: LiveDecisionHistoryTick): void {
  assertSecretSafeNonEmptyString("exchange", tick.exchange);
  assertSecretSafeNonEmptyString("market", tick.market);
  assertSecretSafeNonEmptyString("strategy_id", tick.strategyId);
  assertSecretSafeNonEmptyString("reason_code", tick.reasonCode);
  assertSecretSafeNonEmptyString("dedupe_key", tick.dedupeKey);
  assertNullableSecretSafeNonEmptyString("correlation_id", tick.correlationId ?? null);

  if (!["HOLD", "BUY", "SELL", "BLOCK"].includes(tick.decisionKind)) {
    throw validationError("decision_kind", "허용된 live decision kind가 아닙니다.");
  }

  if (!["HOLD_REASON_1M_BUCKET", "SOURCE_TICK"].includes(tick.dedupePolicy)) {
    throw validationError("dedupe_policy", "허용된 live decision dedupe policy가 아닙니다.");
  }

  if (!Number.isSafeInteger(tick.orderIntentCount) || tick.orderIntentCount < 0) {
    throw validationError("order_intent_count", "0 이상의 안전한 정수여야 합니다.");
  }

  assertValidDate("observed_at", tick.observedAt);
  assertValidDate("decision_at", tick.decisionAt);
  assertValidDate("dedupe_bucket_started_at", tick.dedupeBucketStartedAt);
  assertLiveDecisionHistoryJsonRecord("feature_snapshot_json", tick.featureSnapshot);
  assertLiveDecisionHistoryJsonRecord("threshold_json", tick.thresholds);
  assertLiveDecisionHistoryJsonRecord("trace_json", tick.trace ?? {});
}

function assertLiveDecisionHistoryJsonRecord(path: string, value: unknown): void {
  try {
    assertDecisionLedgerJsonRecord(path, value);
  } catch (error) {
    if (error instanceof DecisionLedgerPersistenceValidationError) {
      throw validationError(path, error.message.replace(/^decision ledger [^:]+: /u, ""));
    }
    throw error;
  }
  assertNoLiveDecisionHistoryCredentialCandidate(path, value);
}

function assertNoLiveDecisionHistoryCredentialCandidate(path: string, value: unknown): void {
  if (typeof value === "string") {
    if (liveDecisionHistorySensitiveValuePattern.test(value)) {
      throw validationError(path, "DB credential URL 후보는 저장할 수 없습니다.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLiveDecisionHistoryCredentialCandidate(`${path}[${index}]`, item));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (liveDecisionHistorySensitiveKeyPattern.test(key)) {
        throw validationError(childPath, "DB credential key 후보는 저장할 수 없습니다.");
      }
      assertNoLiveDecisionHistoryCredentialCandidate(childPath, child);
    }
  }
}

function assertSecretSafeNonEmptyString(path: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(path, "빈 문자열은 저장할 수 없습니다.");
  }
  assertLiveDecisionHistoryJsonRecord(path, { value });
}

function assertNullableSecretSafeNonEmptyString(path: string, value: unknown): void {
  if (value === null) {
    return;
  }
  assertSecretSafeNonEmptyString(path, value);
}

function assertValidDate(path: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw validationError(path, "유효한 Date 객체여야 합니다.");
  }
}

function validationError(path: string, reason: string): LiveDecisionHistoryPersistenceValidationError {
  return new LiveDecisionHistoryPersistenceValidationError(
    `live decision history ${path}: ${reason}`,
  );
}
