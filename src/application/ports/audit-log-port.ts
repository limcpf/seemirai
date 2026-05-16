import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export type AuditEventType =
  | "ORDER_DECISION"
  | "RISK_REJECTION"
  | "STATE_TRANSITION"
  | "REGISTRY_CONFIG_VALIDATION";

export interface AuditEvent {
  eventType: AuditEventType;
  occurredAt: TimestampInput;
  actor: string;
  reasonCode: string;
  orderId?: string;
  strategyId?: string;
  metadata?: JsonRecord;
}

export interface AuditEventReceipt {
  auditEventId: string;
  appendedAt: TimestampInput;
}

export interface AuditLogPort {
  appendEvent(event: AuditEvent): Promise<AuditEventReceipt>;
}

