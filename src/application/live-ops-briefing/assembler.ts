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
const marketProjectionUnavailableSummary = "시장 데이터 시황 projection이 아직 briefing assembler에 연결되지 않았습니다.";
const marketFreshnessSourceUnavailableSummary = "시장 데이터 freshness source가 아직 briefing assembler에 연결되지 않았습니다.";
const marketHeartbeatFreshnessWindowMs = 5 * 60 * 1000;

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
    runtime: createRuntime(input.status, input.liveTradingEnabled),
    market: createMarket(input.market, input.status, input.observedAt),
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

function createRuntime(
  status: LiveOpsStatusSummary | null,
  liveTradingEnabled: boolean | null | undefined,
): LiveOpsBriefingRuntimeSnapshot {
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
    // status source 응답은 daemon 관측 가능 상태로 보고, market heartbeat 장애를 daemon 중지로 오인하지 않는다.
    daemonAlive: true,
    runModeLabel: labelOperatingMode(status.mode),
    liveEnabled: liveTradingEnabled ?? isLiveTradingMode(status),
    liveArmed: status.mode === "live_armed" || status.mode === "live_order_capable",
    liveOrderCapable: status.liveOrderCapable,
    readinessGuard: status.action ?? status.message,
  };
}

function createMarket(
  market: CreateLiveOpsBriefingSnapshotInput["market"],
  status: LiveOpsStatusSummary | null,
  observedAt: string,
): LiveOpsBriefingMarketSnapshot {
  if (market !== undefined && market !== null) {
    return market;
  }

  if (market === null) {
    // market freshness 결측은 stale/healthy 어느 쪽으로도 추정하지 않고 관측 불가로 남긴다.
    return {
      freshnessLabel: unavailableText,
      summary: marketFreshnessSourceUnavailableSummary,
      observedAt: null,
    };
  }

  if (status === null || status.latestHeartbeat.observedAt === null) {
    // market projection 미연결 상태에서는 status heartbeat를 정상 시황으로 승격하지 않는다.
    return {
      freshnessLabel: unavailableText,
      summary: marketProjectionUnavailableSummary,
      observedAt: null,
    };
  }

  const heartbeatFreshnessIssue = resolveMarketHeartbeatFreshnessIssue(
    status.latestHeartbeat.observedAt,
    observedAt,
  );
  if (heartbeatFreshnessIssue !== null) {
    // status reason이 다른 guard에서 먼저 정해졌더라도 market freshness는 heartbeat 시각으로 다시 닫는다.
    return {
      freshnessLabel: "시장 데이터 freshness 확인 필요",
      summary: formatMarketHeartbeatFreshnessIssue(heartbeatFreshnessIssue, status.latestHeartbeat.observedAt),
      observedAt: status.latestHeartbeat.observedAt,
    };
  }

  if (readTraceString(status.trace, "reason") === "heartbeat_unavailable") {
    // status summary가 stale heartbeat를 이미 차단했으면 오래된 수신 label을 정상 freshness처럼 재사용하지 않는다.
    return {
      freshnessLabel: "시장 데이터 freshness 확인 필요",
      summary: status.message,
      observedAt: status.latestHeartbeat.observedAt,
    };
  }

  // market projection이 없는 정상 heartbeat는 시황 근거가 아니므로 freshness/source 결측으로 남긴다.
  return {
    freshnessLabel: unavailableText,
    summary: marketProjectionUnavailableSummary,
    observedAt: null,
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

  const entryItems = why?.markets.items.filter(isEntryMarketItem) ?? [];
  const sellItems = [
    ...(why?.markets.items.filter((item) => isExitDecisionTrace(item.trace)).map(toMarketDecisionItem) ?? []),
    ...(why?.strategies.items.filter(isExitDecisionItem).map(toStrategyDecisionItem) ?? []),
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
      ? why === null && status !== null
        ? formatObservedFact(status.latestDecision)
        : unavailableText
      : formatMarketDecisionItem(latestEntry)),
    latestExitDecision: latestSell === null
      ? formatWhySectionUnavailable(why?.strategies) ?? unavailableText
      : formatDecisionItem(latestSell),
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
  if (portfolio === null) {
    // portfolio source가 명시적으로 실패했으면 status summary PnL로 채우지 않고 관측 부재를 그대로 전달한다.
    return createUnavailablePortfolio();
  }

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
    ...createBalanceStatusLabel(source.balances),
    positions: source.positions ?? [],
    ...createPositionStatusLabel(source.positions),
    pnl,
    openExposureKrw: source.openExposureKrw === undefined ? status?.budget.openExposureKrw ?? null : source.openExposureKrw,
    budgetUsedKrw: source.budgetUsedKrw === undefined ? status?.budget.dailyNotionalUsedKrw ?? null : source.budgetUsedKrw,
  };
}

function createUnavailablePortfolio(): LiveOpsBriefingPortfolioSnapshot {
  return {
    cash: {
      statusLabel: unavailableText,
      availableKrw: null,
      totalKrw: null,
      observedAt: null,
    },
    balances: [],
    positions: [],
    pnl: createUnavailablePnl(),
    openExposureKrw: null,
    budgetUsedKrw: null,
  };
}

function createPnlFromStatus(status: LiveOpsStatusSummary | null): LiveOpsBriefingPnlSnapshot {
  if (status === null) {
    // PnL 결측은 0 손익으로 보정하면 closeout evidence를 왜곡하므로 null로 유지한다.
    return createUnavailablePnl();
  }

  if (status.budget.realizedPnlKrw === null && status.budget.unrealizedPnlKrw === null) {
    // status budget에도 손익 숫자가 없으면 정상 fallback label을 붙이지 않아 운영자가 source 결측을 볼 수 있게 한다.
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

/**
 * market heartbeat가 briefing 관측 시각 기준 freshness window를 벗어났거나 시각이 깨졌는지 판정한다.
 *
 * status의 대표 reason은 live trading disabled 같은 다른 guard가 선점할 수 있으므로, market section은 heartbeat 시각을 직접
 * 비교한다. 이 함수는 날짜 계산만 수행하고 provider 재조회나 snapshot 변경 side effect를 만들지 않는다.
 */
function resolveMarketHeartbeatFreshnessIssue(
  heartbeatObservedAt: string | null,
  briefingObservedAt: string,
): "future" | "invalid" | "stale" | null {
  if (heartbeatObservedAt === null) {
    return null;
  }

  const heartbeatTime = Date.parse(heartbeatObservedAt);
  const briefingTime = Date.parse(briefingObservedAt);
  if (!Number.isFinite(heartbeatTime) || !Number.isFinite(briefingTime)) {
    return "invalid";
  }

  const ageMs = briefingTime - heartbeatTime;
  if (ageMs < 0) {
    return "future";
  }
  return ageMs > marketHeartbeatFreshnessWindowMs ? "stale" : null;
}

/**
 * market heartbeat freshness 문제를 운영자가 읽을 한국어 문구로 변환한다.
 *
 * 내부 reason code를 만들지 않고 market section의 사용자-facing summary만 생성한다. 원 관측 시각은 trace가 아니라 본문에 필요한
 * 안전한 ISO 문자열로만 포함한다.
 */
function formatMarketHeartbeatFreshnessIssue(
  issue: "future" | "invalid" | "stale",
  heartbeatObservedAt: string | null,
): string {
  switch (issue) {
    case "future":
      return `시장 데이터 heartbeat 시각이 브리핑 시각보다 미래입니다. 마지막 수신 ${heartbeatObservedAt}.`;
    case "invalid":
      return `시장 데이터 heartbeat 시각을 해석할 수 없습니다. 마지막 수신 ${heartbeatObservedAt}.`;
    case "stale":
      return `시장 데이터 heartbeat가 5분보다 오래되었습니다. 마지막 수신 ${heartbeatObservedAt}.`;
  }
}

/**
 * balance projection의 명시적 null/empty 상태를 formatter가 구분할 수 있는 label로 낮춘다.
 *
 * `null`은 source 결측, 빈 배열은 정상 조회 후 보유 없음이다. undefined는 projection 미제공이므로 기존 `관측 없음` fallback을
 * 유지한다.
 */
function createBalanceStatusLabel(
  balances: NonNullable<CreateLiveOpsBriefingSnapshotInput["portfolio"]>["balances"],
): Partial<Pick<LiveOpsBriefingPortfolioSnapshot, "balanceStatusLabel">> {
  if (balances === null) {
    return { balanceStatusLabel: "coin balance source 관측 없음" };
  }
  if (balances !== undefined && balances.length === 0) {
    return { balanceStatusLabel: "coin balance 조회 완료: 보유 없음" };
  }
  return {};
}

/**
 * position projection의 명시적 null/empty 상태를 formatter가 구분할 수 있는 label로 낮춘다.
 *
 * `null`은 source 결측, 빈 배열은 정상 조회 후 무포지션이다. undefined는 projection 미제공이므로 기존 `관측 없음` fallback을
 * 유지한다.
 */
function createPositionStatusLabel(
  positions: NonNullable<CreateLiveOpsBriefingSnapshotInput["portfolio"]>["positions"],
): Partial<Pick<LiveOpsBriefingPortfolioSnapshot, "positionStatusLabel">> {
  if (positions === null) {
    return { positionStatusLabel: "position source 관측 없음" };
  }
  if (positions !== undefined && positions.length === 0) {
    return { positionStatusLabel: "position 조회 완료: 보유 없음" };
  }
  return {};
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
  if (input.market === null || input.market === undefined) {
    reasons.push("market_data_source_unavailable");
  }
  if (input.portfolio === null || input.portfolio === undefined) {
    reasons.push("portfolio_source_unavailable");
  }
  if (input.portfolio !== null && input.portfolio !== undefined) {
    if (input.portfolio.balances === null) {
      reasons.push("portfolio_balances_unavailable");
    }
    if (input.portfolio.positions === null) {
      reasons.push("portfolio_positions_unavailable");
    }
  }
  return reasons;
}

function createTraceMetadata(input: CreateLiveOpsBriefingSnapshotInput): JsonRecord | undefined {
  const base: JsonRecord = {
    liveOpsStatus: input.status?.status ?? "unavailable",
    liveOpsMode: input.status?.mode ?? "unavailable",
    liveTradingEnabled: input.liveTradingEnabled ?? "not_provided",
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
    readTraceString(why.trace, "reason") ?? "",
    readTraceString(why.markets.trace, "reason") ?? "",
    readTraceString(why.strategies.trace, "reason") ?? "",
    readTraceString(why.cash.trace, "reason") ?? "",
    ...readTraceStringArray(why.trace, "reasonCodes"),
    ...readTraceStringArray(why.markets.trace, "reasonCodes"),
    ...readTraceStringArray(why.strategies.trace, "reasonCodes"),
    ...readTraceStringArray(why.cash.trace, "reasonCodes"),
  ];
  for (const item of why.markets.items) {
    reasons.push(readTraceString(item.trace, "reasonCode") ?? "");
    reasons.push(readTraceString(item.trace, "reason") ?? "");
    reasons.push(...readTraceStringArray(item.trace, "reasonCodes"));
  }
  for (const item of why.strategies.items) {
    reasons.push(readTraceString(item.trace, "reasonCode") ?? "");
    reasons.push(readTraceString(item.trace, "reason") ?? "");
    reasons.push(...readTraceStringArray(item.trace, "reasonCodes"));
  }
  if (why.cash.item !== null) {
    reasons.push(readTraceString(why.cash.item.trace, "reasonCode") ?? "");
    reasons.push(readTraceString(why.cash.item.trace, "reason") ?? "");
    reasons.push(...readTraceStringArray(why.cash.item.trace, "reasonCodes"));
    for (const holdReason of why.cash.item.holdReasons) {
      reasons.push(readTraceString(holdReason.trace, "reasonCode") ?? "");
      reasons.push(readTraceString(holdReason.trace, "reason") ?? "");
      reasons.push(...readTraceStringArray(holdReason.trace, "reasonCodes"));
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

function readTraceStringArray(trace: JsonRecord, key: string): readonly string[] {
  const value = trace[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

function isEntryMarketItem(item: WhyMarketSummary): boolean {
  if (isExitDecisionTrace(item.trace)) {
    return false;
  }

  if (hasEntryDecisionTrace(item.trace)) {
    return true;
  }

  const category = readTraceString(item.trace, "category");
  if (category === "EXECUTED" || category === "EXECUTION_REJECTED") {
    return false;
  }

  if (category === "CASH_HOLD") {
    return false;
  }

  if (category === "DISCARD") {
    return collectTraceReasonCodes(item.trace).some(isKnownEntryDiscardReasonCode);
  }

  const strategyId = readFirstTraceString(item.trace, ["strategyId", "strategy_id", "resolvedStrategyId"]);
  if (strategyId !== null) {
    // market+strategy frame은 entry/exit 방향 근거가 없으면 매수 조건으로 단정하지 않는다.
    return false;
  }

  return true;
}

function isExitDecisionItem(item: WhyStrategySummary): boolean {
  if (isExitDecisionTrace(item.trace)) {
    return true;
  }

  const strategyId = item.strategyId.toLowerCase();
  return strategyId.includes("exit");
}

function isExitDecisionTrace(trace: JsonRecord): boolean {
  const category = readTraceString(trace, "category");
  if (category === "SELL") {
    return true;
  }

  const side = readFirstTraceString(trace, ["side", "orderSide", "order_side", "intentSide", "intent_side", "decisionSide", "decision_side"])
    ?.toUpperCase();
  if (side === "SELL" || side === "ASK") {
    return true;
  }

  const positionEffect = readFirstTraceString(trace, ["positionEffect", "position_effect"])
    ?.toUpperCase();
  if (positionEffect === "EXIT" || positionEffect === "REDUCE") {
    return true;
  }

  const phase = readTraceString(trace, "phase")?.toLowerCase() ?? "";
  const source = readTraceString(trace, "source")?.toLowerCase() ?? "";
  const reasonCodes = collectTraceReasonCodes(trace);
  return (
    phase.includes("exit") ||
    source.includes("exit") ||
    reasonCodes.some((reasonCode) => hasReasonCodeToken(reasonCode, "exit") || hasReasonCodeToken(reasonCode, "sell"))
  );
}

function hasEntryDecisionTrace(trace: JsonRecord): boolean {
  const category = readTraceString(trace, "category");
  if (category === "BUY") {
    return true;
  }

  const side = readFirstTraceString(trace, ["side", "orderSide", "order_side", "intentSide", "intent_side", "decisionSide", "decision_side"])
    ?.toUpperCase();
  if (side === "BUY" || side === "BID") {
    return true;
  }

  const positionEffect = readFirstTraceString(trace, ["positionEffect", "position_effect"])
    ?.toUpperCase();
  if (positionEffect === "ENTRY" || positionEffect === "INCREASE") {
    return true;
  }

  const phase = readTraceString(trace, "phase")?.toLowerCase() ?? "";
  const source = readTraceString(trace, "source")?.toLowerCase() ?? "";
  const reasonCodes = collectTraceReasonCodes(trace);
  return (
    phase.includes("entry") ||
    source.includes("entry") ||
    reasonCodes.some(isEntryReasonCode)
  );
}

function isEntryReasonCode(reasonCode: string): boolean {
  return reasonCode.includes("entry") ||
    reasonCode.includes("buy") ||
    isKnownEntryRiskReasonCode(reasonCode);
}

/**
 * 신규 진입 한도 차단으로 계약된 decision-ledger reason code인지 판정한다.
 *
 * position 단어만으로 exit을 추정하지 않기 위해 entry risk reason allowlist만 사용한다. 이 함수는 분류만 수행하며 trace나
 * snapshot을 변경하지 않는다.
 */
function isKnownEntryRiskReasonCode(reasonCode: string): boolean {
  return reasonCode === "open_position_budget_exceeded" ||
    reasonCode === "btc_eth_position_limit_exceeded" ||
    reasonCode === "single_alt_position_limit_exceeded" ||
    reasonCode === "exposure_limit_exceeded";
}

/**
 * order intent 변환 단계에서 신규 진입 후보 폐기로 계약된 reason code인지 판정한다.
 *
 * DISCARD category만으로 entry/exit 방향을 알 수 없으므로 sell-side 폐기 reason과 섞이지 않게 entry 변환 계층의 안정 code만
 * 허용한다. 이 함수는 분류만 수행하고 trace를 변경하지 않는다.
 */
function isKnownEntryDiscardReasonCode(reasonCode: string): boolean {
  return reasonCode === "market_order_disabled" ||
    reasonCode === "entry_market_order_disabled" ||
    reasonCode === "requested_quantity_invalid";
}

/**
 * decision-ledger trace의 단일/배열 reason code 표현을 동일한 분류 입력으로 정규화한다.
 *
 * DB-backed summary는 frame `reason_counts_json`을 `reasonCodes` 배열로 낮추므로, 단일 `reasonCode`만 보면 실제 entry/exit
 * guard를 놓칠 수 있다. 이 함수는 trace만 읽고 snapshot이나 외부 상태를 바꾸지 않는다.
 */
function collectTraceReasonCodes(trace: JsonRecord): readonly string[] {
  return uniqueText([
    readTraceString(trace, "reasonCode"),
    ...readTraceStringArray(trace, "reasonCodes"),
  ]).map((reasonCode) => reasonCode.toLowerCase());
}

function hasReasonCodeToken(reasonCode: string, token: string): boolean {
  return reasonCode.split(/[^a-z0-9]+/u).includes(token);
}

function readFirstTraceString(trace: JsonRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readTraceString(trace, key);
    if (value !== null) {
      return value;
    }
  }
  return null;
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

/**
 * status summary mode가 실제 live trading 활성 표시에 사용할 수 있는지 판정한다.
 *
 * `status.liveEnabled`는 guard 활성화일 수 있으므로 briefing의 실거래 활성화 표시는 live armed/order-capable mode만 true로
 * 낮춘다. 외부 provider 호출이나 runtime 상태 변경 side effect는 없다.
 */
function isLiveTradingMode(status: LiveOpsStatusSummary): boolean {
  return status.mode === "live_armed" || status.mode === "live_order_capable";
}

function uniqueText(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values
    .map((value) => value?.trim() ?? "")
    .filter(isNonEmptyString))];
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}
