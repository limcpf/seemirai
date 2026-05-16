import type { MarketDataEvent } from "./market.js";
import type { OrderIntent } from "./orders.js";
import type { JsonRecord, TimestampInput } from "./types.js";

export type StrategyDecisionKind = "HOLD" | "BLOCK" | "ORDER_INTENT";

/**
 * strategy evaluate 호출에 필요한 입력 context다.
 *
 * 전략은 market event와 feature snapshot을 읽고 decision만 반환하며, broker나 거래소 adapter를 직접 알지 않는다.
 */
export interface StrategyContext {
  strategyId: string;
  observedAt: TimestampInput;
  marketEvents: readonly MarketDataEvent[];
  features: Readonly<Record<string, unknown>>;
  positions?: JsonRecord;
  metadata?: JsonRecord;
}

/**
 * 신규 주문 후보를 만들지 않고 대기한다는 전략 판단이다.
 *
 * reason은 나중에 strategy signal과 audit log에서 사람이 확인할 수 있는 설명으로 남긴다.
 */
export interface HoldStrategyDecision {
  kind: "HOLD";
  strategyId: string;
  reason: string;
  metadata?: JsonRecord;
}

/**
 * 전략 단계에서 주문 후보 생성을 차단한다는 판단이다.
 *
 * 위험 상태, feature 부족, universe 제외처럼 비용/리스크 gate 이전에 중단해야 하는 이유를 표현한다.
 */
export interface BlockStrategyDecision {
  kind: "BLOCK";
  strategyId: string;
  reason: string;
  reasonCode: string;
  metadata?: JsonRecord;
}

/**
 * 전략이 생성한 주문 후보 목록이다.
 *
 * 이 decision은 곧바로 주문 제출이 아니며, 모든 OrderIntent는 비용 모델과 리스크 게이트를 통과해야 한다.
 */
export interface OrderIntentStrategyDecision {
  kind: "ORDER_INTENT";
  strategyId: string;
  reason: string;
  orderIntents: readonly OrderIntent[];
  metadata?: JsonRecord;
}

export type StrategyDecision =
  | HoldStrategyDecision
  | BlockStrategyDecision
  | OrderIntentStrategyDecision;

/**
 * 모든 전략 구현체가 따라야 하는 domain contract다.
 *
 * 전략은 id, version, 필요한 feature 목록을 선언하고 evaluate에서 StrategyDecision만 반환한다. 주문 제출 메서드는
 * 의도적으로 포함하지 않는다.
 */
export interface Strategy {
  id: string;
  version: string;
  requiredFeatures: readonly string[];
  evaluate(context: StrategyContext): StrategyDecision | Promise<StrategyDecision>;
}
