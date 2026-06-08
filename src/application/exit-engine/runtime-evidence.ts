import type { DecisionEvidenceItem, DecisionLedgerJsonRecord } from "../decision-ledger/types.js";
import type { DecisionFrameCategory, EvidenceKind } from "../decision-ledger/category.js";
import type { ExitDecision, ExitIntention, ExitSizing } from "../../domain/index.js";

/**
 * Exit 판단 결과를 decision ledger에 남길 evidence item을 생성한다.
 *
 * 이 모듈은 exit 판단, sizing, 실행 결과를 M18 decision ledger의 SELL/HOLD/EXECUTION_REJECTED
 * category와 STRATEGY_DECISION/EXECUTION_RESULT/PnL_STATUS_CONTEXT evidence kind로 변환한다.
 * DB나 외부 side effect는 없으며 순수 변환 함수들로만 구성된다.
 */

/**
 * ExitExecutionEvidence 생성 입력이다.
 */
export interface ExitExecutionEvidenceInput {
  /** exit 판단 */
  decision: ExitDecision;
  /** sizing 결과 */
  sizing: ExitSizing;
  /** 실행 상관 식별자 (broker order id 등) */
  correlationId?: string;
  /** 실행 결과 상태 */
  executionStatus: "FILLED" | "PARTIALLY_FILLED" | "OPEN" | "REJECTED" | "FAILED" | "CANCELED";
  /** 체결 수량 */
  filledQuantity?: string;
  /** 남은 수량 */
  remainingQuantity?: string;
  /** exit 의도 */
  exitIntention: ExitIntention;
  /** 시장 식별자 */
  market: string;
  /** 전략 식별자 */
  strategyId: string;
  /** append-only ledger dedupe에 사용할 안정 evidence key */
  evidenceKey?: string;
}

/**
 * partial fill 이후 dust 잔량을 취소로 닫았음을 남기는 evidence 입력이다.
 *
 * dust 잔량은 새 주문 후보를 만들지 않으므로, 원 broker 잔량과 취소된 수량을 별도 payload로 보존해
 * 재호가 누락이 아니라 정책에 따른 종료임을 `/status.why`가 설명할 수 있게 한다.
 */
export interface ExitRemainingDustEvidenceInput {
  /** 실행 상관 식별자 (broker order id 등) */
  correlationId: string;
  /** 체결 수량 */
  filledQuantity: string;
  /** cancel 직전 dust 잔량 */
  remainingQuantity: string;
  /** dust로 판단되어 취소된 수량 */
  canceledQuantity: string;
  /** cancel 이후 broker snapshot의 잔량 */
  brokerRemainingQuantityAfterCancel: string;
  /** 정책 처리 불가 잔량 기준값 */
  dustThreshold: string;
  /** exit 의도 */
  exitIntention: ExitIntention;
  /** 시장 식별자 */
  market: string;
  /** 전략 식별자 */
  strategyId: string;
  /** append-only ledger dedupe에 사용할 안정 evidence key */
  evidenceKey?: string;
}

/**
 * exit 판단을 decision evidence item으로 변환한다.
 *
 * SELL/HOLD/BLOCK 판단을 STRATEGY_DECISION evidence로 남긴다.
 */
export function createExitStrategyEvidence(
  decision: ExitDecision,
  market: string,
  strategyId: string,
): DecisionEvidenceItem {
  const category: DecisionFrameCategory = exitDecisionToCategory(decision.kind);
  const occurredAt = typeof decision.observedAt === "string"
    ? new Date(decision.observedAt)
    : new Date(decision.observedAt as unknown as string);

  const payload: DecisionLedgerJsonRecord = {
    exit_kind: decision.kind,
    reason_code: decision.reasonCode,
    triggered_rules: decision.triggeredRules.map((r) => r.ruleId),
    blocked_rules: decision.blockedRules.map((r) => r.ruleId),
    user_message: decision.userMessage,
  };

  return {
    evidenceKind: "STRATEGY_DECISION",
    category,
    reasonCode: decision.reasonCode,
    userMessage: decision.userMessage,
    impact: exitDecisionImpact(decision.kind),
    action: exitDecisionAction(decision.kind),
    occurredAt,
    source: "exit-engine",
    sourceId: strategyId,
    payload,
    evidenceFingerprint: `exit-strategy-${decision.reasonCode}-${market}-${strategyId}-${occurredAt.toISOString()}`,
    trace: {
      market,
      strategyId,
      exitKind: decision.kind,
    },
  };
}

/**
 * exit 실행 결과를 decision evidence item으로 변환한다.
 *
 * broker 실행 결과(FILLED/PARTIALLY_FILLED/OPEN/REJECTED/FAILED)를 EXECUTION_RESULT evidence로 남긴다.
 */
export function createExitExecutionEvidence(
  input: ExitExecutionEvidenceInput,
  occurredAt: Date = new Date(),
): DecisionEvidenceItem {
  const category = exitExecutionToCategory(input.executionStatus);
  const evidenceKind: EvidenceKind = "EXECUTION_RESULT";

  const filledQty = input.filledQuantity ?? input.sizing.executableQuantity;
  const remainingQty = input.remainingQuantity ?? "0";
  const isPartialFill = input.executionStatus === "PARTIALLY_FILLED" && remainingQty !== "0";
  const isOpen = input.executionStatus === "OPEN" && remainingQty !== "0";
  const isCanceled = input.executionStatus === "CANCELED";
  const isRejected = input.executionStatus === "REJECTED" || input.executionStatus === "FAILED";

  const { userMessage, impact, action } = buildExitExecutionUserMessage(
    input,
    isPartialFill,
    isOpen,
    isCanceled,
    isRejected,
  );

  const payload: DecisionLedgerJsonRecord = {
    execution_status: input.executionStatus,
    exit_intention: input.exitIntention,
    filled_quantity: filledQty,
    remaining_quantity: remainingQty,
    market: input.market,
    strategy_id: input.strategyId,
    ...(isPartialFill ? { partial_fill_remaining_action: "cancel_or_requote_required" as const } : {}),
    ...(isOpen ? { open_order_remaining_action: "cancel_or_requote_required" as const } : {}),
    ...(isCanceled ? { cancel_requote_status: "open_remaining_canceled" as const } : {}),
    ...(isRejected ? { new_entry_block_required: true as const, manual_review_required: true as const } : {}),
  };

  return {
    evidenceKind,
    category,
    reasonCode: input.executionStatus,
    userMessage,
    impact,
    action,
    occurredAt,
    source: "exit-execution",
    sourceId: input.correlationId ?? input.strategyId,
    payload,
    evidenceFingerprint: input.evidenceKey ?? createExitExecutionFingerprint(input),
    trace: {
      market: input.market,
      strategyId: input.strategyId,
      correlationId: input.correlationId ?? null,
      exitIntention: input.exitIntention,
    },
  };
}

/**
 * partial fill dust 잔량을 cancel 후 재호가 없이 닫은 evidence를 생성한다.
 *
 * 이 evidence는 실패가 아니라 정책적 종료이므로 EXECUTED category로 남기고,
 * remaining_exit_intent_created=false를 명시해 후속 runner가 잔량 재호가 누락으로 오해하지 않게 한다.
 */
export function createExitRemainingDustEvidence(
  input: ExitRemainingDustEvidenceInput,
  occurredAt: Date = new Date(),
): DecisionEvidenceItem {
  const payload: DecisionLedgerJsonRecord = {
    execution_status: "CANCELED",
    exit_intention: input.exitIntention,
    filled_quantity: input.filledQuantity,
    remaining_quantity: input.remainingQuantity,
    canceled_quantity: input.canceledQuantity,
    broker_remaining_quantity_after_cancel: input.brokerRemainingQuantityAfterCancel,
    dust_threshold: input.dustThreshold,
    remaining_exit_intent_created: false,
    cancel_requote_status: "dust_remaining_canceled",
    market: input.market,
    strategy_id: input.strategyId,
  };

  return {
    evidenceKind: "EXECUTION_RESULT",
    category: "EXECUTED",
    reasonCode: "exit_remaining_dust_closed",
    userMessage: `${input.market} 청산 주문의 잔량 ${input.remainingQuantity}이(가) 처리 불가 잔량 기준값 ${input.dustThreshold} 이하라 취소 후 추가 주문을 만들지 않았습니다.`,
    impact: "처리 불가 잔량은 정책에 따라 닫혔고, 잔량 재호가 주문은 생성되지 않았습니다.",
    action: "포지션 잔량이 기대와 다르면 수동으로 확인하세요.",
    occurredAt,
    source: "exit-execution",
    sourceId: input.correlationId,
    payload,
    evidenceFingerprint: input.evidenceKey ?? `exit-dust-${input.correlationId}-${input.remainingQuantity}`,
    trace: {
      market: input.market,
      strategyId: input.strategyId,
      correlationId: input.correlationId,
      exitIntention: input.exitIntention,
    },
  };
}

/**
 * exit 실패 또는 reconcile mismatch를 신규 진입 중지 + manual review evidence로 변환한다.
 *
 * exit 실패, position quantity mismatch, cancel 실패 등은 kill switch NEW_ORDERS_BLOCKED와
 * MANUAL_REVIEW_REQUIRED evidence로 수렴해야 한다.
 */
export function createExitFailureManualReviewEvidence(
  reason: string,
  reasonCode: string,
  market: string,
  strategyId: string,
  occurredAt: Date = new Date(),
  evidenceKey?: string,
): DecisionEvidenceItem {
  const payload: DecisionLedgerJsonRecord = {
    exit_failure_reason: reason,
    exit_failure_reason_code: reasonCode,
    new_orders_blocked: true,
    manual_review_required: true,
    market,
    strategy_id: strategyId,
  };

  return {
    evidenceKind: "EXECUTION_RESULT",
    category: "EXECUTION_REJECTED",
    reasonCode,
    userMessage: `청산 실행이 실패했습니다: ${reason}`,
    impact: "신규 진입이 차단되었습니다. 포지션에 대한 수동 검토가 필요합니다.",
    action: "청산 실패 원인을 확인하고 수동으로 조치하세요. 신규 진입은 차단된 상태입니다.",
    occurredAt,
    source: "exit-execution",
    sourceId: strategyId,
    payload,
    evidenceFingerprint: evidenceKey ?? `exit-failure-${reasonCode}-${market}-${strategyId}`,
    trace: {
      market,
      strategyId,
      exitFailureReasonCode: reasonCode,
    },
  };
}

/**
 * PnL/position context evidence를 생성한다.
 *
 * exit 후 position이 어떻게 변경되었는지 PNL_STATUS_CONTEXT evidence로 남긴다.
 */
export function createExitPnLStatusEvidence(
  market: string,
  strategyId: string,
  remainingQuantity: string,
  averageExitPrice: string | null,
  occurredAt: Date = new Date(),
  evidenceKey?: string,
): DecisionEvidenceItem {
  const payload: DecisionLedgerJsonRecord = {
    market,
    strategy_id: strategyId,
    remaining_position_quantity: remainingQuantity,
    average_exit_price: averageExitPrice,
    position_closed: remainingQuantity === "0",
  };

  const userMessage = remainingQuantity === "0"
    ? `${market} 포지션이 전량 청산되었습니다.`
    : `${market} 포지션 잔량 ${remainingQuantity}이(가) 남아 있습니다.`;

  return {
    evidenceKind: "PNL_STATUS_CONTEXT",
    category: "EXECUTED",
    reasonCode: "exit_pnl_status",
    userMessage,
    impact: remainingQuantity === "0"
      ? "포지션이 종료되었습니다."
      : "일부 포지션이 남아 있습니다. 필요 시 추가 청산을 검토하세요.",
    action: remainingQuantity === "0" ? null : "잔여 포지션 상태를 확인하고 추가 청산 여부를 판단하세요.",
    occurredAt,
    source: "exit-execution",
    sourceId: strategyId,
    payload,
    evidenceFingerprint: evidenceKey ?? `exit-pnl-${market}-${strategyId}-${remainingQuantity}-${averageExitPrice ?? "unknown"}`,
    trace: {
      market,
      strategyId,
      remainingQuantity,
    },
  };
}

// ---------------------------------------------------------------------------
// 내부 helper
// ---------------------------------------------------------------------------

function exitDecisionToCategory(kind: string): DecisionFrameCategory {
  switch (kind) {
    case "EXIT":
      return "SELL";
    case "REDUCE":
      return "SELL";
    case "HOLD":
      return "HOLD";
    case "BLOCK":
      return "DISCARD";
    default:
      return "HOLD";
  }
}

function exitExecutionToCategory(status: string): DecisionFrameCategory {
  switch (status) {
    case "FILLED":
      return "EXECUTED";
    case "PARTIALLY_FILLED":
      return "EXECUTED";
    case "OPEN":
      return "EXECUTED";
    case "REJECTED":
      return "EXECUTION_REJECTED";
    case "FAILED":
      return "EXECUTION_REJECTED";
    case "CANCELED":
      return "EXECUTED";
    default:
      return "EXECUTION_REJECTED";
  }
}

function exitDecisionImpact(kind: string): string | null {
  switch (kind) {
    case "EXIT":
      return "전체 포지션이 청산됩니다.";
    case "REDUCE":
      return "포지션이 일부 축소됩니다.";
    case "HOLD":
      return "청산 조건이 충족되지 않아 포지션을 유지합니다.";
    case "BLOCK":
      return "청산 판단이 차단되어 포지션 변동이 없습니다.";
    default:
      return null;
  }
}

function exitDecisionAction(kind: string): string | null {
  switch (kind) {
    case "EXIT":
    case "REDUCE":
      return "청산 주문이 실행 단계로 넘어갑니다.";
    case "HOLD":
      return "시장 상황 변화를 모니터링하세요.";
    case "BLOCK":
      return "차단 원인을 확인하고 해결 후 다시 시도하세요.";
    default:
      return null;
  }
}

function buildExitExecutionUserMessage(
  input: ExitExecutionEvidenceInput,
  isPartialFill: boolean,
  isOpen: boolean,
  isCanceled: boolean,
  isRejected: boolean,
): { userMessage: string; impact: string | null; action: string | null } {
  const exitLabel = input.exitIntention === "EXIT" ? "전체 청산" : "부분 축소";

  if (isRejected) {
    return {
      userMessage: `${input.market} ${exitLabel} 주문이 거부되었습니다.`,
      impact: "신규 진입이 차단되고 수동 검토가 필요합니다.",
      action: "청산 실패 원인을 확인하고 수동으로 조치하세요.",
    };
  }

  if (isPartialFill) {
    const filledQty = input.filledQuantity ?? "0";
    const remainingQty = input.remainingQuantity ?? "0";
    return {
      userMessage: `${input.market} ${exitLabel} 주문이 부분 체결되었습니다. 체결: ${filledQty}, 잔량: ${remainingQty}`,
      impact: `일부만 체결되어 ${remainingQty}의 잔량이 남았습니다. 잔량에 대한 취소/재호가 또는 후속 청산이 필요합니다.`,
      action: "잔량 취소 후 재호가하거나, 잔량을 새로운 청산 주문으로 생성하세요.",
    };
  }

  if (isOpen) {
    const remainingQty = input.remainingQuantity ?? "0";
    return {
      userMessage: `${input.market} ${exitLabel} 주문이 접수되었지만 아직 체결되지 않았습니다. 잔량: ${remainingQty}`,
      impact: `미체결 잔량 ${remainingQty}이(가) 열려 있습니다. 잔량에 대한 취소/재호가 또는 후속 청산이 필요합니다.`,
      action: "미체결 주문을 취소한 뒤 재호가하거나, 잔량을 새로운 청산 주문으로 생성하세요.",
    };
  }

  if (isCanceled) {
    return {
      userMessage: `${input.market} ${exitLabel} 주문의 미체결 잔량을 취소했습니다.`,
      impact: "열려 있던 잔량 주문이 닫혔습니다. 필요한 경우 잔량 청산 재호가를 이어서 생성합니다.",
      action: "생성된 잔량 청산 주문 후보와 포지션 잔량을 확인하세요.",
    };
  }

  return {
    userMessage: `${input.market} ${exitLabel} 주문이 정상 실행되었습니다.`,
    impact: exitLabel === "전체 청산"
      ? "포지션이 종료되었습니다."
      : "포지션이 축소되었습니다.",
    action: null,
  };
}

function createExitExecutionFingerprint(input: ExitExecutionEvidenceInput): string {
  return [
    "exit-execution",
    input.executionStatus,
    input.correlationId ?? "no-correlation",
    input.market,
    input.strategyId,
    input.exitIntention,
    input.filledQuantity ?? "unknown-filled",
    input.remainingQuantity ?? "unknown-remaining",
  ].join("-");
}
