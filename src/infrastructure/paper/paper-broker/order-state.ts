import type { PaperFillSimulationResult } from "../../../application/execution/index.js";
import type {
  BrokerOrder,
  ExchangeId,
  JsonRecord,
  OrderIntent,
  OrderLifecycleStatus,
  OrderSubmission,
  TimestampInput,
} from "../../../domain/index.js";
import { normalizeDecimalString } from "./decimal-math.js";
import { isPositiveDecimalString } from "./decimal-math.js";
import type {
  PaperBrokerBalanceMutationSummary,
  PaperBrokerCancelMutationSummary,
  PaperBrokerExchangeRejectionSummary,
  PaperBrokerOrderState,
} from "./types.js";

/**
 * broker 인스턴스와 주문 intent의 exchange id mismatch를 거부 evidence로 만든다.
 *
 * 같은 PaperBroker 인스턴스 안에서 서로 다른 거래소 호가와 잔고가 섞이면 이후 risk/audit evidence가 무의미해지므로 fill
 * simulation 이전에 차단한다.
 */
export function createExchangeRejection(
  intent: OrderIntent,
  brokerExchangeId: ExchangeId,
): PaperBrokerExchangeRejectionSummary | undefined {
  if (intent.exchangeId === brokerExchangeId) {
    return undefined;
  }

  return {
    reason_code: "paper_exchange_mismatch",
    broker_exchange_id: brokerExchangeId,
    intent_exchange_id: intent.exchangeId,
  };
}

/**
 * exchange mismatch로 거부된 broker 주문 snapshot을 만든다.
 *
 * fill simulation과 balance mutation을 건너뛰는 경로라 metadata에는 거부 evidence만 남기고 remaining quantity는 0으로 닫는다.
 */
export function createRejectedBrokerOrder(
  submission: OrderSubmission,
  brokerOrderId: string,
  rejection: PaperBrokerExchangeRejectionSummary,
  updatedAt: TimestampInput,
): BrokerOrder {
  const baseOrder: BrokerOrder = {
    brokerOrderId,
    idempotencyKey: submission.intent.idempotencyKey,
    exchangeId: submission.intent.exchangeId,
    market: submission.intent.market,
    side: submission.intent.side,
    orderType: submission.intent.orderType,
    status: "REJECTED",
    requestedQuantity: normalizeDecimalString(submission.intent.requestedQuantity),
    remainingQuantity: "0",
    updatedAt,
    metadata: {
      source: "paper_broker_memory",
      submitted_at: submission.submittedAt,
      paper_broker_rejection: rejection,
    },
  };

  if (submission.intent.orderType === "LIMIT") {
    return {
      ...baseOrder,
      requestedPrice: submission.intent.requestedPrice,
    };
  }

  return baseOrder;
}

/**
 * fill simulation과 balance mutation 결과를 canonical BrokerOrder snapshot으로 만든다.
 *
 * metadata에는 simulation과 balance evidence를 같이 보존해 execution persistence가 같은 근거로 durable row를 만들 수 있게 한다.
 */
export function createBrokerOrderFromSimulation(
  submission: OrderSubmission,
  brokerOrderId: string,
  simulation: PaperFillSimulationResult,
  balanceMutation: PaperBrokerBalanceMutationSummary,
  orderState: PaperBrokerOrderState,
  updatedAt: TimestampInput,
): BrokerOrder {
  const metadata: JsonRecord = {
    source: "paper_broker_memory",
    submitted_at: submission.submittedAt,
    paper_fill_simulation: simulation,
    balance_mutation: balanceMutation,
    balance_mutation_applied: orderState.balanceMutationApplied,
  };
  if (orderState.balanceRejection !== undefined) {
    metadata.paper_balance_rejection = orderState.balanceRejection;
  }

  const baseOrder: BrokerOrder = {
    brokerOrderId,
    idempotencyKey: submission.intent.idempotencyKey,
    exchangeId: submission.intent.exchangeId,
    market: submission.intent.market,
    side: submission.intent.side,
    orderType: submission.intent.orderType,
    status: orderState.status,
    requestedQuantity: simulation.requestedQuantity,
    remainingQuantity: orderState.remainingQuantity,
    updatedAt,
    metadata,
  };

  const orderWithPrice =
    submission.intent.orderType === "LIMIT"
      ? {
          ...baseOrder,
          requestedPrice: submission.intent.requestedPrice,
        }
      : baseOrder;

  if (isAcceptedBrokerStatus(orderWithPrice.status)) {
    return {
      ...orderWithPrice,
      acceptedAt: updatedAt,
    };
  }

  return orderWithPrice;
}

/**
 * open 주문 취소 결과 snapshot을 만든다.
 *
 * cancel mutation은 잔고 해제 side effect가 이미 적용된 근거이므로 metadata에 보존해 후속 persistence 검증이 같은 수량을
 * 확인할 수 있게 한다.
 */
export function createCanceledOrder(
  order: BrokerOrder,
  cancelMutation: PaperBrokerCancelMutationSummary,
  canceledAt: TimestampInput,
): BrokerOrder {
  return {
    ...order,
    status: "CANCELED",
    remainingQuantity: "0",
    updatedAt: canceledAt,
    metadata: {
      ...(order.metadata ?? {}),
      paper_cancel: {
        canceled_at: canceledAt,
        balance_mutation: cancelMutation,
      },
    },
  };
}

/**
 * idempotency key에 연결할 주문 fingerprint를 만든다.
 *
 * 문자열 scale 차이를 정규화해 같은 경제적 주문은 같은 fingerprint로 보고, 가격·수량·TIF가 다른 주문 재사용은 conflict로
 * 차단할 수 있게 한다.
 */
export function createSubmissionFingerprint(intent: OrderIntent): string {
  const commonFingerprint = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: normalizeDecimalString(intent.requestedQuantity),
    requested_notional: normalizeDecimalString(intent.requestedNotional),
    idempotency_key: intent.idempotencyKey,
  };

  if (intent.orderType === "LIMIT") {
    return JSON.stringify({
      ...commonFingerprint,
      requested_price: normalizeDecimalString(intent.requestedPrice),
      post_only: intent.postOnly === true,
      time_in_force: intent.timeInForce ?? "GTC",
    });
  }

  return JSON.stringify(commonFingerprint);
}

function isAcceptedBrokerStatus(status: OrderLifecycleStatus): boolean {
  return status !== "REJECTED" && status !== "FAILED";
}

/**
 * runtime cancel/requote 후보로 노출할 open broker order인지 확인한다.
 *
 * lifecycle status와 remaining quantity를 함께 확인해 terminal 주문이나 잔여 수량 없는 주문을 취소 후보에서 제외한다.
 */
export function isOpenBrokerOrder(order: BrokerOrder): boolean {
  return (
    (order.status === "SUBMITTED" || order.status === "ACCEPTED" || order.status === "PARTIALLY_FILLED") &&
    isPositiveDecimalString(order.remainingQuantity)
  );
}
