import type {
  CreateLiveOpsStatusSummaryInput,
  LiveOpsObservedFact,
  LiveOpsOperatingMode,
  LiveOpsOperationalStatus,
  LiveOpsStatusSummary,
} from "./types.js";

const maxLiveOpsHeartbeatAgeMs = 5 * 60 * 1000;

/**
 * M23 live ops status summary를 생성한다.
 *
 * runtime guard, reconcile, PnL, alert, 최신 event safe summary를 하나의 사용자-facing 상태로 묶는다. 이 함수는 이미 계산된
 * summary만 조합하므로 DB 조회, Upbit API 호출, Telegram 전송, audit write 같은 외부 side effect를 만들지 않는다.
 *
 * @param input secret-safe runtime/status 입력
 * @returns HTTP/Telegram/report가 공유할 M23 live ops summary
 */
export function createLiveOpsStatusSummary(input: CreateLiveOpsStatusSummaryInput): LiveOpsStatusSummary {
  const liveOrderCapable = isLiveOrderCapable(input);
  const mode = resolveOperatingMode(input, liveOrderCapable);
  const status = resolveOperationalStatus(input, liveOrderCapable);
  const reason = resolveReason(input, liveOrderCapable);

  return {
    status,
    statusLabel: toStatusLabel(status, mode),
    message: toMessage(input, mode, liveOrderCapable),
    impact: toImpact(input, mode, liveOrderCapable),
    action: toAction(input, mode, liveOrderCapable),
    mode,
    liveEnabled: input.liveAutonomous.enabled,
    liveOrderCapable,
    paperNoKey: input.paperNoKey,
    readiness: {
      keyScopeSafe: input.liveAutonomous.keyScopeEvidenceConfigured,
      telegramInboundReady: input.liveAutonomous.telegramInboundReady,
      reconcileFresh: input.liveAutonomous.reconcileFresh,
      pnlStatusReady: input.liveAutonomous.pnlStatusReady,
      decisionLedgerReady: input.liveAutonomous.decisionLedgerReady,
      exitEngineReady: input.liveAutonomous.exitEngineReady,
    },
    latestHeartbeat: input.latestHeartbeat ?? createMissingFact(
      "heartbeat 미연결",
      "M23 heartbeat evidence가 아직 status summary에 연결되지 않았습니다.",
      input.observedAt,
      "live_ops_heartbeat_unavailable",
    ),
    latestCandidate: input.latestCandidate ?? createMissingFact(
      "후보 기록 없음",
      "최근 주문 후보 evidence가 아직 status summary에 연결되지 않았습니다.",
      input.observedAt,
      "live_ops_candidate_unavailable",
    ),
    latestDecision: input.latestDecision ?? createMissingFact(
      "판단 기록 없음",
      "최근 매매 판단 evidence가 아직 status summary에 연결되지 않았습니다.",
      input.observedAt,
      "live_ops_decision_unavailable",
    ),
    latestOrderAttempt: input.latestOrderAttempt ?? createMissingFact(
      "주문 시도 없음",
      "최근 live order attempt evidence가 아직 status summary에 연결되지 않았습니다.",
      input.observedAt,
      "live_ops_order_attempt_unavailable",
    ),
    latestFillOrCancel: input.latestFillOrCancel ?? createMissingFact(
      "체결/취소 기록 없음",
      "최근 체결, 부분체결, 취소 확인 evidence가 아직 status summary에 연결되지 않았습니다.",
      input.observedAt,
      "live_ops_fill_cancel_unavailable",
    ),
    reconcile: input.reconcile,
    budget: {
      maxOrderKrw: input.liveAutonomous.maxOrderKrw,
      dailyAutonomousNotionalLimitKrw: input.liveAutonomous.dailyAutonomousNotionalLimitKrw,
      maxOpenPositionNotionalKrw: input.liveAutonomous.maxOpenPositionNotionalKrw,
      dailyNotionalUsedKrw: input.dailyNotionalUsedKrw ?? null,
      openExposureKrw: input.openExposureKrw ?? null,
      realizedPnlKrw: input.pnl.latestRealizedPnlKrw,
      unrealizedPnlKrw: input.pnl.latestUnrealizedPnlKrw,
    },
    riskBlock: input.tradingState,
    alertRetry: input.alerts,
    trace: {
      source: "live_ops_status_summary",
      reason,
      observedAt: input.observedAt,
      runtimeMode: input.runtimeMode,
      liveAutonomousReason: input.liveAutonomous.trace.reason ?? null,
      reconcileResult: input.reconcile.result,
      blockedReason: input.tradingState.blockedReason,
      marketDataConnectionStatus: input.marketData.connectionStatus,
      marketDataLagMs: input.marketData.lagMs,
    },
  };
}

/**
 * M23 live ops summary를 daily report section으로 변환한다.
 *
 * report 본문은 내부 reason code를 첫 화면에 노출하지 않고 상태, 주문 가능 여부, 최신 관측값, 예산/노출, 필요한 조치를 먼저
 * 보여준다. 추적용 mode/reason은 마지막 줄에만 둔다.
 *
 * @param summary secret-safe M23 live ops summary
 * @returns daily report에 붙일 한국어 section
 */
export function formatLiveOpsStatusReportSection(summary: LiveOpsStatusSummary): string {
  return [
    "M23 live 운영 상태",
    `- 상태: ${summary.statusLabel}`,
    `- 설명: ${summary.message}`,
    `- 매매 가능: ${summary.liveOrderCapable ? "예" : "아니오"}`,
    `- 최신 heartbeat: ${summary.latestHeartbeat.observedAt ?? "기록 없음"} (${summary.latestHeartbeat.statusLabel})`,
    `- 최신 판단: ${summary.latestDecision.statusLabel}`,
    `- 최신 주문/체결: ${summary.latestOrderAttempt.statusLabel} / ${summary.latestFillOrCancel.statusLabel}`,
    `- 예산: 1회 ${summary.budget.maxOrderKrw} KRW, 일일 ${summary.budget.dailyAutonomousNotionalLimitKrw} KRW, open ${summary.budget.maxOpenPositionNotionalKrw} KRW`,
    `- 사용/노출: 일일 ${formatNullableKrw(summary.budget.dailyNotionalUsedKrw)}, open ${formatNullableKrw(summary.budget.openExposureKrw)}`,
    `- 필요 조치: ${summary.action ?? "추가 조치 없음"}`,
    `- 추적 정보: mode=${summary.mode}, status=${summary.status}`,
  ].join("\n");
}

function isLiveOrderCapable(input: CreateLiveOpsStatusSummaryInput): boolean {
  return (
    input.liveAutonomous.enabled &&
    input.liveAutonomous.ready &&
    input.liveTradingEnabled &&
    !input.paperNoKey &&
    hasUsableHeartbeat(input) &&
    !input.tradingState.newOrdersBlocked &&
    !input.tradingState.requiresManualReview &&
    input.reconcile.result === "SUCCESS"
  );
}

function resolveOperatingMode(input: CreateLiveOpsStatusSummaryInput, liveOrderCapable: boolean): LiveOpsOperatingMode {
  if (liveOrderCapable) {
    return "live_order_capable";
  }
  if (input.liveAutonomous.enabled && input.liveTradingEnabled && !input.paperNoKey) {
    return "live_armed";
  }
  if (input.liveAutonomous.enabled || input.runtimeMode === "LIVE_AUTONOMOUS_SMALL_BUDGET") {
    return "heartbeat_only";
  }
  return "dry_run";
}

function resolveOperationalStatus(
  input: CreateLiveOpsStatusSummaryInput,
  liveOrderCapable: boolean,
): LiveOpsOperationalStatus {
  if (liveOrderCapable) {
    return "ok";
  }
  if (!input.liveAutonomous.enabled || !input.liveTradingEnabled || input.paperNoKey) {
    return "warning";
  }
  if (!hasUsableHeartbeat(input)) {
    return "unavailable";
  }
  if (input.reconcile.result === "UNAVAILABLE" || input.pnl.statusLabel === "조회 불가") {
    return "unavailable";
  }
  return "warning";
}

function resolveReason(input: CreateLiveOpsStatusSummaryInput, liveOrderCapable: boolean): string {
  if (liveOrderCapable) return "live_order_capable";
  if (!input.liveAutonomous.enabled) return "live_autonomous_disabled";
  if (!input.liveTradingEnabled) return "live_trading_disabled";
  if (input.paperNoKey) return "paper_no_key";
  if (!input.liveAutonomous.ready) return "live_autonomous_guard_blocked";
  if (!hasUsableHeartbeat(input)) return "heartbeat_unavailable";
  if (input.tradingState.newOrdersBlocked) return "new_orders_blocked";
  if (input.tradingState.requiresManualReview) return "manual_review_required";
  if (input.reconcile.result !== "SUCCESS") return "reconcile_not_success";
  return "live_ops_not_order_capable";
}

function toStatusLabel(status: LiveOpsOperationalStatus, mode: LiveOpsOperatingMode): string {
  if (mode === "live_order_capable") return "실매매 가능";
  if (mode === "live_armed") return status === "unavailable" ? "실매매 상태 확인 불가" : "실매매 준비 중";
  if (mode === "heartbeat_only") return "상태 관측 전용";
  return "모의 운영";
}

function toMessage(
  input: CreateLiveOpsStatusSummaryInput,
  mode: LiveOpsOperatingMode,
  liveOrderCapable: boolean,
): string {
  if (liveOrderCapable) {
    return "M23 live small-budget runtime이 guard, reconcile, kill switch 조건을 통과해 주문 가능 상태입니다.";
  }
  if (!input.liveAutonomous.enabled) {
    return "live autonomous 설정이 비활성이라 실제 주문은 제출되지 않습니다.";
  }
  if (!input.liveTradingEnabled) {
    return "live trading 설정이 꺼져 있어 M23 런타임은 실주문을 제출할 수 없습니다.";
  }
  if (input.paperNoKey) {
    return "실거래 키가 없는 모의 운영 상태라 M23 런타임은 실주문을 제출할 수 없습니다.";
  }
  if (!input.liveAutonomous.ready) {
    return input.liveAutonomous.message;
  }
  if (!hasUsableHeartbeat(input)) {
    return "최신 market data heartbeat가 확인되지 않아 M23 런타임을 실주문 가능 상태로 보지 않습니다.";
  }
  if (input.tradingState.newOrdersBlocked || input.tradingState.requiresManualReview) {
    return "kill switch 또는 manual review 상태 때문에 live order capable 상태가 아닙니다.";
  }
  if (input.reconcile.result !== "SUCCESS") {
    return "최신 reconcile이 성공 상태가 아니어서 live order capable 상태로 보지 않습니다.";
  }
  return `${labelOperatingMode(mode)} 상태이며 주문 가능 조건을 아직 모두 확인하지 못했습니다.`;
}

function toImpact(
  input: CreateLiveOpsStatusSummaryInput,
  mode: LiveOpsOperatingMode,
  liveOrderCapable: boolean,
): string | null {
  if (liveOrderCapable) {
    return "소액 한도 안에서 live order API 호출 경계로 전진할 수 있습니다.";
  }
  if (mode === "dry_run" || mode === "heartbeat_only") {
    return "실거래 주문 side effect는 발생하지 않습니다.";
  }
  if (input.tradingState.newOrdersBlocked) {
    return "신규 주문은 차단되고 기존 상태 확인과 복구 evidence만 남겨야 합니다.";
  }
  return "M23 closeout에서 live order capable evidence로 사용할 수 없습니다.";
}

function toAction(
  input: CreateLiveOpsStatusSummaryInput,
  mode: LiveOpsOperatingMode,
  liveOrderCapable: boolean,
): string | null {
  if (liveOrderCapable) {
    return "후보 처리 전에도 budget, price deviation, reconcile freshness를 다시 확인하세요.";
  }
  if (!input.liveAutonomous.enabled) {
    return "M23 live-armed 운영이 필요하면 operator arm, budget, key scope evidence를 준비한 뒤 별도 env로 실행하세요.";
  }
  if (!input.liveTradingEnabled || input.paperNoKey) {
    return "실주문 검증이 필요하면 paper-only 구성을 해제하고 key scope evidence와 live trading 승인 근거를 먼저 확인하세요.";
  }
  if (!input.liveAutonomous.ready) {
    return input.liveAutonomous.action;
  }
  if (!hasUsableHeartbeat(input)) {
    return "market data heartbeat와 websocket 수신 상태를 복구한 뒤 다시 확인하세요.";
  }
  if (input.tradingState.newOrdersBlocked || input.tradingState.requiresManualReview) {
    return "kill switch reason과 manual review evidence를 확인하고 신규 entry를 재개하지 마세요.";
  }
  if (input.reconcile.result !== "SUCCESS") {
    return input.reconcile.actionRequired ?? "reconcile worker와 Upbit read-only 상태를 확인하세요.";
  }
  if (mode === "heartbeat_only") {
    return "heartbeat-only artifact는 preflight로만 사용하고 7일 closeout PASS 근거로 쓰지 마세요.";
  }
  return "status trace와 readiness를 확인하세요.";
}

function createMissingFact(
  statusLabel: string,
  message: string,
  observedAt: string,
  reason: string,
): LiveOpsObservedFact {
  return {
    statusLabel,
    message,
    observedAt: null,
    action: "M23 status provider에 해당 evidence source를 연결하세요.",
    trace: {
      source: "live_ops_status_summary",
      reason,
      generatedAt: observedAt,
    },
  };
}

function hasUsableHeartbeat(input: CreateLiveOpsStatusSummaryInput): boolean {
  if (input.marketData.updatedAt === null || !isConnectedMarketData(input.marketData.connectionStatus)) {
    return false;
  }

  const observedAtMs = Date.parse(input.observedAt);
  const updatedAtMs = Date.parse(input.marketData.updatedAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(updatedAtMs)) {
    return false;
  }

  const ageMs = observedAtMs - updatedAtMs;
  return ageMs >= 0 && ageMs <= maxLiveOpsHeartbeatAgeMs;
}

function isConnectedMarketData(connectionStatus: string): boolean {
  const normalized = connectionStatus.toLowerCase();
  return normalized === "connected" || normalized === "ok" || normalized === "healthy";
}

function labelOperatingMode(mode: LiveOpsOperatingMode): string {
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

function formatNullableKrw(value: string | null): string {
  return value === null ? "조회 불가" : `${value} KRW`;
}
