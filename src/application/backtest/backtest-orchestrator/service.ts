import { CostModel } from "../../../domain/index.js";
import type { CostDecision, MarketEvent, OrderbookEvent, RiskGateContext, RiskGateResult, Rule } from "../../../domain/index.js";
import { validateExecutionSubmission } from "../../execution/index.js";
import { evaluateRiskGate } from "../../risk/index.js";
import { evaluateRules } from "../../rules/index.js";
import { convertStrategyDecisionToOrderIntents } from "../../strategies/index.js";
import {
  createBacktestOrderSubmission,
  createDefaultRuleContext,
  resolveFillOptions,
} from "./candidate-evaluation.js";
import {
  cloneBacktestCostInput,
  cloneBacktestRiskGateContextInput,
  cloneBacktestRuleContextInput,
  cloneReplayStateValue,
  createReplayRequest,
  createReplayState,
  getOrderbookHistory,
  normalizeReplayHistoryLimits,
  snapshotReplayState,
  updateReplayState,
} from "./replay-state.js";
import { resolvePendingFill, resolvePendingFills } from "./fill-resolution.js";
import type {
  BacktestCostInput,
  BacktestFillOptionsInput,
  BacktestOrderCandidateEvaluation,
  BacktestOrderCandidateResult,
  BacktestOrchestratorPorts,
  BacktestReplayStateSnapshot,
  BacktestRiskGateContextInput,
  BacktestRunRequest,
  BacktestRunResult,
  BacktestStrategyEvaluation,
  PendingBacktestFill,
} from "./types.js";
import type { HistoricalEventSource } from "../../ports/index.js";
import type { Strategy } from "../../../domain/index.js";

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

    return this.createSimulatedCandidate({
      input,
      costDecision,
      riskInput,
      riskGateContext,
      riskGateResult,
      ruleResult,
    });
  }

  private createSimulatedCandidate(input: {
    input: BacktestCostInput & {
      request: BacktestRunRequest;
      fillOrderbooks: readonly OrderbookEvent[];
    };
    costDecision: CostDecision;
    riskInput: BacktestRiskGateContextInput;
    riskGateContext: RiskGateContext;
    riskGateResult: RiskGateResult;
    ruleResult: Awaited<ReturnType<typeof evaluateRules>>;
  }): BacktestOrderCandidateEvaluation {
    const submission = createBacktestOrderSubmission(
      input.input,
      input.costDecision,
      input.riskGateContext,
      input.riskGateResult,
    );
    const executionValidation = validateExecutionSubmission(submission);
    if (!executionValidation.valid) {
      return {
        result: {
          status: "EXECUTION_REJECTED",
          event: input.input.event,
          strategyId: input.input.strategy.id,
          intent: input.input.intent,
          costDecision: input.costDecision,
          ruleResult: input.ruleResult,
          riskGateResult: input.riskGateResult,
          submission,
          executionValidation,
        },
      };
    }

    const fillOptions = resolveFillOptions(input.input.request.fillOptions, {
      ...cloneBacktestRuleContextInput({
        ...input.riskInput,
        riskGateContext: input.riskGateContext,
      }),
      ruleResult: cloneReplayStateValue(input.ruleResult),
      riskGateResult: cloneReplayStateValue(input.riskGateResult),
      submission: cloneReplayStateValue(submission),
    } satisfies BacktestFillOptionsInput);
    const result: BacktestOrderCandidateResult = {
      status: "SIMULATED",
      event: input.input.event,
      strategyId: input.input.strategy.id,
      intent: input.input.intent,
      costDecision: input.costDecision,
      ruleResult: input.ruleResult,
      riskGateResult: input.riskGateResult,
      submission,
      executionValidation,
    };
    const pendingFill: PendingBacktestFill = {
      result,
      intent: input.input.intent,
      orderbooks: input.input.fillOrderbooks,
      options: {
        ...fillOptions,
        submittedAt: submission.submittedAt,
      },
    };
    const resolved = resolvePendingFill(pendingFill, false);

    return resolved ? { result } : { result, pendingFill };
  }
}
