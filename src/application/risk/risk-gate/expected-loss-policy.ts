import type { RiskGateContext, RiskGateEvaluation } from "../../../domain/index.js";
import { readNonNegativeDecimal } from "./decimal-read.js";
import { fail, pass, withThresholdSnapshot } from "./evaluation-factory.js";
import type { DecimalRead, ParsedThresholds } from "./types.js";

/**
 * 단일 주문 예상 손실이 계정 평가액 대비 0.2%를 초과하는지 평가한다.
 *
 * 예상 손실 입력이 없으면 비용 차감 후 손실 한도를 검증할 수 없으므로 신규 주문을 fail-closed로 차단한다.
 */
export function evaluateExpectedLossLimit(
  context: RiskGateContext,
  thresholds: ParsedThresholds,
): RiskGateEvaluation {
  const expectedLoss = readExpectedLossBpsOfEquity(context);

  if (expectedLoss.evaluation !== undefined) {
    return withThresholdSnapshot(expectedLoss.evaluation, context.thresholdSnapshot);
  }

  if (expectedLoss.value === undefined) {
    // 예상 손실을 모르는 주문은 손실 한도 검증을 우회할 수 있으므로 승인하지 않는다.
    return withThresholdSnapshot(
      fail("expected_loss_missing", "Expected loss bps is required before RiskGate approval", "BLOCK_NEW_ORDER"),
      context.thresholdSnapshot,
    );
  }

  return withThresholdSnapshot(
    expectedLoss.value.greaterThan(thresholds.maxExpectedLossBpsOfEquity)
      ? fail("expected_loss_limit_exceeded", "Expected loss exceeds the account equity limit", "BLOCK_NEW_ORDER", {
          expected_loss_bps_of_equity: expectedLoss.value.toFixed(),
          threshold_bps: thresholds.maxExpectedLossBpsOfEquity.toFixed(),
        })
      : pass("expected_loss_limit_clear", "Expected loss is within the account equity limit", {
          expected_loss_bps_of_equity: expectedLoss.value.toFixed(),
          threshold_bps: thresholds.maxExpectedLossBpsOfEquity.toFixed(),
        }),
    context.thresholdSnapshot,
  );
}

function readExpectedLossBpsOfEquity(context: RiskGateContext): DecimalRead {
  const metadataValue =
    context.orderIntent.metadata?.expected_loss_bps_of_equity ??
    context.orderIntent.metadata?.expectedLossBpsOfEquity;
  const value = context.expectedLossBpsOfEquity ?? metadataValue;

  if (value === undefined || value === null) {
    return {
      value: undefined,
    };
  }

  return readNonNegativeDecimal(value, "risk_gate.expected_loss_bps_of_equity", {
    reasonCode: "expected_loss_bps_invalid",
    message: "Expected loss bps must be a non-negative decimal string",
  });
}
