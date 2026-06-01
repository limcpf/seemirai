import type { Phase15AltApprovalEvidenceSnapshot } from "../../domain/index.js";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../ports/index.js";

/**
 * phase 1.5 알트 수동 편입 evidence를 audit log에 남길 때 필요한 입력이다.
 *
 * evidence snapshot은 승인/거부/철회/만료 판단의 업무 근거이고, actor는 실제 기록 주체를 분리한다. 이 타입은 저장소를
 * 직접 알지 않으며 `appendPhase15AltApprovalAudit` 호출 전까지 외부 side effect를 만들지 않는다.
 */
export interface Phase15AltApprovalAuditInput {
  evidence: Phase15AltApprovalEvidenceSnapshot;
  actor?: string;
  correlationId?: string;
}

/**
 * phase 1.5 알트 수동 편입 evidence를 append-only audit log로 저장한다.
 *
 * config에 승인 market만 남으면 왜 열렸는지 재구성할 수 없으므로, operator 판단 시점의 조건별 snapshot을 같은 event로
 * 보존한다. DB write side effect는 주입된 `AuditLogPort` 호출 하나로 제한한다.
 */
export async function appendPhase15AltApprovalAudit(
  auditLog: AuditLogPort,
  input: Phase15AltApprovalAuditInput,
): Promise<AuditEventReceipt> {
  return auditLog.appendEvent(toPhase15AltApprovalAuditEvent(input));
}

/**
 * phase 1.5 알트 수동 편입 evidence를 application `AuditEvent`로 변환한다.
 *
 * payload에는 사용자에게 먼저 보여줄 한국어 상태/조치 문구와, 재현에 필요한 원본 threshold/condition snapshot을 함께 남긴다.
 * 이 함수는 순수 변환 경계이며 DB나 notifier를 호출하지 않는다.
 */
export function toPhase15AltApprovalAuditEvent(input: Phase15AltApprovalAuditInput): AuditEvent {
  const evidence = input.evidence;
  const actor = input.actor ?? evidence.approvedBy ?? "phase_1_5_operator";

  return {
    eventType: "PHASE_1_5_ALT_APPROVAL",
    severity: toPhase15AltApprovalAuditSeverity(evidence.action),
    occurredAt: evidence.observedAt,
    actor,
    reasonCode: toPhase15AltApprovalReasonCode(evidence.action),
    correlationId: input.correlationId ?? evidence.evidenceId ?? createPhase15AltApprovalCorrelationId(evidence),
    metadata: {
      audit_kind: "PHASE_1_5_ALT_APPROVAL",
      status_label: toPhase15AltApprovalStatusLabel(evidence.action),
      operator_action: toPhase15AltApprovalOperatorAction(evidence.action),
      exchange_id: evidence.exchangeId,
      market: evidence.market,
      action: evidence.action,
      evidence_id: evidence.evidenceId ?? null,
      source: evidence.source ?? null,
      approved_by: evidence.approvedBy ?? null,
      thresholds: evidence.thresholds,
      conditions: evidence.conditions,
      metadata: evidence.metadata ?? {},
    },
  };
}

function toPhase15AltApprovalAuditSeverity(
  action: Phase15AltApprovalEvidenceSnapshot["action"],
): NonNullable<AuditEvent["severity"]> {
  return action === "APPROVE" ? "INFO" : "WARN";
}

function toPhase15AltApprovalReasonCode(action: Phase15AltApprovalEvidenceSnapshot["action"]): string {
  return `phase_1_5_alt_${action.toLowerCase()}`;
}

function createPhase15AltApprovalCorrelationId(evidence: Phase15AltApprovalEvidenceSnapshot): string {
  return `phase15:${evidence.exchangeId}:${evidence.market}:${evidence.action}:${String(evidence.observedAt)}`;
}

function toPhase15AltApprovalStatusLabel(action: Phase15AltApprovalEvidenceSnapshot["action"]): string {
  if (action === "APPROVE") {
    return "수동 승인";
  }
  if (action === "REJECT") {
    return "승인 거부";
  }
  if (action === "REVOKE") {
    return "승인 철회";
  }
  return "승인 만료";
}

function toPhase15AltApprovalOperatorAction(action: Phase15AltApprovalEvidenceSnapshot["action"]): string {
  if (action === "APPROVE") {
    return "조건 snapshot과 config 승인 목록을 함께 확인한다.";
  }
  if (action === "REJECT") {
    return "미충족 조건을 확인하고 universe 편입을 보류한다.";
  }
  if (action === "REVOKE") {
    return "철회된 market이 runtime universe에서 제외됐는지 확인한다.";
  }
  return "만료된 승인으로 신규 진입이 열리지 않는지 확인한다.";
}
