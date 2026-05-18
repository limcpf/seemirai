import { z } from "zod";
import { defaultRiskLimitThresholds } from "../domain/index.js";
import { parseFinancialDecimal } from "../shared/index.js";

const NonNegativeDecimalStringSchema = z.string().refine((value) => isValidDecimal(value), {
  message: "must be a non-negative decimal string",
});

const PositiveIntegerSchema = z.number().int().positive();

export const RiskThresholdConfigSchema = z
  .object({
    daily_loss_limit_bps: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.dailyLossLimitBps,
    ),
    weekly_loss_limit_bps: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.weeklyLossLimitBps,
    ),
    max_drawdown_bps: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.maxDrawdownBps,
    ),
    max_order_notional_bps_of_equity: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.maxOrderNotionalBpsOfEquity,
    ),
    max_expected_loss_bps_of_equity: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.maxExpectedLossBpsOfEquity,
    ),
    btc_eth_max_position_bps_of_equity: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.btcEthMaxPositionBpsOfEquity,
    ),
    alt_max_position_bps_of_equity: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.altMaxPositionBpsOfEquity,
    ),
    total_alt_max_position_bps_of_equity: NonNegativeDecimalStringSchema.default(
      defaultRiskLimitThresholds.totalAltMaxPositionBpsOfEquity,
    ),
    max_consecutive_strategy_losses: PositiveIntegerSchema.default(
      defaultRiskLimitThresholds.maxConsecutiveStrategyLosses,
    ),
  })
  .strict();

export const defaultRiskConfig = {
  thresholds: {
    daily_loss_limit_bps: defaultRiskLimitThresholds.dailyLossLimitBps,
    weekly_loss_limit_bps: defaultRiskLimitThresholds.weeklyLossLimitBps,
    max_drawdown_bps: defaultRiskLimitThresholds.maxDrawdownBps,
    max_order_notional_bps_of_equity: defaultRiskLimitThresholds.maxOrderNotionalBpsOfEquity,
    max_expected_loss_bps_of_equity: defaultRiskLimitThresholds.maxExpectedLossBpsOfEquity,
    btc_eth_max_position_bps_of_equity: defaultRiskLimitThresholds.btcEthMaxPositionBpsOfEquity,
    alt_max_position_bps_of_equity: defaultRiskLimitThresholds.altMaxPositionBpsOfEquity,
    total_alt_max_position_bps_of_equity: defaultRiskLimitThresholds.totalAltMaxPositionBpsOfEquity,
    max_consecutive_strategy_losses: defaultRiskLimitThresholds.maxConsecutiveStrategyLosses,
  },
} as const;

export const RiskConfigSchema = z
  .object({
    thresholds: RiskThresholdConfigSchema.default(defaultRiskConfig.thresholds),
  })
  .strict()
  .default(defaultRiskConfig);

export type RiskThresholdConfig = z.infer<typeof RiskThresholdConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

function isValidDecimal(value: string): boolean {
  try {
    return !parseFinancialDecimal(value).isNegative();
  } catch {
    return false;
  }
}
