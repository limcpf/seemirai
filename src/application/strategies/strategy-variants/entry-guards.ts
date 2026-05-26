import type { Decimal } from "decimal.js";
import type { StrategyContext, StrategyDecision } from "../../../domain/index.js";
import { block } from "./decision-factory.js";
import { isLlmOnlyContext, requireFeatureDecimal } from "./feature-reader.js";

/**
 * 모든 strategy variant에 공통으로 적용되는 진입 전 guard를 평가한다.
 *
 * LLM-only context, spread, depth를 먼저 확인해 후속 전략별 signal 해석이 안전한 시장 입력에서만 실행되도록 한다.
 */
export function evaluateEntryGuards(
  context: StrategyContext,
  strategyId: string,
  options: {
    maxSpreadBps: Decimal;
    minDepthKrw: Decimal;
  },
): StrategyDecision | undefined {
  // 1. LLM-only context는 가격/수량 feature가 있더라도 신규 주문 후보 생성을 차단한다.
  if (isLlmOnlyContext(context)) {
    return block(strategyId, "llm_only_not_allowed", "LLM-only context cannot create order intents");
  }

  const spread = requireFeatureDecimal(context, "spread_bps", strategyId);

  if (spread.kind !== "value") {
    return spread.decision;
  }

  if (spread.value.isNegative()) {
    return block(strategyId, "spread_negative", "Spread must not be negative", {
      spread_bps: spread.value.toFixed(),
    });
  }

  if (spread.value.greaterThan(options.maxSpreadBps)) {
    return block(strategyId, "spread_too_wide", "Spread exceeds the strategy threshold", {
      spread_bps: spread.value.toFixed(),
      max_spread_bps: options.maxSpreadBps.toFixed(),
    });
  }

  const depth = requireFeatureDecimal(context, "depth_krw", strategyId);

  if (depth.kind !== "value") {
    return depth.decision;
  }

  if (depth.value.lessThan(options.minDepthKrw)) {
    return block(strategyId, "depth_insufficient", "Depth is below the strategy threshold", {
      depth_krw: depth.value.toFixed(),
      min_depth_krw: options.minDepthKrw.toFixed(),
    });
  }

  return undefined;
}
