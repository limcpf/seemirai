import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  JsonRecord,
  MarketCode,
  Rule,
  RuleContext,
  RuleEvaluation,
} from "../../domain/index.js";

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
 * unrealized PnL이 손절 threshold에 도달했는지 확인하는 exit rule을 만든다.
 */
export function createStopLossRule(options: StopLossRuleOptions): Rule {
  const stopLossBps = parseRuleDecimal(options.stopLossBps, "stop_loss_bps");

  return {
    id: "stop_loss",
    evaluate: (context) => {
      const unrealizedPnlBps = readFeatureDecimal(context, "unrealized_pnl_bps");

      if (unrealizedPnlBps === undefined) {
        return pass("stop_loss_not_applicable", "unrealized_pnl_bps feature is absent");
      }

      if (unrealizedPnlBps.lessThanOrEqualTo(stopLossBps.negated())) {
        return warn("stop_loss_triggered", "Unrealized loss reached the stop loss threshold", {
          unrealized_pnl_bps: unrealizedPnlBps.toFixed(),
          stop_loss_bps: stopLossBps.toFixed(),
        });
      }

      return pass("stop_loss_clear", "Stop loss threshold is not reached");
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
