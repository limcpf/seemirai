import { z } from "zod";
import { defaultRiskLimitThresholds } from "../domain/index.js";
import { parseFinancialDecimal } from "../shared/index.js";

/**
 * 리스크 threshold에서 사용하는 bps/금액 문자열을 Decimal-safe 값으로 제한한다.
 */
const NonNegativeDecimalStringSchema = z.string().refine((value) => isValidDecimal(value), {
  message: "must be a non-negative decimal string",
});

/**
 * 연속 손실 횟수처럼 정수로만 의미가 있는 리스크 threshold를 제한한다.
 */
const PositiveIntegerSchema = z.number().int().positive();

/**
 * `config/paper.json`의 `risk.thresholds` 구조를 검증하는 schema다.
 */
// 설정 파일의 snake_case 값을 domain threshold의 source of truth와 같은 기본값으로 맞춘다.
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

/**
 * paper trading 기본 runtime이 사용하는 리스크 설정 기본값이다.
 */
// 기본값은 domain의 camelCase threshold를 runtime config의 snake_case shape로만 변환한다.
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

/**
 * runtime config의 `risk` top-level section 전체를 검증하는 schema다.
 */
export const RiskConfigSchema = z
  .object({
    thresholds: RiskThresholdConfigSchema.default(defaultRiskConfig.thresholds),
  })
  .strict()
  .default(defaultRiskConfig);

export type RiskThresholdConfig = z.infer<typeof RiskThresholdConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

/**
 * 문자열 입력이 금융 Decimal로 해석 가능하고 음수가 아닌지 확인한다.
 */
function isValidDecimal(value: string): boolean {
  try {
    // 음수 threshold는 모든 리스크 한도를 즉시 깨뜨리므로 config 로딩 단계에서 차단한다.
    return !parseFinancialDecimal(value).isNegative();
  } catch {
    return false;
  }
}
