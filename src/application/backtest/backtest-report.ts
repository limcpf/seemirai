import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  NumericString,
  OrderIntent,
  OrderLifecycleStatus,
  OrderSide,
  OrderType,
  TimestampInput,
} from "../../domain/index.js";
import type { PaperFillSimulationResult, PaperFillSimulationStatus } from "../execution/index.js";
import type { BacktestOrderCandidateResult, BacktestRunResult } from "./backtest-orchestrator.js";

export type BacktestReportCountMap = Readonly<Record<string, number>>;

export interface BacktestRunReportOptions {
  label: string;
  result: BacktestRunResult;
  generatedAt?: TimestampInput;
}

export interface BacktestRunReport {
  label: string;
  eventCount: number;
  strategyEvaluationCount: number;
  candidateCount: number;
  totals: BacktestReportTotals;
  strategySummaries: readonly BacktestStrategyReportSummary[];
  statusCounts: BacktestReportCountMap;
  fillStatusCounts: BacktestReportCountMap;
  rejectionReasonCounts: BacktestReportCountMap;
  generatedAt?: TimestampInput;
}

export type BacktestReportTotals = Omit<BacktestStrategyReportSummary, "strategyId">;

export interface BacktestStrategyReportSummary {
  strategyId: string;
  candidateCount: number;
  simulatedCount: number;
  rejectedCount: number;
  filledCount: number;
  partiallyFilledCount: number;
  unfilledCount: number;
  totalFilledQuantity: NumericString;
  totalFillNotional: NumericString;
  totalFee: NumericString;
  estimatedGrossPnlKrw: NumericString;
  estimatedCostKrw: NumericString;
  estimatedNetPnlKrw: NumericString;
  fillRate: NumericString;
  averageSlippageBps?: NumericString;
}

export interface BacktestCostComparisonInput {
  zeroCost: BacktestRunReport;
  costAware: BacktestRunReport;
}

export interface BacktestCostComparisonReport {
  zeroCostLabel: string;
  costAwareLabel: string;
  totalsDelta: BacktestReportDelta;
  perStrategyDelta: readonly BacktestStrategyReportDelta[];
  statusCountDelta: BacktestReportCountMap;
  fillStatusCountDelta: BacktestReportCountMap;
  rejectionReasonCountDelta: BacktestReportCountMap;
}

export interface BacktestReportDelta {
  candidateCountDelta: number;
  simulatedCountDelta: number;
  rejectedCountDelta: number;
  filledCountDelta: number;
  partiallyFilledCountDelta: number;
  unfilledCountDelta: number;
  totalFilledQuantityDelta: NumericString;
  totalFillNotionalDelta: NumericString;
  totalFeeDelta: NumericString;
  estimatedGrossPnlKrwDelta: NumericString;
  estimatedCostKrwDelta: NumericString;
  estimatedNetPnlKrwDelta: NumericString;
}

export interface BacktestStrategyReportDelta extends BacktestReportDelta {
  strategyId: string;
}

export interface BacktestPaperCandidateRecord {
  idempotencyKey: string;
  strategyId?: string;
  exchangeId: string;
  market: string;
  side: OrderSide;
  orderType: OrderType;
  requestedQuantity: NumericString;
  requestedPrice?: NumericString;
  lifecycleStatus?: OrderLifecycleStatus;
  fillStatus?: PaperFillSimulationStatus;
  fillReasonCode?: string;
  filledQuantity?: NumericString;
  remainingQuantity?: NumericString;
  totalFee?: NumericString;
  orderbookReceivedAt?: TimestampInput;
  slippageBps?: NumericString;
}

export interface BacktestPaperConsistencyInput {
  backtestCandidates: readonly BacktestPaperCandidateRecord[];
  paperCandidates: readonly BacktestPaperCandidateRecord[];
}

export interface BacktestPaperConsistencyReport {
  matches: boolean;
  backtestCandidateCount: number;
  paperCandidateCount: number;
  matchedCandidateCount: number;
  mismatches: readonly BacktestPaperConsistencyMismatch[];
}

export interface BacktestPaperConsistencyMismatch {
  idempotencyKey: string;
  field: string;
  backtestValue?: unknown;
  paperValue?: unknown;
}

interface MutableBacktestStrategyReportSummary extends BacktestStrategyReportSummary {
  slippageBpsSum: Decimal;
  slippageSampleCount: number;
}

const zero = new Decimal(0);

/**
 * Backtest run 결과를 전략별 거래 수, 체결률, 비용, 수수료, 추정 PnL 후보로 집계한다.
 *
 * 이 리포트는 외부 저장소나 broker를 호출하지 않고 `BacktestRunResult`만 접는다. 실제 투자 손익 확정값이 아니라
 * 같은 fixture에서 비용 설정 차이와 paper runtime 일관성을 검증하기 위한 결정적 요약이다.
 */
export function createBacktestRunReport(options: BacktestRunReportOptions): BacktestRunReport {
  const summaries = new Map<string, MutableBacktestStrategyReportSummary>();
  const totals = createMutableSummary("__totals__");
  const statusCounts: Record<string, number> = {};
  const fillStatusCounts: Record<string, number> = {};
  const rejectionReasonCounts: Record<string, number> = {};

  for (const candidate of options.result.candidates) {
    const strategySummary = getOrCreateSummary(summaries, candidate.strategyId);
    recordCandidate(strategySummary, candidate);
    recordCandidate(totals, candidate, fillStatusCounts, rejectionReasonCounts);
    incrementCount(statusCounts, candidate.status);
  }

  const strategySummaries = [...summaries.values()]
    .map(finalizeMutableSummary)
    .sort((left, right) => left.strategyId.localeCompare(right.strategyId));
  const finalizedTotals = finalizeMutableSummary(totals);
  const report: BacktestRunReport = {
    label: options.label,
    eventCount: options.result.events.length,
    strategyEvaluationCount: options.result.strategyEvaluations.length,
    candidateCount: options.result.candidates.length,
    totals: stripStrategyId(finalizedTotals),
    strategySummaries,
    statusCounts: sortCountMap(statusCounts),
    fillStatusCounts: sortCountMap(fillStatusCounts),
    rejectionReasonCounts: sortCountMap(rejectionReasonCounts),
  };

  if (options.generatedAt !== undefined) {
    report.generatedAt = options.generatedAt;
  }

  return report;
}

export function createBacktestCostComparisonReport(
  input: BacktestCostComparisonInput,
): BacktestCostComparisonReport {
  return {
    zeroCostLabel: input.zeroCost.label,
    costAwareLabel: input.costAware.label,
    totalsDelta: createReportDelta(input.zeroCost.totals, input.costAware.totals),
    perStrategyDelta: createPerStrategyDelta(input.zeroCost.strategySummaries, input.costAware.strategySummaries),
    statusCountDelta: createCountMapDelta(input.zeroCost.statusCounts, input.costAware.statusCounts),
    fillStatusCountDelta: createCountMapDelta(input.zeroCost.fillStatusCounts, input.costAware.fillStatusCounts),
    rejectionReasonCountDelta: createCountMapDelta(
      input.zeroCost.rejectionReasonCounts,
      input.costAware.rejectionReasonCounts,
    ),
  };
}

export function createBacktestPaperCandidateRecords(
  result: BacktestRunResult,
): readonly BacktestPaperCandidateRecord[] {
  return result.candidates
    .filter((candidate) => candidate.submission !== undefined && candidate.executionValidation?.valid === true)
    .map((candidate) => createBacktestPaperCandidateRecord(candidate));
}

export function createPaperBrokerCandidateRecords(
  orders: readonly BrokerOrder[],
): readonly BacktestPaperCandidateRecord[] {
  return orders.map(createPaperBrokerCandidateRecord);
}

/**
 * Backtest가 만든 broker 제출 후보와 paper runtime 주문 결과를 idempotency key 기준으로 비교한다.
 */
export function createBacktestPaperConsistencyReport(
  input: BacktestPaperConsistencyInput,
): BacktestPaperConsistencyReport {
  const backtestByKey = createCandidateMap(input.backtestCandidates);
  const paperByKey = createCandidateMap(input.paperCandidates);
  const mismatches: BacktestPaperConsistencyMismatch[] = [];
  let matchedCandidateCount = 0;

  // 같은 key가 여러 번 나오면 Map 비교가 덮어쓰기 때문에 먼저 명시적으로 실패시킨다.
  appendDuplicateCandidateKeyMismatches(mismatches, "backtest", input.backtestCandidates);
  appendDuplicateCandidateKeyMismatches(mismatches, "paper", input.paperCandidates);

  for (const [idempotencyKey, backtestCandidate] of backtestByKey) {
    const paperCandidate = paperByKey.get(idempotencyKey);
    if (paperCandidate === undefined) {
      mismatches.push({
        idempotencyKey,
        field: "paper_candidate",
        backtestValue: "present",
        paperValue: "missing",
      });
      continue;
    }

    matchedCandidateCount += 1;
    appendCandidateMismatches(mismatches, backtestCandidate, paperCandidate);
  }

  for (const [idempotencyKey] of paperByKey) {
    if (!backtestByKey.has(idempotencyKey)) {
      mismatches.push({
        idempotencyKey,
        field: "backtest_candidate",
        backtestValue: "missing",
        paperValue: "present",
      });
    }
  }

  return {
    matches: mismatches.length === 0,
    backtestCandidateCount: input.backtestCandidates.length,
    paperCandidateCount: input.paperCandidates.length,
    matchedCandidateCount,
    mismatches,
  };
}

function recordCandidate(
  summary: MutableBacktestStrategyReportSummary,
  candidate: BacktestOrderCandidateResult,
  fillStatusCounts?: Record<string, number>,
  rejectionReasonCounts?: Record<string, number>,
): void {
  summary.candidateCount += 1;
  if (candidate.status === "SIMULATED") {
    summary.simulatedCount += 1;
  } else {
    summary.rejectedCount += 1;
    for (const reasonCode of readRejectionReasonCodes(candidate)) {
      if (rejectionReasonCounts !== undefined) {
        incrementCount(rejectionReasonCounts, reasonCode);
      }
    }
  }

  if (candidate.fillResult === undefined) {
    return;
  }

  recordFillResult(summary, candidate);
  if (fillStatusCounts !== undefined) {
    incrementCount(fillStatusCounts, candidate.fillResult.status);
  }
}

function recordFillResult(
  summary: MutableBacktestStrategyReportSummary,
  candidate: BacktestOrderCandidateResult,
): void {
  const fillResult = candidate.fillResult;
  if (fillResult === undefined) {
    return;
  }

  if (fillResult.status === "FILLED") {
    summary.filledCount += 1;
  } else if (hasFilledQuantity(fillResult)) {
    summary.partiallyFilledCount += 1;
  } else {
    summary.unfilledCount += 1;
  }

  summary.totalFilledQuantity = addDecimalStrings(summary.totalFilledQuantity, fillResult.filledQuantity);
  if (fillResult.totalFillNotional !== undefined) {
    summary.totalFillNotional = addDecimalStrings(summary.totalFillNotional, fillResult.totalFillNotional);
    recordEstimatedPnl(summary, candidate, fillResult.totalFillNotional);
  }
  if (fillResult.totalFee !== undefined) {
    summary.totalFee = addDecimalStrings(summary.totalFee, fillResult.totalFee);
  }
  if (fillResult.slippageBps !== undefined) {
    summary.slippageBpsSum = summary.slippageBpsSum.add(parseFinancialDecimal(fillResult.slippageBps));
    summary.slippageSampleCount += 1;
  }
}

function recordEstimatedPnl(
  summary: MutableBacktestStrategyReportSummary,
  candidate: BacktestOrderCandidateResult,
  totalFillNotional: NumericString,
): void {
  const notional = parseFinancialDecimal(totalFillNotional);
  const expectedReturnBps = parseOptionalDecimal(candidate.costDecision.snapshot.expected_return_bps);
  const costBps = parseOptionalDecimal(candidate.costDecision.snapshot.cost_bps);
  const estimatedGrossPnl = notional.mul(expectedReturnBps).div(10000);
  const estimatedCost = notional.mul(costBps).div(10000);
  const estimatedNetPnl = estimatedGrossPnl.sub(estimatedCost);

  summary.estimatedGrossPnlKrw = addDecimalStrings(summary.estimatedGrossPnlKrw, estimatedGrossPnl.toFixed());
  summary.estimatedCostKrw = addDecimalStrings(summary.estimatedCostKrw, estimatedCost.toFixed());
  summary.estimatedNetPnlKrw = addDecimalStrings(summary.estimatedNetPnlKrw, estimatedNetPnl.toFixed());
}

function readRejectionReasonCodes(candidate: BacktestOrderCandidateResult): readonly string[] {
  switch (candidate.status) {
    case "COST_REJECTED":
      return [candidate.costDecision.reasonCode];
    case "RULE_REJECTED":
      return candidate.ruleResult?.failedEvaluations.map((evaluation) => evaluation.reasonCode) ?? [];
    case "RISK_REJECTED":
      return candidate.riskGateResult?.failedEvaluations.map((evaluation) => evaluation.reasonCode) ?? [];
    case "EXECUTION_REJECTED":
      return candidate.executionValidation?.valid === false ? [candidate.executionValidation.rejection.reasonCode] : [];
    case "SIMULATED":
      return [];
  }
}

function createBacktestPaperCandidateRecord(
  candidate: BacktestOrderCandidateResult,
): BacktestPaperCandidateRecord {
  const fillResult = candidate.fillResult;
  const record = createIntentCandidateRecord(candidate.intent);
  record.strategyId = candidate.strategyId;

  if (fillResult !== undefined) {
    record.lifecycleStatus = fillResult.orderStatus;
    record.fillStatus = fillResult.status;
    record.fillReasonCode = fillResult.reasonCode;
    record.filledQuantity = normalizeDecimalString(fillResult.filledQuantity);
    record.remainingQuantity = normalizeDecimalString(fillResult.openQuantity);
    if (fillResult.totalFee !== undefined) {
      record.totalFee = normalizeDecimalString(fillResult.totalFee);
    }
    if (fillResult.orderbookReceivedAt !== undefined) {
      record.orderbookReceivedAt = normalizeTimestampInput(fillResult.orderbookReceivedAt);
    }
    if (fillResult.slippageBps !== undefined) {
      record.slippageBps = normalizeDecimalString(fillResult.slippageBps);
    }
  }

  return record;
}

function createPaperBrokerCandidateRecord(order: BrokerOrder): BacktestPaperCandidateRecord {
  const record: BacktestPaperCandidateRecord = {
    idempotencyKey: order.idempotencyKey,
    exchangeId: order.exchangeId,
    market: order.market,
    side: order.side,
    orderType: order.orderType,
    requestedQuantity: normalizeDecimalString(order.requestedQuantity),
    lifecycleStatus: order.status,
    remainingQuantity: normalizeDecimalString(order.remainingQuantity),
  };
  if (order.requestedPrice !== undefined) {
    record.requestedPrice = normalizeDecimalString(order.requestedPrice);
  }

  const fillResult = readPaperFillSimulation(order);
  if (fillResult !== undefined) {
    record.fillStatus = fillResult.status;
    record.fillReasonCode = fillResult.reasonCode;
    record.filledQuantity = normalizeDecimalString(fillResult.filledQuantity);
    if (fillResult.totalFee !== undefined) {
      record.totalFee = normalizeDecimalString(fillResult.totalFee);
    }
    if (fillResult.orderbookReceivedAt !== undefined) {
      record.orderbookReceivedAt = normalizeTimestampInput(fillResult.orderbookReceivedAt);
    }
    if (fillResult.slippageBps !== undefined) {
      record.slippageBps = normalizeDecimalString(fillResult.slippageBps);
    }
  }

  return record;
}

function createIntentCandidateRecord(intent: OrderIntent): BacktestPaperCandidateRecord {
  const record: BacktestPaperCandidateRecord = {
    idempotencyKey: intent.idempotencyKey,
    exchangeId: intent.exchangeId,
    market: intent.market,
    side: intent.side,
    orderType: intent.orderType,
    requestedQuantity: normalizeDecimalString(intent.requestedQuantity),
  };
  if (intent.orderType === "LIMIT") {
    record.requestedPrice = normalizeDecimalString(intent.requestedPrice);
  }

  return record;
}

function appendCandidateMismatches(
  mismatches: BacktestPaperConsistencyMismatch[],
  backtestCandidate: BacktestPaperCandidateRecord,
  paperCandidate: BacktestPaperCandidateRecord,
): void {
  const fields: readonly (keyof BacktestPaperCandidateRecord)[] = [
    "exchangeId",
    "market",
    "side",
    "orderType",
    "requestedQuantity",
    "requestedPrice",
    "lifecycleStatus",
    "fillStatus",
    "fillReasonCode",
    "filledQuantity",
    "remainingQuantity",
    "totalFee",
    "orderbookReceivedAt",
    "slippageBps",
  ];

  for (const field of fields) {
    if (backtestCandidate[field] !== paperCandidate[field]) {
      mismatches.push({
        idempotencyKey: backtestCandidate.idempotencyKey,
        field,
        backtestValue: backtestCandidate[field],
        paperValue: paperCandidate[field],
      });
    }
  }
}

function createCandidateMap(
  candidates: readonly BacktestPaperCandidateRecord[],
): Map<string, BacktestPaperCandidateRecord> {
  const candidatesByKey = new Map<string, BacktestPaperCandidateRecord>();
  for (const candidate of candidates) {
    if (!candidatesByKey.has(candidate.idempotencyKey)) {
      candidatesByKey.set(candidate.idempotencyKey, candidate);
    }
  }

  return candidatesByKey;
}

function appendDuplicateCandidateKeyMismatches(
  mismatches: BacktestPaperConsistencyMismatch[],
  source: "backtest" | "paper",
  candidates: readonly BacktestPaperCandidateRecord[],
): void {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    incrementCount(counts, candidate.idempotencyKey);
  }

  const sortedCounts = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  for (const [idempotencyKey, count] of sortedCounts) {
    if (count <= 1) {
      continue;
    }

    mismatches.push({
      idempotencyKey,
      field: `${source}_duplicate_idempotency_key`,
      ...(source === "backtest" ? { backtestValue: count } : { paperValue: count }),
    });
  }
}

function readPaperFillSimulation(order: BrokerOrder): PaperFillSimulationResult | undefined {
  const simulation = order.metadata?.paper_fill_simulation;
  return isJsonRecord(simulation) && typeof simulation.status === "string"
    ? (simulation as unknown as PaperFillSimulationResult)
    : undefined;
}

function createMutableSummary(strategyId: string): MutableBacktestStrategyReportSummary {
  return {
    strategyId,
    candidateCount: 0,
    simulatedCount: 0,
    rejectedCount: 0,
    filledCount: 0,
    partiallyFilledCount: 0,
    unfilledCount: 0,
    totalFilledQuantity: "0",
    totalFillNotional: "0",
    totalFee: "0",
    estimatedGrossPnlKrw: "0",
    estimatedCostKrw: "0",
    estimatedNetPnlKrw: "0",
    fillRate: "0",
    slippageBpsSum: zero,
    slippageSampleCount: 0,
  };
}

function getOrCreateSummary(
  summaries: Map<string, MutableBacktestStrategyReportSummary>,
  strategyId: string,
): MutableBacktestStrategyReportSummary {
  const existingSummary = summaries.get(strategyId);
  if (existingSummary !== undefined) {
    return existingSummary;
  }

  const summary = createMutableSummary(strategyId);
  summaries.set(strategyId, summary);
  return summary;
}

function finalizeMutableSummary(summary: MutableBacktestStrategyReportSummary): BacktestStrategyReportSummary {
  const finalized: BacktestStrategyReportSummary = {
    strategyId: summary.strategyId,
    candidateCount: summary.candidateCount,
    simulatedCount: summary.simulatedCount,
    rejectedCount: summary.rejectedCount,
    filledCount: summary.filledCount,
    partiallyFilledCount: summary.partiallyFilledCount,
    unfilledCount: summary.unfilledCount,
    totalFilledQuantity: normalizeDecimalString(summary.totalFilledQuantity),
    totalFillNotional: normalizeDecimalString(summary.totalFillNotional),
    totalFee: normalizeDecimalString(summary.totalFee),
    estimatedGrossPnlKrw: normalizeDecimalString(summary.estimatedGrossPnlKrw),
    estimatedCostKrw: normalizeDecimalString(summary.estimatedCostKrw),
    estimatedNetPnlKrw: normalizeDecimalString(summary.estimatedNetPnlKrw),
    fillRate: calculateRate(summary.filledCount + summary.partiallyFilledCount, summary.simulatedCount),
  };

  if (summary.slippageSampleCount > 0) {
    finalized.averageSlippageBps = summary.slippageBpsSum.div(summary.slippageSampleCount).toFixed();
  }

  return finalized;
}

function stripStrategyId(summary: BacktestStrategyReportSummary): BacktestReportTotals {
  const { strategyId: _strategyId, ...totals } = summary;
  return totals;
}

function createReportDelta(
  zeroCost: BacktestReportTotals | BacktestStrategyReportSummary,
  costAware: BacktestReportTotals | BacktestStrategyReportSummary,
): BacktestReportDelta {
  return {
    candidateCountDelta: costAware.candidateCount - zeroCost.candidateCount,
    simulatedCountDelta: costAware.simulatedCount - zeroCost.simulatedCount,
    rejectedCountDelta: costAware.rejectedCount - zeroCost.rejectedCount,
    filledCountDelta: costAware.filledCount - zeroCost.filledCount,
    partiallyFilledCountDelta: costAware.partiallyFilledCount - zeroCost.partiallyFilledCount,
    unfilledCountDelta: costAware.unfilledCount - zeroCost.unfilledCount,
    totalFilledQuantityDelta: subtractDecimalStrings(costAware.totalFilledQuantity, zeroCost.totalFilledQuantity),
    totalFillNotionalDelta: subtractDecimalStrings(costAware.totalFillNotional, zeroCost.totalFillNotional),
    totalFeeDelta: subtractDecimalStrings(costAware.totalFee, zeroCost.totalFee),
    estimatedGrossPnlKrwDelta: subtractDecimalStrings(costAware.estimatedGrossPnlKrw, zeroCost.estimatedGrossPnlKrw),
    estimatedCostKrwDelta: subtractDecimalStrings(costAware.estimatedCostKrw, zeroCost.estimatedCostKrw),
    estimatedNetPnlKrwDelta: subtractDecimalStrings(costAware.estimatedNetPnlKrw, zeroCost.estimatedNetPnlKrw),
  };
}

function createPerStrategyDelta(
  zeroCostSummaries: readonly BacktestStrategyReportSummary[],
  costAwareSummaries: readonly BacktestStrategyReportSummary[],
): readonly BacktestStrategyReportDelta[] {
  const zeroByStrategy = new Map(zeroCostSummaries.map((summary) => [summary.strategyId, summary]));
  const costAwareByStrategy = new Map(costAwareSummaries.map((summary) => [summary.strategyId, summary]));
  const strategyIds = new Set([...zeroByStrategy.keys(), ...costAwareByStrategy.keys()]);
  const deltas: BacktestStrategyReportDelta[] = [];

  for (const strategyId of [...strategyIds].sort()) {
    const zeroSummary = zeroByStrategy.get(strategyId) ?? createEmptyFinalSummary(strategyId);
    const costAwareSummary = costAwareByStrategy.get(strategyId) ?? createEmptyFinalSummary(strategyId);
    deltas.push({
      strategyId,
      ...createReportDelta(zeroSummary, costAwareSummary),
    });
  }

  return deltas;
}

function createEmptyFinalSummary(strategyId: string): BacktestStrategyReportSummary {
  return finalizeMutableSummary(createMutableSummary(strategyId));
}

function createCountMapDelta(
  zeroCostCounts: BacktestReportCountMap,
  costAwareCounts: BacktestReportCountMap,
): BacktestReportCountMap {
  const keys = new Set([...Object.keys(zeroCostCounts), ...Object.keys(costAwareCounts)]);
  const delta: Record<string, number> = {};
  for (const key of [...keys].sort()) {
    delta[key] = (costAwareCounts[key] ?? 0) - (zeroCostCounts[key] ?? 0);
  }

  return delta;
}

function sortCountMap(counts: Record<string, number>): BacktestReportCountMap {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function calculateRate(numerator: number, denominator: number): NumericString {
  return denominator === 0 ? "0" : new Decimal(numerator).div(denominator).toFixed();
}

function addDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).add(parseFinancialDecimal(right)).toFixed();
}

function subtractDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).sub(parseFinancialDecimal(right)).toFixed();
}

function parseOptionalDecimal(value: NumericString | undefined): Decimal {
  return value === undefined ? zero : parseFinancialDecimal(value);
}

function hasFilledQuantity(fillResult: PaperFillSimulationResult): boolean {
  return parseFinancialDecimal(fillResult.filledQuantity).gt(0);
}

function normalizeDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).toFixed();
}

function normalizeTimestampInput(value: TimestampInput): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }

  return new Date(milliseconds).toISOString();
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
