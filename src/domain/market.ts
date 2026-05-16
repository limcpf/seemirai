import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type MarketDataEventType = "TRADE" | "ORDERBOOK" | "STATUS";
export type MarketDataConnectionStatus = "CONNECTED" | "STALE" | "RECONNECTING" | "DISCONNECTED";

export interface MarketDataStreamRequest {
  exchangeId: ExchangeId;
  markets: readonly MarketCode[];
  consumerId: string;
}

export interface TradeEvent {
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

export interface OrderbookLevel {
  price: NumericString;
  size: NumericString;
}

export interface OrderbookEvent {
  type: "ORDERBOOK";
  exchangeId: ExchangeId;
  market: MarketCode;
  asks: readonly OrderbookLevel[];
  bids: readonly OrderbookLevel[];
  exchangeTimestamp: TimestampInput;
  receivedAt: TimestampInput;
  raw?: JsonRecord;
}

export interface MarketDataStatusEvent {
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

export interface TickerSnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  tradePrice: NumericString;
  changeRate?: NumericString;
  accTradePrice24h?: NumericString;
  exchangeTimestamp: TimestampInput;
  receivedAt: TimestampInput;
}

export type MarketDataEvent = TradeEvent | OrderbookEvent | MarketDataStatusEvent;

export interface MarketStatus {
  exchangeId: ExchangeId;
  market: MarketCode;
  tradable: boolean;
  warning: boolean;
  caution: boolean;
  reasonCodes: readonly string[];
  updatedAt: TimestampInput;
}

export interface MarketPolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  baseCurrency: string;
  quoteCurrency: string;
  status: MarketStatus;
}

export interface OrderRulePolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  minimumOrderNotional: NumericString;
  priceTickSize: NumericString;
  quantityStepSize?: NumericString;
  allowedOrderTypes: readonly ("LIMIT" | "MARKET")[];
  updatedAt: TimestampInput;
}

export interface FeePolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  bidFeeBps: NumericString;
  askFeeBps: NumericString;
  makerBidFeeBps?: NumericString;
  makerAskFeeBps?: NumericString;
  updatedAt: TimestampInput;
}

export interface RateLimitPolicy {
  exchangeId: ExchangeId;
  group: "REST" | "WEBSOCKET";
  remaining?: number;
  resetAt?: TimestampInput;
  policyText?: string;
}

export interface ExchangePolicySnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  marketPolicy: MarketPolicy;
  orderRules: OrderRulePolicy;
  fees: FeePolicy;
  rateLimits: readonly RateLimitPolicy[];
  capturedAt: TimestampInput;
  raw?: JsonRecord;
}

