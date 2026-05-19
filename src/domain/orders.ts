import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "POST_ONLY";

/**
 * 주문 lifecycle에서 허용하는 canonical 상태 목록이다.
 */
// DB check constraint, state machine, order_events mapper가 같은 문자열 계약을 공유한다.
export const orderLifecycleStatuses = [
  "CREATED",
  "VALIDATED",
  "RISK_APPROVED",
  "RISK_REJECTED",
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCEL_REQUESTED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type OrderLifecycleStatus = (typeof orderLifecycleStatuses)[number];

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
 * MVP 실행은 지정가 중심이므로 LIMIT 후보는 가격을 필수로 둔다. `postOnly`와 `timeInForce`는 후속 PaperBroker가
 * maker-only, IOC/FOK, aggressive limit 체결 여부를 판단하는 실행 조건이므로 ExecutionEngine evidence fingerprint에도
 * 포함된다.
 */
export interface LimitOrderIntent extends BaseOrderIntent {
  orderType: "LIMIT";
  /** broker와 fill simulator가 사용할 지정가 가격이다. */
  requestedPrice: NumericString;
  /** true이면 taker 체결 가능성이 있는 주문을 PaperBroker가 즉시 체결시키지 않고 post-only 조건으로 다룬다. */
  postOnly?: boolean;
  /** 주문 유효 시간 정책이며, 후속 fill/cancel simulation에서 체결 실패 시 상태 전이를 결정하는 입력이다. */
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
 * 이 타입은 broker side effect 직전 경계이므로, application layer는 snapshot과 approval이 현재 intent fingerprint와
 * 일치하는지 다시 검증한 뒤에만 제출할 수 있다.
 */
export interface OrderSubmission {
  intent: OrderIntent;
  /**
   * CostModel이 해당 주문 후보를 허용한 근거 snapshot이다.
   *
   * ExecutionEngine에서는 단순 `trade_allowed`만 보지 않고, source/reason/input 상태와 주문 fingerprint를 함께 대조한다.
   */
  costSnapshot: JsonRecord;
  /**
   * RiskGate가 해당 주문 후보를 승인한 근거 snapshot이다.
   *
   * 저장소나 mapper 경계를 거친 뒤에도 stale approval을 재사용하지 않도록 source/status/action과 주문 fingerprint를
   * ExecutionEngine에서 다시 검증한다.
   */
  riskApproval: JsonRecord;
  /**
   * RiskGate가 단일 주문 예상 손실 한도 평가에 사용한 top-level 입력이다.
   *
   * 기존 OrderIntent metadata에 중복 저장하지 않는 runtime 경로도 ExecutionEngine에서 같은 fingerprint로 대조할 수 있게
   * submission boundary에 보존한다.
   */
  expectedLossBpsOfEquity?: NumericString;
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
