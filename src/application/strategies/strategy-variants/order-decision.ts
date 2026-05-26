import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  NumericString,
  OrderIntent,
  OrderSide,
  StrategyContext,
  StrategyDecision,
} from "../../../domain/index.js";
import { readExchangeId, readMarket, requireFeatureDecimal } from "./feature-reader.js";

/**
 * strategy signal을 지정가 OrderIntent decision으로 변환한다.
 *
 * exchange/market/price/quantity/notional feature를 모두 확인한 뒤에만 ORDER_INTENT를 만들며, 외부 broker나 DB side effect는
 * 수행하지 않는다.
 */
export function createOrderDecision(
  context: StrategyContext,
  strategyId: string,
  side: OrderSide,
  metadata: JsonRecord,
): StrategyDecision {
  const exchangeId = readExchangeId(context, strategyId);

  if (exchangeId.kind !== "value") {
    return exchangeId.decision;
  }

  const market = readMarket(context, strategyId);

  if (market.kind !== "value") {
    return market.decision;
  }

  const price = requireFeatureDecimal(context, "limit_price", strategyId);

  if (price.kind !== "value") {
    return price.decision;
  }

  const quantity = requireFeatureDecimal(context, "requested_quantity", strategyId);

  if (quantity.kind !== "value") {
    return quantity.decision;
  }

  const notional = requireFeatureDecimal(context, "requested_notional", strategyId);

  if (notional.kind !== "value") {
    return notional.decision;
  }

  // 1. 전략 단계에서는 시장가가 아니라 중심 지정가 후보만 만든다.
  const intent: OrderIntent = {
    exchangeId: exchangeId.value,
    market: market.value,
    strategyId,
    side,
    orderType: "LIMIT",
    requestedPrice: price.value.toFixed() as NumericString,
    requestedQuantity: quantity.value.toFixed() as NumericString,
    requestedNotional: notional.value.toFixed() as NumericString,
    idempotencyKey: createIdempotencyKey(context, strategyId, exchangeId.value, market.value, side),
    reason: `${strategyId}_signal`,
    postOnly: true,
    timeInForce: "GTC",
    metadata: {
      ...metadata,
      centered_limit_order: true,
      limit_price_source: "feature.limit_price",
    },
  };

  return {
    kind: "ORDER_INTENT",
    strategyId,
    reason: `${strategyId}_signal`,
    orderIntents: [intent],
    metadata: {
      ...metadata,
      intent_count: 1,
    },
  };
}

function createIdempotencyKey(
  context: StrategyContext,
  strategyId: string,
  exchangeId: ExchangeId,
  market: MarketCode,
  side: OrderSide,
): string {
  const observedAt = normalizeObservedAt(context.observedAt);
  return `${strategyId}:${exchangeId}:${market}:${side}:${observedAt}`;
}

function normalizeObservedAt(input: StrategyContext["observedAt"]): string {
  const date = input instanceof Date ? input : new Date(input);

  if (Number.isNaN(date.getTime())) {
    return String(input);
  }

  return date.toISOString();
}
