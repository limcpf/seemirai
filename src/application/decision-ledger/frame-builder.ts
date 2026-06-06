import { createHash } from "node:crypto";
import { DECISION_LEDGER_VERSION } from "./types.js";
import type {
  DecisionLedgerFrame,
  DecisionEvidenceItem,
  DecisionLedgerJsonRecord,
} from "./types.js";
import type {
  DecisionFrameCategory,
  SummaryStatus,
  EvidenceKind,
} from "./category.js";
import type {
  PaperDecisionRunnerTraceRecord,
  PaperDecisionRunnerResult,
} from "../paper-decision-runner/types.js";

/**
 * runner trace record 하나를 decision ledger evidence item으로 변환하는 옵션이다.
 */
export interface BuildEvidenceOptions {
  /** 상위 frame의 dedupe key. evidence fingerprint prefix로 사용한다. */
  readonly frameDedupeKey: string;
  /** evidence를 발생시킨 frame의 입력 식별자. */
  readonly sourceFrameId: string;
  /** 같은 frame+direction 내에서 이 evidence의 발생 순서 index. */
  readonly stageOccurrenceIndex: number;
}

/**
 * runner 완료 결과에서 frame-builder가 판단하는 frame 범주를 산출하는 입력이다.
 */
export interface BuildFrameCategoryInput {
  /** category를 판정할 strategy flow id. cash/global flow이면 null이다. */
  readonly strategyId: string | null;
  readonly trace: readonly PaperDecisionRunnerTraceRecord[];
  readonly holdReasonCounts: Readonly<Record<string, number>>;
  readonly discardReasonCounts: Readonly<Record<string, number>>;
  readonly costRejectedCount: number;
  readonly riskRejectedCount: number;
  readonly executionRejectedCount: number;
  readonly paperOrderSubmittedCount: number;
  readonly paperFillCount: number;
}

/**
 * frame builder가 runner trace와 metric을 분석해 결정한 frame 범주와 summary status다.
 */
export interface FrameCategoryResult {
  /** frame 판단 범주. */
  readonly category: DecisionFrameCategory;
  /** frame 기록 상태. */
  readonly summaryStatus: SummaryStatus;
}

/**
 * runner trace와 blocking/차단 metric을 보고 frame category와 summaryStatus를 결정한다.
 *
 * 이 함수는 순수 판단 함수이며 DB나 외부 side effect가 없다. 판단 우선순위는
 * 실행 성공 > 실행 거부 > 리스크 차단 > 비용 차단 > discard > strategy HOLD > cash HOLD 순이다.
 *
 * @param input frame 범주 판단 입력
 * @returns frame category와 summary status
 */
export function resolveFrameCategory(input: BuildFrameCategoryInput): FrameCategoryResult {
  // 실행 단계 결과가 있으면 가장 강한 신호다.
  if (input.paperFillCount > 0) {
    return { category: "EXECUTED", summaryStatus: "RECORDED" };
  }

  if (input.executionRejectedCount > 0) {
    // 실행 경계에서 검증/브로커 거부가 확인되면 이전 BUY/SELL 판단으로 되돌리지 않는다.
    return { category: "EXECUTION_REJECTED", summaryStatus: "RECORDED" };
  }

  if (input.riskRejectedCount > 0) {
    return { category: "RISK_REJECTED", summaryStatus: "RECORDED" };
  }

  if (input.costRejectedCount > 0) {
    return { category: "COST_REJECTED", summaryStatus: "RECORDED" };
  }

  const discardKeys = Object.keys(input.discardReasonCounts);
  if (discardKeys.length > 0) {
    return { category: "DISCARD", summaryStatus: "RECORDED" };
  }

  const holdKeys = Object.keys(input.holdReasonCounts);
  if (holdKeys.length > 0) {
    const hasOnlyHold = input.trace.every(
      (record) =>
        record.stage !== "STRATEGY_DECISION" ||
        record.status === "HOLD",
    );
    if (input.strategyId === null && hasOnlyHold) {
      // cash/global flow만 CASH_HOLD로 올려 strategy HOLD와 운영상 현금 보유 상태를 섞지 않는다.
      return { category: "CASH_HOLD", summaryStatus: "RECORDED" };
    }
    return { category: "HOLD", summaryStatus: "RECORDED" };
  }

  // BUY/SELL 판단이 있었지만 비용/리스크/실행을 모두 통과하지 못한 경우
  const strategyDecisionTrace = input.trace.filter(
    (record) => record.stage === "STRATEGY_DECISION",
  );
  if (strategyDecisionTrace.length > 0) {
    const lastDecision = strategyDecisionTrace[strategyDecisionTrace.length - 1]!;
    if (lastDecision.status === "BUY" || lastDecision.status === "SELL") {
      return {
        category: lastDecision.status as DecisionFrameCategory,
        summaryStatus: "RECORDED",
      };
    }
    if (lastDecision.status === "ORDER_INTENT") {
      return {
        category: resolveConversionDirection(lastDecision),
        summaryStatus: "RECORDED",
      };
    }
  }

  // 아무 판단도 없으면 CASH_HOLD
  return { category: "CASH_HOLD", summaryStatus: "RECORDED" };
}

/**
 * runner trace record의 stage를 evidence kind로 매핑한다.
 *
 * 순수 매핑 함수이며 외부 side effect가 없다.
 */
function mapTraceStageToEvidenceKind(
  record: PaperDecisionRunnerTraceRecord,
): EvidenceKind | null {
  switch (record.stage) {
    case "STRATEGY_DECISION":
      return "STRATEGY_DECISION";
    case "ORDER_INTENT_CONVERSION":
      // conversion 단계에서 reject되면 DISCARD_REASON, 성공이면 ORDER_INTENT
      if (record.status === "REJECTED" || record.status === "DISCARDED") {
        return "DISCARD_REASON";
      }
      return "ORDER_INTENT";
    case "COST_DECISION":
      return "COST_BREAKDOWN";
    case "RISK_DECISION":
      return "RISK_DECISION";
    case "EXECUTION_RESULT":
      return "EXECUTION_RESULT";
    default:
      return null;
  }
}

/**
 * trace record의 status와 metadata에서 decision category를 결정한다.
 *
 * **ORDER_INTENT_CONVERSION 분기 수정**: reasonCode(`order_intent_promoted` 등)를
 * BUY/SELL 방향으로 사용하지 않고, trace metadata의 `intent_directions` 배열에서
 * 실제 order intent의 side를 읽어 category로 사용한다. direction을 알 수 없으면
 * HOLD로 낮춰 추정하지 않는다.
 */
function mapTraceStatusToCategory(
  record: PaperDecisionRunnerTraceRecord,
): DecisionFrameCategory {
  switch (record.stage) {
    case "STRATEGY_DECISION": {
      const status = record.status;
      if (status === "BUY" || status === "SELL") {
        return status;
      }
      if (status === "HOLD") {
        return "HOLD";
      }
      if (status === "ORDER_INTENT") {
        return resolveConversionDirection(record);
      }
      if (status === "BLOCK") {
        return "DISCARD";
      }
      return "DISCARD";
    }
    case "ORDER_INTENT_CONVERSION":
      // conversion 거부는 DISCARD
      if (record.status === "REJECTED" || record.status === "DISCARDED") {
        return "DISCARD";
      }
      // intent_directions metadata에서 실제 방향을 읽는다.
      // reasonCode("order_intent_promoted" 등)는 방향이 아니므로 사용하지 않는다.
      return resolveConversionDirection(record);
    case "COST_DECISION":
      return isCostRejected(record) ? "COST_REJECTED" : resolveTraceIntentSide(record);
    case "RISK_DECISION":
      return isRiskRejected(record) ? "RISK_REJECTED" : resolveTraceIntentSide(record);
    case "EXECUTION_RESULT":
      if (isExecutionRejected(record)) {
        return "EXECUTION_REJECTED";
      }
      if (record.status === "FILLED" || isPositiveQuantity(record.metadata?.filled_quantity)) {
        return "EXECUTED";
      }
      return resolveTraceIntentSide(record);
    default:
      return "HOLD";
  }
}

/**
 * trace metadata에 보존된 주문 방향을 evidence category로 복원한다.
 *
 * 방향을 알 수 없으면 BUY로 추정하지 않고 HOLD로 낮춰, SELL 근거를 매수 근거로 오표시하지 않는다.
 */
function resolveTraceIntentSide(
  record: PaperDecisionRunnerTraceRecord,
): DecisionFrameCategory {
  const side = record.metadata?.intent_side;
  if (side === "BUY" || side === "SELL") {
    return side;
  }
  return "HOLD";
}

/**
 * ORDER_INTENT_CONVERSION trace record에서 실제 intent 방향을 추출한다.
 *
 * metadata.intent_directions 배열에서 첫 번째 BUY 또는 SELL을 찾아 반환한다.
 * 방향 정보가 없으면 HOLD로 낮춰 추정하지 않는다. (handoff "ORDER_INTENT_CONVERSION
 * category가 실제 converter reason code(order_intent_promoted)를 고려하지 않아
 * 대부분 SELL로 오분류된다" 수정)
 */
function resolveConversionDirection(
  record: PaperDecisionRunnerTraceRecord,
): DecisionFrameCategory {
  const directions = record.metadata?.intent_directions;
  if (Array.isArray(directions) && directions.length > 0) {
    const firstDirection = directions[0];
    if (firstDirection === "BUY" || firstDirection === "SELL") {
      return firstDirection;
    }
  }

  // 방향을 알 수 없으면 BUY/SELL로 추정하지 않고 HOLD로 낮춘다.
  return "HOLD";
}

/**
 * runner trace record 하나를 DecisionEvidenceItem으로 변환한다.
 *
 * 이 함수는 순수 변환 함수이며 DB나 외부 side effect가 없다.
 *
 * **fingerprint 충돌 방지**: 같은 frame/stage에서 여러 strategy/order intent가
 * evidence를 만들 때 fingerprint가 충돌하지 않도록 `stageOccurrenceIndex`를
 * seed에 포함한다. strategyId도 prefix에 포함해 전략별 evidence를 구분한다.
 *
 * @param record runner trace record
 * @param options evidence 빌드 옵션
 * @returns DecisionEvidenceItem 또는 변환 대상이 아니면 null
 */
export function buildEvidenceItem(
  record: PaperDecisionRunnerTraceRecord,
  options: BuildEvidenceOptions,
): DecisionEvidenceItem | null {
  const rawEvidenceKind = mapTraceStageToEvidenceKind(record);
  if (rawEvidenceKind === null) {
    return null;
  }
  // EXPLANATION_FAILURE evidence는 별도 contract로 처리하므로 일반 evidence build에서 제외한다.
  if (rawEvidenceKind === "EXPLANATION_FAILURE") {
    return null;
  }
  const evidenceKind = rawEvidenceKind as Exclude<EvidenceKind, "EXPLANATION_FAILURE">;

  const category = mapTraceStatusToCategory(record);
  const occurredAt =
    typeof record.observedAt === "string"
      ? new Date(record.observedAt)
      : record.observedAt instanceof Date
        ? record.observedAt
        : new Date(record.observedAt as unknown as string);

  const message = record.message ?? toDefaultEvidenceMessage(evidenceKind, category);
  const reasonCode = record.reasonCode ?? null;
  const source = record.strategyId ?? "paper-decision-runner";
  const sourceId = record.strategyId ?? record.frameId;

  // fingerprint seed에 strategyId + reason/order scope + stage 발생 순서 index를 포함해
  // 같은 frame/stage의 다중 evidence가 충돌하지 않게 한다.
  const strategyPart = record.strategyId ?? "no-strategy";
  const stableMetadataPart = resolveStableEvidenceMetadataPart(record);
  const fingerprintSeed =
    `${options.frameDedupeKey}:evidence:${strategyPart}:${record.stage}:${record.frameId}:${record.reasonCode ?? "no-reason"}:${stableMetadataPart}:${options.stageOccurrenceIndex}`;
  const evidenceFingerprint = simpleHash(fingerprintSeed);

  const payload: DecisionLedgerJsonRecord = {
    stage: record.stage,
    status: record.status,
    frameId: record.frameId,
    ...(record.metadata ?? {}),
  };

  const trace: DecisionLedgerJsonRecord = {
    frameId: record.frameId,
    stage: record.stage,
    stageOccurrenceIndex: options.stageOccurrenceIndex,
    ...(record.strategyId ? { strategyId: record.strategyId } : {}),
    dedupeKeyPrefix: options.frameDedupeKey,
  };

  return {
    evidenceKind,
    category,
    reasonCode,
    userMessage: message,
    impact: null,
    action: null,
    occurredAt,
    source,
    sourceId,
    payload,
    evidenceFingerprint,
    trace,
  };
}

/**
 * evidence kind와 category로 기본 사용자 메시지를 생성한다.
 */
function toDefaultEvidenceMessage(
  evidenceKind: EvidenceKind,
  _category: DecisionFrameCategory,
): string {
  switch (evidenceKind) {
    case "STRATEGY_DECISION":
      return "전략 판단이 생성되었습니다.";
    case "ORDER_INTENT":
      return "주문 후보가 생성되었습니다.";
    case "DISCARD_REASON":
      return "주문 후보가 폐기되었습니다.";
    case "COST_BREAKDOWN":
      return "비용 평가가 완료되었습니다.";
    case "RISK_DECISION":
      return "리스크 평가가 완료되었습니다.";
    case "EXECUTION_RESULT":
      return "실행 결과가 기록되었습니다.";
    case "PNL_STATUS_CONTEXT":
      return "PnL 상태 context입니다.";
    case "EXPLANATION_SUMMARY":
      return "설명 요약입니다.";
    case "EXPLANATION_FAILURE":
      return "설명 생성이 실패했습니다.";
  }
}

/**
 * runner trace record 그룹(frameId + strategy flow 단위)을 하나의 DecisionLedgerFrame으로 변환한다.
 *
 * 한 input frame에서 여러 strategy가 평가되면 strategy별 why summary가 섞이지 않도록 서로 다른 flow로 분리한다.
 * strategy가 없는 frame-level record는 strategy context로 복제하거나 별도 no-strategy flow로 보존한다.
 */
interface TraceFlowGroup {
  frameId: string;
  strategyId: string | null;
  trace: PaperDecisionRunnerTraceRecord[];
  evidenceTrace?: readonly PaperDecisionRunnerTraceRecord[];
}

/**
 * group-local reason count 묶음이다.
 *
 * runner 전체 metric을 복사하지 않고 해당 flow trace에서만 hold/discard/cost/risk/execution 사유를 재구성한다.
 */
interface GroupReasonCounts {
  readonly reasonCounts: Record<string, number>;
  readonly holdReasonCounts: Record<string, number>;
  readonly discardReasonCounts: Record<string, number>;
}

/**
 * runner 결과 전체를 frame+strategy flow 기준으로 그룹화해 DecisionLedgerFrame과 DecisionEvidenceItem 목록으로 변환한다.
 *
 * **다중 frame producer**: 각 input frame의 trace record를 frameId로 그룹화하고,
 * frame 내부에서는 strategyId별 flow로 다시 나눈다. 더 이상 첫 trace record의 frame id나
 * 첫 strategy id로 전체 결과를 접지 않는다.
 *
 * @param result runner 실행 결과
 * @param sourceRunId runner 실행 단위 식별자
 * @param exchange 거래소 식별자 (예: "UPBIT")
 * @param options 추가 옵션
 * @returns frameId별 DecisionLedgerFrame과 DecisionEvidenceItem 목록
 */
export function buildDecisionLedgerFromRunnerResult(
  result: PaperDecisionRunnerResult,
  sourceRunId: string,
  exchange: string,
  options: {
    /** frame dedupe key prefix. 기본값은 exchange + sourceRunId */
    readonly dedupeKeyPrefix?: string;
  } = {},
): {
  readonly frames: readonly {
    readonly frame: DecisionLedgerFrame;
    readonly evidenceItems: readonly DecisionEvidenceItem[];
  }[];
} {
  // trace를 frame+strategy flow 기준으로 그룹화해 다중 strategy why summary가 서로 덮이지 않게 한다.
  const traceGroups = groupTraceByFrameAndStrategy(result.trace);
  const dedupeKeyPrefix = options.dedupeKeyPrefix ?? `${exchange}:${sourceRunId}`;

  // 각 flow group을 별도 DecisionLedgerFrame으로 변환한다.
  const frames = traceGroups.map((group) => {
    // group-local metric을 trace record에서 계산한다.
    // runner 전체 metric을 모든 frame에 복사하지 않고, 해당 frame trace에서만 판단한다.
    const groupMetric = computeGroupMetric(group.trace);
    const groupReasonCounts = computeGroupReasonCounts(group.trace);
    const categoryResult = resolveFrameCategory({
      strategyId: group.strategyId,
      trace: group.trace,
      holdReasonCounts: groupReasonCounts.holdReasonCounts,
      discardReasonCounts: groupReasonCounts.discardReasonCounts,
      costRejectedCount: groupMetric.costRejectedCount,
      riskRejectedCount: groupMetric.riskRejectedCount,
      executionRejectedCount: groupMetric.executionRejectedCount,
      paperOrderSubmittedCount: groupMetric.paperOrderSubmittedCount,
      paperFillCount: groupMetric.paperFillCount,
    });

    const observedAt = resolveObservedAt(group.trace);
    const decisionAt = new Date();
    const sourceFrameId = group.frameId;
    const market = resolveMarket(group.trace);
    const strategyId = group.strategyId;
    const correlationId = resolveCorrelationId(group.trace);
    const dedupeKey = buildFrameDedupeKey(dedupeKeyPrefix, sourceFrameId, strategyId);

    const traceJson: DecisionLedgerJsonRecord = {
      framesProcessed: result.framesProcessed,
      totalTraceRecords: result.trace.length,
      frameTraceRecords: group.trace.length,
      sourceRunId,
      flowGrain: "sourceFrameId+strategyId",
      ...(market !== null ? { resolvedMarket: market } : {}),
      ...(strategyId !== null ? { resolvedStrategyId: strategyId } : {}),
      ...(correlationId !== null ? { resolvedCorrelationId: correlationId } : {}),
    };

    const baseFrame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
      sourceRunId,
      sourceFrameId,
      exchange,
      market,
      strategyId,
      category: categoryResult.category,
      summaryStatus: categoryResult.summaryStatus,
      observedAt,
      decisionAt,
      reasonCounts: groupReasonCounts.reasonCounts,
      dedupeKey,
    } as const;

    const frame: DecisionLedgerFrame = correlationId === null
      ? {
          ...baseFrame,
          correlationId: null as null,
          trace: {
            ...traceJson,
            sourceRunUnavailableReason:
              "runner 실행 단위 식별자가 제공되지 않았습니다.",
            correlationUnavailableReason:
              "주문 후보 0건 또는 correlation id 미생성",
          },
        }
      : {
          ...baseFrame,
          correlationId,
          trace: traceJson,
        };

    // evidence items: trace에서 추출하되 stage occurrence index를 부여한다.
    const stageCounts = new Map<string, number>();
    const evidenceItems: DecisionEvidenceItem[] = [];

    for (const record of group.evidenceTrace ?? group.trace) {
      const stageKey = record.stage;
      const currentIndex = stageCounts.get(stageKey) ?? 0;
      stageCounts.set(stageKey, currentIndex + 1);

      const item = buildEvidenceItem(record, {
        frameDedupeKey: dedupeKey,
        sourceFrameId,
        stageOccurrenceIndex: currentIndex,
      });
      if (item !== null) {
        evidenceItems.push(item);
      }
    }

    return { frame, evidenceItems };
  });

  return { frames };
}

/**
 * trace record를 frameId와 strategy flow 기준으로 그룹화한다.
 *
 * `FRAME_RECEIVED` 같은 frame-level context는 각 strategy flow에 복제한다. strategy가 없는
 * non-context record는 단일 strategy frame이면 그 flow에 포함하고, 다중 strategy frame이면 no-strategy flow로 남긴다.
 */
function groupTraceByFrameAndStrategy(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): readonly TraceFlowGroup[] {
  const groups = new Map<string, PaperDecisionRunnerTraceRecord[]>();

  for (const record of trace) {
    const existing = groups.get(record.frameId);
    if (existing === undefined) {
      groups.set(record.frameId, [record]);
    } else {
      existing.push(record);
    }
  }

  return [...groups.entries()].flatMap(([frameId, frameTrace]) =>
    groupSingleFrameTrace(frameId, frameTrace),
  );
}

/**
 * 단일 input frame trace를 strategy별 flow로 나눈다.
 *
 * strategyId가 없는 frame context는 각 strategy flow의 observedAt/source 근거로 복제하지만, 다중 strategy에서
 * strategyId가 누락된 non-context record는 임의 strategy에 붙이지 않아 why summary 오염을 막는다.
 */
function groupSingleFrameTrace(
  frameId: string,
  frameTrace: readonly PaperDecisionRunnerTraceRecord[],
): readonly TraceFlowGroup[] {
  const strategyIds = collectStrategyIds(frameTrace);
  if (strategyIds.length === 0) {
    return [{ frameId, strategyId: null, trace: [...frameTrace] }];
  }

  const contextRecords = frameTrace.filter((record) => record.strategyId === undefined && record.stage === "FRAME_RECEIVED");
  const ambiguousRecords = frameTrace.filter((record) => record.strategyId === undefined && record.stage !== "FRAME_RECEIVED");
  const includeAmbiguousInStrategy = strategyIds.length === 1;
  const flowGroups: TraceFlowGroup[] = [];

  for (const strategyId of strategyIds) {
    const flowTrace = frameTrace.filter(
      (record) =>
        record.strategyId === strategyId ||
        (record.strategyId === undefined &&
          (record.stage === "FRAME_RECEIVED" || includeAmbiguousInStrategy)),
    );
    flowGroups.push({ frameId, strategyId, trace: flowTrace });
  }

  if (!includeAmbiguousInStrategy && ambiguousRecords.length > 0) {
    // 다중 strategy frame에서 strategyId가 없는 stage record는 임의 strategy로 귀속하지 않고 별도 flow로 남긴다.
    flowGroups.push({ frameId, strategyId: null, trace: [...contextRecords, ...ambiguousRecords] });
  }

  if (shouldCreateCashHoldAggregate(frameTrace, strategyIds)) {
    // 모든 strategy가 HOLD만 냈을 때 cash summary용 aggregate frame을 별도로 남겨 strategy별 HOLD와 CASH_HOLD를 분리한다.
    flowGroups.push({
      frameId,
      strategyId: null,
      trace: createCashHoldAggregateTrace(frameTrace),
      evidenceTrace: [],
    });
  }

  return flowGroups;
}

/**
 * 한 input frame의 모든 strategy가 주문 후보 없이 HOLD로 끝났는지 판정한다.
 *
 * 이 경우 strategy별 frame은 `HOLD`로 유지하고, `/status.why.cash`가 읽을 no-strategy aggregate frame을 추가한다.
 */
function shouldCreateCashHoldAggregate(
  frameTrace: readonly PaperDecisionRunnerTraceRecord[],
  strategyIds: readonly string[],
): boolean {
  if (strategyIds.length === 0) {
    return false;
  }

  const strategyDecisionRecords = frameTrace.filter(
    (record) => record.stage === "STRATEGY_DECISION",
  );
  if (strategyDecisionRecords.length === 0) {
    return false;
  }

  const everyStrategyHeld = strategyIds.every((strategyId) =>
    strategyDecisionRecords.some(
      (record) => record.strategyId === strategyId && record.status === "HOLD",
    ),
  );
  const hasNonHoldStrategyDecision = strategyDecisionRecords.some(
    (record) => record.status !== "HOLD",
  );
  const hasDownstreamTradeStage = frameTrace.some((record) =>
    record.stage === "ORDER_INTENT_CONVERSION" ||
    record.stage === "COST_DECISION" ||
    record.stage === "RISK_DECISION" ||
    record.stage === "EXECUTION_RESULT",
  );

  return everyStrategyHeld && !hasNonHoldStrategyDecision && !hasDownstreamTradeStage;
}

/**
 * cash/global HOLD summary용 trace를 만든다.
 *
 * strategy 판단 record는 reason count 산출용으로만 재사용하고 evidence는 중복 저장하지 않는다.
 */
function createCashHoldAggregateTrace(
  frameTrace: readonly PaperDecisionRunnerTraceRecord[],
): PaperDecisionRunnerTraceRecord[] {
  return frameTrace.filter(
    (record) =>
      record.stage === "FRAME_RECEIVED" ||
      (record.stage === "STRATEGY_DECISION" && record.status === "HOLD"),
  );
}

/**
 * trace에 등장한 strategy id를 최초 등장 순서로 수집한다.
 *
 * 이 순서는 ledger frame 생성 순서와 테스트 fixture의 비교 가능성을 유지하는 deterministic ordering이다.
 */
function collectStrategyIds(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): readonly string[] {
  const strategyIds: string[] = [];
  for (const record of trace) {
    if (record.strategyId !== undefined && !strategyIds.includes(record.strategyId)) {
      strategyIds.push(record.strategyId);
    }
  }
  return strategyIds;
}

/**
 * group-local metric을 trace record에서 계산한다.
 *
 * runner 전체 metric을 모든 frame에 복사하지 않고, 해당 frame trace에 포함된
 * COST_DECISION, RISK_DECISION, EXECUTION_RESULT record만으로 per-frame metric을 만든다.
 * 이 함수는 순수 계산 함수이며 외부 side effect가 없다.
 */
interface PerFrameMetric {
  costRejectedCount: number;
  riskRejectedCount: number;
  executionRejectedCount: number;
  paperOrderSubmittedCount: number;
  paperFillCount: number;
}

function computeGroupMetric(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): PerFrameMetric {
  let costRejectedCount = 0;
  let riskRejectedCount = 0;
  let executionRejectedCount = 0;
  let paperOrderSubmittedCount = 0;
  let paperFillCount = 0;

  for (const record of trace) {
    switch (record.stage) {
      case "COST_DECISION": {
        // metadata.trade_allowed=false 또는 REJECT status는 해당 flow의 비용 차단이다.
        if (isCostRejected(record)) {
          costRejectedCount += 1;
        }
        break;
      }
      case "RISK_DECISION": {
        // metadata.approved=false 또는 FAIL/REJECTED status는 해당 flow의 리스크 차단이다.
        if (isRiskRejected(record)) {
          riskRejectedCount += 1;
        }
        break;
      }
      case "EXECUTION_RESULT": {
        if (isExecutionRejected(record)) {
          executionRejectedCount += 1;
        }
        // SUBMITTED 또는 FILLED 상태이면 paper order가 제출된 것으로 센다.
        if (record.status === "SUBMITTED" || record.status === "FILLED") {
          paperOrderSubmittedCount += 1;
          // filled_quantity가 명시적으로 0보다 크면 paper fill로 센다.
          if (isPositiveQuantity(record.metadata?.filled_quantity)) {
            paperFillCount += 1;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    costRejectedCount,
    riskRejectedCount,
    executionRejectedCount,
    paperOrderSubmittedCount,
    paperFillCount,
  };
}

/**
 * flow trace에서 group-local reasonCounts를 재구성한다.
 *
 * runner 전체 blocking metric을 재사용하지 않고, why summary에 노출할 raw reason code만 담아 다른 frame/strategy의
 * 차단 사유가 현재 flow에 섞이지 않게 한다.
 */
function computeGroupReasonCounts(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): GroupReasonCounts {
  const reasonCounts: Record<string, number> = {};
  const holdReasonCounts: Record<string, number> = {};
  const discardReasonCounts: Record<string, number> = {};

  for (const record of trace) {
    switch (record.stage) {
      case "STRATEGY_DECISION": {
        if (record.status === "HOLD") {
          const reason = record.reasonCode ?? "unknown_hold";
          incrementReason(holdReasonCounts, reason);
          incrementReason(reasonCounts, reason);
        } else if (record.status === "BLOCK") {
          const reason = record.reasonCode ?? "strategy_blocked";
          incrementReason(discardReasonCounts, reason);
          incrementReason(reasonCounts, reason);
        }
        break;
      }
      case "ORDER_INTENT_CONVERSION": {
        if (record.status === "REJECTED" || record.status === "DISCARDED") {
          const reason = record.reasonCode ?? "order_intent_discarded";
          incrementReason(discardReasonCounts, reason);
          incrementReason(reasonCounts, reason);
        }
        break;
      }
      case "COST_DECISION": {
        if (isCostRejected(record)) {
          incrementReason(reasonCounts, record.reasonCode ?? "cost_rejected");
        }
        break;
      }
      case "RISK_DECISION": {
        if (isRiskRejected(record)) {
          const failedReasons = readStringArray(record.metadata?.failed_reason_codes);
          if (failedReasons.length > 0) {
            for (const reason of failedReasons) {
              incrementReason(reasonCounts, reason);
            }
          } else {
            incrementReason(reasonCounts, record.reasonCode ?? "risk_rejected");
          }
        }
        break;
      }
      case "EXECUTION_RESULT": {
        if (isExecutionRejected(record)) {
          const reason = record.reasonCode ?? "execution_rejected";
          incrementReason(discardReasonCounts, reason);
          incrementReason(reasonCounts, reason);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    reasonCounts: sortRecord(reasonCounts),
    holdReasonCounts: sortRecord(holdReasonCounts),
    discardReasonCounts: sortRecord(discardReasonCounts),
  };
}

/**
 * trace record에서 가장 이른 observedAt을 찾는다.
 */
function resolveObservedAt(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): Date {
  if (trace.length === 0) {
    return new Date();
  }

  const firstRecord = trace[0]!;
  if (firstRecord.observedAt instanceof Date) {
    return firstRecord.observedAt;
  }
  if (typeof firstRecord.observedAt === "string") {
    return new Date(firstRecord.observedAt);
  }
  return new Date(firstRecord.observedAt as unknown as string);
}

/**
 * trace record에서 market을 추출한다.
 */
function resolveMarket(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): string | null {
  for (const record of trace) {
    if (record.metadata?.market !== undefined && typeof record.metadata.market === "string") {
      return record.metadata.market;
    }
  }
  return null;
}

/**
 * trace record에서 실행 correlation id를 추출한다.
 */
function resolveCorrelationId(
  trace: readonly PaperDecisionRunnerTraceRecord[],
): string | null {
  for (const record of trace) {
    if (
      record.stage === "EXECUTION_RESULT" &&
      record.metadata?.broker_order_id !== undefined &&
      typeof record.metadata.broker_order_id === "string"
    ) {
      return record.metadata.broker_order_id;
    }
  }
  return null;
}

/**
 * source run, input frame, strategy flow가 같은 재실행을 하나의 ledger frame으로 묶는 dedupe key를 만든다.
 */
function buildFrameDedupeKey(
  dedupeKeyPrefix: string,
  sourceFrameId: string,
  strategyId: string | null,
): string {
  return `${dedupeKeyPrefix}:frame:${sourceFrameId}:strategy:${strategyId ?? "no-strategy"}`;
}

/**
 * 비용 stage record가 해당 flow의 비용 차단을 의미하는지 판정한다.
 */
function isCostRejected(record: PaperDecisionRunnerTraceRecord): boolean {
  return record.metadata?.trade_allowed === false || record.status === "REJECT" || record.status === "REJECTED";
}

/**
 * 리스크 stage record가 해당 flow의 RiskGate 차단을 의미하는지 판정한다.
 */
function isRiskRejected(record: PaperDecisionRunnerTraceRecord): boolean {
  return record.metadata?.approved === false || record.status === "FAIL" || record.status === "REJECTED";
}

/**
 * 실행 stage record가 validation/broker 실행 거부를 의미하는지 판정한다.
 */
function isExecutionRejected(record: PaperDecisionRunnerTraceRecord): boolean {
  return record.status === "REJECTED" || record.metadata?.broker_order_status === "REJECTED";
}

/**
 * paper broker fill 수량 metadata가 실제 양수 체결을 의미하는지 판정한다.
 */
function isPositiveQuantity(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const numericValue = Number(value.trim());
  return Number.isFinite(numericValue) && numericValue > 0;
}

/**
 * JSON metadata 값에서 문자열 배열만 안전하게 읽는다.
 */
function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * group-local reason counter를 증가시킨다.
 */
function incrementReason(target: Record<string, number>, reasonCode: string): void {
  target[reasonCode] = (target[reasonCode] ?? 0) + 1;
}

/**
 * reason count record를 deterministic key 순서로 정렬한다.
 */
function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * evidence fingerprint에 포함할 order/correlation/idempotency 관련 안정 metadata를 추출한다.
 *
 * raw payload 전체를 fingerprint에 넣지 않고, 같은 stage 반복 evidence를 구분하는 데 필요한 안전한 식별자만 사용한다.
 */
function resolveStableEvidenceMetadataPart(record: PaperDecisionRunnerTraceRecord): string {
  const metadata = record.metadata;
  const stableCandidates = [
    metadata?.broker_order_id,
    metadata?.idempotency_key,
    metadata?.order_id,
    metadata?.correlation_id,
  ];
  for (const candidate of stableCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  const directions = readStringArray(metadata?.intent_directions);
  return directions.length > 0 ? directions.join(",") : "no-stable-metadata";
}

/**
 * evidence fingerprint 생성을 위한 충돌 저항 digest 함수다.
 *
 * append-only evidence fingerprint는 DB 전역 unique key이므로 32-bit 해시로 줄이지 않고
 * SHA-256 hex digest를 사용해 장기 24/7 runner에서도 우발 충돌 가능성을 낮춘다.
 */
function simpleHash(input: string): string {
  return `fp-${createHash("sha256").update(input).digest("hex")}`;
}
