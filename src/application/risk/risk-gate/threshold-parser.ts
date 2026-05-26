import { parseFinancialDecimal } from "../../../shared/index.js";
import type { RiskLimitThresholds } from "../../../domain/index.js";
import type { ParsedThresholds } from "./types.js";

/**
 * RiskLimitThresholds 문자열 snapshot을 Decimal 비교 입력으로 파싱한다.
 *
 * threshold는 운영 설정 invariant이므로 음수 값은 evaluation으로 완화하지 않고 즉시 예외를 던져 잘못된 설정을 드러낸다.
 */
export function parseThresholds(thresholds: RiskLimitThresholds): ParsedThresholds {
  return {
    dailyLossLimitBps: parseNonNegativeThreshold(thresholds.dailyLossLimitBps, "daily_loss_limit_bps"),
    weeklyLossLimitBps: parseNonNegativeThreshold(thresholds.weeklyLossLimitBps, "weekly_loss_limit_bps"),
    maxDrawdownBps: parseNonNegativeThreshold(thresholds.maxDrawdownBps, "max_drawdown_bps"),
    maxOrderNotionalBpsOfEquity: parseNonNegativeThreshold(
      thresholds.maxOrderNotionalBpsOfEquity,
      "max_order_notional_bps_of_equity",
    ),
    maxExpectedLossBpsOfEquity: parseNonNegativeThreshold(
      thresholds.maxExpectedLossBpsOfEquity,
      "max_expected_loss_bps_of_equity",
    ),
    btcEthMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.btcEthMaxPositionBpsOfEquity,
      "btc_eth_max_position_bps_of_equity",
    ),
    altMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.altMaxPositionBpsOfEquity,
      "alt_max_position_bps_of_equity",
    ),
    totalAltMaxPositionBpsOfEquity: parseNonNegativeThreshold(
      thresholds.totalAltMaxPositionBpsOfEquity,
      "total_alt_max_position_bps_of_equity",
    ),
    maxConsecutiveStrategyLosses: thresholds.maxConsecutiveStrategyLosses,
  };
}

function parseNonNegativeThreshold(value: string, fieldName: string) {
  const decimal = parseFinancialDecimal(value);

  if (decimal.isNegative()) {
    throw new Error(`${fieldName} must not be negative`);
  }

  return decimal;
}
