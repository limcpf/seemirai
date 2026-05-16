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
 * 전략이 직접 주문을 제출하지 않고 생성하는 주문 후보 intent의 공통 필드다.
 *
 * 이후 CostModel, RiskGate, ExecutionEngine을 통과해야 broker 제출 요청으로 승격된다.
 */
export interface BaseOrderIntent {
  exchangeId: ExchangeId;
  market: MarketCode;
  strategyId: string;
  side: OrderSide;
  requestedQuantity: NumericString;
  requestedNotional: NumericString;
  idempotencyKey: string;
  reason: string;
  metadata?: JsonRecord;
}

/**
 * 지정가 주문 후보 intent다.
 *
 * MVP 실행은 지정가 중심이므로 LIMIT 후보는 가격을 필수로 둔다.
 */
export interface LimitOrderIntent extends BaseOrderIntent {
  orderType: "LIMIT";
  requestedPrice: NumericString;
  postOnly?: boolean;
  timeInForce?: TimeInForce;
}

/**
 * 시장가 주문 후보 intent다.
 *
 * MVP 기본 설정에서는 시장가 주문이 차단되지만, 차단/검증 기록을 표현하기 위해 타입은 남긴다.
 */
export interface MarketOrderIntent extends BaseOrderIntent {
  orderType: "MARKET";
  requestedPrice?: never;
  postOnly?: never;
  timeInForce?: never;
}

export type OrderIntent = LimitOrderIntent | MarketOrderIntent;

/**
 * broker port로 넘기는 주문 제출 요청이다.
 *
 * OrderIntent에 비용 snapshot과 risk 승인 근거를 필수로 붙여 PaperBroker와 future live broker가 같은 입력을 받게 한다.
 */
export interface OrderSubmission {
  intent: OrderIntent;
  costSnapshot: JsonRecord;
  riskApproval: JsonRecord;
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

/**
 * broker가 보고하는 단일 통화 잔고다.
 *
 * RiskGate의 주문 한도, 포지션 한도, balance/position mismatch 검증 입력으로 사용한다.
 */
export interface BrokerBalance {
  currency: string;
  available: NumericString;
  locked: NumericString;
  total: NumericString;
  updatedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * broker 잔고 조회 결과 snapshot이다.
 *
 * PaperBroker와 future live broker가 같은 형태로 계정 상태를 제공해 RiskGate가 구현체를 몰라도 되게 한다.
 */
export interface BrokerBalanceSnapshot {
  exchangeId: ExchangeId;
  balances: readonly BrokerBalance[];
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}
