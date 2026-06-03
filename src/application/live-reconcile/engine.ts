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
import { parseFinancialDecimal } from "../../shared/decimal.js";

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

  // 1. exchange order를 unified list로 합친다 (open + closed + lookup + ws myOrder)
  const websocketOrderSnapshots = buildWebSocketOrderSnapshots(input.websocketContext);
  const allExchangeOrders = prioritizeExchangeOrderSnapshots([
    ...input.exchangeOpenOrders,
    ...input.exchangeClosedOrders,
    ...input.orderLookups,
    ...websocketOrderSnapshots,
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
    countSummaryExchangeOpenOrders(allExchangeOrders, input.localOpenOrders),
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
 * private WebSocket myOrder 이벤트를 주문 diff용 거래소 snapshot으로 변환한다.
 *
 * REST snapshot이 bootstrap source of truth지만, bootstrap 이후 들어온 myOrder는
 * 최신 상태 보강 근거가 될 수 있다. 필수 주문 필드가 없는 이벤트는 raw payload를
 * 추측하지 않고 제외해 잘못된 상태 전진 후보를 만들지 않는다.
 *
 * @param websocketContext private WebSocket 이벤트와 bootstrap context
 * @returns diff engine에서 평가할 ws source 주문 snapshot 목록
 */
function buildWebSocketOrderSnapshots(
  websocketContext: ReconcileEngineInput["websocketContext"],
): ReconcileExchangeOrderSnapshot[] {
  if (!canUseWebSocketOrderSnapshots(websocketContext)) {
    return [];
  }

  const snapshots: ReconcileExchangeOrderSnapshot[] = [];

  for (const event of websocketContext.events) {
    const snapshot = toWebSocketOrderSnapshot(event);
    if (snapshot !== undefined) {
      snapshots.push(snapshot);
    }
  }

  return snapshots;
}

/**
 * 단일 myOrder 이벤트 payload를 ReconcileExchangeOrderSnapshot으로 정규화한다.
 *
 * Upbit 원천 필드(`uuid`, `state`, `volume`, `remaining_volume`, `price`)와
 * 이미 정규화된 camelCase 필드를 모두 허용한다. 변환은 순수하게 payload를
 * 읽기만 하며 외부 side effect나 DB write를 만들지 않는다.
 *
 * @param event private WebSocket 이벤트
 * @returns 주문 snapshot 또는 필수 필드 누락 시 undefined
 */
function toWebSocketOrderSnapshot(
  event: ReconcileEngineInput["websocketContext"]["events"][number],
): ReconcileExchangeOrderSnapshot | undefined {
  if (event.type !== "myOrder") {
    return undefined;
  }

  const payload = event.payload;
  const market = readStringField(payload, "market", "code", "cd");
  const side = normalizeWebSocketOrderSide(readStringField(payload, "side", "ask_bid", "ab"));
  const rawExchangeStatus = readStringField(
    payload,
    "exchangeStatus",
    "exchange_status",
    "state",
    "s",
  );
  const remainingQuantity = readStringField(
    payload,
    "remainingQuantity",
    "remaining_quantity",
    "remainingVolume",
    "remaining_volume",
    "rv",
  );
  const exchangeStatus = normalizeWebSocketExchangeStatus(rawExchangeStatus, remainingQuantity);
  const requestedQuantity = readWebSocketRequestedQuantity(payload, rawExchangeStatus);

  if (
    market === undefined ||
    side === undefined ||
    exchangeStatus === undefined ||
    requestedQuantity === undefined
  ) {
    return undefined;
  }

  const snapshot: ReconcileExchangeOrderSnapshot = {
    market,
    side,
    exchangeStatus,
    requestedQuantity,
    source: "ws",
    capturedAt: event.occurredAt,
  };
  const exchangeOrderId = readStringField(
    payload,
    "exchangeOrderId",
    "exchange_order_id",
    "orderId",
    "order_id",
    "uuid",
    "uid",
  );
  const identifier = readStringField(payload, "identifier");
  const requestedPrice = readStringField(payload, "requestedPrice", "requested_price", "price", "p");

  if (exchangeOrderId !== undefined) {
    snapshot.exchangeOrderId = exchangeOrderId;
  }
  if (identifier !== undefined) {
    snapshot.identifier = identifier;
  }
  if (remainingQuantity !== undefined) {
    snapshot.remainingQuantity = remainingQuantity;
  }
  if (requestedPrice !== undefined) {
    snapshot.requestedPrice = requestedPrice;
  }

  return snapshot;
}

/**
 * WebSocket 주문 snapshot을 상태 diff 근거로 사용할 수 있는지 판단한다.
 *
 * REST bootstrap 기준점이 없거나 실제 liveness gap이 있으면 myOrder 이벤트의
 * 순서를 증명할 수 없으므로, gap evidence는 남기되 상태 전진 후보 입력에서는
 * 제외한다. staleSince 단독 증거는 event-only stream 특성상 gap으로 보지 않는다.
 *
 * @param websocketContext private WebSocket 이벤트와 gap context
 * @returns myOrder 이벤트를 diff snapshot으로 승격해도 되는지 여부
 */
function canUseWebSocketOrderSnapshots(
  websocketContext: ReconcileEngineInput["websocketContext"],
): boolean {
  if (websocketContext.bootstrapCompleteAt === undefined) {
    return false;
  }

  const evidence = websocketContext.disconnectEvidence;
  if (evidence === undefined) {
    return true;
  }

  return !(
    evidence.disconnectedAt !== undefined ||
    evidence.reconnectedAt !== undefined ||
    (evidence.gapDurationMs ?? 0) > 0 ||
    (evidence.reconnectCount ?? 0) > 0
  );
}

/**
 * WebSocket payload에서 주문 기준 수량을 읽는다.
 *
 * normalized myOrder event의 `volume`은 이미 주문 기준 수량이지만, Upbit raw
 * `state=trade` payload의 `volume`은 단일 체결량이다. raw trade 이벤트는
 * 정규화 필드나 `remaining + executed` 복원이 가능할 때만 snapshot으로 쓴다.
 *
 * @param payload private WebSocket myOrder payload
 * @param rawExchangeStatus 원천 myOrder state
 * @returns 주문 기준 수량 또는 복원 불가 시 undefined
 */
function readWebSocketRequestedQuantity(
  payload: Record<string, unknown>,
  rawExchangeStatus: string | undefined,
): string | undefined {
  const normalizedQuantity = readStringField(
    payload,
    "requestedQuantity",
    "requested_quantity",
    "orderQuantity",
    "order_quantity",
  );
  if (normalizedQuantity !== undefined) {
    return normalizedQuantity;
  }

  const payloadType = readStringField(payload, "type");
  const isRawTradeEvent =
    rawExchangeStatus === "trade" && payloadType !== "MY_ORDER";
  if (isRawTradeEvent) {
    return reconstructTradeOrderQuantity(payload);
  }

  return readStringField(payload, "volume", "v");
}

/**
 * raw myOrder trade 이벤트에서 주문 기준 수량을 복원한다.
 *
 * trade 이벤트의 `volume`은 해당 체결량이므로 immutable fingerprint에 쓰면
 * 원주문 수량과 충돌한다. remaining/executed 누적 수량이 둘 다 있을 때만
 * 주문 기준 수량으로 복원한다.
 *
 * @param payload raw private WebSocket myOrder payload
 * @returns remaining + executed 수량 또는 복원 불가 시 undefined
 */
function reconstructTradeOrderQuantity(payload: Record<string, unknown>): string | undefined {
  const remaining = readStringField(
    payload,
    "remainingQuantity",
    "remaining_quantity",
    "remainingVolume",
    "remaining_volume",
    "rv",
  );
  const executed = readStringField(
    payload,
    "executedQuantity",
    "executed_quantity",
    "executedVolume",
    "executed_volume",
    "ev",
  );

  if (remaining === undefined || executed === undefined) {
    return undefined;
  }

  try {
    return parseFinancialDecimal(remaining)
      .plus(parseFinancialDecimal(executed))
      .toFixed();
  } catch {
    return undefined;
  }
}

/**
 * WebSocket state를 reconcile policy가 이해하는 거래소 상태로 정규화한다.
 *
 * raw `trade` 이벤트는 상태 전이 이벤트이며 주문의 terminal/open 상태가 아니므로
 * remaining volume 기준으로 open(wait) 또는 done으로 변환한다.
 *
 * @param rawExchangeStatus WebSocket myOrder state
 * @param remainingQuantity 미체결 수량
 * @returns reconcile용 exchange status
 */
function normalizeWebSocketExchangeStatus(
  rawExchangeStatus: string | undefined,
  remainingQuantity: string | undefined,
): string | undefined {
  if (rawExchangeStatus !== "trade") {
    return rawExchangeStatus;
  }

  if (
    remainingQuantity !== undefined &&
    isPositiveFinancialDecimalString(remainingQuantity)
  ) {
    return "wait";
  }

  return "done";
}

/**
 * decimal 문자열이 0보다 큰지 안전하게 판정한다.
 *
 * raw WebSocket payload가 schema 검증 전 값으로 들어올 수 있으므로 파싱 실패는
 * 상태 전진 근거로 쓰지 않고 false로 처리한다.
 *
 * @param value decimal 후보 문자열
 * @returns 유효한 양수 decimal 여부
 */
function isPositiveFinancialDecimalString(value: string): boolean {
  try {
    return parseFinancialDecimal(value).gt(0);
  } catch {
    return false;
  }
}

/**
 * WebSocket payload에서 허용된 후보 필드명 중 첫 문자열 값을 읽는다.
 *
 * provider raw field와 정규화 field가 공존할 수 있으므로 mapper 경계에서만
 * 선택한다. 숫자 wire 값은 decimal 문자열로 바꿔 domain snapshot에 넣고,
 * 객체 같은 예기치 않은 값은 주문 snapshot 근거로 쓰지 않는다.
 *
 * @param payload private WebSocket 이벤트 payload
 * @param fieldNames 우선순위대로 읽을 필드명
 * @returns 비어 있지 않은 문자열 값 또는 undefined
 */
function readStringField(
  payload: Record<string, unknown>,
  ...fieldNames: readonly string[]
): string | undefined {
  for (const fieldName of fieldNames) {
    const value = payload[fieldName];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

/**
 * Upbit side 표현을 로컬 reconcile domain의 BUY/SELL 값으로 정규화한다.
 *
 * Upbit raw payload의 `bid`/`ask`와 이미 정규화된 `BUY`/`SELL`을 모두 허용한다.
 * 알 수 없는 값은 상태 전진 후보를 만들지 않도록 undefined로 남긴다.
 *
 * @param side WebSocket payload의 side 문자열
 * @returns reconcile side 또는 알 수 없는 값일 때 undefined
 */
function normalizeWebSocketOrderSide(side: string | undefined): "BUY" | "SELL" | undefined {
  const normalized = side?.toUpperCase();
  if (normalized === "BUY" || normalized === "BID") {
    return "BUY";
  }
  if (normalized === "SELL" || normalized === "ASK") {
    return "SELL";
  }

  return undefined;
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
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
): number {
  let count = 0;
  const seenStrongIdentities = new Set<string>();

  for (const exchangeOrder of exchangeOrders) {
    const strongIdentity = getSummaryExchangeOpenOrderIdentity(exchangeOrder);
    if (isSummaryExchangeTerminalOrder(exchangeOrder)) {
      addSummaryExchangeIdentityWithLocalBridge(
        exchangeOrder,
        localOpenOrders,
        seenStrongIdentities,
      );
      continue;
    }

    if (!isSummaryExchangeOpenOrder(exchangeOrder)) {
      continue;
    }

    if (strongIdentity !== undefined) {
      if (seenStrongIdentities.has(strongIdentity)) {
        continue;
      }
      addSummaryExchangeIdentityWithLocalBridge(
        exchangeOrder,
        localOpenOrders,
        seenStrongIdentities,
      );
    }

    count += 1;
  }

  return count;
}

/**
 * summary count dedupe set에 exchange identity와 local bridge identity를 함께 추가한다.
 *
 * 최신 terminal/open snapshot이 identifier만 또는 uuid만 갖는 경우에도, 같은 로컬
 * 주문이 두 key를 모두 알고 있으면 다른 source의 split identity snapshot을 같은
 * 주문으로 접어야 status/CLI의 open count가 과대 표시되지 않는다.
 *
 * @param exchangeOrder 거래소 주문 snapshot
 * @param localOpenOrders bridge 후보 로컬 미체결 주문 목록
 * @param seenStrongIdentities summary count dedupe key set
 */
function addSummaryExchangeIdentityWithLocalBridge(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
  seenStrongIdentities: Set<string>,
): void {
  const exchangeIdentity = getSummaryExchangeOpenOrderIdentity(exchangeOrder);
  if (exchangeIdentity !== undefined) {
    seenStrongIdentities.add(exchangeIdentity);
  }

  for (const localOrder of localOpenOrders) {
    if (hasSummarySharedStrongIdentity(exchangeOrder, localOrder)) {
      for (const localIdentity of getSummaryLocalOrderIdentities(localOrder)) {
        seenStrongIdentities.add(localIdentity);
      }
    }
  }
}

/**
 * summary bridge를 위해 exchange/local이 강한 identity 축을 공유하는지 판정한다.
 *
 * 이 함수는 상태 전진용 identity match가 아니라 summary dedupe key 전파 여부만
 * 결정한다. uuid/identifier 중 하나가 직접 일치할 때만 local의 다른 key를
 * bridge로 신뢰한다.
 *
 * @param exchangeOrder 거래소 주문 snapshot
 * @param localOrder 로컬 주문 snapshot
 * @returns uuid 또는 identifier 공유 여부
 */
function hasSummarySharedStrongIdentity(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
): boolean {
  return (
    (
      exchangeOrder.exchangeOrderId !== undefined &&
      exchangeOrder.exchangeOrderId === localOrder.exchangeOrderId
    ) ||
    (
      exchangeOrder.identifier !== undefined &&
      exchangeOrder.identifier === localOrder.identifier
    )
  );
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
 * 최신 terminal snapshot이 오래된 open snapshot의 summary count를 억제해야 하는지 판정한다.
 *
 * done/cancel은 현재 거래소 미체결 노출이 아니므로 count에 더하지 않지만,
 * 같은 uuid/identifier의 이전 open snapshot이 뒤에서 다시 세어지지 않도록
 * 강한 식별자를 seen set에 남기는 분기에서 사용한다.
 *
 * @param exchangeOrder 거래소 주문 snapshot
 * @returns summary open count 억제용 terminal 여부
 */
function isSummaryExchangeTerminalOrder(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
): boolean {
  return (
    exchangeOrder.exchangeStatus === "done" ||
    exchangeOrder.exchangeStatus === "cancel"
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

/**
 * summary count bridge에 사용할 로컬 주문의 강한 식별자 목록을 만든다.
 *
 * uuid와 identifier만 source dedupe에 충분한 강한 key로 사용한다. fingerprint는
 * 동일 가격/수량 복수 주문 가능성이 있어 summary count 억제에 쓰지 않는다.
 *
 * @param localOrder 로컬 주문 snapshot
 * @returns `uuid:*`, `identifier:*` key 목록
 */
function getSummaryLocalOrderIdentities(
  localOrder: ReconcileLocalOrderSnapshot,
): string[] {
  const identities: string[] = [];
  if (localOrder.exchangeOrderId !== undefined) {
    identities.push(`uuid:${localOrder.exchangeOrderId}`);
  }
  if (localOrder.identifier !== undefined) {
    identities.push(`identifier:${localOrder.identifier}`);
  }
  return identities;
}
