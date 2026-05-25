import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type MarketDataEventType = "TRADE" | "ORDERBOOK" | "TICKER" | "STATUS";
export type MarketDataConnectionStatus = "CONNECTED" | "STALE" | "RECONNECTING" | "DISCONNECTED";

/**
 * market data stream 구독 요청이다.
 *
 * consumerId는 worker, backtest bridge, fixture replay처럼 같은 market stream을 읽는 소비자를 구분하는
 * 업무 식별자다.
 */
export interface MarketDataStreamRequest {
  exchangeId: ExchangeId;
  markets: readonly MarketCode[];
  consumerId: string;
}

/**
 * 같은 timestamp의 market data event를 결정론적으로 정렬하기 위한 선택 key다.
 *
 * adapter나 replay source가 거래소 sequence, source index, payload fingerprint를 알고 있으면 이 값을 채워
 * feature 계산과 backtest/paper parity가 입력 배열 순서에 의존하지 않게 한다. 없는 legacy 입력은 feature calculator가
 * canonical payload fallback을 만들지만, 원천 순서를 보존해야 하는 경계에서는 명시 key를 제공하는 것이 invariant다.
 */
export interface MarketDataEventOrderFields {
  sequence?: string;
  tieBreakKey?: string;
}

/**
 * 거래소 체결 이벤트를 runtime 공통 형태로 정규화한 값이다.
 *
 * exchange timestamp와 local received timestamp를 함께 보존해 WebSocket lag와 stale data 판단에 사용한다.
 */
export interface TradeEvent extends MarketDataEventOrderFields {
  type: "TRADE";
  exchangeId: ExchangeId;
  market: MarketCode;
  tradeId: string;
  price: NumericString;
  quantity: NumericString;
  side: "BID" | "ASK" | "UNKNOWN";
  exchangeTimestamp: TimestampInput;
  receivedAt: TimestampInput;
  raw?: JsonRecord;
}

/**
 * 호가 한 레벨의 가격과 잔량이다.
 *
 * 가격과 수량은 정밀도 손실을 피하기 위해 문자열 numeric 값으로 유지한다.
 */
export interface OrderbookLevel {
  price: NumericString;
  size: NumericString;
}

/**
 * 거래소 호가 이벤트를 runtime 공통 형태로 정규화한 값이다.
 *
 * adapter는 거래소별 payload를 이 구조로 바꿔 feature engine과 paper fill model이 같은 입력을 보게 한다.
 */
export interface OrderbookEvent extends MarketDataEventOrderFields {
  type: "ORDERBOOK";
  exchangeId: ExchangeId;
  market: MarketCode;
  asks: readonly OrderbookLevel[];
  bids: readonly OrderbookLevel[];
  exchangeTimestamp: TimestampInput;
  receivedAt: TimestampInput;
  raw?: JsonRecord;
}

/**
 * market data 연결 상태 이벤트다.
 *
 * stale, reconnecting, disconnected 상태는 리스크 게이트의 신규 주문 차단 입력으로 사용된다.
 */
export interface MarketDataStatusEvent extends MarketDataEventOrderFields {
  type: "STATUS";
  exchangeId: ExchangeId;
  market?: MarketCode;
  status: MarketDataConnectionStatus;
  observedAt: TimestampInput;
  reasonCode?: string;
  websocketLagMs?: number;
  reconnectCount?: number;
  metadata?: JsonRecord;
}

/**
 * 현재가와 24시간 거래대금 같은 ticker snapshot이다.
 *
 * REST 보조 조회나 stream snapshot의 결과를 같은 형태로 넘기기 위한 경계 타입이다.
 */
export interface TickerSnapshot extends MarketDataEventOrderFields {
  type: "TICKER";
  exchangeId: ExchangeId;
  market: MarketCode;
  tradePrice: NumericString;
  changeRate?: NumericString;
  accTradePrice24h?: NumericString;
  exchangeTimestamp: TimestampInput;
  receivedAt: TimestampInput;
  raw?: JsonRecord;
}

export type MarketDataEvent = TradeEvent | OrderbookEvent | TickerSnapshot | MarketDataStatusEvent;

/**
 * 단일 market의 거래 가능성과 market warning/caution 상태다.
 *
 * universe manager와 risk gate가 신규 진입 허용 여부를 판단할 때 사용하는 최소 상태 표현이다.
 */
export interface MarketStatus {
  exchangeId: ExchangeId;
  market: MarketCode;
  tradable: boolean;
  warning: boolean;
  caution: boolean;
  reasonCodes: readonly string[];
  updatedAt: TimestampInput;
}

/**
 * market 목록 조회 결과의 정규화된 정책 단위다.
 *
 * base/quote currency와 market status를 함께 보관해 거래소별 market naming 차이를 application 밖으로 밀어낸다.
 */
export interface MarketPolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  baseCurrency: string;
  quoteCurrency: string;
  status: MarketStatus;
}

/**
 * 가격 구간 하나에 적용되는 호가 단위다.
 *
 * minPrice는 포함, maxPrice는 미포함 경계로 해석한다. 비어 있는 하한이나 상한은 거래소 정책상 열린
 * 구간을 표현할 때 사용한다.
 */
export interface PriceTickBand {
  minPrice?: NumericString;
  maxPrice?: NumericString;
  tickSize: NumericString;
}

/**
 * 주문 가격 검증에 사용할 호가 단위 정책이다.
 *
 * Upbit KRW처럼 가격 구간별 tick이 달라지는 거래소는 PRICE_BANDS를 사용하고, 단일 tick만 있는 시장은
 * FIXED를 사용한다.
 */
export type PriceTickPolicy =
  | {
      kind: "FIXED";
      tickSize: NumericString;
    }
  | {
      kind: "PRICE_BANDS";
      bands: readonly PriceTickBand[];
    };

/**
 * 주문 전 검증에 필요한 주문 규칙이다.
 *
 * 최소 주문금액, 호가 단위, 허용 주문 유형을 거래소 정책 snapshot 또는 API 응답에서 주입한다.
 */
export interface OrderRulePolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  minimumOrderNotional: NumericString;
  priceTickPolicy: PriceTickPolicy;
  quantityStepSize?: NumericString;
  supportedOrderbookLevels?: readonly NumericString[];
  allowedOrderTypes: readonly ("LIMIT" | "MARKET")[];
  updatedAt: TimestampInput;
}

/**
 * 계정과 market을 결합한 주문 가능 정보다.
 *
 * policy-sync profile은 거래소의 orders/chance 계열 응답을 이 구조로 정규화해 수수료, 주문 가능 유형,
 * 가용 잔고, 주문 가능 범위를 주문 전 검증과 audit에 제공한다.
 */
export interface OrderChancePolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  allowedOrderTypes: readonly ("LIMIT" | "MARKET")[];
  bidFeeBps: NumericString;
  askFeeBps: NumericString;
  makerBidFeeBps?: NumericString;
  makerAskFeeBps?: NumericString;
  bidAvailableBalance?: NumericString;
  askAvailableBalance?: NumericString;
  minimumBidNotional?: NumericString;
  maximumBidNotional?: NumericString;
  minimumAskQuantity?: NumericString;
  maximumAskQuantity?: NumericString;
  capturedAt: TimestampInput;
  raw?: JsonRecord;
}

/**
 * 비용 계산에 필요한 수수료 정책이다.
 *
 * Upbit 정책이나 계정 조건에 따라 바뀔 수 있으므로, 비용 모델은 이 구조를 입력으로 받고 상수에 의존하지 않는다.
 */
export interface FeePolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  bidFeeBps: NumericString;
  askFeeBps: NumericString;
  makerBidFeeBps?: NumericString;
  makerAskFeeBps?: NumericString;
  updatedAt: TimestampInput;
}

/**
 * REST/WebSocket 요청 제한 상태나 정책 설명이다.
 *
 * scheduler와 adapter가 요청 대기, 차단, 재시도 판단에 사용할 수 있도록 exchange policy snapshot에 포함한다.
 */
export interface RateLimitPolicy {
  exchangeId: ExchangeId;
  group: "REST" | "WEBSOCKET";
  exchangeGroup?: string;
  remaining?: number;
  resetAt?: TimestampInput;
  policyText?: string;
}

/**
 * 주문 전 검증과 audit에 남길 거래소 정책 snapshot이다.
 *
 * 주문 후보가 어떤 market 상태, 주문 규칙, 수수료, rate limit 기준으로 판단됐는지 재현하기 위한 단위다.
 */
export interface ExchangePolicySnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  marketPolicy: MarketPolicy;
  orderRules: OrderRulePolicy;
  orderChance: OrderChancePolicy;
  fees: FeePolicy;
  rateLimits: readonly RateLimitPolicy[];
  capturedAt: TimestampInput;
  raw?: JsonRecord;
}
