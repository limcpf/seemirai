import { Decimal } from "decimal.js";
import { z } from "zod";
import { parseFinancialDecimal } from "../shared/index.js";

const NonNegativeDecimalStringSchema = z.string().refine((value) => isValidDecimal(value), {
  message: "must be a non-negative decimal string",
});

const PositiveIntegerSchema = z.number().int().positive();

const OrderbookImbalanceThresholdSchema = NonNegativeDecimalStringSchema.refine(
  (value) => isDecimalLessThanOrEqualTo(value, new Decimal(1)),
  {
    message: "must be between 0 and 1",
  },
);

export const TrendFollowingStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("8"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("50000000"),
    breakout_lookback_buckets: PositiveIntegerSchema.default(20),
    min_trade_strength: NonNegativeDecimalStringSchema.default("1.2"),
    min_orderbook_imbalance: OrderbookImbalanceThresholdSchema.default("0.08"),
  })
  .strict();

export const MeanReversionStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("6"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("70000000"),
    entry_deviation_bps: NonNegativeDecimalStringSchema.default("25"),
    exit_deviation_bps: NonNegativeDecimalStringSchema.default("8"),
    stop_loss_bps: NonNegativeDecimalStringSchema.default("35"),
  })
  .strict();

export const VolatilityBreakoutStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("8"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("50000000"),
    breakout_lookback_buckets: PositiveIntegerSchema.default(20),
    min_volatility_expansion_bps: NonNegativeDecimalStringSchema.default("18"),
  })
  .strict();

export const OrderbookImbalanceMomentumStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("7"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("60000000"),
    min_trade_strength: NonNegativeDecimalStringSchema.default("1.25"),
    min_orderbook_imbalance: OrderbookImbalanceThresholdSchema.default("0.1"),
  })
  .strict();

export const LiquidityReversionStrategyParametersSchema = z
  .object({
    max_spread_bps: NonNegativeDecimalStringSchema.default("5"),
    min_depth_krw: NonNegativeDecimalStringSchema.default("90000000"),
    entry_deviation_bps: NonNegativeDecimalStringSchema.default("18"),
    stop_loss_bps: NonNegativeDecimalStringSchema.default("30"),
  })
  .strict();

export const defaultStrategyParametersConfig = {
  trend_following: {
    max_spread_bps: "8",
    min_depth_krw: "50000000",
    breakout_lookback_buckets: 20,
    min_trade_strength: "1.2",
    min_orderbook_imbalance: "0.08",
  },
  mean_reversion: {
    max_spread_bps: "6",
    min_depth_krw: "70000000",
    entry_deviation_bps: "25",
    exit_deviation_bps: "8",
    stop_loss_bps: "35",
  },
  volatility_breakout: {
    max_spread_bps: "8",
    min_depth_krw: "50000000",
    breakout_lookback_buckets: 20,
    min_volatility_expansion_bps: "18",
  },
  orderbook_imbalance_momentum: {
    max_spread_bps: "7",
    min_depth_krw: "60000000",
    min_trade_strength: "1.25",
    min_orderbook_imbalance: "0.1",
  },
  liquidity_reversion: {
    max_spread_bps: "5",
    min_depth_krw: "90000000",
    entry_deviation_bps: "18",
    stop_loss_bps: "30",
  },
} as const;

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

function isDecimalLessThanOrEqualTo(value: string, max: Decimal): boolean {
  try {
    return parseFinancialDecimal(value).lessThanOrEqualTo(max);
  } catch {
    return false;
  }
}
