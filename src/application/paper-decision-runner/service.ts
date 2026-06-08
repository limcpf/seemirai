import { Decimal } from "decimal.js";
import {
  CostModel,
  createRiskThresholdSnapshot,
  defaultRiskLimitThresholds,
} from "../../domain/index.js";
import type {
  AccountRiskSnapshot,
  BrokerOrder,
  CostDecision,
  CostModelInput,
  InfrastructureRiskSnapshot,
  JsonRecord,
  OrderIntent,
  OrderSubmission,
  OrderbookEvent,
  PositionRiskSnapshot,
  RiskGateContext,
  RiskGateResult,
  Strategy,
  StrategyContext,
  StrategyRiskSnapshot,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { FinancialDecimalInput } from "../../shared/index.js";
import {
  ExecutionEngine,
  createExecutionCostSnapshotEvidence,
  createExecutionRiskApprovalEvidence,
} from "../execution/index.js";
import {
  PaperPnlSummaryInvariantError,
  createPaperPnlSummary,
  createUnavailablePaperPnlSummary,
} from "../paper-pnl-summary.js";
import type { PaperPnlFillInput, PaperPnlMarkPriceInput } from "../paper-pnl-summary.js";
import { evaluateRiskGate as evaluateRiskGateDefault } from "../risk/index.js";
import { convertStrategyDecisionToOrderIntents } from "../strategies/index.js";
import type { StrategyDecisionIntentConversion } from "../strategies/index.js";
import {
  buildDecisionLedgerFromRunnerResult,
} from "../decision-ledger.js";
import type {
  PaperDecisionBrokerPort,
  PaperDecisionInputFrame,
  PaperDecisionInputReplayRequest,
  PaperDecisionMetricSummary,
  PaperDecisionRunnerOptions,
  PaperDecisionRunnerPorts,
  PaperDecisionRunnerResult,
  PaperDecisionRunnerTraceRecord,
  PaperDecisionCostSummary,
  PaperDecisionSlippageSummary,
  PaperDecisionLedgerWriteStatus,
} from "./types.js";

type MutableCounts = Record<string, number>;

interface PaperDecisionMetricAccumulator {
  strategyEvaluationCount: number;
  orderCandidateCount: number;
  orderIntentCount: number;
  holdReasonCounts: MutableCounts;
  discardReasonCounts: MutableCounts;
  costRejectedCount: number;
  riskRejectedCount: number;
  paperOrderSubmittedCount: number;
  paperFillCount: number;
  blockingReasonCounts: MutableCounts;
  costBpsValues: Decimal[];
  requiredReturnBpsValues: Decimal[];
  marginBpsValues: Decimal[];
  costAllowedCount: number;
  costEvaluatedCount: number;
  slippageBpsValues: Decimal[];
  submittedBrokerOrderIds: Set<string>;
  filledBrokerOrderIds: Set<string>;
  pnlFills: PaperPnlFillInput[];
  pnlMarkPricesByMarket: Map<string, PaperPnlMarkPriceInput>;
}

const defaultAccountEquityKrw = "1000000";
const defaultExpectedLossBpsOfEquity = "5";
const defaultPnlStartingCashKrw = "1000000";

/**
 * M9 paper decision runner의 application service다.
 *
 * 이 runner는 public WebSocket soak와 분리되어 deterministic frame 또는 DB frame을 받아 `feature -> strategy
 * evaluation -> order intent -> CostModel -> RiskGate -> ExecutionEngine -> BrokerPort` 순서를 실행한다. DB write,
 * Telegram, Upbit private API는 직접 호출하지 않으며, broker side effect는 주입된 `BrokerPort`로만 제한한다.
 */
export class PaperDecisionRunner {
  private readonly source: PaperDecisionRunnerPorts["source"];
  private readonly strategies: readonly Strategy[];
  private readonly broker: PaperDecisionBrokerPort;
  private readonly costModel: Pick<CostModel, "evaluate">;
  private readonly evaluateRiskGate: (context: RiskGateContext) => RiskGateResult;
  private readonly executionEngine: Pick<ExecutionEngine, "submitOrder">;
  private readonly decisionLedgerWriter: PaperDecisionRunnerPorts["decisionLedgerWriter"];

  public constructor(ports: PaperDecisionRunnerPorts) {
    this.source = ports.source;
    this.strategies = ports.strategies;
    this.broker = ports.broker;
    this.costModel = ports.costModel ?? new CostModel();
    this.evaluateRiskGate = ports.evaluateRiskGate ?? evaluateRiskGateDefault;
    this.executionEngine = ports.executionEngine ?? new ExecutionEngine({ broker: ports.broker });
    this.decisionLedgerWriter = ports.decisionLedgerWriter;
  }

  /**
   * 입력 source를 순서대로 replay하고 M9 비교용 summary metric을 만든다.
   *
   * 주문이 0건이어도 HOLD, discard, cost rejection, risk rejection count를 남겨 운영자가 무거래 원인을 확인할 수
   * 있게 한다. 실거래 API 호출 수는 이 runner에서 증가할 수 없으므로 summary에 0으로 고정한다.
   */
  public async run(options: PaperDecisionRunnerOptions = {}): Promise<PaperDecisionRunnerResult> {
    const metrics = createMetricAccumulator();
    const trace: PaperDecisionRunnerTraceRecord[] = [];
    let framesProcessed = 0;
    const replayRequest = createReplayRequest(options);
    const iterator = this.source.replay(replayRequest)[Symbol.asyncIterator]();

    try {
      while (options.maxFrames === undefined || framesProcessed < options.maxFrames) {
        // DB/cursor source는 next 호출 자체가 cursor를 전진시킬 수 있어 처리 한도 전에만 frame을 당긴다.
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }

        const frame = next.value;
        framesProcessed += 1;
        trace.push(createTrace(frame, "FRAME_RECEIVED", "received"));

        if (frame.orderbook !== undefined) {
          // frame-local 호가는 paper fill 근거로만 주입하고 외부 market data 조회를 열지 않는다.
          this.broker.recordOrderbookSnapshot?.(frame.orderbook);
          recordPnlMarkPrice(metrics, frame.orderbook);
        }

        for (const strategy of this.strategies) {
          await this.evaluateStrategyFrame({ frame, strategy, metrics, trace });
        }
      }
    } finally {
      if (typeof iterator.return === "function") {
        await iterator.return();
      }
    }

    const finalMetrics = finalizeMetrics(metrics, options.pnlStartingCashKrw ?? defaultPnlStartingCashKrw);
    const runnerResult: Omit<PaperDecisionRunnerResult, "ledgerWriteStatus"> = {
      framesProcessed,
      metrics: finalMetrics,
      trace,
    };

    // ledger writer가 주입되지 않았으면 NOT_CONFIGURED 상태로 완료한다.
    if (this.decisionLedgerWriter === undefined) {
      return { ...runnerResult, ledgerWriteStatus: "NOT_CONFIGURED" };
    }

    // decision ledger write. 실패해도 broker/execution 재시도를 하지 않고 runner 결과를 보존한다.
    try {
      const sourceRunId = resolveLedgerSourceRunId(options, trace);
      const exchange = "UPBIT";
      // buildDecisionLedgerFromRunnerResult는 ledgerWriteStatus가 없는 runnerResult도 받을 수 있다.
      const ledgerInput: PaperDecisionRunnerResult = { ...runnerResult, ledgerWriteStatus: "RECORDED" };
      const ledgerResult = buildDecisionLedgerFromRunnerResult(ledgerInput, sourceRunId, exchange);

      for (const { frame, evidenceItems } of ledgerResult.frames) {
        // frame/evidence를 한 원자적 writer 호출로 묶어 근거 없는 RECORDED frame이 status에 노출되지 않게 한다.
        await this.decisionLedgerWriter.appendFrameWithEvidence(frame, evidenceItems);
      }

      return { ...runnerResult, ledgerWriteStatus: "RECORDED" };
    } catch {
      // ledger write 실패는 broker retry나 주문 허용 보정을 하지 않고, trace로만 남긴다.
      return { ...runnerResult, ledgerWriteStatus: "UNAVAILABLE" };
    }
  }

  private async evaluateStrategyFrame(input: {
    frame: PaperDecisionInputFrame;
    strategy: Strategy;
    metrics: PaperDecisionMetricAccumulator;
    trace: PaperDecisionRunnerTraceRecord[];
  }): Promise<void> {
    const strategyContext = createPaperDecisionStrategyContext(input.frame, input.strategy);
    const decision = await input.strategy.evaluate(strategyContext);
    input.metrics.strategyEvaluationCount += 1;
    const strategyTraceOptions: {
      strategyId: string;
      reasonCode?: string;
      message: string;
      metadata?: JsonRecord;
    } = {
      strategyId: input.strategy.id,
      message: decision.reason,
    };
    assignIfDefined(strategyTraceOptions, "reasonCode", readDecisionReasonCode(decision));
    if (decision.kind === "ORDER_INTENT") {
      const intentDirections = decision.orderIntents.map((intent) => intent.side);
      strategyTraceOptions.metadata = {
        order_intent_count: decision.orderIntents.length,
        intent_directions: intentDirections,
      };
    }
    input.trace.push(createTrace(input.frame, "STRATEGY_DECISION", decision.kind, strategyTraceOptions));

    if (decision.kind === "HOLD") {
      increment(input.metrics.holdReasonCounts, decision.reason);
      increment(input.metrics.blockingReasonCounts, `hold:${decision.reason}`);
      return;
    }

    if (decision.kind === "BLOCK") {
      increment(input.metrics.discardReasonCounts, decision.reasonCode);
      increment(input.metrics.blockingReasonCounts, `discard:${decision.reasonCode}`);
      return;
    }

    input.metrics.orderCandidateCount += decision.orderIntents.length;
    const conversion = convertStrategyDecisionToOrderIntents(decision, {
      allowMarketOrders: false,
      metadata: {
        paper_decision_runner: true,
        frame_id: input.frame.id,
      },
    });
    recordConversion(input.frame, input.strategy, conversion, input.metrics, input.trace);

    for (const intent of conversion.orderIntents) {
      input.metrics.orderIntentCount += 1;
      await this.evaluateOrderIntent({
        frame: input.frame,
        intent,
        metrics: input.metrics,
        trace: input.trace,
      });
    }
  }

  private async evaluateOrderIntent(input: {
    frame: PaperDecisionInputFrame;
    intent: OrderIntent;
    metrics: PaperDecisionMetricAccumulator;
    trace: PaperDecisionRunnerTraceRecord[];
  }): Promise<void> {
    const intent = createPaperDecisionExecutionIntent(input.frame, input.intent);
    const costDecision = this.costModel.evaluate(createPaperDecisionCostInput(input.frame, intent));
    recordCostDecision(input.frame, intent, costDecision, input.metrics, input.trace);
    if (!costDecision.tradeAllowed) {
      return;
    }

    const riskGateContext = createPaperDecisionRiskGateContext(input.frame, intent, costDecision);
    const riskGateResult = this.evaluateRiskGate(riskGateContext);
    recordRiskDecision(input.frame, intent, riskGateResult, input.metrics, input.trace);
    if (!riskGateResult.approved) {
      return;
    }

    const submission = createPaperDecisionSubmission(input.frame, intent, costDecision, riskGateContext, riskGateResult);
    const executionResult = await this.executionEngine.submitOrder(submission);
    recordExecutionResult(input.frame, intent, executionResult, input.metrics, input.trace);
  }
}

function createReplayRequest(options: PaperDecisionRunnerOptions): PaperDecisionInputReplayRequest | undefined {
  const replayRequest: PaperDecisionInputReplayRequest = {
    ...(options.sourceRequest ?? {}),
  };

  if (options.maxFrames !== undefined) {
    replayRequest.limit =
      replayRequest.limit === undefined ? options.maxFrames : Math.min(replayRequest.limit, options.maxFrames);
  }

  return Object.keys(replayRequest).length === 0 ? undefined : replayRequest;
}

/**
 * runner 결과를 ledger에 기록할 source run id를 결정한다.
 *
 * caller가 source id를 제공하면 그대로 사용하고, 없으면 처리된 frame id 목록으로 결정론적 id를 만든다.
 * Date.now 기반 id를 쓰면 같은 input 재실행이 매번 다른 dedupe key로 저장되어 append-only idempotency가 깨진다.
 */
function resolveLedgerSourceRunId(
  options: PaperDecisionRunnerOptions,
  trace: readonly PaperDecisionRunnerTraceRecord[],
): string {
  const explicitSourceId = options.sourceRequest?.sourceId?.trim();
  if (explicitSourceId !== undefined && explicitSourceId.length > 0) {
    return explicitSourceId;
  }

  const frameIds = [...new Set(trace.map((record) => record.frameId))];
  const seed = frameIds.length === 0 ? "empty" : frameIds.join("|");
  return `paper-runner:${stableHash(seed)}`;
}

/**
 * runner frame을 strategy 호출 context로 변환한다.
 *
 * frame id와 source metadata를 strategy metadata에 보존해, 생성된 주문 후보와 summary trace가 같은 입력 프레임으로
 * 역추적될 수 있게 한다.
 */
export function createPaperDecisionStrategyContext(
  frame: PaperDecisionInputFrame,
  strategy: Strategy,
): StrategyContext {
  return {
    strategyId: strategy.id,
    exchangeId: frame.exchangeId,
    market: frame.market,
    observedAt: frame.observedAt,
    marketEvents: frame.marketEvents ?? [],
    features: frame.features,
    metadata: {
      ...(frame.metadata ?? {}),
      frame_id: frame.id,
      source: frame.metadata?.source ?? "paper_decision_runner",
    },
  };
}

/**
 * CostModel 평가 결과와 frame risk snapshot으로 RiskGate context를 만든다.
 *
 * fixture smoke는 누락된 계정/전략 리스크 값을 안전한 기본값으로 채우지만, 실제 DB source는 저장된 risk snapshot을
 * 주입해야 한다. expected loss는 RiskGate와 ExecutionEngine evidence fingerprint가 공유하는 필수 입력이다.
 */
export function createPaperDecisionRiskGateContext(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  _costDecision: CostDecision,
): RiskGateContext {
  const thresholdSnapshot =
    frame.risk?.thresholdSnapshot ??
    createRiskThresholdSnapshot(defaultRiskLimitThresholds, frame.observedAt, "paper_decision_runner.default");
  const expectedLossBpsOfEquity =
    frame.risk?.expectedLossBpsOfEquity ??
    readStringFeature(frame, "expected_loss_bps_of_equity") ??
    defaultExpectedLossBpsOfEquity;

  return {
    orderIntent: intent,
    account: createAccountRiskSnapshot(frame),
    positions: createPositionRiskSnapshots(frame),
    strategy: createStrategyRiskSnapshot(frame, intent),
    infrastructureSignals: createInfrastructureSignals(frame),
    thresholdSnapshot,
    observedAt: frame.observedAt,
    expectedLossBpsOfEquity,
    metadata: {
      ...(frame.risk?.metadata ?? {}),
      frame_id: frame.id,
      cost_reason_code: _costDecision.reasonCode,
    },
  };
}

/**
 * CostModel과 RiskGate 승인 evidence를 ExecutionEngine 제출 경계에 맞게 묶는다.
 *
 * 이 함수는 broker 호출 직전의 단일 submission을 만들며, cost/risk evidence에 현재 intent fingerprint를 붙여
 * stale approval 재사용을 차단한다.
 */
export function createPaperDecisionSubmission(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  costDecision: CostDecision,
  riskGateContext: RiskGateContext,
  riskGateResult: RiskGateResult,
): OrderSubmission {
  const submission: OrderSubmission = {
    intent,
    costSnapshot: createPaperDecisionExecutionCostEvidence(
      intent,
      costDecision,
      riskGateContext.expectedLossBpsOfEquity,
    ),
    riskApproval: createExecutionRiskApprovalEvidence(riskGateResult, riskGateContext),
    submittedAt: frame.observedAt,
  };

  if (riskGateContext.expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = riskGateContext.expectedLossBpsOfEquity;
  }

  return submission;
}

/**
 * paper decision runner의 SELL 후보를 execution boundary가 요구하는 exit intent metadata로 보강한다.
 *
 * runner 전략은 아직 exit engine을 직접 호출하지 않지만, spot MVP에서 SELL은 포지션 축소/청산으로만 실행해야 한다.
 * 따라서 cost/risk evidence fingerprint를 만들기 전에 frame-local position quantity가 있는 SELL 후보만 exit metadata를
 * 부여하고, 수량 근거가 없으면 기존 plain SELL을 유지해 ExecutionEngine validation이 fail-closed 하게 둔다.
 */
function createPaperDecisionExecutionIntent(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
): OrderIntent {
  if (intent.side !== "SELL") {
    return intent;
  }

  const totalQuantity = readExitPositionQuantity(frame, intent);
  if (totalQuantity === undefined) {
    return intent;
  }

  const positionEffect = resolvePaperDecisionPositionEffect(intent.requestedQuantity, totalQuantity);
  return {
    ...intent,
    metadata: {
      ...(intent.metadata ?? {}),
      position_effect: positionEffect,
      exit_reason_code: readStringFeature(frame, "exit_reason_code") ?? "paper_decision_runner_sell_exit",
      exit_rule_id: readStringFeature(frame, "exit_rule_id") ?? `paper_decision_runner:${intent.strategyId}`,
      position_scope: {
        market: intent.market,
        strategyId: intent.strategyId,
        totalQuantity,
        observedAt: frame.observedAt,
      },
    },
  };
}

/**
 * paper decision submission의 비용 evidence를 execution validation contract에 맞게 만든다.
 *
 * BUY/entry 후보는 기존 `cost_model` fingerprint를 사용하고, exit metadata가 확정된 SELL 후보는 `exit_cost_model`
 * snapshot으로 분리한다. 이 함수는 evidence 객체만 만들며 broker나 저장소 side effect는 수행하지 않는다.
 */
function createPaperDecisionExecutionCostEvidence(
  intent: OrderIntent,
  costDecision: CostDecision,
  expectedLossBpsOfEquity?: string,
): JsonRecord {
  if (intent.side === "SELL" && isExitPositionEffect(readOrderIntentPositionEffect(intent))) {
    const totalQuantity = readStringRecordValue(readRecordValue(intent.metadata, "position_scope"), "totalQuantity");
    const orderIntentEvidence = createExecutionCostSnapshotEvidence(
      costDecision.snapshot,
      intent,
      expectedLossBpsOfEquity,
    ).order_intent;
    return {
      source: "exit_cost_model",
      exit_cost_allowed: costDecision.tradeAllowed,
      exit_cost_reason_code:
        costDecision.reasonCode === "cost_margin_ok" ? "exit_cost_margin_ok" : costDecision.reasonCode,
      exit_cost_bps:
        readStringRecordValue(costDecision.snapshot, "cost_bps") ??
        readStringRecordValue(costDecision.snapshot, "exit_fee_bps") ??
        "0",
      exit_slippage_bps: readStringRecordValue(costDecision.snapshot, "expected_slippage_bps_p95") ?? "0",
      position_scope: {
        market: intent.market,
        strategy_id: intent.strategyId,
        total_quantity: totalQuantity,
      },
      order_intent: orderIntentEvidence,
    };
  }

  return createExecutionCostSnapshotEvidence(costDecision.snapshot, intent, expectedLossBpsOfEquity);
}

/**
 * SELL 후보의 open position 수량 근거를 frame-local 입력에서 읽는다.
 *
 * runner는 broker balance를 조회하지 않으므로 feature 또는 risk position metadata에 명시된 수량만 신뢰한다.
 * 수량 근거가 없으면 undefined를 반환해 plain SELL이 ExecutionEngine에서 fail-closed 되도록 한다.
 */
function readExitPositionQuantity(frame: PaperDecisionInputFrame, intent: OrderIntent): string | undefined {
  const matchingPosition = frame.risk?.positions?.find((position) => {
    // 전략별 SELL이 계정 집계 포지션을 빌리면 다른 전략 물량까지 청산할 수 있어 exact scope만 인정한다.
    return position.market === intent.market && position.strategyId === intent.strategyId;
  });
  const metadata = matchingPosition?.metadata;
  const strategyQuantity =
    readStringRecordValue(metadata, "position_quantity") ??
    readStringRecordValue(metadata, "position_total_quantity") ??
    readStringRecordValue(metadata, "total_quantity") ??
    readStringRecordValue(metadata, "totalQuantity") ??
    readStringRecordValue(metadata, "quantity");
  if (strategyQuantity !== undefined) {
    return strategyQuantity;
  }

  return (
    readStringFeature(frame, "position_quantity") ??
    readStringFeature(frame, "position_total_quantity") ??
    readStringFeature(frame, "total_quantity")
  );
}

/**
 * requested quantity가 position 전체와 같은지 비교해 REDUCE/EXIT metadata를 결정한다.
 *
 * Decimal 비교에 실패하면 전체 청산으로 승격하지 않고 REDUCE로 낮춰 운영 메시지가 과장되지 않게 한다.
 */
function resolvePaperDecisionPositionEffect(requestedQuantity: string, totalQuantity: string): "REDUCE" | "EXIT" {
  try {
    return parseFinancialDecimal(requestedQuantity).equals(parseFinancialDecimal(totalQuantity)) ? "EXIT" : "REDUCE";
  } catch {
    return "REDUCE";
  }
}

/**
 * OrderIntent metadata에서 position effect를 snake_case/camelCase 양쪽 표기로 읽는다.
 *
 * ExecutionEngine fingerprint와 같은 fallback 규칙을 써야 cost/risk evidence와 validation 결과가 같은 intent를 가리킨다.
 */
function readOrderIntentPositionEffect(intent: OrderIntent): string | undefined {
  return (
    readStringRecordValue(intent.metadata, "position_effect") ??
    readStringRecordValue(intent.metadata, "positionEffect")
  );
}

/** REDUCE/EXIT position effect만 exit evidence 대상으로 인정한다. */
function isExitPositionEffect(value: string | undefined): value is "REDUCE" | "EXIT" {
  return value === "REDUCE" || value === "EXIT";
}

function createPaperDecisionCostInput(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
): CostModelInput {
  const input: CostModelInput = {
    exchangeId: intent.exchangeId,
    market: intent.market,
    evaluatedAt: frame.observedAt,
    metadata: {
      ...(frame.costInput?.metadata ?? {}),
      frame_id: frame.id,
      strategy_id: intent.strategyId,
    },
  };

  assignIfDefined(input, "expectedReturnBps", readCostInput(frame, "expectedReturnBps", "expected_return_bps"));
  assignIfDefined(input, "entryFeeBps", readCostInput(frame, "entryFeeBps", "entry_fee_bps"));
  assignIfDefined(input, "exitFeeBps", readCostInput(frame, "exitFeeBps", "exit_fee_bps"));
  assignIfDefined(input, "spreadCostBpsP75", readCostInput(frame, "spreadCostBpsP75", "spread_cost_bps_p75"));
  assignIfDefined(
    input,
    "expectedSlippageBpsP95",
    readCostInput(frame, "expectedSlippageBpsP95", "expected_slippage_bps_p95"),
  );
  assignIfDefined(
    input,
    "cancelRequotePenaltyBps",
    readCostInput(frame, "cancelRequotePenaltyBps", "cancel_requote_penalty_bps"),
  );
  assignIfDefined(input, "safetyBufferBps", readCostInput(frame, "safetyBufferBps", "safety_buffer_bps"));
  if (input.safetyBufferBps === undefined && frame.universe?.phase15ApprovedAltMarkets?.includes(intent.market)) {
    // phase 1.5 universe evidence가 붙은 프레임만 TOP_ALT 기본 buffer를 열어 미승인 알트의 비용 입력 누락 차단을 유지한다.
    input.safetyBufferMarketCategory = "TOP_ALT";
  }

  return input;
}

function recordConversion(
  frame: PaperDecisionInputFrame,
  strategy: Strategy,
  conversion: StrategyDecisionIntentConversion,
  metrics: PaperDecisionMetricAccumulator,
  trace: PaperDecisionRunnerTraceRecord[],
): void {
  // conversion 결과에서 개별 intent의 direction(side)을 추출해 trace에 보존한다.
  // ORDER_INTENT_CONVERSION category 판정 시 reasonCode 대신 실제 intent 방향을 사용하기 위함.
  const intentDirections = conversion.orderIntents.map((intent) => intent.side);
  const metadata: JsonRecord = {
    promoted_count: conversion.orderIntents.length,
    rejection_count: conversion.rejections.length,
  };
  assignIfDefined(metadata, "intent_directions", intentDirections.length > 0 ? intentDirections : undefined);
  trace.push(
    createTrace(frame, "ORDER_INTENT_CONVERSION", conversion.status, {
      strategyId: strategy.id,
      reasonCode: conversion.reasonCode,
      message: conversion.message,
      metadata,
    }),
  );

  for (const rejection of conversion.rejections) {
    increment(metrics.discardReasonCounts, rejection.reasonCode);
    increment(metrics.blockingReasonCounts, `discard:${rejection.reasonCode}`);
  }
}

function recordCostDecision(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  costDecision: CostDecision,
  metrics: PaperDecisionMetricAccumulator,
  trace: PaperDecisionRunnerTraceRecord[],
): void {
  metrics.costEvaluatedCount += 1;
  appendDecimal(metrics.costBpsValues, costDecision.snapshot.cost_bps);
  appendDecimal(metrics.requiredReturnBpsValues, costDecision.snapshot.required_return_bps);
  appendDecimal(metrics.marginBpsValues, costDecision.snapshot.margin_bps);

  if (costDecision.tradeAllowed) {
    metrics.costAllowedCount += 1;
  } else {
    metrics.costRejectedCount += 1;
    increment(metrics.blockingReasonCounts, `cost:${costDecision.reasonCode}`);
  }

  trace.push(
    createTrace(frame, "COST_DECISION", costDecision.kind, {
      strategyId: intent.strategyId,
      reasonCode: costDecision.reasonCode,
      message: costDecision.message,
      metadata: {
        intent_side: intent.side,
        trade_allowed: costDecision.tradeAllowed,
        cost_bps: costDecision.snapshot.cost_bps ?? null,
        margin_bps: costDecision.snapshot.margin_bps ?? null,
      },
    }),
  );
}

function recordRiskDecision(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  riskGateResult: RiskGateResult,
  metrics: PaperDecisionMetricAccumulator,
  trace: PaperDecisionRunnerTraceRecord[],
): void {
  if (!riskGateResult.approved) {
    metrics.riskRejectedCount += 1;
    for (const evaluation of riskGateResult.failedEvaluations) {
      increment(metrics.blockingReasonCounts, `risk:${evaluation.reasonCode}`);
    }
  }

  trace.push(
    createTrace(frame, "RISK_DECISION", riskGateResult.status, {
      strategyId: intent.strategyId,
      reasonCode: riskGateResult.action,
      message: riskGateResult.approved ? "RiskGate approved paper order intent" : "RiskGate rejected paper order intent",
      metadata: {
        intent_side: intent.side,
        approved: riskGateResult.approved,
        action: riskGateResult.action,
        failed_reason_codes: riskGateResult.failedEvaluations.map((evaluation) => evaluation.reasonCode),
      },
    }),
  );
}

function recordExecutionResult(
  frame: PaperDecisionInputFrame,
  intent: OrderIntent,
  executionResult: Awaited<ReturnType<ExecutionEngine["submitOrder"]>>,
  metrics: PaperDecisionMetricAccumulator,
  trace: PaperDecisionRunnerTraceRecord[],
): void {
  if (executionResult.status === "REJECTED") {
    increment(metrics.discardReasonCounts, executionResult.rejection.reasonCode);
    increment(metrics.blockingReasonCounts, `discard:${executionResult.rejection.reasonCode}`);
    trace.push(
      createTrace(frame, "EXECUTION_RESULT", executionResult.status, {
        strategyId: intent.strategyId,
        reasonCode: executionResult.rejection.reasonCode,
        message: executionResult.rejection.message,
      }),
    );
    return;
  }

  const brokerOrderId = executionResult.brokerOrder.brokerOrderId;
  const brokerRejected = executionResult.brokerOrder.status === "REJECTED";
  if (executionResult.status === "SUBMITTED" && !metrics.submittedBrokerOrderIds.has(brokerOrderId)) {
    // broker idempotency 재반환은 신규 제출이 아니므로 운영 제출량 metric을 중복 집계하지 않는다.
    metrics.submittedBrokerOrderIds.add(brokerOrderId);
    metrics.paperOrderSubmittedCount += 1;
  }

  const fillSimulation = readPaperFillSimulation(executionResult.brokerOrder.metadata);
  const filledQuantity = readDecimalValue(fillSimulation?.filledQuantity);
  if (
    !brokerRejected &&
    !metrics.filledBrokerOrderIds.has(brokerOrderId) &&
    filledQuantity !== undefined &&
    filledQuantity.greaterThan(0)
  ) {
    // broker가 최종 거부한 주문과 idempotent 재반환은 실제 paper fill 품질 metric에서 제외한다.
    metrics.filledBrokerOrderIds.add(brokerOrderId);
    metrics.paperFillCount += 1;
    appendDecimal(metrics.slippageBpsValues, fillSimulation?.slippageBps);
    appendPaperPnlFills(metrics.pnlFills, executionResult.brokerOrder);
  }

  if (brokerRejected) {
    increment(metrics.discardReasonCounts, "paper_broker_rejected");
    increment(metrics.blockingReasonCounts, "discard:paper_broker_rejected");
  }

  const executionTraceOptions: {
    strategyId: string;
    reasonCode?: string;
    message: string;
    metadata: JsonRecord;
  } = {
    strategyId: intent.strategyId,
    message: "Paper broker returned an execution result",
    metadata: {
      broker_order_id: executionResult.brokerOrder.brokerOrderId,
      broker_order_status: executionResult.brokerOrder.status,
      intent_side: intent.side,
      filled_quantity: fillSimulation?.filledQuantity ?? "0",
      slippage_bps: fillSimulation?.slippageBps ?? null,
    },
  };
  assignIfDefined(executionTraceOptions, "reasonCode", readStringRecordValue(fillSimulation, "reasonCode"));
  trace.push(createTrace(frame, "EXECUTION_RESULT", executionResult.status, executionTraceOptions));
}

function createAccountRiskSnapshot(frame: PaperDecisionInputFrame): AccountRiskSnapshot {
  const account = frame.risk?.account;
  return {
    equityKrw: account?.equityKrw ?? defaultAccountEquityKrw,
    dailyRealizedPnlBps: account?.dailyRealizedPnlBps ?? "0",
    weeklyRealizedPnlBps: account?.weeklyRealizedPnlBps ?? "0",
    maxDrawdownBps: account?.maxDrawdownBps ?? "0",
    capturedAt: account?.capturedAt ?? frame.observedAt,
    ...(account?.metadata === undefined ? {} : { metadata: account.metadata }),
  };
}

function createPositionRiskSnapshots(frame: PaperDecisionInputFrame): readonly PositionRiskSnapshot[] {
  return frame.risk?.positions ?? [];
}

function createStrategyRiskSnapshot(frame: PaperDecisionInputFrame, intent: OrderIntent): StrategyRiskSnapshot {
  const strategy = frame.risk?.strategy;
  return {
    strategyId: strategy?.strategyId ?? intent.strategyId,
    consecutiveLosses: strategy?.consecutiveLosses ?? 0,
    capturedAt: strategy?.capturedAt ?? frame.observedAt,
    ...(strategy?.metadata === undefined ? {} : { metadata: strategy.metadata }),
  };
}

function createInfrastructureSignals(frame: PaperDecisionInputFrame): readonly InfrastructureRiskSnapshot[] {
  return frame.risk?.infrastructureSignals ?? [];
}

function createMetricAccumulator(): PaperDecisionMetricAccumulator {
  return {
    strategyEvaluationCount: 0,
    orderCandidateCount: 0,
    orderIntentCount: 0,
    holdReasonCounts: {},
    discardReasonCounts: {},
    costRejectedCount: 0,
    riskRejectedCount: 0,
    paperOrderSubmittedCount: 0,
    paperFillCount: 0,
    blockingReasonCounts: {},
    costBpsValues: [],
    requiredReturnBpsValues: [],
    marginBpsValues: [],
    costAllowedCount: 0,
    costEvaluatedCount: 0,
    slippageBpsValues: [],
    submittedBrokerOrderIds: new Set(),
    filledBrokerOrderIds: new Set(),
    pnlFills: [],
    pnlMarkPricesByMarket: new Map(),
  };
}

function finalizeMetrics(accumulator: PaperDecisionMetricAccumulator, pnlStartingCashKrw: string): PaperDecisionMetricSummary {
  return {
    strategyEvaluationCount: accumulator.strategyEvaluationCount,
    orderCandidateCount: accumulator.orderCandidateCount,
    orderIntentCount: accumulator.orderIntentCount,
    holdReasonCounts: sortCounts(accumulator.holdReasonCounts),
    discardReasonCounts: sortCounts(accumulator.discardReasonCounts),
    costRejectedCount: accumulator.costRejectedCount,
    riskRejectedCount: accumulator.riskRejectedCount,
    paperOrderSubmittedCount: accumulator.paperOrderSubmittedCount,
    paperFillCount: accumulator.paperFillCount,
    fillRate: calculateFillRate(accumulator.paperFillCount, accumulator.paperOrderSubmittedCount),
    costSummary: createCostSummary(accumulator),
    slippageSummary: createSlippageSummary(accumulator.slippageBpsValues),
    pnlSummary: createPnlSummary(accumulator, pnlStartingCashKrw),
    blockingReasonCounts: sortCounts(accumulator.blockingReasonCounts),
    liveOrderApiCalls: 0,
  };
}

function createPnlSummary(accumulator: PaperDecisionMetricAccumulator, pnlStartingCashKrw: string) {
  try {
    return createPaperPnlSummary({
      startingCashKrw: pnlStartingCashKrw,
      submittedOrderCount: accumulator.paperOrderSubmittedCount,
      fills: accumulator.pnlFills,
      markPrices: [...accumulator.pnlMarkPricesByMarket.values()],
    });
  } catch (error) {
    if (!(error instanceof PaperPnlSummaryInvariantError)) {
      throw error;
    }

    // 초기 base 잔고 매도처럼 취득가가 없는 ledger는 runner를 죽이지 않고 손익 필드만 보류한다.
    return createUnavailablePaperPnlSummary({
      startingCashKrw: pnlStartingCashKrw,
      endingCashKrw: calculateCashAfterPnlFills(pnlStartingCashKrw, accumulator.pnlFills),
      totalFeesKrw: sumPnlFillFees(accumulator.pnlFills),
      submittedOrderCount: accumulator.paperOrderSubmittedCount,
      filledOrderCount: new Set(accumulator.pnlFills.map((fill) => fill.orderId)).size,
    });
  }
}

function calculateCashAfterPnlFills(startingCashKrw: string, fills: readonly PaperPnlFillInput[]): string {
  let cash = parseFinancialDecimal(startingCashKrw);
  for (const fill of fills) {
    const notional = parseFinancialDecimal(fill.totalFillNotional);
    const fee = parseFinancialDecimal(fill.totalFee ?? "0");
    cash = fill.side === "BUY" ? cash.minus(notional.plus(fee)) : cash.plus(notional.minus(fee));
  }

  return cash.toFixed();
}

function sumPnlFillFees(fills: readonly PaperPnlFillInput[]): string {
  return fills
    .reduce((sum, fill) => sum.plus(parseFinancialDecimal(fill.totalFee ?? "0")), new Decimal(0))
    .toFixed();
}

function createCostSummary(accumulator: PaperDecisionMetricAccumulator): PaperDecisionCostSummary {
  return {
    evaluatedCount: accumulator.costEvaluatedCount,
    allowedCount: accumulator.costAllowedCount,
    rejectedCount: accumulator.costRejectedCount,
    averageCostBps: averageDecimalStrings(accumulator.costBpsValues),
    averageRequiredReturnBps: averageDecimalStrings(accumulator.requiredReturnBpsValues),
    averageMarginBps: averageDecimalStrings(accumulator.marginBpsValues),
  };
}

function createSlippageSummary(values: readonly Decimal[]): PaperDecisionSlippageSummary {
  return {
    observedFillCount: values.length,
    averageSlippageBps: averageDecimalStrings(values),
    minSlippageBps: minDecimalString(values),
    maxSlippageBps: maxDecimalString(values),
  };
}

function calculateFillRate(fillCount: number, submittedCount: number): number {
  if (submittedCount === 0) {
    return 0;
  }

  return Number((fillCount / submittedCount).toFixed(6));
}

function averageDecimalStrings(values: readonly Decimal[]): string | null {
  if (values.length === 0) {
    return null;
  }

  const sum = values.reduce((accumulator, value) => accumulator.plus(value), new Decimal(0));
  return sum.div(values.length).toFixed();
}

function minDecimalString(values: readonly Decimal[]): string | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((minimum, value) => (value.lessThan(minimum) ? value : minimum), values[0]!).toFixed();
}

function maxDecimalString(values: readonly Decimal[]): string | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((maximum, value) => (value.greaterThan(maximum) ? value : maximum), values[0]!).toFixed();
}

function appendDecimal(target: Decimal[], value: unknown): void {
  const decimal = readDecimalValue(value);
  if (decimal !== undefined) {
    target.push(decimal);
  }
}

function appendPaperPnlFills(
  target: PaperPnlFillInput[],
  brokerOrder: BrokerOrder,
): void {
  if (brokerOrder.status === "REJECTED") {
    return;
  }

  const fillSimulation = readPaperFillSimulation(brokerOrder.metadata);
  const fills = Array.isArray(fillSimulation?.fills) ? fillSimulation.fills : [];
  for (const fill of fills) {
    const record = fill !== null && typeof fill === "object" && !Array.isArray(fill) ? (fill as JsonRecord) : undefined;
    const quantity = readStringRecordValue(record, "quantity");
    const notional = readStringRecordValue(record, "notional");
    if (quantity === undefined || notional === undefined) {
      continue;
    }

    const parsedQuantity = readDecimalValue(quantity);
    if (parsedQuantity === undefined || !parsedQuantity.greaterThan(0)) {
      continue;
    }

    target.push({
      orderId: brokerOrder.brokerOrderId,
      market: brokerOrder.market,
      side: brokerOrder.side,
      filledQuantity: quantity,
      totalFillNotional: notional,
      totalFee: readStringRecordValue(record, "fee") ?? "0",
      filledAt: brokerOrder.updatedAt,
    });
  }
}

function recordPnlMarkPrice(metrics: PaperDecisionMetricAccumulator, orderbook: OrderbookEvent): void {
  const bidPrice = readBestBidPrice(orderbook);
  if (bidPrice === undefined) {
    return;
  }

  metrics.pnlMarkPricesByMarket.set(orderbook.market, {
    market: orderbook.market,
    priceKrw: bidPrice,
    observedAt: orderbook.receivedAt,
    source: "orderbook_best_bid",
  });
}

function readBestBidPrice(orderbook: OrderbookEvent): string | undefined {
  let bestBid: Decimal | undefined;
  for (const level of orderbook.bids) {
    const price = readDecimalValue(level.price);
    if (price === undefined) {
      continue;
    }
    bestBid = bestBid === undefined || price.greaterThan(bestBid) ? price : bestBid;
  }

  return bestBid?.toFixed();
}

function readDecimalValue(value: unknown): Decimal | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return parseFinancialDecimal(value);
  } catch {
    return undefined;
  }
}

function readCostInput(
  frame: PaperDecisionInputFrame,
  costInputKey: keyof Pick<
    CostModelInput,
    | "expectedReturnBps"
    | "entryFeeBps"
    | "exitFeeBps"
    | "spreadCostBpsP75"
    | "expectedSlippageBpsP95"
    | "cancelRequotePenaltyBps"
    | "safetyBufferBps"
  >,
  featureKey: string,
): FinancialDecimalInput | undefined {
  const explicitValue = frame.costInput?.[costInputKey];
  if (explicitValue !== undefined) {
    return explicitValue;
  }

  const featureValue = frame.features[featureKey];
  return typeof featureValue === "string" ? featureValue : undefined;
}

function readStringFeature(frame: PaperDecisionInputFrame, key: string): string | undefined {
  const value = frame.features[key];

  return typeof value === "string" ? value : undefined;
}

function readDecisionReasonCode(decision: Awaited<ReturnType<Strategy["evaluate"]>>): string | undefined {
  if (decision.kind === "BLOCK") {
    return decision.reasonCode;
  }

  return decision.reason;
}

function readPaperFillSimulation(metadata: JsonRecord | undefined): JsonRecord | undefined {
  const value = metadata?.paper_fill_simulation;

  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function readStringRecordValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === "string" ? value : undefined;
}

function readRecordValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];

  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function increment(counts: MutableCounts, reasonCode: string): void {
  counts[reasonCode] = (counts[reasonCode] ?? 0) + 1;
}

function sortCounts(counts: MutableCounts): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function createTrace(
  frame: PaperDecisionInputFrame,
  stage: PaperDecisionRunnerTraceRecord["stage"],
  status: string,
  options: {
    strategyId?: string;
    reasonCode?: string;
    message?: string;
    metadata?: JsonRecord;
  } = {},
): PaperDecisionRunnerTraceRecord {
  const record: PaperDecisionRunnerTraceRecord = {
    frameId: frame.id,
    stage,
    status,
    observedAt: frame.observedAt,
  };

  assignIfDefined(record, "strategyId", options.strategyId);
  assignIfDefined(record, "reasonCode", options.reasonCode);
  assignIfDefined(record, "message", options.message);
  const metadata = createTraceMetadata(frame, options.metadata);
  assignIfDefined(record, "metadata", Object.keys(metadata).length > 0 ? metadata : undefined);

  return record;
}

/**
 * runner trace에 frame-local market/source context를 보강한다.
 *
 * ledger producer는 trace만 보고 market별 why summary를 만들기 때문에 모든 stage에 안전한 식별 context를 넣어도
 * broker나 외부 API side effect는 늘어나지 않는다.
 */
function createTraceMetadata(
  frame: PaperDecisionInputFrame,
  metadata: JsonRecord | undefined,
): JsonRecord {
  const traceMetadata: JsonRecord = {
    market: frame.market,
    exchange_id: frame.exchangeId,
    ...(metadata ?? {}),
  };
  assignIfDefined(traceMetadata, "source_id", readStringRecordValue(frame.metadata, "source_id"));
  return traceMetadata;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * 짧은 deterministic id 생성을 위한 비암호화 hash다.
 *
 * 보안 fingerprint가 아니라 같은 frame id 목록의 재실행 dedupe key를 안정화하는 용도이므로 외부 side effect가 없다.
 */
function stableHash(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(16).padStart(8, "0");
}
