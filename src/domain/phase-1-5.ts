import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../shared/decimal.js";
import type { FinancialDecimalInput } from "../shared/decimal.js";
import type { MarketStatus } from "./market.js";
import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

/**
 * phase 1.5 알트 수동 편입 상태 변경의 안정 action code다.
 *
 * 운영자가 수동 승인, 거부, 철회, 만료를 판단한 시점을 audit/reporting 계층이 같은 언어로 기록하게 하는 contract다.
 * 이 타입은 외부 side effect를 만들지 않으며, 후속 repository나 notifier는 이 값을 사용자 문구로 별도 변환해야 한다.
 */
export type Phase15AltApprovalAction = "APPROVE" | "REJECT" | "REVOKE" | "EXPIRE";

/**
 * phase 1.5 알트 후보가 통과해야 하는 유동성/상장/시장경보 기준이다.
 *
 * 런타임 config와 evaluator가 공유하는 입력 contract이며, 모든 숫자는 DB와 audit에서 재현 가능한 Decimal string으로
 * 유지한다. 이 값 자체는 주문 허용이 아니라 수동 승인 후보 판정을 위한 threshold snapshot이다.
 */
export interface Phase15AltEligibilityThresholds {
  minListingAgeDays: number;
  minThirtyDayAverageTradeValueKrw: NumericString;
  maxSevenDaySpreadP95Bps: NumericString;
  maxExpectedSlippageBps: NumericString;
  minDepthKrw: NumericString;
}

/**
 * 수동 승인 설정에 남기는 알트 market 단위 contract다.
 *
 * config는 operator가 승인한 market과 승인 근거 식별자만 보존한다. 실제 조건별 수치 snapshot은 evidence로 남겨
 * 승인 당시 기준을 나중에 재현할 수 있어야 하며, 만료 시각이 있으면 후속 runtime이 신규 진입을 차단해야 한다.
 */
export interface Phase15ManualAltApprovalConfig {
  market: MarketCode;
  approvedAt: TimestampInput;
  approvedBy?: string;
  evidenceId?: string;
  expiresAt?: TimestampInput;
}

/**
 * phase 1.5 알트 수동 편입 설정 contract다.
 *
 * 후보 목록과 승인 목록은 runtime config에서 읽히지만 자동 신규 상장 편입을 의미하지 않는다. 승인 목록은 최대 3개라는
 * invariant를 유지해야 하며, paper runtime의 기본값은 빈 승인 목록이라 기존 BTC/ETH universe를 흔들지 않는다.
 */
export interface Phase15AltUniverseConfig {
  enabled: boolean;
  candidateMarkets: readonly MarketCode[];
  manualApprovals: readonly Phase15ManualAltApprovalConfig[];
  maxManualApprovals: number;
  thresholds: Phase15AltEligibilityThresholds;
}

/**
 * 수동 승인/철회/만료 시점의 조건별 판정 snapshot이다.
 *
 * evaluator는 이 구조를 audit evidence로 넘기고, repository/reporting은 그대로 보존한다. `passed=false`인 항목이 있으면
 * 해당 market은 universe 편입 후보가 아니며, 이 구조 자체는 DB write나 외부 API 호출을 수행하지 않는 순수 데이터다.
 */
export interface Phase15AltApprovalEvidenceSnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  action: Phase15AltApprovalAction;
  observedAt: TimestampInput;
  thresholds: Phase15AltEligibilityThresholds;
  conditions: readonly Phase15AltApprovalEvidenceCondition[];
  approvedBy?: string;
  evidenceId?: string;
  source?: string;
  metadata?: JsonRecord;
}

/**
 * phase 1.5 후보 조건 하나의 판정 결과다.
 *
 * reasonCode는 audit/debug용 안정 식별자이며, 사용자에게 직접 보여줄 때는 한국어 상태/원인/필요 조치 문구로 변환해야 한다.
 */
export interface Phase15AltApprovalEvidenceCondition {
  key:
    | "listing_age"
    | "market_warning"
    | "market_caution"
    | "thirty_day_average_trade_value"
    | "seven_day_spread_p95"
    | "expected_slippage"
    | "depth";
  passed: boolean;
  reasonCode: string;
  actualValue?: NumericString | boolean | number;
  thresholdValue?: NumericString | boolean | number;
  metadata?: JsonRecord;
}

/**
 * phase 1.5 알트 eligibility evaluator가 받는 후보 snapshot이다.
 *
 * 이 입력은 이미 수집된 market status와 유동성 지표만 평가하며, 거래소 API 호출이나 DB write 같은 외부 side effect를 만들지
 * 않는다. 누락되거나 파싱할 수 없는 수치는 fail-closed condition으로 evidence에 남긴다.
 */
export interface Phase15AltEligibilityInput {
  exchangeId: ExchangeId;
  market: MarketCode;
  observedAt: TimestampInput;
  thresholds: Phase15AltEligibilityThresholds;
  listingAgeDays?: number;
  marketStatus?: MarketStatus;
  thirtyDayAverageTradeValueKrw?: FinancialDecimalInput;
  sevenDaySpreadP95Bps?: FinancialDecimalInput;
  expectedSlippageBps?: FinancialDecimalInput;
  depthKrw?: FinancialDecimalInput;
  approvedBy?: string;
  evidenceId?: string;
  source?: string;
  metadata?: JsonRecord;
}

/**
 * phase 1.5 알트 후보 조건 평가 결과다.
 *
 * `eligible=true`는 수동 승인 후보가 될 수 있음을 뜻할 뿐 자동 편입이나 주문 허용을 의미하지 않는다. 후속 runtime은
 * operator approval config, warning/caution 재확인, RiskGate를 별도로 통과해야 한다.
 */
export interface Phase15AltEligibilityDecision {
  eligible: boolean;
  reasonCode: "phase_1_5_alt_eligible" | "phase_1_5_alt_ineligible";
  evidence: Phase15AltApprovalEvidenceSnapshot;
  failedConditions: readonly Phase15AltApprovalEvidenceCondition[];
}

/**
 * phase 1.5 알트 후보가 수동 승인 후보 조건을 모두 만족하는지 평가한다.
 *
 * evaluator는 입력 snapshot만 읽는 순수 함수이며, 모든 조건별 결과를 evidence로 반환한다. 이 invariant가 있어야 운영자가
 * 승인/거부 판단을 나중에 audit log와 fixture로 재현할 수 있다.
 */
export function evaluatePhase15AltEligibility(
  input: Phase15AltEligibilityInput,
): Phase15AltEligibilityDecision {
  const conditions: Phase15AltApprovalEvidenceCondition[] = [
    evaluateListingAge(input),
    evaluateMarketWarning(input),
    evaluateMarketCaution(input),
    evaluateMinimumDecimalCondition({
      key: "thirty_day_average_trade_value",
      actualValue: input.thirtyDayAverageTradeValueKrw,
      thresholdValue: input.thresholds.minThirtyDayAverageTradeValueKrw,
      missingReasonCode: "phase_1_5_30d_trade_value_missing",
      invalidReasonCode: "phase_1_5_30d_trade_value_invalid",
      passReasonCode: "phase_1_5_30d_trade_value_sufficient",
      failReasonCode: "phase_1_5_30d_trade_value_insufficient",
    }),
    evaluateMaximumDecimalCondition({
      key: "seven_day_spread_p95",
      actualValue: input.sevenDaySpreadP95Bps,
      thresholdValue: input.thresholds.maxSevenDaySpreadP95Bps,
      missingReasonCode: "phase_1_5_spread_p95_missing",
      invalidReasonCode: "phase_1_5_spread_p95_invalid",
      passReasonCode: "phase_1_5_spread_p95_within_limit",
      failReasonCode: "phase_1_5_spread_p95_too_wide",
    }),
    evaluateMaximumDecimalCondition({
      key: "expected_slippage",
      actualValue: input.expectedSlippageBps,
      thresholdValue: input.thresholds.maxExpectedSlippageBps,
      missingReasonCode: "phase_1_5_expected_slippage_missing",
      invalidReasonCode: "phase_1_5_expected_slippage_invalid",
      passReasonCode: "phase_1_5_expected_slippage_within_limit",
      failReasonCode: "phase_1_5_expected_slippage_too_high",
    }),
    evaluateMinimumDecimalCondition({
      key: "depth",
      actualValue: input.depthKrw,
      thresholdValue: input.thresholds.minDepthKrw,
      missingReasonCode: "phase_1_5_depth_missing",
      invalidReasonCode: "phase_1_5_depth_invalid",
      passReasonCode: "phase_1_5_depth_sufficient",
      failReasonCode: "phase_1_5_depth_insufficient",
    }),
  ];
  const failedConditions = conditions.filter((condition) => !condition.passed);
  const eligible = failedConditions.length === 0;
  const evidence: Phase15AltApprovalEvidenceSnapshot = {
    exchangeId: input.exchangeId,
    market: input.market,
    action: eligible ? "APPROVE" : "REJECT",
    observedAt: input.observedAt,
    thresholds: input.thresholds,
    conditions,
  };

  assignIfDefined(evidence, "approvedBy", input.approvedBy);
  assignIfDefined(evidence, "evidenceId", input.evidenceId);
  assignIfDefined(evidence, "source", input.source);
  assignIfDefined(evidence, "metadata", input.metadata);

  return {
    eligible,
    reasonCode: eligible ? "phase_1_5_alt_eligible" : "phase_1_5_alt_ineligible",
    evidence,
    failedConditions,
  };
}

function evaluateListingAge(input: Phase15AltEligibilityInput): Phase15AltApprovalEvidenceCondition {
  const listingAgeDays = input.listingAgeDays;

  if (listingAgeDays === undefined || !Number.isFinite(listingAgeDays) || listingAgeDays < 0) {
    return condition(
      "listing_age",
      false,
      "phase_1_5_listing_age_invalid",
      serializeInvalidNumber(listingAgeDays),
      input.thresholds.minListingAgeDays,
    );
  }

  const passed = listingAgeDays >= input.thresholds.minListingAgeDays;

  return condition(
    "listing_age",
    passed,
    passed ? "phase_1_5_listing_age_sufficient" : "phase_1_5_listing_age_too_young",
    listingAgeDays,
    input.thresholds.minListingAgeDays,
  );
}

function evaluateMarketWarning(input: Phase15AltEligibilityInput): Phase15AltApprovalEvidenceCondition {
  const statusProblem = evaluateMarketStatusIdentity(input);

  if (statusProblem !== undefined) {
    return condition("market_warning", false, statusProblem.reasonCode, statusProblem.actualValue, false, statusProblem.metadata);
  }

  const status = input.marketStatus;
  const warning = status?.warning === true;

  if (warning) {
    return condition("market_warning", false, "phase_1_5_market_warning_present", true, false);
  }

  const nonUniverseReasonCodes = withoutUniverseMembershipReasonCodes(status?.reasonCodes ?? []);
  if (status?.tradable === false && nonUniverseReasonCodes.length > 0) {
    return condition("market_warning", false, "phase_1_5_market_not_tradable", false, false, {
      reason_codes: nonUniverseReasonCodes,
    });
  }

  return condition(
    "market_warning",
    true,
    "phase_1_5_market_warning_absent",
    false,
    false,
  );
}

function evaluateMarketCaution(input: Phase15AltEligibilityInput): Phase15AltApprovalEvidenceCondition {
  const statusProblem = evaluateMarketStatusIdentity(input);

  if (statusProblem !== undefined) {
    return condition("market_caution", false, statusProblem.reasonCode, statusProblem.actualValue, false, statusProblem.metadata);
  }

  const status = input.marketStatus;
  const caution = status?.caution === true;

  if (caution) {
    return condition("market_caution", false, "phase_1_5_market_caution_present", true, false);
  }

  const nonUniverseReasonCodes = withoutUniverseMembershipReasonCodes(status?.reasonCodes ?? []);
  if (status?.tradable === false && nonUniverseReasonCodes.length > 0) {
    return condition("market_caution", false, "phase_1_5_market_not_tradable", false, false, {
      reason_codes: nonUniverseReasonCodes,
    });
  }

  return condition(
    "market_caution",
    true,
    "phase_1_5_market_caution_absent",
    false,
    false,
  );
}

function withoutUniverseMembershipReasonCodes(reasonCodes: readonly string[]): readonly string[] {
  return reasonCodes.filter((reasonCode) => !reasonCode.startsWith("market_not_in_mvp_universe:"));
}

function evaluateMarketStatusIdentity(input: Phase15AltEligibilityInput):
  | {
      reasonCode: string;
      actualValue?: boolean;
      metadata?: JsonRecord;
    }
  | undefined {
  const status = input.marketStatus;

  if (status === undefined) {
    return {
      reasonCode: "phase_1_5_market_status_missing",
    };
  }

  if (status.exchangeId !== input.exchangeId || status.market !== input.market) {
    return {
      reasonCode: "phase_1_5_market_status_mismatch",
      metadata: {
        context_exchange_id: input.exchangeId,
        context_market: input.market,
        status_exchange_id: status.exchangeId,
        status_market: status.market,
      },
    };
  }

  return undefined;
}

function evaluateMinimumDecimalCondition(input: {
  key: Phase15AltApprovalEvidenceCondition["key"];
  actualValue: FinancialDecimalInput | undefined;
  thresholdValue: NumericString;
  missingReasonCode: string;
  invalidReasonCode: string;
  passReasonCode: string;
  failReasonCode: string;
}): Phase15AltApprovalEvidenceCondition {
  return evaluateDecimalCondition(input, (actual, threshold) => actual.greaterThanOrEqualTo(threshold));
}

function evaluateMaximumDecimalCondition(input: {
  key: Phase15AltApprovalEvidenceCondition["key"];
  actualValue: FinancialDecimalInput | undefined;
  thresholdValue: NumericString;
  missingReasonCode: string;
  invalidReasonCode: string;
  passReasonCode: string;
  failReasonCode: string;
}): Phase15AltApprovalEvidenceCondition {
  return evaluateDecimalCondition(input, (actual, threshold) => actual.lessThanOrEqualTo(threshold));
}

function evaluateDecimalCondition(
  input: {
    key: Phase15AltApprovalEvidenceCondition["key"];
    actualValue: FinancialDecimalInput | undefined;
    thresholdValue: NumericString;
    missingReasonCode: string;
    invalidReasonCode: string;
    passReasonCode: string;
    failReasonCode: string;
  },
  predicate: (actual: Decimal, threshold: Decimal) => boolean,
): Phase15AltApprovalEvidenceCondition {
  if (input.actualValue === undefined) {
    return condition(input.key, false, input.missingReasonCode, undefined, input.thresholdValue);
  }

  const actual = parseNonNegativeDecimal(input.actualValue);
  const threshold = parseNonNegativeDecimal(input.thresholdValue);

  if (actual === undefined || threshold === undefined) {
    return condition(input.key, false, input.invalidReasonCode, serializeDecimalInput(input.actualValue), input.thresholdValue);
  }

  const passed = predicate(actual, threshold);

  return condition(
    input.key,
    passed,
    passed ? input.passReasonCode : input.failReasonCode,
    actual.toFixed(),
    threshold.toFixed(),
  );
}

function parseNonNegativeDecimal(input: FinancialDecimalInput): Decimal | undefined {
  try {
    const value = parseFinancialDecimal(input);

    if (value.isNegative()) {
      return undefined;
    }

    return value;
  } catch {
    return undefined;
  }
}

function serializeDecimalInput(input: FinancialDecimalInput): NumericString {
  return typeof input === "string" ? input : input.toString();
}

function serializeInvalidNumber(input: number | undefined): NumericString | undefined {
  if (input === undefined) {
    return undefined;
  }

  return Number.isFinite(input) ? input.toString() : String(input);
}

function condition(
  key: Phase15AltApprovalEvidenceCondition["key"],
  passed: boolean,
  reasonCode: string,
  actualValue?: NumericString | boolean | number,
  thresholdValue?: NumericString | boolean | number,
  metadata?: JsonRecord,
): Phase15AltApprovalEvidenceCondition {
  const result: Phase15AltApprovalEvidenceCondition = {
    key,
    passed,
    reasonCode,
  };

  assignIfDefined(result, "actualValue", actualValue);
  assignIfDefined(result, "thresholdValue", thresholdValue);
  assignIfDefined(result, "metadata", metadata);

  return result;
}

function assignIfDefined<T extends JsonRecord | Phase15AltApprovalEvidenceSnapshot | Phase15AltApprovalEvidenceCondition>(
  target: T,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key as keyof T] = value as T[keyof T];
  }
}
