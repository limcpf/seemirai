import type { OrderLifecycleStatus, StateTransitionEventCandidate } from "../../../domain/index.js";
import { toOrderEventRow } from "../order-events.js";
import { createPaperExecutionStateTransitionEvents } from "./state-transition-mapper.js";
import type { ExecutionOrderEventRecord, ExecutionPersistenceTransaction, PersistPaperExecutionInput } from "./types.js";

/**
 * paper execution 상태 전이를 append-only order event log와 orders snapshot에 함께 반영한다.
 *
 * event append와 snapshot update를 같은 transaction에 묶어 장애 복구 시 event log와 현재 상태 중 어느 쪽을 읽어도 같은
 * lifecycle을 관측하게 한다.
 */
export async function appendPaperExecutionStateEvents(
  database: ExecutionPersistenceTransaction,
  orderId: string,
  input: PersistPaperExecutionInput,
): Promise<ExecutionOrderEventRecord[]> {
  const events: ExecutionOrderEventRecord[] = [];

  for (const event of createPaperExecutionStateTransitionEvents(input)) {
    const orderEvent = await database
      .insertInto("order_events")
      .values(toOrderEventRow(createOrderEventAppendInput(orderId, input, event)))
      .returningAll()
      .executeTakeFirstOrThrow();

    // event append와 orders snapshot 갱신을 같은 transaction 안에서 처리해 복구 기준을 하나로 유지한다.
    const updatedOrder = await database
      .updateTable("orders")
      .set({
        status: event.toState,
        updated_at: event.occurredAt,
      })
      .where("id", "=", orderId)
      .where("status", "=", event.fromState)
      .returning("id")
      .executeTakeFirst();
    if (updatedOrder === undefined) {
      throw new Error("paper execution order transition target order not found or current status mismatch");
    }

    events.push(orderEvent);
  }

  return events;
}

function createOrderEventAppendInput(
  orderId: string,
  input: PersistPaperExecutionInput,
  event: StateTransitionEventCandidate<OrderLifecycleStatus>,
) {
  const appendInput = {
    orderId,
    event,
  };
  if (input.correlationId === undefined) {
    return appendInput;
  }

  return {
    ...appendInput,
    correlationId: input.correlationId,
  };
}
