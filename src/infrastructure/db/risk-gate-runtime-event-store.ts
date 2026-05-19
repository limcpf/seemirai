import type {
  AuditEventReceipt,
  RiskGateDecisionEvidenceAppendInput,
  RiskGateDecisionEvidenceReceipt,
  RiskGateRuntimeEventStorePort,
} from "../../application/index.js";
import type { JsonRecord } from "../../domain/index.js";
import type { Transaction } from "kysely";
import type { Database } from "./database.js";
import type { DatabaseSchema } from "./schema.js";
import { toAuditEventRow } from "./audit-log.js";
import { toOrderEventRow } from "./order-events.js";
import { toRiskEventRow } from "./risk-events.js";

/**
 * RiskGate runtime evidence를 PostgreSQL에 원자적으로 저장하는 event store다.
 *
 * 주문 상태 전이, risk event, audit event를 하나의 transaction에서 저장해 중간 실패로 현재 주문 snapshot과 판단 근거가
 * 갈라지지 않게 한다. kill switch 전이 자체는 별도 table이 없으므로 같은 audit event 묶음의
 * `RISK_GATE_KILL_SWITCH_STATE_TRANSITION` receipt를 kill switch receipt로 반환한다.
 */
export class PostgresRiskGateRuntimeEventStore implements RiskGateRuntimeEventStorePort {
  public constructor(private readonly database: Database) {}

  /**
   * RiskGate 판단 evidence 전체를 같은 DB transaction 안에서 append한다.
   */
  public async appendDecisionEvidence(
    input: RiskGateDecisionEvidenceAppendInput,
  ): Promise<RiskGateDecisionEvidenceReceipt> {
    return appendRiskGateDecisionEvidence(this.database, input);
  }
}

/**
 * 함수형 호출에서 RiskGate 판단 evidence 전체를 같은 DB transaction 안에서 append한다.
 */
export async function appendRiskGateDecisionEvidence(
  database: Database,
  input: RiskGateDecisionEvidenceAppendInput,
): Promise<RiskGateDecisionEvidenceReceipt> {
  return database.transaction().execute(async (transaction) => {
    const orderEventReceipt = await transaction
      .insertInto("order_events")
      .values(toOrderEventRow(input.orderStateTransition))
      .returningAll()
      .executeTakeFirstOrThrow();

    if (input.orderStateTransition.event.accepted) {
      // combined store도 개별 repository와 같은 현재 상태 대조로 stale accepted 전이를 차단한다.
      const updatedOrder = await transaction
        .updateTable("orders")
        .set({
          status: input.orderStateTransition.event.toState,
          updated_at: input.orderStateTransition.event.occurredAt,
        })
        .where("id", "=", input.orderStateTransition.orderId)
        .where("status", "=", input.orderStateTransition.event.fromState)
        .returning("id")
        .executeTakeFirst();

      if (updatedOrder === undefined) {
        throw new Error("accepted order state transition target order not found or current status mismatch");
      }
    }

    const riskEventReceipts = [];
    for (const riskEvent of input.riskEvents) {
      const insertedRiskEvent = await transaction
        .insertInto("risk_events")
        .values(toRiskEventRow(riskEvent))
        .returningAll()
        .executeTakeFirstOrThrow();
      riskEventReceipts.push(insertedRiskEvent);
    }

    const auditEventReceipts: AuditEventReceipt[] = [];
    for (const auditEvent of input.auditEvents) {
      const insertedAuditEvent = await transaction
        .insertInto("audit_events")
        .values(toAuditEventRow(auditEvent))
        .returning("id")
        .executeTakeFirstOrThrow();
      auditEventReceipts.push({
        auditEventId: insertedAuditEvent.id,
        appendedAt: new Date(),
      });
    }

    const receipt: RiskGateDecisionEvidenceReceipt = {
      orderEventReceipt,
      riskEventReceipts,
      auditEventReceipts,
    };

    if (input.killSwitchStateTransition !== undefined) {
      receipt.killSwitchEventReceipt = await updateKillSwitchSnapshot(
        transaction,
        input,
        auditEventReceipts,
      );
    }

    return receipt;
  });
}

async function updateKillSwitchSnapshot(
  transaction: Transaction<DatabaseSchema>,
  input: RiskGateDecisionEvidenceAppendInput,
  auditEventReceipts: readonly AuditEventReceipt[],
): Promise<unknown> {
  const transition = input.killSwitchStateTransition?.event;
  if (transition === undefined) {
    return undefined;
  }

  if (transition.accepted) {
    // durable kill switch snapshot도 event의 from 상태와 같을 때만 전진시켜 stale 전이를 막는다.
    const updatedState = await transaction
      .updateTable("kill_switch_state")
      .set({
        state: transition.toState,
        reason_code: transition.reasonCode,
        correlation_id: input.killSwitchStateTransition?.correlationId ?? null,
        payload_json: toStateTransitionPayload(transition),
        updated_at: transition.occurredAt,
      })
      .where("scope", "=", "global")
      .where("state", "=", transition.fromState)
      .returningAll()
      .executeTakeFirst();

    if (updatedState === undefined) {
      throw new Error("accepted kill switch state transition current state mismatch");
    }

    return {
      state: updatedState,
      auditEventReceipt: findKillSwitchAuditReceipt(input, auditEventReceipts),
    };
  }

  return {
    event: transition,
    auditEventReceipt: findKillSwitchAuditReceipt(input, auditEventReceipts),
  };
}

function findKillSwitchAuditReceipt(
  input: RiskGateDecisionEvidenceAppendInput,
  auditEventReceipts: readonly AuditEventReceipt[],
): AuditEventReceipt {
  const auditIndex = input.auditEvents.findIndex((event) =>
    event.eventType === "STATE_TRANSITION" &&
    event.reasonCode === input.killSwitchStateTransition?.event.reasonCode &&
    readStringMetadata(event.metadata, "audit_kind") === "RISK_GATE_KILL_SWITCH_STATE_TRANSITION"
  );

  if (auditIndex < 0) {
    throw new Error("kill switch state transition audit event is required");
  }

  return auditEventReceipts[auditIndex] as AuditEventReceipt;
}

function toStateTransitionPayload(event: {
  eventKind: string;
  fromState: string;
  toState: string;
  accepted: boolean;
  reasonCode: string;
  message: string;
  metadata?: JsonRecord;
}): JsonRecord {
  const payload: JsonRecord = {
    event_kind: event.eventKind,
    from_state: event.fromState,
    to_state: event.toState,
    accepted: event.accepted,
    reason_code: event.reasonCode,
    message: event.message,
  };
  if (event.metadata !== undefined) {
    payload.metadata = event.metadata;
  }

  return payload;
}

function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
