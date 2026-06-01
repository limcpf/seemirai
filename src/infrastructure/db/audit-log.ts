import type { Insertable, Selectable } from "kysely";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../../application/index.js";
import type {
  JsonRecord,
  Phase15AltApprovalEvidenceCondition,
  Phase15AltApprovalEvidenceSnapshot,
  Phase15AltEligibilityThresholds,
} from "../../domain/index.js";
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

/**
 * phase 1.5 승인/철회 audit event에서 runtime universe 해석에 필요한 evidence snapshot을 읽는다.
 *
 * 런타임 조립과 `/status`는 config의 `manual_approvals`만 신뢰하지 않고 같은 durable audit evidence를 재사용해야 한다.
 * 이 조회는 read-only이며, payload shape가 깨진 row는 신규 진입 근거가 될 수 없도록 제외한다.
 */
export async function listPhase15AltApprovalEvidenceSnapshots(
  database: Database,
): Promise<readonly Phase15AltApprovalEvidenceSnapshot[]> {
  const rows = await database
    .selectFrom("audit_events")
    .select(["occurred_at", "payload_json"])
    .where("event_type", "=", "PHASE_1_5_ALT_APPROVAL")
    .orderBy("occurred_at", "asc")
    .execute();

  return rows
    .map((row) => toPhase15AltApprovalEvidenceSnapshot(row.payload_json, row.occurred_at))
    .filter((snapshot): snapshot is Phase15AltApprovalEvidenceSnapshot => snapshot !== undefined);
}

function toPhase15AltApprovalEvidenceSnapshot(
  payload: JsonRecord,
  occurredAt: Date | string,
): Phase15AltApprovalEvidenceSnapshot | undefined {
  if (payload.audit_kind !== "PHASE_1_5_ALT_APPROVAL") {
    return undefined;
  }

  const exchangeId = readString(payload.exchange_id);
  const market = readString(payload.market);
  const action = readPhase15Action(payload.action);
  const thresholds = readThresholds(payload.thresholds);
  const conditions = readConditions(payload.conditions);

  if (exchangeId === undefined || market === undefined || action === undefined || thresholds === undefined) {
    return undefined;
  }

  const snapshot: Phase15AltApprovalEvidenceSnapshot = {
    exchangeId,
    market,
    action,
    observedAt: occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt,
    thresholds,
    conditions,
  };
  const evidenceId = readNullableString(payload.evidence_id);
  const source = readNullableString(payload.source);
  const approvedBy = readNullableString(payload.approved_by);
  const metadata = readRecord(payload.metadata);

  if (evidenceId !== undefined) {
    snapshot.evidenceId = evidenceId;
  }
  if (source !== undefined) {
    snapshot.source = source;
  }
  if (approvedBy !== undefined) {
    snapshot.approvedBy = approvedBy;
  }
  if (metadata !== undefined) {
    snapshot.metadata = metadata;
  }

  return snapshot;
}

function readThresholds(input: unknown): Phase15AltEligibilityThresholds | undefined {
  const record = readRecord(input);
  const minListingAgeDays = readNumber(record?.minListingAgeDays);
  const minThirtyDayAverageTradeValueKrw = readString(record?.minThirtyDayAverageTradeValueKrw);
  const maxSevenDaySpreadP95Bps = readString(record?.maxSevenDaySpreadP95Bps);
  const maxExpectedSlippageBps = readString(record?.maxExpectedSlippageBps);
  const minDepthKrw = readString(record?.minDepthKrw);

  if (
    minListingAgeDays === undefined ||
    minThirtyDayAverageTradeValueKrw === undefined ||
    maxSevenDaySpreadP95Bps === undefined ||
    maxExpectedSlippageBps === undefined ||
    minDepthKrw === undefined
  ) {
    return undefined;
  }

  return {
    minListingAgeDays,
    minThirtyDayAverageTradeValueKrw,
    maxSevenDaySpreadP95Bps,
    maxExpectedSlippageBps,
    minDepthKrw,
  };
}

function readConditions(input: unknown): readonly Phase15AltApprovalEvidenceCondition[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map(readCondition)
    .filter((condition): condition is Phase15AltApprovalEvidenceCondition => condition !== undefined);
}

function readCondition(input: unknown): Phase15AltApprovalEvidenceCondition | undefined {
  const record = readRecord(input);
  const key = readString(record?.key);
  const passed = typeof record?.passed === "boolean" ? record.passed : undefined;
  const reasonCode = readString(record?.reasonCode);

  if (key === undefined || passed === undefined || reasonCode === undefined || !isPhase15ConditionKey(key)) {
    return undefined;
  }

  const condition: Phase15AltApprovalEvidenceCondition = {
    key,
    passed,
    reasonCode,
  };

  if (isConditionValue(record?.actualValue)) {
    condition.actualValue = record.actualValue;
  }
  if (isConditionValue(record?.thresholdValue)) {
    condition.thresholdValue = record.thresholdValue;
  }
  const metadata = readRecord(record?.metadata);
  if (metadata !== undefined) {
    condition.metadata = metadata;
  }

  return condition;
}

function readPhase15Action(input: unknown): Phase15AltApprovalEvidenceSnapshot["action"] | undefined {
  return input === "APPROVE" || input === "REJECT" || input === "REVOKE" || input === "EXPIRE" ? input : undefined;
}

function isPhase15ConditionKey(input: string): input is Phase15AltApprovalEvidenceCondition["key"] {
  return [
    "listing_age",
    "market_warning",
    "market_caution",
    "thirty_day_average_trade_value",
    "seven_day_spread_p95",
    "expected_slippage",
    "depth",
  ].includes(input);
}

function readRecord(input: unknown): JsonRecord | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as JsonRecord : undefined;
}

function readString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function readNullableString(input: unknown): string | undefined {
  return input === null ? undefined : readString(input);
}

function readNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isConditionValue(input: unknown): input is string | boolean | number {
  return typeof input === "string" || typeof input === "boolean" || typeof input === "number";
}
