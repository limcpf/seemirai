import type { PaperFillSimulationResult } from "../../../application/execution/index.js";
import type { JsonRecord, NumericString, OrderLifecycleStatus, TimeInForce } from "../../../domain/index.js";
import { toStorageDecimalString } from "../../../shared/index.js";
import { readPaperFillSimulation } from "./broker-evidence.js";
import { isPositiveDecimalString } from "./decimal-comparison.js";
import type {
  ExecutionOrderRowInput,
  FillRowInput,
  PaperOrderRowInput,
  PersistPaperExecutionInput,
} from "./types.js";

/**
 * broker 제출 직전까지 승인된 주문 intent를 `orders` insert row로 변환한다.
 *
 * 이 mapper는 DB write를 수행하지 않고 intent, cost snapshot, risk approval을 durable 주문 snapshot의 초기 상태로만
 * 정규화한다.
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
 *
 * post-only는 별도 boolean column으로 보존하고, terminal broker 상태만 cleanup 가능한 `completed_at`으로 표시한다.
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
 *
 * balance rejection처럼 simulation 후보가 있어도 broker가 실제 실행하지 않은 상태는 회계 row로 승격하지 않는다.
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

function shouldPersistFillRows(
  brokerStatus: OrderLifecycleStatus,
  simulation: PaperFillSimulationResult,
): boolean {
  if (brokerStatus === "FILLED" || brokerStatus === "PARTIALLY_FILLED") {
    return true;
  }

  return brokerStatus === "CANCELED" && isPositiveDecimalString(simulation.filledQuantity);
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
