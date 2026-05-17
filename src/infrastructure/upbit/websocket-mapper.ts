import { Decimal } from "decimal.js";
import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  MarketDataConnectionStatus,
  MarketDataEvent,
  MarketDataStatusEvent,
  NumericString,
  OrderbookEvent,
  OrderbookLevel,
  TimestampInput,
  TradeEvent,
} from "../../domain/index.js";
import { UPBIT_KRW_SPOT_EXCHANGE_ID } from "./policy-mapper.js";
import type {
  UpbitWebSocketErrorResponse,
  UpbitWebSocketOrderbook,
  UpbitWebSocketStatus,
  UpbitWebSocketTrade,
} from "./schemas.js";

/** Upbit WebSocket payload를 domain event로 정규화할 때 필요한 공통 옵션이다. */
export interface MapUpbitWebSocketEventOptions {
  exchangeId?: ExchangeId;
  receivedAt: TimestampInput;
}

/** Upbit WebSocket 상태 이벤트 생성 옵션이다. */
export interface CreateUpbitMarketDataStatusOptions {
  exchangeId?: ExchangeId;
  market?: MarketCode;
  status: MarketDataConnectionStatus;
  observedAt: TimestampInput;
  reasonCode?: string;
  websocketLagMs?: number;
  reconnectCount?: number;
  metadata?: JsonRecord;
}

/** stale data 판정 옵션이다. */
export interface UpbitStaleMarketDataOptions {
  observedAt: TimestampInput;
  staleThresholdMs: number;
  reasonCode?: string;
}

/**
 * Upbit WebSocket 체결 payload를 공통 `TradeEvent`로 변환한다.
 *
 * 업무 흐름은 schema 검증이 끝난 외부 payload에서 market, 체결 번호, 가격/수량, 거래소 시각을 뽑아
 * runtime 공통 event로 넘기는 것이다. raw payload는 후속 저장 PR에서 원천 이벤트 감사 근거로 사용한다.
 */
export function toTradeEvent(
  payload: UpbitWebSocketTrade,
  options: MapUpbitWebSocketEventOptions,
): TradeEvent {
  return {
    type: "TRADE",
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: payload.code,
    tradeId: String(payload.sequential_id),
    price: toNumericString(payload.trade_price),
    quantity: toNumericString(payload.trade_volume),
    side: payload.ask_bid,
    exchangeTimestamp: timestampFromMilliseconds(payload.trade_timestamp),
    receivedAt: options.receivedAt,
    raw: payload,
  };
}

/**
 * Upbit WebSocket 호가 payload를 공통 `OrderbookEvent`로 변환한다.
 *
 * Upbit는 ask와 bid를 한 level 객체에 묶어 주지만 domain contract는 양쪽 book을 분리한다. 변환 시
 * level 순서는 거래소가 보낸 순서를 유지해 후속 metric/snapshot PR이 같은 depth 기준으로 집계한다.
 */
export function toOrderbookEvent(
  payload: UpbitWebSocketOrderbook,
  options: MapUpbitWebSocketEventOptions,
): OrderbookEvent {
  return {
    type: "ORDERBOOK",
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: payload.code,
    asks: payload.orderbook_units.map((unit) => toOrderbookLevel(unit.ask_price, unit.ask_size)),
    bids: payload.orderbook_units.map((unit) => toOrderbookLevel(unit.bid_price, unit.bid_size)),
    exchangeTimestamp: timestampFromMilliseconds(payload.timestamp),
    receivedAt: options.receivedAt,
    raw: payload,
  };
}

/**
 * Upbit keepalive status payload를 공통 연결 상태 이벤트로 변환한다.
 *
 * `{"status":"UP"}`는 market별 시세가 아니라 연결 생존 신호다. 따라서 신규 주문 차단을 풀 수 있는
 * `CONNECTED` 상태 후보로만 전달하고 raw status는 metadata에 보존한다.
 */
export function toConnectedStatusEvent(
  payload: UpbitWebSocketStatus,
  options: Omit<CreateUpbitMarketDataStatusOptions, "status">,
): MarketDataStatusEvent {
  return createUpbitMarketDataStatusEvent({
    ...options,
    status: "CONNECTED",
    reasonCode: options.reasonCode ?? "upbit_websocket_up",
    metadata: {
      ...(options.metadata ?? {}),
      upbitStatus: payload.status,
    },
  });
}

/**
 * Upbit WebSocket 에러 응답을 상태 이벤트로 변환한다.
 *
 * 요청 형식 오류나 인증 경계 침범은 market data stream의 안전성을 훼손한다. 메시지 원문 전체를 로그로
 * 노출하지 않고 error name/message만 metadata에 남겨 후속 worker가 재연결 또는 중단을 판단하게 한다.
 */
export function toWebSocketErrorStatusEvent(
  payload: UpbitWebSocketErrorResponse,
  options: Omit<CreateUpbitMarketDataStatusOptions, "status" | "reasonCode">,
): MarketDataStatusEvent {
  return createUpbitMarketDataStatusEvent({
    ...options,
    status: "DISCONNECTED",
    reasonCode: `upbit_websocket_error:${payload.error.name}`,
    metadata: {
      ...(options.metadata ?? {}),
      errorName: payload.error.name,
      errorMessage: payload.error.message,
    },
  });
}

/**
 * market data 연결 상태 이벤트를 만든다.
 *
 * WebSocket 단절, 재연결, stale data는 리스크 게이트의 신규 주문 차단 입력이다. 이 helper는 상태 payload를
 * 한 곳에서 만들어 reason code와 lag 값을 누락하지 않게 한다.
 */
export function createUpbitMarketDataStatusEvent(
  options: CreateUpbitMarketDataStatusOptions,
): MarketDataStatusEvent {
  return {
    type: "STATUS",
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    ...(options.market === undefined ? {} : { market: options.market }),
    status: options.status,
    observedAt: options.observedAt,
    ...(options.reasonCode === undefined ? {} : { reasonCode: options.reasonCode }),
    ...(options.websocketLagMs === undefined ? {} : { websocketLagMs: options.websocketLagMs }),
    ...(options.reconnectCount === undefined ? {} : { reconnectCount: options.reconnectCount }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/**
 * 정규화된 market data event가 stale 상태인지 판정한다.
 *
 * exchange timestamp와 관측 시각 차이가 threshold를 넘으면 신규 주문 차단 후보인 `STALE` 상태 이벤트를
 * 만든다. clock skew나 잘못된 fixture로 음수 lag가 나오면 fail-fast해 운영 판단을 오염시키지 않는다.
 */
export function toStaleMarketDataStatusEvent(
  event: Exclude<MarketDataEvent, MarketDataStatusEvent>,
  options: UpbitStaleMarketDataOptions,
): MarketDataStatusEvent | undefined {
  const websocketLagMs = timestampToMilliseconds(options.observedAt) - timestampToMilliseconds(event.exchangeTimestamp);

  if (websocketLagMs < 0) {
    throw new Error(`Market data observedAt is earlier than exchangeTimestamp: ${websocketLagMs}`);
  }

  if (websocketLagMs < options.staleThresholdMs) {
    return undefined;
  }

  return createUpbitMarketDataStatusEvent({
    exchangeId: event.exchangeId,
    market: event.market,
    status: "STALE",
    observedAt: options.observedAt,
    reasonCode: options.reasonCode ?? "upbit_websocket_lag_exceeded",
    websocketLagMs,
  });
}

function toOrderbookLevel(price: string | number, size: string | number): OrderbookLevel {
  return {
    price: toNumericString(price),
    size: toNumericString(size),
  };
}

function toNumericString(value: string | number): NumericString {
  return new Decimal(value).toFixed();
}

function timestampFromMilliseconds(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function timestampToMilliseconds(timestamp: TimestampInput): number {
  const milliseconds = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);

  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid timestamp: ${String(timestamp)}`);
  }

  return milliseconds;
}
