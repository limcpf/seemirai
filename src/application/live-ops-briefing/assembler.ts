import type { JsonRecord } from "../../domain/index.js";
import type { LiveOpsObservedFact, LiveOpsStatusSummary } from "../live-ops-status/types.js";
import type {
  WhyCashSummary,
  WhyMarketSummary,
  WhyStrategySummary,
  WhySummary,
} from "../decision-ledger/types.js";
import {
  LIVE_OPS_BRIEFING_SCHEMA_VERSION,
} from "./types.js";
import type {
  CreateLiveOpsBriefingSnapshotInput,
  LiveOpsBriefingDecisionSnapshot,
  LiveOpsBriefingHeadline,
  LiveOpsBriefingMarketSnapshot,
  LiveOpsBriefingOperationsSnapshot,
  LiveOpsBriefingPnlSnapshot,
  LiveOpsBriefingPortfolioSnapshot,
  LiveOpsBriefingRuntimeSnapshot,
  LiveOpsBriefingSnapshot,
  LiveOpsBriefingTraceSnapshot,
} from "./types.js";

const unavailableText = "관측 없음";

interface BriefingWhyDecisionItem {
  label: string;
  statusLabel: string;
  message: string;
  latestDecisionAt: string | null;
  trace: JsonRecord;
}

/**
 * Live Ops status/why/portfolio projection을 Telegram briefing snapshot으로 조립한다.
 *
 * provider 호출과 Telegram 전송은 caller 경계에 남기고, 이 함수는 이미 secret-safe로 낮아진 입력을 deterministic snapshot으로
 * 변환한다. 결측 source는 0이나 정상 상태로 보정하지 않고 `관측 없음`과 trace reason으로 남겨 운영자가 source 연결 누락을
 * 확인할 수 있게 한다.
 *
 * @param input status, decision why, market, portfolio safe projection 묶음
 * @returns formatter와 LLM guard가 공유할 read-only briefing snapshot
 */
export function createLiveOpsBriefingSnapshot(
  input: CreateLiveOpsBriefingSnapshotInput,
): LiveOpsBriefingSnapshot {
  return {
    schemaVersion: LIVE_OPS_BRIEFING_SCHEMA_VERSION,
    observedAt: input.observedAt,
    headline: createHeadline(input.status),
    runtime: createRuntime(input.status),
    market: createMarket(input.market, input.status),
    decisions: createDecisions(input.status, input.why),
    portfolio: createPortfolio(input.portfolio, input.status),
    operations: createOperations(input.status),
    trace: createTrace(input),
  };
}

function createHeadline(status: LiveOpsStatusSummary | null): LiveOpsBriefingHeadline {
  if (status === null) {
    // status source 결측은 주문 가능으로 추정하지 않고 operator가 연결 누락을 먼저 보게 한다.
    return {
      statusLabel: unavailableText,
      cause: "Live Ops status source가 아직 briefing assembler에 연결되지 않았습니다.",
      impact: "실거래 가능 여부를 briefing으로 판정할 수 없습니다.",
      action: "status provider 연결 상태를 확인한 뒤 다시 브리핑을 생성하세요.",
    };
  }

  return {
    statusLabel: status.statusLabel,
    cause: status.message,
    impact: status.impact ?? "운영 영향 관측 없음",
    action: status.action ?? "추가 조치 없음",
  };
}

function createRuntime(status: LiveOpsStatusSummary | null): LiveOpsBriefingRuntimeSnapshot {
  if (status === null) {
    // daemon/readiness 결측은 live armed로 보정하면 위험하므로 모든 runtime capability를 닫는다.
    return {
      daemonAlive: false,
      runModeLabel: unavailableText,
      liveEnabled: false,
      liveArmed: false,
      liveOrderCapable: false,
      readinessGuard: "Live Ops status source가 아직 briefing assembler에 연결되지 않았습니다.",
    };
  }

  return {
    daemonAlive: status.latestHeartbeat.observedAt !== null,
    runModeLabel: labelOperatingMode(status.mode),
    liveEnabled: status.liveEnabled,
    liveArmed: status.mode === "live_armed" || status.mode === "live_order_capable",
    liveOrderCapable: status.liveOrderCapable,
    readinessGuard: status.action ?? status.message,
  };
}

function createMarket(
  market: CreateLiveOpsBriefingSnapshotInput["market"],
  status: LiveOpsStatusSummary | null,
): LiveOpsBriefingMarketSnapshot {
  if (market !== undefined && market !== null) {
    return market;
  }

  if (market === null || status === null || status.latestHeartbeat.observedAt === null) {
    // market freshness 결측은 stale/healthy 어느 쪽으로도 추정하지 않고 관측 불가로 남긴다.
    return {
      freshnessLabel: unavailableText,
      summary: "시장 데이터 freshness source가 아직 briefing assembler에 연결되지 않았습니다.",
      observedAt: null,
    };
  }

  return {
    freshnessLabel: status.latestHeartbeat.statusLabel,
    summary: status.latestHeartbeat.message,
    observedAt: status.latestHeartbeat.observedAt,
  };
}

function createDecisions(
  status: LiveOpsStatusSummary | null,
  why: WhySummary | null,
): LiveOpsBriefingDecisionSnapshot {
  if (status === null && why === null) {
    // 판단 source가 모두 없으면 HOLD/BLOCK을 꾸며내지 않고 source 결측 자체를 block reason으로 노출한다.
    return {
      latestCandidate: unavailableText,
      latestEntryDecision: unavailableText,
      latestExitDecision: unavailableText,
      buyConditions: [],
      sellConditions: [],
      holdReason: null,
      blockReason: "decision ledger why summary source가 아직 briefing assembler에 연결되지 않았습니다.",
    };
  }

  const entryItems = why?.markets.items.filter((item) => !isSellDecision(item.trace)) ?? [];
  const sellItems = [
    ...(why?.markets.items.filter((item) => isSellDecision(item.trace)).map(toMarketDecisionItem) ?? []),
    ...(why?.strategies.items.filter((item) => isSellDecision(item.trace)).map(toStrategyDecisionItem) ?? []),
  ];
  const latestEntry = selectLatestMarketItem(entryItems);
  const latestSell = selectLatestDecisionItem(sellItems);
  const whyBlockReason = formatWhyBlockReason(why);

  return {
    latestCandidate: status === null
      ? unavailableText
      : formatObservedFact(status.latestCandidate),
    latestEntryDecision: formatWhySectionUnavailable(why?.markets)
      ?? (latestEntry === null
      ? status === null
        ? unavailableText
        : formatObservedFact(status.latestDecision)
      : formatMarketDecisionItem(latestEntry)),
    latestExitDecision: formatWhySectionUnavailable(why?.strategies)
      ?? (latestSell === null ? unavailableText : formatDecisionItem(latestSell)),
    buyConditions: entryItems.map((item) => `${item.market}: ${item.statusLabel}`),
    sellConditions: sellItems.map((item) => `${item.label}: ${item.statusLabel}`),
    holdReason: why?.cash.item === null || why?.cash.item === undefined
      ? null
      : formatCashHoldReason(why.cash.item),
    blockReason: formatRiskBlockReason(status)
      ?? whyBlockReason
      ?? (why === null ? "decision ledger why summary source가 아직 briefing assembler에 연결되지 않았습니다." : null),
  };
}

function createPortfolio(
  portfolio: CreateLiveOpsBriefingSnapshotInput["portfolio"],
  status: LiveOpsStatusSummary | null,
): LiveOpsBriefingPortfolioSnapshot {
  const source = portfolio ?? {};
  const pnl = source.pnl === undefined ? createPnlFromStatus(status) : source.pnl ?? createUnavailablePnl();

  return {
    cash: source.cash ?? {
      statusLabel: unavailableText,
      availableKrw: null,
      totalKrw: null,
      observedAt: null,
    },
    balances: source.balances ?? [],
    positions: source.positions ?? [],
    pnl,
    openExposureKrw: source.openExposureKrw ?? status?.budget.openExposureKrw ?? null,
    budgetUsedKrw: source.budgetUsedKrw ?? status?.budget.dailyNotionalUsedKrw ?? null,
  };
}

function createPnlFromStatus(status: LiveOpsStatusSummary | null): LiveOpsBriefingPnlSnapshot {
  if (status === null) {
    // PnL 결측은 0 손익으로 보정하면 closeout evidence를 왜곡하므로 null로 유지한다.
    return createUnavailablePnl();
  }

  return {
    statusLabel: "status summary 기준",
    realizedKrw: status.budget.realizedPnlKrw,
    unrealizedKrw: status.budget.unrealizedPnlKrw,
    equityKrw: null,
    observedAt: null,
  };
}

function createUnavailablePnl(): LiveOpsBriefingPnlSnapshot {
  return {
    statusLabel: unavailableText,
    realizedKrw: null,
    unrealizedKrw: null,
    equityKrw: null,
    observedAt: null,
  };
}

function createOperations(status: LiveOpsStatusSummary | null): LiveOpsBriefingOperationsSnapshot {
  if (status === null) {
    // 운영 source 결측은 정상 주문/정상 reconcile로 보정하지 않고 모두 관측 없음으로 닫는다.
    return {
      openOrders: unavailableText,
      reconcile: unavailableText,
      risk: unavailableText,
      alertRetry: unavailableText,
    };
  }

  return {
    openOrders: formatOrderOperation(status),
    reconcile: [
      formatReconcileResult(status.reconcile.result),
      status.reconcile.lastReconcileAt === null ? null : `마지막 ${status.reconcile.lastReconcileAt}`,
      status.reconcile.actionRequired === null ? null : `조치 ${status.reconcile.actionRequired}`,
    ].filter(isNonEmptyString).join(", "),
    risk: [
      formatRiskState(status),
      status.riskBlock.newOrdersBlocked ? "신규 주문 차단" : "신규 주문 허용",
      status.riskBlock.requiresManualReview ? "manual review 필요" : "manual review 없음",
      status.riskBlock.blockedReason === null ? null : "차단 사유는 추적 정보에 보존",
    ].filter(isNonEmptyString).join(", "),
    alertRetry: [
      status.alertRetry.statusLabel,
      status.alertRetry.lastSentAt === null ? null : `마지막 전송 ${status.alertRetry.lastSentAt}`,
      status.alertRetry.lastSkippedAt === null ? null : `마지막 skip ${status.alertRetry.lastSkippedAt}`,
      status.alertRetry.action === null ? null : `조치 ${status.alertRetry.action}`,
    ].filter(isNonEmptyString).join(", "),
  };
}

function createTrace(input: CreateLiveOpsBriefingSnapshotInput): LiveOpsBriefingTraceSnapshot {
  const status = input.status;
  const why = input.why;
  const extraTrace = input.trace;
  const sourceIds = [
    ...(extraTrace?.sourceIds ?? []),
    ...(status === null ? [] : collectStatusSourceIds(status)),
    ...(why === null ? [] : collectWhySourceIds(why)),
  ];
  const reasonCodes = [
    ...(extraTrace?.reasonCodes ?? []),
    ...(status === null ? ["live_ops_status_unavailable"] : collectStatusReasonCodes(status)),
    ...(why === null ? ["decision_ledger_why_unavailable"] : collectWhyReasonCodes(why)),
    ...collectSourceAvailabilityReasons(input),
  ];

  const metadata = createTraceMetadata(input);
  return {
    evidenceIds: uniqueText([
      ...(extraTrace?.evidenceIds ?? []),
      ...(status === null ? [] : collectStatusEvidenceIds(status)),
    ]),
    reasonCodes: uniqueText(reasonCodes),
    sourceIds: uniqueText(sourceIds),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function collectSourceAvailabilityReasons(input: CreateLiveOpsBriefingSnapshotInput): readonly string[] {
  const reasons: string[] = [];
  if (input.market === null || (input.market === undefined && input.status === null)) {
    reasons.push("market_data_source_unavailable");
  }
  if (input.portfolio === null || input.portfolio === undefined) {
    reasons.push("portfolio_source_unavailable");
  }
  return reasons;
}

function createTraceMetadata(input: CreateLiveOpsBriefingSnapshotInput): JsonRecord | undefined {
  const base: JsonRecord = {
    liveOpsStatus: input.status?.status ?? "unavailable",
    liveOpsMode: input.status?.mode ?? "unavailable",
    whyReadStatus: input.why?.readStatus ?? "unavailable",
  };
  return input.trace?.metadata === undefined
    ? base
    : { ...base, ...input.trace.metadata };
}

function collectStatusSourceIds(status: LiveOpsStatusSummary): readonly string[] {
  return uniqueText([
    readTraceString(status.trace, "source"),
    readTraceString(status.latestHeartbeat.trace, "source"),
    readTraceString(status.latestCandidate.trace, "source"),
    readTraceString(status.latestDecision.trace, "source"),
    readTraceString(status.latestOrderAttempt.trace, "source"),
    readTraceString(status.latestFillOrCancel.trace, "source"),
  ]);
}

function collectStatusEvidenceIds(status: LiveOpsStatusSummary): readonly string[] {
  return uniqueText([
    readTraceString(status.latestHeartbeat.trace, "evidenceId"),
    readTraceString(status.latestCandidate.trace, "evidenceId"),
    readTraceString(status.latestDecision.trace, "evidenceId"),
    readTraceString(status.latestOrderAttempt.trace, "evidenceId"),
    readTraceString(status.latestFillOrCancel.trace, "evidenceId"),
  ]);
}

function collectStatusReasonCodes(status: LiveOpsStatusSummary): readonly string[] {
  return uniqueText([
    readTraceString(status.trace, "reason"),
    status.riskBlock.blockedReason,
    status.riskBlock.killSwitchState,
    status.reconcile.result,
  ]);
}

function collectWhySourceIds(why: WhySummary): readonly string[] {
  return uniqueText([
    "decision_ledger_why_summary",
    readTraceString(why.trace, "querySource"),
    readTraceString(why.markets.trace, "querySource"),
    readTraceString(why.strategies.trace, "querySource"),
    readTraceString(why.cash.trace, "querySource"),
  ]);
}

function collectWhyReasonCodes(why: WhySummary): readonly string[] {
  const reasons: string[] = [
    readTraceString(why.trace, "reasonCode") ?? "",
    readTraceString(why.markets.trace, "reasonCode") ?? "",
    readTraceString(why.strategies.trace, "reasonCode") ?? "",
    readTraceString(why.cash.trace, "reasonCode") ?? "",
  ];
  for (const item of why.markets.items) {
    reasons.push(readTraceString(item.trace, "reasonCode") ?? "");
  }
  for (const item of why.strategies.items) {
    reasons.push(readTraceString(item.trace, "reasonCode") ?? "");
  }
  if (why.cash.item !== null) {
    reasons.push(readTraceString(why.cash.item.trace, "reasonCode") ?? "");
    for (const holdReason of why.cash.item.holdReasons) {
      reasons.push(readTraceString(holdReason.trace, "reasonCode") ?? "");
    }
  }
  if (why.readStatus !== "OK") {
    reasons.push(`decision_ledger_why_${why.readStatus.toLowerCase()}`);
  }
  return uniqueText(reasons);
}

function readTraceString(trace: JsonRecord, key: string): string | null {
  const value = trace[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatObservedFact(fact: LiveOpsObservedFact): string {
  return `${fact.statusLabel}: ${fact.message}`;
}

function formatMarketDecisionItem(item: WhyMarketSummary): string {
  return `${item.market}: ${item.statusLabel} - ${item.message}`;
}

function formatDecisionItem(item: BriefingWhyDecisionItem): string {
  return `${item.label}: ${item.statusLabel} - ${item.message}`;
}

function toMarketDecisionItem(item: WhyMarketSummary): BriefingWhyDecisionItem {
  return {
    label: item.market,
    statusLabel: item.statusLabel,
    message: item.message,
    latestDecisionAt: item.latestDecisionAt,
    trace: item.trace,
  };
}

function toStrategyDecisionItem(item: WhyStrategySummary): BriefingWhyDecisionItem {
  return {
    label: item.strategyId,
    statusLabel: item.statusLabel,
    message: item.message,
    latestDecisionAt: item.latestDecisionAt,
    trace: item.trace,
  };
}

function selectLatestMarketItem(items: readonly WhyMarketSummary[]): WhyMarketSummary | null {
  return selectLatestByObservedAt(items);
}

function selectLatestDecisionItem(items: readonly BriefingWhyDecisionItem[]): BriefingWhyDecisionItem | null {
  return selectLatestByObservedAt(items);
}

function selectLatestByObservedAt<T extends { latestDecisionAt: string | null }>(items: readonly T[]): T | null {
  let latest: T | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const itemTime = item.latestDecisionAt === null ? Number.NEGATIVE_INFINITY : Date.parse(item.latestDecisionAt);
    const normalizedTime = Number.isFinite(itemTime) ? itemTime : Number.NEGATIVE_INFINITY;
    if (latest === null || normalizedTime > latestTime) {
      latest = item;
      latestTime = normalizedTime;
    }
  }

  return latest;
}

function isSellDecision(trace: JsonRecord): boolean {
  return readTraceString(trace, "category") === "SELL";
}

function formatWhySectionUnavailable(section: {
  readStatus: string;
  statusLabel: string;
  message: string;
  action: string | null;
} | null | undefined): string | null {
  if (section === null || section === undefined || section.readStatus === "OK") {
    return null;
  }

  return [
    section.statusLabel,
    section.message,
    section.action === null ? null : `필요 조치: ${section.action}`,
  ].filter(isNonEmptyString).join(" - ");
}

function formatWhyBlockReason(why: WhySummary | null): string | null {
  if (why === null) {
    return null;
  }

  const unavailableSections = [
    why.markets.readStatus === "UNAVAILABLE" ? why.markets.statusLabel : null,
    why.strategies.readStatus === "UNAVAILABLE" ? why.strategies.statusLabel : null,
    why.cash.readStatus === "UNAVAILABLE" ? why.cash.statusLabel : null,
  ];
  if (why.readStatus !== "UNAVAILABLE" && unavailableSections.every((section) => section === null)) {
    return null;
  }

  return [
    "decision ledger why summary 조회 불가",
    ...unavailableSections,
  ].filter(isNonEmptyString).join(": ");
}

function formatRiskBlockReason(status: LiveOpsStatusSummary | null): string | null {
  if (status === null) {
    return null;
  }
  if (status.riskBlock.requiresManualReview) {
    return "수동 검토가 필요한 상태라 신규 진입 판단을 실행하지 않습니다.";
  }
  if (status.riskBlock.newOrdersBlocked) {
    return "신규 주문 차단 상태라 신규 진입 판단을 실행하지 않습니다.";
  }
  return null;
}

function formatOrderOperation(status: LiveOpsStatusSummary): string {
  const openOrders = status.reconcile.openOrderCount === null
    ? "미체결 주문 관측 없음"
    : `미체결 주문 ${status.reconcile.openOrderCount}건`;

  return [
    `주문 시도: ${formatObservedFact(status.latestOrderAttempt)}`,
    `체결/취소: ${formatObservedFact(status.latestFillOrCancel)}`,
    openOrders,
  ].join(", ");
}

function formatReconcileResult(result: string): string {
  switch (result) {
    case "SUCCESS":
      return "reconcile 정상";
    case "MISMATCH_DETECTED":
      return "reconcile 불일치 발견";
    case "FAILED":
      return "reconcile 확인 실패";
    case "UNAVAILABLE":
      return "reconcile 조회 불가";
    case "SKIPPED":
      return "reconcile 실행 전";
    default:
      return "reconcile 상태 확인 필요";
  }
}

function formatRiskState(status: LiveOpsStatusSummary): string {
  if (status.riskBlock.requiresManualReview) {
    return "수동 검토 필요 상태";
  }
  if (status.riskBlock.newOrdersBlocked) {
    return "신규 주문 차단 상태";
  }
  return "신규 주문 제한 없음";
}

function formatCashHoldReason(cash: WhyCashSummary): string {
  if (cash.holdReasons.length === 0) {
    return cash.message;
  }

  return cash.holdReasons
    .map((reason) => `${reason.label} ${reason.count}건`)
    .join(", ");
}

function labelOperatingMode(mode: LiveOpsStatusSummary["mode"]): string {
  switch (mode) {
    case "live_order_capable":
      return "실매매 가능";
    case "live_armed":
      return "실매매 준비";
    case "heartbeat_only":
      return "상태 관측 전용";
    case "dry_run":
      return "모의 운영";
  }
}

function uniqueText(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values
    .map((value) => value?.trim() ?? "")
    .filter(isNonEmptyString))];
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}
