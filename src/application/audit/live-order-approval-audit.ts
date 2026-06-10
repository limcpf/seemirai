import type { LiveOrderApprovalEvidenceSnapshot } from "../../domain/index.js";
import type { AuditEvent } from "../ports/index.js";
import type { JsonRecord } from "../../domain/index.js";

const SENSITIVE_METADATA_KEY_PATTERN =
  /(?:authorization|credential|jwt|secret|signature|token|access[_-]?key|upbitaccesskey|upbitsecretkey|raw[_-]?text|provider[_-]?body)/iu;

/**
 * M21 approval evidence를 audit event로 변환할 때 필요한 입력이다.
 *
 * `evidence`는 이미 raw Telegram text/provider body/token/API key/JWT가 제거된 projection이어야 한다. actor는 업무 주체만
 * 표현하며, caller chat/user 원문은 evidence의 hash projection으로만 남긴다.
 */
export interface CreateLiveOrderApprovalAuditEventInput {
  evidence: LiveOrderApprovalEvidenceSnapshot;
  actor?: string;
  correlationId?: string;
}

/**
 * M21 proposal/approval/submission evidence를 `audit_events` append 입력으로 변환한다.
 *
 * audit payload에는 proposal fingerprint, idempotency key, budget/risk/decision ledger id만 남기며 raw Telegram update,
 * raw message text, provider body, token, API key, JWT는 복사하지 않는다. 이 함수는 순수 projection이고 DB write side effect는
 * `AuditLogPort` 구현체가 담당한다.
 */
export function createLiveOrderApprovalAuditEvent(
  input: CreateLiveOrderApprovalAuditEventInput,
): AuditEvent {
  return {
    eventType: "LIVE_ORDER_APPROVAL",
    severity: toLiveOrderApprovalAuditSeverity(input.evidence),
    occurredAt: input.evidence.occurredAt,
    actor: input.actor ?? "live_manual_approval",
    reasonCode: input.evidence.reasonCode,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    metadata: createLiveOrderApprovalAuditMetadata(input.evidence),
  };
}

function createLiveOrderApprovalAuditMetadata(evidence: LiveOrderApprovalEvidenceSnapshot): JsonRecord {
  const metadata: JsonRecord = {
    audit_kind: evidence.auditKind,
    evidence_kind: evidence.evidenceKind,
    proposal_id: evidence.proposalId,
    proposal_status: evidence.proposalStatus,
    proposal_fingerprint: evidence.proposalFingerprint,
    exchange_id: evidence.exchangeId,
    market: evidence.market,
    side: evidence.side,
    order_type: evidence.orderType,
    expected_notional_krw: evidence.expectedNotionalKrw,
    configured_max_order_krw: evidence.configuredMaxOrderKrw,
    daily_approved_notional_limit_krw: evidence.dailyApprovedNotionalLimitKrw,
    daily_approved_notional_used_krw: evidence.dailyApprovedNotionalUsedKrw,
    decision_ledger_id: evidence.decisionLedgerId,
    risk_decision_id: evidence.riskDecisionId,
    idempotency_key: evidence.idempotencyKey,
  };

  assignIfDefined(metadata, "actor_hash", evidence.actorHash);
  assignIfDefined(metadata, "broker_order_id", evidence.brokerOrderId);
  assignIfDefined(metadata, "safe_metadata", sanitizeLiveOrderApprovalMetadata(evidence.metadata));

  return metadata;
}

function toLiveOrderApprovalAuditSeverity(
  evidence: LiveOrderApprovalEvidenceSnapshot,
): NonNullable<AuditEvent["severity"]> {
  switch (evidence.evidenceKind) {
    case "SUBMISSION_FAILURE_RECORDED":
      return "ERROR";
    case "REJECTION_RECORDED":
    case "EXPIRATION_RECORDED":
      return "WARN";
    case "PROPOSAL_CREATED":
    case "APPROVAL_RECORDED":
    case "SUBMISSION_RECHECK_PASSED":
    case "BROKER_SUBMISSION_RECORDED":
      return "INFO";
  }
}

function sanitizeLiveOrderApprovalMetadata(metadata: JsonRecord | undefined): JsonRecord | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const sanitized: JsonRecord = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) {
      // caller가 실수로 raw provider/secret 계열 metadata를 넣어도 audit payload로 그대로 흐르지 않게 마지막 경계에서 마스킹한다.
      sanitized[key] = "[REDACTED]";
      continue;
    }

    sanitized[key] = sanitizeLiveOrderApprovalMetadataValue(value);
  }

  return sanitized;
}

function sanitizeLiveOrderApprovalMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeLiveOrderApprovalMetadataValue);
  }

  if (value !== null && typeof value === "object") {
    return sanitizeLiveOrderApprovalMetadata(value as JsonRecord);
  }

  return value;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
