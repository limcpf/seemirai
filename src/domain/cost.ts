import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../shared/decimal.js";
import type { FinancialDecimalInput } from "../shared/decimal.js";
import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

/**
 * 비용 모델이 주문 후보를 다음 단계로 넘길 수 있는지 나타내는 최종 판정이다.
 */
export type CostDecisionKind = "ALLOW" | "REJECT";

/**
 * 비용 판정 결과를 audit log와 rule engine에서 재사용하기 위한 안정적인 reason code다.
 */
export type CostDecisionReasonCode =
  | "cost_margin_ok"
  | "cost_margin_insufficient"
  | "missing_cost_input"
  | "invalid_cost_input";

/**
 * 기본 safety buffer를 market code만으로 결정할 수 없을 때 사용하는 시장군 분류다.
 */
export type SafetyBufferMarketCategory = "BTC_ETH" | "TOP_ALT";

/**
 * 비용 snapshot에 남기는 입력 필드 이름이다.
 *
 * 외부 저장소와 audit payload에서 camelCase domain input을 그대로 노출하지 않기 위해 snake_case로 고정한다.
 */
export type CostInputField =
  | "expected_return_bps"
  | "entry_fee_bps"
  | "exit_fee_bps"
  | "spread_cost_bps_p75"
  | "expected_slippage_bps_p95"
  | "cancel_requote_penalty_bps"
  | "safety_buffer_bps";

/**
 * 비용 모델 평가에 필요한 주문 후보 비용 입력이다.
 *
 * 모든 금융 숫자는 string 또는 Decimal만 허용하고, JS number는 정밀도 손실 가능성 때문에 런타임에서 거부한다.
 */
export interface CostModelInput {
  exchangeId: ExchangeId;
  market: MarketCode;
  expectedReturnBps?: FinancialDecimalInput;
  entryFeeBps?: FinancialDecimalInput;
  exitFeeBps?: FinancialDecimalInput;
  spreadCostBpsP75?: FinancialDecimalInput;
  expectedSlippageBpsP95?: FinancialDecimalInput;
  cancelRequotePenaltyBps?: FinancialDecimalInput;
  safetyBufferBps?: FinancialDecimalInput;
  safetyBufferMarketCategory?: SafetyBufferMarketCategory;
  evaluatedAt?: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 후속 M6 `OrderSubmission.costSnapshot`과 audit event에 그대로 붙일 수 있는 JSON-safe 비용 snapshot이다.
 *
 * Decimal 값은 모두 string으로 직렬화해 DB numeric, log, API boundary에서 같은 값을 재현할 수 있게 한다.
 */
export type CostSnapshot = JsonRecord & {
  exchange_id: ExchangeId;
  market: MarketCode;
  expected_return_bps?: NumericString;
  entry_fee_bps?: NumericString;
  exit_fee_bps?: NumericString;
  spread_cost_bps_p75?: NumericString;
  expected_slippage_bps_p95?: NumericString;
  cancel_requote_penalty_bps?: NumericString;
  cost_bps?: NumericString;
  safety_buffer_bps?: NumericString;
  required_return_bps?: NumericString;
  margin_bps?: NumericString;
  trade_allowed: boolean;
  reason_code: CostDecisionReasonCode;
  missing_fields?: readonly CostInputField[];
  invalid_fields?: readonly CostInputField[];
  evaluated_at?: string;
};

/**
 * 비용 모델의 단일 평가 결과다.
 *
 * `tradeAllowed=false`인 경우도 snapshot을 항상 포함해 폐기 사유와 당시 비용 입력을 audit로 남길 수 있게 한다.
 */
export interface CostDecision {
  kind: CostDecisionKind;
  tradeAllowed: boolean;
  reasonCode: CostDecisionReasonCode;
  message: string;
  snapshot: CostSnapshot;
}

/**
 * Decimal로 파싱된 내부 계산 값 묶음이다.
 *
 * 일부 입력이 누락되거나 invalid일 수 있으므로 계산 전 단계에서는 필드를 optional로 유지한다.
 */
interface ParsedCostValues {
  expectedReturnBps?: Decimal;
  entryFeeBps?: Decimal;
  exitFeeBps?: Decimal;
  spreadCostBpsP75?: Decimal;
  expectedSlippageBpsP95?: Decimal;
  cancelRequotePenaltyBps?: Decimal;
  safetyBufferBps?: Decimal;
}

type ParsedCostValueKey = keyof ParsedCostValues;

/**
 * domain input field와 snapshot field를 연결하는 파싱 규칙이다.
 */
interface CostInputBinding {
  inputKey: Exclude<
    keyof CostModelInput,
    "exchangeId" | "market" | "safetyBufferMarketCategory" | "evaluatedAt" | "metadata"
  >;
  parsedKey: ParsedCostValueKey;
  snapshotKey: CostInputField;
  allowNegative: boolean;
}

/**
 * safety buffer를 제외한 필수 비용 입력 목록이다.
 *
 * safety buffer는 market별 기본값을 resolve할 수 있어 별도 흐름에서 처리한다.
 */
const REQUIRED_COST_INPUTS: readonly CostInputBinding[] = [
  {
    inputKey: "expectedReturnBps",
    parsedKey: "expectedReturnBps",
    snapshotKey: "expected_return_bps",
    allowNegative: true,
  },
  {
    inputKey: "entryFeeBps",
    parsedKey: "entryFeeBps",
    snapshotKey: "entry_fee_bps",
    allowNegative: false,
  },
  {
    inputKey: "exitFeeBps",
    parsedKey: "exitFeeBps",
    snapshotKey: "exit_fee_bps",
    allowNegative: false,
  },
  {
    inputKey: "spreadCostBpsP75",
    parsedKey: "spreadCostBpsP75",
    snapshotKey: "spread_cost_bps_p75",
    allowNegative: false,
  },
  {
    inputKey: "expectedSlippageBpsP95",
    parsedKey: "expectedSlippageBpsP95",
    snapshotKey: "expected_slippage_bps_p95",
    allowNegative: false,
  },
  {
    inputKey: "cancelRequotePenaltyBps",
    parsedKey: "cancelRequotePenaltyBps",
    snapshotKey: "cancel_requote_penalty_bps",
    allowNegative: false,
  },
] as const;

/**
 * 내부 camelCase 파싱 결과를 외부 snapshot snake_case field로 변환하는 매핑이다.
 */
const SNAPSHOT_KEYS_BY_PARSED_KEY: Readonly<Record<ParsedCostValueKey, CostInputField>> = {
  expectedReturnBps: "expected_return_bps",
  entryFeeBps: "entry_fee_bps",
  exitFeeBps: "exit_fee_bps",
  spreadCostBpsP75: "spread_cost_bps_p75",
  expectedSlippageBpsP95: "expected_slippage_bps_p95",
  cancelRequotePenaltyBps: "cancel_requote_penalty_bps",
  safetyBufferBps: "safety_buffer_bps",
};

/**
 * 주문 후보의 비용 차감 후 기대값을 평가하는 공통 도메인 서비스다.
 *
 * 전략과 실행 계층은 이 결과를 기준으로 후보를 다음 rule/risk 단계로 넘길지 결정한다.
 */
export class CostModel {
  /**
   * 비용 입력을 검증하고 `expected_return_bps >= cost_bps + safety_buffer_bps` 조건을 평가한다.
   */
  public evaluate(input: CostModelInput): CostDecision {
    const parsed: ParsedCostValues = {};
    const missingFields: CostInputField[] = [];
    const invalidFields: CostInputField[] = [];

    // 1. safety buffer를 제외한 필수 비용 입력을 Decimal로 파싱한다.
    for (const binding of REQUIRED_COST_INPUTS) {
      parseCostInputField(input[binding.inputKey], binding, parsed, missingFields, invalidFields);
    }

    // 2. 명시 입력 또는 market 기본값으로 safety buffer를 확정한다.
    parseSafetyBuffer(input, parsed, missingFields, invalidFields);

    // 3. 비용 입력이 불명확하면 주문 후보를 비용 계산 전 단계에서 폐기한다.
    if (missingFields.length > 0 || invalidFields.length > 0) {
      return createRejectedDecision({
        input,
        parsed,
        missingFields,
        invalidFields,
        reasonCode: invalidFields.length > 0 ? "invalid_cost_input" : "missing_cost_input",
        message:
          invalidFields.length > 0
            ? "Cost model input contains invalid numeric fields"
            : "Cost model input is missing required numeric fields",
      });
    }

    // 4. 이후 계산은 모두 Decimal 인스턴스만 사용한다.
    const expectedReturnBps = requireParsed(parsed.expectedReturnBps, "expected_return_bps");
    const entryFeeBps = requireParsed(parsed.entryFeeBps, "entry_fee_bps");
    const exitFeeBps = requireParsed(parsed.exitFeeBps, "exit_fee_bps");
    const spreadCostBpsP75 = requireParsed(parsed.spreadCostBpsP75, "spread_cost_bps_p75");
    const expectedSlippageBpsP95 = requireParsed(
      parsed.expectedSlippageBpsP95,
      "expected_slippage_bps_p95",
    );
    const cancelRequotePenaltyBps = requireParsed(
      parsed.cancelRequotePenaltyBps,
      "cancel_requote_penalty_bps",
    );
    const safetyBufferBps = requireParsed(parsed.safetyBufferBps, "safety_buffer_bps");

    // 5. 총비용과 필요 기대수익률, 남는 margin을 계산한다.
    const costBps = entryFeeBps
      .plus(exitFeeBps)
      .plus(spreadCostBpsP75)
      .plus(expectedSlippageBpsP95)
      .plus(cancelRequotePenaltyBps);
    const requiredReturnBps = costBps.plus(safetyBufferBps);
    const marginBps = expectedReturnBps.minus(requiredReturnBps);
    const tradeAllowed = expectedReturnBps.greaterThanOrEqualTo(requiredReturnBps);

    // 6. margin이 부족하면 OrderIntent 승격 전 단계에서 reject snapshot을 만든다.
    if (!tradeAllowed) {
      return {
        kind: "REJECT",
        tradeAllowed,
        reasonCode: "cost_margin_insufficient",
        message: "Expected return is below total cost plus safety buffer",
        snapshot: buildSnapshot(input, parsed, {
          costBps,
          requiredReturnBps,
          marginBps,
          tradeAllowed,
          reasonCode: "cost_margin_insufficient",
        }),
      };
    }

    // 7. margin이 충분한 후보만 다음 rule/risk 단계로 보낼 수 있게 allow snapshot을 만든다.
    return {
      kind: "ALLOW",
      tradeAllowed,
      reasonCode: "cost_margin_ok",
      message: "Expected return covers total cost plus safety buffer",
      snapshot: buildSnapshot(input, parsed, {
        costBps,
        requiredReturnBps,
        marginBps,
        tradeAllowed,
        reasonCode: "cost_margin_ok",
      }),
    };
  }
}

/**
 * MVP market 정책에 맞는 기본 safety buffer를 bps string으로 반환한다.
 *
 * BTC/ETH는 10 bps, phase 1.5 상위 알트는 명시적인 `TOP_ALT` 분류가 있을 때만 20 bps를 반환한다.
 */
export function resolveDefaultSafetyBufferBps(
  market: MarketCode,
  marketCategory?: SafetyBufferMarketCategory,
): NumericString | undefined {
  if (market === "KRW-BTC" || market === "KRW-ETH" || marketCategory === "BTC_ETH") {
    return "10";
  }

  if (marketCategory === "TOP_ALT") {
    return "20";
  }

  return undefined;
}

/**
 * 일회성 호출에서 `CostModel` 인스턴스 생성 없이 비용 판정을 실행하는 편의 함수다.
 */
export function evaluateCost(input: CostModelInput): CostDecision {
  return new CostModel().evaluate(input);
}

/**
 * 단일 비용 입력을 Decimal로 파싱하고 missing/invalid field 목록을 갱신한다.
 */
function parseCostInputField(
  inputValue: unknown,
  binding: CostInputBinding,
  parsed: ParsedCostValues,
  missingFields: CostInputField[],
  invalidFields: CostInputField[],
): void {
  if (inputValue === undefined || inputValue === null) {
    missingFields.push(binding.snapshotKey);
    return;
  }

  const decimal = parseCostDecimal(inputValue, binding.allowNegative);
  if (decimal === undefined) {
    invalidFields.push(binding.snapshotKey);
    return;
  }

  parsed[binding.parsedKey] = decimal;
}

/**
 * 명시된 safety buffer를 우선하고, 없으면 market 기본 safety buffer를 적용한다.
 */
function parseSafetyBuffer(
  input: CostModelInput,
  parsed: ParsedCostValues,
  missingFields: CostInputField[],
  invalidFields: CostInputField[],
): void {
  const configuredSafetyBuffer =
    input.safetyBufferBps ?? resolveDefaultSafetyBufferBps(input.market, input.safetyBufferMarketCategory);

  if (configuredSafetyBuffer === undefined || configuredSafetyBuffer === null) {
    missingFields.push("safety_buffer_bps");
    return;
  }

  const safetyBufferBps = parseCostDecimal(configuredSafetyBuffer, false);
  if (safetyBufferBps === undefined) {
    invalidFields.push("safety_buffer_bps");
    return;
  }

  parsed.safetyBufferBps = safetyBufferBps;
}

/**
 * 금융 숫자 파싱 정책을 비용 모델에 맞게 감싼다.
 *
 * 수수료, 스프레드, 슬리피지, 패널티, safety buffer는 음수를 허용하지 않는다.
 */
function parseCostDecimal(input: unknown, allowNegative: boolean): Decimal | undefined {
  try {
    const value = parseFinancialDecimal(input);
    if (!allowNegative && value.isNegative()) {
      return undefined;
    }

    return value;
  } catch {
    return undefined;
  }
}

/**
 * 입력 검증 실패를 계산 실패가 아닌 명시적인 reject decision으로 변환한다.
 */
function createRejectedDecision(input: {
  input: CostModelInput;
  parsed: ParsedCostValues;
  missingFields: readonly CostInputField[];
  invalidFields: readonly CostInputField[];
  reasonCode: "missing_cost_input" | "invalid_cost_input";
  message: string;
}): CostDecision {
  return {
    kind: "REJECT",
    tradeAllowed: false,
    reasonCode: input.reasonCode,
    message: input.message,
    snapshot: buildSnapshot(input.input, input.parsed, {
      tradeAllowed: false,
      reasonCode: input.reasonCode,
      missingFields: input.missingFields,
      invalidFields: input.invalidFields,
    }),
  };
}

/**
 * 계산 결과와 입력 상태를 후속 broker submission/audit에 붙일 수 있는 JSON-safe snapshot으로 만든다.
 */
function buildSnapshot(
  input: CostModelInput,
  parsed: ParsedCostValues,
  outcome: {
    tradeAllowed: boolean;
    reasonCode: CostDecisionReasonCode;
    costBps?: Decimal;
    requiredReturnBps?: Decimal;
    marginBps?: Decimal;
    missingFields?: readonly CostInputField[];
    invalidFields?: readonly CostInputField[];
  },
): CostSnapshot {
  const snapshot: CostSnapshot = {
    exchange_id: input.exchangeId,
    market: input.market,
    trade_allowed: outcome.tradeAllowed,
    reason_code: outcome.reasonCode,
  };

  for (const [parsedKey, snapshotKey] of Object.entries(SNAPSHOT_KEYS_BY_PARSED_KEY) as ReadonlyArray<
    readonly [ParsedCostValueKey, CostInputField]
  >) {
    const value = parsed[parsedKey];
    if (value !== undefined) {
      snapshot[snapshotKey] = value.toFixed();
    }
  }

  if (outcome.costBps !== undefined) {
    snapshot.cost_bps = outcome.costBps.toFixed();
  }

  if (outcome.requiredReturnBps !== undefined) {
    snapshot.required_return_bps = outcome.requiredReturnBps.toFixed();
  }

  if (outcome.marginBps !== undefined) {
    snapshot.margin_bps = outcome.marginBps.toFixed();
  }

  if (outcome.missingFields !== undefined && outcome.missingFields.length > 0) {
    snapshot.missing_fields = [...outcome.missingFields];
  }

  if (outcome.invalidFields !== undefined && outcome.invalidFields.length > 0) {
    snapshot.invalid_fields = [...outcome.invalidFields];
  }

  if (input.evaluatedAt !== undefined) {
    snapshot.evaluated_at = normalizeTimestamp(input.evaluatedAt);
  }

  return snapshot;
}

/**
 * Date와 string timestamp 입력을 snapshot 저장용 ISO/string 값으로 정규화한다.
 */
function normalizeTimestamp(input: TimestampInput): string {
  if (input instanceof Date) {
    return input.toISOString();
  }

  return input;
}

/**
 * 입력 검증 이후에도 값이 없으면 코드 invariant 위반으로 보고 즉시 실패시킨다.
 */
function requireParsed(value: Decimal | undefined, field: CostInputField): Decimal {
  if (value === undefined) {
    throw new Error(`Cost model internal parse invariant failed for ${field}`);
  }

  return value;
}
