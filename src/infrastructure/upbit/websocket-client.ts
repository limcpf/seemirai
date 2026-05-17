import type { MarketDataStreamRequest, NumericString } from "../../domain/index.js";

/** Upbit 공개 시세 WebSocket endpoint다. 인증이 필요한 private endpoint는 PR2 범위에서 사용하지 않는다. */
export const UPBIT_QUOTATION_WEBSOCKET_URL = "wss://api.upbit.com/websocket/v1";

/** Upbit WebSocket 수신 포맷이다. PR2 mapper가 정규화할 수 있는 기본 필드 포맷만 허용한다. */
export type UpbitWebSocketFormat = "DEFAULT" | "JSON_LIST";

/** Upbit WebSocket에서 구독할 quotation data type이다. */
export type UpbitQuotationWebSocketType = "trade" | "orderbook";

/** Upbit WebSocket 요청 ticket object다. */
export interface UpbitWebSocketTicketObject {
  ticket: string;
}

/** Upbit WebSocket quotation data type object다. */
export interface UpbitWebSocketDataTypeObject {
  type: UpbitQuotationWebSocketType;
  codes: readonly string[];
  level?: NumericString;
  is_only_snapshot?: boolean;
  is_only_realtime?: boolean;
}

/** Upbit WebSocket format object다. */
export interface UpbitWebSocketFormatObject {
  format: UpbitWebSocketFormat;
}

/** Upbit WebSocket subscription 요청 payload다. */
export type UpbitWebSocketRequest = readonly [
  UpbitWebSocketTicketObject,
  ...UpbitWebSocketDataTypeObject[],
  UpbitWebSocketFormatObject,
];

/** Upbit orderbook 구독 대상 market 옵션이다. */
export interface UpbitOrderbookSubscriptionMarket {
  market: string;
  unit?: 1 | 5 | 15 | 30;
}

/** Upbit WebSocket 구독 생성 옵션이다. */
export interface CreateUpbitWebSocketSubscriptionOptions {
  ticket: string;
  format?: UpbitWebSocketFormat;
  isOnlySnapshot?: boolean;
  isOnlyRealtime?: boolean;
}

/** Upbit orderbook 구독 생성 옵션이다. */
export interface CreateUpbitOrderbookSubscriptionOptions extends CreateUpbitWebSocketSubscriptionOptions {
  level?: NumericString;
}

/** WebSocket 연결 생성 함수다. test와 runtime wiring에서 실제 transport를 주입할 수 있다. */
export type UpbitWebSocketFactory = (url: string) => UpbitWebSocketConnection;

/** Upbit WebSocket client 생성 옵션이다. */
export interface UpbitWebSocketClientOptions {
  url?: string;
  websocketFactory?: UpbitWebSocketFactory;
}

/** PR2에서 필요한 최소 WebSocket transport surface다. */
export interface UpbitWebSocketConnection {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
}

/**
 * Upbit quotation WebSocket client다.
 *
 * 이 client는 공개 시세 endpoint만 열고 subscription 요청을 전송한다. 인증 header나 private endpoint를
 * 만들지 않아 `PAPER_NO_KEY` 기본 프로파일에서 실거래/잔고 API 경계로 넘어가지 않는다.
 */
export class UpbitQuotationWebSocketClient {
  private readonly url: string;
  private readonly websocketFactory: UpbitWebSocketFactory;

  public constructor(options: UpbitWebSocketClientOptions = {}) {
    this.url = options.url ?? UPBIT_QUOTATION_WEBSOCKET_URL;
    this.websocketFactory = options.websocketFactory ?? createDefaultWebSocketConnection;
  }

  /**
   * application stream request에서 체결 구독 요청을 만든다.
   *
   * `consumerId`를 ticket으로 사용해 runtime worker, fixture replay, backtest bridge가 같은 market stream을
   * 구독하더라도 요청 출처를 구분할 수 있게 한다.
   */
  public createTradeSubscription(
    request: MarketDataStreamRequest,
    options: Omit<CreateUpbitWebSocketSubscriptionOptions, "ticket"> = {},
  ): UpbitWebSocketRequest {
    return createUpbitTradeSubscription({
      ticket: request.consumerId,
      markets: request.markets,
      ...options,
    });
  }

  /**
   * application stream request에서 호가 구독 요청을 만든다.
   *
   * orderbook unit suffix와 level은 Upbit 정책 조회 결과를 검증한 뒤 caller가 넣는다. 기본값은 거래소
   * 기본 30호가/level 0 흐름을 그대로 사용한다.
   */
  public createOrderbookSubscription(
    request: MarketDataStreamRequest,
    options: Omit<CreateUpbitOrderbookSubscriptionOptions, "ticket"> & {
      markets?: readonly UpbitOrderbookSubscriptionMarket[];
    } = {},
  ): UpbitWebSocketRequest {
    return createUpbitOrderbookSubscription({
      ticket: request.consumerId,
      markets: options.markets ?? request.markets.map((market) => ({ market })),
      ...(options.format === undefined ? {} : { format: options.format }),
      ...(options.isOnlyRealtime === undefined ? {} : { isOnlyRealtime: options.isOnlyRealtime }),
      ...(options.isOnlySnapshot === undefined ? {} : { isOnlySnapshot: options.isOnlySnapshot }),
      ...(options.level === undefined ? {} : { level: options.level }),
    });
  }

  /**
   * Upbit WebSocket 연결을 열고 구독 payload를 보낸다.
   *
   * transport가 이미 open 상태면 즉시 보내고, open event를 지원하면 최초 open 시점에 전송한다. 실제
   * message loop와 재연결 정책은 runtime worker PR에서 이 low-level client 위에 얹는다.
   */
  public subscribe(request: UpbitWebSocketRequest): UpbitWebSocketConnection {
    const connection = this.websocketFactory(this.url);
    const message = serializeUpbitWebSocketRequest(request);
    const send = (): void => connection.send(message);

    if (connection.readyState === 1 || connection.addEventListener === undefined) {
      send();
      return connection;
    }

    connection.addEventListener("open", send, { once: true });
    return connection;
  }
}

/**
 * Upbit trade subscription 요청을 만든다.
 *
 * 요청 payload는 ticket object, data type object, format object 순서의 JSON array다. 인증 정보나 private
 * path를 포함하지 않아 PR2 fixture와 runtime 모두 같은 공개 quotation contract를 사용한다.
 */
export function createUpbitTradeSubscription(
  options: CreateUpbitWebSocketSubscriptionOptions & {
    markets: readonly string[];
  },
): UpbitWebSocketRequest {
  return createUpbitWebSocketRequest(options.ticket, [
    createDataTypeObject("trade", options.markets, options),
  ], options.format);
}

/**
 * Upbit orderbook subscription 요청을 만든다.
 *
 * market별 조회 개수는 `KRW-BTC.15`처럼 code suffix로 표현하고, 호가 모아보기 단위는 `level` 필드로
 * 보낸다. 지원 level은 PR1의 public policy snapshot에서 검증한 값을 caller가 넘겨야 한다.
 */
export function createUpbitOrderbookSubscription(
  options: CreateUpbitOrderbookSubscriptionOptions & {
    markets: readonly UpbitOrderbookSubscriptionMarket[];
  },
): UpbitWebSocketRequest {
  const codes = options.markets.map((market) => formatOrderbookMarketCode(market));

  return createUpbitWebSocketRequest(options.ticket, [
    createDataTypeObject("orderbook", codes, options),
  ], options.format);
}

/**
 * Upbit WebSocket 요청 payload를 JSON 문자열로 직렬화한다.
 *
 * test와 runtime은 이 함수를 통해 실제 전송 문자열을 검증한다. JSON string 안에는 공개 market code와
 * 구독 옵션만 존재해야 하며 Authorization 같은 secret 후보는 들어가지 않는다.
 */
export function serializeUpbitWebSocketRequest(request: UpbitWebSocketRequest): string {
  return JSON.stringify(request);
}

function createUpbitWebSocketRequest(
  ticket: string,
  subscriptions: readonly UpbitWebSocketDataTypeObject[],
  format: UpbitWebSocketFormat = "DEFAULT",
): UpbitWebSocketRequest {
  if (ticket.trim().length === 0) {
    throw new Error("Upbit WebSocket ticket is required");
  }

  if (subscriptions.length === 0) {
    throw new Error("At least one Upbit WebSocket subscription is required");
  }

  return [
    { ticket },
    ...subscriptions,
    { format },
  ];
}

function createDataTypeObject(
  type: UpbitQuotationWebSocketType,
  codes: readonly string[],
  options: Pick<CreateUpbitWebSocketSubscriptionOptions, "isOnlyRealtime" | "isOnlySnapshot"> & {
    level?: NumericString;
  },
): UpbitWebSocketDataTypeObject {
  if (codes.length === 0) {
    throw new Error(`Upbit ${type} subscription requires at least one market`);
  }

  return {
    type,
    codes,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.isOnlySnapshot === undefined ? {} : { is_only_snapshot: options.isOnlySnapshot }),
    ...(options.isOnlyRealtime === undefined ? {} : { is_only_realtime: options.isOnlyRealtime }),
  };
}

function formatOrderbookMarketCode(market: UpbitOrderbookSubscriptionMarket): string {
  return market.unit === undefined ? market.market : `${market.market}.${market.unit}`;
}

function createDefaultWebSocketConnection(url: string): UpbitWebSocketConnection {
  const WebSocketConstructor = (globalThis as unknown as {
    WebSocket?: new (url: string) => UpbitWebSocketConnection;
  }).WebSocket;

  if (WebSocketConstructor === undefined) {
    throw new Error("globalThis.WebSocket is not available in this Node.js runtime");
  }

  return new WebSocketConstructor(url);
}
