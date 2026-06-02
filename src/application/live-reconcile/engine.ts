import { checkBalanceLock } from "./balance-policy.js";
import { checkClosedOrderWindow, checkWebSocketGap, reconcileOrders } from "./mismatch-policy.js";
import type {
  ReconcileEngineInput,
  ReconcileEngineOutput,
  ReconcileExchangeOrderSnapshot,
  ReconcileLocalOrderSnapshot,
  ReconcileMismatchEvidence,
  ReconcileStateAdvancementCandidate,
  ReconcileSummary,
} from "../../domain/live-reconcile.js";
import type { KillSwitchState } from "../../domain/state-machines.js";

/* ============================================================
 * Reconcile Diff Engine — 순수 Orchestration
 *
 * 모든 하위 policy 모듈을 호출해 mismatch evidence, state advancement
 * 후보, fail-closed 판정을 종합한다. 이 모듈은 DB write, API 호출,
 * runtime side effect를 수행하지 않는다.
 *
 * 입력: ReconcileEngineInput (exchange snapshot, local snapshot, ws context)
 * 출력: ReconcileEngineOutput (summary, mismatches, advancements, failClosed)
 * ============================================================ */

/**
 * Reconcile diff engine의 유일한 public entry point다.
 *
 * exchange 주문/잔고 snapshot과 로컬 주문/잔고 snapshot을 받아
 * 결정론적 mismatch taxonomy와 fail-closed decision을 반환한다.
 *
 * @param input 모든 snapshot이 포함된 reconcile 입력
 * @returns mismatch evidence, state advancement 후보, fail-closed 판정
 */
export function runReconcileEngine(input: ReconcileEngineInput): ReconcileEngineOutput {
  const allMismatches: ReconcileMismatchEvidence[] = [];
  const allStateAdvancements: ReconcileStateAdvancementCandidate[] = [];

  // 1. exchange order를 unified list로 합친다 (open + closed + lookup)
  const allExchangeOrders: ReconcileExchangeOrderSnapshot[] = [
    ...input.exchangeOpenOrders,
    ...input.exchangeClosedOrders,
    ...input.orderLookups,
  ];

  // 2. 주문 대조 — identity matching과 mismatch 분류
  const orderResults = reconcileOrders(
    allExchangeOrders,
    input.localOpenOrders,
    input.observedAt as string,
  );

  for (const result of orderResults) {
    allMismatches.push(...result.mismatches);
    if (result.stateAdvancement !== undefined) {
      allStateAdvancements.push(result.stateAdvancement);
    }
  }

  const exchangeVerifiedLocalOrderIds = new Set<string>();
  for (const result of orderResults) {
    if (result.identityMatch !== undefined && result.localOrderId !== undefined) {
      exchangeVerifiedLocalOrderIds.add(result.localOrderId);
    }
  }

  // 3. closed order window 밖 주문 검사
  const windowMismatches = checkClosedOrderWindow(
    input.localOpenOrders,
    input.closedOrderWindow,
    input.observedAt as string,
    exchangeVerifiedLocalOrderIds,
  );
  allMismatches.push(...windowMismatches);

  // 4. WebSocket gap/stale 검사
  const wsMismatches = checkWebSocketGap(
    input.websocketContext,
    input.observedAt as string,
  );
  allMismatches.push(...wsMismatches);

  // 5. 잔고 locked 검증
  const balanceResult = checkBalanceLock(
    input.localOpenOrders,
    input.localBalances,
    input.exchangeBalances,
    input.observedAt as string,
  );
  allMismatches.push(...balanceResult.mismatches);

  // 6. fail-closed 판정
  const failClosedDecision = determineFailClosed(allMismatches);

  // 7. summary 생성
  const summary = buildSummary(
    allMismatches,
    input.exchangeOpenOrders,
    input.localOpenOrders,
    balanceResult.status,
  );

  const output: ReconcileEngineOutput = {
    summary,
    mismatches: allMismatches,
    stateAdvancements: allStateAdvancements,
    failClosed: failClosedDecision.failClosed,
  };

  if (failClosedDecision.targetKillSwitchState !== undefined) {
    return {
      ...output,
      targetKillSwitchState: failClosedDecision.targetKillSwitchState,
    };
  }

  return output;
}

/* ============================================================
 * 내부 구현
 * ============================================================ */

/**
 * 전체 mismatch evidence 목록에서 fail-closed 여부와 target kill switch 상태를 판정한다.
 *
 * 규칙:
 * - mismatch가 하나라도 있으면 severity와 무관하게 failClosed=true
 * - 수동 확인이 필요한 mismatch는 MANUAL_REVIEW_REQUIRED로 승격
 * - 그 외 mismatch는 신규 주문 차단(NEW_ORDERS_BLOCKED)
 * - MANUAL_REVIEW_REQUIRED는 더 강한 상태이므로 같은 run 안에서 낮추지 않음
 */
function determineFailClosed(
  mismatches: readonly ReconcileMismatchEvidence[],
): { failClosed: boolean; targetKillSwitchState?: KillSwitchState } {
  if (mismatches.length === 0) {
    return { failClosed: false };
  }

  let targetKillSwitchState: KillSwitchState = "NEW_ORDERS_BLOCKED";

  for (const mismatch of mismatches) {
    if (requiresManualReview(mismatch.mismatchType)) {
      // 수동 검토는 단순 신규 주문 차단보다 강한 운영 상태라 이후 낮은 mismatch가 덮어쓰면 안 된다.
      targetKillSwitchState = "MANUAL_REVIEW_REQUIRED";
    }
  }

  return { failClosed: true, targetKillSwitchState };
}

/**
 * mismatch 유형이 kill switch의 수동 검토 상태를 요구하는지 판단한다.
 *
 * 이 함수는 ReconcileEngine 내부의 순수 정책 경계이며 외부 side effect가 없다.
 * 입력은 append-only evidence의 mismatch type이고, 출력은 target kill switch를
 * `MANUAL_REVIEW_REQUIRED`까지 올려야 하는지 여부다. 새로운 mismatch 유형을
 * 추가할 때는 자동 복구 가능성과 사람 확인 필요성을 명시적으로 분류해야 한다.
 */
function requiresManualReview(
  mismatchType: ReconcileMismatchEvidence["mismatchType"],
): boolean {
  switch (mismatchType) {
    case "CANCEL_FAILURE_RETRY_NEEDED":
    case "EXCHANGE_CANCEL_STATE_MISMATCH":
    case "ORDER_STATE_ADVANCEMENT_BLOCKED":
    case "WEBSOCKET_GAP_MANUAL_REVIEW":
    case "BALANCE_LOCK_MISMATCH":
    case "BALANCE_SNAPSHOT_UNAVAILABLE":
    case "CLOSED_ORDER_WINDOW_EXCEEDED":
      return true;
    case "UNTRACKED_EXCHANGE_OPEN_ORDER":
    case "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE":
    case "PARTIAL_FILL_MISMATCH":
      return false;
  }
}

/**
 * 전체 결과를 바탕으로 ReconcileSummary를 생성한다.
 */
function buildSummary(
  mismatches: readonly ReconcileMismatchEvidence[],
  exchangeOpenOrders: readonly ReconcileExchangeOrderSnapshot[],
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE",
): ReconcileSummary {
  const result = mismatches.length > 0 ? "MISMATCH_DETECTED" : "CLEAN";

  const untracked = mismatches.filter(
    (m) => m.mismatchType === "UNTRACKED_EXCHANGE_OPEN_ORDER",
  ).length;
  const missing = mismatches.filter(
    (m) => m.mismatchType === "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
  ).length;
  const cancelFails = mismatches.filter(
    (m) => m.mismatchType === "CANCEL_FAILURE_RETRY_NEEDED",
  ).length;
  const windowExceeded = mismatches.filter(
    (m) => m.mismatchType === "CLOSED_ORDER_WINDOW_EXCEEDED",
  ).length;

  return {
    result,
    mismatchCount: mismatches.length,
    openOrderCount: {
      exchange: exchangeOpenOrders.length,
      local: localOpenOrders.length,
    },
    balanceStatus,
    untrackedExchangeOrders: untracked,
    missingLocalOrders: missing,
    cancelFailures: cancelFails,
    windowExceededOrders: windowExceeded,
  };
}
