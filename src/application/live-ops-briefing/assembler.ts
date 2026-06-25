import type { JsonRecord } from "../../domain/index.js";
import type { LiveOpsObservedFact, LiveOpsStatusSummary } from "../live-ops-status/types.js";
import type { WhyCashSummary, WhySummary } from "../decision-ledger/types.js";
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

  const firstMarketWhy = why?.markets.items[0] ?? null;
  const firstStrategyWhy = why?.strategies.items[0] ?? null;

  return {
    latestCandidate: status === null
      ? unavailableText
      : formatObservedFact(status.latestCandidate),
    latestEntryDecision: firstMarketWhy === null
      ? status === null
        ? unavailableText
        : formatObservedFact(status.latestDecision)
      : `${firstMarketWhy.market}: ${firstMarketWhy.statusLabel} - ${firstMarketWhy.message}`,
    latestExitDecision: firstStrategyWhy === null
      ? status === null
        ? unavailableText
        : formatObservedFact(status.latestFillOrCancel)
      : `${firstStrategyWhy.strategyId}: ${firstStrategyWhy.statusLabel} - ${firstStrategyWhy.message}`,
    buyConditions: why?.markets.items.map((item) => `${item.market}: ${item.statusLabel}`) ?? [],
    sellConditions: why?.strategies.items.map((item) => `${item.strategyId}: ${item.statusLabel}`) ?? [],
    holdReason: why?.cash.item === null || why?.cash.item === undefined
      ? null
      : formatCashHoldReason(why.cash.item),
    blockReason: status?.riskBlock.blockedReason
      ?? (why === null ? "decision ledger why summary source가 아직 briefing assembler에 연결되지 않았습니다." : null),
  };
}

function createPortfolio(
  portfolio: CreateLiveOpsBriefingSnapshotInput["portfolio"],
  status: LiveOpsStatusSummary | null,
): LiveOpsBriefingPortfolioSnapshot {
  const source = portfolio ?? {};
  const pnl = source.pnl ?? createPnlFromStatus(status);

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
    return {
      statusLabel: unavailableText,
      realizedKrw: null,
      unrealizedKrw: null,
      equityKrw: null,
      observedAt: null,
    };
  }

  return {
    statusLabel: "status summary 기준",
    realizedKrw: status.budget.realizedPnlKrw,
    unrealizedKrw: status.budget.unrealizedPnlKrw,
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
    openOrders: status.reconcile.openOrderCount === null
      ? "미체결 주문 관측 없음"
      : `미체결 주문 ${status.reconcile.openOrderCount}건`,
    reconcile: [
      status.reconcile.result,
      status.reconcile.lastReconcileAt === null ? null : `마지막 ${status.reconcile.lastReconcileAt}`,
      status.reconcile.actionRequired === null ? null : `조치 ${status.reconcile.actionRequired}`,
    ].filter(isNonEmptyString).join(", "),
    risk: [
      `kill switch ${status.riskBlock.killSwitchState}`,
      status.riskBlock.newOrdersBlocked ? "신규 주문 차단" : "신규 주문 허용",
      status.riskBlock.requiresManualReview ? "manual review 필요" : "manual review 없음",
      status.riskBlock.blockedReason === null ? null : `사유 ${status.riskBlock.blockedReason}`,
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
  const reasons: string[] = [];
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
