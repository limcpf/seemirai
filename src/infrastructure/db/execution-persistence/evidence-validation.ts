import type { PaperFillSimulationResult } from "../../../application/execution/index.js";
import type { NumericString } from "../../../domain/index.js";
import { parseFinancialDecimal } from "../../../shared/index.js";
import { readPaperCancelEvidence, readPaperFillSimulation } from "./broker-evidence.js";
import {
  decimalStringEquals,
  decimalStringEqualsAtScale,
  isPositiveDecimalString,
  nullableDecimalStringEquals,
} from "./decimal-comparison.js";
import { toExecutionOrderRowInput } from "./row-mapper.js";
import type { ExecutionOrderRecord, FinancialDecimal, PersistPaperExecutionInput } from "./types.js";

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

/**
 * submission intent와 broker 응답의 핵심 주문 정체성이 같은지 확인한다.
 *
 * 이 검증을 통과해야 같은 `order_id` 아래 주문 snapshot, fill, position이 같은 자산/방향을 가리킨다는 전제가 성립한다.
 */
export function assertBrokerOrderMatchesSubmission(input: PersistPaperExecutionInput): void {
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
 *
 * 이미 저장된 주문과 새 입력이 다르면 동일 key가 다른 주문으로 재사용된 것이므로 fill/position side effect 재실행 전에
 * 중단한다.
 */
export function assertExistingOrderMatchesInput(
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
 *
 * broker 최종 상태, simulation 상태, fill row 합계, cancel evidence를 함께 대조해 DB 회계 row가 paper broker state와
 * 다른 lifecycle을 기록하지 못하게 막는다.
 */
export function assertFillEvidenceMatchesBrokerStatus(input: PersistPaperExecutionInput): void {
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

function addMismatchIf(mismatches: string[], field: string, mismatch: boolean): void {
  if (mismatch) {
    mismatches.push(field);
  }
}
