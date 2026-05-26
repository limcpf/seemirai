import type { RiskGateContext, RiskGateEvaluation } from "../../../domain/index.js";
import { fail, pass, withThresholdSnapshot } from "./evaluation-factory.js";
import type { ParsedThresholds } from "./types.js";

/**
 * 동일 strategy의 연속 손실 중지 기준을 평가한다.
 *
 * 주문 intent와 strategy snapshot이 다르면 다른 전략의 손실 상태로 현재 주문을 승인하지 않도록 manual review로 차단한다.
 */
export function evaluateConsecutiveStrategyLosses(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation {
  // 다른 전략의 손실 snapshot으로 현재 주문을 승인하거나 중지하지 않도록 먼저 동일성을 고정한다.
  if (context.strategy.strategyId !== context.orderIntent.strategyId) {
    return withThresholdSnapshot(
      fail(
        "strategy_snapshot_mismatch",
        "Strategy risk snapshot must match the order intent strategy",
        "MANUAL_REVIEW_REQUIRED",
        {
          order_strategy_id: context.orderIntent.strategyId,
          snapshot_strategy_id: context.strategy.strategyId,
        },
      ),
      context.thresholdSnapshot,
    );
  }

  if (!Number.isSafeInteger(context.strategy.consecutiveLosses) || context.strategy.consecutiveLosses < 0) {
    return withThresholdSnapshot(
      fail("consecutive_strategy_losses_invalid", "Consecutive strategy losses must be a non-negative safe integer", "MANUAL_REVIEW_REQUIRED"),
      context.thresholdSnapshot,
    );
  }

  return withThresholdSnapshot(
    context.strategy.consecutiveLosses >= thresholds.maxConsecutiveStrategyLosses
      ? fail("consecutive_strategy_loss_limit_exceeded", "Consecutive strategy loss limit is reached", "PAUSE_STRATEGY", {
          strategy_id: context.strategy.strategyId,
          consecutive_losses: context.strategy.consecutiveLosses,
          threshold_count: thresholds.maxConsecutiveStrategyLosses,
        })
      : pass("consecutive_strategy_loss_limit_clear", "Consecutive strategy loss limit is clear", {
          strategy_id: context.strategy.strategyId,
          consecutive_losses: context.strategy.consecutiveLosses,
          threshold_count: thresholds.maxConsecutiveStrategyLosses,
        }),
    context.thresholdSnapshot,
  );
}
