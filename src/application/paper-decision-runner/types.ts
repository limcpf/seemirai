import type {
  AccountRiskSnapshot,
  CostDecision,
  CostModel,
  CostModelInput,
  InfrastructureRiskSnapshot,
  JsonRecord,
  MarketCode,
  MarketDataEvent,
  OrderIntent,
  OrderbookEvent,
  PositionRiskSnapshot,
  RiskGateContext,
  RiskGateResult,
  RiskThresholdSnapshot,
  Strategy,
  StrategyRiskSnapshot,
  TimestampInput,
} from "../../domain/index.js";
import type { ExecutionEngine, ExecutionSubmitOrderResult } from "../execution/index.js";
import type { PaperPnlSummary } from "../paper-pnl-summary.js";
import type { BrokerPort } from "../ports/index.js";

/**
 * paper decision runner가 주문 제출 전후에 사용하는 broker port다.
 *
 * 기본 계약은 `BrokerPort`와 같지만, fixture/runtime 입력 source가 프레임별 호가를 제공할 수 있으므로
 * `recordOrderbookSnapshot`을 선택적으로 허용한다. 이 선택 메서드는 paper broker의 market data side effect
 * 경계이며, 실거래 주문 API나 private API 호출을 열지 않는다.
 */
export interface PaperDecisionBrokerPort extends BrokerPort {
  recordOrderbookSnapshot?(snapshot: OrderbookEvent): void;
}

/**
 * runner가 한 번의 feature -> strategy -> gate -> broker 흐름을 평가할 입력 프레임이다.
 *
 * 입력 source는 fixture, DB cursor, runtime market-data buffer 중 하나일 수 있다. 프레임은 이미 계산된 feature와
 * 비용/리스크 보조 snapshot을 제공하고, runner는 이 값을 같은 순서로 소비해야 한다. `orderbook`은 paper fill의
 * 근거일 뿐이며, 이 타입 자체는 외부 API 호출 side effect를 갖지 않는다.
 */
export interface PaperDecisionInputFrame {
  id: string;
  observedAt: TimestampInput;
  exchangeId: string;
  market: MarketCode;
  features: Readonly<Record<string, unknown>>;
  marketEvents?: readonly MarketDataEvent[];
  orderbook?: OrderbookEvent;
  costInput?: Partial<CostModelInput>;
  risk?: PaperDecisionRiskInput;
  metadata?: JsonRecord;
}

/**
 * runner가 RiskGate context를 만들 때 사용하는 frame-local 리스크 입력이다.
 *
 * 누락된 값은 paper smoke용 보수적 기본값으로 채워진다. 단, `expectedLossBpsOfEquity`는 주문 손실 한도 검증의
 * 핵심 입력이므로 기본값을 쓰더라도 summary trace에 남겨야 하며, 실제 DB source는 저장된 snapshot을 넘겨야 한다.
 */
export interface PaperDecisionRiskInput {
  account?: Partial<AccountRiskSnapshot>;
  positions?: readonly PositionRiskSnapshot[];
  strategy?: Partial<StrategyRiskSnapshot>;
  infrastructureSignals?: readonly InfrastructureRiskSnapshot[];
  thresholdSnapshot?: RiskThresholdSnapshot;
  expectedLossBpsOfEquity?: string;
  metadata?: JsonRecord;
}

/**
 * fixture 또는 DB 기반 입력 source가 replay 요청을 좁힐 때 쓰는 선택 필터다.
 *
 * 현재 runner는 market과 frame 수 제한만 요구하지만, source 구현이 DB cursor나 기간 필터를 추가해도 public
 * runner contract를 바꾸지 않도록 확장 가능한 request 객체로 둔다.
 */
export interface PaperDecisionInputReplayRequest {
  markets?: readonly MarketCode[];
  limit?: number;
  sourceId?: string;
}

/**
 * paper decision runner가 소비하는 입력 source port다.
 *
 * source는 deterministic fixture, DB query, runtime buffer 어느 쪽이든 같은 `AsyncIterable` 계약으로 frame을
 * 제공한다. runner는 source를 읽기만 하며 DB write나 네트워크 side effect를 직접 수행하지 않는다.
 */
export interface PaperDecisionInputSource {
  replay(request?: PaperDecisionInputReplayRequest): AsyncIterable<PaperDecisionInputFrame>;
}

/**
 * runner 조립에 필요한 application port 묶음이다.
 *
 * `strategies`는 주문 후보만 생성하고, `broker`는 execution side effect를 담당한다. 비용 모델과 RiskGate evaluator,
 * execution engine은 테스트와 runtime이 같은 순서를 재사용할 수 있게 주입 가능하지만 기본 구현도 제공된다.
 */
export interface PaperDecisionRunnerPorts {
  source: PaperDecisionInputSource;
  strategies: readonly Strategy[];
  broker: PaperDecisionBrokerPort;
  costModel?: Pick<CostModel, "evaluate">;
  evaluateRiskGate?: (context: RiskGateContext) => RiskGateResult;
  executionEngine?: Pick<ExecutionEngine, "submitOrder">;
}

/**
 * runner 실행을 제어하는 옵션이다.
 *
 * 기본값은 fixture smoke에 맞춰 모든 프레임을 처리한다. `maxFrames`는 운영자가 DB 입력을 짧게 샘플링할 때만
 * 사용하며, runner summary의 입력 한계를 명시적으로 남긴다.
 */
export interface PaperDecisionRunnerOptions {
  sourceRequest?: PaperDecisionInputReplayRequest;
  maxFrames?: number;
  pnlStartingCashKrw?: string;
}

/**
 * 비용 metric을 M9 3일 비교 report가 안정적으로 읽을 수 있게 고정한 summary shape다.
 *
 * 평균값은 평가 대상이 없으면 `null`이며, 숫자 정밀도를 잃지 않도록 bps 값은 문자열로 저장한다. 이 객체는
 * `scripts/compare-m9-paper-reports.mjs`가 `metrics.costSummary`로 읽는 비교 입력이다.
 */
export interface PaperDecisionCostSummary extends JsonRecord {
  evaluatedCount: number;
  allowedCount: number;
  rejectedCount: number;
  averageCostBps: string | null;
  averageRequiredReturnBps: string | null;
  averageMarginBps: string | null;
}

/**
 * paper fill 결과의 슬리피지를 비교 가능한 형태로 요약한다.
 *
 * fill이 없을 때도 객체 자체는 항상 존재해 3일 report 비교에서 metric 누락으로 해석되지 않게 한다.
 */
export interface PaperDecisionSlippageSummary extends JsonRecord {
  observedFillCount: number;
  averageSlippageBps: string | null;
  minSlippageBps: string | null;
  maxSlippageBps: string | null;
}

/**
 * M9 paper decision runner가 산출하는 핵심 운영 metric이다.
 *
 * 이 summary는 public WebSocket 수신 수가 아니라 전략 평가, 주문 후보, 비용/리스크 차단, PaperBroker 제출과
 * 체결을 세는 알고리즘 검증 경계다. `liveOrderApiCalls`는 runner가 실거래 broker를 만들지 않는 invariant를
 * 외부 report가 기계적으로 확인할 수 있게 항상 포함한다.
 */
export interface PaperDecisionMetricSummary extends JsonRecord {
  strategyEvaluationCount: number;
  orderCandidateCount: number;
  orderIntentCount: number;
  holdReasonCounts: Record<string, number>;
  discardReasonCounts: Record<string, number>;
  costRejectedCount: number;
  riskRejectedCount: number;
  paperOrderSubmittedCount: number;
  paperFillCount: number;
  fillRate: number;
  costSummary: PaperDecisionCostSummary;
  slippageSummary: PaperDecisionSlippageSummary;
  pnlSummary: PaperPnlSummary;
  blockingReasonCounts: Record<string, number>;
  liveOrderApiCalls: 0;
}

/**
 * runner가 처리한 주요 단계별 trace record다.
 *
 * trace는 CLI raw log와 테스트 evidence용이며, 감사 로그 persistence를 대체하지 않는다. DB-backed runner가 붙으면
 * 같은 reason code와 frame id를 audit event로 저장할 수 있어야 한다.
 */
export interface PaperDecisionRunnerTraceRecord {
  frameId: string;
  strategyId?: string;
  stage:
    | "FRAME_RECEIVED"
    | "STRATEGY_DECISION"
    | "ORDER_INTENT_CONVERSION"
    | "COST_DECISION"
    | "RISK_DECISION"
    | "EXECUTION_RESULT";
  status: string;
  reasonCode?: string;
  message?: string;
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * paper decision runner의 단일 실행 결과다.
 *
 * `metrics`는 report 비교용 안정 shape이고, `trace`는 주문이 0건이어도 어떤 hold/discard/cost/risk 이유로
 * 중단됐는지 사람이 재구성할 수 있게 남긴다.
 */
export interface PaperDecisionRunnerResult {
  framesProcessed: number;
  metrics: PaperDecisionMetricSummary;
  trace: readonly PaperDecisionRunnerTraceRecord[];
}

/**
 * 후보 하나가 비용/리스크/실행 단계에서 처리되는 동안 공유하는 내부 evaluation 묶음이다.
 *
 * public export는 테스트와 향후 DB adapter가 같은 입력 의미를 확인하기 위한 것이며, runner 외부에서 값을
 * 변형해 재사용하면 stale approval 위험이 생기므로 읽기 전용 evidence로 취급해야 한다.
 */
export interface PaperDecisionCandidateEvaluation {
  frame: PaperDecisionInputFrame;
  intent: OrderIntent;
  costDecision: CostDecision;
  riskGateContext?: RiskGateContext;
  riskGateResult?: RiskGateResult;
  executionResult?: ExecutionSubmitOrderResult;
}
