import type { RiskGateContext, RiskGateEvaluation, RiskGateResult } from "../../domain/index.js";
import { readPositiveDecimal } from "./risk-gate/decimal-read.js";
import { evaluateExpectedLossLimit } from "./risk-gate/expected-loss-policy.js";
import { evaluateInfrastructureSignals } from "./risk-gate/infrastructure-signal-policy.js";
import { evaluateLossLimits } from "./risk-gate/loss-limit-policy.js";
import { calculateOrderNotionalBps, evaluateOrderNotionalLimit } from "./risk-gate/order-notional-policy.js";
import { evaluatePositionExposureLimits } from "./risk-gate/position-exposure-policy.js";
import { createRiskGateResult } from "./risk-gate/result-policy.js";
import { evaluateConsecutiveStrategyLosses } from "./risk-gate/strategy-loss-policy.js";
import { parseThresholds } from "./risk-gate/threshold-parser.js";

/**
 * M5 RiskGate의 손실, 노출, 인프라 장애 한도를 순수 함수로 평가한다.
 *
 * 이 evaluator는 DB나 broker를 호출하지 않고 전달받은 snapshot만 사용한다. runtime 연결과 persistence append는
 * 후속 Sub PR에서 같은 결과 payload를 사용해 붙인다.
 */
export function evaluateRiskGate(context: RiskGateContext): RiskGateResult {
  const thresholds = parseThresholds(context.thresholdSnapshot.thresholds);
  const evaluations: RiskGateEvaluation[] = [];

  evaluations.push(...evaluateLossLimits(context, thresholds));

  const equity = readPositiveDecimal(context.account.equityKrw, "account.equity_krw", {
    reasonCode: "account_equity_invalid",
    message: "Account equity must be greater than zero before RiskGate evaluation",
  });
  if (equity.evaluation !== undefined) {
    evaluations.push(equity.evaluation);
  }

  const orderNotionalBps =
    equity.value === undefined
      ? undefined
      : calculateOrderNotionalBps(context.orderIntent, equity.value, context.thresholdSnapshot);

  if (orderNotionalBps?.evaluation !== undefined) {
    evaluations.push(orderNotionalBps.evaluation);
  }
  if (orderNotionalBps?.value !== undefined) {
    evaluations.push(evaluateOrderNotionalLimit(context, thresholds, orderNotionalBps.value));
    evaluations.push(...evaluatePositionExposureLimits(context, thresholds, orderNotionalBps.value));
  }

  evaluations.push(evaluateExpectedLossLimit(context, thresholds));
  evaluations.push(evaluateConsecutiveStrategyLosses(context, thresholds));
  evaluations.push(...evaluateInfrastructureSignals(context.infrastructureSignals));

  return createRiskGateResult(evaluations, context.thresholdSnapshot);
}
