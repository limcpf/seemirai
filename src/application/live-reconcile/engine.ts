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
  const observedAt = normalizeObservedAt(input.observedAt);

  // 1. exchange order를 unified list로 합친다 (open + closed + lookup)
  const allExchangeOrders = prioritizeExchangeOrderSnapshots([
    ...input.exchangeOpenOrders,
    ...input.exchangeClosedOrders,
    ...input.orderLookups,
  ]);

  // 2. 주문 대조 — identity matching과 mismatch 분류
  const orderResults = reconcileOrders(
    allExchangeOrders,
    input.localOpenOrders,
    observedAt,
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
    observedAt,
    exchangeVerifiedLocalOrderIds,
  );
  allMismatches.push(...windowMismatches);

  // 4. WebSocket gap/stale 검사
  const wsMismatches = checkWebSocketGap(
    input.websocketContext,
    observedAt,
  );
  allMismatches.push(...wsMismatches);

  // 5. 잔고 locked 검증
  const balanceResult = checkBalanceLock(
    input.localOpenOrders,
    input.localBalances,
    input.exchangeBalances,
    observedAt,
  );
  allMismatches.push(...balanceResult.mismatches);

  // 6. fail-closed 판정
  const failClosedDecision = determineFailClosed(allMismatches);

  // 7. summary 생성
  const summary = buildSummary(
    allMismatches,
    countSummaryExchangeOpenOrders(allExchangeOrders),
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
 * 같은 주문의 여러 exchange snapshot 중 상태 복구에 더 강한 관측을 먼저 평가한다.
 *
 * capturedAt이 더 늦은 snapshot을 우선한다. 같은 시각이면 lookup/closed snapshot이
 * open 목록보다 더 강한 보강 관측일 수 있으므로 source rank를 tie-breaker로 쓴다. 이 함수는 입력 배열을 복사해 정렬하는
 * 순수 helper이며 DB write나 외부 API 호출을 하지 않는다.
 */
function prioritizeExchangeOrderSnapshots(
  exchangeOrders: readonly ReconcileExchangeOrderSnapshot[],
): ReconcileExchangeOrderSnapshot[] {
  return [...exchangeOrders].sort((left, right) => {
    const capturedAtDelta =
      toTimestampMs(right.capturedAt) -
      toTimestampMs(left.capturedAt);
    if (capturedAtDelta !== 0) {
      return capturedAtDelta;
    }

    return getExchangeSnapshotSourceRank(left) - getExchangeSnapshotSourceRank(right);
  });
}

/**
 * engine 경계에서 실행 시각을 ISO 문자열로 고정한다.
 *
 * 하위 policy는 evidence fingerprint와 occurredAt에 같은 문자열을 사용하므로,
 * Date 객체가 런타임 timezone 표현으로 문자열화되면 재시도 중복 차단 invariant가 깨진다.
 */
function normalizeObservedAt(observedAt: ReconcileEngineInput["observedAt"]): string {
  if (observedAt instanceof Date) {
    return observedAt.toISOString();
  }

  return observedAt;
}

/**
 * source ordering 전에 snapshot 관측 시각을 비교하기 위한 순수 변환 helper다.
 *
 * Date/string 입력을 같은 epoch millisecond로 바꿔 최신 REST open 관측이 오래된 lookup terminal 관측에
 * 밀리지 않도록 보장한다. 외부 side effect는 없다.
 */
function toTimestampMs(timestamp: ReconcileExchangeOrderSnapshot["capturedAt"]): number {
  return timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
}

function getExchangeSnapshotSourceRank(order: ReconcileExchangeOrderSnapshot): number {
  switch (order.source) {
    case "lookup":
      return 0;
    case "closed":
      return 1;
    case "open":
      return 2;
    case "ws":
      return 3;
  }
}

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
    case "ORDER_IDENTITY_CONFLICT":
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
  exchangeOpenOrderCount: number,
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
      exchange: exchangeOpenOrderCount,
      local: localOpenOrders.length,
    },
    balanceStatus,
    untrackedExchangeOrders: untracked,
    missingLocalOrders: missing,
    cancelFailures: cancelFails,
    windowExceededOrders: windowExceeded,
  };
}

/**
 * status/CLI summary에 표시할 거래소 미체결 주문 수를 계산한다.
 *
 * REST open뿐 아니라 lookup/ws에서 확인된 wait/watch 주문도 운영자가 보는
 * 노출 수에 포함한다. uuid/identifier가 있는 중복 source는 한 주문으로 접고,
 * fingerprint-only 행은 실제 복수 주문 가능성이 있어 행 단위로 보존한다.
 *
 * @param exchangeOrders reconcile engine에 입력된 거래소 주문 snapshot 전체
 * @returns 운영 요약에 표시할 거래소 미체결 주문 수
 */
function countSummaryExchangeOpenOrders(
  exchangeOrders: readonly ReconcileExchangeOrderSnapshot[],
): number {
  let count = 0;
  const seenStrongIdentities = new Set<string>();

  for (const exchangeOrder of exchangeOrders) {
    if (!isSummaryExchangeOpenOrder(exchangeOrder)) {
      continue;
    }

    const strongIdentity = getSummaryExchangeOpenOrderIdentity(exchangeOrder);
    if (strongIdentity !== undefined) {
      if (seenStrongIdentities.has(strongIdentity)) {
        continue;
      }
      seenStrongIdentities.add(strongIdentity);
    }

    count += 1;
  }

  return count;
}

/**
 * summary count에 포함할 거래소 미체결 snapshot인지 판정한다.
 *
 * closed source나 terminal 상태는 현재 열려 있는 노출이 아니므로 제외하고,
 * lookup/ws에서 wait/watch로 확인된 주문은 운영 summary에 포함한다.
 *
 * @param exchangeOrder 거래소 주문 snapshot
 * @returns summary open count 포함 여부
 */
function isSummaryExchangeOpenOrder(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
): boolean {
  return (
    (
      exchangeOrder.source === "open" ||
      exchangeOrder.source === "lookup" ||
      exchangeOrder.source === "ws"
    ) &&
    (exchangeOrder.exchangeStatus === "wait" || exchangeOrder.exchangeStatus === "watch")
  );
}

/**
 * summary count dedupe에 사용할 강한 거래소 주문 식별자를 반환한다.
 *
 * uuid가 있으면 uuid를 우선하고, 없으면 identifier를 사용한다. 둘 다 없으면
 * 동일 fingerprint의 실제 복수 주문을 구분할 수 없어 dedupe key를 반환하지 않는다.
 *
 * @param exchangeOrder 거래소 주문 snapshot
 * @returns 중복 source 제거용 강한 식별자 또는 undefined
 */
function getSummaryExchangeOpenOrderIdentity(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
): string | undefined {
  if (exchangeOrder.exchangeOrderId !== undefined) {
    return `uuid:${exchangeOrder.exchangeOrderId}`;
  }

  if (exchangeOrder.identifier !== undefined) {
    return `identifier:${exchangeOrder.identifier}`;
  }

  // fingerprint-only snapshot은 동일 가격/수량의 실제 복수 주문 가능성이 있어 summary에서도 행 단위로 보존한다.
  return undefined;
}
