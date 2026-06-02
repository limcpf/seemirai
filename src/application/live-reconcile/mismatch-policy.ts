import { parseFinancialDecimal } from "../../shared/decimal.js";
import {
  describeExchangeOrderIdentity,
  matchOrderIdentity,
} from "./identity.js";
import type {
  ReconcileExchangeOrderSnapshot,
  ReconcileLocalOrderSnapshot,
  ReconcileMismatchEvidence,
  ReconcileStateAdvancementCandidate,
  ReconcileWebSocketContext,
  ReconcileClosedOrderWindow,
} from "../../domain/live-reconcile.js";
import { canTransitionOrderState } from "../../domain/state-machines.js";
import type { IdentityMatchFailure, IdentityMatchSuccess } from "./identity.js";

/* ============================================================
 * Mismatch Policy — order 상태 차이 판정
 *
 * 거래소 주문 snapshot과 로컬 주문 snapshot을 대조해
 * mismatch evidence와 state advancement 후보를 생성하는 순수 함수들이다.
 * DB write, API 호출, side effect를 만들지 않는다.
 * ============================================================ */

/**
 * 단일 exchange/local order pair에 대한 대조 결과다.
 */
export interface OrderPairReconcileResult {
  /** 이 결과가 연결된 로컬 주문 id다. exchange-only mismatch이면 없다. */
  localOrderId?: string;
  /** identity match에 사용한 거래소 snapshot source다. */
  exchangeSource?: ReconcileExchangeOrderSnapshot["source"];
  /** identity 일치가 확인된 경우의 match 정보다. */
  identityMatch?: IdentityMatchSuccess;
  /** 이 pair에서 발생한 mismatch evidence 목록이다. */
  mismatches: ReconcileMismatchEvidence[];
  /** identity 일치 시에만 생성되는 상태 전진 후보다. */
  stateAdvancement?: ReconcileStateAdvancementCandidate;
}

/**
 * 거래소 미체결 주문과 로컬 미체결 주문 전체를 대조한다.
 *
 * 1. identity가 일치하는 exchange→local pair를 찾아 상태 비교
 * 2. exchange에만 있는 미체결 주문 → UNTRACKED_EXCHANGE_OPEN_ORDER
 * 3. 로컬에만 있는 미체결 주문 → LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE
 *
 * @param exchangeOrders 거래소에서 조회한 모든 주문 (open + closed + lookup)
 * @param localOpenOrders 로컬 미체결 주문 목록
 * @param observedAt 이번 reconcile 실행 시각
 * @returns pair별 결과 목록
 */
export function reconcileOrders(
  exchangeOrders: readonly ReconcileExchangeOrderSnapshot[],
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
  observedAt: string,
): OrderPairReconcileResult[] {
  const results: OrderPairReconcileResult[] = [];
  const matchedLocalIds = new Set<string>();
  const matchedExchangeOrders = new Set<ReconcileExchangeOrderSnapshot>();
  const matchedExchangeIdentityKeys = new Set<string>();
  const strongerExchangeIdentityKeys = new Set<string>();

  // 각 exchange open order에 대해 로컬 매칭 시도
  for (const exchangeOrder of exchangeOrders) {
    // WebSocket terminal event는 이미 닫힌 주문 알림일 수 있어 untracked open으로 분류하지 않는다.
    if (!isUntrackedExchangeOpenCandidate(exchangeOrder)) {
      addExchangeIdentityKeys(exchangeOrder, strongerExchangeIdentityKeys);
      continue;
    }

    if (
      hasMatchedExchangeIdentity(exchangeOrder, matchedExchangeIdentityKeys) ||
      hasMatchedExchangeIdentity(exchangeOrder, strongerExchangeIdentityKeys)
    ) {
      // 더 강한 lookup/closed 관측이나 이미 처리된 중복 source가 있으면 새 untracked 주문으로 세지 않는다.
      matchedExchangeOrders.add(exchangeOrder);
      continue;
    }

    const match = findMatchingLocalOrder(exchangeOrder, localOpenOrders, matchedLocalIds);
    if (match === undefined) {
      const conflict = findIdentityConflictLocalOrder(
        exchangeOrder,
        localOpenOrders,
        matchedLocalIds,
      );
      if (conflict !== undefined) {
        // 동일 identifier/uuid 충돌은 누락 주문 두 건이 아니라 stale mapping으로 수동 검토해야 한다.
        matchedLocalIds.add(conflict.local.orderId);
        matchedExchangeOrders.add(exchangeOrder);
        addExchangeIdentityKeys(exchangeOrder, matchedExchangeIdentityKeys);
        results.push(
          createIdentityConflictResult(
            exchangeOrder,
            conflict.local,
            conflict.identity,
            observedAt,
          ),
        );
        continue;
      }

      // 로컬에서 찾지 못한 exchange open order
      results.push({
        mismatches: [createUntrackedExchangeOrderMismatch(exchangeOrder, observedAt)],
      });
      continue;
    }

    // identity가 일치하는 pair 발견
    matchedLocalIds.add(match.local.orderId);
    matchedExchangeOrders.add(exchangeOrder);
    addExchangeIdentityKeys(exchangeOrder, matchedExchangeIdentityKeys);
    results.push(
      evaluateMatchedPair(exchangeOrder, match.local, match.identity, observedAt),
    );
  }

  // 로컬에만 있고 exchange에서 찾지 못한 주문
  for (const localOrder of localOpenOrders) {
    if (matchedLocalIds.has(localOrder.orderId)) {
      continue;
    }

    const match = findMatchingExchangeOrder(localOrder, exchangeOrders, matchedExchangeOrders);
    if (match === undefined) {
      const conflict = findIdentityConflictExchangeOrder(
        localOrder,
        exchangeOrders,
        matchedExchangeOrders,
      );
      if (conflict !== undefined) {
        // closed/lookup에서 확인된 충돌도 낮은 missing-local 상태로 숨기지 않고 manual review evidence로 남긴다.
        matchedLocalIds.add(localOrder.orderId);
        matchedExchangeOrders.add(conflict.exchange);
        addExchangeIdentityKeys(conflict.exchange, matchedExchangeIdentityKeys);
        results.push(
          createIdentityConflictResult(
            conflict.exchange,
            localOrder,
            conflict.identity,
            observedAt,
          ),
        );
      } else {
        results.push({
          localOrderId: localOrder.orderId,
          mismatches: [createMissingLocalOrderMismatch(localOrder, observedAt)],
        });
      }
    } else {
      // exchange order 중 open이 아닌 source(closed, lookup)에서 찾음
      matchedLocalIds.add(localOrder.orderId);
      matchedExchangeOrders.add(match.exchange);
      addExchangeIdentityKeys(match.exchange, matchedExchangeIdentityKeys);
      results.push(
        evaluateMatchedPair(match.exchange, localOrder, match.identity, observedAt),
      );
    }
  }

  return results;
}

/**
 * closed order 조회 window 밖에 있는 로컬 주문을 찾아 mismatch evidence를 생성한다.
 *
 * 로컬 주문의 생성 시각이 closed order 조회 window 시작보다 이전이면
 * 자동 복구하지 않고 manual review evidence만 남긴다.
 *
 * @param localOpenOrders 로컬 미체결 주문 목록
 * @param closedOrderWindow closed order API 조회 window
 * @param observedAt 이번 reconcile 실행 시각
 * @returns window 밖 로컬 주문의 mismatch evidence 목록
 */
export function checkClosedOrderWindow(
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[],
  closedOrderWindow: ReconcileClosedOrderWindow,
  observedAt: string,
  verifiedLocalOrderIds: ReadonlySet<string> = new Set(),
): ReconcileMismatchEvidence[] {
  const mismatches: ReconcileMismatchEvidence[] = [];
  const windowStart = new Date(closedOrderWindow.windowStart).getTime();

  if (closedOrderWindow.windowExhausted) {
    mismatches.push(createClosedOrderWindowExhaustedMismatch(closedOrderWindow, observedAt));
  }

  for (const localOrder of localOpenOrders) {
    if (verifiedLocalOrderIds.has(localOrder.orderId)) {
      continue;
    }

    // createdAt이 없으면 window 판정 불가 → skip (다른 mismatch에서 잡음)
    if (localOrder.createdAt === undefined) {
      continue;
    }

    const createdAt = new Date(localOrder.createdAt).getTime();
    if (createdAt < windowStart) {
      mismatches.push({
        mismatchType: "CLOSED_ORDER_WINDOW_EXCEEDED",
        severity: "WARN",
        market: localOrder.market,
        orderIdentity: `local:${localOrder.orderId}`,
        userMessage: `로컬 주문(${localOrder.orderId})의 생성 시점(${localOrder.createdAt})이 거래소 체결 내역 조회 기간(${closedOrderWindow.windowStart} ~ ${closedOrderWindow.windowEnd})을 벗어나 상태 확인이 불가능합니다.`,
        requiredAction: "수동 검토: 거래소 웹/앱에서 해당 주문의 최종 상태를 확인하고 로컬 주문 상태를 수동 갱신하세요.",
        evidenceFingerprint: `closed-window-exceeded:${localOrder.orderId}:${observedAt}`,
        trace: {
          orderId: localOrder.orderId,
          windowStart: closedOrderWindow.windowStart,
          windowEnd: closedOrderWindow.windowEnd,
          createdAt: localOrder.createdAt,
          currentStatus: localOrder.status,
        },
        occurredAt: observedAt,
      });
    }
  }

  return mismatches;
}

function createClosedOrderWindowExhaustedMismatch(
  closedOrderWindow: ReconcileClosedOrderWindow,
  observedAt: string,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "CLOSED_ORDER_WINDOW_EXCEEDED",
    severity: "ERROR",
    userMessage: `거래소 종료 주문 조회 window(${closedOrderWindow.windowStart} ~ ${closedOrderWindow.windowEnd})가 API limit으로 소진되어 일부 종료 주문이 누락됐을 수 있습니다.`,
    requiredAction: "수동 검토 필요: 종료 주문 조회 구간을 더 작게 나눠 재조회하거나 거래소 웹/앱에서 해당 기간 주문 상태를 확인하세요.",
    evidenceFingerprint: `closed-window-exhausted:${closedOrderWindow.windowStart}:${closedOrderWindow.windowEnd}:${observedAt}`,
    trace: {
      windowStart: closedOrderWindow.windowStart,
      windowEnd: closedOrderWindow.windowEnd,
      queryCount: closedOrderWindow.queryCount,
      windowExhausted: closedOrderWindow.windowExhausted,
    },
    occurredAt: observedAt,
  };
}

/**
 * WebSocket context에서 gap/stale 의심 증거가 있는지 확인한다.
 *
 * REST bootstrap 완료 이전 이벤트, reconnect discontinuity,
 * stale 의심 기간이 있으면 manual review evidence를 생성한다.
 *
 * @returns WebSocket gap mismatch evidence 또는 빈 배열
 */
export function checkWebSocketGap(
  websocketContext: ReconcileWebSocketContext,
  observedAt: string,
): ReconcileMismatchEvidence[] {
  const mismatches: ReconcileMismatchEvidence[] = [];

  if (
    websocketContext.bootstrapCompleteAt === undefined &&
    websocketContext.events.length > 0
  ) {
    // REST snapshot 기준점 없이 수신된 WebSocket 이벤트는 순서를 증명할 수 없어 자동 복구 근거로 쓰지 않는다.
    mismatches.push(createWebSocketBootstrapMissingMismatch(websocketContext, observedAt));
  }

  // bootstrap 이전 이벤트 검사
  if (websocketContext.bootstrapCompleteAt !== undefined) {
    const bootstrapAt = new Date(websocketContext.bootstrapCompleteAt).getTime();
    const preBootstrapEvents = websocketContext.events.filter(
      (event) => new Date(event.occurredAt).getTime() < bootstrapAt,
    );
    if (preBootstrapEvents.length > 0) {
      mismatches.push({
        mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
        severity: "WARN",
        userMessage: `WebSocket bootstrap(${websocketContext.bootstrapCompleteAt}) 이전에 ${preBootstrapEvents.length}건의 이벤트가 수신되어 신뢰할 수 없습니다.`,
        requiredAction: "수동 검토: bootstrap 이전 이벤트는 무시하고 REST snapshot 기준 상태만 신뢰하세요. 필요하면 reconcile을 재실행하세요.",
        evidenceFingerprint: `ws-pre-bootstrap:${observedAt}`,
        trace: {
          bootstrapCompleteAt: websocketContext.bootstrapCompleteAt,
          preBootstrapEventCount: preBootstrapEvents.length,
          preBootstrapEventTypes: [...new Set(preBootstrapEvents.map((e) => e.type))],
        },
        occurredAt: observedAt,
      });
    }
  }

  // 연결 불연속 증거 검사
  if (websocketContext.disconnectEvidence !== undefined) {
    const evidence = websocketContext.disconnectEvidence;
    mismatches.push({
      mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
      severity: "ERROR",
      userMessage: buildWebSocketGapMessage(evidence),
      requiredAction: "수동 검토: WebSocket 재연결 후 REST snapshot을 다시 조회하여 bootstrap을 재수행하세요. 불연속 기간 중 발생한 주문/체결은 거래소 웹에서 직접 확인하세요.",
      evidenceFingerprint: `ws-disconnect:${evidence.disconnectedAt ?? observedAt}:${observedAt}`,
      trace: {
        lastConnectedAt: evidence.lastConnectedAt,
        disconnectedAt: evidence.disconnectedAt,
        reconnectedAt: evidence.reconnectedAt,
        gapDurationMs: evidence.gapDurationMs,
        reconnectCount: evidence.reconnectCount,
        staleSince: evidence.staleSince,
      },
      occurredAt: observedAt,
    });
  }

  return mismatches;
}

function createWebSocketBootstrapMissingMismatch(
  websocketContext: ReconcileWebSocketContext,
  observedAt: string,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
    severity: "ERROR",
    userMessage: `WebSocket 이벤트 ${websocketContext.events.length}건이 있지만 REST bootstrap 완료 시각이 없어 snapshot 기준점을 확인할 수 없습니다.`,
    requiredAction: "수동 검토 필요: private WebSocket을 REST snapshot 기준으로 다시 bootstrap하고, 기준점 없는 이벤트는 거래소 REST 상태와 대조하세요.",
    evidenceFingerprint: `ws-bootstrap-missing:${observedAt}`,
    trace: {
      eventCount: websocketContext.events.length,
      eventTypes: [...new Set(websocketContext.events.map((event) => event.type))],
    },
    occurredAt: observedAt,
  };
}

/* ============================================================
 * 내부 구현
 * ============================================================ */

/**
 * exchange 주문과 일치하는 로컬 주문을 identity 기준으로 찾는다.
 *
 * @returns 일치하는 로컬 주문과 identity match 정보, 없으면 undefined
 */
function findMatchingLocalOrder(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrders: readonly ReconcileLocalOrderSnapshot[],
  matchedLocalIds: ReadonlySet<string>,
): { local: ReconcileLocalOrderSnapshot; identity: IdentityMatchSuccess } | undefined {
  for (const localOrder of localOrders) {
    if (matchedLocalIds.has(localOrder.orderId)) {
      continue;
    }
    const result = matchOrderIdentity(exchangeOrder, localOrder);
    if (result.matched) {
      return { local: localOrder, identity: result };
    }
  }
  return undefined;
}

function findIdentityConflictLocalOrder(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrders: readonly ReconcileLocalOrderSnapshot[],
  matchedLocalIds: ReadonlySet<string>,
): { local: ReconcileLocalOrderSnapshot; identity: IdentityMatchFailure } | undefined {
  for (const localOrder of localOrders) {
    if (matchedLocalIds.has(localOrder.orderId)) {
      continue;
    }

    const result = matchOrderIdentity(exchangeOrder, localOrder);
    if (!result.matched && isIdentityConflictReason(result.reason)) {
      return { local: localOrder, identity: result };
    }
  }
  return undefined;
}

/**
 * 로컬 주문과 일치하는 exchange 주문을 찾는다 (모든 source 대상).
 */
function findMatchingExchangeOrder(
  localOrder: ReconcileLocalOrderSnapshot,
  exchangeOrders: readonly ReconcileExchangeOrderSnapshot[],
  matchedExchangeOrders: ReadonlySet<ReconcileExchangeOrderSnapshot>,
): { exchange: ReconcileExchangeOrderSnapshot; identity: IdentityMatchSuccess } | undefined {
  for (const exchangeOrder of exchangeOrders) {
    if (matchedExchangeOrders.has(exchangeOrder)) {
      continue;
    }
    const result = matchOrderIdentity(exchangeOrder, localOrder);
    if (result.matched) {
      return { exchange: exchangeOrder, identity: result };
    }
  }
  return undefined;
}

function findIdentityConflictExchangeOrder(
  localOrder: ReconcileLocalOrderSnapshot,
  exchangeOrders: readonly ReconcileExchangeOrderSnapshot[],
  matchedExchangeOrders: ReadonlySet<ReconcileExchangeOrderSnapshot>,
): { exchange: ReconcileExchangeOrderSnapshot; identity: IdentityMatchFailure } | undefined {
  for (const exchangeOrder of exchangeOrders) {
    if (matchedExchangeOrders.has(exchangeOrder)) {
      continue;
    }

    const result = matchOrderIdentity(exchangeOrder, localOrder);
    if (!result.matched && isIdentityConflictReason(result.reason)) {
      return { exchange: exchangeOrder, identity: result };
    }
  }
  return undefined;
}

function isIdentityConflictReason(reason: string): boolean {
  return (
    reason.startsWith("identifier_mismatch_after_uuid_match") ||
    reason.startsWith("uuid_mismatch_after_identifier_match") ||
    reason.startsWith("immutable_fingerprint_mismatch")
  );
}

function isUntrackedExchangeOpenCandidate(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
): boolean {
  return (
    (
      exchangeOrder.source === "open" ||
      exchangeOrder.source === "ws" ||
      exchangeOrder.source === "lookup"
    ) &&
    isOpenExchangeStatus(exchangeOrder.exchangeStatus)
  );
}

function isOpenExchangeStatus(exchangeStatus: string): boolean {
  return exchangeStatus === "wait" || exchangeStatus === "watch";
}

function hasMatchedExchangeIdentity(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  matchedExchangeIdentityKeys: ReadonlySet<string>,
): boolean {
  return getStrongExchangeIdentityKeys(exchangeOrder).some((key) =>
    matchedExchangeIdentityKeys.has(key),
  );
}

function addExchangeIdentityKeys(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  matchedExchangeIdentityKeys: Set<string>,
): void {
  for (const key of getStrongExchangeIdentityKeys(exchangeOrder)) {
    matchedExchangeIdentityKeys.add(key);
  }
}

function getStrongExchangeIdentityKeys(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
): string[] {
  const keys: string[] = [];
  if (exchangeOrder.exchangeOrderId !== undefined) {
    keys.push(`uuid:${exchangeOrder.exchangeOrderId}`);
  }
  if (exchangeOrder.identifier !== undefined) {
    keys.push(`identifier:${exchangeOrder.identifier}`);
  }
  return keys;
}

/**
 * identity가 일치하는 exchange/local pair를 평가한다.
 *
 * cancel failure, 거래소 취소 상태 충돌, partial fill mismatch,
 * state advancement 후보를 판정한다.
 */
function evaluateMatchedPair(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
  observedAt: string,
): OrderPairReconcileResult {
  const mismatches: ReconcileMismatchEvidence[] = [];
  let stateAdvancement: ReconcileStateAdvancementCandidate | undefined;

  const exchangeStatus = exchangeOrder.exchangeStatus;

  // cancel failure: 로컬은 CANCEL_REQUESTED인데 거래소는 여전히 열려 있음
  if (
    localOrder.status === "CANCEL_REQUESTED" &&
    (exchangeStatus === "wait" || exchangeStatus === "watch")
  ) {
    mismatches.push(createCancelFailureMismatch(exchangeOrder, localOrder, identity, observedAt));
  }

  if (
    exchangeStatus === "cancel" &&
    localOrder.status !== "CANCEL_REQUESTED" &&
    localOrder.status !== "CANCELED"
  ) {
    mismatches.push(
      createExchangeCancelStateMismatch(exchangeOrder, localOrder, identity, observedAt),
    );
  }

  // partial fill mismatch: 남은 수량이 다름
  if (exchangeOrder.remainingQuantity !== undefined) {
    const remainingMatch = compareRemainingQuantity(
      exchangeOrder.remainingQuantity,
      localOrder.remainingQuantity,
    );
    if (!remainingMatch) {
      mismatches.push(
        createPartialFillMismatch(exchangeOrder, localOrder, identity, observedAt),
      );
    }
  }

  // 상태 전진 후보 판정
  stateAdvancement = createStateAdvancementCandidate(
    exchangeOrder,
    localOrder,
    identity,
  );

  if (stateAdvancement !== undefined) {
    if (identity.matchType === "fingerprint") {
      // fingerprint-only 일치는 특정 로컬 주문을 증명하지 못하므로 자동 체결/취소 전진을 막고 사람 검토로 올린다.
      mismatches.push(
        createOrderStateAdvancementBlockedMismatch(
          exchangeOrder,
          localOrder,
          identity,
          stateAdvancement.targetLocalStatus,
          observedAt,
          "fingerprint_only_identity",
        ),
      );
      return {
        localOrderId: localOrder.orderId,
        exchangeSource: exchangeOrder.source,
        identityMatch: identity,
        mismatches,
      };
    }

    if (
      stateAdvancement.targetLocalStatus !== undefined &&
      !canTransitionOrderState(localOrder.status, stateAdvancement.targetLocalStatus)
    ) {
      // 거래소 상태만으로 state machine을 우회하면 취소/체결 경합에서 잘못된 최종 상태가 커밋될 수 있다.
      mismatches.push(
        createOrderStateAdvancementBlockedMismatch(
          exchangeOrder,
          localOrder,
          identity,
          stateAdvancement.targetLocalStatus,
          observedAt,
          "state_machine_transition_not_allowed",
        ),
      );
      return {
        localOrderId: localOrder.orderId,
        exchangeSource: exchangeOrder.source,
        identityMatch: identity,
        mismatches,
      };
    }

    return {
      localOrderId: localOrder.orderId,
      exchangeSource: exchangeOrder.source,
      identityMatch: identity,
      mismatches,
      stateAdvancement,
    };
  }

  return {
    localOrderId: localOrder.orderId,
    exchangeSource: exchangeOrder.source,
    identityMatch: identity,
    mismatches,
  };
}

function createIdentityConflictResult(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchFailure,
  observedAt: string,
): OrderPairReconcileResult {
  return {
    localOrderId: localOrder.orderId,
    exchangeSource: exchangeOrder.source,
    mismatches: [
      createOrderIdentityConflictMismatch(exchangeOrder, localOrder, identity, observedAt),
    ],
  };
}

/**
 * 거래소에는 있지만 로컬에 없는 미체결 주문 mismatch evidence를 생성한다.
 */
function createUntrackedExchangeOrderMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  observedAt: string,
): ReconcileMismatchEvidence {
  const identity = describeExchangeOrderIdentity(exchangeOrder);
  return {
    mismatchType: "UNTRACKED_EXCHANGE_OPEN_ORDER",
    severity: "WARN",
    market: exchangeOrder.market,
    orderIdentity: identity,
    userMessage: `거래소에 미체결 상태(${exchangeOrder.exchangeStatus})로 존재하지만 로컬에 기록이 없는 주문이 발견되었습니다. (${identity})`,
    requiredAction: "확인 필요: 거래소 웹/앱에서 해당 주문의 생성 경로를 확인하세요. 로컬에 수동 등록하거나 거래소에서 취소하세요.",
    evidenceFingerprint: `untracked:${identity}:${observedAt}`,
    trace: {
      exchangeStatus: exchangeOrder.exchangeStatus,
      market: exchangeOrder.market,
      side: exchangeOrder.side,
      requestedQuantity: exchangeOrder.requestedQuantity,
      requestedPrice: exchangeOrder.requestedPrice,
      source: exchangeOrder.source,
    },
    occurredAt: observedAt,
  };
}

/**
 * 같은 identifier/uuid 축에서 다른 immutable fingerprint가 관측된 주문 충돌 evidence다.
 */
function createOrderIdentityConflictMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchFailure,
  observedAt: string,
): ReconcileMismatchEvidence {
  const exchangeIdentity = describeExchangeOrderIdentity(exchangeOrder);
  return {
    mismatchType: "ORDER_IDENTITY_CONFLICT",
    severity: "ERROR",
    market: exchangeOrder.market,
    orderIdentity: `${exchangeIdentity}|local:${localOrder.orderId}`,
    userMessage: `주문 식별자 충돌이 감지되었습니다. 거래소 주문(${exchangeIdentity})과 로컬 주문(${localOrder.orderId})이 같은 식별자 축에 있지만 원주문 정보가 일치하지 않습니다.`,
    requiredAction: "수동 검토 필요: 거래소 uuid/identifier와 로컬 주문의 market, side, 수량, 가격을 대조하고 stale mapping 또는 중복 identifier를 정리하세요.",
    evidenceFingerprint: `identity-conflict:${exchangeIdentity}:local:${localOrder.orderId}:${observedAt}`,
    trace: {
      reason: identity.reason,
      exchangeOrderId: exchangeOrder.exchangeOrderId,
      exchangeIdentifier: exchangeOrder.identifier,
      localOrderId: localOrder.orderId,
      localExchangeOrderId: localOrder.exchangeOrderId,
      localIdentifier: localOrder.identifier,
      exchangeMarket: exchangeOrder.market,
      localMarket: localOrder.market,
      exchangeSide: exchangeOrder.side,
      localSide: localOrder.side,
      exchangeRequestedQuantity: exchangeOrder.requestedQuantity,
      localRequestedQuantity: localOrder.requestedQuantity,
      exchangeRequestedPrice: exchangeOrder.requestedPrice,
      localRequestedPrice: localOrder.requestedPrice,
      source: exchangeOrder.source,
    },
    occurredAt: observedAt,
  };
}

/**
 * 로컬에는 있지만 거래소 모든 source(open/closed/lookup)에서 찾지 못한 주문 mismatch다.
 */
function createMissingLocalOrderMismatch(
  localOrder: ReconcileLocalOrderSnapshot,
  observedAt: string,
): ReconcileMismatchEvidence {
  const identity = localOrder.orderId;
  return {
    mismatchType: "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
    severity: "ERROR",
    market: localOrder.market,
    orderIdentity: `local:${identity}`,
    userMessage: `로컬에 미체결(${localOrder.status})로 기록됐지만 거래소 열린 주문/체결 내역/개별 조회에서 확인할 수 없는 주문이 있습니다. (orderId: ${identity})`,
    requiredAction: "수동 검토: 거래소 웹/앱에서 해당 주문의 실제 상태를 확인하세요. 이미 체결/취소됐다면 로컬 상태를 수동 갱신하세요.",
    evidenceFingerprint: `missing-local:${identity}:${observedAt}`,
    trace: {
      orderId: localOrder.orderId,
      status: localOrder.status,
      market: localOrder.market,
      side: localOrder.side,
      requestedQuantity: localOrder.requestedQuantity,
      remainingQuantity: localOrder.remainingQuantity,
      updatedAt: localOrder.updatedAt,
    },
    occurredAt: observedAt,
  };
}

/**
 * 취소 요청했지만 거래소에 여전히 열려 있는 cancel failure evidence다.
 */
function createCancelFailureMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
  observedAt: string,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "CANCEL_FAILURE_RETRY_NEEDED",
    severity: "ERROR",
    market: exchangeOrder.market,
    orderIdentity: identity.identity,
    userMessage: `취소 요청한 주문이 거래소에서 여전히 ${exchangeOrder.exchangeStatus} 상태입니다. 취소가 실패했거나 지연되고 있습니다. (${identity.identity})`,
    requiredAction: "긴급 조치 필요: 거래소 웹/앱에서 즉시 취소하고 로컬 상태를 CANCELED로 갱신하세요. 자동 재시도는 Sub PR 06 이후에 구현됩니다.",
    evidenceFingerprint: `cancel-failure:${identity.identity}:${observedAt}`,
    trace: {
      exchangeStatus: exchangeOrder.exchangeStatus,
      localStatus: localOrder.status,
      matchType: identity.matchType,
      market: exchangeOrder.market,
    },
    occurredAt: observedAt,
  };
}

/**
 * 거래소에서는 취소가 확인됐지만 로컬 open lifecycle이 취소 요청 상태가 아닌 경우의 evidence다.
 */
function createExchangeCancelStateMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
  observedAt: string,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "EXCHANGE_CANCEL_STATE_MISMATCH",
    severity: "ERROR",
    market: exchangeOrder.market,
    orderIdentity: identity.identity,
    userMessage: `거래소에서 주문(${identity.identity})이 취소(cancel) 상태로 확인됐지만 로컬 상태는 ${localOrder.status}입니다.`,
    requiredAction: "수동 검토 필요: 거래소 웹/앱에서 취소 주체와 최종 체결 여부를 확인하고 로컬 주문 상태를 CANCELED 또는 필요한 최종 상태로 갱신하세요.",
    evidenceFingerprint: `exchange-cancel-state:${identity.identity}:${localOrder.status}:${observedAt}`,
    trace: {
      exchangeStatus: exchangeOrder.exchangeStatus,
      localStatus: localOrder.status,
      matchType: identity.matchType,
      market: exchangeOrder.market,
      source: exchangeOrder.source,
    },
    occurredAt: observedAt,
  };
}

/**
 * 거래소 상태로 만든 전진 후보가 로컬 주문 state machine에서 불가능한 경우의 evidence다.
 */
function createOrderStateAdvancementBlockedMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
  targetLocalStatus: ReconcileStateAdvancementCandidate["targetLocalStatus"],
  observedAt: string,
  reasonCode: "state_machine_transition_not_allowed" | "fingerprint_only_identity" = "state_machine_transition_not_allowed",
): ReconcileMismatchEvidence {
  const detailMessage =
    reasonCode === "fingerprint_only_identity"
      ? `fingerprint만으로 연결된 주문(${identity.identity})은 동일 조건 주문이 여러 건일 수 있어 로컬 상태 ${localOrder.status}에서 ${String(targetLocalStatus)}로 자동 전진할 수 없습니다.`
      : `거래소 주문(${identity.identity})은 ${exchangeOrder.exchangeStatus} 상태지만 로컬 상태 ${localOrder.status}에서 ${String(targetLocalStatus)}로 자동 전진할 수 없습니다.`;

  return {
    mismatchType: "ORDER_STATE_ADVANCEMENT_BLOCKED",
    severity: "ERROR",
    market: exchangeOrder.market,
    orderIdentity: identity.identity,
    userMessage: detailMessage,
    requiredAction: "수동 검토 필요: 취소/체결 경합 여부와 실제 체결 내역을 확인한 뒤 로컬 주문 상태를 수동으로 정리하세요.",
    evidenceFingerprint: `state-advancement-blocked:${identity.identity}:${localOrder.status}:${String(targetLocalStatus)}:${reasonCode}:${observedAt}`,
    trace: {
      reasonCode,
      exchangeStatus: exchangeOrder.exchangeStatus,
      localStatus: localOrder.status,
      targetLocalStatus,
      matchType: identity.matchType,
      source: exchangeOrder.source,
    },
    occurredAt: observedAt,
  };
}

/**
 * partial fill 수량 불일치 evidence를 생성한다.
 */
function createPartialFillMismatch(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
  observedAt: string,
): ReconcileMismatchEvidence {
  return {
    mismatchType: "PARTIAL_FILL_MISMATCH",
    severity: "WARN",
    market: exchangeOrder.market,
    orderIdentity: identity.identity,
    userMessage: `거래소 미체결 수량(${exchangeOrder.remainingQuantity ?? "N/A"})과 로컬 미체결 수량(${localOrder.remainingQuantity})이 일치하지 않습니다. (${identity.identity})`,
    requiredAction: "확인 필요: 거래소 체결 내역을 확인하고 누락된 부분 체결을 로컬에 반영하세요.",
    evidenceFingerprint: `partial-fill-mismatch:${identity.identity}:${observedAt}`,
    trace: {
      exchangeRemainingQuantity: exchangeOrder.remainingQuantity,
      localRemainingQuantity: localOrder.remainingQuantity,
      exchangeStatus: exchangeOrder.exchangeStatus,
      localStatus: localOrder.status,
      matchType: identity.matchType,
    },
    occurredAt: observedAt,
  };
}

/**
 * identity가 일치하는 pair의 상태 전진 후보를 판정한다.
 *
 * 규칙:
 * - exchange=done, local≠FILLED → FILL_CANDIDATE (remainingQuantity>0이면 PARTIALLY_FILLED_CANDIDATE)
 * - exchange=cancel, local=CANCEL_REQUESTED → CANCEL_CANDIDATE
 * - exchange=cancel, local≠CANCEL_REQUESTED → mismatch evidence만 남기고 자동 전진 금지
 * - fingerprint match는 특정 주문을 증명하지 못하므로 전진 후보를 manual-review evidence로 차단
 */
function createStateAdvancementCandidate(
  exchangeOrder: ReconcileExchangeOrderSnapshot,
  localOrder: ReconcileLocalOrderSnapshot,
  identity: IdentityMatchSuccess,
): ReconcileStateAdvancementCandidate | undefined {
  const exchangeStatus = exchangeOrder.exchangeStatus;

  if (isOpenExchangeStatus(exchangeStatus) && exchangeOrder.remainingQuantity !== undefined) {
    const exchangeRemaining = parseFinancialDecimal(exchangeOrder.remainingQuantity);
    const localRemaining = parseFinancialDecimal(localOrder.remainingQuantity);

    if (exchangeRemaining.gt(0) && exchangeRemaining.lt(localRemaining)) {
      if (localOrder.status === "PARTIALLY_FILLED") {
        return undefined;
      }

      return {
        localOrderId: localOrder.orderId,
        exchangeOrderIdentity: identity.identity,
        exchangeStatus,
        currentLocalStatus: localOrder.status,
        targetLocalStatus: "PARTIALLY_FILLED",
        advancementType: "PARTIALLY_FILLED_CANDIDATE",
        reasonCode: "exchange_open_remaining_reduced",
        userMessage: `거래소 주문(${identity.identity})이 아직 열려 있지만 미체결 수량이 줄어 부분 체결로 판단됩니다.`,
        trace: {
          matchType: identity.matchType,
          exchangeRemainingQuantity: exchangeOrder.remainingQuantity,
          localRemainingQuantity: localOrder.remainingQuantity,
          localStatus: localOrder.status,
        },
      };
    }
  }

  // exchange done: 체결 완료
  if (exchangeStatus === "done") {
    // 이미 FILLED면 전진 불필요
    if (localOrder.status === "FILLED") {
      return undefined;
    }

    const hasRemaining =
      exchangeOrder.remainingQuantity !== undefined &&
      parseFinancialDecimal(exchangeOrder.remainingQuantity).gt(0);

    if (hasRemaining) {
      // remainingQuantity > 0 → 부분 체결
      if (localOrder.status === "PARTIALLY_FILLED") {
        return undefined; // 이미 PARTIALLY_FILLED
      }
      return {
        localOrderId: localOrder.orderId,
        exchangeOrderIdentity: identity.identity,
        exchangeStatus,
        currentLocalStatus: localOrder.status,
        targetLocalStatus: "PARTIALLY_FILLED",
        advancementType: "PARTIALLY_FILLED_CANDIDATE",
        reasonCode: "exchange_done_with_remaining",
        userMessage: `거래소 주문(${identity.identity})이 체결 완료(done) 상태이고 미체결 수량이 남아 있어 부분 체결로 판단됩니다.`,
        trace: {
          matchType: identity.matchType,
          exchangeRemainingQuantity: exchangeOrder.remainingQuantity,
          localStatus: localOrder.status,
        },
      };
    }

    // remainingQuantity=0 또는 undefined → 완전 체결
    return {
      localOrderId: localOrder.orderId,
      exchangeOrderIdentity: identity.identity,
      exchangeStatus,
      currentLocalStatus: localOrder.status,
      targetLocalStatus: "FILLED",
      advancementType: "FILL_CANDIDATE",
      reasonCode: "exchange_done_fully_filled",
      userMessage: `거래소 주문(${identity.identity})이 체결 완료(done) 상태입니다. 로컬 상태를 FILLED로 전진할 수 있습니다.`,
      trace: {
        matchType: identity.matchType,
        exchangeRemainingQuantity: exchangeOrder.remainingQuantity,
        localStatus: localOrder.status,
      },
    };
  }

  // exchange cancel + local CANCEL_REQUESTED
  if (exchangeStatus === "cancel" && localOrder.status === "CANCEL_REQUESTED") {
    return {
      localOrderId: localOrder.orderId,
      exchangeOrderIdentity: identity.identity,
      exchangeStatus,
      currentLocalStatus: localOrder.status,
      targetLocalStatus: "CANCELED",
      advancementType: "CANCEL_CANDIDATE",
      reasonCode: "exchange_cancel_confirmed",
      userMessage: `거래소에서 취소(cancel) 확인되어 로컬 취소 요청 상태를 CANCELED로 전진할 수 있습니다. (${identity.identity})`,
      trace: {
        matchType: identity.matchType,
      },
    };
  }

  // exchange wait/watch + local ACCEPTED/SUBMITTED: 정상 운영 중 → 전진 불필요
  return undefined;
}

/**
 * WebSocket gap 메시지를 생성한다.
 */
function buildWebSocketGapMessage(
  evidence: NonNullable<ReconcileWebSocketContext["disconnectEvidence"]>,
): string {
  const parts: string[] = ["WebSocket 연결 불연속이 감지되었습니다."];
  if (evidence.disconnectedAt !== undefined) {
    parts.push(`단절 시각: ${String(evidence.disconnectedAt)}`);
  }
  if (evidence.gapDurationMs !== undefined) {
    parts.push(`단절 기간: ${evidence.gapDurationMs}ms`);
  }
  if (evidence.staleSince !== undefined) {
    parts.push(`데이터 부재(stale) 감지: ${String(evidence.staleSince)}`);
  }
  if (evidence.reconnectCount !== undefined) {
    parts.push(`재연결 시도: ${evidence.reconnectCount}회`);
  }
  return parts.join(" ");
}

/**
 * 두 remainingQuantity가 Decimal 기준으로 같은지 비교한다.
 *
 * JS number 비교를 피하고 string Decimal 비교를 사용한다.
 */
function compareRemainingQuantity(
  exchangeRemaining: string,
  localRemaining: string,
): boolean {
  try {
    return parseFinancialDecimal(exchangeRemaining).eq(
      parseFinancialDecimal(localRemaining),
    );
  } catch {
    // Decimal parsing 실패 시 문자열 직접 비교로 fallback
    return exchangeRemaining === localRemaining;
  }
}
