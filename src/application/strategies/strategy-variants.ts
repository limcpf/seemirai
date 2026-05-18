import { Decimal } from "decimal.js";
import { strategyRegistry } from "../registry.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  NumericString,
  OrderIntent,
  OrderSide,
  Strategy,
  StrategyContext,
  StrategyDecision,
} from "../../domain/index.js";

interface EntryGuardOptions {
  maxSpreadBps: string;
  minDepthKrw: string;
}

/**
 * 추세 추종 전략의 보수적 진입 threshold다.
 */
export interface TrendFollowingStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minTradeStrength: string;
  minOrderbookImbalance: string;
}

/**
 * 평균 회귀 전략의 보수적 진입 threshold다.
 */
export interface MeanReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  exitDeviationBps: string;
  stopLossBps: string;
}

/**
 * 변동성 돌파 전략의 보수적 진입 threshold다.
 */
export interface VolatilityBreakoutStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minVolatilityExpansionBps: string;
}

/**
 * 호가 불균형 모멘텀 전략의 보수적 진입 threshold다.
 */
export interface OrderbookImbalanceMomentumStrategyOptions extends EntryGuardOptions {
  minTradeStrength: string;
  minOrderbookImbalance: string;
}

/**
 * 유동성 회귀 전략의 보수적 진입 threshold다.
 */
export interface LiquidityReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  stopLossBps: string;
}

/**
 * M4 MVP에서 활성화할 5개 strategy variant의 parameter 묶음이다.
 */
export interface M4StrategyVariantOptions {
  trendFollowing: TrendFollowingStrategyOptions;
  meanReversion: MeanReversionStrategyOptions;
  volatilityBreakout: VolatilityBreakoutStrategyOptions;
  orderbookImbalanceMomentum: OrderbookImbalanceMomentumStrategyOptions;
  liquidityReversion: LiquidityReversionStrategyOptions;
}

type DecimalRead =
  | {
      status: "ok";
      value: Decimal;
    }
  | {
      status: "missing";
    }
  | {
      status: "invalid";
    };

/**
 * M4 기본 strategy variant 5개를 만든다.
 */
export function createM4StrategyVariants(options: M4StrategyVariantOptions): readonly Strategy[] {
  return [
    createTrendFollowingStrategy(options.trendFollowing),
    createMeanReversionStrategy(options.meanReversion),
    createVolatilityBreakoutStrategy(options.volatilityBreakout),
    createOrderbookImbalanceMomentumStrategy(options.orderbookImbalanceMomentum),
    createLiquidityReversionStrategy(options.liquidityReversion),
  ];
}

/**
 * 체결강도와 호가 불균형이 같은 방향으로 충분할 때 지정가 후보를 만드는 추세 추종 전략이다.
 */
export function createTrendFollowingStrategy(options: TrendFollowingStrategyOptions): Strategy {
  const maxSpreadBps = parseNonNegativeDecimal(options.maxSpreadBps, "max_spread_bps");
  const minDepthKrw = parseNonNegativeDecimal(options.minDepthKrw, "min_depth_krw");
  const minTradeStrength = parseNonNegativeDecimal(options.minTradeStrength, "min_trade_strength");
  const minOrderbookImbalance = parseNonNegativeDecimal(
    options.minOrderbookImbalance,
    "min_orderbook_imbalance",
  );

  return {
    ...strategyRegistry.trend_following,
    evaluate: (context) => {
      const guard = evaluateEntryGuards(context, "trend_following", {
        maxSpreadBps,
        minDepthKrw,
      });

      if (guard !== undefined) {
        return guard;
      }

      const tradeStrength = requireFeatureDecimal(context, "trade_strength", "trend_following");

      if (tradeStrength.kind !== "value") {
        return tradeStrength.decision;
      }

      const imbalance = requireFeatureDecimal(context, "orderbook_imbalance", "trend_following");

      if (imbalance.kind !== "value") {
        return imbalance.decision;
      }

      // 1. 모멘텀 강도와 호가 방향성이 모두 충분할 때만 주문 후보로 승격한다.
      if (tradeStrength.value.lessThan(minTradeStrength)) {
        return hold("trend_following", "trade_strength_below_threshold", {
          trade_strength: tradeStrength.value.toFixed(),
          min_trade_strength: minTradeStrength.toFixed(),
        });
      }

      const side = sideFromSignedSignal(imbalance.value, minOrderbookImbalance);

      if (side === undefined) {
        return hold("trend_following", "orderbook_imbalance_below_threshold", {
          orderbook_imbalance: imbalance.value.toFixed(),
          min_orderbook_imbalance: minOrderbookImbalance.toFixed(),
        });
      }

      const breakoutDirection = readStringFeature(context, "breakout_direction");
      const breakoutSide = sideFromDirectionFeature(breakoutDirection);

      // 2. 추세 추종은 호가 방향성만으로 주문 후보를 만들지 않고 돌파 방향 증거를 함께 요구한다.
      if (breakoutSide === undefined) {
        return hold("trend_following", "breakout_direction_absent", {
          breakout_direction: breakoutDirection,
          breakout_lookback_buckets: options.breakoutLookbackBuckets,
        });
      }

      if (breakoutSide !== side) {
        return hold("trend_following", "breakout_direction_mismatch", {
          breakout_direction: breakoutDirection,
          signal_side: side,
          breakout_side: breakoutSide,
        });
      }

      const breakoutLookback = requireFeatureDecimal(
        context,
        "breakout_lookback_buckets",
        "trend_following",
      );

      if (breakoutLookback.kind !== "value") {
        return breakoutLookback.decision;
      }

      if (breakoutLookback.value.lessThan(options.breakoutLookbackBuckets)) {
        return hold("trend_following", "breakout_lookback_below_threshold", {
          breakout_lookback_buckets: breakoutLookback.value.toFixed(),
          min_breakout_lookback_buckets: options.breakoutLookbackBuckets,
        });
      }

      return createOrderDecision(context, "trend_following", side, {
        breakout_lookback_buckets: options.breakoutLookbackBuckets,
        signal_breakout_lookback_buckets: breakoutLookback.value.toFixed(),
        breakout_direction: breakoutDirection,
        min_trade_strength: minTradeStrength.toFixed(),
        min_orderbook_imbalance: minOrderbookImbalance.toFixed(),
        signal_orderbook_imbalance: imbalance.value.toFixed(),
        signal_trade_strength: tradeStrength.value.toFixed(),
      });
    },
  };
}

/**
 * 평균 대비 이탈 폭이 충분할 때 반대 방향 지정가 후보를 만드는 평균 회귀 전략이다.
 */
export function createMeanReversionStrategy(options: MeanReversionStrategyOptions): Strategy {
  const maxSpreadBps = parseNonNegativeDecimal(options.maxSpreadBps, "max_spread_bps");
  const minDepthKrw = parseNonNegativeDecimal(options.minDepthKrw, "min_depth_krw");
  const entryDeviationBps = parseNonNegativeDecimal(options.entryDeviationBps, "entry_deviation_bps");
  const exitDeviationBps = parseNonNegativeDecimal(options.exitDeviationBps, "exit_deviation_bps");

  return {
    ...strategyRegistry.mean_reversion,
    evaluate: (context) => {
      const guard = evaluateEntryGuards(context, "mean_reversion", {
        maxSpreadBps,
        minDepthKrw,
      });

      if (guard !== undefined) {
        return guard;
      }

      const deviation = requireFeatureDecimal(
        context,
        "mean_reversion_deviation_bps",
        "mean_reversion",
      );

      if (deviation.kind !== "value") {
        return deviation.decision;
      }

      // 1. 가격이 평균보다 충분히 이탈했을 때만 반대 방향 주문 후보를 만든다.
      if (isNegativeReversionSignal(deviation.value, entryDeviationBps)) {
        return createOrderDecision(context, "mean_reversion", "BUY", {
          entry_deviation_bps: entryDeviationBps.toFixed(),
          exit_deviation_bps: exitDeviationBps.toFixed(),
          stop_loss_bps: options.stopLossBps,
          signal_deviation_bps: deviation.value.toFixed(),
        });
      }

      // 2. 평균 근처 복귀 청산 후보는 entry threshold가 아니라 exit threshold로 더 빠르게 만든다.
      if (isPositiveReversionSignal(deviation.value, exitDeviationBps)) {
        return createOrderDecision(context, "mean_reversion", "SELL", {
          entry_deviation_bps: entryDeviationBps.toFixed(),
          exit_deviation_bps: exitDeviationBps.toFixed(),
          stop_loss_bps: options.stopLossBps,
          signal_deviation_bps: deviation.value.toFixed(),
        });
      }

      return hold("mean_reversion", "mean_reversion_deviation_below_threshold", {
        entry_deviation_bps: entryDeviationBps.toFixed(),
        exit_deviation_bps: exitDeviationBps.toFixed(),
        signal_deviation_bps: deviation.value.toFixed(),
      });
    },
  };
}

/**
 * 변동성 확장과 돌파 방향이 함께 확인될 때 지정가 후보를 만드는 변동성 돌파 전략이다.
 */
export function createVolatilityBreakoutStrategy(options: VolatilityBreakoutStrategyOptions): Strategy {
  const maxSpreadBps = parseNonNegativeDecimal(options.maxSpreadBps, "max_spread_bps");
  const minDepthKrw = parseNonNegativeDecimal(options.minDepthKrw, "min_depth_krw");
  const minVolatilityExpansionBps = parseNonNegativeDecimal(
    options.minVolatilityExpansionBps,
    "min_volatility_expansion_bps",
  );

  return {
    ...strategyRegistry.volatility_breakout,
    evaluate: (context) => {
      const guard = evaluateEntryGuards(context, "volatility_breakout", {
        maxSpreadBps,
        minDepthKrw,
      });

      if (guard !== undefined) {
        return guard;
      }

      const expansion = requireFeatureDecimal(
        context,
        "volatility_expansion_bps",
        "volatility_breakout",
      );

      if (expansion.kind !== "value") {
        return expansion.decision;
      }

      if (expansion.value.lessThan(minVolatilityExpansionBps)) {
        return hold("volatility_breakout", "volatility_expansion_below_threshold", {
          min_volatility_expansion_bps: minVolatilityExpansionBps.toFixed(),
          volatility_expansion_bps: expansion.value.toFixed(),
        });
      }

      const side = sideFromDirectionFeature(readStringFeature(context, "breakout_direction"));

      if (side === undefined) {
        return hold("volatility_breakout", "breakout_direction_absent", {
          breakout_direction: readStringFeature(context, "breakout_direction"),
        });
      }

      const breakoutLookback = requireFeatureDecimal(
        context,
        "breakout_lookback_buckets",
        "volatility_breakout",
      );

      if (breakoutLookback.kind !== "value") {
        return breakoutLookback.decision;
      }

      if (breakoutLookback.value.lessThan(options.breakoutLookbackBuckets)) {
        return hold("volatility_breakout", "breakout_lookback_below_threshold", {
          breakout_lookback_buckets: breakoutLookback.value.toFixed(),
          min_breakout_lookback_buckets: options.breakoutLookbackBuckets,
        });
      }

      // 1. 변동성 확장과 돌파 lookback threshold 통과 후 돌파 방향을 지정가 side로 변환한다.
      return createOrderDecision(context, "volatility_breakout", side, {
        breakout_lookback_buckets: options.breakoutLookbackBuckets,
        signal_breakout_lookback_buckets: breakoutLookback.value.toFixed(),
        min_volatility_expansion_bps: minVolatilityExpansionBps.toFixed(),
        volatility_expansion_bps: expansion.value.toFixed(),
      });
    },
  };
}

/**
 * 체결강도와 호가 불균형이 함께 강할 때 같은 방향 지정가 후보를 만드는 모멘텀 전략이다.
 */
export function createOrderbookImbalanceMomentumStrategy(
  options: OrderbookImbalanceMomentumStrategyOptions,
): Strategy {
  const maxSpreadBps = parseNonNegativeDecimal(options.maxSpreadBps, "max_spread_bps");
  const minDepthKrw = parseNonNegativeDecimal(options.minDepthKrw, "min_depth_krw");
  const minTradeStrength = parseNonNegativeDecimal(options.minTradeStrength, "min_trade_strength");
  const minOrderbookImbalance = parseNonNegativeDecimal(
    options.minOrderbookImbalance,
    "min_orderbook_imbalance",
  );

  return {
    ...strategyRegistry.orderbook_imbalance_momentum,
    evaluate: (context) => {
      const guard = evaluateEntryGuards(context, "orderbook_imbalance_momentum", {
        maxSpreadBps,
        minDepthKrw,
      });

      if (guard !== undefined) {
        return guard;
      }

      const tradeStrength = requireFeatureDecimal(
        context,
        "trade_strength",
        "orderbook_imbalance_momentum",
      );

      if (tradeStrength.kind !== "value") {
        return tradeStrength.decision;
      }

      const imbalance = requireFeatureDecimal(
        context,
        "orderbook_imbalance",
        "orderbook_imbalance_momentum",
      );

      if (imbalance.kind !== "value") {
        return imbalance.decision;
      }

      if (tradeStrength.value.lessThan(minTradeStrength)) {
        return hold("orderbook_imbalance_momentum", "trade_strength_below_threshold", {
          trade_strength: tradeStrength.value.toFixed(),
          min_trade_strength: minTradeStrength.toFixed(),
        });
      }

      const side = sideFromSignedSignal(imbalance.value, minOrderbookImbalance);

      if (side === undefined) {
        return hold("orderbook_imbalance_momentum", "orderbook_imbalance_below_threshold", {
          orderbook_imbalance: imbalance.value.toFixed(),
          min_orderbook_imbalance: minOrderbookImbalance.toFixed(),
        });
      }

      // 1. 호가 불균형 부호를 그대로 매수/매도 방향으로 해석한다.
      return createOrderDecision(context, "orderbook_imbalance_momentum", side, {
        min_trade_strength: minTradeStrength.toFixed(),
        min_orderbook_imbalance: minOrderbookImbalance.toFixed(),
        signal_orderbook_imbalance: imbalance.value.toFixed(),
        signal_trade_strength: tradeStrength.value.toFixed(),
      });
    },
  };
}

/**
 * 유동성 이탈 폭이 충분할 때 평균 회귀 방향 지정가 후보를 만드는 전략이다.
 */
export function createLiquidityReversionStrategy(options: LiquidityReversionStrategyOptions): Strategy {
  const maxSpreadBps = parseNonNegativeDecimal(options.maxSpreadBps, "max_spread_bps");
  const minDepthKrw = parseNonNegativeDecimal(options.minDepthKrw, "min_depth_krw");
  const entryDeviationBps = parseNonNegativeDecimal(options.entryDeviationBps, "entry_deviation_bps");

  return {
    ...strategyRegistry.liquidity_reversion,
    evaluate: (context) => {
      const guard = evaluateEntryGuards(context, "liquidity_reversion", {
        maxSpreadBps,
        minDepthKrw,
      });

      if (guard !== undefined) {
        return guard;
      }

      const reversion = requireFeatureDecimal(
        context,
        "liquidity_reversion_bps",
        "liquidity_reversion",
      );

      if (reversion.kind !== "value") {
        return reversion.decision;
      }

      const side = sideFromReversionSignal(reversion.value, entryDeviationBps);

      if (side === undefined) {
        return hold("liquidity_reversion", "liquidity_reversion_below_threshold", {
          entry_deviation_bps: entryDeviationBps.toFixed(),
          liquidity_reversion_bps: reversion.value.toFixed(),
        });
      }

      // 1. 유동성 이탈 부호의 반대 방향으로 평균 회귀 주문 후보를 만든다.
      return createOrderDecision(context, "liquidity_reversion", side, {
        entry_deviation_bps: entryDeviationBps.toFixed(),
        stop_loss_bps: options.stopLossBps,
        liquidity_reversion_bps: reversion.value.toFixed(),
      });
    },
  };
}

function evaluateEntryGuards(
  context: StrategyContext,
  strategyId: string,
  options: {
    maxSpreadBps: Decimal;
    minDepthKrw: Decimal;
  },
): StrategyDecision | undefined {
  // 1. LLM-only context는 가격/수량 feature가 있더라도 신규 주문 후보 생성을 차단한다.
  if (isLlmOnlyContext(context)) {
    return block(strategyId, "llm_only_not_allowed", "LLM-only context cannot create order intents");
  }

  const spread = requireFeatureDecimal(context, "spread_bps", strategyId);

  if (spread.kind !== "value") {
    return spread.decision;
  }

  if (spread.value.greaterThan(options.maxSpreadBps)) {
    return block(strategyId, "spread_too_wide", "Spread exceeds the strategy threshold", {
      spread_bps: spread.value.toFixed(),
      max_spread_bps: options.maxSpreadBps.toFixed(),
    });
  }

  const depth = requireFeatureDecimal(context, "depth_krw", strategyId);

  if (depth.kind !== "value") {
    return depth.decision;
  }

  if (depth.value.lessThan(options.minDepthKrw)) {
    return block(strategyId, "depth_insufficient", "Depth is below the strategy threshold", {
      depth_krw: depth.value.toFixed(),
      min_depth_krw: options.minDepthKrw.toFixed(),
    });
  }

  return undefined;
}

function createOrderDecision(
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

function requireFeatureDecimal(
  context: StrategyContext,
  key: string,
  strategyId: string,
):
  | {
      kind: "value";
      value: Decimal;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const read = readFeatureDecimal(context, key);

  if (read.status === "ok") {
    return {
      kind: "value",
      value: read.value,
    };
  }

  if (read.status === "missing") {
    return {
      kind: "decision",
      decision: block(strategyId, `feature_missing_${key}`, `${key} feature is required`),
    };
  }

  return {
    kind: "decision",
    decision: block(strategyId, `feature_invalid_${key}`, `${key} feature must be a decimal string`),
  };
}

function readFeatureDecimal(context: StrategyContext, key: string): DecimalRead {
  const value = context.features[key];

  if (value === undefined || value === null) {
    return {
      status: "missing",
    };
  }

  try {
    return {
      status: "ok",
      value: parseFinancialDecimal(value),
    };
  } catch {
    return {
      status: "invalid",
    };
  }
}

function readExchangeId(
  context: StrategyContext,
  strategyId: string,
):
  | {
      kind: "value";
      value: ExchangeId;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const exchangeId = context.exchangeId ?? readStringFeature(context, "exchange_id");

  if (exchangeId === undefined || exchangeId.trim().length === 0) {
    return {
      kind: "decision",
      decision: block(strategyId, "exchange_id_missing", "exchange id is required"),
    };
  }

  return {
    kind: "value",
    value: exchangeId,
  };
}

function readMarket(
  context: StrategyContext,
  strategyId: string,
):
  | {
      kind: "value";
      value: MarketCode;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const market = context.market ?? readStringFeature(context, "market");

  if (market === undefined || market.trim().length === 0) {
    return {
      kind: "decision",
      decision: block(strategyId, "market_missing", "market is required"),
    };
  }

  return {
    kind: "value",
    value: market,
  };
}

function readStringFeature(context: StrategyContext, key: string): string | undefined {
  const value = context.features[key];

  return typeof value === "string" ? value : undefined;
}

function sideFromSignedSignal(signal: Decimal, threshold: Decimal): OrderSide | undefined {
  if (threshold.isZero()) {
    if (signal.greaterThan(0)) {
      return "BUY";
    }

    if (signal.lessThan(0)) {
      return "SELL";
    }

    return undefined;
  }

  if (signal.greaterThanOrEqualTo(threshold)) {
    return "BUY";
  }

  if (signal.lessThanOrEqualTo(threshold.negated())) {
    return "SELL";
  }

  return undefined;
}

function sideFromReversionSignal(signal: Decimal, threshold: Decimal): OrderSide | undefined {
  if (isNegativeReversionSignal(signal, threshold)) {
    return "BUY";
  }

  if (isPositiveReversionSignal(signal, threshold)) {
    return "SELL";
  }

  return undefined;
}

function isNegativeReversionSignal(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.lessThan(0) : signal.lessThanOrEqualTo(threshold.negated());
}

function isPositiveReversionSignal(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.greaterThan(0) : signal.greaterThanOrEqualTo(threshold);
}

function sideFromDirectionFeature(direction: string | undefined): OrderSide | undefined {
  const normalized = direction?.trim().toUpperCase();

  if (normalized === "UP" || normalized === "BUY" || normalized === "LONG") {
    return "BUY";
  }

  if (normalized === "DOWN" || normalized === "SELL" || normalized === "SHORT") {
    return "SELL";
  }

  return undefined;
}

function isLlmOnlyContext(context: StrategyContext): boolean {
  return (
    context.metadata?.llm_only === true ||
    context.metadata?.source === "llm" ||
    context.metadata?.source === "LLM" ||
    context.features.llm_only === true ||
    context.features.source === "llm" ||
    context.features.source === "LLM"
  );
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

function parseNonNegativeDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);

  if (decimal.isNegative()) {
    throw new Error(`${fieldName} must not be negative`);
  }

  return decimal;
}

function hold(strategyId: string, reasonCode: string, metadata?: JsonRecord): StrategyDecision {
  return {
    kind: "HOLD",
    strategyId,
    reason: reasonCode,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function block(
  strategyId: string,
  reasonCode: string,
  reason: string,
  metadata?: JsonRecord,
): StrategyDecision {
  return {
    kind: "BLOCK",
    strategyId,
    reason,
    reasonCode,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
