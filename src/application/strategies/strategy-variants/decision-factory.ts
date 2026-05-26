import type { JsonRecord, StrategyDecision } from "../../../domain/index.js";

/**
 * strategy HOLD decision에 discard audit 공통 metadata를 부착한다.
 *
 * 기존 reason string은 유지하면서 strategy id와 reason family를 안정 key로 추가한다. 외부 side effect는 없고, 호출자가 넘긴
 * metadata를 덮어쓰지 않는 범위에서 공통 필드가 항상 존재해야 한다.
 */
export function hold(strategyId: string, reasonCode: string, metadata?: JsonRecord): StrategyDecision {
  return {
    kind: "HOLD",
    strategyId,
    reason: reasonCode,
    metadata: {
      ...(metadata ?? {}),
      strategy_id: strategyId,
      reason_code: reasonCode,
      reason_family: "strategy_hold",
    },
  };
}

/**
 * strategy BLOCK decision에 fail-closed 원인과 audit 공통 metadata를 부착한다.
 *
 * BLOCK은 후보 생성이 안전하지 않은 입력/상태를 의미하므로 reasonCode와 reasonFamily를 metadata에 남긴다. 호출자가
 * feature_missing/feature_invalid family를 지정한 경우 그 분류를 유지한다.
 */
export function block(
  strategyId: string,
  reasonCode: string,
  reason: string,
  metadata?: JsonRecord,
): StrategyDecision {
  return {
    kind: "BLOCK",
    strategyId,
    reason,
    reasonCode,
    metadata: {
      ...(metadata ?? {}),
      strategy_id: strategyId,
      reason_code: reasonCode,
      reason_family: metadata?.reason_family ?? "strategy_block",
    },
  };
}
