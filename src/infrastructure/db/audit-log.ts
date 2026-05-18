import type { Insertable, Selectable } from "kysely";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../../application/index.js";
import type { Database } from "./database.js";
import type { AuditEventsTable } from "./schema.js";

export type AuditEventRecord = Selectable<AuditEventsTable>;
export type AuditEventRowInput = Insertable<AuditEventsTable>;

/**
 * PostgreSQL `audit_events` 테이블에 append-only audit log를 저장하는 repository다.
 */
export class PostgresAuditLogRepository implements AuditLogPort {
  public constructor(private readonly database: Database) {}

  /**
   * audit event를 `audit_events`에 append하고 저장된 row id를 receipt로 돌려준다.
   */
  public async appendEvent(event: AuditEvent): Promise<AuditEventReceipt> {
    return appendAuditEvent(this.database, event);
  }
}

/**
 * 함수형 호출에서 audit event를 append한다.
 */
export async function appendAuditEvent(
  database: Database,
  event: AuditEvent,
): Promise<AuditEventReceipt> {
  const inserted = await database
    .insertInto("audit_events")
    .values(toAuditEventRow(event))
    .returning("id")
    .executeTakeFirstOrThrow();

  return {
    auditEventId: inserted.id,
    appendedAt: new Date(),
  };
}

/**
 * application `AuditEvent`를 DB insert row로 변환한다.
 *
 * actor, reason code, strategy id는 사람이 추적하기 쉬운 공통 payload로 보존하고, correlation id는
 * `audit_events.correlation_id`에 별도로 저장한다.
 */
export function toAuditEventRow(event: AuditEvent): AuditEventRowInput {
  const payloadJson = {
    ...(event.metadata ?? {}),
    actor: event.actor,
    reason_code: event.reasonCode,
    ...(event.strategyId === undefined ? {} : { strategy_id: event.strategyId }),
  };
  const row: AuditEventRowInput = {
    event_type: event.eventType,
    severity: event.severity ?? "INFO",
    order_id: event.orderId ?? null,
    correlation_id: event.correlationId ?? null,
    payload_json: payloadJson,
    occurred_at: event.occurredAt,
  };

  return row;
}
