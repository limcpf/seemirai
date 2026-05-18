import type { RuleEngineResult } from "../rules/index.js";
import type { StrategyDecisionIntentConversion } from "../strategies/index.js";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../ports/index.js";
import type {
  CostDecision,
  ExchangeId,
  JsonRecord,
  MarketCode,
  OrderIntent,
  StrategyDecision,
  TimestampInput,
} from "../../domain/index.js";

export type OrderCandidateDiscardStage =
  | "STRATEGY_DECISION"
  | "INTENT_CONVERSION"
  | "COST_DECISION"
  | "RULE_ENGINE";

/**
 * 주문 후보 폐기 audit event 생성에 필요한 판단 snapshot이다.
 */
export interface OrderCandidateDiscardAuditInput {
  occurredAt: TimestampInput;
  actor: string;
  exchangeId?: ExchangeId;
  market?: MarketCode;
  strategyId?: string;
  orderId?: string;
  correlationId?: string;
  strategyDecision?: StrategyDecision;
  intentConversion?: StrategyDecisionIntentConversion;
  costDecision?: CostDecision;
  ruleResult?: RuleEngineResult;
  orderIntent?: OrderIntent;
  metadata?: JsonRecord;
}

/**
 * 주문 후보 폐기 감사 이벤트를 저장소에 append한다.
 *
 * 실제 폐기 판단이 없으면 audit log를 쓰지 않아 HOLD/PASS 흐름이 불필요하게 누적되지 않게 한다.
 */
export async function appendOrderCandidateDiscardAudit(
  auditLog: AuditLogPort,
  input: OrderCandidateDiscardAuditInput,
): Promise<AuditEventReceipt | undefined> {
  if (!isOrderCandidateDiscarded(input)) {
    return undefined;
  }

  return auditLog.appendEvent(toOrderCandidateDiscardAuditEvent(input));
}

/**
 * 주문 후보 폐기 판단을 `ORDER_DECISION` audit event로 변환한다.
 */
export function toOrderCandidateDiscardAuditEvent(
  input: OrderCandidateDiscardAuditInput,
): AuditEvent {
  const stage = inferDiscardStage(input);

  if (stage === undefined) {
    throw new Error("order candidate discard audit requires a discard decision");
  }

  const strategyId = inferStrategyId(input);
  const event: AuditEvent = {
    eventType: "ORDER_DECISION",
    severity: "WARN",
    occurredAt: input.occurredAt,
    actor: input.actor,
    reasonCode: inferReasonCode(input, stage),
    metadata: toDiscardPayload(input, stage),
  };

  if (input.orderId !== undefined) {
    event.orderId = input.orderId;
  }

  if (input.correlationId !== undefined) {
    event.correlationId = input.correlationId;
  }

  if (strategyId !== undefined) {
    event.strategyId = strategyId;
  }

  return event;
}

/**
 * 입력 snapshot이 실제 주문 후보 폐기 사유를 포함하는지 판단한다.
 */
export function isOrderCandidateDiscarded(input: OrderCandidateDiscardAuditInput): boolean {
  return inferDiscardStage(input) !== undefined;
}

function inferDiscardStage(
  input: OrderCandidateDiscardAuditInput,
): OrderCandidateDiscardStage | undefined {
  // 1. 전략이 직접 BLOCK한 후보는 conversion reject와 함께 전달돼도 실제 폐기 지점을 전략 판단으로 남긴다.
  if (input.strategyDecision !== undefined && input.strategyDecision.kind === "BLOCK") {
    return "STRATEGY_DECISION";
  }

  // 2. 전략 판단을 OrderIntent로 승격하지 못한 경우를 기록한다.
  if (input.intentConversion !== undefined && input.intentConversion.status === "REJECTED") {
    return "INTENT_CONVERSION";
  }

  // 3. 비용 모델이 거부한 후보는 실행/risk 단계로 넘기지 않는다.
  if (input.costDecision !== undefined && !input.costDecision.tradeAllowed) {
    return "COST_DECISION";
  }

  // 4. rule fail은 cost를 통과한 후보를 rule chain에서 폐기한 판단이다.
  if (input.ruleResult !== undefined && !input.ruleResult.passed) {
    return "RULE_ENGINE";
  }

  return undefined;
}

function inferReasonCode(
  input: OrderCandidateDiscardAuditInput,
  stage: OrderCandidateDiscardStage,
): string {
  if (stage === "RULE_ENGINE") {
    return input.ruleResult?.failedEvaluations[0]?.reasonCode ?? "rule_engine_failed";
  }

  if (stage === "COST_DECISION") {
    return input.costDecision?.reasonCode ?? "cost_decision_rejected";
  }

  if (stage === "INTENT_CONVERSION") {
    return input.intentConversion?.reasonCode ?? "order_intent_rejected";
  }

  return input.strategyDecision?.kind === "BLOCK"
    ? input.strategyDecision.reasonCode
    : "strategy_decision_blocked";
}

function inferStrategyId(input: OrderCandidateDiscardAuditInput): string | undefined {
  return (
    input.strategyId ??
    input.strategyDecision?.strategyId ??
    inferOrderIntent(input)?.strategyId
  );
}

function inferExchangeId(input: OrderCandidateDiscardAuditInput): ExchangeId | undefined {
  return input.exchangeId ?? inferOrderIntent(input)?.exchangeId;
}

function inferMarket(input: OrderCandidateDiscardAuditInput): MarketCode | undefined {
  return input.market ?? inferOrderIntent(input)?.market;
}

function inferOrderIntent(input: OrderCandidateDiscardAuditInput): OrderIntent | undefined {
  if (input.orderIntent !== undefined) {
    return input.orderIntent;
  }

  const convertedIntent = input.intentConversion?.orderIntents[0];

  if (convertedIntent !== undefined) {
    return convertedIntent;
  }

  if (input.strategyDecision?.kind === "ORDER_INTENT") {
    return input.strategyDecision.orderIntents[0];
  }

  return undefined;
}

function toDiscardPayload(
  input: OrderCandidateDiscardAuditInput,
  stage: OrderCandidateDiscardStage,
): JsonRecord {
  const payload: JsonRecord = {
    audit_kind: "ORDER_CANDIDATE_DISCARDED",
    discard_stage: stage,
    actor: input.actor,
    reason_code: inferReasonCode(input, stage),
  };

  assignIfDefined(payload, "exchange_id", inferExchangeId(input));
  assignIfDefined(payload, "market", inferMarket(input));
  assignIfDefined(payload, "strategy_id", inferStrategyId(input));
  assignIfDefined(payload, "correlation_id", input.correlationId);
  assignIfDefined(payload, "strategy_decision", toStrategyDecisionPayload(input.strategyDecision));
  assignIfDefined(payload, "intent_conversion", toIntentConversionPayload(input.intentConversion));
  assignIfDefined(payload, "cost_decision", toCostDecisionPayload(input.costDecision));
  assignIfDefined(payload, "rule_result", toRuleResultPayload(input.ruleResult));
  assignIfDefined(payload, "order_intent", toOrderIntentPayload(inferOrderIntent(input)));
  assignIfDefined(payload, "metadata", input.metadata);

  return payload;
}

function toStrategyDecisionPayload(decision: StrategyDecision | undefined): JsonRecord | undefined {
  if (decision === undefined) {
    return undefined;
  }

  const payload: JsonRecord = {
    kind: decision.kind,
    strategy_id: decision.strategyId,
    reason: decision.reason,
  };

  if (decision.kind === "BLOCK") {
    payload.reason_code = decision.reasonCode;
  }

  if (decision.kind === "ORDER_INTENT") {
    payload.order_intent_count = decision.orderIntents.length;
  }

  assignIfDefined(payload, "metadata", decision.metadata);

  return payload;
}

function toIntentConversionPayload(
  conversion: StrategyDecisionIntentConversion | undefined,
): JsonRecord | undefined {
  if (conversion === undefined) {
    return undefined;
  }

  const payload: JsonRecord = {
    status: conversion.status,
    reason_code: conversion.reasonCode,
    message: conversion.message,
    rejection_count: conversion.rejections.length,
    rejections: [...conversion.rejections],
  };

  assignIfDefined(payload, "metadata", conversion.metadata);

  return payload;
}

function toCostDecisionPayload(decision: CostDecision | undefined): JsonRecord | undefined {
  if (decision === undefined) {
    return undefined;
  }

  return {
    kind: decision.kind,
    trade_allowed: decision.tradeAllowed,
    reason_code: decision.reasonCode,
    message: decision.message,
    snapshot: decision.snapshot,
  };
}

function toRuleResultPayload(result: RuleEngineResult | undefined): JsonRecord | undefined {
  if (result === undefined) {
    return undefined;
  }

  return {
    status: result.status,
    passed: result.passed,
    evaluations: [...result.evaluations],
    failed_evaluations: [...result.failedEvaluations],
    warning_evaluations: [...result.warningEvaluations],
  };
}

function toOrderIntentPayload(intent: OrderIntent | undefined): JsonRecord | undefined {
  if (intent === undefined) {
    return undefined;
  }

  const payload: JsonRecord = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    idempotency_key: intent.idempotencyKey,
    reason: intent.reason,
  };

  if (intent.orderType === "LIMIT") {
    payload.requested_price = intent.requestedPrice;
  }

  assignIfDefined(payload, "metadata", intent.metadata);

  return payload;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
