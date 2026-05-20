import { CostModel, parseMarketEventTimestampNanos } from "../../domain/index.js";
import type {
  CostDecision,
  CostModelInput,
  MarketDataEvent,
  MarketEvent,
  MarketOrderbookSnapshotEvent,
  MarketPolicyCandidateEvent,
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
  TimestampInput,
} from "../../domain/index.js";
import type { HistoricalEventReplayRequest, HistoricalEventSource } from "../ports/index.js";
import {
  createExecutionCostSnapshotEvidence,
  createExecutionRiskApprovalEvidence,
  simulatePaperFill,
  validateExecutionSubmission,
} from "../execution/index.js";
import type {
  ExecutionSubmissionValidationResult,
  PaperFillSimulationResult,
  PaperFillSimulatorOptions,
} from "../execution/index.js";
import { evaluateRiskGate } from "../risk/index.js";
import { evaluateRules } from "../rules/index.js";
import type { RuleEngineResult } from "../rules/index.js";
import { convertStrategyDecisionToOrderIntents } from "../strategies/index.js";
import type {
  ConvertStrategyDecisionToOrderIntentsOptions,
  StrategyDecisionIntentConversion,
} from "../strategies/index.js";

export type BacktestOrderCandidateStatus =
  | "COST_REJECTED"
  | "RULE_REJECTED"
  | "RISK_REJECTED"
  | "EXECUTION_REJECTED"
  | "SIMULATED";

export interface BacktestReplayStateSnapshot {
  latestMarketDataEvents: readonly MarketDataEvent[];
  latestOrderbook?: OrderbookEvent;
  latestMarketStatus?: MarketStatus;
  orderbookHistory: readonly OrderbookEvent[];
}

export interface BacktestStrategyContextInput {
  event: MarketEvent;
  strategy: Strategy;
  state: BacktestReplayStateSnapshot;
}

export interface BacktestCostInput {
  event: MarketEvent;
  strategy: Strategy;
  strategyContext: StrategyContext;
  decision: StrategyDecision;
  conversion: StrategyDecisionIntentConversion;
  intent: OrderIntent;
  state: BacktestReplayStateSnapshot;
}

export interface BacktestRiskGateContextInput extends BacktestCostInput {
  costDecision: CostDecision;
}

export interface BacktestRuleContextInput extends BacktestRiskGateContextInput {
  riskGateContext: RiskGateContext;
}

export interface BacktestFillOptionsInput extends BacktestRuleContextInput {
  ruleResult: RuleEngineResult;
  riskGateResult: RiskGateResult;
  submission: OrderSubmission;
}

export interface BacktestOrchestratorPorts {
  source: HistoricalEventSource;
  strategies: readonly Strategy[];
  rules?: readonly Rule[];
  costModel?: Pick<CostModel, "evaluate">;
  evaluateRiskGate?: (context: RiskGateContext) => RiskGateResult;
}

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

export interface BacktestStrategyEvaluation {
  event: MarketEvent;
  strategyId: string;
  context: StrategyContext;
  decision: StrategyDecision;
  conversion: StrategyDecisionIntentConversion;
}

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

export interface BacktestRunResult {
  events: readonly MarketEvent[];
  strategyEvaluations: readonly BacktestStrategyEvaluation[];
  candidates: readonly BacktestOrderCandidateResult[];
}

interface BacktestReplayState {
  latestMarketDataEvents: MarketDataEvent[];
  latestOrderbooksByMarketKey: Map<string, OrderbookEvent>;
  latestMarketStatusesByMarketKey: Map<string, MarketStatus>;
  orderbookHistoryByMarketKey: Map<string, OrderbookEvent[]>;
}

interface BacktestOrderCandidateEvaluation {
  result: BacktestOrderCandidateResult;
  pendingFill?: PendingBacktestFill;
}

interface PendingBacktestFill {
  result: BacktestOrderCandidateResult;
  intent: OrderIntent;
  orderbooks: readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
}

const emptyOrderbookHistory: readonly OrderbookEvent[] = [];
const defaultReplayHistoryLimit = 10_000;

interface NormalizedBacktestReplayHistoryLimits {
  marketDataEvents: number;
  orderbooksPerMarket: number;
}

/**
 * 이벤트 기반 backtest 흐름을 runtime core와 같은 순서로 실행하는 application orchestrator다.
 *
 * 이 계층은 source replay와 clock/lifecycle만 backtest 전용으로 받고, 전략 판단, 비용 판단, rule 평가,
 * RiskGate 평가, paper fill simulator는 기존 application/domain core를 그대로 호출한다. DB persistence나
 * live broker side effect는 만들지 않는다.
 */
export class BacktestOrchestrator {
  private readonly source: HistoricalEventSource;
  private readonly strategies: readonly Strategy[];
  private readonly rules: readonly Rule[];
  private readonly costModel: Pick<CostModel, "evaluate">;
  private readonly evaluateRiskGate: (context: RiskGateContext) => RiskGateResult;

  public constructor(ports: BacktestOrchestratorPorts) {
    this.source = ports.source;
    this.strategies = ports.strategies;
    this.rules = ports.rules ?? [];
    this.costModel = ports.costModel ?? new CostModel();
    this.evaluateRiskGate = ports.evaluateRiskGate ?? evaluateRiskGate;
  }

  public async run(request: BacktestRunRequest): Promise<BacktestRunResult> {
    const events: MarketEvent[] = [];
    const state = createReplayState();
    const historyLimits = normalizeReplayHistoryLimits(request.historyLimits);
    const strategyEvaluations: BacktestStrategyEvaluation[] = [];
    const candidates: BacktestOrderCandidateResult[] = [];
    const pendingFills: PendingBacktestFill[] = [];

    for await (const sourceEvent of this.source.replay(createReplayRequest(request))) {
      const event = cloneReplayStateValue(sourceEvent);
      events.push(cloneReplayStateValue(event));
      updateReplayState(state, event, historyLimits);
      if (event.kind === "ORDERBOOK_SNAPSHOT") {
        // 새 호가는 decision state가 아니라 이미 승인된 체결 대기 후보에만 후행 근거로 연결한다.
        resolvePendingFills(pendingFills, false);
      }

      for (const strategy of this.strategies) {
        const strategyState = snapshotReplayState(state, event);
        const strategyContext = request.createStrategyContext({
          event: cloneReplayStateValue(event),
          strategy,
          state: strategyState,
        });

        if (strategyContext === undefined) {
          continue;
        }

        const decision = await strategy.evaluate(strategyContext);
        const conversion = convertStrategyDecisionToOrderIntents(decision, request.convertDecisionOptions);
        strategyEvaluations.push({
          event,
          strategyId: strategy.id,
          context: strategyContext,
          decision,
          conversion,
        });

        for (const intent of conversion.orderIntents) {
          const evaluation = await this.evaluateCandidate({
            event,
            strategy,
            strategyContext,
            decision,
            conversion,
            intent,
            request,
            state: snapshotReplayState(state, event, intent),
            fillOrderbooks: getOrderbookHistory(state, event, intent),
          });

          candidates.push(evaluation.result);
          if (evaluation.pendingFill !== undefined) {
            pendingFills.push(evaluation.pendingFill);
          }
        }
      }
    }

    resolvePendingFills(pendingFills, true);

    return {
      events,
      strategyEvaluations,
      candidates,
    };
  }

  private async evaluateCandidate(
    input: BacktestCostInput & {
      request: BacktestRunRequest;
      fillOrderbooks: readonly OrderbookEvent[];
    },
  ): Promise<BacktestOrderCandidateEvaluation> {
    const costDecision = this.costModel.evaluate(input.request.createCostInput(cloneBacktestCostInput(input)));
    if (!costDecision.tradeAllowed) {
      return {
        result: {
          status: "COST_REJECTED",
          event: input.event,
          strategyId: input.strategy.id,
          intent: input.intent,
          costDecision,
        },
      };
    }

    const riskInput: BacktestRiskGateContextInput = {
      ...input,
      costDecision,
    };
    const riskGateContext = input.request.createRiskGateContext(cloneBacktestRiskGateContextInput(riskInput));
    const ruleContext =
      input.request.createRuleContext?.({
        ...cloneBacktestRiskGateContextInput(riskInput),
        riskGateContext: cloneReplayStateValue(riskGateContext),
      }) ?? createDefaultRuleContext(input, costDecision, riskGateContext);
    const ruleResult = await evaluateRules(this.rules, ruleContext);

    if (!ruleResult.passed) {
      return {
        result: {
          status: "RULE_REJECTED",
          event: input.event,
          strategyId: input.strategy.id,
          intent: input.intent,
          costDecision,
          ruleResult,
        },
      };
    }

    const riskGateResult = this.evaluateRiskGate(riskGateContext);
    if (!riskGateResult.approved) {
      return {
        result: {
          status: "RISK_REJECTED",
          event: input.event,
          strategyId: input.strategy.id,
          intent: input.intent,
          costDecision,
          ruleResult,
          riskGateResult,
        },
      };
    }

    const submission = createBacktestOrderSubmission(input, costDecision, riskGateContext, riskGateResult);
    const executionValidation = validateExecutionSubmission(submission);
    if (!executionValidation.valid) {
      return {
        result: {
          status: "EXECUTION_REJECTED",
          event: input.event,
          strategyId: input.strategy.id,
          intent: input.intent,
          costDecision,
          ruleResult,
          riskGateResult,
          submission,
          executionValidation,
        },
      };
    }

    const fillOptions = resolveFillOptions(input.request.fillOptions, {
      ...cloneBacktestRuleContextInput({
        ...riskInput,
        riskGateContext,
      }),
      ruleResult: cloneReplayStateValue(ruleResult),
      riskGateResult: cloneReplayStateValue(riskGateResult),
      submission: cloneReplayStateValue(submission),
    });
    const result: BacktestOrderCandidateResult = {
      status: "SIMULATED",
      event: input.event,
      strategyId: input.strategy.id,
      intent: input.intent,
      costDecision,
      ruleResult,
      riskGateResult,
      submission,
      executionValidation,
    };
    const pendingFill: PendingBacktestFill = {
      result,
      intent: input.intent,
      orderbooks: input.fillOrderbooks,
      options: {
        ...fillOptions,
        submittedAt: submission.submittedAt,
      },
    };
    const resolved = resolvePendingFill(pendingFill, false);

    return resolved ? { result } : { result, pendingFill };
  }
}

function createReplayRequest(request: BacktestRunRequest): HistoricalEventReplayRequest {
  const replayRequest: HistoricalEventReplayRequest = {};

  if (request.exchangeId !== undefined) {
    replayRequest.exchangeId = request.exchangeId;
  }
  if (request.markets !== undefined) {
    replayRequest.markets = request.markets;
  }
  if (request.from !== undefined) {
    replayRequest.from = request.from;
  }
  if (request.to !== undefined) {
    replayRequest.to = request.to;
  }
  if (request.sourceId !== undefined) {
    replayRequest.sourceId = request.sourceId;
  }
  if (request.limit !== undefined) {
    replayRequest.limit = request.limit;
  }

  return replayRequest;
}

function createReplayState(): BacktestReplayState {
  return {
    latestMarketDataEvents: [],
    latestOrderbooksByMarketKey: new Map(),
    latestMarketStatusesByMarketKey: new Map(),
    orderbookHistoryByMarketKey: new Map(),
  };
}

function updateReplayState(
  state: BacktestReplayState,
  event: MarketEvent,
  historyLimits: NormalizedBacktestReplayHistoryLimits,
): void {
  const marketDataEvent = toMarketDataEvent(event);
  if (marketDataEvent !== undefined) {
    state.latestMarketDataEvents.push(marketDataEvent);
    trimArrayStart(state.latestMarketDataEvents, historyLimits.marketDataEvents);
  }

  if (event.kind === "ORDERBOOK_SNAPSHOT") {
    const orderbook = toOrderbookEvent(event);
    const marketKey = createMarketKey(event.exchangeId, event.market);
    state.latestOrderbooksByMarketKey.set(marketKey, orderbook);
    const history = getOrCreateOrderbookHistory(state, marketKey);
    history.push(orderbook);
    trimArrayStart(history, historyLimits.orderbooksPerMarket);
  }

  if (event.kind === "POLICY_CANDIDATE") {
    state.latestMarketStatusesByMarketKey.set(createMarketKey(event.exchangeId, event.market), toMarketStatus(event));
  }
}

function snapshotReplayState(
  state: BacktestReplayState,
  event: MarketEvent,
  intent?: OrderIntent,
): BacktestReplayStateSnapshot {
  const targetExchangeId = intent?.exchangeId ?? event.exchangeId;
  const targetMarket = intent?.market ?? event.market;
  const marketKey = targetMarket === undefined ? undefined : createMarketKey(targetExchangeId, targetMarket);
  const latestOrderbook =
    marketKey === undefined ? undefined : state.latestOrderbooksByMarketKey.get(marketKey);
  const latestMarketStatus =
    marketKey === undefined ? undefined : state.latestMarketStatusesByMarketKey.get(marketKey);
  const orderbookHistory = marketKey === undefined ? emptyOrderbookHistory : getOrderbookHistoryByMarketKey(state, marketKey);

  return {
    latestMarketDataEvents: cloneReplayStateArray(state.latestMarketDataEvents),
    orderbookHistory: cloneReplayStateArray(orderbookHistory),
    ...(latestOrderbook === undefined ? {} : { latestOrderbook: cloneReplayStateValue(latestOrderbook) }),
    ...(latestMarketStatus === undefined ? {} : { latestMarketStatus: cloneReplayStateValue(latestMarketStatus) }),
  };
}

function createDefaultRuleContext(
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

function createBacktestOrderSubmission(
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
    submittedAt: readObservedSubmitTime(input.event),
  };

  if (riskGateContext.expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = riskGateContext.expectedLossBpsOfEquity;
  }

  return submission;
}

function resolveFillOptions(
  fillOptions: BacktestRunRequest["fillOptions"],
  input: BacktestFillOptionsInput,
): PaperFillSimulatorOptions | undefined {
  return typeof fillOptions === "function" ? fillOptions(input) : fillOptions;
}

function resolvePendingFills(pendingFills: PendingBacktestFill[], force: boolean): void {
  for (let index = pendingFills.length - 1; index >= 0; index -= 1) {
    if (resolvePendingFill(pendingFills[index]!, force)) {
      pendingFills.splice(index, 1);
    }
  }
}

function resolvePendingFill(pendingFill: PendingBacktestFill, force: boolean): boolean {
  const simulationInput = createPaperFillSimulationInput(pendingFill);
  const fillResult = simulatePaperFill({
    intent: pendingFill.intent,
    orderbooks: simulationInput.orderbooks,
    options: simulationInput.options,
  });

  if (!force && fillResult.reasonCode === "latency_snapshot_missing") {
    // latency 기준 snapshot이 아직 replay되지 않았으면 임의 no-fill로 확정하지 않고 다음 호가를 기다린다.
    return false;
  }

  pendingFill.result.fillResult = fillResult;
  return true;
}

function createPaperFillSimulationInput(pendingFill: PendingBacktestFill): {
  orderbooks: OrderbookEvent | readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
} {
  const sortedOrderbooks = sortOrderbooksByReceivedAt(pendingFill.orderbooks);
  if (!usesImmediateExecutionSnapshot(pendingFill.options)) {
    return {
      orderbooks: sortedOrderbooks,
      options: pendingFill.options,
    };
  }

  const selectedOrderbook = selectImmediateExecutionOrderbook(sortedOrderbooks, pendingFill.options.submittedAt);
  return {
    orderbooks: selectedOrderbook ?? [],
    options: omitSubmittedAt(pendingFill.options),
  };
}

function usesImmediateExecutionSnapshot(options: PaperFillSimulatorOptions): options is PaperFillSimulatorOptions & {
  submittedAt: TimestampInput;
} {
  return options.submittedAt !== undefined && Math.max(options.latencyMs ?? 0, 0) === 0;
}

function omitSubmittedAt(options: PaperFillSimulatorOptions): PaperFillSimulatorOptions {
  const { submittedAt: _submittedAt, ...remainingOptions } = options;
  return remainingOptions;
}

function selectImmediateExecutionOrderbook(
  orderbooks: readonly OrderbookEvent[],
  submittedAt: TimestampInput,
): OrderbookEvent | undefined {
  const submittedAtNanos = readTimestampNanos(submittedAt);
  let latestPreSubmitSnapshot: OrderbookEvent | undefined;
  let earliestPostSubmitSnapshot: OrderbookEvent | undefined;

  for (const orderbook of orderbooks) {
    const receivedAtNanos = readTimestampNanos(orderbook.receivedAt);
    if (receivedAtNanos <= submittedAtNanos) {
      // latency가 없으면 runtime PaperBroker처럼 제출 직전에 관측한 최신 snapshot을 즉시 체결 근거로 사용한다.
      latestPreSubmitSnapshot = orderbook;
      continue;
    }

    earliestPostSubmitSnapshot ??= orderbook;
  }

  return latestPreSubmitSnapshot ?? earliestPostSubmitSnapshot;
}

function getOrderbookHistory(
  state: BacktestReplayState,
  event: MarketEvent,
  intent: OrderIntent,
): readonly OrderbookEvent[] {
  const targetMarket = intent.market ?? event.market;
  if (targetMarket === undefined) {
    return emptyOrderbookHistory;
  }

  return getOrderbookHistoryByMarketKey(state, createMarketKey(intent.exchangeId, targetMarket));
}

function getOrderbookHistoryByMarketKey(state: BacktestReplayState, marketKey: string): readonly OrderbookEvent[] {
  return state.orderbookHistoryByMarketKey.get(marketKey) ?? emptyOrderbookHistory;
}

function getOrCreateOrderbookHistory(state: BacktestReplayState, marketKey: string): OrderbookEvent[] {
  const existingHistory = state.orderbookHistoryByMarketKey.get(marketKey);
  if (existingHistory !== undefined) {
    return existingHistory;
  }

  const history: OrderbookEvent[] = [];
  state.orderbookHistoryByMarketKey.set(marketKey, history);
  return history;
}

function sortOrderbooksByReceivedAt(orderbooks: readonly OrderbookEvent[]): readonly OrderbookEvent[] {
  return [...orderbooks].sort(compareOrderbooksByReceivedAt);
}

function compareOrderbooksByReceivedAt(left: OrderbookEvent, right: OrderbookEvent): number {
  // receivedAt 동률은 runtime PaperBroker처럼 기존 관측 순서를 보존한다.
  return compareBigInt(readTimestampNanos(left.receivedAt), readTimestampNanos(right.receivedAt));
}

function readObservedSubmitTime(event: MarketEvent): TimestampInput {
  return event.receivedAt ?? event.eventTimestamp;
}

function readTimestampNanos(timestamp: TimestampInput): bigint {
  return parseMarketEventTimestampNanos(timestamp);
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function normalizeReplayHistoryLimits(
  limits: BacktestReplayHistoryLimits | undefined,
): NormalizedBacktestReplayHistoryLimits {
  return {
    marketDataEvents: normalizeReplayHistoryLimit(limits?.marketDataEvents, "marketDataEvents"),
    orderbooksPerMarket: normalizeReplayHistoryLimit(limits?.orderbooksPerMarket, "orderbooksPerMarket"),
  };
}

function normalizeReplayHistoryLimit(value: number | undefined, name: keyof BacktestReplayHistoryLimits): number {
  if (value === undefined) {
    return defaultReplayHistoryLimit;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`BacktestRunRequest.historyLimits.${name} must be a positive integer`);
  }

  return value;
}

function trimArrayStart<T>(items: T[], maxLength: number): void {
  const overflow = items.length - maxLength;
  if (overflow <= 0) {
    return;
  }

  // 오래된 replay state만 제거해 callback window와 pending fill window가 무한히 커지지 않게 한다.
  items.splice(0, overflow);
}

function cloneReplayStateArray<T>(items: readonly T[]): readonly T[] {
  return items.map(cloneReplayStateValue);
}

function cloneReplayStateValue<T>(value: T): T {
  return structuredClone(value) as T;
}

function cloneReplayStateSnapshot(state: BacktestReplayStateSnapshot): BacktestReplayStateSnapshot {
  return {
    latestMarketDataEvents: cloneReplayStateArray(state.latestMarketDataEvents),
    orderbookHistory: cloneReplayStateArray(state.orderbookHistory),
    ...(state.latestOrderbook === undefined ? {} : { latestOrderbook: cloneReplayStateValue(state.latestOrderbook) }),
    ...(state.latestMarketStatus === undefined
      ? {}
      : { latestMarketStatus: cloneReplayStateValue(state.latestMarketStatus) }),
  };
}

function cloneBacktestCostInput(input: BacktestCostInput): BacktestCostInput {
  return {
    event: cloneReplayStateValue(input.event),
    strategy: input.strategy,
    strategyContext: cloneReplayStateValue(input.strategyContext),
    decision: cloneReplayStateValue(input.decision),
    conversion: cloneReplayStateValue(input.conversion),
    intent: cloneReplayStateValue(input.intent),
    state: cloneReplayStateSnapshot(input.state),
  };
}

function cloneBacktestRiskGateContextInput(input: BacktestRiskGateContextInput): BacktestRiskGateContextInput {
  return {
    ...cloneBacktestCostInput(input),
    costDecision: cloneReplayStateValue(input.costDecision),
  };
}

function cloneBacktestRuleContextInput(input: BacktestRuleContextInput): BacktestRuleContextInput {
  return {
    ...cloneBacktestRiskGateContextInput(input),
    riskGateContext: cloneReplayStateValue(input.riskGateContext),
  };
}

function toMarketDataEvent(event: MarketEvent): MarketDataEvent | undefined {
  switch (event.kind) {
    case "TRADE":
      return {
        type: "TRADE",
        exchangeId: event.exchangeId,
        market: event.market,
        tradeId: event.tradeId,
        price: event.price,
        quantity: event.quantity,
        side: event.side,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
      };
    case "ORDERBOOK_SNAPSHOT":
      return toOrderbookEvent(event);
    case "TICKER":
      return {
        type: "TICKER",
        exchangeId: event.exchangeId,
        market: event.market,
        tradePrice: event.tradePrice,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
        ...(event.changeRate === undefined ? {} : { changeRate: event.changeRate }),
        ...(event.accTradePrice24h === undefined ? {} : { accTradePrice24h: event.accTradePrice24h }),
      };
    case "STATUS":
      return {
        type: "STATUS",
        exchangeId: event.exchangeId,
        status: event.status,
        observedAt: event.eventTimestamp,
        ...(event.market === undefined ? {} : { market: event.market }),
        ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
        ...(event.websocketLagMs === undefined ? {} : { websocketLagMs: event.websocketLagMs }),
        ...(event.reconnectCount === undefined ? {} : { reconnectCount: event.reconnectCount }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      };
    case "ORDERBOOK_METRIC":
    case "POLICY_CANDIDATE":
      return undefined;
  }
}

function toOrderbookEvent(event: MarketOrderbookSnapshotEvent): OrderbookEvent {
  return {
    type: "ORDERBOOK",
    exchangeId: event.exchangeId,
    market: event.market,
    asks: event.asks,
    bids: event.bids,
    exchangeTimestamp: event.eventTimestamp,
    receivedAt: event.receivedAt ?? event.eventTimestamp,
    ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
  };
}

function toMarketStatus(event: MarketPolicyCandidateEvent): MarketStatus {
  return {
    exchangeId: event.exchangeId,
    market: event.market,
    tradable: event.tradable,
    warning: event.warning,
    caution: event.caution,
    reasonCodes: event.reasonCodes,
    updatedAt: event.eventTimestamp,
  };
}

function createMarketKey(exchangeId: string, market: string): string {
  return JSON.stringify([exchangeId, market]);
}
