import { Decimal } from "decimal.js";
import type { LiveOrderProposalContract } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  LiveOrderApprovalSubmissionRecheckDecision,
  LiveOrderApprovalSubmissionRecheckInput,
  LiveOrderApprovalSubmissionRecheckViolation,
} from "./types.js";

const upbitIdentifierMaxLength = 32;

/**
 * M21 approval submission 직전 guard를 평가한다.
 *
 * approval evidence가 있어도 현재 risk/reconcile/budget/market data가 달라졌을 수 있으므로, 이 함수가 통과하기 전에는
 * `BrokerPort.submitOrder`를 호출하면 안 된다. 함수는 순수 평가만 수행하고 외부 side effect를 만들지 않는다.
 */
export function evaluateLiveOrderApprovalSubmissionRecheck(
  input: LiveOrderApprovalSubmissionRecheckInput,
): LiveOrderApprovalSubmissionRecheckDecision {
  const violations: LiveOrderApprovalSubmissionRecheckViolation[] = [];
  const proposal = input.proposal;
  const config = input.config;
  const snapshot = input.snapshot;

  if (!config.enabled) {
    violations.push("m21_runtime_disabled");
  }

  if (proposal.status !== "APPROVED") {
    violations.push("m21_proposal_not_approved");
  }

  if (!config.allowed_markets.includes(proposal.market)) {
    violations.push("m21_market_not_allowed");
  }

  if (proposal.orderType !== "LIMIT") {
    violations.push("m21_order_type_not_supported");
  }

  const expectedNotional = parseGuardDecimal(proposal.expectedNotionalKrw);
  const submittedNotional = calculateSubmittedNotional(proposal.requestedPrice, proposal.requestedVolume);
  if (
    !expectedNotional.isFinite() ||
    !submittedNotional.isFinite() ||
    submittedNotional.lte(0) ||
    !submittedNotional.eq(expectedNotional)
  ) {
    violations.push("m21_order_notional_mismatch");
  }

  const maxOrder = parseGuardDecimal(config.max_order_krw);
  if (
    !expectedNotional.isFinite() ||
    !submittedNotional.isFinite() ||
    !maxOrder.isFinite() ||
    expectedNotional.gt(maxOrder) ||
    submittedNotional.gt(maxOrder)
  ) {
    violations.push("m21_order_notional_exceeds_limit");
  }

  const dailyUsed = parseGuardDecimal(snapshot.dailyApprovedNotionalUsedKrw);
  const dailyLimit = parseGuardDecimal(config.daily_approved_notional_limit_krw);
  if (
    !dailyUsed.isFinite() ||
    !dailyLimit.isFinite() ||
    !submittedNotional.isFinite() ||
    dailyUsed.plus(submittedNotional).gt(dailyLimit)
  ) {
    violations.push("m21_daily_budget_exceeded");
  }

  if (!snapshot.riskApproved) {
    violations.push("m21_risk_not_approved");
  }

  if (snapshot.riskDecisionId !== proposal.riskDecisionId) {
    violations.push("m21_risk_decision_mismatch");
  }

  if (!snapshot.killSwitchAllowsNewOrders) {
    violations.push("m21_kill_switch_blocks_new_orders");
  }

  if (!snapshot.reconcileFresh) {
    violations.push("m21_reconcile_not_fresh");
  }

  if (proposal.idempotencyKey.length < 1 || proposal.idempotencyKey.length > upbitIdentifierMaxLength) {
    violations.push("m21_invalid_idempotency_key");
  }

  const priceDeviation = calculatePriceDeviationBps(proposal.requestedPrice, snapshot.referencePrice);
  if (priceDeviation === null) {
    violations.push("m21_price_reference_invalid");
  } else if (priceDeviation.gt(parseGuardDecimal(config.max_price_deviation_bps))) {
    violations.push("m21_price_deviation_exceeded");
  }

  return violations.length === 0
    ? { accepted: true }
    : {
        accepted: false,
        violations,
      };
}

/**
 * broker에 실제 전달될 지정가 price * volume 금액을 KRW 문자열로 계산한다.
 *
 * proposal의 expected notional은 저장된 projection일 수 있으므로, live broker side effect 직전 reservation/evidence 경계에서는 이
 * helper로 실제 제출 금액을 다시 계산해야 한다. 유효하지 않은 숫자이면 `null`을 반환하며 외부 side effect는 없다.
 */
export function calculateLiveOrderApprovalSubmittedNotionalKrw(
  proposal: Pick<LiveOrderProposalContract, "requestedPrice" | "requestedVolume">,
): string | null {
  const submittedNotional = calculateSubmittedNotional(proposal.requestedPrice, proposal.requestedVolume);
  return submittedNotional.isFinite() && submittedNotional.gt(0) ? submittedNotional.toFixed() : null;
}

function calculatePriceDeviationBps(requestedPrice: string, referencePrice: string): Decimal | null {
  const requested = parseGuardDecimal(requestedPrice);
  const reference = parseGuardDecimal(referencePrice);
  if (!requested.isFinite() || !reference.isFinite() || reference.lte(0)) {
    return null;
  }

  return requested.minus(reference).abs().div(reference).mul(10_000);
}

function calculateSubmittedNotional(requestedPrice: string, requestedVolume: string): Decimal {
  const price = parseGuardDecimal(requestedPrice);
  const volume = parseGuardDecimal(requestedVolume);
  if (!price.isFinite() || !volume.isFinite()) {
    return new Decimal(Number.NaN);
  }

  return price.mul(volume);
}

function parseGuardDecimal(value: string): Decimal {
  try {
    return parseFinancialDecimal(value);
  } catch {
    return new Decimal(Number.NaN);
  }
}
