import type { TimestampInput } from "../../domain/index.js";
import type {
  CreateLiveReconcileRuntimeSafeSummaryInput,
  LiveReconcileRuntimeSafeSummary,
  LiveReconcileRuntimeProfile,
  ReconcileStatusSummary,
  ReconcileWebSocketStatus,
} from "./types.js";

/**
 * reconcile runtime guard 상태를 secret-safe 요약으로 변환한다.
 *
 * credential 원문은 boolean으로만 낮추며, 운영자에게는 profile/scope/evidence와 필요한 다음 조치만 보여준다.
 * 이 함수는 순수 변환 함수이며 private client나 worker를 만들지 않는다.
 *
 * @param input guard 상태를 포함한 safe summary 입력
 * @returns 운영자 표면에 노출 가능한 reconcile runtime 요약
 */
export function createLiveReconcileRuntimeSafeSummary(
  input: CreateLiveReconcileRuntimeSafeSummaryInput,
): LiveReconcileRuntimeSafeSummary {
  if (!input.liveReconcileEnabled || !input.reconcileConfig.enabled) {
    return {
      enabled: false,
      profile: null,
      credentialsConfigured: false,
      keyScopes: [],
      keyScopeEvidenceId: null,
      statusLabel: "비활성",
      message: "Live reconcile runtime guard가 꺼져 있어 실계좌 상태 대조를 실행하지 않는다.",
      action: "실계좌 상태 대조가 필요할 때 SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1과 private smoke guard를 설정한다.",
      trace: {
        source: "live_reconcile_runtime",
        reason: "reconcile_guard_disabled",
        liveReconcileEnabled: input.liveReconcileEnabled,
      },
    };
  }

  const profile: LiveReconcileRuntimeProfile = "LIVE_READ_ONLY_RECONCILE";
  // Upbit secret 원문은 summary 경계에서 boolean으로만 낮춰 HTTP/log/report로 흘러가지 않게 한다.
  const credentialsConfigured =
    input.reconcileConfig.upbitAccessKey.length > 0 &&
    input.reconcileConfig.upbitSecretKey.length > 0;

  return {
    enabled: true,
    profile,
    credentialsConfigured,
    keyScopes: [...input.reconcileConfig.keyScopes],
    keyScopeEvidenceId: input.reconcileConfig.keyScopeEvidenceId,
    statusLabel: "reconcile guard 충족",
    message: "M16 read-only reconcile guard가 충족됐다. 실제 대조 실행은 별도 worker 경계에서만 수행하며 주문 side effect는 생성하지 않는다.",
    action: "실행 직전 key scope evidence와 credential을 다시 확인한다. 주문하기 권한이 관찰되면 worker가 시작되지 않는다.",
    trace: {
      source: "live_reconcile_runtime",
      reason: "reconcile_guard_ready",
      liveReconcileEnabled: input.liveReconcileEnabled,
    },
  };
}

/**
 * reconcile engine 출력과 runtime 상태를 `/status` 또는 CLI에 노출 가능한 summary로 변환한다.
 *
 * 내부 식별자(run id, mismatch id, correlation id)는 `trace` 하위 객체에 분리하고,
 * mismatch trace detail, raw order detail, fingerprint는 노출하지 않는다. 이 함수는 순수 변환 경계이며
 * DB 조회나 외부 API 호출 side effect를 만들지 않는다.
 *
 * @param input reconcile 실행 결과와 WebSocket 상태
 * @returns 운영자 표면에 노출 가능한 reconcile status summary
 */
export function createReconcileStatusSummary(input: {
  lastReconcileAt: string | null;
  reconcileResult: "CLEAN" | "MISMATCH_DETECTED" | null;
  mismatchCount: number | null;
  openOrderCount: number | null;
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" | null;
  websocketStatus: ReconcileWebSocketStatus;
  runId?: string;
  correlationId?: string;
}): ReconcileStatusSummary {
  const lastReconcileAt = input.lastReconcileAt;
  const reconcileResult = input.reconcileResult;
  const mismatchCount = input.mismatchCount;
  const openOrderCount = input.openOrderCount;
  const balanceStatus = input.balanceStatus;
  const websocketStatus = input.websocketStatus;

  // reconcile이 한 번도 실행되지 않은 상태
  if (reconcileResult === null) {
    return {
      lastReconcileAt: null,
      result: "SKIPPED",
      mismatchCount: null,
      openOrderCount: null,
      balanceStatus: "UNAVAILABLE",
      websocketStatus,
      actionRequired: "reconcile 실행 필요",
      message: "아직 reconcile이 실행되지 않았다. 실계좌 상태 대조를 시작하려면 reconcile worker를 활성화한다.",
      trace: {
        source: "live_reconcile_status",
        reason: "reconcile_not_run",
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      },
    };
  }

  // reconcile 실행 결과를 기반으로 summary 생성
  const result = mapReconcileResult(reconcileResult, balanceStatus);
  const actionRequired = buildReconcileActionRequired(reconcileResult, balanceStatus, mismatchCount);
  const message = buildReconcileMessage(reconcileResult, balanceStatus, mismatchCount, openOrderCount);

  return {
    lastReconcileAt,
    result,
    mismatchCount,
    openOrderCount,
    balanceStatus: mapBalanceStatus(balanceStatus),
    websocketStatus,
    actionRequired,
    message,
    trace: {
      source: "live_reconcile_status",
      reason: `reconcile_${reconcileResult.toLowerCase()}`,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    },
  };
}

/**
 * reconcile engine 결과를 `/status` 표시용 result code로 변환한다.
 *
 * CLEAN은 성공, MISMATCH_DETECTED는 불일치 발견이다. 잔고 스냅샷 판정 불가가 있으면
 * 결과와 무관하게 UNAVAILABLE로 낮춘다.
 */
function mapReconcileResult(
  reconcileResult: "CLEAN" | "MISMATCH_DETECTED",
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" | null,
): ReconcileStatusSummary["result"] {
  if (balanceStatus === "NOT_AVAILABLE") {
    return "FAILED";
  }

  if (reconcileResult === "CLEAN") {
    return "SUCCESS";
  }

  return "MISMATCH_DETECTED";
}

/**
 * balance status를 status summary의 canonical 상태로 변환한다.
 */
function mapBalanceStatus(
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" | null,
): "OK" | "STALE" | "UNAVAILABLE" {
  if (balanceStatus === "NOT_AVAILABLE" || balanceStatus === null) {
    return "UNAVAILABLE";
  }

  if (balanceStatus === "LOCK_MISMATCH") {
    return "STALE";
  }

  return "OK";
}

/**
 * reconcile 결과를 기반으로 한국어 필요 조치 문구를 생성한다.
 *
 * @param reconcileResult CLEAN 또는 MISMATCH_DETECTED
 * @param balanceStatus 잔고 상태
 * @param mismatchCount mismatch 수
 * @returns 운영자에게 표시할 필요 조치
 */
function buildReconcileActionRequired(
  reconcileResult: "CLEAN" | "MISMATCH_DETECTED",
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" | null,
  mismatchCount: number | null,
): string {
  if (balanceStatus === "NOT_AVAILABLE") {
    return "잔고 스냅샷이 없어 상태 판정이 불가능합니다. 잔고 조회 복구 후 reconcile을 재실행하거나 수동으로 확인하세요.";
  }

  if (reconcileResult === "CLEAN") {
    if (balanceStatus === "LOCK_MISMATCH") {
      return "주문 상태는 일치하지만 잠김 잔고에 불일치가 있습니다. 거래소와 로컬 잔고를 직접 대조한 뒤 reconcile을 재실행하세요.";
    }
    return "정상";
  }

  // MISMATCH_DETECTED
  const count = mismatchCount ?? 0;
  if (count === 0) {
    return "불일치 확인 필요";
  }

  return `불일치 ${count}건을 확인하세요. 신규 주문은 fail-closed 상태입니다. 모든 불일치를 해소한 뒤 kill switch를 NORMAL로 복구하세요.`;
}

/**
 * reconcile 결과를 기반으로 한국어 상태 메시지를 생성한다.
 *
 * @param reconcileResult CLEAN 또는 MISMATCH_DETECTED
 * @param balanceStatus 잔고 상태
 * @param mismatchCount mismatch 수
 * @param openOrderCount 거래소 open order 수
 * @returns 운영자에게 표시할 설명 메시지
 */
function buildReconcileMessage(
  reconcileResult: "CLEAN" | "MISMATCH_DETECTED",
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" | null,
  mismatchCount: number | null,
  openOrderCount: number | null,
): string {
  const parts: string[] = [];

  if (reconcileResult === "CLEAN") {
    parts.push("거래소-로컬 상태 일치: 모든 미체결 주문과 잔고가 정상입니다.");
  } else {
    const count = mismatchCount ?? 0;
    parts.push(`불일치 발견: ${count}건의 불일치가 감지되었습니다.`);
  }

  if (openOrderCount !== null) {
    parts.push(`현재 거래소 미체결 주문 ${openOrderCount}건.`);
  }

  if (balanceStatus === "LOCK_MISMATCH") {
    parts.push("잠김 잔고 불일치가 있습니다.");
  } else if (balanceStatus === "NOT_AVAILABLE") {
    parts.push("잔고 스냅샷이 없어 상태 판정이 불가능합니다.");
  }

  return parts.join(" ");
}

/**
 * ReconcileWebSocketStatus를 한국어 label로 변환한다.
 *
 * 순수 변환 함수이며 외부 side effect가 없다.
 */
export function describeReconcileWebSocketStatus(status: ReconcileWebSocketStatus): string {
  switch (status) {
    case "CONNECTED":
      return "연결됨";
    case "DISCONNECTED":
      return "연결 끊김";
    case "RECONNECTING":
      return "재연결 중";
    case "DEGRADED":
      return "성능 저하";
  }
}
