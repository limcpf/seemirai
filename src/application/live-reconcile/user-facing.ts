import type {
  ReconcileMismatchType,
  ReconcileSeverity,
} from "../../domain/live-reconcile.js";

/* ============================================================
 * User-Facing Message / Action 생성기
 *
 * mismatch type별 한국어 사용자 메시지와 필요 조치 문구를 생성한다.
 * 안정적인 내부 식별자와 진단 정보는 trace로 분리하고,
 * 이 모듈은 사용자 표면 문자열만 관리한다.
 *
 * 모든 함수는 순수 함수이며 side effect가 없다.
 * ============================================================ */

/**
 * mismatchType에 해당하는 severity 기본값을 반환한다.
 */
export function getDefaultSeverity(mismatchType: ReconcileMismatchType): ReconcileSeverity {
  switch (mismatchType) {
    case "UNTRACKED_EXCHANGE_OPEN_ORDER":
      return "WARN";
    case "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE":
      return "ERROR";
    case "PARTIAL_FILL_MISMATCH":
      return "WARN";
    case "CANCEL_FAILURE_RETRY_NEEDED":
      return "ERROR";
    case "EXCHANGE_CANCEL_STATE_MISMATCH":
      return "ERROR";
    case "ORDER_STATE_ADVANCEMENT_BLOCKED":
      return "ERROR";
    case "ORDER_IDENTITY_CONFLICT":
      return "ERROR";
    case "BALANCE_LOCK_MISMATCH":
      return "ERROR";
    case "BALANCE_SNAPSHOT_UNAVAILABLE":
      return "ERROR";
    case "CLOSED_ORDER_WINDOW_EXCEEDED":
      return "WARN";
    case "WEBSOCKET_GAP_MANUAL_REVIEW":
      return "ERROR";
  }
}

/**
 * mismatchType별 한국어 분류명을 반환한다.
 *
 * `/status`나 CLI 요약에서 사용할 짧은 레이블이다.
 */
export function getMismatchTypeLabel(mismatchType: ReconcileMismatchType): string {
  switch (mismatchType) {
    case "UNTRACKED_EXCHANGE_OPEN_ORDER":
      return "거래소 미체결 주문 누락";
    case "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE":
      return "로컬 미체결 주문 거래소 불일치";
    case "PARTIAL_FILL_MISMATCH":
      return "부분 체결 수량 불일치";
    case "CANCEL_FAILURE_RETRY_NEEDED":
      return "취소 실패";
    case "EXCHANGE_CANCEL_STATE_MISMATCH":
      return "거래소 취소 상태 불일치";
    case "ORDER_STATE_ADVANCEMENT_BLOCKED":
      return "주문 상태 전진 불가";
    case "ORDER_IDENTITY_CONFLICT":
      return "주문 식별자 충돌";
    case "BALANCE_LOCK_MISMATCH":
      return "잠김 잔고 불일치";
    case "BALANCE_SNAPSHOT_UNAVAILABLE":
      return "잔고 스냅샷 판정 불가";
    case "CLOSED_ORDER_WINDOW_EXCEEDED":
      return "체결 조회 기간 초과";
    case "WEBSOCKET_GAP_MANUAL_REVIEW":
      return "WebSocket 연결 불연속";
  }
}

/**
 * reconcile summary 결과에 대한 한국어 설명을 생성한다.
 *
 * @returns "정상", "불일치 발견", "잔고 판정 불가" 등
 */
export function describeReconcileSummary(
  result: "CLEAN" | "MISMATCH_DETECTED",
  mismatchCount: number,
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE",
): string {
  const parts: string[] = [];

  if (result === "CLEAN") {
    parts.push("✅ 거래소-로컬 상태 일치: 모든 미체결 주문과 잔고가 정상입니다.");
  } else {
    parts.push(`⚠️ 불일치 발견: ${mismatchCount}건의 불일치가 감지되었습니다.`);
  }

  if (balanceStatus === "LOCK_MISMATCH") {
    parts.push("잠김 잔고 불일치가 있습니다.");
  } else if (balanceStatus === "NOT_AVAILABLE") {
    parts.push("잔고 정보가 없어 잠김 잔고 검증을 건너뛰었습니다.");
  }

  return parts.join(" ");
}

/**
 * fail-closed 상황에서 운영자에게 제시할 필요 조치 문구를 생성한다.
 */
export function describeFailClosedAction(
  targetKillSwitchState?: string,
): string {
  if (targetKillSwitchState === undefined) {
    return "불일치가 해소될 때까지 신규 주문을 제출하지 마세요.";
  }

  switch (targetKillSwitchState) {
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 검토 필요: 모든 불일치를 해소하고 kill switch를 NORMAL로 직접 복구하기 전까지 신규 주문이 차단됩니다.";
    case "NEW_ORDERS_BLOCKED":
      return "신규 주문 차단: 불일치가 감지되어 신규 주문이 차단됩니다. 불일치 해소 후 kill switch를 NORMAL로 복구하세요.";
    default:
      return `Kill switch 상태(${targetKillSwitchState})로 인해 신규 주문이 차단됩니다.`;
  }
}
