import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryAlertCooldownStore,
  createDefaultExitRules,
  createExitSubmission,
  createRemainingExitIntent,
  createStopLossExitRule,
  createTakeProfitExitRule,
  createTrailingStopExitRule,
  createTimeBasedExitRule,
  createStrategyExitSignalRule,
  createRiskReductionExitRule,
  evaluateExitRules,
  evaluateExitSizing,
  formatSizingUserMessage,
  runExitPaperRuntime,
} from "../../src/application/index.js";
import type {
  AlertDispatchServiceOptions,
  AlertNotification,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import type {
  BrokerOrder,
  ExitDecision,
  ExitRuleContext,
  ExitPositionSnapshot,
  ExitPolicySnapshot,
  ExitPositionScope,
  ExitSizing,
  ExitTrailingState,
  ExitStrategySignal,
  ExitTimeBasedConfig,
  ExitRiskReductionSignal,
  ExitRuleEvaluation,
  ExitOrderIntent,
  ExitOrderIntentMetadata,
  OrderSubmission,
} from "../../src/domain/index.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const observedAt = new Date("2026-06-07T09:00:00.000Z");

const btcPosition: ExitPositionSnapshot = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  quantity: "0.005",
  averageEntryPrice: "125000000",
  currentPrice: "128000000",
  unrealizedPnlBps: "2400",
  notionalKrw: "640000",
  strategyId: "trend_following",
  observedAt,
};

const lossPosition: ExitPositionSnapshot = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  quantity: "0.005",
  averageEntryPrice: "130000000",
  currentPrice: "125000000",
  unrealizedPnlBps: "-3846",
  notionalKrw: "625000",
  strategyId: "trend_following",
  observedAt,
};

const paperPolicy: ExitPolicySnapshot = {
  minOrderNotional: "5000",
  tickSize: "1000",
  dustThreshold: "0.0001",
  exitCostBps: "5",
  exitSlippageBps: "2",
  source: "config/paper.json",
  capturedAt: observedAt,
};

function createContext(overrides: Partial<ExitRuleContext> = {}): ExitRuleContext {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    observedAt,
    strategyId: "trend_following",
    position: btcPosition,
    policySnapshot: paperPolicy,
    ...overrides,
  };
}

/** rule.evaluate()의 반환값을 ExitRuleEvaluation으로 resolve한다. */
async function evaluateRule(
  rule: { evaluate(ctx: ExitRuleContext): ExitRuleEvaluation | Promise<ExitRuleEvaluation> },
  ctx: ExitRuleContext,
): Promise<ExitRuleEvaluation> {
  return rule.evaluate(ctx);
}

const rawExitRuleIds = [
  "exit_position_scope",
  "stop_loss_exit",
  "take_profit_exit",
  "trailing_stop_exit",
  "time_based_exit",
  "strategy_exit_signal",
  "risk_reduction_exit",
] as const;

function expectNoRawExitRuleIds(message: string): void {
  for (const rawRuleId of rawExitRuleIds) {
    expect(message).not.toContain(rawRuleId);
  }
}

type ExitSizingTestOptions = Omit<
  Parameters<typeof evaluateExitSizing>[0],
  "market" | "strategyId" | "requestedPrice"
> & {
  market?: string;
  strategyId?: string;
  requestedPrice?: string;
};

function evaluateTestExitSizing(options: ExitSizingTestOptions) {
  return evaluateExitSizing({
    ...options,
    market: options.market ?? options.positionScope.market,
    strategyId: options.strategyId ?? options.positionScope.strategyId,
    requestedPrice: options.requestedPrice ?? options.currentPrice,
  });
}

function createRiskReductionSignal(
  overrides: Partial<ExitRiskReductionSignal> = {},
): ExitRiskReductionSignal {
  return {
    intention: "REDUCE",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    reductionRatio: "0.5",
    reasonCode: "daily_loss_limit_approaching",
    reason: "일간 손실 한도 접근, 포지션 축소",
    observedAt,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Exit rule tests
// ---------------------------------------------------------------------------

describe("exit rule engine", () => {
  describe("stop loss exit rule", () => {
    const rule = createStopLossExitRule({ stopLossBps: "3000" });

    it("rejects zero stop loss thresholds", () => {
      expect(() => createStopLossExitRule({ stopLossBps: "0" })).toThrow("greater than zero");
    });

    it("passes when unrealized loss is below stop loss threshold", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "-2400" } }));
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "stop_loss_clear",
      });
    });

    it("triggers EXIT when unrealized loss reaches stop loss threshold", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "-3100" } }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
        reasonCode: "stop_loss_triggered",
        metadata: {
          unrealized_pnl_bps: "-3100",
          stop_loss_bps: "3000",
        },
      });
    });

    it("triggers exactly at the threshold boundary", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "-3000" } }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
      });
    });

    it("returns UNAVAILABLE when unrealized PnL feature is absent", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "" } }));
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "stop_loss_unavailable",
      });
    });

    it("returns UNAVAILABLE when unrealized PnL is invalid (garbage string)", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "not-a-number" } }));
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "stop_loss_unavailable",
      });
    });

    it("is deterministic with the same fixture", async () => {
      const ctx = createContext({ position: lossPosition });
      const r1 = await evaluateRule(rule, ctx);
      const r2 = await evaluateRule(rule, ctx);
      expect(r1).toEqual(r2);
      expect(r1.status).toBe("TRIGGERED");
    });
  });

  describe("take profit exit rule", () => {
    const rule = createTakeProfitExitRule({ takeProfitBps: "2000" });

    it("rejects zero take profit thresholds", () => {
      expect(() => createTakeProfitExitRule({ takeProfitBps: "0" })).toThrow("greater than zero");
    });

    it("passes when unrealized profit is below take profit threshold", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "1500" } }));
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "take_profit_clear",
      });
    });

    it("triggers EXIT when unrealized profit reaches take profit threshold", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "2500" } }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
        reasonCode: "take_profit_triggered",
        metadata: {
          unrealized_pnl_bps: "2500",
          take_profit_bps: "2000",
        },
      });
    });

    it("triggers exactly at the threshold boundary", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "2000" } }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
      });
    });

    it("returns UNAVAILABLE when unrealized PnL feature is absent", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "" } }));
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "take_profit_unavailable",
      });
    });

    it("returns UNAVAILABLE when unrealized PnL is invalid (garbage string)", async () => {
      const result = await evaluateRule(rule, createContext({ position: { ...btcPosition, unrealizedPnlBps: "invalid" } }));
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "take_profit_unavailable",
      });
    });

    it("is deterministic with the same fixture", async () => {
      const ctx = createContext({ position: btcPosition });
      const r1 = await evaluateRule(rule, ctx);
      const r2 = await evaluateRule(rule, ctx);
      expect(r1).toEqual(r2);
      expect(r1.status).toBe("TRIGGERED");
    });
  });

  describe("trailing stop exit rule", () => {
    const rule = createTrailingStopExitRule({ defaultTrailBps: "500" });

    it("rejects zero default trailing thresholds", () => {
      expect(() => createTrailingStopExitRule({ defaultTrailBps: "0" })).toThrow("greater than zero");
    });

    it("returns UNAVAILABLE when trailing state snapshot is missing", async () => {
      const result = await evaluateRule(rule, createContext());
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reasonCode: "trailing_state_missing",
      });
    });

    it("passes when current price is close to anchor", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "129500000" },
      }));
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "trailing_stop_clear",
      });
    });

    it("triggers EXIT when current price drops below trailing threshold", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "120000000" },
      }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
        reasonCode: "trailing_stop_triggered",
      });
    });

    it("does not use current price as anchor when snapshot is missing", async () => {
      const result = await evaluateRule(rule, createContext());
      expect(result.status).toBe("UNAVAILABLE");
      expect(result.reasonCode).toBe("trailing_state_missing");
    });

    it("blocks when anchorPrice is zero (prevents NaN/Infinity evidence)", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "0",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({ trailingState }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_anchor_invalid",
      });
    });

    it("blocks when anchorPrice is negative", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "-100",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({ trailingState }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_anchor_invalid",
      });
    });

    it("blocks when anchorPrice is not a finite number", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "Infinity",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({ trailingState }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_anchor_invalid",
      });
    });

    it("blocks when anchor observed time is invalid", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: "not-a-date",
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "120000000" },
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_anchor_observed_at_invalid",
      });
    });

    it("blocks when currentPrice is invalid", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "not-a-price" },
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_price_invalid",
      });
    });

    it("blocks when currentPrice is zero or negative", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "500",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "0" },
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_price_invalid",
      });
    });

    it("blocks when trailBps is invalid (non-empty garbage string)", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "abc",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "120000000" },
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "trailing_trail_bps_invalid",
      });
    });

    it("blocks when trailBps is zero or negative", async () => {
      for (const trailBps of ["0", "-500"]) {
        const trailingState: ExitTrailingState = {
          anchorPrice: "130000000",
          anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
          trailBps,
        };
        const result = await evaluateRule(rule, createContext({
          trailingState,
          position: { ...btcPosition, currentPrice: "120000000" },
        }));
        expect(result).toMatchObject({
          status: "BLOCKED",
          reasonCode: "trailing_trail_bps_invalid",
        });
      }
    });

    it("uses default trailBps when trailing state has no trailBps override", async () => {
      const trailingState: ExitTrailingState = {
        anchorPrice: "130000000",
        anchorObservedAt: new Date("2026-06-07T08:00:00.000Z"),
        trailBps: "",
      };
      const result = await evaluateRule(rule, createContext({
        trailingState,
        position: { ...btcPosition, currentPrice: "120000000" },
      }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
      });
    });
  });

  describe("time based exit rule", () => {
    const rule = createTimeBasedExitRule();

    it("passes when time based config is absent", async () => {
      const result = await evaluateRule(rule, createContext());
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "time_based_not_configured",
      });
    });

    it("passes when deadline is in the future", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: new Date("2026-06-08T00:00:00.000Z"),
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({ timeBasedConfig: timeConfig }));
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "time_based_not_reached",
      });
    });

    it("triggers EXIT when deadline has passed", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: new Date("2026-06-07T08:00:00.000Z"),
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({ timeBasedConfig: timeConfig }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
        reasonCode: "time_based_triggered",
        metadata: {
          timezone: "UTC",
        },
      });
    });

    it("records timezone in metadata to prevent UTC/KST confusion", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: new Date("2026-06-07T08:00:00.000Z"),
        timezone: "KST",
      };
      const result = await evaluateRule(rule, createContext({ timeBasedConfig: timeConfig }));
      expect(result.metadata?.timezone).toBe("KST");
    });

    it("interprets KST wall-clock deadlines as UTC+9 before comparison", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "2026-06-08T09:00:00",
        timezone: "KST",
      };
      const result = await evaluateRule(rule, createContext({
        timeBasedConfig: timeConfig,
        observedAt: "2026-06-08T00:00:00.000Z",
      }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        reasonCode: "time_based_triggered",
        metadata: {
          timezone: "KST",
        },
      });
    });

    it("interprets UTC wall-clock deadlines as UTC rather than process local time", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "2026-06-08T09:00:00",
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({
        timeBasedConfig: timeConfig,
        observedAt: "2026-06-08T00:00:00.000Z",
      }));
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "time_based_not_reached",
      });
    });

    it("blocks on invalid deadline values", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "not-a-date",
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({ timeBasedConfig: timeConfig }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "time_based_deadline_invalid",
      });
    });

    it("blocks when deadline string mixes explicit offset with timezone field", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "2026-06-08T09:00:00Z",
        timezone: "KST",
      };
      const result = await evaluateRule(rule, createContext({ timeBasedConfig: timeConfig }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "time_based_deadline_timezone_mixed",
      });
    });

    it("blocks when observedAt is invalid", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: new Date("2026-06-08T00:00:00.000Z"),
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({
        timeBasedConfig: timeConfig,
        observedAt: "invalid-date",
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "time_based_observed_at_invalid",
      });
    });

    it("blocks when observedAt is an offset-less wall-clock string", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "2026-06-08T09:00:00",
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({
        timeBasedConfig: timeConfig,
        observedAt: "2026-06-08T09:00:00",
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "time_based_observed_at_timezone_missing",
      });
    });

    it("blocks normalized observedAt calendar dates even with explicit offset", async () => {
      const timeConfig: ExitTimeBasedConfig = {
        deadline: "2026-06-08T09:00:00",
        timezone: "UTC",
      };
      const result = await evaluateRule(rule, createContext({
        timeBasedConfig: timeConfig,
        observedAt: "2026-02-30T09:00:00.000Z",
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "time_based_observed_at_invalid",
      });
    });
  });

  describe("strategy exit signal rule", () => {
    const rule = createStrategyExitSignalRule();

    it("passes when no strategy exit signal is present", async () => {
      const result = await evaluateRule(rule, createContext());
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "strategy_exit_no_signal",
      });
    });

    it("triggers EXIT when strategy signal has EXIT intention", async () => {
      const signal: ExitStrategySignal = {
        intention: "EXIT",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "trend_following",
        reasonCode: "mean_reversion_exit",
        reason: "평균 복귀 exit signal",
        observedAt,
      };
      const result = await evaluateRule(rule, createContext({ strategyExitSignal: signal }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
        reasonCode: "mean_reversion_exit",
        metadata: {
          signal_strategy_id: "trend_following",
        },
      });
    });

    it("triggers REDUCE when strategy signal has REDUCE intention", async () => {
      const signal: ExitStrategySignal = {
        intention: "REDUCE",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "trend_following",
        reductionRatio: "0.4",
        reasonCode: "trend_reversal_partial",
        reason: "추세 반전 감지, 부분 축소",
        observedAt,
      };
      const result = await evaluateRule(rule, createContext({ strategyExitSignal: signal }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "REDUCE",
        metadata: {
          reduction_ratio: "0.4",
        },
      });
    });

    it("blocks REDUCE strategy signal when reduction ratio is invalid", async () => {
      const signal: ExitStrategySignal = {
        intention: "REDUCE",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "trend_following",
        reductionRatio: "1",
        reasonCode: "trend_reversal_partial",
        reason: "잘못된 부분 축소 비율",
        observedAt,
      };
      const result = await evaluateRule(rule, createContext({ strategyExitSignal: signal }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "strategy_exit_reduction_ratio_invalid",
      });
    });

    it("blocks strategy signal when runtime intention is invalid", async () => {
      const signal = {
        intention: "PARTIAL",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "trend_following",
        reasonCode: "partial_exit_signal",
        reason: "잘못된 intention",
        observedAt,
      } as unknown as ExitStrategySignal;
      const result = await evaluateRule(rule, createContext({ strategyExitSignal: signal }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "strategy_exit_intention_invalid",
      });
      expect(result.metadata).toMatchObject({
        signal_intention: "PARTIAL",
      });
    });

    it("blocks when strategy signal scope does not match current position scope", async () => {
      const signal: ExitStrategySignal = {
        intention: "EXIT",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        strategyId: "mean_reversion",
        reasonCode: "mean_reversion_exit",
        reason: "다른 전략의 exit signal",
        observedAt,
      };
      const result = await evaluateRule(rule, createContext({
        position: { ...btcPosition, strategyId: "trend_following" },
        strategyExitSignal: signal,
      }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "strategy_exit_scope_mismatch",
      });
      expect(result.metadata).toMatchObject({
        signal_strategy_id: "mean_reversion",
        context_strategy_id: "trend_following",
        position_strategy_id: "trend_following",
      });
    });

    it("blocks when strategy signal market scope does not match context market", async () => {
      const signal: ExitStrategySignal = {
        intention: "EXIT",
        exchangeId: "upbit_krw_spot",
        market: "KRW-ETH",
        strategyId: "trend_following",
        reasonCode: "trend_exit_other_market",
        reason: "다른 마켓의 exit signal",
        observedAt,
      };
      const result = await evaluateRule(rule, createContext({ strategyExitSignal: signal }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "strategy_exit_scope_mismatch",
      });
      expect(result.metadata).toMatchObject({
        signal_market: "KRW-ETH",
        context_market: "KRW-BTC",
      });
    });
  });

  describe("risk reduction exit rule", () => {
    const rule = createRiskReductionExitRule();

    it("passes when no risk reduction signal is present", async () => {
      const result = await evaluateRule(rule, createContext());
      expect(result).toMatchObject({
        status: "PASS",
        reasonCode: "risk_reduction_no_signal",
      });
    });

    it("triggers REDUCE when risk signal requests reduction", async () => {
      const signal = createRiskReductionSignal({
        reasonCode: "daily_loss_limit_approaching",
        reason: "일간 손실 한도 접근, 포지션 50% 축소",
      });
      const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "REDUCE",
        reasonCode: "daily_loss_limit_approaching",
        metadata: {
          reduction_ratio: "0.5",
        },
      });
    });

    it("triggers EXIT when risk signal requests exit", async () => {
      const signal = createRiskReductionSignal({
        intention: "EXIT",
        reductionRatio: "1",
        reasonCode: "drawdown_limit_exceeded",
        reason: "MDD 한도 초과, 전량 청산",
      });
      const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
      expect(result).toMatchObject({
        status: "TRIGGERED",
        exitIntention: "EXIT",
      });
    });

    it("blocks when risk reduction ratio is invalid", async () => {
      for (const reductionRatio of ["not-a-ratio", "-0.5", "0", "2"]) {
        const signal = createRiskReductionSignal({
          reductionRatio,
        });
        const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
        expect(result).toMatchObject({
          status: "BLOCKED",
          reasonCode: "risk_reduction_ratio_invalid",
        });
        expect(result.metadata?.reduction_ratio).toBe(reductionRatio);
      }
    });

    it("blocks when risk reduction runtime intention is invalid", async () => {
      const signal = createRiskReductionSignal({
        intention: "PARTIAL" as ExitRiskReductionSignal["intention"],
        reductionRatio: "0.5",
      });
      const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "risk_reduction_intention_invalid",
      });
      expect(result.metadata).toMatchObject({
        signal_intention: "PARTIAL",
      });
    });

    it("blocks when risk reduction signal scope does not match context", async () => {
      const signal = createRiskReductionSignal({
        market: "KRW-ETH",
      });
      const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
      expect(result).toMatchObject({
        status: "BLOCKED",
        reasonCode: "risk_reduction_scope_mismatch",
      });
      expect(result.metadata).toMatchObject({
        signal_market: "KRW-ETH",
        context_market: "KRW-BTC",
      });
    });

    it("blocks when risk reduction intention conflicts with ratio semantics", async () => {
      const exitWithPartialRatio = createRiskReductionSignal({
        intention: "EXIT",
        reductionRatio: "0.5",
        reasonCode: "drawdown_limit_exceeded",
        reason: "전량 청산 의도와 부분 축소 비율 불일치",
      });
      const reduceWithFullRatio = createRiskReductionSignal({
        intention: "REDUCE",
        reductionRatio: "1",
        reasonCode: "daily_loss_limit_approaching",
        reason: "부분 축소 의도와 전량 비율 불일치",
      });

      for (const signal of [exitWithPartialRatio, reduceWithFullRatio]) {
        const result = await evaluateRule(rule, createContext({ riskReductionSignal: signal }));
        expect(result).toMatchObject({
          status: "BLOCKED",
          reasonCode: "risk_reduction_ratio_intention_mismatch",
        });
        expect(result.metadata).toMatchObject({
          reduction_ratio: signal.reductionRatio,
          signal_intention: signal.intention,
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Exit decision aggregation tests
// ---------------------------------------------------------------------------

describe("exit decision aggregation", () => {
  it("returns HOLD when no rule is triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "3000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: { ...btcPosition, unrealizedPnlBps: "1000" } }),
    );
    expect(decision).toMatchObject({
      kind: "HOLD",
      reasonCode: "exit_hold",
    });
    expect(decision.triggeredRules).toHaveLength(0);
  });

  it("returns EXIT when stop loss is triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: { ...btcPosition, unrealizedPnlBps: "-2500" } }),
    );
    expect(decision).toMatchObject({
      kind: "EXIT",
      reasonCode: "exit_triggered",
    });
    expect(decision.triggeredRules).toHaveLength(1);
    expect(decision.triggeredRules[0]!.ruleId).toBe("stop_loss_exit");
    expect(decision.userMessage).toContain("전체 청산");
    expect(decision.userMessage).toContain("손절 기준");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("returns EXIT when take profit is triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "5000",
      takeProfitBps: "1500",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: { ...btcPosition, unrealizedPnlBps: "2400" } }),
    );
    expect(decision).toMatchObject({
      kind: "EXIT",
      reasonCode: "exit_triggered",
    });
    expect(decision.triggeredRules[0]!.ruleId).toBe("take_profit_exit");
    expect(decision.userMessage).toContain("익절 기준");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("returns EXIT when multiple rules are triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "1500",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: { ...btcPosition, unrealizedPnlBps: "2400" } }),
    );
    expect(decision.kind).toBe("EXIT");
  });

  it("returns REDUCE when only risk reduction with REDUCE is triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "5000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const signal = createRiskReductionSignal({
      reductionRatio: "0.3",
      reasonCode: "position_rebalance",
      reason: "포지션 리밸런싱",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: btcPosition, riskReductionSignal: signal }),
    );
    expect(decision).toMatchObject({
      kind: "REDUCE",
      reasonCode: "reduce_triggered",
    });
    expect(decision.userMessage).toContain("일부 축소");
    expect(decision.userMessage).toContain("리스크 축소 신호");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("returns EXIT when EXIT and REDUCE rules are both triggered", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const signal = createRiskReductionSignal({
      reductionRatio: "0.5",
      reasonCode: "risk_rebalance",
      reason: "리스크 축소",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({
        position: { ...btcPosition, unrealizedPnlBps: "-3000" },
        riskReductionSignal: signal,
      }),
    );
    expect(decision.kind).toBe("EXIT");
    expect(decision.triggeredRules.map((r) => r.ruleId)).toContain("stop_loss_exit");
    expect(decision.triggeredRules.map((r) => r.ruleId)).toContain("risk_reduction_exit");
  });

  it("returns HOLD when only UNAVAILABLE rules exist (not BLOCKED)", async () => {
    // UNAVAILABLE은 trace에 blockedRules로 남지만 최종 결정은 BLOCK이 아니다.
    // PASS(trigger되지 않음)와 UNAVAILABLE(평가 불가)은 decision에서 구분된다.
    const rules = createDefaultExitRules({
      stopLossBps: "3000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    // unrealizedPnlBps가 빈 문자열 → stop-loss와 take-profit이 UNAVAILABLE
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: { ...btcPosition, unrealizedPnlBps: "" } }),
    );
    // UNAVAILABLE은 BLOCK이 아니므로 HOLD로 수렴한다.
    expect(decision.kind).toBe("HOLD");
    // 하지만 blockedRules에는 UNAVAILABLE rule이 trace로 남는다.
    expect(decision.blockedRules.length).toBeGreaterThanOrEqual(2);
    const unavailableIds = decision.blockedRules
      .filter((r) => r.status === "UNAVAILABLE")
      .map((r) => r.ruleId);
    expect(unavailableIds).toContain("stop_loss_exit");
    expect(unavailableIds).toContain("take_profit_exit");
  });

  it("returns BLOCK when any rule is BLOCKED", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "5000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const timeConfig: ExitTimeBasedConfig = {
      deadline: "bad-date",
      timezone: "UTC",
    };
    const decision = await evaluateExitRules(
      rules,
      createContext({ position: btcPosition, timeBasedConfig: timeConfig }),
    );
    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "exit_blocked",
    });
    expect(decision.userMessage).toContain("차단");
    expect(decision.userMessage).toContain("시간 기반 청산 기준");
    expectNoRawExitRuleIds(decision.userMessage);
    expect(decision.blockedRules.map((r) => r.ruleId)).toContain("time_based_exit");
  });

  it("returns BLOCK when position quantity is zero even if an exit rule triggers", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({
        position: { ...btcPosition, quantity: "0", unrealizedPnlBps: "-3000" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "exit_blocked",
    });
    expect(decision.triggeredRules.map((r) => r.ruleId)).toContain("stop_loss_exit");
    expect(decision.blockedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "exit_position_scope",
          status: "BLOCKED",
          reasonCode: "exit_no_position",
        }),
      ]),
    );
    expect(decision.userMessage).toContain("보유 포지션 수량");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("returns BLOCK when position snapshot scope does not match context scope", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({
        position: { ...btcPosition, market: "KRW-ETH", unrealizedPnlBps: "-3000" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "exit_blocked",
    });
    expect(decision.blockedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "exit_position_scope",
          status: "BLOCKED",
          reasonCode: "exit_position_scope_mismatch",
        }),
      ]),
    );
    expect(decision.userMessage).toContain("보유 포지션 수량");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("returns BLOCK when position strategy scope is missing", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({
        position: { ...btcPosition, strategyId: "", unrealizedPnlBps: "-3000" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "exit_blocked",
    });
    expect(decision.blockedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "exit_position_scope",
          status: "BLOCKED",
          reasonCode: "exit_position_scope_mismatch",
        }),
      ]),
    );
  });

  it("returns BLOCK when position quantity cannot be parsed", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "2000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });
    const decision = await evaluateExitRules(
      rules,
      createContext({
        position: { ...btcPosition, quantity: "not-a-quantity", unrealizedPnlBps: "-3000" },
      }),
    );
    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "exit_blocked",
    });
    expect(decision.blockedRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "exit_position_scope",
          status: "BLOCKED",
          reasonCode: "exit_position_quantity_invalid",
        }),
      ]),
    );
    expect(decision.userMessage).toContain("보유 포지션 수량");
    expectNoRawExitRuleIds(decision.userMessage);
  });

  it("contains user-facing message in Korean without raw internal codes", () => {
    const decision: ExitDecision = {
      kind: "HOLD",
      ruleEvaluations: [],
      triggeredRules: [],
      blockedRules: [],
      reasonCode: "exit_hold",
      userMessage: "청산 조건이 충족되지 않아 현재 포지션을 유지합니다.",
      observedAt,
    };
    expect(decision.userMessage).not.toContain("exit_hold");
    expect(decision.reasonCode).toBe("exit_hold");
  });
});

// ---------------------------------------------------------------------------
// Exit sizing tests
// ---------------------------------------------------------------------------

describe("exit sizing", () => {
  it("validates a normal exit request within position bounds", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: true,
      requestedQuantity: "0.003",
      executableQuantity: "0.003",
      dustQuantity: "0",
      exceedsPosition: false,
      belowMinOrderNotional: false,
    });
  });

  it("blocks when requested sizing scope does not match position scope", () => {
    const result = evaluateTestExitSizing({
      market: "KRW-ETH",
      strategyId: "trend_following",
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: false,
      rejectionReason: "exit_position_scope_mismatch",
    });
  });

  it("blocks dust residue so partial sell does not become a broker candidate", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.00495",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: false,
      executableQuantity: "0",
      dustQuantity: "0.00005",
      rejectionReason: "dust_remainder",
    });
    expect(result.dustReason).toBeDefined();
    expect(result.dustReason).toContain("처리 불가 잔량");
    expect(formatSizingUserMessage(result)).toContain("주문 후보 생성을 차단");
  });

  it("preserves dust evidence before remaining min-order checks", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.00495",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "2000000",
    });

    expect(result).toMatchObject({
      valid: false,
      executableQuantity: "0",
      dustQuantity: "0.00005",
      rejectionReason: "dust_remainder",
    });
    expect(result.remainingBelowMinOrderNotional).toBeUndefined();
    expect(formatSizingUserMessage(result)).toContain("처리 불가 잔량");
  });

  it("detects exact exit (no dust) when selling the full position", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.005",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: true,
      dustQuantity: "0",
    });
    expect(result.dustReason).toBeUndefined();
  });

  it("blocks when requested quantity exceeds open position", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.01",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: false,
      exceedsPosition: true,
      rejectionReason: "position_exceeded",
    });
    expect(result.executableQuantity).toBe("0");
    expect(result.exceedsPositionReason).toContain("초과");
  });

  it("blocks when requested quantity is 0 or negative", () => {
    const zeroResult = evaluateTestExitSizing({
      requestedQuantity: "0",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(zeroResult).toMatchObject({
      valid: false,
      rejectionReason: "exit_quantity_invalid",
    });
  });

  it("blocks when there is no open position", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: false,
      rejectionReason: "exit_no_position",
    });
  });

  it("blocks when executable notional is below min order amount", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.00001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(result).toMatchObject({
      valid: false,
      belowMinOrderNotional: true,
      rejectionReason: "below_min_order_notional",
    });
  });

  it("uses requested price rather than current price for min order amount", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "6000000",
      requestedPrice: "4000000",
    });
    expect(result).toMatchObject({
      valid: false,
      belowMinOrderNotional: true,
      rejectionReason: "below_min_order_notional",
    });
  });

  it("blocks when remaining position notional would be below min order amount", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.006",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.01",
        observedAt,
      },
      policySnapshot: {
        ...paperPolicy,
        minOrderNotional: "5000",
        dustThreshold: "0.0001",
      },
      currentPrice: "1000000",
    });
    expect(result).toMatchObject({
      valid: false,
      executableQuantity: "0",
      remainingBelowMinOrderNotional: true,
      rejectionReason: "remaining_below_min_order_notional",
    });
    expect(result.dustQuantity).toBe("0");
    expect(formatSizingUserMessage(result)).toContain("잔여 포지션");
  });

  it("blocks when min order policy is zero or negative", () => {
    for (const minOrderNotional of ["0", "-1"]) {
      const result = evaluateTestExitSizing({
        requestedQuantity: "0.003",
        positionScope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
        policySnapshot: {
          ...paperPolicy,
          minOrderNotional,
        },
        currentPrice: "128000000",
      });

      expect(result).toMatchObject({
        valid: false,
        rejectionReason: "exit_policy_invalid",
      });
      expect(formatSizingUserMessage(result)).toContain("정책");
    }
  });

  it("blocks when dust threshold policy is negative", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: {
        ...paperPolicy,
        dustThreshold: "-0.0001",
      },
      currentPrice: "128000000",
    });

    expect(result).toMatchObject({
      valid: false,
      rejectionReason: "exit_policy_invalid",
    });
    expect(formatSizingUserMessage(result)).toContain("정책");
  });

  it("blocks when tick size policy is zero or negative", () => {
    for (const tickSize of ["0", "-1"]) {
      const result = evaluateTestExitSizing({
        requestedQuantity: "0.003",
        positionScope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
        policySnapshot: {
          ...paperPolicy,
          tickSize,
        },
        currentPrice: "128000000",
      });

      expect(result).toMatchObject({
        valid: false,
        rejectionReason: "exit_policy_invalid",
      });
      expect(formatSizingUserMessage(result)).toContain("호가 단위");
    }
  });

  it("blocks when current price is zero or negative", () => {
    for (const currentPrice of ["0", "-1"]) {
      const result = evaluateTestExitSizing({
        requestedQuantity: "0.003",
        positionScope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
        policySnapshot: paperPolicy,
        currentPrice,
      });

      expect(result).toMatchObject({
        valid: false,
        rejectionReason: "exit_price_invalid",
      });
      expect(formatSizingUserMessage(result)).toContain("현재가");
    }
  });

  it("blocks when requested price is zero or negative", () => {
    for (const requestedPrice of ["0", "-1"]) {
      const result = evaluateTestExitSizing({
        requestedQuantity: "0.003",
        positionScope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
        policySnapshot: paperPolicy,
        currentPrice: "128000000",
        requestedPrice,
      });

      expect(result).toMatchObject({
        valid: false,
        rejectionReason: "exit_price_invalid",
      });
      expect(formatSizingUserMessage(result)).toContain("가격");
    }
  });

  it("blocks when requested price does not match tick size", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      requestedPrice: "128000001",
    });

    expect(result).toMatchObject({
      valid: false,
      rejectionReason: "exit_price_tick_mismatch",
    });
    expect(formatSizingUserMessage(result)).toContain("호가 단위");
  });

  it("provides Korean user messages for sizing failures", () => {
    const result = evaluateTestExitSizing({
      requestedQuantity: "0.01",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    const msg = formatSizingUserMessage(result);
    expect(msg).toContain("초과");
    expect(msg).toContain("차단");
  });

  it("never exposes raw rejectionReason codes to users", () => {
    // exit_sizing_parse_error
    const parseError = evaluateTestExitSizing({
      requestedQuantity: "not-a-number",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(parseError.rejectionReason).toBe("exit_sizing_parse_error");
    const parseMsg = formatSizingUserMessage(parseError);
    expect(parseMsg).not.toContain("exit_sizing_parse_error");
    expect(parseMsg).toContain("파싱");

    // exit_no_position
    const noPos = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(noPos.rejectionReason).toBe("exit_no_position");
    const noPosMsg = formatSizingUserMessage(noPos);
    expect(noPosMsg).not.toContain("exit_no_position");
    expect(noPosMsg).toContain("포지션");

    // exit_quantity_invalid
    const qtyInvalid = evaluateTestExitSizing({
      requestedQuantity: "0",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(qtyInvalid.rejectionReason).toBe("exit_quantity_invalid");
    const qtyMsg = formatSizingUserMessage(qtyInvalid);
    expect(qtyMsg).not.toContain("exit_quantity_invalid");
    expect(qtyMsg).toContain("0");

    const policyInvalid = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: {
        ...paperPolicy,
        minOrderNotional: "0",
      },
      currentPrice: "128000000",
    });
    expect(policyInvalid.rejectionReason).toBe("exit_policy_invalid");
    const policyMsg = formatSizingUserMessage(policyInvalid);
    expect(policyMsg).not.toContain("exit_policy_invalid");
    expect(policyMsg).toContain("정책");

    const priceInvalid = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "0",
    });
    expect(priceInvalid.rejectionReason).toBe("exit_price_invalid");
    const priceMsg = formatSizingUserMessage(priceInvalid);
    expect(priceMsg).not.toContain("exit_price_invalid");
    expect(priceMsg).toContain("현재가");

    const dustRemainder = evaluateTestExitSizing({
      requestedQuantity: "0.00495",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(dustRemainder.rejectionReason).toBe("dust_remainder");
    const dustMsg = formatSizingUserMessage(dustRemainder);
    expect(dustMsg).not.toContain("dust_remainder");
    expect(dustMsg).toContain("처리 불가 잔량");

    const remainingBelowMin = evaluateTestExitSizing({
      requestedQuantity: "0.006",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.01",
        observedAt,
      },
      policySnapshot: {
        ...paperPolicy,
        minOrderNotional: "5000",
        dustThreshold: "0.0001",
      },
      currentPrice: "1000000",
    });
    expect(remainingBelowMin.rejectionReason).toBe("remaining_below_min_order_notional");
    const remainingBelowMinMsg = formatSizingUserMessage(remainingBelowMin);
    expect(remainingBelowMinMsg).not.toContain("remaining_below_min_order_notional");
    expect(remainingBelowMinMsg).toContain("잔여 포지션");

    const scopeMismatch = evaluateTestExitSizing({
      market: "KRW-ETH",
      strategyId: "trend_following",
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });
    expect(scopeMismatch.rejectionReason).toBe("exit_position_scope_mismatch");
    const scopeMismatchMsg = formatSizingUserMessage(scopeMismatch);
    expect(scopeMismatchMsg).not.toContain("exit_position_scope_mismatch");
    expect(scopeMismatchMsg).toContain("범위");

    const tickMismatch = evaluateTestExitSizing({
      requestedQuantity: "0.003",
      positionScope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      requestedPrice: "128000001",
    });
    expect(tickMismatch.rejectionReason).toBe("exit_price_tick_mismatch");
    const tickMismatchMsg = formatSizingUserMessage(tickMismatch);
    expect(tickMismatchMsg).not.toContain("exit_price_tick_mismatch");
    expect(tickMismatchMsg).toContain("호가 단위");
  });
});

// ---------------------------------------------------------------------------
// Hard stop invariant test
// ---------------------------------------------------------------------------

describe("hard stop invariant", () => {
  it("does not produce exit order intents through the exit rule engine", async () => {
    const rules = createDefaultExitRules({
      stopLossBps: "5000",
      takeProfitBps: "5000",
      defaultTrailBps: "500",
    });

    const decision = await evaluateExitRules(
      rules,
      createContext({ position: btcPosition }),
    );
    expect(decision.kind).toBe("HOLD");
  });
});

// ---------------------------------------------------------------------------
// ExitOrderIntent type contract test
// ---------------------------------------------------------------------------

describe("ExitOrderIntent contract", () => {
  it("requires metadata with position_effect, exit_reason_code, exit_rule_id, position_scope", () => {
    // 이 테스트는 컴파일 타임 계약을 런타임으로 검증한다.
    // ExitOrderIntent.metadata가 ExitOrderIntentMetadata 타입으로 강제되어
    // 필수 필드 누락 시 TypeScript 컴파일 오류가 발생한다.
    // 런타임에서는 실제 객체를 구성해 모든 필수 필드가 존재하는지 확인한다.
    const metadata: ExitOrderIntentMetadata = {
      position_effect: "EXIT",
      exit_reason_code: "stop_loss_triggered",
      exit_rule_id: "stop_loss_exit",
      position_scope: {
        market: "KRW-BTC",
        strategyId: "trend_following",
        totalQuantity: "0.005",
        observedAt,
      },
    };

    const intent: ExitOrderIntent = {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "SELL",
      orderType: "LIMIT",
      requestedQuantity: "0.005",
      requestedNotional: "640000",
      idempotencyKey: "exit-test-001",
      reason: "손절 조건 충족",
      requestedPrice: "128000000",
      metadata,
    };

    expect(intent.side).toBe("SELL");
    expect(intent.metadata.position_effect).toBe("EXIT");
    expect(intent.metadata.exit_reason_code).toBe("stop_loss_triggered");
    expect(intent.metadata.exit_rule_id).toBe("stop_loss_exit");
    expect(intent.metadata.position_scope.market).toBe("KRW-BTC");
  });

  it("ExitOrderIntent side is always SELL (type-level narrowing)", () => {
    // BUY를 side에 할당하면 TypeScript 컴파일 오류가 발생해야 한다.
    // 런타임 테스트로 SELL만 허용됨을 확인한다.
    const intent: ExitOrderIntent = {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "SELL",
      orderType: "LIMIT",
      requestedQuantity: "0.001",
      requestedNotional: "128000",
      idempotencyKey: "exit-test-002",
      reason: "익절",
      requestedPrice: "128000000",
      metadata: {
        position_effect: "EXIT",
        exit_reason_code: "take_profit_triggered",
        exit_rule_id: "take_profit_exit",
        position_scope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
      },
    };
    // side가 "SELL"로 좁혀졌음을 확인 (런타임 검증)
    expect(intent.side).toBe("SELL");
    expect(intent.side).not.toBe("BUY");
  });
});

describe("exit/entry cost separation", () => {
  it("exit policy snapshot has exit-specific cost fields separate from entry cost margin", () => {
    const policy: ExitPolicySnapshot = {
      minOrderNotional: "5000",
      tickSize: "1000",
      dustThreshold: "0.0001",
      exitCostBps: "5",
      exitSlippageBps: "2",
      source: "config/paper.json",
      capturedAt: observedAt,
    };

    expect(policy.exitCostBps).toBe("5");
    expect(policy.exitSlippageBps).toBe("2");
    expect(policy).not.toHaveProperty("cost_margin_ok");
    expect(policy).not.toHaveProperty("trade_allowed");
  });
});

describe("exit submission and paper runtime integration", () => {
  it("creates a stable SELL submission only for REDUCE/EXIT decisions with explicit scope and risk evidence", async () => {
    const decision = await createTriggeredReduceDecision();
    const sizing = createValidExitSizing();
    const positionScope = createBtcPositionScope();

    const result = createExitSubmission({
      decision,
      sizing,
      positionScope,
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-stable-001",
      submittedAt: observedAt,
      expectedLossBpsOfEquity: "5",
    });

    expect(result).not.toBeNull();
    expect(result?.exitOrderIntent).toMatchObject({
      side: "SELL",
      requestedNotional: "128000",
      idempotencyKey: "exit-stable-001",
      metadata: {
        position_effect: "REDUCE",
        position_scope: positionScope,
      },
    });
    expect(result?.submission).toMatchObject({
      riskApproval: { source: "risk_gate", approved: true },
      expectedLossBpsOfEquity: "5",
    });
  });

  it("uses the validated sizing requestedPrice instead of raw currentPrice", async () => {
    const decision = await createTriggeredReduceDecision();
    const positionScope = createBtcPositionScope();
    const sizing = evaluateTestExitSizing({
      requestedQuantity: "0.001",
      positionScope,
      policySnapshot: paperPolicy,
      currentPrice: "128000001",
      requestedPrice: "128000000",
    });

    const result = createExitSubmission({
      decision,
      sizing,
      positionScope,
      policySnapshot: paperPolicy,
      currentPrice: "128000001",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-validated-price-001",
      submittedAt: observedAt,
    });

    expect(result?.exitOrderIntent).toMatchObject({
      requestedPrice: "128000000",
      requestedNotional: "128000",
    });
  });

  it("rejects EXIT submission when executable quantity is only a partial position", async () => {
    const result = createExitSubmission({
      decision: await createTriggeredExitDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-partial-exit-001",
      submittedAt: observedAt,
    });

    expect(result).toBeNull();
  });

  it("creates EXIT submission when executable quantity closes the full position", async () => {
    const positionScope = createBtcPositionScope();
    const sizing = evaluateTestExitSizing({
      requestedQuantity: positionScope.totalQuantity,
      positionScope,
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
    });

    const result = createExitSubmission({
      decision: await createTriggeredExitDecision(),
      sizing,
      positionScope,
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-full-exit-001",
      submittedAt: observedAt,
    });

    expect(result?.exitOrderIntent).toMatchObject({
      requestedQuantity: positionScope.totalQuantity,
      metadata: {
        position_effect: "EXIT",
      },
    });
  });

  it("does not convert HOLD decisions or empty idempotency keys into SELL intents", async () => {
    const holdDecision = await evaluateExitRules([], createContext());
    const sizing = createValidExitSizing();

    expect(
      createExitSubmission({
        decision: holdDecision,
        sizing,
        positionScope: createBtcPositionScope(),
        policySnapshot: paperPolicy,
        currentPrice: "128000000",
        riskApproval: { source: "risk_gate", approved: true },
        idempotencyKey: "exit-hold-001",
        submittedAt: observedAt,
      }),
    ).toBeNull();

    const exitDecision = await createTriggeredExitDecision();
    expect(
      createExitSubmission({
        decision: exitDecision,
        sizing,
        positionScope: createBtcPositionScope(),
        policySnapshot: paperPolicy,
        currentPrice: "128000000",
        riskApproval: { source: "risk_gate", approved: true },
        idempotencyKey: "   ",
        submittedAt: observedAt,
      }),
    ).toBeNull();
  });

  it("creates deterministic remaining exit intents after cancel/requote", () => {
    const originalIntent = createExitIntentFixture();

    const first = createRemainingExitIntent(originalIntent, "0.0004", {
      lineageId: "paper-exit-order-1",
      requoteSequence: 1,
    });
    const second = createRemainingExitIntent(originalIntent, "0.0004", {
      lineageId: "paper-exit-order-1",
      requoteSequence: 1,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      requestedQuantity: "0.0004",
      requestedNotional: "51200",
      idempotencyKey: "exit-original-001-requote-paper-exit-order-1-1",
      metadata: {
        position_scope: {
          totalQuantity: "0.0004",
        },
        requote_parent_idempotency_key: "exit-original-001",
        requote_lineage_id: "paper-exit-order-1",
        requote_sequence: 1,
      },
    });
  });

  it("restores expected loss from RiskGate approval when runtime input omits it", async () => {
    const capturedSubmissions: OrderSubmission[] = [];
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => {
        capturedSubmissions.push(submission);
        return {
          status: "REJECTED" as const,
          submission,
          rejection: {
            reasonCode: "risk_approval_mismatch" as const,
            message: "captured by unit test",
          },
        };
      }),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };

    await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: {
        source: "risk_gate",
        approved: true,
        order_intent: {
          expected_loss_bps_of_equity: "5",
        },
      },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(capturedSubmissions[0]?.expectedLossBpsOfEquity).toBe("5");
  });

  it("submits exit order, cancels partial fill remainder, creates remaining intent, and appends evidence", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0",
      })),
    };
    const appendExitEvidence = vi.fn(async () => undefined);
    const persistPaperExecution = vi.fn(async () => undefined);

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        executionPersistence: { persistPaperExecution },
        evidenceWriter: { appendExitEvidence },
      },
    });

    expect(result.status).toBe("REMAINING_CANCEL_REQUOTE_CREATED");
    expect(executionEngine.submitOrder).toHaveBeenCalledTimes(1);
    expect(broker.cancelOrder).toHaveBeenCalledWith("paper-exit-order-1");
    expect(result.remainingIntent).toMatchObject({
      requestedQuantity: "0.0004",
      idempotencyKey: "exit-original-001-requote-paper-exit-order-1-1",
    });
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceKind: "PNL_STATUS_CONTEXT",
          payload: expect.objectContaining({
            remaining_position_quantity: "0.0044",
            position_closed: false,
          }),
        }),
        expect.objectContaining({
          evidenceKind: "EXECUTION_RESULT",
          payload: expect.objectContaining({
            execution_status: "CANCELED",
            cancel_requote_status: "open_remaining_canceled",
          }),
        }),
      ]),
    );
    expect(result.executionPersistenceStatus).toBe("RECORDED");
    expect(persistPaperExecution).toHaveBeenCalledWith({
      submission: result.submission,
      brokerOrder: expect.objectContaining({
        brokerOrderId: "paper-exit-order-1",
        status: "CANCELED",
        remainingQuantity: "0",
      }),
      correlationId: "paper-exit-order-1",
    });
    expect(result.evidenceWriteStatus).toBe("RECORDED");
    expect(appendExitEvidence).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ evidenceKind: "STRATEGY_DECISION" }),
        expect.objectContaining({ evidenceKind: "EXECUTION_RESULT" }),
        expect.objectContaining({ evidenceKind: "PNL_STATUS_CONTEXT" }),
      ]),
    );
  });

  it("dispatches live ops alerts for exit submit, partial fill, cancel request, and cancel confirmation", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0",
      })),
    };
    const alertRecorder = createAlertDispatchRecorder();

    await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        liveOpsAlerts: {
          environment: "prod",
          runMode: "live_autonomous_small_budget",
          alertDispatch: alertRecorder.alertDispatch,
        },
      },
    });

    expect(alertRecorder.alerts.map((alert) => alert.metadata?.event_kind)).toEqual([
      "ORDER_SUBMITTED",
      "ORDER_PARTIALLY_FILLED",
      "CANCEL_REQUESTED",
      "CANCEL_CONFIRMED",
    ]);
    expect(alertRecorder.alerts[1]).toMatchObject({
      title: "M23 live 운영 알림: 부분 체결",
      metadata: {
        event_kind: "ORDER_PARTIALLY_FILLED",
        filled_quantity: "0.0006",
        remaining_quantity: "0.0004",
        evidence_id: "exit-fill:paper-exit-order-1:PARTIALLY_FILLED:0.0006:0.0004",
      },
    });
    expect(alertRecorder.alerts[2]).toMatchObject({
      title: "M23 live 운영 알림: 취소 요청",
      metadata: {
        event_kind: "CANCEL_REQUESTED",
        broker_order_id: "paper-exit-order-1",
        safe_details: expect.objectContaining({
          source: "exit_paper_runtime",
          original_broker_order_id: "paper-exit-order-1",
        }),
      },
    });
    expect(alertRecorder.alerts[3]).toMatchObject({
      title: "M23 live 운영 알림: 취소 확인",
      metadata: {
        event_kind: "CANCEL_CONFIRMED",
        broker_order_id: "paper-exit-order-1",
        remaining_quantity: "0",
        evidence_id: "exit-cancel-confirmed:paper-exit-order-1",
        safe_details: expect.objectContaining({
          source: "exit_paper_runtime",
          original_broker_order_id: "paper-exit-order-1",
          cancel_result_status: "CANCELED",
        }),
      },
    });
  });

  it("treats broker-side rejected orders as unfilled execution failures", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "REJECTED",
      remainingQuantity: "0",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };
    const persistPaperExecution = vi.fn(async () => undefined);

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: evaluateTestExitSizing({
        requestedQuantity: "0.001",
        positionScope: createBtcPositionScope(),
        policySnapshot: paperPolicy,
        currentPrice: "10000000",
      }),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        executionPersistence: { persistPaperExecution },
      },
    });

    expect(result.status).toBe("EXECUTION_REJECTED");
    expect(result.executionPersistenceStatus).toBe("RECORDED");
    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(persistPaperExecution).toHaveBeenCalledWith({
      submission: result.submission,
      brokerOrder: expect.objectContaining({
        brokerOrderId: "paper-exit-order-1",
        status: "REJECTED",
      }),
      correlationId: "paper-exit-order-1",
    });
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceKind: "EXECUTION_RESULT",
          payload: expect.objectContaining({
            execution_status: "REJECTED",
            filled_quantity: "0",
            remaining_quantity: "0.001",
            new_entry_block_required: true,
            manual_review_required: true,
          }),
        }),
        expect.objectContaining({
          evidenceKind: "PNL_STATUS_CONTEXT",
          payload: expect.objectContaining({
            remaining_position_quantity: "0.005",
            position_closed: false,
          }),
        }),
        expect.objectContaining({
          reasonCode: "exit_broker_order_terminal_failure",
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
  });

  it("surfaces submission construction failures for triggered exits as manual review evidence", async () => {
    const executionEngine = {
      submitOrder: vi.fn(async () => {
        throw new Error("submit must not be called without an exit submission");
      }),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "   ",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("EXECUTION_REJECTED");
    expect(executionEngine.submitOrder).not.toHaveBeenCalled();
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "EXECUTION_REJECTED",
          reasonCode: "exit_submission_construction_failed",
          evidenceFingerprint: expect.stringContaining("missing-idempotency-key"),
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
  });

  it("converts broker submit exceptions into exit failure evidence", async () => {
    const executionEngine = {
      submitOrder: vi.fn(async () => {
        throw new Error("broker adapter unavailable");
      }),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };
    const appendExitEvidence = vi.fn(async () => undefined);

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        evidenceWriter: { appendExitEvidence },
      },
    });

    expect(result.status).toBe("EXECUTION_REJECTED");
    expect(result.submission).toBeDefined();
    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(result.evidenceWriteStatus).toBe("RECORDED");
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "EXECUTION_REJECTED",
          reasonCode: "exit_broker_submit_failed",
          evidenceFingerprint: expect.stringContaining("exit-original-001"),
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
    expect(appendExitEvidence).toHaveBeenCalledWith(result.evidenceItems);
  });

  it("cancels accepted but unfilled exit orders and creates remaining intent", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "ACCEPTED",
      remainingQuantity: "0.001",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0",
      })),
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("REMAINING_CANCEL_REQUOTE_CREATED");
    expect(broker.cancelOrder).toHaveBeenCalledWith("paper-exit-order-1");
    expect(result.remainingIntent).toMatchObject({
      requestedQuantity: "0.001",
      requestedNotional: "128000",
      idempotencyKey: "exit-original-001-requote-paper-exit-order-1-1",
    });
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceKind: "EXECUTION_RESULT",
          payload: expect.objectContaining({
            execution_status: "OPEN",
            open_order_remaining_action: "cancel_or_requote_required",
          }),
        }),
        expect.objectContaining({
          evidenceKind: "PNL_STATUS_CONTEXT",
          payload: expect.objectContaining({
            remaining_position_quantity: "0.005",
            position_closed: false,
          }),
        }),
        expect.objectContaining({
          evidenceKind: "EXECUTION_RESULT",
          payload: expect.objectContaining({
            execution_status: "CANCELED",
            cancel_requote_status: "open_remaining_canceled",
          }),
        }),
      ]),
    );
  });

  it("normalizes canceled broker remaining quantity before deciding cancel failure", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0.00000000",
      })),
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("REMAINING_CANCEL_REQUOTE_CREATED");
    expect(result.remainingIntent).toMatchObject({
      requestedQuantity: "0.0004",
    });
    expect(result.evidenceItems).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "exit_remaining_cancel_open",
        }),
      ]),
    );
  });

  it("scopes manual-review evidence fingerprints by broker event", async () => {
    const runCancelFailure = async (brokerOrderId: string) => {
      const brokerOrder = createBrokerOrderFixture({
        brokerOrderId,
        status: "PARTIALLY_FILLED",
        remainingQuantity: "0.0004",
      });
      const executionEngine = {
        submitOrder: vi.fn(async (submission: OrderSubmission) => ({
          status: "SUBMITTED" as const,
          submission,
          brokerOrder,
        })),
      };
      const broker = {
        cancelOrder: vi.fn(async () => {
          throw new Error("cancel unavailable");
        }),
      };

      return runExitPaperRuntime({
        decision: await createTriggeredReduceDecision(),
        sizing: createValidExitSizing(),
        positionScope: createBtcPositionScope(),
        policySnapshot: paperPolicy,
        currentPrice: "128000000",
        riskApproval: { source: "risk_gate", approved: true },
        idempotencyKey: "exit-original-001",
        submittedAt: observedAt,
        ports: {
          executionEngine,
          broker,
        },
      });
    };

    const first = await runCancelFailure("paper-exit-order-1");
    const second = await runCancelFailure("paper-exit-order-2");
    const firstFailure = first.evidenceItems.find((item) => item.reasonCode === "exit_remaining_cancel_failed");
    const secondFailure = second.evidenceItems.find((item) => item.reasonCode === "exit_remaining_cancel_failed");

    expect(firstFailure?.evidenceFingerprint).toContain("paper-exit-order-1");
    expect(secondFailure?.evidenceFingerprint).toContain("paper-exit-order-2");
    expect(firstFailure?.evidenceFingerprint).not.toBe(secondFailure?.evidenceFingerprint);
  });

  it("uses policy dust threshold to close partial fill remainder without creating a new intent", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0",
      })),
    };
    const appendExitEvidence = vi.fn(async () => undefined);

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: {
        ...paperPolicy,
        dustThreshold: "0.0005",
      },
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        evidenceWriter: { appendExitEvidence },
      },
    });

    expect(result.status).toBe("EXECUTION_SUBMITTED");
    expect(result.remainingIntent).toBeUndefined();
    expect(broker.cancelOrder).toHaveBeenCalledWith("paper-exit-order-1");
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "exit_remaining_dust_closed",
          payload: expect.objectContaining({
            remaining_quantity: "0.0004",
            canceled_quantity: "0.0004",
            broker_remaining_quantity_after_cancel: "0",
            dust_threshold: "0.0005",
            remaining_exit_intent_created: false,
            cancel_requote_status: "dust_remaining_canceled",
          }),
        }),
      ]),
    );
    expect(appendExitEvidence).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "exit_remaining_dust_closed",
        }),
      ]),
    );
  });

  it("does not create remaining intent when requote notional is below minimum order notional", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
      requestedPrice: "10000000",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async (orderId: string) => createBrokerOrderFixture({
        brokerOrderId: orderId,
        status: "CANCELED",
        remainingQuantity: "0",
        requestedPrice: "10000000",
      })),
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: evaluateTestExitSizing({
        requestedQuantity: "0.001",
        positionScope: createBtcPositionScope(),
        policySnapshot: paperPolicy,
        currentPrice: "10000000",
      }),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "10000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("EXECUTION_SUBMITTED");
    expect(result.remainingIntent).toBeUndefined();
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasonCode: "exit_remaining_below_min_notional_closed",
          payload: expect.objectContaining({
            remaining_quantity: "0.0004",
            broker_remaining_quantity_after_cancel: "0",
            remaining_notional: "4000",
            min_order_notional: "5000",
            remaining_exit_intent_created: false,
            cancel_requote_status: "remaining_below_min_order_notional",
          }),
        }),
      ]),
    );
  });

  it("surfaces invalid exit sizing as manual review evidence instead of no-op exit", async () => {
    const executionEngine = {
      submitOrder: vi.fn(async () => {
        throw new Error("submit must not be called for invalid sizing");
      }),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };
    const invalidSizing: ExitSizing = {
      ...createValidExitSizing(),
      executableQuantity: "0",
      belowMinOrderNotional: true,
      belowMinOrderReason: "청산 주문 예상 금액이 최소 주문금액 미만입니다.",
      valid: false,
      rejectionReason: "below_min_order_notional",
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: invalidSizing,
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("EXECUTION_REJECTED");
    expect(executionEngine.submitOrder).not.toHaveBeenCalled();
    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "EXECUTION_REJECTED",
          reasonCode: "below_min_order_notional",
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
  });

  it("converges remaining cancel failure to manual review evidence without retrying submit", async () => {
    const brokerOrder = createBrokerOrderFixture({
      status: "PARTIALLY_FILLED",
      remainingQuantity: "0.0004",
    });
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(async () => createBrokerOrderFixture({
        status: "PARTIALLY_FILLED",
        remainingQuantity: "0.0004",
      })),
    };

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
      },
    });

    expect(result.status).toBe("REMAINING_CANCEL_FAILED");
    expect(executionEngine.submitOrder).toHaveBeenCalledTimes(1);
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "EXECUTION_REJECTED",
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
  });

  it("reports persistence failure as manual review evidence without retrying broker submit", async () => {
    const brokerOrder = createBrokerOrderFixture();
    const executionEngine = {
      submitOrder: vi.fn(async (submission: OrderSubmission) => ({
        status: "SUBMITTED" as const,
        submission,
        brokerOrder,
      })),
    };
    const broker = {
      cancelOrder: vi.fn(),
    };
    const persistPaperExecution = vi.fn(async () => {
      throw new Error("db unavailable");
    });

    const result = await runExitPaperRuntime({
      decision: await createTriggeredReduceDecision(),
      sizing: createValidExitSizing(),
      positionScope: createBtcPositionScope(),
      policySnapshot: paperPolicy,
      currentPrice: "128000000",
      riskApproval: { source: "risk_gate", approved: true },
      idempotencyKey: "exit-original-001",
      submittedAt: observedAt,
      ports: {
        executionEngine,
        broker,
        executionPersistence: { persistPaperExecution },
      },
    });

    expect(result.status).toBe("EXECUTION_SUBMITTED");
    expect(result.executionPersistenceStatus).toBe("UNAVAILABLE");
    expect(executionEngine.submitOrder).toHaveBeenCalledTimes(1);
    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(result.evidenceItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "EXECUTION_REJECTED",
          reasonCode: "exit_execution_persistence_unavailable",
          payload: expect.objectContaining({
            new_orders_blocked: true,
            manual_review_required: true,
          }),
        }),
      ]),
    );
  });
});

async function createTriggeredExitDecision(): Promise<ExitDecision> {
  return evaluateExitRules(
    [createTakeProfitExitRule({ takeProfitBps: "2000" })],
    createContext({ position: btcPosition }),
  );
}

async function createTriggeredReduceDecision(): Promise<ExitDecision> {
  return evaluateExitRules(
    [createRiskReductionExitRule()],
    createContext({
      position: btcPosition,
      riskReductionSignal: createRiskReductionSignal({
        intention: "REDUCE",
        reductionRatio: "0.2",
      }),
    }),
  );
}

function createBtcPositionScope(): ExitPositionScope {
  return {
    market: "KRW-BTC",
    strategyId: "trend_following",
    totalQuantity: "0.005",
    observedAt,
  };
}

function createValidExitSizing(): ExitSizing {
  return evaluateTestExitSizing({
    requestedQuantity: "0.001",
    positionScope: createBtcPositionScope(),
    policySnapshot: paperPolicy,
    currentPrice: "128000000",
  });
}

function createExitIntentFixture(): ExitOrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "SELL",
    orderType: "LIMIT",
    requestedQuantity: "0.001",
    requestedNotional: "128000",
    idempotencyKey: "exit-original-001",
    reason: "익절 조건 충족",
    requestedPrice: "128000000",
    timeInForce: "GTC",
    metadata: {
      position_effect: "EXIT",
      exit_reason_code: "take_profit_triggered",
      exit_rule_id: "take_profit_exit",
      position_scope: createBtcPositionScope(),
    },
  };
}

function createAlertDispatchRecorder(): {
  alertDispatch: AlertDispatchServiceOptions;
  alerts: AlertNotification[];
} {
  const alerts: AlertNotification[] = [];
  const notifier: NotifierPort = {
    async sendAlert(notification) {
      alerts.push(notification);
      return {
        delivered: true,
        providerMessageId: `telegram-${alerts.length}`,
      };
    },
    async sendDailyReport(_notification: DailyReportNotification): Promise<NotificationResult> {
      return {
        delivered: true,
        providerMessageId: "daily-report-1",
      };
    },
  };

  return {
    alerts,
    alertDispatch: {
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
      memoryCooldownStore: createInMemoryAlertCooldownStore(),
      clock: () => observedAt,
    },
  };
}

function createBrokerOrderFixture(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    brokerOrderId: "paper-exit-order-1",
    idempotencyKey: "exit-original-001",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "SELL",
    orderType: "LIMIT",
    status: "FILLED",
    requestedQuantity: "0.001",
    remainingQuantity: "0",
    requestedPrice: "128000000",
    updatedAt: observedAt,
    ...overrides,
  };
}
