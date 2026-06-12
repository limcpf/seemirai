import type { JsonRecord } from "../../domain/index.js";

/**
 * M23 live ops summary의 운영 health code다.
 *
 * HTTP status code와 분리된 사용자-facing 업무 상태이며, `warning`과 `unavailable`은 운영자가 신규 주문 가능 여부를 다시
 * 확인해야 하는 신호다. 이 타입은 표현 contract라서 DB 조회, broker 호출, notification side effect를 만들지 않는다.
 */
export type LiveOpsOperationalStatus = "ok" | "warning" | "unavailable";

/**
 * 운영자가 보는 M23 runtime mode다.
 *
 * config enum을 그대로 노출하지 않고, dry-run/heartbeat-only/live armed/live order capable처럼 운영자가 행동을 결정할 수 있는
 * 언어로 낮춘다. mode 판정은 safe summary 입력만 사용하며 외부 side effect가 없다.
 */
export type LiveOpsOperatingMode = "dry_run" | "heartbeat_only" | "live_armed" | "live_order_capable";

/**
 * M23 status 표면에 노출할 단일 관측 사실이다.
 *
 * 최신 후보, 판단, 주문 시도, 체결/취소처럼 source가 서로 다른 이벤트를 같은 안전한 모양으로 표현한다. raw order/provider
 * payload와 credential은 `trace`에도 넣지 않는 것이 invariant다.
 */
export interface LiveOpsObservedFact {
  statusLabel: string;
  message: string;
  observedAt: string | null;
  action: string | null;
  trace: JsonRecord;
}

/**
 * M22/M23 startup guard를 M23 운영 표면에서 재사용하기 위한 최소 snapshot이다.
 *
 * runtime layer의 config 객체를 application layer가 직접 참조하지 않도록 필요한 safe field만 복사한다. evidence id 원문은 이미
 * boolean으로 낮아진 값만 허용한다.
 */
export interface LiveOpsRuntimeGuardSummary {
  enabled: boolean;
  ready: boolean;
  allowedMarkets: readonly string[];
  maxOrderKrw: string;
  dailyAutonomousNotionalLimitKrw: string;
  maxOpenPositionNotionalKrw: string;
  keyScopeEvidenceConfigured: boolean;
  telegramInboundReady: boolean;
  reconcileFresh: boolean;
  pnlStatusReady: boolean;
  decisionLedgerReady: boolean;
  exitEngineReady: boolean;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: JsonRecord;
}

/**
 * M23 readiness summary다.
 *
 * M20/M16/M17/M18/M19 readiness와 key scope evidence를 한 화면에 보여주기 위한 구조다. 값은 이미 계산된 safe boolean만 받으며,
 * 이 타입 자체는 readiness provider 호출이나 DB write side effect를 만들지 않는다.
 */
export interface LiveOpsReadinessSummary {
  keyScopeSafe: boolean;
  telegramInboundReady: boolean;
  reconcileFresh: boolean;
  pnlStatusReady: boolean;
  decisionLedgerReady: boolean;
  exitEngineReady: boolean;
}

/**
 * M23 reconcile surface가 읽는 최소 summary다.
 *
 * mismatch detail, raw order, balance raw payload는 포함하지 않고 운영 판단에 필요한 결과, 미체결 수, 최신 실행 시각만 보존한다.
 */
export interface LiveOpsReconcileSummary {
  result: string;
  mismatchCount: number | null;
  openOrderCount: number | null;
  lastReconcileAt: string | null;
  actionRequired: string | null;
}

/**
 * M23 PnL/budget surface가 읽는 최소 PnL summary다.
 *
 * 금액은 이미 formatter-safe 문자열이어야 하고, 결측은 null로 표현한다. 0과 unavailable을 구분하기 위해 null을 숫자 0으로
 * 보정하지 않는다.
 */
export interface LiveOpsPnLSummary {
  statusLabel: string;
  latestCapturedAt: string | null;
  latestEquityKrw: string | null;
  latestRealizedPnlKrw: string | null;
  latestUnrealizedPnlKrw: string | null;
}

/**
 * M23 budget/exposure summary다.
 *
 * 상한 값은 config에서 읽은 safe 문자열이고 사용량/노출 값은 runtime 또는 reconcile/PnL provider가 주입할 수 있다. 값이 없으면
 * null로 남겨 운영자가 closeout evidence 부족을 확인할 수 있게 한다.
 */
export interface LiveOpsBudgetSummary {
  maxOrderKrw: string;
  dailyAutonomousNotionalLimitKrw: string;
  maxOpenPositionNotionalKrw: string;
  dailyNotionalUsedKrw: string | null;
  openExposureKrw: string | null;
  realizedPnlKrw: string | null;
  unrealizedPnlKrw: string | null;
}

/**
 * M23 risk block summary다.
 *
 * kill switch와 manual review 상태를 주문 가능 여부 판정에 연결한다. 내부 reason code는 추적용으로만 보존하고 사용자-facing
 * message/action은 상위 summary가 한국어로 제공한다.
 */
export interface LiveOpsRiskBlockSummary {
  killSwitchState: string;
  newOrdersBlocked: boolean;
  requiresManualReview: boolean;
  blockedReason: string | null;
}

/**
 * M23 alert retry/cooldown summary다.
 *
 * Telegram provider raw 응답 없이 durable alert 상태의 마지막 전송/스킵 시각과 사용자가 읽을 상태 문구만 포함한다.
 */
export interface LiveOpsAlertRetrySummary {
  statusLabel: string;
  lastSentAt: string | null;
  lastSkippedAt: string | null;
  action: string | null;
}

/**
 * M23 live ops status summary 생성 입력이다.
 *
 * caller는 이미 secret-safe로 낮춘 runtime, reconcile, PnL, alert, optional event summary를 전달한다. 이 함수군은 입력을
 * 조합해 `/status`, Telegram, daily report에 공통으로 노출할 summary를 만들 뿐 외부 API, DB write, broker, notification
 * side effect를 수행하지 않는다.
 */
export interface CreateLiveOpsStatusSummaryInput {
  observedAt: string;
  runtimeMode: string;
  paperNoKey: boolean;
  liveTradingEnabled: boolean;
  liveAutonomous: LiveOpsRuntimeGuardSummary;
  marketData: {
    connectionStatus: string;
    lagMs: number | null;
    updatedAt: string | null;
  };
  reconcile: LiveOpsReconcileSummary;
  pnl: LiveOpsPnLSummary;
  tradingState: LiveOpsRiskBlockSummary;
  alerts: LiveOpsAlertRetrySummary;
  latestHeartbeat?: LiveOpsObservedFact | null;
  latestCandidate?: LiveOpsObservedFact | null;
  latestDecision?: LiveOpsObservedFact | null;
  latestOrderAttempt?: LiveOpsObservedFact | null;
  latestFillOrCancel?: LiveOpsObservedFact | null;
  dailyNotionalUsedKrw?: string | null;
  openExposureKrw?: string | null;
}

/**
 * HTTP status, Telegram `/status`, daily report가 공유하는 M23 live ops safe summary다.
 *
 * 첫 화면에는 한국어 상태, 원인, 영향, 필요 조치를 배치하고, 내부 reason code와 source 식별자는 `trace`에 분리한다. raw provider
 * payload, raw order detail, credential, Telegram token을 포함하지 않는 것이 invariant다.
 */
export interface LiveOpsStatusSummary {
  status: LiveOpsOperationalStatus;
  statusLabel: string;
  message: string;
  impact: string | null;
  action: string | null;
  mode: LiveOpsOperatingMode;
  liveEnabled: boolean;
  liveOrderCapable: boolean;
  paperNoKey: boolean;
  readiness: LiveOpsReadinessSummary;
  latestHeartbeat: LiveOpsObservedFact;
  latestCandidate: LiveOpsObservedFact;
  latestDecision: LiveOpsObservedFact;
  latestOrderAttempt: LiveOpsObservedFact;
  latestFillOrCancel: LiveOpsObservedFact;
  reconcile: LiveOpsReconcileSummary;
  budget: LiveOpsBudgetSummary;
  riskBlock: LiveOpsRiskBlockSummary;
  alertRetry: LiveOpsAlertRetrySummary;
  trace: JsonRecord;
}
