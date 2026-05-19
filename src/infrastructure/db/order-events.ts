import type { Insertable, Selectable } from "kysely";
import type {
  JsonRecord,
  OrderLifecycleStatus,
  StateTransitionEventCandidate,
} from "../../domain/index.js";
import type { Database } from "./database.js";
import type { AuditEventsTable, OrderEventsTable } from "./schema.js";

export type OrderEventRecord = Selectable<OrderEventsTable>;
export type OrderEventRowInput = Insertable<OrderEventsTable>;
export type StateTransitionAuditRowInput = Insertable<AuditEventsTable>;

export interface AppendOrderStateTransitionEventInput {
  orderId: string;
  correlationId?: string;
  event: StateTransitionEventCandidate<OrderLifecycleStatus>;
}

export interface ListOrderEventsOptions {
  orderId: string;
  limit?: number;
}

/**
 * 주문 상태 전이 event를 `order_events`에 append-only로 저장하는 repository다.
 */
export class PostgresOrderEventRepository {
  public constructor(private readonly database: Database) {}

  /**
   * 주문 상태 전이 event를 append하고 저장된 row를 반환한다.
   */
  public async appendStateTransition(
    input: AppendOrderStateTransitionEventInput,
  ): Promise<OrderEventRecord> {
    return appendOrderStateTransitionEvent(this.database, input);
  }

  /**
   * 단일 주문의 상태 전이 event log를 최신순으로 조회한다.
   */
  public async listByOrderId(options: ListOrderEventsOptions): Promise<OrderEventRecord[]> {
    return listOrderEventsByOrderId(this.database, options);
  }
}

/**
 * 주문 상태 전이 event를 `order_events`에 append한다.
 */
export async function appendOrderStateTransitionEvent(
  database: Database,
  input: AppendOrderStateTransitionEventInput,
): Promise<OrderEventRecord> {
  const inserted = await database
    .insertInto("order_events")
    .values(toOrderEventRow(input))
    .returningAll()
    .executeTakeFirstOrThrow();

  return inserted;
}

/**
 * 주문 상태 전이 event log를 주문 기준으로 조회한다.
 */
export async function listOrderEventsByOrderId(
  database: Database,
  options: ListOrderEventsOptions,
): Promise<OrderEventRecord[]> {
  const limit = options.limit ?? 100;
  // 조회 limit은 운영 화면/장애 분석 쿼리가 실수로 과도한 범위를 읽지 않도록 방어한다.
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("order event query limit must be a positive safe integer");
  }

  return database
    .selectFrom("order_events")
    .selectAll()
    .where("order_id", "=", options.orderId)
    .orderBy("occurred_at", "desc")
    .limit(limit)
    .execute();
}

/**
 * domain 상태 전이 event 후보를 `order_events` insert row로 변환한다.
 */
export function toOrderEventRow(input: AppendOrderStateTransitionEventInput): OrderEventRowInput {
  // order_events는 주문 lifecycle 전이만 저장해 kill switch 같은 시스템 전이는 audit_events로 분리한다.
  if (input.event.eventKind !== "ORDER_STATE_TRANSITION") {
    throw new Error("order_events only accepts ORDER_STATE_TRANSITION events");
  }

  const row: OrderEventRowInput = {
    order_id: input.orderId,
    event_type: input.event.eventKind,
    from_status: input.event.fromState,
    to_status: input.event.toState,
    accepted: input.event.accepted,
    reason_code: input.event.reasonCode,
    message: input.event.message,
    correlation_id: input.correlationId ?? null,
    payload_json: toStateTransitionPayload(input.event),
    occurred_at: input.event.occurredAt,
  };

  return row;
}

export interface StateTransitionAuditRowOptions<State extends string> {
  event: StateTransitionEventCandidate<State>;
  actor: string;
  orderId?: string;
  correlationId?: string;
  strategyId?: string;
}

/**
 * 상태 전이 event 후보를 `audit_events` insert row로 변환한다.
 */
export function toStateTransitionAuditRow<State extends string>(
  options: StateTransitionAuditRowOptions<State>,
): StateTransitionAuditRowInput {
  const payload = toStateTransitionPayload(options.event);
  assignIfDefined(payload, "strategy_id", options.strategyId);

  // 거부된 전이는 운영자가 먼저 볼 수 있도록 WARN 감사 이벤트로 남긴다.
  const row: StateTransitionAuditRowInput = {
    event_type: "STATE_TRANSITION",
    severity: options.event.accepted ? "INFO" : "WARN",
    order_id: options.orderId ?? null,
    correlation_id: options.correlationId ?? null,
    payload_json: {
      ...payload,
      actor: options.actor,
      reason_code: options.event.reasonCode,
    },
    occurred_at: options.event.occurredAt,
  };

  return row;
}

/**
 * 상태 전이 event의 공통 payload를 만든다.
 */
function toStateTransitionPayload<State extends string>(
  event: StateTransitionEventCandidate<State>,
): JsonRecord {
  const payload: JsonRecord = {
    event_kind: event.eventKind,
    from_state: event.fromState,
    to_state: event.toState,
    accepted: event.accepted,
    reason_code: event.reasonCode,
    message: event.message,
  };

  // 상태 전이 metadata는 원본 shape를 유지해 후속 장애 분석에서 판단 근거를 잃지 않게 한다.
  assignIfDefined(payload, "metadata", event.metadata);

  return payload;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
