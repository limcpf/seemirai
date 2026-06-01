import {
  redactPilotCorrelationId,
  toPilotEvidenceSafeSummary,
  type PilotEvidenceSnapshot,
} from "../../domain/index.js";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../ports/index.js";

/**
 * pilot private API evidence를 audit log에 남길 때 필요한 입력이다.
 *
 * evidence는 이미 secret-safe snapshot이어야 하며, actor는 runner와 운영자 행위를 분리해 추적하기 위한 값이다. 이 타입은
 * 저장소 구현을 알지 않고, `appendPilotEvidenceAudit` 호출 전까지 외부 side effect를 만들지 않는다.
 */
export interface PilotEvidenceAuditInput {
  evidence: PilotEvidenceSnapshot;
  actor?: string;
  correlationId?: string;
}

/**
 * pilot private API evidence를 append-only audit log로 저장한다.
 *
 * private smoke 결과는 paper trading 리포트와 분리된 운영 근거이므로 audit event 하나로 profile, 상태, artifact 위치를
 * 보존한다. DB write side effect는 주입된 `AuditLogPort` 호출 하나로 제한한다.
 */
export async function appendPilotEvidenceAudit(
  auditLog: AuditLogPort,
  input: PilotEvidenceAuditInput,
): Promise<AuditEventReceipt> {
  return auditLog.appendEvent(toPilotEvidenceAuditEvent(input));
}

/**
 * pilot private API evidence를 application `AuditEvent`로 변환한다.
 *
 * payload에는 사용자에게 먼저 보여줄 한국어 상태/조치 문구와 재현에 필요한 profile/status/artifact 식별자만 넣는다. raw
 * secret, raw Authorization header, JWT는 입력 invariant와 safe summary 변환으로 audit payload에서 제외한다.
 */
export function toPilotEvidenceAuditEvent(input: PilotEvidenceAuditInput): AuditEvent {
  const evidence = input.evidence;
  const safeSummary = toPilotEvidenceSafeSummary(evidence);
  const correlationId = input.correlationId ?? evidence.correlationId;

  return {
    eventType: "PILOT_PRIVATE_API_EVIDENCE",
    severity: toPilotEvidenceAuditSeverity(evidence.status),
    occurredAt: evidence.occurredAt,
    actor: input.actor ?? "pilot_private_api_runner",
    reasonCode: toPilotEvidenceReasonCode(evidence.status),
    correlationId,
    metadata: {
      audit_kind: "PILOT_PRIVATE_API_EVIDENCE",
      status_label: safeSummary.statusLabel,
      operator_action: safeSummary.action,
      profile: safeSummary.profile,
      status: safeSummary.status,
      message: safeSummary.message,
      redacted_correlation_id: redactPilotCorrelationId(correlationId),
      audit_event_id: safeSummary.auditEventId ?? null,
      report_artifact_id: safeSummary.reportArtifactId ?? null,
      report_artifact_path: safeSummary.reportArtifactPath ?? null,
      safe_metadata: safeSummary.safeMetadata ?? {},
    },
  };
}

function toPilotEvidenceAuditSeverity(status: PilotEvidenceSnapshot["status"]): NonNullable<AuditEvent["severity"]> {
  if (status === "FAILED") {
    return "ERROR";
  }

  if (status === "MANUAL_REVIEW_REQUIRED") {
    return "WARN";
  }

  return "INFO";
}

function toPilotEvidenceReasonCode(status: PilotEvidenceSnapshot["status"]): string {
  return `pilot_private_api_${status.toLowerCase()}`;
}
