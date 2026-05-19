import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import { evaluateRiskGate } from "../risk/risk-gate.js";
import type {
  JsonRecord,
  MarketCode,
  Rule,
  RuleContext,
  RuleEvaluation,
  RiskGateContext,
  RiskGateResult,
} from "../../domain/index.js";

type OptionalRuleDecimalRead =
  | {
      status: "ok";
      value: Decimal;
      source: string;
    }
  | {
      status: "missing";
    }
  | {
      status: "invalid";
      source: string;
    };

export interface UniverseAllowedRuleOptions {
  allowedMarkets: readonly MarketCode[];
}

export interface SpreadOkRuleOptions {
  maxSpreadBps: string;
}

export interface DepthSufficientRuleOptions {
  minDepthKrw: string;
}

export interface StopLossRuleOptions {
  stopLossBps: string;
}

export interface TakeProfitRuleOptions {
  takeProfitBps: string;
}

export interface DefaultM4RulesOptions {
  allowedMarkets: readonly MarketCode[];
  maxSpreadBps: string;
  minDepthKrw: string;
  stopLossBps: string;
  takeProfitBps: string;
}

export interface RiskOkRuleOptions {
  evaluateRiskGate?: (context: RiskGateContext) => RiskGateResult;
}

/**
 * universe에 포함된 market만 신규 후보로 통과시키는 rule을 만든다.
 */
export function createUniverseAllowedRule(options: UniverseAllowedRuleOptions): Rule {
  return {
    id: "universe_allowed",
    evaluate: (context) => {
      const allowedMarkets = context.universe?.allowedMarkets ?? options.allowedMarkets;

      if (!allowedMarkets.includes(context.market)) {
        return fail("universe_not_allowed", "Market is not included in the configured universe", {
          market: context.market,
          allowed_markets: [...allowedMarkets],
        });
      }

      return pass("universe_allowed", "Market is included in the configured universe");
    },
  };
}

/**
 * Upbit market warning/caution 또는 거래 불가 상태면 신규 진입 후보를 차단한다.
 */
export const marketWarningAbsentRule: Rule = {
  id: "market_warning_absent",
  evaluate: (context) => {
    const status = context.marketStatus;

    if (status === undefined) {
      return fail("market_status_missing", "Market status is required before creating a new candidate");
    }

    if (status.exchangeId !== context.exchangeId || status.market !== context.market) {
      return fail("market_status_mismatch", "Market status does not match the rule context", {
        context_exchange_id: context.exchangeId,
        context_market: context.market,
        status_exchange_id: status.exchangeId,
        status_market: status.market,
      });
    }

    if (!status.tradable) {
      return fail("market_not_tradable", "Market is not tradable", {
        reason_codes: [...status.reasonCodes],
      });
    }

    if (status.warning) {
      return fail("market_warning_present", "Market warning is present");
    }

    if (status.caution) {
      return fail("market_caution_present", "Market caution is present");
    }

    return pass("market_warning_absent", "Market warning and caution are absent");
  },
};

/**
 * 현재 spread가 strategy threshold 이하인지 확인하는 rule을 만든다.
 */
export function createSpreadOkRule(options: SpreadOkRuleOptions): Rule {
  const maxSpreadBps = parseRuleDecimal(options.maxSpreadBps, "max_spread_bps");

  return {
    id: "spread_ok",
    evaluate: (context) => {
      const spreadBps = readFeatureDecimal(context, "spread_bps");

      if (spreadBps === undefined) {
        return fail("feature_missing_spread_bps", "spread_bps feature is required");
      }

      if (spreadBps.isNegative()) {
        return fail("spread_negative", "spread_bps must not be negative", {
          spread_bps: spreadBps.toFixed(),
        });
      }

      if (spreadBps.greaterThan(maxSpreadBps)) {
        return fail("spread_too_wide", "Spread exceeds the configured threshold", {
          spread_bps: spreadBps.toFixed(),
          max_spread_bps: maxSpreadBps.toFixed(),
        });
      }

      return pass("spread_ok", "Spread is within the configured threshold", {
        spread_bps: spreadBps.toFixed(),
        max_spread_bps: maxSpreadBps.toFixed(),
      });
    },
  };
}

/**
 * 주문 후보가 필요한 최소 KRW depth를 충족하는지 확인하는 rule을 만든다.
 */
export function createDepthSufficientRule(options: DepthSufficientRuleOptions): Rule {
  const minDepthKrw = parseRuleDecimal(options.minDepthKrw, "min_depth_krw");

  return {
    id: "depth_sufficient",
    evaluate: (context) => {
      const depthKrw = readFeatureDecimal(context, "depth_krw");

      if (depthKrw === undefined) {
        return fail("feature_missing_depth_krw", "depth_krw feature is required");
      }

      if (depthKrw.lessThan(minDepthKrw)) {
        return fail("depth_insufficient", "Depth is below the configured threshold", {
          depth_krw: depthKrw.toFixed(),
          min_depth_krw: minDepthKrw.toFixed(),
        });
      }

      return pass("depth_sufficient", "Depth is sufficient for the configured threshold", {
        depth_krw: depthKrw.toFixed(),
        min_depth_krw: minDepthKrw.toFixed(),
      });
    },
  };
}

/**
 * CostModel decision이 allow인지 확인하는 rule이다.
 */
export const costMarginOkRule: Rule = {
  id: "cost_margin_ok",
  evaluate: (context) => {
    const decision = context.costDecision;

    if (decision === undefined) {
      return fail("cost_decision_missing", "Cost decision is required before rule evaluation");
    }

    if (!decision.tradeAllowed) {
      return fail(decision.reasonCode, decision.message, {
        cost_snapshot: decision.snapshot,
      });
    }

    return pass("cost_margin_ok", "Cost decision allows the candidate", {
      cost_snapshot: decision.snapshot,
    });
  },
};

/**
 * M5 전까지 RiskGate 활성 판단이 아님을 명시하는 placeholder rule이다.
 *
 * WARN으로 반환해 rule chain에 기록은 남기되, execution 승인으로 해석할 PASS를 반환하지 않는다.
 */
export const riskOkPlaceholderRule: Rule = {
  id: "risk_ok",
  evaluate: () =>
    warn("risk_ok_placeholder", "Active RiskGate approval is not implemented until M5", {
      placeholder: true,
      active_risk_gate_evaluated: false,
      execution_approval: false,
    }),
};

/**
 * 실제 RiskGate 평가 결과를 `risk_ok` rule 결과로 연결한다.
 *
 * RiskGate가 audit-only WARN을 반환해도 `approved=true`이면 rule은 PASS로 남겨 실행 후보를 막지 않는다.
 *
 * 후보 fingerprint가 없는 사전 계산 결과는 현재 주문 후보와 일치하는지 검증할 수 없으므로 받지 않는다. 이 rule은 항상
 * 현재 `riskGateContext`로 RiskGate를 재평가하고, 입력이 없으면 fail-closed로 차단한다.
 */
export function createRiskOkRule(options: RiskOkRuleOptions = {}): Rule {
  const evaluate = options.evaluateRiskGate ?? evaluateRiskGate;

  return {
    id: "risk_ok",
    evaluate: (context) => {
      if (context.riskGateContext === undefined) {
        // RiskGate 입력 누락은 주문 승인 근거 누락이므로 PASS나 WARN으로 완화하지 않는다.
        return fail("risk_gate_context_missing", "RiskGate context is required before risk_ok can pass", {
          active_risk_gate_evaluated: false,
          execution_approval: false,
        });
      }

      const candidateMismatch = validateRiskGateRuleCandidate(context);
      if (candidateMismatch !== undefined) {
        return candidateMismatch;
      }

      // 외부 캐시 결과 대신 현재 context를 평가해 stale 승인 결과가 주문 후보를 우회하지 못하게 한다.
      const result = evaluate(context.riskGateContext);

      return result.approved
        ? pass("risk_gate_approved", "RiskGate approved the candidate", toRiskGateRuleMetadata(result))
        : fail("risk_gate_rejected", "RiskGate rejected the candidate", toRiskGateRuleMetadata(result));
    },
  };
}

/**
 * M5 이후 runtime 기본 rule 조합을 만든다.
 */
export function createDefaultM5Rules(options: DefaultM4RulesOptions): readonly Rule[] {
  return [
    createUniverseAllowedRule({ allowedMarkets: options.allowedMarkets }),
    marketWarningAbsentRule,
    createSpreadOkRule({ maxSpreadBps: options.maxSpreadBps }),
    createDepthSufficientRule({ minDepthKrw: options.minDepthKrw }),
    costMarginOkRule,
    createRiskOkRule(),
    createStopLossRule({ stopLossBps: options.stopLossBps }),
    createTakeProfitRule({ takeProfitBps: options.takeProfitBps }),
  ];
}

/**
 * unrealized PnL이 손절 threshold에 도달했는지 확인하는 exit rule을 만든다.
 */
export function createStopLossRule(options: StopLossRuleOptions): Rule {
  const defaultStopLossBps = parseRuleDecimal(options.stopLossBps, "stop_loss_bps");

  return {
    id: "stop_loss",
    evaluate: (context) => {
      const unrealizedPnlBps = readFeatureDecimal(context, "unrealized_pnl_bps");

      if (unrealizedPnlBps === undefined) {
        return pass("stop_loss_not_applicable", "unrealized_pnl_bps feature is absent");
      }

      const candidateStopLossBps = readOrderIntentMetadataDecimal(context, "stop_loss_bps");

      if (candidateStopLossBps.status === "invalid") {
        return fail("stop_loss_bps_invalid", "stop_loss_bps metadata must be a non-negative decimal string", {
          source: candidateStopLossBps.source,
        });
      }

      // 1. 전략별 stop-loss metadata가 있으면 rule 기본값보다 우선 적용한다.
      const stopLossBps =
        candidateStopLossBps.status === "ok" ? candidateStopLossBps.value : defaultStopLossBps;
      const stopLossBpsSource =
        candidateStopLossBps.status === "ok"
          ? candidateStopLossBps.source
          : "rule.default_stop_loss_bps";

      if (unrealizedPnlBps.lessThanOrEqualTo(stopLossBps.negated())) {
        return warn("stop_loss_triggered", "Unrealized loss reached the stop loss threshold", {
          unrealized_pnl_bps: unrealizedPnlBps.toFixed(),
          stop_loss_bps: stopLossBps.toFixed(),
          stop_loss_bps_source: stopLossBpsSource,
        });
      }

      return pass("stop_loss_clear", "Stop loss threshold is not reached", {
        stop_loss_bps: stopLossBps.toFixed(),
        stop_loss_bps_source: stopLossBpsSource,
      });
    },
  };
}

/**
 * unrealized PnL이 익절 threshold에 도달했는지 확인하는 exit rule을 만든다.
 */
export function createTakeProfitRule(options: TakeProfitRuleOptions): Rule {
  const takeProfitBps = parseRuleDecimal(options.takeProfitBps, "take_profit_bps");

  return {
    id: "take_profit",
    evaluate: (context) => {
      const unrealizedPnlBps = readFeatureDecimal(context, "unrealized_pnl_bps");

      if (unrealizedPnlBps === undefined) {
        return pass("take_profit_not_applicable", "unrealized_pnl_bps feature is absent");
      }

      if (unrealizedPnlBps.greaterThanOrEqualTo(takeProfitBps)) {
        return warn("take_profit_triggered", "Unrealized profit reached the take profit threshold", {
          unrealized_pnl_bps: unrealizedPnlBps.toFixed(),
          take_profit_bps: takeProfitBps.toFixed(),
        });
      }

      return pass("take_profit_clear", "Take profit threshold is not reached");
    },
  };
}

/**
 * M4 기본 rule 조합을 만든다.
 */
export function createDefaultM4Rules(options: DefaultM4RulesOptions): readonly Rule[] {
  return [
    createUniverseAllowedRule({ allowedMarkets: options.allowedMarkets }),
    marketWarningAbsentRule,
    createSpreadOkRule({ maxSpreadBps: options.maxSpreadBps }),
    createDepthSufficientRule({ minDepthKrw: options.minDepthKrw }),
    costMarginOkRule,
    riskOkPlaceholderRule,
    createStopLossRule({ stopLossBps: options.stopLossBps }),
    createTakeProfitRule({ takeProfitBps: options.takeProfitBps }),
  ];
}

/**
 * 현재 rule 후보와 RiskGate 입력 후보가 같은 주문 intent인지 확인한다.
 *
 * exchange/market rule과 cost rule은 `RuleContext` 기준으로 통과했는데 `risk_ok`만 다른 후보의 RiskGate snapshot을
 * 평가하면 stale 승인 우회가 가능하므로, 후보 식별자가 다르면 fail-closed한다.
 */
function validateRiskGateRuleCandidate(context: RuleContext): RuleEvaluation | undefined {
  const riskIntent = context.riskGateContext?.orderIntent;

  if (riskIntent === undefined) {
    return undefined;
  }

  if (context.orderIntent === undefined) {
    return fail("risk_gate_order_intent_missing", "Rule order intent is required before risk_ok can pass", {
      active_risk_gate_evaluated: false,
      execution_approval: false,
      risk_gate_exchange_id: riskIntent.exchangeId,
      risk_gate_market: riskIntent.market,
      risk_gate_idempotency_key: riskIntent.idempotencyKey,
    });
  }

  const mismatches = createOrderIntentMismatchMetadata(context, riskIntent);

  if (Object.keys(mismatches).length === 0) {
    return undefined;
  }

  return fail("risk_gate_context_mismatch", "Rule context and RiskGate context do not describe the same order candidate", {
    active_risk_gate_evaluated: false,
    execution_approval: false,
    mismatches,
  });
}

function createOrderIntentMismatchMetadata(
  context: RuleContext,
  riskIntent: NonNullable<RuleContext["riskGateContext"]>["orderIntent"],
): JsonRecord {
  const ruleIntent = context.orderIntent;
  const mismatches: JsonRecord = {};

  if (context.exchangeId !== riskIntent.exchangeId) {
    mismatches.context_exchange_id = context.exchangeId;
    mismatches.risk_gate_exchange_id = riskIntent.exchangeId;
  }
  if (context.market !== riskIntent.market) {
    mismatches.context_market = context.market;
    mismatches.risk_gate_market = riskIntent.market;
  }

  if (ruleIntent === undefined) {
    return mismatches;
  }

  appendMismatch(mismatches, "order_intent_exchange_id", ruleIntent.exchangeId, riskIntent.exchangeId);
  appendMismatch(mismatches, "order_intent_market", ruleIntent.market, riskIntent.market);
  appendMismatch(mismatches, "order_intent_strategy_id", ruleIntent.strategyId, riskIntent.strategyId);
  appendMismatch(mismatches, "order_intent_side", ruleIntent.side, riskIntent.side);
  appendMismatch(mismatches, "order_intent_order_type", ruleIntent.orderType, riskIntent.orderType);
  appendMismatch(mismatches, "order_intent_idempotency_key", ruleIntent.idempotencyKey, riskIntent.idempotencyKey);

  return mismatches;
}

function appendMismatch(
  target: JsonRecord,
  fieldName: string,
  ruleValue: string,
  riskGateValue: string,
): void {
  if (ruleValue !== riskGateValue) {
    target[`${fieldName}_rule`] = ruleValue;
    target[`${fieldName}_risk_gate`] = riskGateValue;
  }
}

function toRiskGateRuleMetadata(result: RiskGateResult): JsonRecord {
  return {
    active_risk_gate_evaluated: true,
    execution_approval: result.approved,
    risk_gate_status: result.status,
    risk_gate_action: result.action,
    threshold_snapshot: result.thresholdSnapshot,
    failed_evaluations: result.failedEvaluations.map(toRiskGateEvaluationMetadata),
    warning_evaluations: result.warningEvaluations.map(toRiskGateEvaluationMetadata),
  };
}

function toRiskGateEvaluationMetadata(evaluation: RiskGateResult["evaluations"][number]): JsonRecord {
  const metadata: JsonRecord = {
    status: evaluation.status,
    reason_code: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    action: evaluation.action,
  };

  assignIfDefined(metadata, "metadata", evaluation.metadata);

  return metadata;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function readFeatureDecimal(context: RuleContext, key: string): Decimal | undefined {
  const value = context.features?.[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  try {
    return parseFinancialDecimal(value);
  } catch {
    return undefined;
  }
}

function readOrderIntentMetadataDecimal(context: RuleContext, key: string): OptionalRuleDecimalRead {
  const source = `order_intent.metadata.${key}`;
  const value = context.orderIntent?.metadata?.[key];

  if (value === undefined || value === null) {
    return {
      status: "missing",
    };
  }

  try {
    const decimal = parseFinancialDecimal(value);

    if (decimal.isNegative()) {
      return {
        status: "invalid",
        source,
      };
    }

    return {
      status: "ok",
      value: decimal,
      source,
    };
  } catch {
    return {
      status: "invalid",
      source,
    };
  }
}

function parseRuleDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);

  if (decimal.isNegative()) {
    throw new Error(`${fieldName} must not be negative`);
  }

  return decimal;
}

function pass(reasonCode: string, message: string, metadata?: JsonRecord): RuleEvaluation {
  return createEvaluation("PASS", reasonCode, message, metadata);
}

function fail(reasonCode: string, message: string, metadata?: JsonRecord): RuleEvaluation {
  return createEvaluation("FAIL", reasonCode, message, metadata);
}

function warn(reasonCode: string, message: string, metadata?: JsonRecord): RuleEvaluation {
  return createEvaluation("WARN", reasonCode, message, metadata);
}

function createEvaluation(
  status: RuleEvaluation["status"],
  reasonCode: string,
  message: string,
  metadata?: JsonRecord,
): RuleEvaluation {
  if (metadata === undefined) {
    return {
      status,
      reasonCode,
      message,
    };
  }

  return {
    status,
    reasonCode,
    message,
    metadata,
  };
}
