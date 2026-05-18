import { describe, expect, it } from "vitest";
import {
  costMarginOkRule,
  createDefaultM4Rules,
  createDepthSufficientRule,
  createSpreadOkRule,
  evaluateRules,
  marketWarningAbsentRule,
  riskOkPlaceholderRule,
} from "../../src/application/index.js";
import { evaluateCost } from "../../src/domain/index.js";
import type { MarketStatus, RuleContext } from "../../src/domain/index.js";

const observedAt = new Date("2026-05-18T00:00:00.000Z");

const healthyMarketStatus: MarketStatus = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  tradable: true,
  warning: false,
  caution: false,
  reasonCodes: [],
  updatedAt: observedAt,
};

const allowedCostDecision = evaluateCost({
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  expectedReturnBps: "30",
  entryFeeBps: "5",
  exitFeeBps: "5",
  spreadCostBpsP75: "1",
  expectedSlippageBpsP95: "1",
  cancelRequotePenaltyBps: "0.5",
});

const rejectedCostDecision = evaluateCost({
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  expectedReturnBps: "10",
  entryFeeBps: "5",
  exitFeeBps: "5",
  spreadCostBpsP75: "1",
  expectedSlippageBpsP95: "1",
  cancelRequotePenaltyBps: "0.5",
});

function createContext(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    observedAt,
    universe: {
      allowedMarkets: ["KRW-BTC", "KRW-ETH"],
    },
    marketStatus: healthyMarketStatus,
    features: {
      spread_bps: "4",
      depth_krw: "80000000",
    },
    costDecision: allowedCostDecision,
    ...overrides,
  };
}

describe("M4 rule engine", () => {
  it("summarizes rule results and keeps risk_ok as an explicit WARN placeholder", async () => {
    const rules = createDefaultM4Rules({
      allowedMarkets: ["KRW-BTC", "KRW-ETH"],
      maxSpreadBps: "8",
      minDepthKrw: "50000000",
      stopLossBps: "35",
      takeProfitBps: "40",
    });

    const result = await evaluateRules(rules, createContext());

    expect(result.status).toBe("WARN");
    expect(result.passed).toBe(true);
    expect(result.failedEvaluations).toEqual([]);
    expect(result.warningEvaluations).toMatchObject([
      {
        reasonCode: "risk_ok_placeholder",
        metadata: {
          placeholder: true,
          active_risk_gate_evaluated: false,
          execution_approval: false,
        },
      },
    ]);
  });

  it("fails closed when market warning or caution is present", async () => {
    const warningResult = await Promise.resolve(
      marketWarningAbsentRule.evaluate(
        createContext({
          marketStatus: {
            ...healthyMarketStatus,
            warning: true,
          },
        }),
      ),
    );
    expect(warningResult).toMatchObject({
      status: "FAIL",
      reasonCode: "market_warning_present",
    });

    const cautionResult = await Promise.resolve(
      marketWarningAbsentRule.evaluate(
        createContext({
          marketStatus: {
            ...healthyMarketStatus,
            caution: true,
          },
        }),
      ),
    );
    expect(cautionResult).toMatchObject({
      status: "FAIL",
      reasonCode: "market_caution_present",
    });
  });

  it("fails closed when market status belongs to another context", async () => {
    const result = await Promise.resolve(
      marketWarningAbsentRule.evaluate(
        createContext({
          marketStatus: {
            ...healthyMarketStatus,
            market: "KRW-ETH",
          },
        }),
      ),
    );

    expect(result).toMatchObject({
      status: "FAIL",
      reasonCode: "market_status_mismatch",
      metadata: {
        context_exchange_id: "upbit_krw_spot",
        context_market: "KRW-BTC",
        status_exchange_id: "upbit_krw_spot",
        status_market: "KRW-ETH",
      },
    });
  });

  it("returns explicit spread and depth fail reasons", async () => {
    const negativeSpreadResult = await Promise.resolve(
      createSpreadOkRule({ maxSpreadBps: "6" }).evaluate(
        createContext({
          features: {
            spread_bps: "-1",
            depth_krw: "80000000",
          },
        }),
      ),
    );
    expect(negativeSpreadResult).toMatchObject({
      status: "FAIL",
      reasonCode: "spread_negative",
      metadata: {
        spread_bps: "-1",
      },
    });

    const spreadResult = await Promise.resolve(
      createSpreadOkRule({ maxSpreadBps: "6" }).evaluate(
        createContext({
          features: {
            spread_bps: "7",
            depth_krw: "80000000",
          },
        }),
      ),
    );
    expect(spreadResult).toMatchObject({
      status: "FAIL",
      reasonCode: "spread_too_wide",
      metadata: {
        spread_bps: "7",
        max_spread_bps: "6",
      },
    });

    const depthResult = await Promise.resolve(
      createDepthSufficientRule({ minDepthKrw: "70000000" }).evaluate(
        createContext({
          features: {
            spread_bps: "4",
            depth_krw: "60000000",
          },
        }),
      ),
    );
    expect(depthResult).toMatchObject({
      status: "FAIL",
      reasonCode: "depth_insufficient",
      metadata: {
        depth_krw: "60000000",
        min_depth_krw: "70000000",
      },
    });
  });

  it("fails explicitly when required features are absent", async () => {
    const missingSpreadResult = await Promise.resolve(
      createSpreadOkRule({ maxSpreadBps: "6" }).evaluate(
        createContext({
          features: {},
        }),
      ),
    );
    expect(missingSpreadResult).toMatchObject({
      status: "FAIL",
      reasonCode: "feature_missing_spread_bps",
    });

    const missingDepthResult = await Promise.resolve(
      createDepthSufficientRule({ minDepthKrw: "70000000" }).evaluate(
        createContext({
          features: {},
        }),
      ),
    );
    expect(missingDepthResult).toMatchObject({
      status: "FAIL",
      reasonCode: "feature_missing_depth_krw",
    });
  });

  it("uses CostModel decision as the cost_margin_ok rule input", async () => {
    const passResult = await Promise.resolve(costMarginOkRule.evaluate(createContext()));
    expect(passResult).toMatchObject({
      status: "PASS",
      reasonCode: "cost_margin_ok",
    });

    const failResult = await Promise.resolve(
      costMarginOkRule.evaluate(
        createContext({
          costDecision: rejectedCostDecision,
        }),
      ),
    );
    expect(failResult).toMatchObject({
      status: "FAIL",
      reasonCode: "cost_margin_insufficient",
    });
  });

  it("does not let risk_ok act as M4 execution approval", async () => {
    const result = await Promise.resolve(riskOkPlaceholderRule.evaluate(createContext()));

    expect(result).toMatchObject({
      status: "WARN",
      reasonCode: "risk_ok_placeholder",
      metadata: {
        active_risk_gate_evaluated: false,
        execution_approval: false,
      },
    });
  });

  it("keeps stop loss and take profit as exit warnings", async () => {
    const result = await evaluateRules(
      createDefaultM4Rules({
        allowedMarkets: ["KRW-BTC", "KRW-ETH"],
        maxSpreadBps: "8",
        minDepthKrw: "50000000",
        stopLossBps: "35",
        takeProfitBps: "40",
      }),
      createContext({
        features: {
          spread_bps: "4",
          depth_krw: "80000000",
          unrealized_pnl_bps: "42",
        },
      }),
    );

    expect(result.warningEvaluations.map((evaluation) => evaluation.reasonCode)).toEqual([
      "risk_ok_placeholder",
      "take_profit_triggered",
    ]);
  });
});
