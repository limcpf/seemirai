import { strategyRegistry } from "../registry.js";
import type { Strategy } from "../../domain/index.js";
import { evaluateEntryGuards } from "./strategy-variants/entry-guards.js";
import { createOrderDecision } from "./strategy-variants/order-decision.js";
import {
  evaluateLiquidityReversionM11Guards,
  evaluateMeanReversionM11Guards,
  evaluateOrderbookImbalanceM11Guards,
  evaluateTrendFollowingM11Guards,
  evaluateVolatilityBreakoutM11Guards,
} from "./strategy-variants/m11-guards.js";
import { requireFeatureDecimal, readStringFeature } from "./strategy-variants/feature-reader.js";
import {
  isNegativeReversionSignal,
  isPositiveReversionSignal,
  passesPositiveSignalThreshold,
  sideFromDirectionFeature,
  sideFromReversionSignal,
  sideFromSignedSignal,
} from "./strategy-variants/signal-policy.js";
import { hold } from "./strategy-variants/decision-factory.js";
import {
  normalizeAllowedMarketRegimes,
  parseDecimal,
  parseNonNegativeDecimal,
  parseRatioDecimal,
} from "./strategy-variants/threshold-parser.js";
import type {
  LiquidityReversionStrategyOptions,
  M4StrategyVariantOptions,
  MeanReversionStrategyOptions,
  OrderbookImbalanceMomentumStrategyOptions,
  TrendFollowingStrategyOptions,
  VolatilityBreakoutStrategyOptions,
} from "./strategy-variants/types.js";

export type {
  LiquidityReversionStrategyOptions,
  M4StrategyVariantOptions,
  MeanReversionStrategyOptions,
  OrderbookImbalanceMomentumStrategyOptions,
  TrendFollowingStrategyOptions,
  VolatilityBreakoutStrategyOptions,
} from "./strategy-variants/types.js";

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
  const minVolatilityExpansionBps = parseNonNegativeDecimal(
    options.minVolatilityExpansionBps,
    "min_volatility_expansion_bps",
  );
  const minCostAdjustedMarginBps = parseDecimal(options.minCostAdjustedMarginBps, "min_cost_adjusted_margin_bps");
  const minCandleMomentumBps = parseNonNegativeDecimal(options.minCandleMomentumBps, "min_candle_momentum_bps");
  const minRealizedVolatilityBps = parseNonNegativeDecimal(
    options.minRealizedVolatilityBps,
    "min_realized_volatility_bps",
  );
  const maxRealizedVolatilityBps = parseNonNegativeDecimal(
    options.maxRealizedVolatilityBps,
    "max_realized_volatility_bps",
  );
  const minVolumeSpikeRatio = parseNonNegativeDecimal(options.minVolumeSpikeRatio, "min_volume_spike_ratio");
  const minTradeDirectionImbalance = parseRatioDecimal(
    options.minTradeDirectionImbalance,
    "min_trade_direction_imbalance",
  );
  const allowedMarketRegimes = normalizeAllowedMarketRegimes(options.allowedMarketRegimes);

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

      const m11Guard = evaluateTrendFollowingM11Guards(context, {
        strategyId: "trend_following",
        minCostAdjustedMarginBps,
        minCandleMomentumBps,
        minRealizedVolatilityBps,
        maxRealizedVolatilityBps,
        minVolumeSpikeRatio,
        minTradeDirectionImbalance,
        allowedMarketRegimes,
      });

      if (m11Guard !== undefined) {
        // M11 feature 누락과 비용 여유 부족은 기존 신호 강도보다 먼저 닫아 폐기 원인을 분리한다.
        return m11Guard;
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
      if (!passesPositiveSignalThreshold(tradeStrength.value, minTradeStrength)) {
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

      const volatilityExpansion = requireFeatureDecimal(
        context,
        "volatility_expansion_bps",
        "trend_following",
      );

      if (volatilityExpansion.kind !== "value") {
        return volatilityExpansion.decision;
      }

      // 3. 추세 추종은 돌파 증거에 더해 변동성 확장이 충분할 때만 진입 후보를 만든다.
      if (volatilityExpansion.value.lessThan(minVolatilityExpansionBps)) {
        return hold("trend_following", "volatility_expansion_below_threshold", {
          min_volatility_expansion_bps: minVolatilityExpansionBps.toFixed(),
          volatility_expansion_bps: volatilityExpansion.value.toFixed(),
        });
      }

      return createOrderDecision(context, "trend_following", side, {
        breakout_lookback_buckets: options.breakoutLookbackBuckets,
        signal_breakout_lookback_buckets: breakoutLookback.value.toFixed(),
        breakout_direction: breakoutDirection,
        min_volatility_expansion_bps: minVolatilityExpansionBps.toFixed(),
        volatility_expansion_bps: volatilityExpansion.value.toFixed(),
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
  const minCostAdjustedMarginBps = parseDecimal(options.minCostAdjustedMarginBps, "min_cost_adjusted_margin_bps");
  const minRealizedVolatilityBps = parseNonNegativeDecimal(
    options.minRealizedVolatilityBps,
    "min_realized_volatility_bps",
  );
  const maxRealizedVolatilityBps = parseNonNegativeDecimal(
    options.maxRealizedVolatilityBps,
    "max_realized_volatility_bps",
  );
  const minAbsVwapDeviationBps = parseNonNegativeDecimal(
    options.minAbsVwapDeviationBps,
    "min_abs_vwap_deviation_bps",
  );
  const minSessionLiquidityScore = parseRatioDecimal(
    options.minSessionLiquidityScore,
    "min_session_liquidity_score",
  );
  const allowedMarketRegimes = normalizeAllowedMarketRegimes(options.allowedMarketRegimes);

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

      const m11Guard = evaluateMeanReversionM11Guards(context, {
        strategyId: "mean_reversion",
        minCostAdjustedMarginBps,
        minRealizedVolatilityBps,
        maxRealizedVolatilityBps,
        minAbsVwapDeviationBps,
        minSessionLiquidityScore,
        allowedMarketRegimes,
      });

      if (m11Guard !== undefined) {
        // M11 feature 누락과 regime 불일치는 평균회귀 신호 해석 전에 확정해 audit reason을 섞지 않는다.
        return m11Guard;
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
  const minCostAdjustedMarginBps = parseDecimal(options.minCostAdjustedMarginBps, "min_cost_adjusted_margin_bps");
  const minCandleMomentumBps = parseNonNegativeDecimal(options.minCandleMomentumBps, "min_candle_momentum_bps");
  const minRealizedVolatilityBps = parseNonNegativeDecimal(
    options.minRealizedVolatilityBps,
    "min_realized_volatility_bps",
  );
  const maxRealizedVolatilityBps = parseNonNegativeDecimal(
    options.maxRealizedVolatilityBps,
    "max_realized_volatility_bps",
  );
  const minVolumeSpikeRatio = parseNonNegativeDecimal(options.minVolumeSpikeRatio, "min_volume_spike_ratio");
  const allowedMarketRegimes = normalizeAllowedMarketRegimes(options.allowedMarketRegimes);

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

      const m11Guard = evaluateVolatilityBreakoutM11Guards(context, {
        strategyId: "volatility_breakout",
        minCostAdjustedMarginBps,
        minCandleMomentumBps,
        minRealizedVolatilityBps,
        maxRealizedVolatilityBps,
        minVolumeSpikeRatio,
        allowedMarketRegimes,
      });

      if (m11Guard !== undefined) {
        // M11 변동성/거래량 guard를 먼저 적용해 기존 돌파 feature 실패와 새 feature 실패를 분리한다.
        return m11Guard;
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
  const minCostAdjustedMarginBps = parseDecimal(options.minCostAdjustedMarginBps, "min_cost_adjusted_margin_bps");
  const minDepthSlopeKrwPerBps = parseNonNegativeDecimal(
    options.minDepthSlopeKrwPerBps,
    "min_depth_slope_krw_per_bps",
  );
  const minDepthChangeRateRatio = parseDecimal(options.minDepthChangeRateRatio, "min_depth_change_rate_ratio");
  const minTradeDirectionImbalance = parseRatioDecimal(
    options.minTradeDirectionImbalance,
    "min_trade_direction_imbalance",
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

      const m11Guard = evaluateOrderbookImbalanceM11Guards(context, {
        strategyId: "orderbook_imbalance_momentum",
        minCostAdjustedMarginBps,
        minDepthSlopeKrwPerBps,
        minDepthChangeRateRatio,
        minTradeDirectionImbalance,
      });

      if (m11Guard !== undefined) {
        // 호가 depth 품질 guard가 실패하면 legacy imbalance 신호를 주문 후보로 승격하지 않는다.
        return m11Guard;
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

      if (!passesPositiveSignalThreshold(tradeStrength.value, minTradeStrength)) {
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
  const minCostAdjustedMarginBps = parseDecimal(options.minCostAdjustedMarginBps, "min_cost_adjusted_margin_bps");
  const minDepthChangeRateRatio = parseDecimal(options.minDepthChangeRateRatio, "min_depth_change_rate_ratio");
  const minAbsVwapDeviationBps = parseNonNegativeDecimal(
    options.minAbsVwapDeviationBps,
    "min_abs_vwap_deviation_bps",
  );
  const minSessionLiquidityScore = parseRatioDecimal(
    options.minSessionLiquidityScore,
    "min_session_liquidity_score",
  );

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

      const m11Guard = evaluateLiquidityReversionM11Guards(context, {
        strategyId: "liquidity_reversion",
        minCostAdjustedMarginBps,
        minDepthChangeRateRatio,
        minAbsVwapDeviationBps,
        minSessionLiquidityScore,
      });

      if (m11Guard !== undefined) {
        // 유동성 품질 guard를 선행시켜 회귀 신호가 있어도 얇은 시장 후보는 audit 가능한 HOLD/BLOCK으로 남긴다.
        return m11Guard;
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
