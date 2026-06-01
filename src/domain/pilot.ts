import type { JsonRecord, TimestampInput } from "./types.js";

/**
 * v0.2 pilot runtime이 허용하는 private API profile 식별자다.
 *
 * runtime env guard, status summary, audit/reporting evidence가 같은 profile 값을 공유하기 위한 domain contract다. 이 값은
 * profile 선택만 표현하며, 외부 API 호출이나 DB write 같은 side effect를 직접 만들지 않는다.
 */
export type PilotProfileId = "PILOT_READ_ONLY" | "PILOT_POLICY_SYNC" | "PILOT_ORDER_SMOKE";

/**
 * v0.2 pilot에서 허용되는 Upbit API key 권한 이름이다.
 *
 * 운영자가 확인한 key scope evidence와 runtime guard가 비교하는 업무 값이다. 출금/입출금/레버리지 권한은 이 union에 없으므로
 * 후속 private API 조립 전에 fail-closed 되어야 하며, 이 타입 자체는 외부 side effect가 없다.
 */
export type PilotKeyScope = "자산조회" | "주문조회" | "주문하기";

/**
 * pilot private API evidence의 운영 상태 code다.
 *
 * audit log, `/status`, daily report가 같은 상태 축으로 private smoke 결과를 기록하기 위한 안정 식별자다. 사용자에게는
 * 별도 한국어 label/message를 먼저 보여주고, 이 code는 추적 정보로 보존한다.
 */
export type PilotEvidenceStatus = "SKIPPED" | "PASSED" | "FAILED" | "MANUAL_REVIEW_REQUIRED";

/**
 * pilot private API 실행 또는 skip 결과의 secret-safe evidence snapshot이다.
 *
 * 호출 경계는 private smoke runner, audit 변환기, status/reporting 계층이다. 입력에는 raw secret, raw Authorization/JWT,
 * provider 원문 payload를 넣지 않는 것이 invariant이며, 이 구조는 저장이나 전송 side effect 없이 evidence 값을 운반한다.
 */
export interface PilotEvidenceSnapshot {
  profile: PilotProfileId;
  status: PilotEvidenceStatus;
  occurredAt: TimestampInput;
  correlationId: string;
  message: string;
  action: string | null;
  auditEventId?: string;
  reportArtifactId?: string;
  reportArtifactPath?: string;
  safeMetadata?: JsonRecord;
}

/**
 * 외부 노출이 가능한 pilot evidence 요약이다.
 *
 * raw correlation id는 축약하고, metadata는 secret처럼 보이는 key를 한 번 더 마스킹한다. `/status`와 report formatter는 이
 * 구조만 사용해야 하며, 이 타입은 이미 저장된 evidence를 읽기 전용으로 표현하므로 외부 side effect가 없다.
 */
export interface PilotEvidenceSafeSummary {
  profile: PilotProfileId;
  status: PilotEvidenceStatus;
  statusLabel: string;
  occurredAt: string;
  correlationId: string;
  message: string;
  action: string | null;
  auditEventId?: string;
  reportArtifactId?: string;
  reportArtifactPath?: string;
  safeMetadata?: JsonRecord;
}

/**
 * `/status`와 운영 CLI에 노출할 수 있는 pilot runtime 요약이다.
 *
 * raw access/secret key는 절대 포함하지 않고, credential 존재 여부와 명시 guard 상태만 보여준다. 호출자는 이 값만 로그나
 * HTTP 응답에 넘겨야 하며, profile이 enabled라도 실제 Upbit 호출 side effect는 별도 runner가 담당한다.
 */
export interface PilotRuntimeSafeSummary {
  enabled: boolean;
  profile: PilotProfileId | null;
  privateSmokeEnabled: boolean;
  orderSmokeEnabled: boolean;
  credentialsConfigured: boolean;
  keyScopes: readonly PilotKeyScope[];
  keyScopeEvidenceId: string | null;
  policySyncMarket: string | null;
  orderSmokeMarket: string | null;
  orderSmokeMaxKrw: string | null;
  lookupOrderConfigured: boolean;
  statusLabel: string;
  message: string;
  action: string | null;
  lastEvidence: PilotEvidenceSafeSummary | null;
  trace: JsonRecord;
}

const PILOT_SENSITIVE_METADATA_KEY_PATTERN =
  /(?:authorization|credential|jwt|secret|signature|token|access[_-]?key|upbitaccesskey|upbitsecretkey)/iu;

/**
 * pilot evidence 상태 code를 운영자가 읽을 수 있는 한국어 label로 변환한다.
 *
 * audit/reporting layer는 stable code를 보존하되 사용자에게는 이 label을 먼저 보여준다. 순수 변환 함수라 외부 상태를 읽거나
 * 변경하지 않는다.
 */
export function toPilotEvidenceStatusLabel(status: PilotEvidenceStatus): string {
  switch (status) {
    case "PASSED":
      return "검증 통과";
    case "FAILED":
      return "검증 실패";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 점검 필요";
    case "SKIPPED":
      return "실행 생략";
  }
}

/**
 * pilot correlation id를 운영 화면에 남길 수 있는 축약값으로 변환한다.
 *
 * correlation id가 외부 provider 식별자를 포함할 수 있으므로 전체 값을 `/status`와 report에 노출하지 않는다. 짧은 값은
 * 재식별 가치가 낮도록 고정 마스킹하고, 긴 값은 앞/뒤 일부만 남긴다. 외부 side effect는 없다.
 */
export function redactPilotCorrelationId(correlationId: string): string {
  if (correlationId.length <= 8) {
    return "redacted";
  }

  return `${correlationId.slice(0, 6)}...${correlationId.slice(-4)}`;
}

/**
 * 저장된 pilot evidence를 status/reporting용 safe summary로 낮춘다.
 *
 * 호출자는 이미 secret-safe snapshot만 넘겨야 하지만, 이 함수는 metadata key를 한 번 더 검사해 실수로 들어온 token/secret 계열
 * 값을 마스킹한다. 순수 변환 경계이며 DB나 외부 API를 호출하지 않는다.
 */
export function toPilotEvidenceSafeSummary(evidence: PilotEvidenceSnapshot): PilotEvidenceSafeSummary {
  const summary: PilotEvidenceSafeSummary = {
    profile: evidence.profile,
    status: evidence.status,
    statusLabel: toPilotEvidenceStatusLabel(evidence.status),
    occurredAt: toTimestampString(evidence.occurredAt),
    correlationId: redactPilotCorrelationId(evidence.correlationId),
    message: evidence.message,
    action: evidence.action,
  };
  assignIfDefined(summary, "auditEventId", evidence.auditEventId);
  assignIfDefined(summary, "reportArtifactId", evidence.reportArtifactId);
  assignIfDefined(summary, "reportArtifactPath", evidence.reportArtifactPath);
  assignIfDefined(summary, "safeMetadata", sanitizePilotSafeMetadata(evidence.safeMetadata));

  return summary;
}

function toTimestampString(timestamp: TimestampInput): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function sanitizePilotSafeMetadata(metadata: JsonRecord | undefined): JsonRecord | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const sanitized = sanitizePilotRecord(metadata);
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function sanitizePilotRecord(record: JsonRecord): JsonRecord {
  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (PILOT_SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
      // evidence metadata는 이미 안전해야 하지만, secret 계열 key는 운영 노출 전에 한 번 더 마스킹한다.
      sanitized[key] = "[REDACTED]";
      continue;
    }

    sanitized[key] = sanitizePilotJsonValue(value);
  }

  return sanitized;
}

function sanitizePilotJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizePilotJsonValue);
  }

  if (value !== null && typeof value === "object") {
    return sanitizePilotRecord(value as JsonRecord);
  }

  return value;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
