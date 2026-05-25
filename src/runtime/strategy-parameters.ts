import { Decimal } from "decimal.js";
import { z } from "zod";
import { parseFinancialDecimal } from "../shared/index.js";

const NonNegativeDecimalStringSchema = z.string().refine((value) => isValidDecimal(value), {
  message: "must be a non-negative decimal string",
});

const DecimalStringSchema = z.string().refine((value) => canParseDecimal(value), {
  message: "must be a decimal string",
});

const PositiveIntegerSchema = z.number().int().positive();

const OrderbookImbalanceThresholdSchema = NonNegativeDecimalStringSchema.refine(
  (value) => isDecimalLessThanOrEqualTo(value, new Decimal(1)),
  {
    message: "must be between 0 and 1",
  },
);

const RatioZeroToOneSchema = NonNegativeDecimalStringSchema.refine(
  (value) => isDecimalLessThanOrEqualTo(value, new Decimal(1)),
  {
    message: "must be between 0 and 1",
  },
);

const MarketRegimeSchema = z.enum(["trend_up", "trend_down", "range", "volatile", "liquidity_stress"]);
/**
 * runtime config가 strategy layer로 전달하는 M11 시장 국면 enum이다.
 *
 * config 검증 경계에서만 사용하며, 사용자 표시 문구가 아니라 내부 feature code로 보존된다. 이 타입에 없는 값은 startup
 * 단계에서 차단해 strategy 평가 중 unknown regime을 보정하지 않는 것이 invariant다.
 */
type MarketRegime = z.infer<typeof MarketRegimeSchema>;
const AllowedMarketRegimesSchema = z.array(MarketRegimeSchema).nonempty("must include at least one market regime");
const allMarketRegimes = ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"] as const;

export const TrendFollowingStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("8"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("50000000"),
    breakout_lookback_buckets: PositiveIntegerSchema.default(20),
    min_trade_strength: NonNegativeDecimalStringSchema.default("1.2"),
    min_orderbook_imbalance: OrderbookImbalanceThresholdSchema.default("0.08"),
    min_volatility_expansion_bps: NonNegativeDecimalStringSchema.default("18"),
    min_candle_momentum_bps: NonNegativeDecimalStringSchema.default("0"),
    min_realized_volatility_bps: NonNegativeDecimalStringSchema.default("0"),
    max_realized_volatility_bps: NonNegativeDecimalStringSchema.default("100000"),
    min_volume_spike_ratio: NonNegativeDecimalStringSchema.default("0"),
    min_trade_direction_imbalance: RatioZeroToOneSchema.default("0"),
    allowed_market_regimes: AllowedMarketRegimesSchema.default(defaultAllowedMarketRegimes()),
    min_cost_adjusted_margin_bps: DecimalStringSchema.default("0"),
  })
  .strict();

export const MeanReversionStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("6"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("70000000"),
    entry_deviation_bps: NonNegativeDecimalStringSchema.default("25"),
    exit_deviation_bps: NonNegativeDecimalStringSchema.default("8"),
    stop_loss_bps: NonNegativeDecimalStringSchema.default("35"),
    min_realized_volatility_bps: NonNegativeDecimalStringSchema.default("0"),
    max_realized_volatility_bps: NonNegativeDecimalStringSchema.default("100000"),
    min_abs_vwap_deviation_bps: NonNegativeDecimalStringSchema.default("0"),
    min_session_liquidity_score: RatioZeroToOneSchema.default("0"),
    allowed_market_regimes: AllowedMarketRegimesSchema.default(defaultAllowedMarketRegimes()),
    min_cost_adjusted_margin_bps: DecimalStringSchema.default("0"),
  })
  .strict();

export const VolatilityBreakoutStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("8"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("50000000"),
    breakout_lookback_buckets: PositiveIntegerSchema.default(20),
    min_volatility_expansion_bps: NonNegativeDecimalStringSchema.default("18"),
    min_candle_momentum_bps: NonNegativeDecimalStringSchema.default("0"),
    min_realized_volatility_bps: NonNegativeDecimalStringSchema.default("0"),
    max_realized_volatility_bps: NonNegativeDecimalStringSchema.default("100000"),
    min_volume_spike_ratio: NonNegativeDecimalStringSchema.default("0"),
    allowed_market_regimes: AllowedMarketRegimesSchema.default(defaultAllowedMarketRegimes()),
    min_cost_adjusted_margin_bps: DecimalStringSchema.default("0"),
  })
  .strict();

export const OrderbookImbalanceMomentumStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("7"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("60000000"),
    min_trade_strength: NonNegativeDecimalStringSchema.default("1.25"),
    min_orderbook_imbalance: OrderbookImbalanceThresholdSchema.default("0.1"),
    min_depth_slope_krw_per_bps: NonNegativeDecimalStringSchema.default("0"),
    min_depth_change_rate_ratio: DecimalStringSchema.default("-1"),
    min_trade_direction_imbalance: RatioZeroToOneSchema.default("0"),
    min_cost_adjusted_margin_bps: DecimalStringSchema.default("0"),
  })
  .strict();

export const LiquidityReversionStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("5"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("90000000"),
    entry_deviation_bps: NonNegativeDecimalStringSchema.default("18"),
    stop_loss_bps: NonNegativeDecimalStringSchema.default("30"),
    min_depth_change_rate_ratio: DecimalStringSchema.default("-1"),
    min_abs_vwap_deviation_bps: NonNegativeDecimalStringSchema.default("0"),
    min_session_liquidity_score: RatioZeroToOneSchema.default("0"),
    min_cost_adjusted_margin_bps: DecimalStringSchema.default("0"),
  })
  .strict();

export const defaultStrategyParametersConfig = {
  trend_following: {
    max_spread_bps: "8",
    min_depth_krw: "50000000",
    breakout_lookback_buckets: 20,
    min_trade_strength: "1.2",
    min_orderbook_imbalance: "0.08",
    min_volatility_expansion_bps: "18",
    min_candle_momentum_bps: "0",
    min_realized_volatility_bps: "0",
    max_realized_volatility_bps: "100000",
    min_volume_spike_ratio: "0",
    min_trade_direction_imbalance: "0",
    allowed_market_regimes: defaultAllowedMarketRegimes(),
    min_cost_adjusted_margin_bps: "0",
  },
  mean_reversion: {
    max_spread_bps: "6",
    min_depth_krw: "70000000",
    entry_deviation_bps: "25",
    exit_deviation_bps: "8",
    stop_loss_bps: "35",
    min_realized_volatility_bps: "0",
    max_realized_volatility_bps: "100000",
    min_abs_vwap_deviation_bps: "0",
    min_session_liquidity_score: "0",
    allowed_market_regimes: defaultAllowedMarketRegimes(),
    min_cost_adjusted_margin_bps: "0",
  },
  volatility_breakout: {
    max_spread_bps: "8",
    min_depth_krw: "50000000",
    breakout_lookback_buckets: 20,
    min_volatility_expansion_bps: "18",
    min_candle_momentum_bps: "0",
    min_realized_volatility_bps: "0",
    max_realized_volatility_bps: "100000",
    min_volume_spike_ratio: "0",
    allowed_market_regimes: defaultAllowedMarketRegimes(),
    min_cost_adjusted_margin_bps: "0",
  },
  orderbook_imbalance_momentum: {
    max_spread_bps: "7",
    min_depth_krw: "60000000",
    min_trade_strength: "1.25",
    min_orderbook_imbalance: "0.1",
    min_depth_slope_krw_per_bps: "0",
    min_depth_change_rate_ratio: "-1",
    min_trade_direction_imbalance: "0",
    min_cost_adjusted_margin_bps: "0",
  },
  liquidity_reversion: {
    max_spread_bps: "5",
    min_depth_krw: "90000000",
    entry_deviation_bps: "18",
    stop_loss_bps: "30",
    min_depth_change_rate_ratio: "-1",
    min_abs_vwap_deviation_bps: "0",
    min_session_liquidity_score: "0",
    min_cost_adjusted_margin_bps: "0",
  },
};

export const StrategyParametersConfigSchema = z
  .object({
    trend_following: TrendFollowingStrategyParametersSchema.default(
      defaultStrategyParametersConfig.trend_following,
    ),
    mean_reversion: MeanReversionStrategyParametersSchema.default(
      defaultStrategyParametersConfig.mean_reversion,
    ),
    volatility_breakout: VolatilityBreakoutStrategyParametersSchema.default(
      defaultStrategyParametersConfig.volatility_breakout,
    ),
    orderbook_imbalance_momentum: OrderbookImbalanceMomentumStrategyParametersSchema.default(
      defaultStrategyParametersConfig.orderbook_imbalance_momentum,
    ),
    liquidity_reversion: LiquidityReversionStrategyParametersSchema.default(
      defaultStrategyParametersConfig.liquidity_reversion,
    ),
  })
  .strict()
  .default(defaultStrategyParametersConfig);

export type TrendFollowingStrategyParameters = z.infer<
  typeof TrendFollowingStrategyParametersSchema
>;
export type MeanReversionStrategyParameters = z.infer<
  typeof MeanReversionStrategyParametersSchema
>;
export type VolatilityBreakoutStrategyParameters = z.infer<
  typeof VolatilityBreakoutStrategyParametersSchema
>;
export type OrderbookImbalanceMomentumStrategyParameters = z.infer<
  typeof OrderbookImbalanceMomentumStrategyParametersSchema
>;
export type LiquidityReversionStrategyParameters = z.infer<
  typeof LiquidityReversionStrategyParametersSchema
>;
export type StrategyParametersConfig = z.infer<typeof StrategyParametersConfigSchema>;

function isValidDecimal(value: string): boolean {
  try {
    return !parseFinancialDecimal(value).isNegative();
  } catch {
    return false;
  }
}

/**
 * 음수 허용 Decimal string config 값을 schema refine 단계에서 검증한다.
 *
 * 비용 차감 margin과 depth 변화율처럼 음수가 의미 있는 threshold에 사용한다. 파싱 성공 여부만 반환하고 외부 상태는 변경하지
 * 않는다.
 */
function canParseDecimal(value: string): boolean {
  try {
    parseFinancialDecimal(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 모든 M11 market regime을 포함하는 non-empty 기본 profile을 만든다.
 *
 * zod default가 배열 참조를 공유하지 않도록 매번 새 배열을 반환한다. 기본 profile은 Sub PR 5 calibration 전까지 regime을
 * 공격적으로 제한하지 않는 것이 invariant다.
 */
function defaultAllowedMarketRegimes(): [MarketRegime, ...MarketRegime[]] {
  return [...allMarketRegimes] as [MarketRegime, ...MarketRegime[]];
}

function isDecimalLessThanOrEqualTo(value: string, max: Decimal): boolean {
  try {
    return parseFinancialDecimal(value).lessThanOrEqualTo(max);
  } catch {
    return false;
  }
}
