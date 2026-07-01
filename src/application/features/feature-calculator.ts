import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  parseMarketEventTimestampNanos,
  type MarketDataEvent,
  type OrderbookEvent,
  type OrderbookLevel,
  type TimestampInput,
  type TradeEvent,
} from "../../domain/index.js";
import type {
  FeatureCalculationFailureReasonCode,
  FeatureCalculationInput,
  FeatureCalculationOptions,
  FeatureCalculationResult,
  FeatureCostInput,
  FeatureFailureResult,
  FeatureResult,
  FeatureSuccessResult,
  FeatureValue,
  M11FeatureKey,
  MarketRegime,
  SessionLiquidityState,
} from "./types.js";
import { M11_FEATURE_KEYS } from "./types.js";

const DEFAULT_OPTIONS = {
  candleBucketMs: 60_000,
  candleBucketCount: 20,
  volumeBaselineBucketCount: 20,
  tradeImbalanceWindowMs: 5 * 60_000,
  depthChangeLookbackMs: 5 * 60_000,
  orderbookDepthLevels: 15,
  volatileRealizedVolatilityBps: "5000",
  volatileVolumeSpikeRatio: "3",
  volatileSpreadBps: "150",
  rangeMaxVwapDeviationBps: "200",
  liquidityStressSessionLiquidityScore: "0.5",
  trendMomentumBps: "10",
  trendImbalanceRatio: "0.2",
} as const;

const FEATURE_KEYS: readonly M11FeatureKey[] = M11_FEATURE_KEYS;

interface ResolvedFeatureCalculationOptions {
  candleBucketMs: number;
  candleBucketCount: number;
  volumeBaselineBucketCount: number;
  tradeImbalanceWindowMs: number;
  depthChangeLookbackMs: number;
  orderbookDepthLevels: number;
  volatileRealizedVolatilityBps: Decimal;
  volatileVolumeSpikeRatio: Decimal;
  volatileSpreadBps: Decimal;
  rangeMaxVwapDeviationBps: Decimal;
  liquidityStressSessionLiquidityScore: Decimal;
  trendMomentumBps: Decimal;
  trendImbalanceRatio: Decimal;
}

interface CalculationContext {
  observedAt: Date;
  observedAtIso: string;
  events: readonly MarketDataEvent[];
  options: ResolvedFeatureCalculationOptions;
}

interface Bucket {
  startMs: number;
  trades: TradeEvent[];
}

interface OrderbookBucket {
  startMs: number;
  orderbook?: OrderbookEvent;
}

interface EventOrderCandidate {
  event: MarketDataEvent;
  timestampMs: number;
  timestampNanos: bigint;
  exchangeId: string;
  market: string | undefined;
  sequence: string;
  tieBreakKey: string;
  canonicalPayloadKey: string;
}

interface Candle {
  open: Decimal;
  close: Decimal;
}

interface ComputedFeatureValues {
  candleMomentumBps?: Decimal;
  realizedVolatilityBps?: Decimal;
  volumeSpikeRatio?: Decimal;
  bidDepthSlopeKrwPerBps?: Decimal;
  askDepthSlopeKrwPerBps?: Decimal;
  depthChangeRateRatio?: Decimal;
  vwapDeviationBps?: Decimal;
  tradeDirectionImbalanceRatio?: Decimal;
  trendStrengthBps?: Decimal;
  meanReversionDiscountBps?: Decimal;
  marketRegime?: MarketRegime;
  sessionLiquidityScore?: Decimal;
  sessionLiquidityState?: SessionLiquidityState;
  costAdjustedExpectedReturnBps?: Decimal;
  costAdjustedMarginBps?: Decimal;
}

type DecimalFeatureKey = Exclude<M11FeatureKey, "market_regime" | "session_liquidity_state">;

/**
 * M11 feature snapshot을 계산하는 순수 application service다.
 *
 * 입력 market event와 cost snapshot만 읽고, DB/네트워크/broker/clock side effect를 만들지 않는다. 실패한 feature는 0으로
 * 대체하지 않고 `FeatureFailureResult`로 반환해 strategy가 주문 후보 생성을 fail-closed로 중지할 수 있게 한다.
 */
export function calculateM11FeatureSnapshot(
  input: FeatureCalculationInput,
  options: FeatureCalculationOptions = {},
): FeatureCalculationResult {
  let context: CalculationContext;
  try {
    context = createCalculationContext(input, options);
  } catch (error) {
    const failure = normalizeFeatureError(error);
    // 입력 정규화 실패도 호출자를 중단시키지 않고 전체 snapshot failure로 닫아 strategy 후보 생성을 막는다.
    return createInputFailureSnapshot(input, failure.reasonCode, failure.message);
  }

  const staleFailure = createStaleFailureIfNeeded(context);

  if (staleFailure !== undefined) {
    // stale 상태가 window 안에 있으면 부분 성공 값이 주문 후보를 열 수 있어 모든 feature를 실패로 닫는다.
    const failures = FEATURE_KEYS.map((key) => createFailure(context, key, staleFailure.reasonCode, staleFailure.message));
    return createSnapshotResult(context, failures, input.metadata);
  }

  const computed: ComputedFeatureValues = {};
  const results: FeatureResult[] = [
    calculateDecimalFeature(context, "candle_momentum_bps", () => calculateCandleMomentumBps(context), computed),
    calculateDecimalFeature(context, "realized_volatility_bps", () => calculateRealizedVolatilityBps(context), computed),
    calculateDecimalFeature(context, "volume_spike_ratio", () => calculateVolumeSpikeRatio(context), computed),
    calculateDecimalFeature(
      context,
      "bid_depth_slope_krw_per_bps",
      () => calculateDepthSlopeKrwPerBps(context, "bid"),
      computed,
    ),
    calculateDecimalFeature(
      context,
      "ask_depth_slope_krw_per_bps",
      () => calculateDepthSlopeKrwPerBps(context, "ask"),
      computed,
    ),
    calculateDecimalFeature(context, "depth_change_rate_ratio", () => calculateDepthChangeRateRatio(context), computed),
    calculateDecimalFeature(context, "vwap_deviation_bps", () => calculateVwapDeviationBps(context), computed),
    calculateDecimalFeature(context, "mean_reversion_discount_bps", () => calculateMeanReversionDiscountBps(computed), computed),
    calculateDecimalFeature(
      context,
      "trade_direction_imbalance_ratio",
      () => calculateTradeDirectionImbalanceRatio(context),
      computed,
    ),
    calculateDecimalFeature(context, "trend_strength_bps", () => calculateTrendStrengthBps(computed), computed),
  ];

  results.push(calculateDecimalFeature(context, "session_liquidity_score", () => calculateSessionLiquidityScore(context), computed));
  results.push(calculateMarketRegimeFeature(context, computed));
  results.push(calculateSessionLiquidityStateFeature(context, computed));
  results.push(
    calculateDecimalFeature(
      context,
      "cost_adjusted_expected_return_bps",
      () => calculateCostAdjustedExpectedReturnBps(input.cost),
      computed,
    ),
  );
  results.push(
    calculateDecimalFeature(
      context,
      "cost_adjusted_margin_bps",
      () => calculateCostAdjustedMarginBps(input.cost),
      computed,
    ),
  );

  return createSnapshotResult(context, results, input.metadata);
}

function createCalculationContext(
  input: FeatureCalculationInput,
  options: FeatureCalculationOptions,
): CalculationContext {
  const observedAt = parseTimestamp(input.observedAt);
  const events = sortAndValidateEvents(input.events);

  return {
    observedAt,
    observedAtIso: observedAt.toISOString(),
    events,
    options: resolveFeatureCalculationOptions(options),
  };
}

function calculateDecimalFeature(
  context: CalculationContext,
  key: DecimalFeatureKey,
  calculate: () => Decimal,
  computed: ComputedFeatureValues,
): FeatureResult {
  try {
    const value = calculate();
    rememberDecimalFeatureValue(computed, key, value);
    return createSuccess(context, key, value.toFixed());
  } catch (error) {
    const failure = normalizeFeatureError(error);
    // feature 실패는 값을 0으로 꾸미면 주문 후보가 열릴 수 있으므로 명시적 failure로 남긴다.
    return createFailure(context, key, failure.reasonCode, failure.message);
  }
}

function calculateCandleMomentumBps(context: CalculationContext): Decimal {
  const candles = buildTradeCandles(context, context.options.candleBucketCount);

  if (candles.length < 2) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "candle momentum requires at least two candle buckets");
  }

  const firstOpen = candles[0]!.open;
  const lastClose = candles[candles.length - 1]!.close;

  if (firstOpen.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "candle open must be positive");
  }

  return lastClose.minus(firstOpen).div(firstOpen).mul(10_000);
}

function calculateRealizedVolatilityBps(context: CalculationContext): Decimal {
  const candles = buildTradeCandles(context, context.options.candleBucketCount);
  const closes = candles.map((candle) => candle.close);

  if (closes.length < 3) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "realized volatility requires at least two return samples");
  }

  const returns = closes.slice(1).map((close, index) => {
    const previous = closes[index]!;
    if (previous.lessThanOrEqualTo(0)) {
      throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "previous close must be positive");
    }
    return close.minus(previous).div(previous);
  });
  const mean = average(returns);
  const variance = average(returns.map((value) => value.minus(mean).pow(2)));

  return variance.sqrt().mul(10_000);
}

function calculateVolumeSpikeRatio(context: CalculationContext): Decimal {
  const buckets = buildTradeBuckets(context, context.options.volumeBaselineBucketCount + 1);

  if (buckets.length < context.options.volumeBaselineBucketCount + 1) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "volume spike requires latest bucket and baseline buckets");
  }

  const latest = buckets[buckets.length - 1]!;
  const baselineBuckets = buckets.slice(0, -1);
  const latestNotional = sumTradeNotional(latest.trades);
  const baselineMedian = median(baselineBuckets.map((bucket) => sumTradeNotional(bucket.trades)));

  if (baselineMedian.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "volume baseline median must be positive");
  }

  return latestNotional.div(baselineMedian);
}

function calculateDepthSlopeKrwPerBps(context: CalculationContext, side: "bid" | "ask"): Decimal {
  const orderbook = getLatestOrderbook(context);
  const levels = (side === "bid" ? orderbook.bids : orderbook.asks).slice(0, context.options.orderbookDepthLevels);

  if (levels.length < 2) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", `${side} depth slope requires at least two levels`);
  }

  const bestPrice = parsePositiveLevelPrice(levels[0]!);
  const deepestPrice = parsePositiveLevelPrice(levels[levels.length - 1]!);
  const distanceBps =
    side === "bid"
      ? bestPrice.minus(deepestPrice).div(bestPrice).mul(10_000)
      : deepestPrice.minus(bestPrice).div(bestPrice).mul(10_000);

  if (distanceBps.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", `${side} depth slope requires price distance`);
  }

  return sumOrderbookNotional(levels).div(distanceBps);
}

function calculateDepthChangeRateRatio(context: CalculationContext): Decimal {
  const current = getLatestOrderbook(context);
  const referenceTime = context.observedAt.getTime() - context.options.depthChangeLookbackMs;
  const reference = getLatestOrderbookAtOrBefore(context, referenceTime);
  const currentTimestampMs = getEventTimestampMs(current);
  const referenceTimestampMs = getEventTimestampMs(reference);

  if (currentTimestampMs <= referenceTime || currentTimestampMs === referenceTimestampMs) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "depth change requires current and reference snapshots");
  }

  const currentDepth = calculateDepth5Notional(current);
  const referenceDepth = calculateDepth5Notional(reference);

  if (referenceDepth.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "reference depth must be positive");
  }

  return currentDepth.minus(referenceDepth).div(referenceDepth);
}

function calculateVwapDeviationBps(context: CalculationContext): Decimal {
  const trades = getTradesInLookback(context, context.options.candleBucketCount * context.options.candleBucketMs);

  if (trades.length === 0) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "VWAP deviation requires trade events");
  }

  const totalQuantity = trades.reduce((sum, trade) => sum.plus(parsePositiveDecimal(trade.quantity, "trade quantity")), new Decimal(0));
  const totalNotional = sumTradeNotional(trades);

  if (totalQuantity.lessThanOrEqualTo(0) || totalNotional.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "VWAP input must have positive quantity and notional");
  }

  const latestPrice = parsePositiveDecimal(trades[trades.length - 1]!.price, "latest trade price");
  const vwap = totalNotional.div(totalQuantity);

  return latestPrice.minus(vwap).div(vwap).mul(10_000);
}

/**
 * VWAP 대비 현재가 할인 폭을 autonomous 평균회귀 entry feature로 낮춘다.
 *
 * 책임:
 * - 기존 `vwap_deviation_bps`를 재사용해 기본 M11 feature 경로에서도 `mean_reversion_discount_bps`를 산출한다.
 * - 현재가가 VWAP보다 높으면 할인 폭은 0으로 닫아 BUY mean-reversion 신호로 과대 해석하지 않는다.
 *
 * side effect:
 * - 없음. 이미 계산된 feature cache만 읽는다.
 */
function calculateMeanReversionDiscountBps(computed: ComputedFeatureValues): Decimal {
  const required = readRequiredComputedDecimals(computed, ["vwapDeviationBps"]);
  return Decimal.max(required.vwapDeviationBps.negated(), 0);
}

function calculateTradeDirectionImbalanceRatio(context: CalculationContext): Decimal {
  const trades = getTradesInLookback(context, context.options.tradeImbalanceWindowMs).filter(
    (trade) => trade.side === "BID" || trade.side === "ASK",
  );

  if (trades.length === 0) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "trade direction imbalance requires BID or ASK trades");
  }

  let bidQuantity = new Decimal(0);
  let askQuantity = new Decimal(0);
  for (const trade of trades) {
    const quantity = parsePositiveDecimal(trade.quantity, "trade quantity");
    if (trade.side === "BID") {
      bidQuantity = bidQuantity.plus(quantity);
    } else {
      askQuantity = askQuantity.plus(quantity);
    }
  }

  const totalQuantity = bidQuantity.plus(askQuantity);
  if (totalQuantity.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "trade direction quantity must be positive");
  }

  return bidQuantity.minus(askQuantity).div(totalQuantity);
}

/**
 * 양의 candle momentum을 autonomous trend entry feature로 낮춘다.
 *
 * 책임:
 * - 기존 M11 candle momentum을 재사용해 production 기본 feature calculator가 `trend_strength_bps`를 제공하게 한다.
 * - 하락 momentum은 0으로 닫아 trend-following BUY 신호로 사용하지 않는다.
 *
 * side effect:
 * - 없음. 이미 계산된 feature cache만 읽는다.
 */
function calculateTrendStrengthBps(computed: ComputedFeatureValues): Decimal {
  const required = readRequiredComputedDecimals(computed, ["candleMomentumBps"]);
  return Decimal.max(required.candleMomentumBps, 0);
}

function calculateMarketRegimeFeature(context: CalculationContext, computed: ComputedFeatureValues): FeatureResult {
  try {
    const required = readRequiredComputedDecimals(computed, [
      "candleMomentumBps",
      "realizedVolatilityBps",
      "volumeSpikeRatio",
      "depthChangeRateRatio",
      "tradeDirectionImbalanceRatio",
      "vwapDeviationBps",
      "sessionLiquidityScore",
    ]);
    const spreadBps = calculateLatestSpreadBps(context);
    const regime = classifyMarketRegime(context, {
      candleMomentumBps: required.candleMomentumBps,
      realizedVolatilityBps: required.realizedVolatilityBps,
      volumeSpikeRatio: required.volumeSpikeRatio,
      depthChangeRateRatio: required.depthChangeRateRatio,
      tradeDirectionImbalanceRatio: required.tradeDirectionImbalanceRatio,
      vwapDeviationBps: required.vwapDeviationBps,
      sessionLiquidityScore: required.sessionLiquidityScore,
      spreadBps,
    });
    computed.marketRegime = regime;
    return createSuccess(context, "market_regime", regime);
  } catch (error) {
    const failure = normalizeFeatureError(error);
    return createFailure(context, "market_regime", failure.reasonCode, failure.message);
  }
}

function calculateSessionLiquidityScore(context: CalculationContext): Decimal {
  const tradeBuckets = buildTradeBuckets(context, context.options.volumeBaselineBucketCount + 1);

  if (tradeBuckets.length < context.options.volumeBaselineBucketCount + 1) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "session liquidity requires volume baseline buckets");
  }

  const latestVolume = sumTradeNotional(tradeBuckets[tradeBuckets.length - 1]!.trades);
  const volumeBaseline = median(tradeBuckets.slice(0, -1).map((bucket) => sumTradeNotional(bucket.trades)));
  const orderbookBuckets = buildOrderbookBuckets(context, context.options.volumeBaselineBucketCount + 1);
  const latestOrderbook = orderbookBuckets[orderbookBuckets.length - 1]!.orderbook;
  const baselineOrderbooks = orderbookBuckets
    .slice(0, -1)
    .map((bucket) => bucket.orderbook)
    .filter((orderbook): orderbook is OrderbookEvent => orderbook !== undefined);

  if (
    latestOrderbook === undefined ||
    baselineOrderbooks.length < context.options.volumeBaselineBucketCount ||
    volumeBaseline.lessThanOrEqualTo(0)
  ) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "session liquidity requires orderbook and volume baselines");
  }

  const currentDepth = calculateDepth5Notional(latestOrderbook);
  const depthBaseline = median(baselineOrderbooks.map((orderbook) => calculateDepth5Notional(orderbook)));

  if (currentDepth.lessThanOrEqualTo(0) || depthBaseline.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "session liquidity depth baseline must be positive");
  }

  const volumeScore = capRatioAtOne(latestVolume.div(volumeBaseline));
  const depthScore = capRatioAtOne(currentDepth.div(depthBaseline));
  const timeScore = kstSessionWeight(context.observedAt);

  return Decimal.min(volumeScore, depthScore, timeScore);
}

function calculateSessionLiquidityStateFeature(context: CalculationContext, computed: ComputedFeatureValues): FeatureResult {
  try {
    if (computed.sessionLiquidityScore === undefined) {
      throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "session liquidity state requires liquidity score");
    }

    const state: SessionLiquidityState = computed.sessionLiquidityScore.greaterThanOrEqualTo("0.75")
      ? "normal"
      : computed.sessionLiquidityScore.greaterThanOrEqualTo("0.5")
        ? "thin"
        : "stressed";
    computed.sessionLiquidityState = state;
    return createSuccess(context, "session_liquidity_state", state);
  } catch (error) {
    const failure = normalizeFeatureError(error);
    return createFailure(context, "session_liquidity_state", failure.reasonCode, failure.message);
  }
}

function calculateCostAdjustedExpectedReturnBps(cost: FeatureCostInput | undefined): Decimal {
  const values = readCostValuesWithoutSafetyBuffer(cost);
  return values.expectedReturnBps
    .minus(values.entryFeeBps)
    .minus(values.exitFeeBps)
    .minus(values.spreadCostBpsP75)
    .minus(values.expectedSlippageBpsP95)
    .minus(values.cancelRequotePenaltyBps);
}

function calculateCostAdjustedMarginBps(cost: FeatureCostInput | undefined): Decimal {
  const values = readCostValuesWithSafetyBuffer(cost);
  return values.expectedReturnBps
    .minus(values.entryFeeBps)
    .minus(values.exitFeeBps)
    .minus(values.spreadCostBpsP75)
    .minus(values.expectedSlippageBpsP95)
    .minus(values.cancelRequotePenaltyBps)
    .minus(values.safetyBufferBps);
}

function classifyMarketRegime(
  context: CalculationContext,
  input: {
    candleMomentumBps: Decimal;
    realizedVolatilityBps: Decimal;
    volumeSpikeRatio: Decimal;
    depthChangeRateRatio: Decimal;
    tradeDirectionImbalanceRatio: Decimal;
    vwapDeviationBps: Decimal;
    sessionLiquidityScore: Decimal;
    spreadBps: Decimal;
  },
): MarketRegime {
  if (
    input.depthChangeRateRatio.lessThan("-0.3") ||
    input.sessionLiquidityScore.lessThan(context.options.liquidityStressSessionLiquidityScore)
  ) {
    // 유동성 저하 국면은 가격 신호가 좋아도 체결 품질 리스크가 우선이므로 가장 먼저 차단 국면으로 분류한다.
    return "liquidity_stress";
  }

  if (
    input.realizedVolatilityBps.greaterThanOrEqualTo(context.options.volatileRealizedVolatilityBps) ||
    input.volumeSpikeRatio.greaterThanOrEqualTo(context.options.volatileVolumeSpikeRatio) ||
    input.spreadBps.greaterThanOrEqualTo(context.options.volatileSpreadBps)
  ) {
    return "volatile";
  }

  if (
    input.candleMomentumBps.greaterThanOrEqualTo(context.options.trendMomentumBps) &&
    input.tradeDirectionImbalanceRatio.greaterThanOrEqualTo(context.options.trendImbalanceRatio)
  ) {
    return "trend_up";
  }

  if (
    input.candleMomentumBps.lessThanOrEqualTo(context.options.trendMomentumBps.negated()) &&
    input.tradeDirectionImbalanceRatio.lessThanOrEqualTo(context.options.trendImbalanceRatio.negated())
  ) {
    return "trend_down";
  }

  if (input.vwapDeviationBps.abs().greaterThan(context.options.rangeMaxVwapDeviationBps)) {
    return "volatile";
  }

  return "range";
}

function buildTradeCandles(context: CalculationContext, bucketCount: number): readonly Candle[] {
  const buckets = buildTradeBuckets(context, bucketCount);
  const candles: Candle[] = [];

  for (const bucket of buckets) {
    if (bucket.trades.length === 0) {
      continue;
    }
    candles.push({
      open: parsePositiveDecimal(bucket.trades[0]!.price, "trade price"),
      close: parsePositiveDecimal(bucket.trades[bucket.trades.length - 1]!.price, "trade price"),
    });
  }

  if (candles.length < bucketCount) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "trade candle bucket is missing");
  }

  return candles;
}

function buildTradeBuckets(context: CalculationContext, bucketCount: number): readonly Bucket[] {
  const bucketMs = context.options.candleBucketMs;
  const endBucketStart = Math.floor(context.observedAt.getTime() / bucketMs) * bucketMs;
  const firstBucketStart = endBucketStart - (bucketCount - 1) * bucketMs;
  const buckets: Bucket[] = [];

  for (let index = 0; index < bucketCount; index += 1) {
    buckets.push({
      startMs: firstBucketStart + index * bucketMs,
      trades: [],
    });
  }

  const trades = context.events.filter((event): event is TradeEvent => event.type === "TRADE");
  for (const trade of trades) {
    const timestampMs = getEventTimestampMs(trade);
    if (timestampMs <= firstBucketStart - 1 || timestampMs > context.observedAt.getTime()) {
      continue;
    }
    const bucketStart = Math.floor(timestampMs / bucketMs) * bucketMs;
    const bucketIndex = (bucketStart - firstBucketStart) / bucketMs;
    if (Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex < buckets.length) {
      buckets[bucketIndex]!.trades.push(trade);
    }
  }

  return buckets;
}

function buildOrderbookBuckets(context: CalculationContext, bucketCount: number): readonly OrderbookBucket[] {
  const bucketMs = context.options.candleBucketMs;
  const endBucketStart = Math.floor(context.observedAt.getTime() / bucketMs) * bucketMs;
  const firstBucketStart = endBucketStart - (bucketCount - 1) * bucketMs;
  const buckets: OrderbookBucket[] = [];

  for (let index = 0; index < bucketCount; index += 1) {
    buckets.push({
      startMs: firstBucketStart + index * bucketMs,
    });
  }

  for (const orderbook of getOrderbooksUpToObservedAt(context)) {
    const timestampMs = getEventTimestampMs(orderbook);
    if (timestampMs < firstBucketStart || timestampMs > context.observedAt.getTime()) {
      continue;
    }
    const bucketStart = Math.floor(timestampMs / bucketMs) * bucketMs;
    const bucketIndex = (bucketStart - firstBucketStart) / bucketMs;
    if (Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex < buckets.length) {
      buckets[bucketIndex]!.orderbook = orderbook;
    }
  }

  return buckets;
}

function getTradesInLookback(context: CalculationContext, lookbackMs: number): readonly TradeEvent[] {
  const startMs = context.observedAt.getTime() - lookbackMs;
  return context.events.filter((event): event is TradeEvent => {
    if (event.type !== "TRADE") {
      return false;
    }
    const timestampMs = getEventTimestampMs(event);
    return timestampMs > startMs && timestampMs <= context.observedAt.getTime();
  });
}

function getLatestOrderbook(context: CalculationContext): OrderbookEvent {
  const orderbook = getOrderbooksUpToObservedAt(context).at(-1);

  if (orderbook === undefined) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "orderbook feature requires a snapshot");
  }

  return orderbook;
}

function getLatestOrderbookAtOrBefore(context: CalculationContext, timestampMs: number): OrderbookEvent {
  const orderbook = getOrderbooksUpToObservedAt(context)
    .filter((event) => getEventTimestampMs(event) <= timestampMs)
    .at(-1);

  if (orderbook === undefined) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "reference orderbook snapshot is missing");
  }

  return orderbook;
}

function getOrderbooksUpToObservedAt(context: CalculationContext): readonly OrderbookEvent[] {
  return context.events.filter((event): event is OrderbookEvent => {
    if (event.type !== "ORDERBOOK") {
      return false;
    }
    return getEventTimestampMs(event) <= context.observedAt.getTime();
  });
}

function sumTradeNotional(trades: readonly TradeEvent[]): Decimal {
  return trades.reduce(
    (sum, trade) =>
      sum.plus(parsePositiveDecimal(trade.price, "trade price").mul(parsePositiveDecimal(trade.quantity, "trade quantity"))),
    new Decimal(0),
  );
}

function sumOrderbookNotional(levels: readonly OrderbookLevel[]): Decimal {
  return levels.reduce(
    (sum, level) =>
      sum.plus(parsePositiveDecimal(level.price, "orderbook price").mul(parsePositiveDecimal(level.size, "orderbook size"))),
    new Decimal(0),
  );
}

function calculateDepth5Notional(orderbook: OrderbookEvent): Decimal {
  return sumOrderbookNotional(orderbook.bids.slice(0, 5)).plus(sumOrderbookNotional(orderbook.asks.slice(0, 5)));
}

function calculateLatestSpreadBps(context: CalculationContext): Decimal {
  const orderbook = getLatestOrderbook(context);
  const bestBid = parsePositiveLevelPrice(orderbook.bids[0] ?? failMissingBestLevel("bid"));
  const bestAsk = parsePositiveLevelPrice(orderbook.asks[0] ?? failMissingBestLevel("ask"));
  const midPrice = bestBid.plus(bestAsk).div(2);

  if (bestAsk.lessThanOrEqualTo(bestBid) || midPrice.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "orderbook spread must be positive");
  }

  return bestAsk.minus(bestBid).div(midPrice).mul(10_000);
}

function failMissingBestLevel(side: "bid" | "ask"): never {
  throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", `${side} best level is required for spread`);
}

function readCostValuesWithoutSafetyBuffer(
  cost: FeatureCostInput | undefined,
): Omit<Required<Record<keyof FeatureCostInput, Decimal>>, "safetyBufferBps"> {
  if (cost === undefined) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "cost-adjusted feature requires cost input");
  }

  return {
    expectedReturnBps: readRequiredCostDecimal(cost.expectedReturnBps, "expected_return_bps", true),
    entryFeeBps: readRequiredCostDecimal(cost.entryFeeBps, "entry_fee_bps", false),
    exitFeeBps: readRequiredCostDecimal(cost.exitFeeBps, "exit_fee_bps", false),
    spreadCostBpsP75: readRequiredCostDecimal(cost.spreadCostBpsP75, "spread_cost_bps_p75", false),
    expectedSlippageBpsP95: readRequiredCostDecimal(cost.expectedSlippageBpsP95, "expected_slippage_bps_p95", false),
    cancelRequotePenaltyBps: readRequiredCostDecimal(cost.cancelRequotePenaltyBps, "cancel_requote_penalty_bps", false),
  };
}

function readCostValuesWithSafetyBuffer(cost: FeatureCostInput | undefined): Required<Record<keyof FeatureCostInput, Decimal>> {
  const values = readCostValuesWithoutSafetyBuffer(cost);

  return {
    ...values,
    safetyBufferBps: readRequiredCostDecimal(cost?.safetyBufferBps, "safety_buffer_bps", false),
  };
}

function readRequiredCostDecimal(value: unknown, fieldName: string, allowNegative: boolean): Decimal {
  if (value === undefined) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", `${fieldName} is required`);
  }

  return parseDecimalValue(value, fieldName, allowNegative);
}

function parsePositiveLevelPrice(level: OrderbookLevel): Decimal {
  return parsePositiveDecimal(level.price, "orderbook price");
}

function parsePositiveDecimal(value: unknown, fieldName: string): Decimal {
  const decimal = parseDecimalValue(value, fieldName, false);

  if (decimal.isZero()) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", `${fieldName} must be positive`);
  }

  return decimal;
}

function parseDecimalValue(value: unknown, fieldName: string, allowNegative: boolean): Decimal {
  let decimal: Decimal;
  try {
    decimal = parseFinancialDecimal(value);
  } catch {
    throw new FeatureCalculationError("FEATURE_INVALID_DECIMAL", `${fieldName} must be a decimal string`);
  }

  if (!allowNegative && decimal.isNegative()) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", `${fieldName} must not be negative`);
  }

  return decimal;
}

function parseOptionDecimal(value: unknown): Decimal {
  return parseDecimalValue(value, "feature option", false);
}

function resolveFeatureCalculationOptions(options: FeatureCalculationOptions): ResolvedFeatureCalculationOptions {
  return {
    candleBucketMs: readPositiveIntegerOption(options.candleBucketMs ?? DEFAULT_OPTIONS.candleBucketMs, "candleBucketMs"),
    candleBucketCount: readPositiveIntegerOption(options.candleBucketCount ?? DEFAULT_OPTIONS.candleBucketCount, "candleBucketCount"),
    volumeBaselineBucketCount: readPositiveIntegerOption(
      options.volumeBaselineBucketCount ?? DEFAULT_OPTIONS.volumeBaselineBucketCount,
      "volumeBaselineBucketCount",
    ),
    tradeImbalanceWindowMs: readPositiveIntegerOption(
      options.tradeImbalanceWindowMs ?? DEFAULT_OPTIONS.tradeImbalanceWindowMs,
      "tradeImbalanceWindowMs",
    ),
    depthChangeLookbackMs: readPositiveIntegerOption(
      options.depthChangeLookbackMs ?? DEFAULT_OPTIONS.depthChangeLookbackMs,
      "depthChangeLookbackMs",
    ),
    orderbookDepthLevels: readPositiveIntegerOption(
      options.orderbookDepthLevels ?? DEFAULT_OPTIONS.orderbookDepthLevels,
      "orderbookDepthLevels",
    ),
    volatileRealizedVolatilityBps: parseOptionDecimal(
      options.volatileRealizedVolatilityBps ?? DEFAULT_OPTIONS.volatileRealizedVolatilityBps,
    ),
    volatileVolumeSpikeRatio: parseOptionDecimal(options.volatileVolumeSpikeRatio ?? DEFAULT_OPTIONS.volatileVolumeSpikeRatio),
    volatileSpreadBps: parseOptionDecimal(options.volatileSpreadBps ?? DEFAULT_OPTIONS.volatileSpreadBps),
    rangeMaxVwapDeviationBps: parseOptionDecimal(
      options.rangeMaxVwapDeviationBps ?? DEFAULT_OPTIONS.rangeMaxVwapDeviationBps,
    ),
    liquidityStressSessionLiquidityScore: parseOptionDecimal(
      options.liquidityStressSessionLiquidityScore ?? DEFAULT_OPTIONS.liquidityStressSessionLiquidityScore,
    ),
    trendMomentumBps: parseOptionDecimal(options.trendMomentumBps ?? DEFAULT_OPTIONS.trendMomentumBps),
    trendImbalanceRatio: parseOptionDecimal(options.trendImbalanceRatio ?? DEFAULT_OPTIONS.trendImbalanceRatio),
  };
}

function readPositiveIntegerOption(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", `${fieldName} must be a positive integer`);
  }

  return value;
}

function parseTimestamp(value: TimestampInput): Date {
  if (typeof value === "string") {
    parseTimestampNanos(value);
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (!Number.isFinite(parsed.getTime())) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "timestamp must be valid");
  }

  return parsed;
}

function parseTimestampNanos(value: TimestampInput): bigint {
  try {
    return parseMarketEventTimestampNanos(value);
  } catch {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "timestamp must include an explicit timezone");
  }
}

function getEventTimestampMs(event: MarketDataEvent): number {
  if (event.type === "STATUS") {
    return parseTimestamp(event.observedAt).getTime();
  }
  return parseTimestamp(event.exchangeTimestamp).getTime();
}

function sortAndValidateEvents(events: readonly MarketDataEvent[]): readonly MarketDataEvent[] {
  const candidates = events.map((event) => createEventOrderCandidate(event));
  validateSingleMarketBoundary(candidates);
  validateDuplicateTimestampOrderKeys(candidates);

  return candidates.sort(compareEventOrderCandidates).map(({ event }) => event);
}

function createEventOrderCandidate(event: MarketDataEvent): EventOrderCandidate {
  const timestamp = getEventTimestamp(event);
  const canonicalPayloadKey = createCanonicalEventPayloadKey(event);
  return {
    event,
    timestampMs: getEventTimestampMs(event),
    timestampNanos: parseTimestampNanos(timestamp),
    exchangeId: event.exchangeId,
    market: getEventMarket(event),
    sequence: readEventOrderText(event, "sequence") ?? createFallbackEventSequence(event),
    tieBreakKey: readEventOrderText(event, "tieBreakKey") ?? canonicalPayloadKey,
    canonicalPayloadKey,
  };
}

function getEventTimestamp(event: MarketDataEvent): TimestampInput {
  return event.type === "STATUS" ? event.observedAt : event.exchangeTimestamp;
}

function getEventMarket(event: MarketDataEvent): string | undefined {
  return "market" in event ? event.market : undefined;
}

function createFallbackEventSequence(event: MarketDataEvent): string {
  switch (event.type) {
    case "TRADE":
      return `trade:${event.tradeId}`;
    case "ORDERBOOK":
      return `orderbook:${timestampOrderKey(event.receivedAt)}`;
    case "TICKER":
      return `ticker:${timestampOrderKey(event.receivedAt)}`;
    case "STATUS":
      return `status:${event.status}:${timestampOrderKey(event.observedAt)}`;
  }
}

function createCanonicalEventPayloadKey(event: MarketDataEvent): string {
  switch (event.type) {
    case "TRADE":
      return JSON.stringify([
        "trade",
        event.exchangeId,
        event.market,
        timestampOrderKey(event.exchangeTimestamp),
        timestampOrderKey(event.receivedAt),
        event.tradeId,
        event.price,
        event.quantity,
        event.side,
      ]);
    case "ORDERBOOK":
      return JSON.stringify([
        "orderbook",
        event.exchangeId,
        event.market,
        timestampOrderKey(event.exchangeTimestamp),
        timestampOrderKey(event.receivedAt),
        orderbookLevelPayloadKey(event.asks),
        orderbookLevelPayloadKey(event.bids),
      ]);
    case "TICKER":
      return JSON.stringify([
        "ticker",
        event.exchangeId,
        event.market,
        timestampOrderKey(event.exchangeTimestamp),
        timestampOrderKey(event.receivedAt),
        event.tradePrice,
        event.changeRate ?? "*",
        event.accTradePrice24h ?? "*",
      ]);
    case "STATUS":
      return JSON.stringify([
        "status",
        event.exchangeId,
        event.market ?? "*",
        timestampOrderKey(event.observedAt),
        event.status,
        event.reasonCode ?? "*",
        event.websocketLagMs ?? "*",
        event.reconnectCount ?? "*",
      ]);
  }
}

function orderbookLevelPayloadKey(levels: readonly OrderbookLevel[]): readonly (readonly [unknown, unknown])[] {
  return levels.map((level) => [level.price, level.size] as const);
}

function timestampOrderKey(value: TimestampInput): string {
  return parseTimestampNanos(value).toString();
}

function validateSingleMarketBoundary(candidates: readonly EventOrderCandidate[]): void {
  let exchangeId: string | undefined;
  let market: string | undefined;

  for (const candidate of candidates) {
    if (exchangeId === undefined) {
      exchangeId = candidate.exchangeId;
    } else if (exchangeId !== candidate.exchangeId) {
      throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "feature input requires a single exchange");
    }

    if (candidate.market === undefined) {
      continue;
    }

    if (market === undefined) {
      market = candidate.market;
    } else if (market !== candidate.market) {
      // 서로 다른 market을 섞으면 정상 값처럼 보이는 오염 snapshot이 되므로 context 생성에서 먼저 차단한다.
      throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "feature input requires a single market");
    }
  }
}

function validateDuplicateTimestampOrderKeys(candidates: readonly EventOrderCandidate[]): void {
  const timestampCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const timestampKey = candidate.timestampNanos.toString();
    timestampCounts.set(timestampKey, (timestampCounts.get(timestampKey) ?? 0) + 1);
  }

  const seenOrderKeys = new Map<string, string>();
  for (const candidate of candidates) {
    if ((timestampCounts.get(candidate.timestampNanos.toString()) ?? 0) < 2) {
      continue;
    }

    const orderKey = JSON.stringify([
      candidate.timestampNanos.toString(),
      candidate.exchangeId,
      candidate.market ?? "*",
      candidate.sequence,
      candidate.tieBreakKey,
    ]);
    const existingPayloadKey = seenOrderKeys.get(orderKey);
    if (existingPayloadKey !== undefined && existingPayloadKey !== candidate.canonicalPayloadKey) {
      throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "duplicate event order key");
    }
    seenOrderKeys.set(orderKey, candidate.canonicalPayloadKey);
  }
}

function compareEventOrderCandidates(left: EventOrderCandidate, right: EventOrderCandidate): number {
  const timestampDiff = compareBigInt(left.timestampNanos, right.timestampNanos);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const sequenceDiff = compareSequence(left.sequence, right.sequence);
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }

  const tieBreakDiff = compareString(left.tieBreakKey, right.tieBreakKey);
  if (tieBreakDiff !== 0) {
    return tieBreakDiff;
  }

  const exchangeDiff = compareString(left.exchangeId, right.exchangeId);
  if (exchangeDiff !== 0) {
    return exchangeDiff;
  }

  return compareString(left.market ?? "*", right.market ?? "*");
}

function readEventOrderText(event: MarketDataEvent, key: "sequence" | "tieBreakKey"): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", `${key} must be a non-empty string`);
  }

  return value;
}

function createStaleFailureIfNeeded(
  context: CalculationContext,
): { reasonCode: FeatureCalculationFailureReasonCode; message: string } | undefined {
  const maxLookbackMs = Math.max(
    context.options.candleBucketMs * (context.options.volumeBaselineBucketCount + 1),
    context.options.candleBucketMs * context.options.candleBucketCount,
    context.options.tradeImbalanceWindowMs,
    context.options.depthChangeLookbackMs,
  );
  const startMs = context.observedAt.getTime() - maxLookbackMs;
  const staleStatus = context.events.find((event): event is Extract<MarketDataEvent, { type: "STATUS" }> => {
    if (event.type !== "STATUS") {
      return false;
    }
    const timestampMs = getEventTimestampMs(event);
    return (
      timestampMs > startMs &&
      timestampMs <= context.observedAt.getTime() &&
      (event.status === "STALE" || event.status === "RECONNECTING" || event.status === "DISCONNECTED")
    );
  });

  if (staleStatus === undefined) {
    return undefined;
  }

  return {
    reasonCode: "FEATURE_MARKET_DATA_STALE",
    message: `market data status blocks feature calculation: ${staleStatus.status}`,
  };
}

function createSuccess(
  context: CalculationContext,
  key: M11FeatureKey,
  value: FeatureValue,
  metadata?: FeatureSuccessResult["metadata"],
): FeatureSuccessResult {
  const result: FeatureSuccessResult = {
    status: "ok",
    key,
    value,
    observedAt: context.observedAtIso,
    windowEndAt: context.observedAtIso,
  };

  if (metadata !== undefined) {
    return {
      ...result,
      metadata,
    };
  }

  return result;
}

function createFailure(
  context: CalculationContext,
  key: M11FeatureKey,
  reasonCode: FeatureCalculationFailureReasonCode,
  message: string,
  metadata?: FeatureFailureResult["metadata"],
): FeatureFailureResult {
  const result: FeatureFailureResult = {
    status: "failed",
    key,
    reasonCode,
    message,
    observedAt: context.observedAtIso,
    windowEndAt: context.observedAtIso,
  };

  if (metadata !== undefined) {
    return {
      ...result,
      metadata,
    };
  }

  return result;
}

function createSnapshotResult(
  context: CalculationContext,
  results: readonly FeatureResult[],
  metadata?: FeatureCalculationInput["metadata"],
): FeatureCalculationResult {
  const features: Partial<Record<M11FeatureKey, FeatureValue>> = {};
  const failureReasons: FeatureFailureResult[] = [];

  for (const result of results) {
    if (result.status === "ok") {
      features[result.key] = result.value;
    } else {
      failureReasons.push(result);
    }
  }

  const snapshot: FeatureCalculationResult = {
    status: failureReasons.length === 0 ? "ok" : "failed",
    observedAt: context.observedAtIso,
    features,
    results,
    failureReasons,
  };

  if (metadata !== undefined) {
    return {
      ...snapshot,
      metadata,
    };
  }

  return snapshot;
}

function createInputFailureSnapshot(
  input: FeatureCalculationInput,
  reasonCode: FeatureCalculationFailureReasonCode,
  message: string,
): FeatureCalculationResult {
  const observedAt = safeObservedAtIso(input.observedAt);
  const results: FeatureFailureResult[] = FEATURE_KEYS.map((key) => ({
    status: "failed",
    key,
    reasonCode,
    message,
    observedAt,
    windowEndAt: observedAt,
  }));
  const snapshot: FeatureCalculationResult = {
    status: "failed",
    observedAt,
    features: {},
    results,
    failureReasons: results,
  };

  if (input.metadata !== undefined) {
    return {
      ...snapshot,
      metadata: input.metadata,
    };
  }

  return snapshot;
}

function safeObservedAtIso(value: TimestampInput): string {
  try {
    return parseTimestamp(value).toISOString();
  } catch {
    return typeof value === "string" ? value : "invalid";
  }
}

function normalizeFeatureError(error: unknown): { reasonCode: FeatureCalculationFailureReasonCode; message: string } {
  if (error instanceof FeatureCalculationError) {
    return {
      reasonCode: error.reasonCode,
      message: error.message,
    };
  }

  return {
    reasonCode: "FEATURE_INVALID_MARKET_VALUE",
    message: error instanceof Error ? error.message : "feature calculation failed",
  };
}

class FeatureCalculationError extends Error {
  public constructor(
    public readonly reasonCode: FeatureCalculationFailureReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "FeatureCalculationError";
  }
}

function rememberDecimalFeatureValue(computed: ComputedFeatureValues, key: DecimalFeatureKey, value: Decimal): void {
  switch (key) {
    case "candle_momentum_bps":
      computed.candleMomentumBps = value;
      break;
    case "realized_volatility_bps":
      computed.realizedVolatilityBps = value;
      break;
    case "volume_spike_ratio":
      computed.volumeSpikeRatio = value;
      break;
    case "bid_depth_slope_krw_per_bps":
      computed.bidDepthSlopeKrwPerBps = value;
      break;
    case "ask_depth_slope_krw_per_bps":
      computed.askDepthSlopeKrwPerBps = value;
      break;
    case "depth_change_rate_ratio":
      computed.depthChangeRateRatio = value;
      break;
    case "vwap_deviation_bps":
      computed.vwapDeviationBps = value;
      break;
    case "trade_direction_imbalance_ratio":
      computed.tradeDirectionImbalanceRatio = value;
      break;
    case "trend_strength_bps":
      computed.trendStrengthBps = value;
      break;
    case "mean_reversion_discount_bps":
      computed.meanReversionDiscountBps = value;
      break;
    case "session_liquidity_score":
      computed.sessionLiquidityScore = value;
      break;
    case "cost_adjusted_expected_return_bps":
      computed.costAdjustedExpectedReturnBps = value;
      break;
    case "cost_adjusted_margin_bps":
      computed.costAdjustedMarginBps = value;
      break;
  }
}

function readRequiredComputedDecimals<T extends readonly (keyof ComputedFeatureValues)[]>(
  computed: ComputedFeatureValues,
  keys: T,
): { [K in T[number]]: Decimal } {
  const output: Partial<Record<keyof ComputedFeatureValues, Decimal>> = {};
  for (const key of keys) {
    const value = computed[key];
    if (!(value instanceof Decimal)) {
      throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", `${String(key)} is required for market regime`);
    }
    output[key] = value;
  }
  return output as { [K in T[number]]: Decimal };
}

function compareSequence(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (isUnsignedIntegerText(left) && isUnsignedIntegerText(right)) {
    const normalizedLeft = trimLeadingZeroes(left);
    const normalizedRight = trimLeadingZeroes(right);

    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length - normalizedRight.length;
    }

    const normalizedDiff = compareString(normalizedLeft, normalizedRight);
    if (normalizedDiff !== 0) {
      return normalizedDiff;
    }

    return compareString(left, right);
  }

  return compareString(left, right);
}

function compareString(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function isUnsignedIntegerText(value: string): boolean {
  return /^\d+$/u.test(value);
}

function trimLeadingZeroes(value: string): string {
  const trimmed = value.replace(/^0+/u, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

function average(values: readonly Decimal[]): Decimal {
  if (values.length === 0) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "average requires values");
  }
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "median requires values");
  }

  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }

  return sorted[middle - 1]!.plus(sorted[middle]!).div(2);
}

function capRatioAtOne(value: Decimal): Decimal {
  if (value.isNegative()) {
    return new Decimal(0);
  }
  return Decimal.min(value, new Decimal(1));
}

function kstSessionWeight(observedAt: Date): Decimal {
  const kstHour = new Date(observedAt.getTime() + 9 * 60 * 60 * 1000).getUTCHours();

  if (kstHour >= 9 && kstHour <= 23) {
    return new Decimal(1);
  }

  if (kstHour >= 0 && kstHour <= 2) {
    return new Decimal("0.6");
  }

  return new Decimal("0.8");
}
