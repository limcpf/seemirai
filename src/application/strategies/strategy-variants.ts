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
  minCostAdjustedMarginBps: string;
}

/**
 * M11 feature snapshot이 strategy 경계에 전달하는 시장 국면 코드다.
 *
 * 사용자 표시 문구가 아니라 내부 feature enum이므로, strategy는 이 값으로 후보 허용 여부만 판단하고 외부 side effect를 만들지
 * 않는다. 알 수 없는 값은 feature 생성 경계가 깨진 것으로 보고 주문 후보를 fail-closed한다.
 */
type M11MarketRegime = "trend_up" | "trend_down" | "range" | "volatile" | "liquidity_stress";

/**
 * strategy 입력 검증에서 허용하는 M11 시장 국면의 단일 source of truth다.
 */
const m11MarketRegimes = ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"] as const;

/**
 * 추세 추종 전략의 보수적 진입 threshold다.
 *
 * 기존 M4 실행 보조 feature와 M11 feature snapshot을 함께 요구한다. M11 threshold 기본값은 #68 운영 관측 전에는
 * 공격적으로 후보를 줄이지 않도록 0 또는 전체 regime 허용으로 시작하고, 후보 생성 전 fail-closed 검증 경계만 연다.
 */
export interface TrendFollowingStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minTradeStrength: string;
  minOrderbookImbalance: string;
  minVolatilityExpansionBps: string;
  minCandleMomentumBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minVolumeSpikeRatio: string;
  minTradeDirectionImbalance: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 평균 회귀 전략의 보수적 진입 threshold다.
 *
 * rolling VWAP 이탈, 유동성 점수, regime, 비용 차감 margin을 M11 입력으로 요구한다. 기준값이 0인 기본 profile은
 * 기존 운영 threshold보다 공격적으로 바꾸지 않고, feature 누락과 invalid 값만 주문 후보 생성을 차단한다.
 */
export interface MeanReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  exitDeviationBps: string;
  stopLossBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minAbsVwapDeviationBps: string;
  minSessionLiquidityScore: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 변동성 돌파 전략의 보수적 진입 threshold다.
 *
 * realized volatility, volume spike, candle momentum, regime, 비용 차감 margin을 같은 snapshot에서 읽는다. CostModel은
 * 여전히 최종 비용 권한을 갖고, 이 옵션은 strategy 설명과 calibration 비교를 위한 사전 입력 검증에 한정된다.
 */
export interface VolatilityBreakoutStrategyOptions extends EntryGuardOptions {
  breakoutLookbackBuckets: number;
  minVolatilityExpansionBps: string;
  minCandleMomentumBps: string;
  minRealizedVolatilityBps: string;
  maxRealizedVolatilityBps: string;
  minVolumeSpikeRatio: string;
  allowedMarketRegimes: readonly M11MarketRegime[];
}

/**
 * 호가 불균형 모멘텀 전략의 보수적 진입 threshold다.
 *
 * depth slope, depth 변화율, 체결 방향 imbalance, 비용 차감 margin을 요구한다. 호가 metric이 비어 있으면 0 보정 없이
 * BLOCK으로 닫아 backtest/paper calibration에서 누락 원인을 분리할 수 있게 한다.
 */
export interface OrderbookImbalanceMomentumStrategyOptions extends EntryGuardOptions {
  minTradeStrength: string;
  minOrderbookImbalance: string;
  minDepthSlopeKrwPerBps: string;
  minDepthChangeRateRatio: string;
  minTradeDirectionImbalance: string;
}

/**
 * 유동성 회귀 전략의 보수적 진입 threshold다.
 *
 * depth 변화율, session liquidity score, VWAP 이탈, 비용 차감 margin을 후보 생성 전 검증한다. 기본값은 운영 threshold
 * 확정 전 안전하게 pass-through에 가깝게 두고, Sub PR 5에서 관측 데이터 기반 조정을 검토한다.
 */
export interface LiquidityReversionStrategyOptions extends EntryGuardOptions {
  entryDeviationBps: string;
  stopLossBps: string;
  minDepthChangeRateRatio: string;
  minAbsVwapDeviationBps: string;
  minSessionLiquidityScore: string;
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

  if (spread.value.isNegative()) {
    return block(strategyId, "spread_negative", "Spread must not be negative", {
      spread_bps: spread.value.toFixed(),
    });
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

/**
 * 추세 추종 전략이 요구하는 M11 feature gate를 순서대로 평가한다.
 *
 * 입력은 이미 파싱된 threshold와 strategy context이며, 첫 실패만 StrategyDecision으로 반환한다. 외부 side effect는 없고,
 * fail-closed BLOCK과 threshold HOLD metadata가 이후 discard audit의 안정 식별자로 유지되는 것이 invariant다.
 */
function evaluateTrendFollowingM11Guards(
  context: StrategyContext,
  options: {
    strategyId: string;
    minCostAdjustedMarginBps: Decimal;
    minCandleMomentumBps: Decimal;
    minRealizedVolatilityBps: Decimal;
    maxRealizedVolatilityBps: Decimal;
    minVolumeSpikeRatio: Decimal;
    minTradeDirectionImbalance: Decimal;
    allowedMarketRegimes: readonly M11MarketRegime[];
  },
): StrategyDecision | undefined {
  return (
    evaluateM11CostMarginGuard(context, options.strategyId, options.minCostAdjustedMarginBps) ??
    evaluateRealizedVolatilityGuard(
      context,
      options.strategyId,
      options.minRealizedVolatilityBps,
      options.maxRealizedVolatilityBps,
    ) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "candle_momentum_bps",
      options.minCandleMomentumBps,
    ) ??
    evaluateMinimumFeatureGuard(context, options.strategyId, "volume_spike_ratio", options.minVolumeSpikeRatio) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "trade_direction_imbalance_ratio",
      options.minTradeDirectionImbalance,
    ) ??
    evaluateMarketRegimeGuard(context, options.strategyId, options.allowedMarketRegimes)
  );
}

/**
 * 평균 회귀 전략의 M11 VWAP/유동성/regime gate를 평가한다.
 *
 * legacy 평균 이탈 feature를 읽기 전에 새 feature 품질을 먼저 검증한다. 반환값은 첫 실패 decision 또는 undefined이고,
 * 입력 context와 threshold 객체는 변경하지 않는다.
 */
function evaluateMeanReversionM11Guards(
  context: StrategyContext,
  options: {
    strategyId: string;
    minCostAdjustedMarginBps: Decimal;
    minRealizedVolatilityBps: Decimal;
    maxRealizedVolatilityBps: Decimal;
    minAbsVwapDeviationBps: Decimal;
    minSessionLiquidityScore: Decimal;
    allowedMarketRegimes: readonly M11MarketRegime[];
  },
): StrategyDecision | undefined {
  return (
    evaluateM11CostMarginGuard(context, options.strategyId, options.minCostAdjustedMarginBps) ??
    evaluateRealizedVolatilityGuard(
      context,
      options.strategyId,
      options.minRealizedVolatilityBps,
      options.maxRealizedVolatilityBps,
    ) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "vwap_deviation_bps",
      options.minAbsVwapDeviationBps,
    ) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "session_liquidity_score",
      options.minSessionLiquidityScore,
    ) ??
    evaluateMarketRegimeGuard(context, options.strategyId, options.allowedMarketRegimes)
  );
}

/**
 * 변동성 돌파 전략의 M11 momentum/volatility/volume/regime gate를 평가한다.
 *
 * 기존 돌파 방향과 lookback 해석 전 단계에서 feature snapshot 완전성과 보수적 threshold를 확인한다. 이 함수는 순수 판정만
 * 수행하며, audit metadata는 하위 guard의 HOLD/BLOCK decision에 위임한다.
 */
function evaluateVolatilityBreakoutM11Guards(
  context: StrategyContext,
  options: {
    strategyId: string;
    minCostAdjustedMarginBps: Decimal;
    minCandleMomentumBps: Decimal;
    minRealizedVolatilityBps: Decimal;
    maxRealizedVolatilityBps: Decimal;
    minVolumeSpikeRatio: Decimal;
    allowedMarketRegimes: readonly M11MarketRegime[];
  },
): StrategyDecision | undefined {
  return (
    evaluateM11CostMarginGuard(context, options.strategyId, options.minCostAdjustedMarginBps) ??
    evaluateRealizedVolatilityGuard(
      context,
      options.strategyId,
      options.minRealizedVolatilityBps,
      options.maxRealizedVolatilityBps,
    ) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "candle_momentum_bps",
      options.minCandleMomentumBps,
    ) ??
    evaluateMinimumFeatureGuard(context, options.strategyId, "volume_spike_ratio", options.minVolumeSpikeRatio) ??
    evaluateMarketRegimeGuard(context, options.strategyId, options.allowedMarketRegimes)
  );
}

/**
 * 호가 불균형 모멘텀 전략의 M11 orderbook 품질 gate를 평가한다.
 *
 * bid/ask depth slope와 depth 변화율을 0으로 보정하지 않고 누락/invalid 값을 차단한다. 첫 실패만 반환해 paper/backtest
 * 비교에서 폐기 원인이 중복 집계되지 않게 한다.
 */
function evaluateOrderbookImbalanceM11Guards(
  context: StrategyContext,
  options: {
    strategyId: string;
    minCostAdjustedMarginBps: Decimal;
    minDepthSlopeKrwPerBps: Decimal;
    minDepthChangeRateRatio: Decimal;
    minTradeDirectionImbalance: Decimal;
  },
): StrategyDecision | undefined {
  return (
    evaluateM11CostMarginGuard(context, options.strategyId, options.minCostAdjustedMarginBps) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "bid_depth_slope_krw_per_bps",
      options.minDepthSlopeKrwPerBps,
    ) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "ask_depth_slope_krw_per_bps",
      options.minDepthSlopeKrwPerBps,
    ) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "depth_change_rate_ratio",
      options.minDepthChangeRateRatio,
    ) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "trade_direction_imbalance_ratio",
      options.minTradeDirectionImbalance,
    )
  );
}

/**
 * 유동성 회귀 전략의 M11 depth/session/VWAP gate를 평가한다.
 *
 * 회귀 신호 자체보다 시장 유동성 품질을 먼저 확인한다. 함수는 외부 상태를 변경하지 않고, 반환되는 HOLD/BLOCK metadata가
 * discard audit의 원본 feature key를 보존해야 한다.
 */
function evaluateLiquidityReversionM11Guards(
  context: StrategyContext,
  options: {
    strategyId: string;
    minCostAdjustedMarginBps: Decimal;
    minDepthChangeRateRatio: Decimal;
    minAbsVwapDeviationBps: Decimal;
    minSessionLiquidityScore: Decimal;
  },
): StrategyDecision | undefined {
  return (
    evaluateM11CostMarginGuard(context, options.strategyId, options.minCostAdjustedMarginBps) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "depth_change_rate_ratio",
      options.minDepthChangeRateRatio,
    ) ??
    evaluateMinimumAbsFeatureGuard(
      context,
      options.strategyId,
      "vwap_deviation_bps",
      options.minAbsVwapDeviationBps,
    ) ??
    evaluateMinimumFeatureGuard(
      context,
      options.strategyId,
      "session_liquidity_score",
      options.minSessionLiquidityScore,
    )
  );
}

/**
 * 비용과 safety buffer를 반영한 M11 margin feature를 strategy 후보 승격 전에 검증한다.
 *
 * CostModel 최종 승인 권한을 대체하지 않고, feature 누락/invalid 또는 threshold 미달을 audit 가능한 decision으로 바꾼다.
 * 입력 feature와 threshold는 Decimal로 비교하며 side effect는 없다.
 */
function evaluateM11CostMarginGuard(
  context: StrategyContext,
  strategyId: string,
  minCostAdjustedMarginBps: Decimal,
): StrategyDecision | undefined {
  const margin = requireFeatureDecimal(context, "cost_adjusted_margin_bps", strategyId);

  if (margin.kind !== "value") {
    return margin.decision;
  }

  if (margin.value.lessThan(minCostAdjustedMarginBps)) {
    return hold(strategyId, "cost_adjusted_margin_below_threshold", {
      cost_adjusted_margin_bps: margin.value.toFixed(),
      min_cost_adjusted_margin_bps: minCostAdjustedMarginBps.toFixed(),
    });
  }

  return undefined;
}

/**
 * realized volatility가 전략별 최소/최대 운용 범위에 들어오는지 확인한다.
 *
 * 너무 낮은 변동성과 급변동 국면을 같은 feature key로 비교하되 reason code는 분리한다. 첫 실패만 반환하고 context는 수정하지
 * 않는다.
 */
function evaluateRealizedVolatilityGuard(
  context: StrategyContext,
  strategyId: string,
  minRealizedVolatilityBps: Decimal,
  maxRealizedVolatilityBps: Decimal,
): StrategyDecision | undefined {
  const realizedVolatility = requireFeatureDecimal(context, "realized_volatility_bps", strategyId);

  if (realizedVolatility.kind !== "value") {
    return realizedVolatility.decision;
  }

  if (realizedVolatility.value.lessThan(minRealizedVolatilityBps)) {
    return hold(strategyId, "realized_volatility_below_threshold", {
      realized_volatility_bps: realizedVolatility.value.toFixed(),
      min_realized_volatility_bps: minRealizedVolatilityBps.toFixed(),
    });
  }

  if (realizedVolatility.value.greaterThan(maxRealizedVolatilityBps)) {
    return hold(strategyId, "realized_volatility_above_threshold", {
      realized_volatility_bps: realizedVolatility.value.toFixed(),
      max_realized_volatility_bps: maxRealizedVolatilityBps.toFixed(),
    });
  }

  return undefined;
}

/**
 * 단일 Decimal feature가 최소 threshold 이상인지 확인하는 공통 M11 guard다.
 *
 * feature key를 metadata에 남겨 서로 다른 전략의 폐기 사유를 같은 audit 축으로 집계할 수 있게 한다. missing/invalid는
 * requireFeatureDecimal의 BLOCK decision을 그대로 반환한다.
 */
function evaluateMinimumFeatureGuard(
  context: StrategyContext,
  strategyId: string,
  featureKey: string,
  threshold: Decimal,
): StrategyDecision | undefined {
  const feature = requireFeatureDecimal(context, featureKey, strategyId);

  if (feature.kind !== "value") {
    return feature.decision;
  }

  if (feature.value.lessThan(threshold)) {
    return hold(strategyId, `${featureKey}_below_threshold`, {
      feature_key: featureKey,
      feature_value: feature.value.toFixed(),
      threshold: threshold.toFixed(),
    });
  }

  return undefined;
}

/**
 * 부호가 방향을 의미하는 M11 feature의 절대 강도가 threshold 이상인지 확인한다.
 *
 * momentum, VWAP 이탈, 체결 방향 imbalance처럼 양/음 부호가 side 해석에 쓰이는 feature를 0 기준으로 대칭 평가한다. 외부
 * side effect 없이 첫 실패 decision만 반환한다.
 */
function evaluateMinimumAbsFeatureGuard(
  context: StrategyContext,
  strategyId: string,
  featureKey: string,
  threshold: Decimal,
): StrategyDecision | undefined {
  const feature = requireFeatureDecimal(context, featureKey, strategyId);

  if (feature.kind !== "value") {
    return feature.decision;
  }

  if (feature.value.abs().lessThan(threshold)) {
    return hold(strategyId, `${featureKey}_below_abs_threshold`, {
      feature_key: featureKey,
      feature_value: feature.value.toFixed(),
      threshold: threshold.toFixed(),
    });
  }

  return undefined;
}

/**
 * 시장 국면 feature가 known enum이고 전략이 허용한 regime인지 검증한다.
 *
 * 누락/unknown 값은 feature 생성 계약 위반이라 BLOCK으로 닫고, known 값이지만 전략 profile에서 제외된 경우만 HOLD로 남긴다.
 * 사용자 표시 문구로 enum을 직접 노출하지 않고 metadata에만 보존한다.
 */
function evaluateMarketRegimeGuard(
  context: StrategyContext,
  strategyId: string,
  allowedMarketRegimes: readonly M11MarketRegime[],
): StrategyDecision | undefined {
  const marketRegime = readStringFeature(context, "market_regime");

  if (marketRegime === undefined) {
    return block(strategyId, "feature_missing_market_regime", "market_regime feature is required", {
      feature_key: "market_regime",
      reason_family: "feature_missing",
    });
  }

  if (!isM11MarketRegime(marketRegime)) {
    return block(strategyId, "feature_invalid_market_regime", "market_regime feature must be a known M11 regime", {
      feature_key: "market_regime",
      feature_value: marketRegime,
      reason_family: "feature_invalid",
    });
  }

  if (!allowedMarketRegimes.includes(marketRegime)) {
    return hold(strategyId, "market_regime_not_allowed", {
      market_regime: marketRegime,
      allowed_market_regimes: [...allowedMarketRegimes],
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
      decision: block(strategyId, `feature_missing_${key}`, `${key} feature is required`, {
        feature_key: key,
        reason_family: "feature_missing",
      }),
    };
  }

  return {
    kind: "decision",
    decision: block(strategyId, `feature_invalid_${key}`, `${key} feature must be a decimal string`, {
      feature_key: key,
      reason_family: "feature_invalid",
    }),
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

function passesPositiveSignalThreshold(signal: Decimal, threshold: Decimal): boolean {
  return threshold.isZero() ? signal.greaterThan(0) : signal.greaterThanOrEqualTo(threshold);
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

/**
 * 음수도 허용해야 하는 strategy threshold 문자열을 Decimal로 정규화한다.
 *
 * 설정 파싱 경계에서만 호출되며, 잘못된 값은 startup/config validation 실패로 노출되도록 예외를 던진다. 반환 Decimal은 이후
 * strategy 평가에서 재파싱하지 않는 것이 invariant다.
 */
function parseDecimal(value: string, fieldName: string): Decimal {
  try {
    return parseFinancialDecimal(value);
  } catch {
    throw new Error(`${fieldName} must be a decimal string`);
  }
}

/**
 * 0..1 범위 ratio threshold를 Decimal로 정규화한다.
 *
 * 체결 방향 imbalance와 session liquidity score처럼 단위가 고정된 비율 설정에만 사용한다. 범위를 벗어나면 잘못된 profile로
 * 보고 외부 side effect 없이 예외를 던진다.
 */
function parseRatioDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseNonNegativeDecimal(value, fieldName);

  if (decimal.greaterThan(1)) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }

  return decimal;
}

/**
 * strategy option의 allowed market regime 목록을 불변 복사본으로 정규화한다.
 *
 * 비어 있거나 unknown enum이 섞이면 config 계약 위반으로 실패시킨다. 반환 배열은 평가 중 변경되지 않아야 하며, 사용자 표시
 * 문구로 변환하지 않고 audit metadata에만 보존한다.
 */
function normalizeAllowedMarketRegimes(values: readonly M11MarketRegime[]): readonly M11MarketRegime[] {
  if (values.length === 0) {
    throw new Error("allowed_market_regimes must include at least one market regime");
  }

  for (const value of values) {
    if (!isM11MarketRegime(value)) {
      throw new Error(`allowed_market_regimes contains an unknown market regime: ${String(value)}`);
    }
  }

  return [...values];
}

/**
 * 외부 feature snapshot에서 온 문자열이 M11 market regime enum인지 좁힌다.
 *
 * 이 함수는 runtime feature 값의 trust boundary에서만 사용하며, unknown 값은 보정하지 않고 상위 guard가 BLOCK으로 기록한다.
 */
function isM11MarketRegime(value: string): value is M11MarketRegime {
  return (m11MarketRegimes as readonly string[]).includes(value);
}

/**
 * strategy HOLD decision에 discard audit 공통 metadata를 부착한다.
 *
 * 기존 reason string은 유지하면서 strategy id와 reason family를 안정 key로 추가한다. 외부 side effect는 없고, 호출자가 넘긴
 * metadata를 덮어쓰지 않는 범위에서 공통 필드가 항상 존재해야 한다.
 */
function hold(strategyId: string, reasonCode: string, metadata?: JsonRecord): StrategyDecision {
  return {
    kind: "HOLD",
    strategyId,
    reason: reasonCode,
    metadata: {
      ...(metadata ?? {}),
      strategy_id: strategyId,
      reason_code: reasonCode,
      reason_family: "strategy_hold",
    },
  };
}

/**
 * strategy BLOCK decision에 fail-closed 원인과 audit 공통 metadata를 부착한다.
 *
 * BLOCK은 후보 생성이 안전하지 않은 입력/상태를 의미하므로 reasonCode와 reasonFamily를 metadata에 남긴다. 호출자가
 * feature_missing/feature_invalid family를 지정한 경우 그 분류를 유지한다.
 */
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
    metadata: {
      ...(metadata ?? {}),
      strategy_id: strategyId,
      reason_code: reasonCode,
      reason_family: metadata?.reason_family ?? "strategy_block",
    },
  };
}
