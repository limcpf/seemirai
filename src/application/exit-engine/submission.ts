import type {
  ExitDecision,
  ExitIntention,
  ExitOrderIntent,
  ExitOrderIntentMetadata,
  ExitPolicySnapshot,
  ExitPositionScope,
  ExitSizing,
  JsonRecord,
  OrderSubmission,
  TimestampInput,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

/**
 * ExitDecision과 sizing 결과를 broker에 제출할 수 있는 OrderSubmission으로 승격한다.
 *
 * sub PR 01이 생성한 ExitDecision, ExitSizing, ExitPolicySnapshot을 실행 경계(ExecutionEngine)가
 * 해석할 수 있는 OrderSubmission으로 변환하는 adapter다. 이 함수는 외부 side effect 없이
 * 순수 변환만 수행한다.
 */

/**
 * ExitSubmission 생성 입력이다.
 *
 * sizing이 유효하지 않으면 submission을 만들지 않고 null을 반환한다.
 */
export interface ExitSubmissionInput {
  /** exit rule 엔진이 생성한 최종 exit 판단 */
  decision: ExitDecision;
  /** sizing 검증 결과 */
  sizing: ExitSizing;
  /** 현재 청산 대상 position scope. scope 결측을 기본값으로 보정하지 않기 위해 호출자가 명시한다. */
  positionScope: ExitPositionScope;
  /** exit 정책 snapshot */
  policySnapshot: ExitPolicySnapshot;
  /** 현재 시장가. 제출 지정가는 검증된 `sizing.requestedPrice`를 사용하며, 이 값은 runtime 입력 호환성을 위해 유지한다. */
  currentPrice: string;
  /** RiskGate가 현재 exit intent를 승인한 evidence snapshot */
  riskApproval: JsonRecord;
  /** 재시도와 ledger dedupe가 공유할 안정 idempotency key */
  idempotencyKey: string;
  /** RiskGate 단일 주문 손실 한도 평가 입력 */
  expectedLossBpsOfEquity?: string;
  /** 제출 시각 */
  submittedAt: TimestampInput;
}

/**
 * ExitSubmission 생성 결과다.
 *
 * 생성 성공 시 submission과 exitOrderIntent를 모두 반환하며, sizing이 유효하지 않으면 null이다.
 */
export interface ExitSubmissionResult {
  submission: OrderSubmission;
  exitOrderIntent: ExitOrderIntent;
}

/**
 * ExitDecision과 ExitSizing을 broker 제출용 OrderSubmission으로 변환한다.
 *
 * ExitSizing이 유효하지 않으면 null을 반환해 broker side effect로 이어지지 않게 한다.
 * exit 비용 evidence는 entry cost_margin_ok와 다른 source=exit_cost_model로 분리한다.
 *
 * @returns ExitSubmissionResult 또는 sizing이 유효하지 않으면 null
 */
export function createExitSubmission(input: ExitSubmissionInput): ExitSubmissionResult | null {
  if (!input.sizing.valid) {
    return null;
  }

  const sizing = input.sizing;
  const decision = input.decision;
  if (decision.kind !== "REDUCE" && decision.kind !== "EXIT") {
    // HOLD/BLOCK 판단은 청산 side effect 후보가 아니므로 SELL intent로 낮추지 않는다.
    return null;
  }

  const exitIntention = resolveExitIntention(decision);
  if (exitIntention === "EXIT" && !isFullExitQuantity(sizing, input.positionScope)) {
    // 전체 청산 metadata와 부분 수량이 갈라지면 운영자가 포지션 종료로 오인하므로 broker 제출 전에 차단한다.
    return null;
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    // 실행 경계에서 중복 억제 기준이 사라지면 broker side effect를 안전하게 재시도할 수 없다.
    return null;
  }

  // 지정가는 sizing 단계에서 호가 단위와 최소 주문금액 기준을 통과한 가격만 사용한다.
  const requestedPrice = sizing.requestedPrice;

  const positionScope = input.positionScope;
  const notionalEstimate = calculateExitNotional(requestedPrice, sizing.executableQuantity);
  if (notionalEstimate === null) {
    // 가격과 수량이 Decimal로 해석되지 않으면 최소 주문금액/리스크 evidence를 재현할 수 없어 후보를 만들지 않는다.
    return null;
  }

  const exitMetadata: ExitOrderIntentMetadata = {
    position_effect: exitIntention,
    exit_reason_code: decision.reasonCode,
    exit_rule_id: resolveExitRuleId(decision),
    position_scope: positionScope,
    exit_cost_bps: input.policySnapshot.exitCostBps,
    exit_slippage_bps: input.policySnapshot.exitSlippageBps,
  };

  const exitOrderIntent: ExitOrderIntent = {
    exchangeId: "upbit_krw_spot",
    market: positionScope.market,
    strategyId: positionScope.strategyId,
    side: "SELL",
    orderType: "LIMIT",
    requestedQuantity: sizing.executableQuantity,
    requestedNotional: notionalEstimate,
    idempotencyKey,
    reason: decision.userMessage,
    requestedPrice,
    timeInForce: "GTC",
    metadata: exitMetadata,
  };

  // exit 비용 evidence: entry cost_margin_ok와 분리된 exit_cost_model contract
  const costSnapshot = {
    source: "exit_cost_model" as const,
    exit_cost_allowed: true,
    exit_cost_reason_code: "exit_cost_margin_ok",
    exit_cost_bps: input.policySnapshot.exitCostBps,
    exit_slippage_bps: input.policySnapshot.exitSlippageBps,
    position_scope: {
      market: positionScope.market,
      strategy_id: positionScope.strategyId,
      total_quantity: positionScope.totalQuantity,
    },
  };

  const submission: OrderSubmission = {
    intent: exitOrderIntent,
    costSnapshot,
    riskApproval: input.riskApproval,
    submittedAt: input.submittedAt,
  };
  if (input.expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = input.expectedLossBpsOfEquity;
  }

  return { submission, exitOrderIntent };
}

/**
 * ExitDecision에서 ExitIntention(REDUCE|EXIT)을 추출한다.
 *
 * HOLD/BLOCK인 경우 호출자가 이미 null을 반환했어야 하므로, 기본값으로 REDUCE를 사용한다.
 */
function resolveExitIntention(decision: ExitDecision): ExitIntention {
  if (decision.kind === "EXIT") return "EXIT";
  return "REDUCE";
}

function isFullExitQuantity(sizing: ExitSizing, positionScope: ExitPositionScope): boolean {
  try {
    return parseFinancialDecimal(sizing.executableQuantity).equals(parseFinancialDecimal(positionScope.totalQuantity));
  } catch {
    return false;
  }
}

/**
 * ExitDecision에서 trigger한 rule id 목록을 추출한다.
 */
function resolveExitRuleId(decision: ExitDecision): string {
  const ids = decision.triggeredRules.map((r) => r.ruleId);
  return ids.length > 0 ? ids.join("+") : "exit_unknown";
}

function calculateExitNotional(price: string, quantity: string): string | null {
  try {
    const priceDecimal = parseFinancialDecimal(price);
    const quantityDecimal = parseFinancialDecimal(quantity);
    if (!priceDecimal.greaterThan(0) || !quantityDecimal.greaterThan(0)) {
      return null;
    }
    return priceDecimal.mul(quantityDecimal).toFixed();
  } catch {
    return null;
  }
}
