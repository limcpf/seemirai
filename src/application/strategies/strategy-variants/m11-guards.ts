import type { Decimal } from "decimal.js";
import type { StrategyContext, StrategyDecision } from "../../../domain/index.js";
import { block, hold } from "./decision-factory.js";
import { readStringFeature, requireFeatureDecimal } from "./feature-reader.js";
import { isM11MarketRegime } from "./threshold-parser.js";
import type { M11MarketRegime } from "./types.js";

/**
 * 추세 추종 전략이 요구하는 M11 feature gate를 순서대로 평가한다.
 *
 * 입력은 이미 파싱된 threshold와 strategy context이며, 첫 실패만 StrategyDecision으로 반환한다. 외부 side effect는 없고,
 * fail-closed BLOCK과 threshold HOLD metadata가 이후 discard audit의 안정 식별자로 유지되는 것이 invariant다.
 */
export function evaluateTrendFollowingM11Guards(
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
    evaluateNonNegativeFeatureGuard(context, options.strategyId, "volume_spike_ratio", options.minVolumeSpikeRatio) ??
    evaluateSignedRatioAbsFeatureGuard(
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
export function evaluateMeanReversionM11Guards(
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
    evaluateRatioFeatureGuard(
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
export function evaluateVolatilityBreakoutM11Guards(
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
    evaluateNonNegativeFeatureGuard(context, options.strategyId, "volume_spike_ratio", options.minVolumeSpikeRatio) ??
    evaluateMarketRegimeGuard(context, options.strategyId, options.allowedMarketRegimes)
  );
}

/**
 * 호가 불균형 모멘텀 전략의 M11 orderbook 품질 gate를 평가한다.
 *
 * bid/ask depth slope와 depth 변화율을 0으로 보정하지 않고 누락/invalid 값을 차단한다. 첫 실패만 반환해 paper/backtest
 * 비교에서 폐기 원인이 중복 집계되지 않게 한다.
 */
export function evaluateOrderbookImbalanceM11Guards(
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
    evaluateNonNegativeFeatureGuard(
      context,
      options.strategyId,
      "bid_depth_slope_krw_per_bps",
      options.minDepthSlopeKrwPerBps,
    ) ??
    evaluateNonNegativeFeatureGuard(
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
    evaluateSignedRatioAbsFeatureGuard(
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
export function evaluateLiquidityReversionM11Guards(
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
    evaluateRatioFeatureGuard(
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

  if (realizedVolatility.value.isNegative()) {
    return block(
      strategyId,
      "feature_invalid_realized_volatility_bps",
      "realized_volatility_bps feature must not be negative",
      {
        feature_key: "realized_volatility_bps",
        feature_value: realizedVolatility.value.toFixed(),
        reason_family: "feature_invalid",
      },
    );
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
 * 0 이상이어야 하는 Decimal feature가 유효하고 최소 threshold 이상인지 검증한다.
 *
 * volume spike와 depth slope처럼 계산식상 음수가 나올 수 없는 feature에 사용한다. 음수는 정상적인 threshold 미달이 아니라
 * feature 계약 위반이므로 BLOCK으로 남겨 데이터 품질 이상을 audit에서 분리한다.
 */
function evaluateNonNegativeFeatureGuard(
  context: StrategyContext,
  strategyId: string,
  featureKey: string,
  threshold: Decimal,
): StrategyDecision | undefined {
  const feature = requireFeatureDecimal(context, featureKey, strategyId);

  if (feature.kind !== "value") {
    return feature.decision;
  }

  if (feature.value.isNegative()) {
    return block(strategyId, `feature_invalid_${featureKey}`, `${featureKey} feature must not be negative`, {
      feature_key: featureKey,
      feature_value: feature.value.toFixed(),
      min_value: "0",
      reason_family: "feature_invalid",
    });
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
 * `-1..1` 범위의 signed ratio feature가 유효하고 절대 강도 threshold를 넘는지 검증한다.
 *
 * 체결 방향 imbalance처럼 부호가 방향, 절대값이 강도를 뜻하는 feature에 사용한다. 범위 위반은 threshold 미달 HOLD가 아니라
 * feature 계약 위반 BLOCK으로 기록해 데이터 품질 오류를 숨기지 않는다.
 */
function evaluateSignedRatioAbsFeatureGuard(
  context: StrategyContext,
  strategyId: string,
  featureKey: string,
  threshold: Decimal,
): StrategyDecision | undefined {
  const feature = requireFeatureDecimal(context, featureKey, strategyId);

  if (feature.kind !== "value") {
    return feature.decision;
  }

  if (feature.value.abs().greaterThan(1)) {
    return block(strategyId, `feature_invalid_${featureKey}`, `${featureKey} feature must be between -1 and 1`, {
      feature_key: featureKey,
      feature_value: feature.value.toFixed(),
      max_abs_value: "1",
      reason_family: "feature_invalid",
    });
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
 * `0..1` 범위의 ratio feature가 유효하고 최소 threshold 이상인지 검증한다.
 *
 * session liquidity score처럼 음수와 1 초과가 모두 feature 계산 오류인 입력에 사용한다. 범위 위반은 fail-closed BLOCK으로
 * 남기고, 정상 범위의 threshold 미달만 HOLD로 분리한다.
 */
function evaluateRatioFeatureGuard(
  context: StrategyContext,
  strategyId: string,
  featureKey: string,
  threshold: Decimal,
): StrategyDecision | undefined {
  const feature = requireFeatureDecimal(context, featureKey, strategyId);

  if (feature.kind !== "value") {
    return feature.decision;
  }

  if (feature.value.isNegative() || feature.value.greaterThan(1)) {
    return block(strategyId, `feature_invalid_${featureKey}`, `${featureKey} feature must be between 0 and 1`, {
      feature_key: featureKey,
      feature_value: feature.value.toFixed(),
      min_value: "0",
      max_value: "1",
      reason_family: "feature_invalid",
    });
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
