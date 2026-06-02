import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "../../../domain/index.js";
import type { UpbitWebSocketConnection, UpbitWebSocketFormat } from "../websocket-client.js";

/* ============================================================
 * Private WebSocket endpoint 상수
 *
 * Upbit private WebSocket은 REST와 동일한 JWT Authorization
 * header로 인증하며, query_hash는 사용하지 않는다.
 * ============================================================ */

/** Upbit private WebSocket endpoint다. REST JWT와 같은 Authorization header로 인증한다. */
export const UPBIT_PRIVATE_WEBSOCKET_URL = "wss://api.upbit.com/websocket/v1/private";

/* ============================================================
 * Subscription type 상수
 *
 * myOrder: 계정의 주문 상태 변경 이벤트를 수신한다.
 *   - codes 미지정 시 전 market 구독
 * myAsset: 계정의 자산 잔고 변경 이벤트를 수신한다.
 *   - codes 지정 시 local fail-closed
 * ============================================================ */

/** Private WebSocket 구독 type이다. */
export type UpbitPrivateWebSocketType = "myOrder" | "myAsset";

/** Private WebSocket 요청 format이다. */
export type UpbitPrivateWebSocketFormat = Exclude<UpbitWebSocketFormat, "SIMPLE">;

/* ============================================================
 * Subscription payload types
 * ============================================================ */

/** Private WebSocket 요청의 type object다. */
export interface UpbitPrivateWebSocketTypeObject {
  type: UpbitPrivateWebSocketType;
  codes?: readonly string[];
}

/** Private WebSocket 요청 payload (JSON array)다. */
export type UpbitPrivateWebSocketRequest = readonly [
  { ticket: string },
  ...UpbitPrivateWebSocketTypeObject[],
  { format: UpbitPrivateWebSocketFormat },
];

/* ============================================================
 * Lifecycle event contracts
 *
 * runtime worker가 reconnect와 gap evidence를 만들 수 있도록
 * 안정 event type을 제공한다. myOrder/myAsset 데이터 미수신은
 * 조용한 계정의 정상 상태일 수 있으므로 상태값에 포함하지 않는다.
 * raw JWT/Authorization header, raw provider body는 절대
 * event payload에 포함하지 않는다.
 * ============================================================ */

/** Private WebSocket 연결 상태다. */
export type UpbitPrivateWebSocketConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "DEGRADED";

/** Private WebSocket lifecycle event다. */
export interface UpbitPrivateWebSocketLifecycleEvent {
  type: "LIFECYCLE";
  status: UpbitPrivateWebSocketConnectionStatus;
  exchangeId: ExchangeId;
  observedAt: TimestampInput;
  reasonCode?: string;
  /** 재연결 시도 횟수다. runtime worker가 누적한다. */
  reconnectCount?: number;
  metadata?: JsonRecord;
}

/* ============================================================
 * Subscription-first bootstrap buffer contract
 *
 * REST snapshot 전 WebSocket 구독을 먼저 성립시키고, snapshot 중
 * 들어온 account event를 메모리 버퍼로 보존해 bootstrap 공백을
 * 증명한다. 이 contract는 raw WebSocket payload를 drain caller에게만
 * 전달하며 status/log/audit summary에는 gap evidence만 남겨야 한다.
 * ============================================================ */

/** Private WebSocket bootstrap buffer에 보존된 단일 message다. */
export interface UpbitPrivateWebSocketBufferedMessage {
  /** WebSocket message data다. caller가 schema parse 후 raw body를 폐기해야 한다. */
  data: unknown;
  /** 로컬 수신 시각이다. */
  receivedAt: TimestampInput;
}

/** Subscription-first bootstrap 공백 판단 근거다. */
export interface UpbitPrivateWebSocketBootstrapGapEvidence {
  /** 이벤트 버퍼를 연 로컬 시각이다. */
  bufferOpenedAt: TimestampInput;
  /** subscribe payload 전송이 완료된 로컬 시각이다. */
  subscribedAt?: TimestampInput;
  /** REST snapshot 조회를 시작한 로컬 시각이다. */
  snapshotStartedAt?: TimestampInput;
  /** REST snapshot 조회를 완료한 로컬 시각이다. */
  snapshotCompletedAt?: TimestampInput;
  /** buffer를 drain한 로컬 시각이다. */
  drainedAt?: TimestampInput;
  /** drain 전 또는 현재까지 버퍼에 보존된 message 수다. */
  bufferedMessageCount: number;
  /** 구독 전 snapshot 시작, drain 누락 등 bootstrap 공백 의심 여부다. */
  hasBootstrapGap: boolean;
  /** gap 의심 시 runtime worker가 evidence에 남길 안정 reason code다. */
  reasonCode?: "SUBSCRIPTION_NOT_CONFIRMED_BEFORE_SNAPSHOT" | "BUFFER_NOT_DRAINED";
}

/** drain 결과와 gap evidence를 함께 제공한다. */
export interface UpbitPrivateWebSocketBufferedMessageDrain {
  messages: readonly UpbitPrivateWebSocketBufferedMessage[];
  evidence: UpbitPrivateWebSocketBootstrapGapEvidence;
}

/** subscribe-first bootstrap buffer session이다. */
export interface UpbitPrivateWebSocketSubscriptionSession {
  /** 이벤트 버퍼를 연 로컬 시각이다. */
  readonly bufferOpenedAt: TimestampInput;
  /** subscribe payload 전송 완료 시각이다. */
  readonly subscribedAt: TimestampInput | undefined;
  /** REST snapshot 시작 시각이다. */
  readonly snapshotStartedAt: TimestampInput | undefined;
  /** REST snapshot 완료 시각이다. */
  readonly snapshotCompletedAt: TimestampInput | undefined;
  /** WebSocket message event에서 호출할 수 있는 버퍼 입력 handler다. */
  handleMessage(data: unknown, receivedAt?: TimestampInput): void;
  /** REST snapshot 조회 직전에 호출해 subscription-first 순서를 검증한다. */
  markSnapshotStarted(observedAt?: TimestampInput): UpbitPrivateWebSocketBootstrapGapEvidence;
  /** REST snapshot 조회 직후 호출해 snapshot 완료 시각을 고정한다. */
  markSnapshotCompleted(observedAt?: TimestampInput): UpbitPrivateWebSocketBootstrapGapEvidence;
  /** snapshot 이후 버퍼 message를 반환하고 gap evidence를 함께 제공한다. */
  drainBufferedMessages(observedAt?: TimestampInput): UpbitPrivateWebSocketBufferedMessageDrain;
  /** raw message 없이 status/audit에 남길 수 있는 gap evidence를 반환한다. */
  getGapEvidence(): UpbitPrivateWebSocketBootstrapGapEvidence;
}

/** bootstrap buffer의 clock 주입 옵션이다. */
export interface UpbitPrivateWebSocketBootstrapBufferOptions {
  now?: () => TimestampInput;
}

/** Private WebSocket 오류 event다. raw provider body는 포함하지 않는다. */
export interface UpbitPrivateWebSocketErrorEvent {
  type: "ERROR";
  exchangeId: ExchangeId;
  observedAt: TimestampInput;
  /** 인증 실패, 형식 오류 등 provider error name만 보존한다. */
  errorKind: string;
  /** raw provider body는 보존하지 않는다. schema path만 남긴다. */
  schemaPath?: string;
  metadata?: JsonRecord;
}

/** Private WebSocket에서 발생할 수 있는 모든 event다. */
export type UpbitPrivateWebSocketEvent =
  | UpbitPrivateWebSocketLifecycleEvent
  | UpbitPrivateWebSocketErrorEvent
  | UpbitPrivateMyOrderEvent
  | UpbitPrivateMyAssetEvent;

/* ============================================================
 * Normalized myOrder event contract
 *
 * myOrder는 주문 상태 변경 시에만 데이터를 보낸다.
 * sequence가 없으므로 gap 감지는 runtime worker가
 * ping/pong, close/error, 마지막 수신 시간 기준으로
 * 판단해야 한다.
 * ============================================================ */

/** 정규화된 myOrder event다. */
export interface UpbitPrivateMyOrderEvent {
  type: "MY_ORDER";
  exchangeId: ExchangeId;
  /** 주문 uuid다. */
  orderId: string;
  market: MarketCode;
  side: "ASK" | "BID";
  /** Upbit 주문 상태다. */
  state: "wait" | "watch" | "trade" | "done" | "cancel" | "prevented";
  /** 주문 시점의 지정가다. 시장가 주문은 빈 문자열일 수 있다. */
  price: NumericString;
  /** 주문 기준 수량이다. trade 이벤트에서는 remaining_volume + executed_volume으로 복원한다. */
  volume: NumericString;
  /** raw 이벤트의 volume이다. trade 이벤트에서는 해당 체결 수량이다. */
  eventVolume: NumericString;
  /** 거래소 체결 uuid다. trade 이벤트에 있을 때만 보존한다. */
  tradeId?: string;
  /** 거래소 체결 시각(trade_timestamp)이다. trade 이벤트에 있을 때만 보존한다. */
  tradeTimestamp?: string;
  /** 미체결 수량이다. */
  remainingVolume: NumericString;
  /** 체결된 수량이다. */
  executedVolume: NumericString;
  /** 누적 체결 평균 가격(avg_price)이다. */
  tradePrice: NumericString;
  /** 누적 수수료다. */
  paidFee: NumericString;
  /** 수수료 통화다. Upbit myOrder raw payload에 없으면 undefined로 둔다. */
  feeCurrency?: string;
  /** 거래소 주문 생성 시각(order_timestamp)이다. */
  orderTimestamp: string;
  /** 거래소 이벤트 시각 (timestamp)이다. */
  eventTimestamp: string;
  receivedAt: TimestampInput;
  streamType: "SNAPSHOT" | "REALTIME";
  /** raw payload에서 추출한 기타 안전 metadata다. */
  metadata?: JsonRecord;
}

/* ============================================================
 * Normalized myAsset event contract
 *
 * myAsset는 자산 잔고 변경 시에만 데이터를 보낸다.
 * 연결 직후 수신이 없을 수 있으므로 runtime worker는
 * REST /v1/accounts를 bootstrap source로 사용해야 한다.
 * ============================================================ */

/** 정규화된 myAsset event의 단일 자산 row다. */
export interface UpbitPrivateMyAssetBalance {
  currency: string;
  balance: NumericString;
  locked: NumericString;
}

/** 정규화된 myAsset event다. */
export interface UpbitPrivateMyAssetEvent {
  type: "MY_ASSET";
  exchangeId: ExchangeId;
  balances: readonly UpbitPrivateMyAssetBalance[];
  eventTimestamp: string;
  receivedAt: TimestampInput;
  streamType: "SNAPSHOT" | "REALTIME";
  metadata?: JsonRecord;
}

/* ============================================================
 * Transport factory contract
 *
 * Authorization header를 transport 생성 시점에만 전달한다.
 * raw JWT는 외부로 유출되지 않으며, log/status/audit payload
 * 에 저장하지 않는 invariant를 유지한다.
 * ============================================================ */

/** Authorization header가 포함된 WebSocket 전송 객체다. */
export interface UpbitPrivateWebSocketTransport extends UpbitWebSocketConnection {
  /** transport가 연결에 사용한 endpoint URL이다. secret은 포함하지 않는다. */
  readonly url: string;
}

/**
 * Private WebSocket 연결을 생성하는 팩토리 함수다.
 *
 * raw JWT/Authorization header는 이 factory 내부에서만 사용하고
 * 반환된 transport 객체나 event payload에 secret을 저장하지
 * 않는 invariant를 유지해야 한다.
 */
export type UpbitPrivateWebSocketFactory = (
  url: string,
  authorizationHeader: string,
) => UpbitPrivateWebSocketTransport;

/** Private WebSocket client 생성 옵션이다. */
export interface UpbitPrivateWebSocketClientOptions {
  url?: string;
  /**
   * Authorization header 값이다. `Bearer <JWT>` 형식의 문자열을
   * 전달하며, 이 값은 log/status/audit payload에 저장하지 않는
   * invariant를 유지해야 한다.
   */
  authorizationHeader: string;
  /** WebSocket 연결 팩토리다. test에서 mock transport를 주입할 수 있다. */
  websocketFactory?: UpbitPrivateWebSocketFactory;
  /** bootstrap buffer evidence 시각을 고정하기 위한 clock이다. */
  clock?: () => TimestampInput;
}
