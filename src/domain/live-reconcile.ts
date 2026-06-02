import type { BrokerBalance, OrderLifecycleStatus } from "./orders.js";
import type { KillSwitchState } from "./state-machines.js";
import type { JsonRecord, NumericString, TimestampInput } from "./types.js";

/* ============================================================
 * M16 Reconcile Engine Domain Types
 *
 * 이 파일은 reconcile diff engine의 입력/출력 contract와
 * mismatch taxonomy를 정의한다. DB write나 외부 API 호출을
 * 포함하지 않는 순수 domain type이다.
 * ============================================================ */

/**
 * 거래소에서 관측한 주문의 unified snapshot이다.
 *
 * open/closed/lookup/ws 4개 source를 하나의 contract로 통일하며,
 * exchangeOrderId(uuid)와 identifier(client-assigned) 중 하나는
 * 반드시 존재해야 identity matching이 가능하다.
 */
export interface ReconcileExchangeOrderSnapshot {
  /** 거래소가 부여한 uuid. closed/lookup에는 항상 있고 open/ws는 없을 수 있다. */
  exchangeOrderId?: string;
  /** 클라이언트가 부여한 identifier. 없는 주문은 fingerprint matching만 가능하다. */
  identifier?: string;
  market: string;
  side: "BUY" | "SELL";
  /** 거래소 원천 주문 상태. Upbit 기준 wait/watch/done/cancel이다. */
  exchangeStatus: string;
  requestedQuantity: NumericString;
  /** 미체결 수량. closed order이거나 일부 ws event에서는 누락될 수 있다. */
  remainingQuantity?: NumericString;
  requestedPrice?: NumericString;
  source: "open" | "closed" | "lookup" | "ws";
  capturedAt: TimestampInput;
}

/**
 * 로컬 DB에 기록된 미체결 주문 snapshot이다.
 *
 * BrokerOrder와 같은 주문 lifecycle 필드를 reconcile 입력에 맞게
 * 정규화한 snapshot이며, engine은 이 snapshot을 기준으로 exchange
 * 상태와 대조한다.
 */
export interface ReconcileLocalOrderSnapshot {
  orderId: string;
  exchangeOrderId?: string;
  identifier?: string;
  market: string;
  side: "BUY" | "SELL";
  orderType: "LIMIT" | "MARKET";
  /** 로컬 상태 전이 machine의 canonical 상태다. */
  status: OrderLifecycleStatus;
  requestedQuantity: NumericString;
  remainingQuantity: NumericString;
  requestedPrice?: NumericString;
  /** BUY 주문의 전체 예약 수수료다. 거래소 payload에 남아 있으면 locked 설명 보조값으로 사용한다. */
  reservedFee?: NumericString;
  /** BUY 주문의 남은 예약 수수료다. 부분 체결 이후 KRW locked가 주문 금액과 함께 줄어드는 invariant를 검증한다. */
  remainingFee?: NumericString;
  updatedAt: TimestampInput;
  /** 주문이 최초 생성된 로컬 시각이다. closed order window 판정에 사용한다. */
  createdAt?: TimestampInput;
}

/**
 * WebSocket 이벤트의 단일 메시지 정규화 표현이다.
 *
 * myOrder와 myAsset 이벤트를 공통 contract로 담는다. 이벤트 발생 시각은
 * REST bootstrap 완료 시각보다 앞설 수 있으며, 기준점이 확인된 context에서는
 * subscription-first bootstrap 버퍼에서 drain된 정상 이벤트로 취급한다.
 */
export interface ReconcileWebSocketEvent {
  type: "myOrder" | "myAsset";
  occurredAt: TimestampInput;
  payload: JsonRecord;
}

/**
 * WebSocket 연결 불연속 증거다.
 *
 * close/error, ping 실패, reconnect discontinuity처럼 실제 연결 liveness가
 * 깨진 증거를 runtime worker가 이 contract로 전달한다. `staleSince`는
 * 진단 보조값이며, event-only stream의 데이터 부재만으로 주문 경로를
 * 차단하는 근거가 되어서는 안 된다.
 */
export interface ReconcileDisconnectEvidence {
  lastConnectedAt?: TimestampInput;
  disconnectedAt?: TimestampInput;
  reconnectedAt?: TimestampInput;
  /** 연결이 끊긴 기간(ms). 재연결 실패 누적이면 reconnectCount로 판단한다. */
  gapDurationMs?: number;
  /** 데이터가 들어오지 않은 기간이 임계치를 넘어 stale로 의심되는 시점이다. */
  staleSince?: TimestampInput;
  /** 재연결 시도 누적 횟수다. */
  reconnectCount?: number;
}

/**
 * subscription-first bootstrap 이후 WebSocket context를 묶은 입력이다.
 *
 * REST snapshot 기준점 유무와 reconnect gap을 engine이 판단할 수 있도록
 * bootstrap 시점 정보와 이벤트 목록을 함께 전달한다. 기준점이 확인된 경우
 * bootstrap 이전에 발생한 buffered event는 정상 이벤트로 남기고 gap evidence로
 * 승격하지 않는다.
 */
export interface ReconcileWebSocketContext {
  /** REST bootstrap 완료 시각. 없으면 수신 이벤트를 snapshot 기준으로 해석할 수 없다. */
  bootstrapCompleteAt?: TimestampInput;
  /** private WebSocket에서 수신해 reconcile 입력으로 정규화한 이벤트다. */
  events: readonly ReconcileWebSocketEvent[];
  /** reconnect 불연속 증거. 없으면 연결이 안정적이다. */
  disconnectEvidence?: ReconcileDisconnectEvidence;
}

/**
 * closed order REST API 조회 window metadata다.
 *
 * API limit 초과나 window 밖 주문은 자동 복구하지 않고
 * mismatch evidence로만 남긴다.
 */
export interface ReconcileClosedOrderWindow {
  /** 조회 시작 시각. 이보다 오래된 로컬 주문은 window 밖이다. */
  windowStart: TimestampInput;
  /** 조회 종료 시각이다. */
  windowEnd: TimestampInput;
  /** API response limit에 걸려 모든 데이터를 가져오지 못했는지 여부다. */
  windowExhausted: boolean;
  /** 실제 수행한 API 호출 횟수다. */
  queryCount: number;
}

/**
 * Reconcile diff engine의 전체 입력이다.
 *
 * 모든 입력은 snapshot이므로 engine은 외부 API/DB를 호출하지 않는다.
 */
export interface ReconcileEngineInput {
  /** 거래소 REST open order 목록이다. */
  exchangeOpenOrders: readonly ReconcileExchangeOrderSnapshot[];
  /** 거래소 REST closed order 목록이다. */
  exchangeClosedOrders: readonly ReconcileExchangeOrderSnapshot[];
  /** 개별 주문 조회로 얻은 보강 snapshot 목록이다. */
  orderLookups: readonly ReconcileExchangeOrderSnapshot[];
  /** private WebSocket 연결 context와 이벤트다. */
  websocketContext: ReconcileWebSocketContext;
  /** 로컬 DB에 기록된 미체결 주문 snapshot이다. */
  localOpenOrders: readonly ReconcileLocalOrderSnapshot[];
  /** 로컬에 기록된 잔고 snapshot. 없으면 balance 판정 불가 mismatch로 fail-closed한다. */
  localBalances?: readonly BrokerBalance[];
  /** 거래소 REST 잔고 snapshot. 없으면 balance 판정 불가 mismatch로 fail-closed한다. */
  exchangeBalances?: readonly BrokerBalance[];
  /** closed order 조회 window metadata이다. */
  closedOrderWindow: ReconcileClosedOrderWindow;
  /** 이번 reconcile 실행 시각이다. */
  observedAt: TimestampInput;
}

/* ============================================================
 * Mismatch Taxonomy
 *
 * 모든 mismatch는 사용자 메시지/필요 조치와 내부 trace를 분리한다.
 * mismatchType은 DB `live_reconcile_mismatch_evidence.mismatch_type`
 * CHECK constraint와 동기화한다.
 * ============================================================ */

/** reconcile mismatch 분류 식별자다. */
export type ReconcileMismatchType =
  | "UNTRACKED_EXCHANGE_OPEN_ORDER"
  | "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE"
  | "PARTIAL_FILL_MISMATCH"
  | "CANCEL_FAILURE_RETRY_NEEDED"
  | "EXCHANGE_CANCEL_STATE_MISMATCH"
  | "ORDER_STATE_ADVANCEMENT_BLOCKED"
  | "ORDER_IDENTITY_CONFLICT"
  | "BALANCE_LOCK_MISMATCH"
  | "BALANCE_SNAPSHOT_UNAVAILABLE"
  | "CLOSED_ORDER_WINDOW_EXCEEDED"
  | "WEBSOCKET_GAP_MANUAL_REVIEW";

export type ReconcileSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

/**
 * 단일 불일치 증거 payload다.
 *
 * `userMessage`와 `requiredAction`은 한국어 운영자 문구이고,
 * `trace`는 안정적인 내부 식별자와 진단 정보다. DB write 입력으로
 * 넘길 때는 이 구조를 `row-mapper`에서 DB row로 변환한다.
 */
export interface ReconcileMismatchEvidence {
  mismatchType: ReconcileMismatchType;
  severity: ReconcileSeverity;
  market?: string;
  orderIdentity?: string;
  currency?: string;
  /** 한국어 사용자 메시지. 상태, 원인, 영향을 설명한다. */
  userMessage: string;
  /** 한국어 필요 조치. 운영자가 취해야 할 행동을 설명한다. */
  requiredAction: string;
  /** 같은 run 내 중복 evidence를 구분하는 결정론적 fingerprint다. */
  evidenceFingerprint: string;
  /** 안정적인 내부 진단 정보. 사용자 표면에 노출하지 않는다. */
  trace: JsonRecord;
  occurredAt: TimestampInput;
}

/* ============================================================
 * State Advancement
 *
 * identity가 일치한 경우에만 거래소 상태를 반영해 local order
 * 상태를 전진할 수 있는 후보를 만든다. engine은 DB write를 하지
 * 않고 advancement 후보만 출력한다.
 * ============================================================ */

export type ReconcileStateAdvancementType =
  | "FILL_CANDIDATE"
  | "PARTIALLY_FILLED_CANDIDATE"
  | "CANCEL_CANDIDATE"
  | "BLOCKED_NO_IDENTITY_MATCH"
  | "BLOCKED_NO_REMAINING_QUANTITY"
  | "BLOCKED_IDENTIFIER_CHANGED";

/**
 * identity 일치가 확인된 거래소/로컬 주문 쌍에 대한 상태 전진 후보다.
 *
 * engine은 전이를 실행하지 않고, 현재 상태, 목표 상태, 근거만
 * payload로 반환한다. Sub PR 06 runtime worker가 이 후보를 읽어
 * 실제 DB 전이를 수행한다.
 */
export interface ReconcileStateAdvancementCandidate {
  /** 로컬 주문의 orderId다. */
  localOrderId: string;
  /** 거래소 주문의 identity fingerprint다. */
  exchangeOrderIdentity: string;
  /** 거래소 원천 상태 값이다. */
  exchangeStatus: string;
  /** 로컬 주문의 현재 canonical 상태다. */
  currentLocalStatus: OrderLifecycleStatus;
  /** 상태 전진이 가능한 경우 목표 canonical 상태다. */
  targetLocalStatus?: OrderLifecycleStatus;
  advancementType: ReconcileStateAdvancementType;
  reasonCode: string;
  /** 한국어 사용자 메시지다. */
  userMessage: string;
  /** 안정적인 내부 진단 정보다. */
  trace: JsonRecord;
}

/* ============================================================
 * Output Contract
 * ============================================================ */

export type ReconcileResult = "CLEAN" | "MISMATCH_DETECTED";
export type ReconcileBalanceStatus = "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE";

/**
 * Reconcile 실행 요약이다.
 *
 * 운영자가 `/status`나 CLI에서 한눈에 reconcile 상태를 판단할 수 있도록
 * mismatch count와 핵심 지표만 포함한다.
 */
export interface ReconcileSummary {
  result: ReconcileResult;
  mismatchCount: number;
  openOrderCount: {
    exchange: number;
    local: number;
  };
  balanceStatus: ReconcileBalanceStatus;
  /** 거래소에는 있지만 로컬에 기록되지 않은 미체결 주문 수다. */
  untrackedExchangeOrders: number;
  /** 로컬에는 있지만 거래소에서 확인할 수 없는 미체결 주문 수다. */
  missingLocalOrders: number;
  /** 취소 요청했지만 거래소에 여전히 열려 있는 주문 수다. */
  cancelFailures: number;
  /** closed order 조회 window를 벗어난 로컬 주문 수다. */
  windowExceededOrders: number;
}

/**
 * Reconcile diff engine의 최종 출력이다.
 *
 * DB write, kill switch 전이, runtime side effect를 직접 수행하지 않고
 * decision/evidence payload만 반환한다. Sub PR 06 runtime worker가 이
 * 출력을 읽어 persist와 kill switch 제어를 수행한다.
 */
export interface ReconcileEngineOutput {
  summary: ReconcileSummary;
  /** 발생한 모든 불일치 증거 목록이다. */
  mismatches: readonly ReconcileMismatchEvidence[];
  /** identity 일치가 확인된 주문의 상태 전진 후보 목록이다. */
  stateAdvancements: readonly ReconcileStateAdvancementCandidate[];
  /** 신규 주문을 차단해야 하는지 여부다. */
  failClosed: boolean;
  /** fail-closed 시 runtime이 전이해야 할 kill switch 목표 상태다. */
  targetKillSwitchState?: KillSwitchState;
}
