import { CostModel } from "../../domain/index.js";
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
  orderbookHistoryByMarketKey: Map<string, readonly OrderbookEvent[]>;
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
    const events = await collectMarketEvents(this.source.replay(createReplayRequest(request)));
    const state = createReplayState(events);
    const strategyEvaluations: BacktestStrategyEvaluation[] = [];
    const candidates: BacktestOrderCandidateResult[] = [];

    for (const event of events) {
      updateReplayState(state, event);

      for (const strategy of this.strategies) {
        const strategyContext = request.createStrategyContext({
          event,
          strategy,
          state: snapshotReplayState(state, event),
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
          candidates.push(
            await this.evaluateCandidate({
              event,
              strategy,
              strategyContext,
              decision,
              conversion,
              intent,
              request,
              state: snapshotReplayState(state, event, intent),
            }),
          );
        }
      }
    }

    return {
      events,
      strategyEvaluations,
      candidates,
    };
  }

  private async evaluateCandidate(
    input: BacktestCostInput & {
      request: BacktestRunRequest;
    },
  ): Promise<BacktestOrderCandidateResult> {
    const costDecision = this.costModel.evaluate(input.request.createCostInput(input));
    if (!costDecision.tradeAllowed) {
      return {
        status: "COST_REJECTED",
        event: input.event,
        strategyId: input.strategy.id,
        intent: input.intent,
        costDecision,
      };
    }

    const riskInput: BacktestRiskGateContextInput = {
      ...input,
      costDecision,
    };
    const riskGateContext = input.request.createRiskGateContext(riskInput);
    const ruleContext =
      input.request.createRuleContext?.({
        ...riskInput,
        riskGateContext,
      }) ?? createDefaultRuleContext(input, costDecision, riskGateContext);
    const ruleResult = await evaluateRules(this.rules, ruleContext);

    if (!ruleResult.passed) {
      return {
        status: "RULE_REJECTED",
        event: input.event,
        strategyId: input.strategy.id,
        intent: input.intent,
        costDecision,
        ruleResult,
      };
    }

    const riskGateResult = this.evaluateRiskGate(riskGateContext);
    if (!riskGateResult.approved) {
      return {
        status: "RISK_REJECTED",
        event: input.event,
        strategyId: input.strategy.id,
        intent: input.intent,
        costDecision,
        ruleResult,
        riskGateResult,
      };
    }

    const submission = createBacktestOrderSubmission(input, costDecision, riskGateContext, riskGateResult);
    const executionValidation = validateExecutionSubmission(submission);
    if (!executionValidation.valid) {
      return {
        status: "EXECUTION_REJECTED",
        event: input.event,
        strategyId: input.strategy.id,
        intent: input.intent,
        costDecision,
        ruleResult,
        riskGateResult,
        submission,
        executionValidation,
      };
    }

    const fillOptions = resolveFillOptions(input.request.fillOptions, {
      ...input,
      costDecision,
      riskGateContext,
      ruleResult,
      riskGateResult,
      submission,
    });
    const fillResult = simulatePaperFill({
      intent: input.intent,
      orderbooks: input.state.orderbookHistory,
      options: {
        submittedAt: input.event.eventTimestamp,
        ...fillOptions,
      },
    });

    return {
      status: "SIMULATED",
      event: input.event,
      strategyId: input.strategy.id,
      intent: input.intent,
      costDecision,
      ruleResult,
      riskGateResult,
      submission,
      executionValidation,
      fillResult,
    };
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

async function collectMarketEvents(stream: AsyncIterable<MarketEvent>): Promise<MarketEvent[]> {
  const events: MarketEvent[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function createReplayState(events: readonly MarketEvent[]): BacktestReplayState {
  return {
    latestMarketDataEvents: [],
    latestOrderbooksByMarketKey: new Map(),
    latestMarketStatusesByMarketKey: new Map(),
    orderbookHistoryByMarketKey: createOrderbookHistoryByMarketKey(events),
  };
}

function updateReplayState(state: BacktestReplayState, event: MarketEvent): void {
  const marketDataEvent = toMarketDataEvent(event);
  if (marketDataEvent !== undefined) {
    state.latestMarketDataEvents.push(marketDataEvent);
  }

  if (event.kind === "ORDERBOOK_SNAPSHOT") {
    const orderbook = toOrderbookEvent(event);
    state.latestOrderbooksByMarketKey.set(createMarketKey(event.exchangeId, event.market), orderbook);
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

  return {
    latestMarketDataEvents: [...state.latestMarketDataEvents],
    orderbookHistory: marketKey === undefined ? [] : [...(state.orderbookHistoryByMarketKey.get(marketKey) ?? [])],
    ...(latestOrderbook === undefined ? {} : { latestOrderbook }),
    ...(latestMarketStatus === undefined ? {} : { latestMarketStatus }),
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
    submittedAt: input.event.eventTimestamp,
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

function createOrderbookHistoryByMarketKey(events: readonly MarketEvent[]): Map<string, readonly OrderbookEvent[]> {
  const history = new Map<string, OrderbookEvent[]>();

  for (const event of events) {
    if (event.kind !== "ORDERBOOK_SNAPSHOT") {
      continue;
    }

    const marketKey = createMarketKey(event.exchangeId, event.market);
    const snapshots = history.get(marketKey) ?? [];
    snapshots.push(toOrderbookEvent(event));
    history.set(marketKey, snapshots);
  }

  return history;
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
