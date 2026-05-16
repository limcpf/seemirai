import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "POST_ONLY";

export type OrderLifecycleStatus =
  | "CREATED"
  | "VALIDATED"
  | "RISK_APPROVED"
  | "RISK_REJECTED"
  | "SUBMITTED"
  | "ACCEPTED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED"
  | "MANUAL_REVIEW_REQUIRED";

export interface OrderIntent {
  exchangeId: ExchangeId;
  market: MarketCode;
  strategyId: string;
  side: OrderSide;
  orderType: OrderType;
  requestedQuantity: NumericString;
  requestedNotional: NumericString;
  idempotencyKey: string;
  requestedPrice?: NumericString;
  postOnly?: boolean;
  timeInForce?: TimeInForce;
  reason: string;
  metadata?: JsonRecord;
}

export interface OrderSubmission {
  intent: OrderIntent;
  costSnapshot?: JsonRecord;
  riskApproval?: JsonRecord;
  submittedAt: TimestampInput;
}

export interface BrokerOrder {
  brokerOrderId: string;
  idempotencyKey: string;
  exchangeId: ExchangeId;
  market: MarketCode;
  side: OrderSide;
  orderType: OrderType;
  status: OrderLifecycleStatus;
  requestedQuantity: NumericString;
  remainingQuantity: NumericString;
  requestedPrice?: NumericString;
  acceptedAt?: TimestampInput;
  updatedAt: TimestampInput;
  metadata?: JsonRecord;
}

