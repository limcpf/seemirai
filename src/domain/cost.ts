import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../shared/decimal.js";
import type { FinancialDecimalInput } from "../shared/decimal.js";
import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type CostDecisionKind = "ALLOW" | "REJECT";

export type CostDecisionReasonCode =
  | "cost_margin_ok"
  | "cost_margin_insufficient"
  | "missing_cost_input"
  | "invalid_cost_input";

export type SafetyBufferMarketCategory = "BTC_ETH" | "TOP_ALT";

export type CostInputField =
  | "expected_return_bps"
  | "entry_fee_bps"
  | "exit_fee_bps"
  | "spread_cost_bps_p75"
  | "expected_slippage_bps_p95"
  | "cancel_requote_penalty_bps"
  | "safety_buffer_bps";

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

export interface CostDecision {
  kind: CostDecisionKind;
  tradeAllowed: boolean;
  reasonCode: CostDecisionReasonCode;
  message: string;
  snapshot: CostSnapshot;
}

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

interface CostInputBinding {
  inputKey: Exclude<
    keyof CostModelInput,
    "exchangeId" | "market" | "safetyBufferMarketCategory" | "evaluatedAt" | "metadata"
  >;
  parsedKey: ParsedCostValueKey;
  snapshotKey: CostInputField;
  allowNegative: boolean;
}

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

const SNAPSHOT_KEYS_BY_PARSED_KEY: Readonly<Record<ParsedCostValueKey, CostInputField>> = {
  expectedReturnBps: "expected_return_bps",
  entryFeeBps: "entry_fee_bps",
  exitFeeBps: "exit_fee_bps",
  spreadCostBpsP75: "spread_cost_bps_p75",
  expectedSlippageBpsP95: "expected_slippage_bps_p95",
  cancelRequotePenaltyBps: "cancel_requote_penalty_bps",
  safetyBufferBps: "safety_buffer_bps",
};

export class CostModel {
  public evaluate(input: CostModelInput): CostDecision {
    const parsed: ParsedCostValues = {};
    const missingFields: CostInputField[] = [];
    const invalidFields: CostInputField[] = [];

    for (const binding of REQUIRED_COST_INPUTS) {
      parseCostInputField(input[binding.inputKey], binding, parsed, missingFields, invalidFields);
    }

    parseSafetyBuffer(input, parsed, missingFields, invalidFields);

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

    const costBps = entryFeeBps
      .plus(exitFeeBps)
      .plus(spreadCostBpsP75)
      .plus(expectedSlippageBpsP95)
      .plus(cancelRequotePenaltyBps);
    const requiredReturnBps = costBps.plus(safetyBufferBps);
    const marginBps = expectedReturnBps.minus(requiredReturnBps);
    const tradeAllowed = expectedReturnBps.greaterThanOrEqualTo(requiredReturnBps);

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

export function evaluateCost(input: CostModelInput): CostDecision {
  return new CostModel().evaluate(input);
}

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

function normalizeTimestamp(input: TimestampInput): string {
  if (input instanceof Date) {
    return input.toISOString();
  }

  return input;
}

function requireParsed(value: Decimal | undefined, field: CostInputField): Decimal {
  if (value === undefined) {
    throw new Error(`Cost model internal parse invariant failed for ${field}`);
  }

  return value;
}
