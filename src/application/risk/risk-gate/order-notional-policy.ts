import type { Decimal } from "decimal.js";
import type {
  OrderIntent,
  RiskGateContext,
  RiskGateEvaluation,
  RiskThresholdSnapshot,
} from "../../../domain/index.js";
import { readPositiveDecimal } from "./decimal-read.js";
import { fail, pass, withThresholdSnapshot } from "./evaluation-factory.js";
import type { DecimalRead, ParsedThresholds } from "./types.js";

/**
 * 단일 주문 금액이 계정 평가액 대비 1%를 초과하는지 평가한다.
 *
 * 이미 계산된 bps 값을 threshold와 비교하고, 주문 금액 원문을 metadata에 남겨 승인/차단 근거를 재현 가능하게 한다.
 */
export function evaluateOrderNotionalLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
  orderNotionalBps: Decimal,
): RiskGateEvaluation {
  return withThresholdSnapshot(
    orderNotionalBps.greaterThan(thresholds.maxOrderNotionalBpsOfEquity)
      ? fail("order_notional_limit_exceeded", "Order notional exceeds the account equity limit", "BLOCK_NEW_ORDER", {
          order_notional_bps_of_equity: orderNotionalBps.toFixed(),
          requested_notional_krw: context.orderIntent.requestedNotional,
          threshold_bps: thresholds.maxOrderNotionalBpsOfEquity.toFixed(),
        })
      : pass("order_notional_limit_clear", "Order notional is within the account equity limit", {
          order_notional_bps_of_equity: orderNotionalBps.toFixed(),
          requested_notional_krw: context.orderIntent.requestedNotional,
          threshold_bps: thresholds.maxOrderNotionalBpsOfEquity.toFixed(),
        }),
    context.thresholdSnapshot,
  );
}

/**
 * 주문 후보 notional을 계정 평가액 대비 bps로 환산한다.
 *
 * LIMIT 주문은 가격과 수량 곱이 requestedNotional과 일치해야 하며, 불일치하면 한도 계산 대신 fail-closed evaluation을 반환한다.
 */
export function calculateOrderNotionalBps(
  orderIntent: OrderIntent,
  equityKrw: Decimal,
  thresholdSnapshot: RiskThresholdSnapshot,
): DecimalRead {
  const requestedNotional = readPositiveDecimal(orderIntent.requestedNotional, "order_intent.requested_notional", {
    reasonCode: "order_notional_invalid",
    message: "Order requested notional must be a positive decimal string",
  });
  if (requestedNotional.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedNotional.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedNotional.value === undefined) {
    return {
      value: undefined,
    };
  }

  const canonicalNotional = readCanonicalOrderNotional(orderIntent, requestedNotional.value, thresholdSnapshot);
  if (canonicalNotional.evaluation !== undefined || canonicalNotional.value === undefined) {
    return canonicalNotional;
  }

  // 계정 평가액 대비 주문 크기를 bps로 환산해 설정 threshold와 같은 단위로 비교한다.
  return {
    value: canonicalNotional.value.dividedBy(equityKrw).times(10000),
  };
}

function readCanonicalOrderNotional(
  orderIntent: OrderIntent,
  requestedNotional: Decimal,
  thresholdSnapshot: RiskThresholdSnapshot,
): DecimalRead {
  if (orderIntent.orderType !== "LIMIT") {
    return {
      value: requestedNotional,
    };
  }

  const requestedPrice = readPositiveDecimal(orderIntent.requestedPrice, "order_intent.requested_price", {
    reasonCode: "order_price_invalid",
    message: "Limit order requested price must be a positive decimal string",
  });
  if (requestedPrice.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedPrice.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedPrice.value === undefined) {
    return {
      value: undefined,
    };
  }

  const requestedQuantity = readPositiveDecimal(orderIntent.requestedQuantity, "order_intent.requested_quantity", {
    reasonCode: "order_quantity_invalid",
    message: "Limit order requested quantity must be a positive decimal string",
  });
  if (requestedQuantity.evaluation !== undefined) {
    return {
      evaluation: withThresholdSnapshot(requestedQuantity.evaluation, thresholdSnapshot),
      value: undefined,
    };
  }
  if (requestedQuantity.value === undefined) {
    return {
      value: undefined,
    };
  }

  const calculatedNotional = requestedPrice.value.times(requestedQuantity.value);

  if (!calculatedNotional.equals(requestedNotional)) {
    // LIMIT 주문은 broker가 가격과 수량으로 제출하므로 notional 불일치를 한도 우회로 보아 차단한다.
    return {
      evaluation: withThresholdSnapshot(
        fail("order_notional_mismatch", "Limit order requested notional must equal price multiplied by quantity", "BLOCK_NEW_ORDER", {
          requested_notional_krw: requestedNotional.toFixed(),
          calculated_notional_krw: calculatedNotional.toFixed(),
          requested_price: requestedPrice.value.toFixed(),
          requested_quantity: requestedQuantity.value.toFixed(),
        }),
        thresholdSnapshot,
      ),
      value: undefined,
    };
  }

  return {
    value: calculatedNotional,
  };
}
