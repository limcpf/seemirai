import {
  assertBrokerOrderMatchesSubmission,
  assertExistingOrderMatchesInput,
  assertFillEvidenceMatchesBrokerStatus,
} from "./execution-persistence/evidence-validation.js";
import { insertPaperExecutionFills, upsertPositionFromFills } from "./execution-persistence/position-repository.js";
import { toExecutionOrderRowInput, toPaperOrderRowInput } from "./execution-persistence/row-mapper.js";
import { appendPaperExecutionStateEvents } from "./execution-persistence/state-event-repository.js";
import type {
  ExecutionPersistenceTransaction,
  PersistPaperExecutionInput,
  PersistPaperExecutionResult,
} from "./execution-persistence/types.js";
import type { Database } from "./database.js";

export { createPaperExecutionStateTransitionEvents } from "./execution-persistence/state-transition-mapper.js";
export { toExecutionOrderRowInput, toFillRowInputs, toPaperOrderRowInput } from "./execution-persistence/row-mapper.js";
export type {
  ExecutionOrderEventRecord,
  ExecutionOrderRecord,
  ExecutionOrderRowInput,
  FillRecord,
  FillRowInput,
  PaperOrderRecord,
  PaperOrderRowInput,
  PersistPaperExecutionInput,
  PersistPaperExecutionResult,
  PositionRecord,
} from "./execution-persistence/types.js";

/**
 * paper broker 실행 결과를 PostgreSQL 주문/체결/포지션 테이블에 원자적으로 저장하는 repository다.
 *
 * `BrokerPort`는 외부 side effect 경계이고, 이 repository는 그 결과를 durable state로 내리는 경계다. 같은
 * idempotency key는 이미 저장된 주문을 반환하고 fill/position side effect를 반복하지 않는다.
 */
export class PostgresExecutionPersistenceRepository {
  public constructor(private readonly database: Database) {}

  /**
   * paper 주문 실행 결과를 주문 snapshot, 상태 event log, fill, position snapshot으로 저장한다.
   */
  public async persistPaperExecution(
    input: PersistPaperExecutionInput,
  ): Promise<PersistPaperExecutionResult> {
    return this.database.transaction().execute(async (transaction) =>
      persistPaperExecutionInTransaction(transaction, input),
    );
  }
}

/**
 * 이미 열린 DB transaction 안에서 paper 실행 결과를 저장한다.
 *
 * runtime 조립 단계에서 다른 evidence append와 같은 transaction으로 묶어야 할 수 있으므로 class method와 별도로
 * 함수 형태를 노출한다. 입력 검증, 상태 event append, fill/position write는 같은 transaction에서 끝나야 재시도 시
 * idempotency key 하나가 durable 주문 하나만 가리키는 invariant를 유지한다.
 */
export async function persistPaperExecutionInTransaction(
  database: ExecutionPersistenceTransaction,
  input: PersistPaperExecutionInput,
): Promise<PersistPaperExecutionResult> {
  assertBrokerOrderMatchesSubmission(input);
  assertFillEvidenceMatchesBrokerStatus(input);

  const insertedOrder = await database
    .insertInto("orders")
    .values(toExecutionOrderRowInput(input))
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returningAll()
    .executeTakeFirst();

  if (insertedOrder === undefined) {
    const existingOrder = await database
      .selectFrom("orders")
      .selectAll()
      .where("idempotency_key", "=", input.submission.intent.idempotencyKey)
      .executeTakeFirstOrThrow();

    assertExistingOrderMatchesInput(existingOrder, input);

    // idempotent 재시도는 이미 반영된 fill/position을 다시 쓰지 않고 기존 주문만 돌려준다.
    return {
      created: false,
      order: existingOrder,
      fills: [],
      orderEvents: [],
    };
  }

  const paperOrder = await database
    .insertInto("paper_orders")
    .values(toPaperOrderRowInput(insertedOrder.id, input))
    .returningAll()
    .executeTakeFirstOrThrow();
  const orderEvents = await appendPaperExecutionStateEvents(database, insertedOrder.id, input);
  const order = await database
    .selectFrom("orders")
    .selectAll()
    .where("id", "=", insertedOrder.id)
    .executeTakeFirstOrThrow();
  const fills = await insertPaperExecutionFills(database, insertedOrder.id, input);
  const position = await upsertPositionFromFills(database, order, fills);

  const result: PersistPaperExecutionResult = {
    created: true,
    order,
    paperOrder,
    fills,
    orderEvents,
  };
  if (position !== undefined) {
    result.position = position;
  }

  return result;
}
