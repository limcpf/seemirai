import { sql } from "kysely";
import type { Insertable, Selectable, Transaction } from "kysely";
import type { PaperFillSimulationResult } from "../../application/execution/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  NumericString,
  OrderLifecycleStatus,
  OrderSubmission,
  StateTransitionEventCandidate,
  TimeInForce,
  TimestampInput,
} from "../../domain/index.js";
import { transitionOrderState } from "../../domain/index.js";
import { toStorageDecimalString } from "../../shared/index.js";
import type { Database } from "./database.js";
import { toOrderEventRow } from "./order-events.js";
import type {
  DatabaseSchema,
  FillsTable,
  OrderEventsTable,
  OrdersTable,
  PaperOrdersTable,
  PositionsTable,
} from "./schema.js";

export type ExecutionOrderRecord = Selectable<OrdersTable>;
export type PaperOrderRecord = Selectable<PaperOrdersTable>;
export type FillRecord = Selectable<FillsTable>;
export type PositionRecord = Selectable<PositionsTable>;
export type ExecutionOrderEventRecord = Selectable<OrderEventsTable>;
export type ExecutionOrderRowInput = Insertable<OrdersTable>;
export type PaperOrderRowInput = Insertable<PaperOrdersTable>;
export type FillRowInput = Insertable<FillsTable>;

type ExecutionPersistenceTransaction = Transaction<DatabaseSchema>;

export interface PersistPaperExecutionInput {
  submission: OrderSubmission;
  brokerOrder: BrokerOrder;
  correlationId?: string;
  simulatedLatencyMs?: number;
}

export interface PersistPaperExecutionResult {
  created: boolean;
  order: ExecutionOrderRecord;
  paperOrder?: PaperOrderRecord;
  fills: readonly FillRecord[];
  position?: PositionRecord;
  orderEvents: readonly ExecutionOrderEventRecord[];
}

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
 * 함수 형태를 노출한다.
 */
export async function persistPaperExecutionInTransaction(
  database: ExecutionPersistenceTransaction,
  input: PersistPaperExecutionInput,
): Promise<PersistPaperExecutionResult> {
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

/**
 * broker 제출 직전까지 승인된 주문 intent를 `orders` insert row로 변환한다.
 */
export function toExecutionOrderRowInput(input: PersistPaperExecutionInput): ExecutionOrderRowInput {
  const { intent } = input.submission;
  const row: ExecutionOrderRowInput = {
    exchange: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    status: "RISK_APPROVED",
    idempotency_key: intent.idempotencyKey,
    requested_price: intent.orderType === "LIMIT" ? toStorageDecimalString(intent.requestedPrice) : null,
    requested_quantity: toStorageDecimalString(intent.requestedQuantity),
    requested_notional: toStorageDecimalString(intent.requestedNotional),
    reason_json: createOrderReasonPayload(input),
    created_at: input.submission.submittedAt,
    updated_at: input.submission.submittedAt,
  };

  return row;
}

/**
 * paper broker 전용 실행 metadata를 `paper_orders` insert row로 변환한다.
 */
export function toPaperOrderRowInput(
  orderId: string,
  input: PersistPaperExecutionInput,
): PaperOrderRowInput {
  const intent = input.submission.intent;
  const row: PaperOrderRowInput = {
    order_id: orderId,
    post_only: intent.orderType === "LIMIT" && (intent.postOnly === true || intent.timeInForce === "POST_ONLY"),
    time_in_force: intent.orderType === "LIMIT" ? toPaperOrderTimeInForce(intent.timeInForce) : null,
    simulated_latency_ms: input.simulatedLatencyMs ?? null,
    fill_model_json: createPaperOrderFillModelPayload(input),
    submitted_at: input.submission.submittedAt,
    accepted_at: input.brokerOrder.acceptedAt ?? null,
    completed_at: isTerminalOrderStatus(input.brokerOrder.status) ? input.brokerOrder.updatedAt : null,
  };

  return row;
}

/**
 * paper fill simulation 결과를 `fills` insert row 배열로 변환한다.
 */
export function toFillRowInputs(
  orderId: string,
  input: PersistPaperExecutionInput,
): readonly FillRowInput[] {
  const simulation = readPaperFillSimulation(input.brokerOrder);
  if (simulation === undefined || simulation.fills.length === 0) {
    return [];
  }

  const quoteCurrency = parseMarketQuoteCurrency(input.brokerOrder.market);
  return simulation.fills.map((fill) => ({
    order_id: orderId,
    exchange: input.brokerOrder.exchangeId,
    market: input.brokerOrder.market,
    side: input.brokerOrder.side,
    price: toStorageDecimalString(fill.price),
    quantity: toStorageDecimalString(fill.quantity),
    fee: toStorageDecimalString(fill.fee),
    fee_currency: quoteCurrency,
    liquidity: fill.liquidity,
    filled_at: simulation.orderbookReceivedAt ?? input.brokerOrder.updatedAt,
  }));
}

/**
 * paper broker 최종 상태를 상태 machine이 허용하는 주문 lifecycle event sequence로 확장한다.
 */
export function createPaperExecutionStateTransitionEvents(
  input: PersistPaperExecutionInput,
): readonly StateTransitionEventCandidate<OrderLifecycleStatus>[] {
  const targetStatuses = createPaperExecutionTargetStatuses(input);
  const events: StateTransitionEventCandidate<OrderLifecycleStatus>[] = [];
  let fromState: OrderLifecycleStatus = "RISK_APPROVED";

  for (const toState of targetStatuses) {
    const decision = transitionOrderState({
      fromState,
      toState,
      occurredAt: selectTransitionTimestamp(toState, input),
      reasonCode: createPaperExecutionReasonCode(fromState, toState),
      message: `Paper execution state transition: ${fromState} -> ${toState}`,
      metadata: createStateTransitionMetadata(input),
    });

    if (!decision.accepted) {
      // 최종 broker 상태를 event log로 못 풀면 DB snapshot과 상태 machine 계약이 어긋난 것이므로 저장을 중단한다.
      throw new Error(`paper execution produced illegal order transition: ${fromState} -> ${toState}`);
    }

    events.push(decision.event);
    fromState = toState;
  }

  return events;
}

async function appendPaperExecutionStateEvents(
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

async function insertPaperExecutionFills(
  database: ExecutionPersistenceTransaction,
  orderId: string,
  input: PersistPaperExecutionInput,
): Promise<FillRecord[]> {
  const rows = toFillRowInputs(orderId, input);
  if (rows.length === 0) {
    return [];
  }

  return database.insertInto("fills").values(rows).returningAll().execute();
}

async function upsertPositionFromFills(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fills: readonly FillRecord[],
): Promise<PositionRecord | undefined> {
  let position: PositionRecord | undefined;

  for (const fill of fills) {
    if (fill.side === "BUY") {
      position = await upsertBuyPositionFill(database, order, fill);
      continue;
    }

    position = await applySellPositionFill(database, order, fill);
  }

  return position;
}

/**
 * BUY fill을 포지션 snapshot에 원자적으로 누적한다.
 *
 * 최초 포지션 생성과 기존 포지션 평균 단가 갱신을 `ON CONFLICT DO UPDATE` 하나로 묶어, 동시에 들어온 첫 fill이
 * unique constraint 경합으로 주문 persistence transaction 전체를 롤백시키지 않게 한다.
 */
async function upsertBuyPositionFill(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fill: FillRecord,
): Promise<PositionRecord> {
  const quantity = toStorageDecimalString(fill.quantity);
  const price = toStorageDecimalString(fill.price);
  const result = await sql<PositionRecord>`
    INSERT INTO positions (
      exchange,
      market,
      strategy_id,
      quantity,
      average_entry_price,
      realized_pnl,
      unrealized_pnl,
      updated_at
    )
    VALUES (
      ${order.exchange},
      ${order.market},
      ${order.strategy_id},
      ${quantity},
      ${price},
      '0',
      '0',
      ${fill.filled_at}
    )
    ON CONFLICT (exchange, market, strategy_id) DO UPDATE
    SET
      quantity = positions.quantity + EXCLUDED.quantity,
      average_entry_price = CASE
        WHEN positions.quantity + EXCLUDED.quantity = 0 THEN 0
        ELSE (
          (positions.quantity * positions.average_entry_price)
          + (EXCLUDED.quantity * EXCLUDED.average_entry_price)
        ) / (positions.quantity + EXCLUDED.quantity)
      END,
      realized_pnl = positions.realized_pnl,
      unrealized_pnl = positions.unrealized_pnl,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `.execute(database);

  const position = result.rows[0];
  if (position === undefined) {
    throw new Error("buy position upsert did not return a row");
  }

  return position;
}

/**
 * SELL fill을 기존 포지션 snapshot에 반영한다.
 *
 * 보유 snapshot이 없으면 short position을 만들지 않고 fill record만 남긴다. 이미 보유 중인 수량은 단일 `UPDATE`로
 * 차감해 realized PnL과 잔여 수량이 같은 row version을 기준으로 계산되게 한다.
 */
async function applySellPositionFill(
  database: ExecutionPersistenceTransaction,
  order: ExecutionOrderRecord,
  fill: FillRecord,
): Promise<PositionRecord | undefined> {
  const quantity = toStorageDecimalString(fill.quantity);
  const price = toStorageDecimalString(fill.price);
  const result = await sql<PositionRecord>`
    UPDATE positions
    SET
      realized_pnl = realized_pnl + ((${price}::numeric - average_entry_price) * LEAST(quantity, ${quantity}::numeric)),
      quantity = GREATEST(quantity - ${quantity}::numeric, 0),
      average_entry_price = CASE
        WHEN GREATEST(quantity - ${quantity}::numeric, 0) = 0 THEN 0
        ELSE average_entry_price
      END,
      updated_at = ${fill.filled_at}
    WHERE exchange = ${order.exchange}
      AND market = ${order.market}
      AND strategy_id = ${order.strategy_id}
    RETURNING *
  `.execute(database);

  // 보유 snapshot 없이 들어온 SELL fill은 음수 포지션을 만들지 않고 체결 record만 보존한다.
  return result.rows[0];
}

function createOrderReasonPayload(input: PersistPaperExecutionInput): JsonRecord {
  const payload: JsonRecord = {
    reason: input.submission.intent.reason,
    broker_order_id: input.brokerOrder.brokerOrderId,
    broker_status: input.brokerOrder.status,
    cost_snapshot: input.submission.costSnapshot,
    risk_approval: input.submission.riskApproval,
  };
  assignIfDefined(payload, "intent_metadata", input.submission.intent.metadata);
  assignIfDefined(payload, "expected_loss_bps_of_equity", input.submission.expectedLossBpsOfEquity);
  assignIfDefined(payload, "broker_metadata", input.brokerOrder.metadata);

  return payload;
}

function createPaperOrderFillModelPayload(input: PersistPaperExecutionInput): JsonRecord {
  const payload: JsonRecord = {
    source: "paper_broker",
    broker_order_id: input.brokerOrder.brokerOrderId,
    broker_status: input.brokerOrder.status,
  };
  assignIfDefined(payload, "paper_fill_simulation", readPaperFillSimulation(input.brokerOrder));
  assignIfDefined(payload, "broker_metadata", input.brokerOrder.metadata);
  assignIfDefined(payload, "simulated_latency_ms", input.simulatedLatencyMs);

  return payload;
}

function createStateTransitionMetadata(input: PersistPaperExecutionInput): JsonRecord {
  const payload: JsonRecord = {
    source: "paper_execution_persistence",
    broker_order_id: input.brokerOrder.brokerOrderId,
    idempotency_key: input.brokerOrder.idempotencyKey,
    broker_status: input.brokerOrder.status,
    remaining_quantity: toStorageDecimalString(input.brokerOrder.remainingQuantity),
  };
  assignIfDefined(payload, "paper_fill_reason_code", readPaperFillSimulation(input.brokerOrder)?.reasonCode);

  return payload;
}

function createPaperExecutionTargetStatuses(input: PersistPaperExecutionInput): readonly OrderLifecycleStatus[] {
  const finalStatus = input.brokerOrder.status;
  switch (finalStatus) {
    case "SUBMITTED":
      return ["SUBMITTED"];
    case "ACCEPTED":
      return ["SUBMITTED", "ACCEPTED"];
    case "PARTIALLY_FILLED":
      return ["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"];
    case "FILLED":
      return ["SUBMITTED", "ACCEPTED", "FILLED"];
    case "CANCELED":
      if (hasPaperFills(input)) {
        // IOC 부분체결 후 취소처럼 fill이 있는 취소 주문은 lifecycle event만으로도 부분체결 이력을 복구할 수 있어야 한다.
        return ["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "CANCELED"];
      }
      return ["SUBMITTED", "ACCEPTED", "CANCEL_REQUESTED", "CANCELED"];
    case "REJECTED":
      return ["SUBMITTED", "REJECTED"];
    case "EXPIRED":
      return ["SUBMITTED", "ACCEPTED", "EXPIRED"];
    case "FAILED":
      return ["SUBMITTED", "FAILED"];
    case "MANUAL_REVIEW_REQUIRED":
      return ["SUBMITTED", "MANUAL_REVIEW_REQUIRED"];
    default:
      throw new Error(`paper execution final status is not persistable from RISK_APPROVED: ${finalStatus}`);
  }
}

function selectTransitionTimestamp(
  toState: OrderLifecycleStatus,
  input: PersistPaperExecutionInput,
): TimestampInput {
  if (toState === "SUBMITTED") {
    return input.submission.submittedAt;
  }

  if (toState === "ACCEPTED") {
    return input.brokerOrder.acceptedAt ?? input.brokerOrder.updatedAt;
  }

  return input.brokerOrder.updatedAt;
}

function createPaperExecutionReasonCode(
  fromState: OrderLifecycleStatus,
  toState: OrderLifecycleStatus,
): string {
  return `paper_execution_${fromState.toLowerCase()}_to_${toState.toLowerCase()}`;
}

function toPaperOrderTimeInForce(timeInForce: TimeInForce | undefined): "GTC" | "IOC" | "FOK" | null {
  if (timeInForce === undefined || timeInForce === "POST_ONLY") {
    // DB는 post-only를 boolean으로 보존하므로 POST_ONLY sentinel은 time_in_force에 중복 저장하지 않는다.
    return null;
  }

  return timeInForce;
}

function isTerminalOrderStatus(status: OrderLifecycleStatus): boolean {
  return status === "FILLED" || status === "CANCELED" || status === "REJECTED" || status === "EXPIRED" || status === "FAILED";
}

function hasPaperFills(input: PersistPaperExecutionInput): boolean {
  return (readPaperFillSimulation(input.brokerOrder)?.fills.length ?? 0) > 0;
}

function readPaperFillSimulation(order: BrokerOrder): PaperFillSimulationResult | undefined {
  const simulation = order.metadata?.paper_fill_simulation;
  if (isPaperFillSimulationResult(simulation)) {
    return simulation;
  }

  return undefined;
}

function isPaperFillSimulationResult(value: unknown): value is PaperFillSimulationResult {
  if (!isJsonRecord(value) || !Array.isArray(value.fills)) {
    return false;
  }

  return typeof value.status === "string" && typeof value.orderStatus === "string";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMarketQuoteCurrency(market: string): string {
  const separatorIndex = market.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === market.length - 1) {
    throw new Error(`execution persistence requires market codes in QUOTE-BASE format: ${market}`);
  }

  return market.slice(0, separatorIndex).trim().toUpperCase();
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
