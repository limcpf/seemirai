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

/**
 * 전략이 직접 주문을 제출하지 않고 생성하는 주문 후보 intent다.
 *
 * 이후 CostModel, RiskGate, ExecutionEngine을 통과해야 broker 제출 요청으로 승격된다.
 */
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

/**
 * broker port로 넘기는 주문 제출 요청이다.
 *
 * OrderIntent에 비용 snapshot과 risk 승인 근거를 붙여 PaperBroker와 future live broker가 같은 입력을 받게 한다.
 */
export interface OrderSubmission {
  intent: OrderIntent;
  costSnapshot?: JsonRecord;
  riskApproval?: JsonRecord;
  submittedAt: TimestampInput;
}

/**
 * broker가 관리하는 주문 상태의 공통 표현이다.
 *
 * MVP PaperBroker와 future live broker의 조회 결과를 같은 형태로 맞춰 execution layer가 구현체를 몰라도 되게 한다.
 */
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
