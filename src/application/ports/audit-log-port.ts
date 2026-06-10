import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export type AuditEventType =
  | "ALERT_COOLDOWN"
  | "DAILY_REPORT"
  | "LLM_RISK_ASSISTANT"
  | "LIVE_ORDER_APPROVAL"
  | "NOTIFICATION_DELIVERY"
  | "ORDER_DECISION"
  | "PHASE_1_5_ALT_APPROVAL"
  | "PILOT_PRIVATE_API_EVIDENCE"
  | "RISK_REJECTION"
  | "STATE_TRANSITION"
  | "TELEGRAM_INBOUND_COMMAND"
  | "REGISTRY_CONFIG_VALIDATION";

export type AuditSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";

/**
 * 운영 판단 근거를 append-only로 남기기 위한 audit event payload다.
 *
 * 주문 판단, risk rejection, state transition, registry/config validation 같은 사람이 나중에 추적해야 하는
 * 사건을 같은 형태로 기록한다.
 */
export interface AuditEvent {
  eventType: AuditEventType;
  severity?: AuditSeverity;
  occurredAt: TimestampInput;
  actor: string;
  reasonCode: string;
  orderId?: string;
  correlationId?: string;
  strategyId?: string;
  metadata?: JsonRecord;
}

/**
 * audit event 저장 결과다.
 *
 * 호출자는 receipt를 이용해 동일한 판단이 audit log에 실제로 남았는지 검증하거나 후속 로그와 연결한다.
 */
export interface AuditEventReceipt {
  auditEventId: string;
  appendedAt: TimestampInput;
}

/**
 * 감사 로그 저장소가 구현해야 하는 application port다.
 *
 * application layer는 이 port에 append만 요청하고, PostgreSQL 저장 방식이나 retention 정책은
 * infrastructure가 담당한다.
 */
export interface AuditLogPort {
  /** audit event를 append-only log로 저장한다. */
  appendEvent(event: AuditEvent): Promise<AuditEventReceipt>;
}
