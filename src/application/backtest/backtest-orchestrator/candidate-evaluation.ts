import type { CostDecision, OrderSubmission, RiskGateContext, RiskGateResult, RuleContext } from "../../../domain/index.js";
import {
  createExecutionCostSnapshotEvidence,
  createExecutionRiskApprovalEvidence,
} from "../../execution/index.js";
import type {
  BacktestCostInput,
  BacktestFillOptionsInput,
  BacktestRiskGateContextInput,
  BacktestRunRequest,
} from "./types.js";

/**
 * Backtest 기본 rule context를 생성한다.
 *
 * 사용자가 createRuleContext를 주입하지 않은 경우 runtime rule chain과 같은 입력 구조를 만들어 rule 평가 순서를 보존한다.
 */
export function createDefaultRuleContext(
  input: BacktestCostInput,
  costDecision: CostDecision,
  riskGateContext: RiskGateContext,
): RuleContext {
  const context: RuleContext = {
    exchangeId: input.intent.exchangeId,
    market: input.intent.market,
    observedAt: input.strategyContext.observedAt,
    latestEvents: input.strategyContext.marketEvents,
    features: input.strategyContext.features,
    costDecision,
    orderIntent: input.intent,
    riskGateContext,
    ...(riskGateContext.expectedLossBpsOfEquity === undefined
      ? {}
      : { expectedLossBpsOfEquity: riskGateContext.expectedLossBpsOfEquity }),
    metadata: {
      source: "backtest_orchestrator",
      event_kind: input.event.kind,
    },
  };

  if (input.state.latestMarketStatus !== undefined) {
    context.marketStatus = input.state.latestMarketStatus;
  }

  return context;
}

/**
 * CostModel/RiskGate 승인 evidence를 ExecutionEngine submission 구조로 묶는다.
 *
 * broker 호출은 하지 않고 validation과 fill simulator가 읽을 submission payload만 생성한다.
 */
export function createBacktestOrderSubmission(
  input: BacktestCostInput,
  costDecision: CostDecision,
  riskGateContext: RiskGateContext,
  riskGateResult: RiskGateResult,
): OrderSubmission {
  const submission: OrderSubmission = {
    intent: input.intent,
    costSnapshot: createExecutionCostSnapshotEvidence(
      costDecision.snapshot,
      input.intent,
      riskGateContext.expectedLossBpsOfEquity,
    ),
    riskApproval: createExecutionRiskApprovalEvidence(riskGateResult, riskGateContext),
    submittedAt: input.event.receivedAt ?? input.event.eventTimestamp,
  };

  if (riskGateContext.expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = riskGateContext.expectedLossBpsOfEquity;
  }

  return submission;
}

/**
 * 정적 fill option 또는 callback fill option을 현재 후보 입력으로 해석한다.
 *
 * callback은 backtest 후보별 latency/slippage 설정을 만들기 위한 순수 확장점이며, 이 함수는 실행 side effect를 만들지 않는다.
 */
export function resolveFillOptions(
  fillOptions: BacktestRunRequest["fillOptions"],
  input: BacktestFillOptionsInput,
) {
  return typeof fillOptions === "function" ? fillOptions(input) : fillOptions;
}
