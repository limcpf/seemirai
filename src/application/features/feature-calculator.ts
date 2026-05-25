import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { MarketDataEvent, OrderbookEvent, OrderbookLevel, TimestampInput, TradeEvent } from "../../domain/index.js";
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

const DEFAULT_OPTIONS = {
  candleBucketMs: 60_000,
  candleBucketCount: 20,
  volumeBaselineBucketCount: 20,
  tradeImbalanceWindowMs: 5 * 60_000,
  depthChangeLookbackMs: 5 * 60_000,
  orderbookDepthLevels: 15,
  volatileRealizedVolatilityBps: "5000",
  volatileVolumeSpikeRatio: "3",
  trendMomentumBps: "10",
  trendImbalanceRatio: "0.2",
} as const;

const FEATURE_KEYS: readonly M11FeatureKey[] = [
  "candle_momentum_bps",
  "realized_volatility_bps",
  "volume_spike_ratio",
  "bid_depth_slope_krw_per_bps",
  "ask_depth_slope_krw_per_bps",
  "depth_change_rate_ratio",
  "vwap_deviation_bps",
  "trade_direction_imbalance_ratio",
  "market_regime",
  "session_liquidity_score",
  "session_liquidity_state",
  "cost_adjusted_expected_return_bps",
  "cost_adjusted_margin_bps",
];

interface ResolvedFeatureCalculationOptions {
  candleBucketMs: number;
  candleBucketCount: number;
  volumeBaselineBucketCount: number;
  tradeImbalanceWindowMs: number;
  depthChangeLookbackMs: number;
  orderbookDepthLevels: number;
  volatileRealizedVolatilityBps: Decimal;
  volatileVolumeSpikeRatio: Decimal;
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
  const context = createCalculationContext(input, options);
  const staleFailure = createStaleFailureIfNeeded(context);

  if (staleFailure !== undefined) {
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
    calculateDecimalFeature(
      context,
      "trade_direction_imbalance_ratio",
      () => calculateTradeDirectionImbalanceRatio(context),
      computed,
    ),
  ];

  results.push(calculateMarketRegimeFeature(context, computed));
  results.push(calculateDecimalFeature(context, "session_liquidity_score", () => calculateSessionLiquidityScore(context), computed));
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

  return {
    observedAt,
    observedAtIso: observedAt.toISOString(),
    events: sortEvents(input.events),
    options: {
      candleBucketMs: options.candleBucketMs ?? DEFAULT_OPTIONS.candleBucketMs,
      candleBucketCount: options.candleBucketCount ?? DEFAULT_OPTIONS.candleBucketCount,
      volumeBaselineBucketCount: options.volumeBaselineBucketCount ?? DEFAULT_OPTIONS.volumeBaselineBucketCount,
      tradeImbalanceWindowMs: options.tradeImbalanceWindowMs ?? DEFAULT_OPTIONS.tradeImbalanceWindowMs,
      depthChangeLookbackMs: options.depthChangeLookbackMs ?? DEFAULT_OPTIONS.depthChangeLookbackMs,
      orderbookDepthLevels: options.orderbookDepthLevels ?? DEFAULT_OPTIONS.orderbookDepthLevels,
      volatileRealizedVolatilityBps: parseOptionDecimal(
        options.volatileRealizedVolatilityBps ?? DEFAULT_OPTIONS.volatileRealizedVolatilityBps,
      ),
      volatileVolumeSpikeRatio: parseOptionDecimal(
        options.volatileVolumeSpikeRatio ?? DEFAULT_OPTIONS.volatileVolumeSpikeRatio,
      ),
      trendMomentumBps: parseOptionDecimal(options.trendMomentumBps ?? DEFAULT_OPTIONS.trendMomentumBps),
      trendImbalanceRatio: parseOptionDecimal(options.trendImbalanceRatio ?? DEFAULT_OPTIONS.trendImbalanceRatio),
    },
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

function calculateMarketRegimeFeature(context: CalculationContext, computed: ComputedFeatureValues): FeatureResult {
  try {
    const required = readRequiredComputedDecimals(computed, [
      "candleMomentumBps",
      "realizedVolatilityBps",
      "volumeSpikeRatio",
      "depthChangeRateRatio",
      "tradeDirectionImbalanceRatio",
      "vwapDeviationBps",
    ]);
    const regime = classifyMarketRegime(context, {
      candleMomentumBps: required.candleMomentumBps,
      realizedVolatilityBps: required.realizedVolatilityBps,
      volumeSpikeRatio: required.volumeSpikeRatio,
      depthChangeRateRatio: required.depthChangeRateRatio,
      tradeDirectionImbalanceRatio: required.tradeDirectionImbalanceRatio,
      vwapDeviationBps: required.vwapDeviationBps,
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
  const orderbooks = getOrderbooksUpToObservedAt(context);

  if (orderbooks.length < 2 || volumeBaseline.lessThanOrEqualTo(0)) {
    throw new FeatureCalculationError("FEATURE_INSUFFICIENT_INPUT", "session liquidity requires orderbook and volume baselines");
  }

  const currentDepth = calculateDepth5Notional(orderbooks[orderbooks.length - 1]!);
  const depthBaseline = median(orderbooks.slice(0, -1).map((orderbook) => calculateDepth5Notional(orderbook)));

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
  },
): MarketRegime {
  if (input.depthChangeRateRatio.lessThan("-0.3")) {
    return "liquidity_stress";
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

  if (
    input.realizedVolatilityBps.greaterThanOrEqualTo(context.options.volatileRealizedVolatilityBps) ||
    input.volumeSpikeRatio.greaterThanOrEqualTo(context.options.volatileVolumeSpikeRatio)
  ) {
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

function parseTimestamp(value: TimestampInput): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (!Number.isFinite(parsed.getTime())) {
    throw new FeatureCalculationError("FEATURE_INVALID_MARKET_VALUE", "timestamp must be valid");
  }

  return parsed;
}

function getEventTimestampMs(event: MarketDataEvent): number {
  if (event.type === "STATUS") {
    return parseTimestamp(event.observedAt).getTime();
  }
  return parseTimestamp(event.exchangeTimestamp).getTime();
}

function sortEvents(events: readonly MarketDataEvent[]): readonly MarketDataEvent[] {
  return [...events].sort((left, right) => getEventTimestampMs(left) - getEventTimestampMs(right));
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
