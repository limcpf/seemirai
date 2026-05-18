import { parseFinancialDecimal } from "../../shared/index.js";
import type { JsonRecord, OrderIntent, StrategyDecision } from "../../domain/index.js";

export type StrategyDecisionIntentConversionStatus = "PROMOTED" | "NO_INTENT" | "REJECTED";

/**
 * 전략 판단을 주문 후보로 승격할 때 적용할 안전 옵션이다.
 */
export interface ConvertStrategyDecisionToOrderIntentsOptions {
  allowMarketOrders?: boolean;
  metadata?: JsonRecord;
}

/**
 * 단일 주문 후보가 승격되지 못한 이유다.
 */
export interface StrategyDecisionIntentRejection {
  index: number;
  reasonCode: string;
  message: string;
}

/**
 * 전략 판단을 주문 후보로 변환한 결과다.
 */
export interface StrategyDecisionIntentConversion {
  status: StrategyDecisionIntentConversionStatus;
  orderIntents: readonly OrderIntent[];
  reasonCode: string;
  message: string;
  rejections: readonly StrategyDecisionIntentRejection[];
  metadata?: JsonRecord;
}

/**
 * StrategyDecision을 검증된 OrderIntent 목록으로 변환한다.
 *
 * HOLD/BLOCK은 주문 후보를 만들지 않고, ORDER_INTENT는 시장가 기본 차단과 필수 금융 필드를 통과한 경우에만 승격한다.
 */
export function convertStrategyDecisionToOrderIntents(
  decision: StrategyDecision,
  options: ConvertStrategyDecisionToOrderIntentsOptions = {},
): StrategyDecisionIntentConversion {
  if (decision.kind === "HOLD") {
    return createConversion("NO_INTENT", [], "strategy_hold", decision.reason, [], decision.metadata);
  }

  if (decision.kind === "BLOCK") {
    return createConversion(
      "REJECTED",
      [],
      decision.reasonCode,
      decision.reason,
      [
        {
          index: -1,
          reasonCode: decision.reasonCode,
          message: decision.reason,
        },
      ],
      decision.metadata,
    );
  }

  const rejections = decision.orderIntents.flatMap((intent, index) =>
    validateOrderIntent(intent, index, options),
  );

  if (rejections.length > 0) {
    return createConversion(
      "REJECTED",
      [],
      "order_intent_validation_failed",
      "Strategy order intents failed validation",
      rejections,
      mergeMetadata(decision.metadata, options.metadata),
    );
  }

  return createConversion(
    "PROMOTED",
    decision.orderIntents.map((intent) => withPromotionMetadata(intent, decision, options.metadata)),
    "order_intent_promoted",
    decision.reason,
    [],
    mergeMetadata(decision.metadata, options.metadata),
  );
}

function validateOrderIntent(
  intent: OrderIntent,
  index: number,
  options: ConvertStrategyDecisionToOrderIntentsOptions,
): readonly StrategyDecisionIntentRejection[] {
  const rejections: StrategyDecisionIntentRejection[] = [];

  // 1. 주문 후보 식별과 중복 방지에 필요한 불변 key를 먼저 확인한다.
  if (intent.idempotencyKey.trim().length === 0) {
    rejections.push(reject(index, "idempotency_key_missing", "idempotencyKey is required"));
  }

  // 2. MVP 기본 설정에서는 모든 시장가 주문 후보를 차단한다.
  if (intent.orderType === "MARKET" && options.allowMarketOrders !== true) {
    rejections.push(reject(index, "market_order_disabled", "Market order intents are disabled"));
  }

  // 3. 수량/금액/가격은 Decimal로 양수 검증해 number 정밀도 손실을 피한다.
  if (!isPositiveDecimal(intent.requestedQuantity)) {
    rejections.push(
      reject(index, "requested_quantity_invalid", "requestedQuantity must be a positive decimal string"),
    );
  }

  if (!isPositiveDecimal(intent.requestedNotional)) {
    rejections.push(
      reject(index, "requested_notional_invalid", "requestedNotional must be a positive decimal string"),
    );
  }

  if (intent.orderType === "LIMIT" && !isPositiveDecimal(intent.requestedPrice)) {
    rejections.push(
      reject(index, "requested_price_invalid", "LIMIT requestedPrice must be a positive decimal string"),
    );
  }

  return rejections;
}

function withPromotionMetadata(
  intent: OrderIntent,
  decision: StrategyDecision,
  metadata: JsonRecord | undefined,
): OrderIntent {
  const mergedMetadata = mergeMetadata(intent.metadata, decision.metadata, metadata, {
    strategy_decision_kind: decision.kind,
    strategy_decision_reason: decision.reason,
  });

  if (intent.orderType === "LIMIT") {
    return {
      ...intent,
      ...(mergedMetadata === undefined ? {} : { metadata: mergedMetadata }),
    };
  }

  return {
    ...intent,
    ...(mergedMetadata === undefined ? {} : { metadata: mergedMetadata }),
  };
}

function isPositiveDecimal(value: unknown): boolean {
  try {
    return parseFinancialDecimal(value).greaterThan(0);
  } catch {
    return false;
  }
}

function reject(index: number, reasonCode: string, message: string): StrategyDecisionIntentRejection {
  return {
    index,
    reasonCode,
    message,
  };
}

function createConversion(
  status: StrategyDecisionIntentConversionStatus,
  orderIntents: readonly OrderIntent[],
  reasonCode: string,
  message: string,
  rejections: readonly StrategyDecisionIntentRejection[],
  metadata?: JsonRecord,
): StrategyDecisionIntentConversion {
  if (metadata === undefined) {
    return {
      status,
      orderIntents,
      reasonCode,
      message,
      rejections,
    };
  }

  return {
    status,
    orderIntents,
    reasonCode,
    message,
    rejections,
    metadata,
  };
}

function mergeMetadata(...items: readonly (JsonRecord | undefined)[]): JsonRecord | undefined {
  const merged: JsonRecord = {};

  for (const item of items) {
    if (item !== undefined) {
      Object.assign(merged, item);
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
