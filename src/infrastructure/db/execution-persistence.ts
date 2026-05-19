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
import { parseFinancialDecimal, toStorageDecimalString } from "../../shared/index.js";
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
type FinancialDecimal = ReturnType<typeof parseFinancialDecimal>;

/**
 * PaperBroker 취소 metadata에서 persistence 검증에 필요한 최소 evidence만 추린 값이다.
 *
 * `BrokerOrder.metadata`는 JSON 경계라서 DB 저장 전에 구조를 좁혀야 하며, 여기서는 open 수량을 실제로 해소한
 * `canceled_quantity`만 상태/회계 불변식 검증에 사용한다.
 */
interface PaperCancelEvidence {
  canceledQuantity: NumericString;
}

/**
 * broker 최종 상태 기준으로 정규화한 simulation 수량이다.
 *
 * submit 시점 simulation과 cancel 시점 mutation이 나뉘어 들어와도 이후 검증은 이 구조만 보게 해서, 상태별 수량
 * 규칙이 metadata 모양에 흔들리지 않게 한다.
 */
interface EffectiveSimulationQuantities {
  requestedQuantity: FinancialDecimal;
  filledQuantity: FinancialDecimal;
  openQuantity: FinancialDecimal;
  canceledQuantity: FinancialDecimal;
}

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
  if (!shouldPersistFillRows(input.brokerOrder.status, simulation)) {
    // balance rejection처럼 simulator는 fill 후보를 만들었지만 broker가 실행을 거부한 경우 회계 근거를 쓰지 않는다.
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

/**
 * submission intent와 broker 응답의 핵심 주문 정체성이 같은지 확인한다.
 *
 * 이 검증을 통과해야 같은 `order_id` 아래 주문 snapshot, fill, position이 같은 자산/방향을 가리킨다는 전제가 성립한다.
 */
function assertBrokerOrderMatchesSubmission(input: PersistPaperExecutionInput): void {
  const intent = input.submission.intent;
  const mismatches: string[] = [];
  addMismatchIf(mismatches, "idempotency_key", input.brokerOrder.idempotencyKey !== intent.idempotencyKey);
  addMismatchIf(mismatches, "exchange", input.brokerOrder.exchangeId !== intent.exchangeId);
  addMismatchIf(mismatches, "market", input.brokerOrder.market !== intent.market);
  addMismatchIf(mismatches, "side", input.brokerOrder.side !== intent.side);
  addMismatchIf(mismatches, "order_type", input.brokerOrder.orderType !== intent.orderType);
  addMismatchIf(
    mismatches,
    "requested_quantity",
    !decimalStringEquals(input.brokerOrder.requestedQuantity, intent.requestedQuantity),
  );

  if (intent.orderType === "LIMIT") {
    addMismatchIf(
      mismatches,
      "requested_price",
      input.brokerOrder.requestedPrice === undefined ||
        !decimalStringEquals(input.brokerOrder.requestedPrice, intent.requestedPrice),
    );
  }

  if (mismatches.length > 0) {
    throw new Error(`broker order does not match execution submission: ${mismatches.join(", ")}`);
  }
}

/**
 * idempotency key 충돌이 같은 주문의 재시도인지 확인한다.
 */
function assertExistingOrderMatchesInput(
  existingOrder: ExecutionOrderRecord,
  input: PersistPaperExecutionInput,
): void {
  const expectedOrder = toExecutionOrderRowInput(input);
  const mismatches: string[] = [];

  addMismatchIf(mismatches, "exchange", existingOrder.exchange !== expectedOrder.exchange);
  addMismatchIf(mismatches, "market", existingOrder.market !== expectedOrder.market);
  addMismatchIf(mismatches, "strategy_id", existingOrder.strategy_id !== expectedOrder.strategy_id);
  addMismatchIf(mismatches, "side", existingOrder.side !== expectedOrder.side);
  addMismatchIf(mismatches, "order_type", existingOrder.order_type !== expectedOrder.order_type);
  addMismatchIf(
    mismatches,
    "requested_price",
    !nullableDecimalStringEquals(existingOrder.requested_price, expectedOrder.requested_price ?? null, 18),
  );
  addMismatchIf(
    mismatches,
    "requested_quantity",
    !decimalStringEqualsAtScale(existingOrder.requested_quantity, expectedOrder.requested_quantity, 18),
  );
  addMismatchIf(
    mismatches,
    "requested_notional",
    !decimalStringEqualsAtScale(existingOrder.requested_notional, expectedOrder.requested_notional, 8),
  );

  if (mismatches.length > 0) {
    throw new Error(`paper execution idempotency key conflict: ${mismatches.join(", ")}`);
  }
}

/**
 * 체결 상태와 fill simulation payload가 서로 일관되는지 확인한다.
 */
function assertFillEvidenceMatchesBrokerStatus(input: PersistPaperExecutionInput): void {
  const simulation = readPaperFillSimulation(input.brokerOrder);
  if (input.brokerOrder.status === "FILLED" || input.brokerOrder.status === "PARTIALLY_FILLED") {
    if (simulation === undefined || simulation.fills.length === 0 || !isPositiveDecimalString(simulation.filledQuantity)) {
      throw new Error("filled paper execution requires fill evidence");
    }
  }

  if (simulation === undefined) {
    return;
  }

  assertSimulationStatusCompatible(input, simulation);
  assertSimulationQuantityMatchesBrokerOrder(input, simulation);

  const totalFillQuantity = simulation.fills.reduce(
    (sum, fill) => sum.add(parseFinancialDecimal(fill.quantity)),
    parseFinancialDecimal("0"),
  );
  if (!totalFillQuantity.equals(parseFinancialDecimal(simulation.filledQuantity))) {
    throw new Error("paper fill evidence quantity does not match simulation filled quantity");
  }

  if (isPositiveDecimalString(simulation.filledQuantity) && simulation.fills.length === 0) {
    throw new Error("positive paper fill quantity requires at least one fill row");
  }
}

function assertSimulationStatusCompatible(
  input: PersistPaperExecutionInput,
  simulation: PaperFillSimulationResult,
): void {
  if (simulation.orderStatus === input.brokerOrder.status) {
    return;
  }

  if (input.brokerOrder.status === "CANCELED" && readPaperCancelEvidence(input.brokerOrder) !== undefined) {
    // PaperBroker 취소 응답은 원 fill simulation을 그대로 보존하고 최종 취소 evidence를 별도 metadata로 남긴다.
    return;
  }

  if (input.brokerOrder.status === "REJECTED" && input.brokerOrder.metadata?.paper_balance_rejection !== undefined) {
    // 잔고 부족 거부는 simulator가 만든 체결 후보를 실제 broker 실행으로 승격하지 않는 예외 경로다.
    return;
  }

  throw new Error("paper simulation order status does not match broker order status");
}

function assertSimulationQuantityMatchesBrokerOrder(
  input: PersistPaperExecutionInput,
  simulation: PaperFillSimulationResult,
): void {
  const quantities = createEffectiveSimulationQuantities(input, simulation);
  const accountedQuantity = quantities.filledQuantity.add(quantities.openQuantity).add(quantities.canceledQuantity);

  if (!accountedQuantity.equals(quantities.requestedQuantity)) {
    throw new Error("paper simulation quantities do not add up to requested quantity");
  }

  if (input.brokerOrder.status === "REJECTED") {
    return;
  }

  if (!decimalStringEqualsAtScale(input.brokerOrder.requestedQuantity, simulation.requestedQuantity, 18)) {
    throw new Error("paper simulation requested quantity does not match broker order requested quantity");
  }

  if (!parseFinancialDecimal(input.brokerOrder.remainingQuantity).equals(quantities.openQuantity)) {
    throw new Error("paper simulation open quantity does not match broker order remaining quantity");
  }

  assertStateSpecificQuantityInvariants(input, quantities);
}

/**
 * broker 최종 상태 기준의 수량 breakdown을 만든다.
 *
 * PaperBroker `cancelOrder`는 최초 submit 시점의 `paper_fill_simulation`을 수정하지 않고, 취소로 해소된 open 수량을
 * `paper_cancel.balance_mutation`에 별도로 기록한다. persistence 경계에서는 이 두 evidence를 합쳐야 `orders.status`,
 * `fills`, `positions`가 같은 lifecycle을 바라본다.
 */
function createEffectiveSimulationQuantities(
  input: PersistPaperExecutionInput,
  simulation: PaperFillSimulationResult,
): EffectiveSimulationQuantities {
  const requestedQuantity = parseFinancialDecimal(simulation.requestedQuantity);
  const filledQuantity = parseFinancialDecimal(simulation.filledQuantity);
  const openQuantity = parseFinancialDecimal(simulation.openQuantity);
  const canceledQuantity = parseFinancialDecimal(simulation.canceledQuantity);
  const paperCancel = readPaperCancelEvidence(input.brokerOrder);

  if (input.brokerOrder.status !== "CANCELED" || paperCancel === undefined) {
    return {
      requestedQuantity,
      filledQuantity,
      openQuantity,
      canceledQuantity,
    };
  }

  const cancelCanceledQuantity = parseFinancialDecimal(paperCancel.canceledQuantity);
  if (!cancelCanceledQuantity.equals(openQuantity)) {
    throw new Error("paper cancel quantity does not match open simulation quantity");
  }

  return {
    requestedQuantity,
    filledQuantity,
    // 취소 evidence가 open 수량을 해소했으므로 최종 broker snapshot에서는 잔여 수량을 0으로 본다.
    openQuantity: parseFinancialDecimal("0"),
    canceledQuantity: canceledQuantity.add(cancelCanceledQuantity),
  };
}

function assertStateSpecificQuantityInvariants(
  input: PersistPaperExecutionInput,
  quantities: EffectiveSimulationQuantities,
): void {
  const { requestedQuantity, filledQuantity, openQuantity, canceledQuantity } = quantities;
  const remainingQuantity = parseFinancialDecimal(input.brokerOrder.remainingQuantity);

  if (input.brokerOrder.status === "FILLED") {
    if (!filledQuantity.equals(requestedQuantity) || !openQuantity.equals(0) || !canceledQuantity.equals(0)) {
      throw new Error("filled paper execution quantity breakdown is inconsistent");
    }
    if (!remainingQuantity.equals(0)) {
      throw new Error("filled paper execution must not have remaining quantity");
    }
    return;
  }

  if (input.brokerOrder.status === "PARTIALLY_FILLED") {
    if (
      !filledQuantity.greaterThan(0) ||
      !openQuantity.greaterThan(0) ||
      !openQuantity.lessThan(requestedQuantity) ||
      !canceledQuantity.equals(0)
    ) {
      throw new Error("partially filled paper execution requires positive open quantity below requested quantity");
    }
    return;
  }

  if (input.brokerOrder.status === "CANCELED") {
    if (!remainingQuantity.equals(0) || !openQuantity.equals(0)) {
      throw new Error("canceled paper execution must not have remaining quantity");
    }
    if (!canceledQuantity.greaterThan(0) || !filledQuantity.lessThan(requestedQuantity)) {
      throw new Error("canceled paper execution requires positive canceled quantity below requested quantity");
    }
    return;
  }

  if (input.brokerOrder.status === "ACCEPTED") {
    if (!filledQuantity.equals(0) || !canceledQuantity.equals(0) || !openQuantity.equals(requestedQuantity)) {
      throw new Error("accepted paper execution must keep the full requested quantity open");
    }
  }
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
  return (
    status === "FILLED" ||
    status === "CANCELED" ||
    status === "REJECTED" ||
    status === "EXPIRED" ||
    status === "FAILED" ||
    status === "MANUAL_REVIEW_REQUIRED"
  );
}

function hasPaperFills(input: PersistPaperExecutionInput): boolean {
  return (readPaperFillSimulation(input.brokerOrder)?.fills.length ?? 0) > 0;
}

function shouldPersistFillRows(
  brokerStatus: OrderLifecycleStatus,
  simulation: PaperFillSimulationResult,
): boolean {
  if (brokerStatus === "FILLED" || brokerStatus === "PARTIALLY_FILLED") {
    return true;
  }

  return brokerStatus === "CANCELED" && isPositiveDecimalString(simulation.filledQuantity);
}

function readPaperFillSimulation(order: BrokerOrder): PaperFillSimulationResult | undefined {
  const simulation = order.metadata?.paper_fill_simulation;
  if (isPaperFillSimulationResult(simulation)) {
    return simulation;
  }

  return undefined;
}

/**
 * PaperBroker `paper_cancel` JSON에서 취소 수량 evidence를 읽는다.
 *
 * 외부 입력과 같은 JSON metadata는 타입 선언만 믿지 않고 runtime 구조를 확인한다. 구조가 맞지 않으면 evidence가
 * 없는 것으로 취급해 기존 status/quantity 검증이 fail-closed 하도록 둔다.
 */
function readPaperCancelEvidence(order: BrokerOrder): PaperCancelEvidence | undefined {
  const cancel = order.metadata?.paper_cancel;
  if (!isJsonRecord(cancel)) {
    return undefined;
  }

  const balanceMutation = cancel.balance_mutation;
  if (!isJsonRecord(balanceMutation) || typeof balanceMutation.canceled_quantity !== "string") {
    return undefined;
  }

  return {
    canceledQuantity: balanceMutation.canceled_quantity,
  };
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

function addMismatchIf(mismatches: string[], field: string, mismatch: boolean): void {
  if (mismatch) {
    mismatches.push(field);
  }
}

function nullableDecimalStringEquals(
  left: NumericString | null,
  right: NumericString | null,
  scale: number,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return decimalStringEqualsAtScale(left, right, scale);
}

function decimalStringEquals(left: NumericString, right: NumericString): boolean {
  return parseFinancialDecimal(left).equals(parseFinancialDecimal(right));
}

function decimalStringEqualsAtScale(left: NumericString, right: NumericString, scale: number): boolean {
  return parseFinancialDecimal(left).toDecimalPlaces(scale).equals(parseFinancialDecimal(right).toDecimalPlaces(scale));
}

function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}
