import { getKillSwitchActionPlan } from "../../../domain/index.js";
import type { BrokerOrder, OrderLifecycleStatus, StrategyRiskSnapshot } from "../../../domain/index.js";
import type { HardStopRuntimeActionPlan, StrategyPauseRuntimeActionPlan } from "./types.js";

/**
 * HARD_STOP action plan을 만든다.
 *
 * 실제 cancelOrder side effect는 여기서 호출하지 않고 pending paper order 취소 계획만 남겨 audit/event append가 먼저 완료되게 한다.
 */
export function createHardStopRuntimeActionPlan(
  pendingPaperOrders: readonly BrokerOrder[],
): HardStopRuntimeActionPlan {
  const cancelActions = pendingPaperOrders
    .filter((order) => pendingPaperOrderStatusesRequiringCancel.includes(order.status))
    .map((order) => ({
      action: "PLAN_CANCEL_PENDING_PAPER_ORDER" as const,
      brokerOrderId: order.brokerOrderId,
      idempotencyKey: order.idempotencyKey,
      market: order.market,
      status: order.status,
    }));

  return {
    state: "HARD_STOP",
    actionPlan: getKillSwitchActionPlan("HARD_STOP"),
    pendingPaperOrderCancelActions: cancelActions,
  };
}

/**
 * 전략 단위 pause action plan을 만든다.
 *
 * 전역 신규 주문 차단과 별개로 특정 strategy 평가 중지 근거를 audit trail에 남기기 위한 side-effect-free plan이다.
 */
export function createStrategyPauseRuntimeActionPlan(
  strategy: StrategyRiskSnapshot,
): StrategyPauseRuntimeActionPlan {
  return {
    action: "PLAN_PAUSE_STRATEGY",
    strategyId: strategy.strategyId,
    newOrdersBlocked: false,
    strategyEvaluationBlocked: true,
  };
}

const pendingPaperOrderStatusesRequiringCancel: readonly OrderLifecycleStatus[] = [
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
];
