import type {
  CostDecision,
  CostModel,
  CostModelInput,
  MarketDataEvent,
  MarketEvent,
  MarketStatus,
  OrderIntent,
  OrderSubmission,
  OrderbookEvent,
  RiskGateContext,
  RiskGateResult,
  Rule,
  RuleContext,
  Strategy,
  StrategyContext,
  StrategyDecision,
} from "../../../domain/index.js";
import type { ExecutionSubmissionValidationResult, PaperFillSimulationResult, PaperFillSimulatorOptions } from "../../execution/index.js";
import type { HistoricalEventReplayRequest, HistoricalEventSource } from "../../ports/index.js";
import type { RuleEngineResult } from "../../rules/index.js";
import type {
  ConvertStrategyDecisionToOrderIntentsOptions,
  StrategyDecisionIntentConversion,
} from "../../strategies/index.js";

/**
 * backtest 후보가 runtime 실행 순서 중 어디에서 종료됐는지 나타내는 status다.
 *
 * CostModel, rule, RiskGate, ExecutionEngine validation, paper fill simulator의 단계별 결과를 구분해 리포트와 테스트가
 * 같은 상태 전이 기준을 공유한다.
 */
export type BacktestOrderCandidateStatus =
  | "COST_REJECTED"
  | "RULE_REJECTED"
  | "RISK_REJECTED"
  | "EXECUTION_REJECTED"
  | "SIMULATED";

/**
 * backtest callback에 전달하는 현재 replay state snapshot이다.
 *
 * source 전체 이벤트 목록이 아니라 전략/비용/리스크 판단에 필요한 최근 market data, 최신 orderbook/status, 제한된 orderbook
 * window만 복사해 전달한다.
 */
export interface BacktestReplayStateSnapshot {
  latestMarketDataEvents: readonly MarketDataEvent[];
  latestOrderbook?: OrderbookEvent;
  latestMarketStatus?: MarketStatus;
  orderbookHistory: readonly OrderbookEvent[];
}

/**
 * strategy context callback에 전달하는 입력이다.
 *
 * event와 strategy 자체는 현재 replay 항목이고, state는 mutable replay state가 아닌 복사된 snapshot이다.
 */
export interface BacktestStrategyContextInput {
  event: MarketEvent;
  strategy: Strategy;
  state: BacktestReplayStateSnapshot;
}

/**
 * CostModel input callback에 전달하는 후보 평가 입력이다.
 *
 * strategy decision과 변환 결과, 단일 intent, replay snapshot을 함께 전달해 비용 판단이 특정 후보에 고정되도록 한다.
 */
export interface BacktestCostInput {
  event: MarketEvent;
  strategy: Strategy;
  strategyContext: StrategyContext;
  decision: StrategyDecision;
  conversion: StrategyDecisionIntentConversion;
  intent: OrderIntent;
  state: BacktestReplayStateSnapshot;
}

/**
 * RiskGate context callback에 전달하는 입력이다.
 *
 * 비용을 통과한 후보만 이 경계에 도달하며, costDecision은 RiskGate/Rule 입력과 같은 후보의 비용 증거여야 한다.
 */
export interface BacktestRiskGateContextInput extends BacktestCostInput {
  costDecision: CostDecision;
}

/**
 * RuleEngine context callback에 전달하는 입력이다.
 *
 * runtime rule chain과 같은 순서를 보존하기 위해 RiskGateContext를 포함하지만 아직 RiskGateResult는 평가하지 않은 상태다.
 */
export interface BacktestRuleContextInput extends BacktestRiskGateContextInput {
  riskGateContext: RiskGateContext;
}

/**
 * paper fill option callback에 전달하는 입력이다.
 *
 * rule/RiskGate/Execution validation을 모두 통과한 후보에 대해서만 만들어지며, simulator option 선택 외 side effect는 없다.
 */
export interface BacktestFillOptionsInput extends BacktestRuleContextInput {
  ruleResult: RuleEngineResult;
  riskGateResult: RiskGateResult;
  submission: OrderSubmission;
}

/**
 * BacktestOrchestrator가 외부 replay source와 runtime core를 조립하는 port 묶음이다.
 *
 * source는 backtest 전용이지만 strategy/rule/cost/risk evaluator는 runtime core와 같은 인터페이스를 사용한다.
 */
export interface BacktestOrchestratorPorts {
  source: HistoricalEventSource;
  strategies: readonly Strategy[];
  rules?: readonly Rule[];
  costModel?: Pick<CostModel, "evaluate">;
  evaluateRiskGate?: (context: RiskGateContext) => RiskGateResult;
}

/**
 * 단일 backtest replay 실행 요청이다.
 *
 * HistoricalEventSource 필터와 runtime core callback을 함께 담으며, callback들은 orchestrator가 복사한 입력만 받아야 한다.
 */
export interface BacktestRunRequest extends HistoricalEventReplayRequest {
  createStrategyContext(input: BacktestStrategyContextInput): StrategyContext | undefined;
  createCostInput(input: BacktestCostInput): CostModelInput;
  createRiskGateContext(input: BacktestRiskGateContextInput): RiskGateContext;
  createRuleContext?(input: BacktestRuleContextInput): RuleContext;
  fillOptions?: PaperFillSimulatorOptions | ((input: BacktestFillOptionsInput) => PaperFillSimulatorOptions);
  convertDecisionOptions?: ConvertStrategyDecisionToOrderIntentsOptions;
  historyLimits?: BacktestReplayHistoryLimits;
}

/**
 * backtest replay 중 callback state에 보관할 최근 이벤트 수 상한이다.
 *
 * 결과 집계용 `events`는 그대로 반환하되, 전략/비용/리스크 callback이 참조하는 replay state는 긴 입력에서도
 * 무한히 커지지 않도록 market data와 market별 orderbook window를 따로 제한한다.
 */
export interface BacktestReplayHistoryLimits {
  marketDataEvents?: number;
  orderbooksPerMarket?: number;
}

/**
 * strategy 평가 결과를 backtest 결과에 남기는 record다.
 *
 * 후보가 없더라도 strategy decision과 conversion 결과를 보존해 폐기/무주문 사유를 리포트에서 추적할 수 있게 한다.
 */
export interface BacktestStrategyEvaluation {
  event: MarketEvent;
  strategyId: string;
  context: StrategyContext;
  decision: StrategyDecision;
  conversion: StrategyDecisionIntentConversion;
}

/**
 * 단일 order intent 후보가 실행 순서에서 남긴 결과다.
 *
 * status에 따라 cost/rule/risk/submission/fill evidence가 단계적으로 채워지며, 실제 broker나 DB side effect는 포함하지 않는다.
 */
export interface BacktestOrderCandidateResult {
  status: BacktestOrderCandidateStatus;
  event: MarketEvent;
  strategyId: string;
  intent: OrderIntent;
  costDecision: CostDecision;
  ruleResult?: RuleEngineResult;
  riskGateResult?: RiskGateResult;
  submission?: OrderSubmission;
  executionValidation?: ExecutionSubmissionValidationResult;
  fillResult?: PaperFillSimulationResult;
}

/**
 * backtest replay 전체 결과다.
 *
 * 원본 replay event, strategy 평가, 후보 평가를 분리해 리포트 생성기가 필요한 축만 소비할 수 있게 한다.
 */
export interface BacktestRunResult {
  events: readonly MarketEvent[];
  strategyEvaluations: readonly BacktestStrategyEvaluation[];
  candidates: readonly BacktestOrderCandidateResult[];
}

/**
 * replay 중 mutable하게 유지하는 내부 state다.
 *
 * 외부 callback에는 이 객체 자체를 노출하지 않고 snapshotReplayState가 복사한 값만 전달해야 한다.
 */
export interface BacktestReplayState {
  latestMarketDataEvents: MarketDataEvent[];
  latestOrderbooksByMarketKey: Map<string, OrderbookEvent>;
  latestMarketStatusesByMarketKey: Map<string, MarketStatus>;
  orderbookHistoryByMarketKey: Map<string, OrderbookEvent[]>;
}

/**
 * 내부 후보 평가 결과와 지연 체결 대기 상태를 함께 반환하는 타입이다.
 *
 * pendingFill이 있으면 후보 result는 이미 candidates에 포함되며, 이후 orderbook replay에서 fillResult가 append된다.
 */
export interface BacktestOrderCandidateEvaluation {
  result: BacktestOrderCandidateResult;
  pendingFill?: PendingBacktestFill;
}

/**
 * paper fill simulator가 아직 확정하지 않은 backtest 후보다.
 *
 * latency 기준 orderbook이 도착할 때까지 intent, 후보 result 참조, orderbook window, fill option을 보존한다.
 */
export interface PendingBacktestFill {
  result: BacktestOrderCandidateResult;
  intent: OrderIntent;
  orderbooks: readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
}

/**
 * history limit 기본값과 검증을 적용한 내부 설정이다.
 *
 * replay loop는 이 값을 기준으로 callback state window만 잘라 결과 event 목록은 손상하지 않는다.
 */
export interface NormalizedBacktestReplayHistoryLimits {
  marketDataEvents: number;
  orderbooksPerMarket: number;
}
