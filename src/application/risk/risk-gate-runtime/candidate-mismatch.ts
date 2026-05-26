import { parseFinancialDecimal } from "../../../shared/index.js";
import type {
  JsonRecord,
  OrderIntent,
  OrderLifecycleStatus,
  RiskGateContext,
  RiskGateEvaluation,
  StateTransitionDecision,
} from "../../../domain/index.js";
import {
  readStringMetadata,
  toOrderIntentPayload,
} from "./payload-mapper.js";
import type { RiskGateRuntimeDecisionInput } from "./types.js";

/**
 * RiskGate 결과와 주문 상태 machine이 충돌한 상황을 fail-closed 리스크 평가로 변환한다.
 *
 * 상태 전이 자체가 거부되면 주문 승인을 진행하지 않고 manual review를 요구해 runtime snapshot과 domain state machine 계약을
 * 동시에 보호한다.
 */
export function createIllegalRiskGateOrderStateTransitionEvaluation(
  input: RiskGateRuntimeDecisionInput,
  transition: StateTransitionDecision<OrderLifecycleStatus>,
): RiskGateEvaluation {
  return {
    status: "FAIL",
    reasonCode: "risk_gate_illegal_order_state_transition",
    message: "RiskGate order state transition is not allowed by the order state machine",
    severity: "CRITICAL",
    action: "MANUAL_REVIEW_REQUIRED",
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      order_id: input.orderId,
      from_state: transition.fromState,
      to_state: transition.toState,
      state_transition_reason_code: transition.reasonCode,
      state_transition_message: transition.message,
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };
}

/**
 * runtime 주문 후보와 RiskGateContext 주문 후보가 같은지 확인한다.
 *
 * idempotency key, 주문 식별자, 시장/전략/가격/수량/예상 손실 입력이 어긋나면 stale approval 재사용으로 보고 fail-closed
 * evaluation을 반환한다.
 */
export function createRuntimeCandidateMismatchEvaluation(
  input: RiskGateRuntimeDecisionInput,
): RiskGateEvaluation | undefined {
  const intent = input.riskGateContext.orderIntent;
  const mismatches: JsonRecord = {};
  const intentOrderId = readStringMetadata(intent.metadata, "order_id");

  if (input.correlationId !== input.orderIntent.idempotencyKey) {
    mismatches.correlation_id = input.correlationId;
    mismatches.runtime_order_intent_idempotency_key = input.orderIntent.idempotencyKey;
  }
  if (intentOrderId !== undefined && intentOrderId !== input.orderId) {
    mismatches.order_id = input.orderId;
    mismatches.order_intent_metadata_order_id = intentOrderId;
  }
  appendRuntimeOrderIntentMismatch(mismatches, "order_intent_exchange_id", input.orderIntent.exchangeId, intent.exchangeId);
  appendRuntimeOrderIntentMismatch(mismatches, "order_intent_market", input.orderIntent.market, intent.market);
  appendRuntimeOrderIntentMismatch(mismatches, "order_intent_strategy_id", input.orderIntent.strategyId, intent.strategyId);
  appendRuntimeOrderIntentMismatch(mismatches, "order_intent_side", input.orderIntent.side, intent.side);
  appendRuntimeOrderIntentMismatch(mismatches, "order_intent_order_type", input.orderIntent.orderType, intent.orderType);
  appendRuntimeDecimalMismatch(
    mismatches,
    "order_intent_requested_quantity",
    input.orderIntent.requestedQuantity,
    intent.requestedQuantity,
  );
  appendRuntimeDecimalMismatch(
    mismatches,
    "order_intent_requested_notional",
    input.orderIntent.requestedNotional,
    intent.requestedNotional,
  );
  appendRuntimeDecimalMismatch(
    mismatches,
    "order_intent_requested_price",
    readOrderIntentRequestedPrice(input.orderIntent),
    readOrderIntentRequestedPrice(intent),
  );
  appendRuntimeOrderIntentMismatch(
    mismatches,
    "order_intent_idempotency_key",
    input.orderIntent.idempotencyKey,
    intent.idempotencyKey,
  );
  appendRuntimeDecimalMismatch(
    mismatches,
    "order_intent_expected_loss_bps_of_equity",
    readRuntimeExpectedLossBps(input),
    readRiskGateExpectedLossBps(input.riskGateContext),
  );

  if (Object.keys(mismatches).length === 0) {
    return undefined;
  }

  return {
    status: "FAIL",
    reasonCode: "risk_gate_runtime_candidate_mismatch",
    message: "Runtime order candidate does not match the RiskGate order intent",
    severity: "CRITICAL",
    action: "MANUAL_REVIEW_REQUIRED",
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      order_id: input.orderId,
      order_intent: toOrderIntentPayload(input.riskGateContext),
      mismatches,
    },
  };
}

function appendRuntimeOrderIntentMismatch(
  target: JsonRecord,
  fieldName: string,
  runtimeValue: string | undefined,
  riskGateValue: string | undefined,
): void {
  if (runtimeValue !== riskGateValue) {
    target[`${fieldName}_runtime`] = runtimeValue;
    target[`${fieldName}_risk_gate`] = riskGateValue;
  }
}

function appendRuntimeDecimalMismatch(
  target: JsonRecord,
  fieldName: string,
  runtimeValue: string | undefined,
  riskGateValue: string | undefined,
): void {
  appendRuntimeOrderIntentMismatch(
    target,
    fieldName,
    normalizeFinancialDecimalString(runtimeValue),
    normalizeFinancialDecimalString(riskGateValue),
  );
}

function normalizeFinancialDecimalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    return parseFinancialDecimal(value).toFixed();
  } catch {
    return value;
  }
}

function readOrderIntentRequestedPrice(intent: OrderIntent): string | undefined {
  return intent.orderType === "LIMIT" ? intent.requestedPrice : undefined;
}

function readRiskGateExpectedLossBps(context: RiskGateContext): string | undefined {
  return context.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(context.orderIntent);
}

function readRuntimeExpectedLossBps(input: RiskGateRuntimeDecisionInput): string | undefined {
  return input.expectedLossBpsOfEquity ?? readOrderIntentExpectedLossBps(input.orderIntent);
}

function readOrderIntentExpectedLossBps(intent: OrderIntent): string | undefined {
  const value =
    intent.metadata?.expected_loss_bps_of_equity ??
    intent.metadata?.expectedLossBpsOfEquity;

  return typeof value === "string" ? value : undefined;
}
