import type { RiskGateContext, RiskGateEvaluation } from "../../../domain/index.js";
import { appendReadEvaluation, readDecimal, readNonNegativeDecimal } from "./decimal-read.js";
import { fail, pass, withThresholdSnapshots } from "./evaluation-factory.js";
import type { ParsedThresholds } from "./types.js";

/**
 * 계정 손실 한도와 MDD 한도를 평가한다.
 *
 * 계정 snapshot 입력이 깨졌으면 해당 read evaluation을 같이 반환하고, 유효한 값은 설정 threshold와 비교해 신규 주문 차단 여부를 판단한다.
 */
export function evaluateLossLimits(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation[] {
  const evaluations: RiskGateEvaluation[] = [];
  const dailyLossBps = readDecimal(context.account.dailyRealizedPnlBps, "account.daily_realized_pnl_bps", {
    reasonCode: "daily_loss_bps_invalid",
    message: "Daily realized PnL bps must be a finite decimal string",
  });
  const weeklyLossBps = readDecimal(context.account.weeklyRealizedPnlBps, "account.weekly_realized_pnl_bps", {
    reasonCode: "weekly_loss_bps_invalid",
    message: "Weekly realized PnL bps must be a finite decimal string",
  });
  const maxDrawdownBps = readNonNegativeDecimal(context.account.maxDrawdownBps, "account.max_drawdown_bps", {
    reasonCode: "max_drawdown_bps_invalid",
    message: "Max drawdown bps must be a non-negative decimal string",
  });

  appendReadEvaluation(evaluations, dailyLossBps);
  appendReadEvaluation(evaluations, weeklyLossBps);
  appendReadEvaluation(evaluations, maxDrawdownBps);

  if (dailyLossBps.value !== undefined) {
    evaluations.push(
      dailyLossBps.value.lessThanOrEqualTo(thresholds.dailyLossLimitBps.negated())
        ? fail("daily_loss_limit_exceeded", "Daily loss limit is reached", "BLOCK_NEW_ORDER", {
            daily_realized_pnl_bps: dailyLossBps.value.toFixed(),
            threshold_bps: thresholds.dailyLossLimitBps.toFixed(),
          })
        : pass("daily_loss_limit_clear", "Daily loss limit is clear", {
            daily_realized_pnl_bps: dailyLossBps.value.toFixed(),
            threshold_bps: thresholds.dailyLossLimitBps.toFixed(),
          }),
    );
  }

  if (weeklyLossBps.value !== undefined) {
    evaluations.push(
      weeklyLossBps.value.lessThanOrEqualTo(thresholds.weeklyLossLimitBps.negated())
        ? fail("weekly_loss_limit_exceeded", "Weekly loss limit is reached", "BLOCK_NEW_ORDER", {
            weekly_realized_pnl_bps: weeklyLossBps.value.toFixed(),
            threshold_bps: thresholds.weeklyLossLimitBps.toFixed(),
          })
        : pass("weekly_loss_limit_clear", "Weekly loss limit is clear", {
            weekly_realized_pnl_bps: weeklyLossBps.value.toFixed(),
            threshold_bps: thresholds.weeklyLossLimitBps.toFixed(),
          }),
    );
  }

  if (maxDrawdownBps.value !== undefined) {
    evaluations.push(
      maxDrawdownBps.value.greaterThanOrEqualTo(thresholds.maxDrawdownBps)
        ? fail("max_drawdown_limit_exceeded", "Max drawdown limit is reached", "BLOCK_NEW_ORDER", {
            max_drawdown_bps: maxDrawdownBps.value.toFixed(),
            threshold_bps: thresholds.maxDrawdownBps.toFixed(),
          })
        : pass("max_drawdown_limit_clear", "Max drawdown limit is clear", {
            max_drawdown_bps: maxDrawdownBps.value.toFixed(),
            threshold_bps: thresholds.maxDrawdownBps.toFixed(),
          }),
    );
  }

  return withThresholdSnapshots(evaluations, context.thresholdSnapshot);
}
