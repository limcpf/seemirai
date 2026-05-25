import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertStrategyDecisionToOrderIntents,
  createLiquidityReversionStrategy,
  createM4StrategyVariants,
  createMeanReversionStrategy,
  createOrderbookImbalanceMomentumStrategy,
  createTrendFollowingStrategy,
  createVolatilityBreakoutStrategy,
} from "../../src/application/index.js";
import type {
  LiquidityReversionStrategyOptions,
  M4StrategyVariantOptions,
  MeanReversionStrategyOptions,
  OrderbookImbalanceMomentumStrategyOptions,
  TrendFollowingStrategyOptions,
  VolatilityBreakoutStrategyOptions,
} from "../../src/application/index.js";
import type { OrderIntent, Strategy, StrategyContext, StrategyDecision } from "../../src/domain/index.js";

const observedAt = new Date("2026-05-16T00:00:00.000Z");

const variantOptions: M4StrategyVariantOptions = {
  trendFollowing: {
    maxSpreadBps: "8",
    minDepthKrw: "50000000",
    breakoutLookbackBuckets: 20,
    minTradeStrength: "1.2",
    minOrderbookImbalance: "0.08",
    minVolatilityExpansionBps: "18",
    minCandleMomentumBps: "0",
    minRealizedVolatilityBps: "0",
    maxRealizedVolatilityBps: "100000",
    minVolumeSpikeRatio: "0",
    minTradeDirectionImbalance: "0",
    allowedMarketRegimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
    minCostAdjustedMarginBps: "0",
  },
  meanReversion: {
    maxSpreadBps: "6",
    minDepthKrw: "70000000",
    entryDeviationBps: "25",
    exitDeviationBps: "8",
    stopLossBps: "35",
    minRealizedVolatilityBps: "0",
    maxRealizedVolatilityBps: "100000",
    minAbsVwapDeviationBps: "0",
    minSessionLiquidityScore: "0",
    allowedMarketRegimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
    minCostAdjustedMarginBps: "0",
  },
  volatilityBreakout: {
    maxSpreadBps: "8",
    minDepthKrw: "50000000",
    breakoutLookbackBuckets: 20,
    minVolatilityExpansionBps: "18",
    minCandleMomentumBps: "0",
    minRealizedVolatilityBps: "0",
    maxRealizedVolatilityBps: "100000",
    minVolumeSpikeRatio: "0",
    allowedMarketRegimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
    minCostAdjustedMarginBps: "0",
  },
  orderbookImbalanceMomentum: {
    maxSpreadBps: "7",
    minDepthKrw: "60000000",
    minTradeStrength: "1.25",
    minOrderbookImbalance: "0.1",
    minDepthSlopeKrwPerBps: "0",
    minDepthChangeRateRatio: "-1",
    minTradeDirectionImbalance: "0",
    minCostAdjustedMarginBps: "0",
  },
  liquidityReversion: {
    maxSpreadBps: "5",
    minDepthKrw: "90000000",
    entryDeviationBps: "18",
    stopLossBps: "30",
    minDepthChangeRateRatio: "-1",
    minAbsVwapDeviationBps: "0",
    minSessionLiquidityScore: "0",
    minCostAdjustedMarginBps: "0",
  },
};

describe("strategy variants", () => {
  it("creates the five MVP strategy variants", () => {
    const strategies = createM4StrategyVariants(variantOptions);

    expect(strategies.map((strategy) => strategy.id)).toEqual([
      "trend_following",
      "mean_reversion",
      "volatility_breakout",
      "orderbook_imbalance_momentum",
      "liquidity_reversion",
    ]);
    expect(strategies.every((strategy) => strategy.requiredFeatures.length > 0)).toBe(true);
  });

  it("keeps strategy implementations independent from broker, Upbit, and database modules", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "application", "strategies", "strategy-variants.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from\s+["'][^"']*(broker|upbit|db|database)/iu);
    expect(source).not.toMatch(/\b(BrokerPort|submitOrder|Upbit|Kysely)\b/u);
  });

  it("does not create order intents from LLM-only context", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        metadata: {
          source: "llm",
        },
        features: {
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "llm_only_not_allowed",
    });
  });

  it("returns explicit BLOCK when a required feature is missing", async () => {
    const strategy = createVolatilityBreakoutStrategy(variantOptions.volatilityBreakout);
    const decision = await evaluate(
      strategy,
      contextFor("volatility_breakout", {
        features: {
          breakout_direction: "UP",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "feature_missing_volatility_expansion_bps",
    });
  });

  it("fails closed when an M11 required strategy feature is missing", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          cost_adjusted_margin_bps: undefined,
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_direction: "UP",
          breakout_lookback_buckets: "20",
          volatility_expansion_bps: "20",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "feature_missing_cost_adjusted_margin_bps",
      metadata: {
        feature_key: "cost_adjusted_margin_bps",
        reason_family: "feature_missing",
      },
    });
  });

  it("keeps strategy candidates on HOLD when M11 cost-adjusted margin is below threshold", async () => {
    const strategy = createTrendFollowingStrategy({
      ...variantOptions.trendFollowing,
      minCostAdjustedMarginBps: "5",
    });
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          cost_adjusted_margin_bps: "4",
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_direction: "UP",
          breakout_lookback_buckets: "20",
          volatility_expansion_bps: "20",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "HOLD",
      reason: "cost_adjusted_margin_below_threshold",
      metadata: {
        cost_adjusted_margin_bps: "4",
        min_cost_adjusted_margin_bps: "5",
      },
    });
  });

  it("creates centered LIMIT order intents from each strategy signal", async () => {
    const cases: readonly [Strategy, Partial<StrategyContext>][] = [
      [
        createTrendFollowingStrategy(variantOptions.trendFollowing),
        {
          strategyId: "trend_following",
          features: {
            trade_strength: "1.4",
            orderbook_imbalance: "0.12",
            breakout_direction: "UP",
            breakout_lookback_buckets: "20",
            volatility_expansion_bps: "20",
          },
        },
      ],
      [
        createMeanReversionStrategy(variantOptions.meanReversion),
        {
          strategyId: "mean_reversion",
          features: {
            spread_bps: "3",
            depth_krw: "80000000",
            mean_reversion_deviation_bps: "-30",
          },
        },
      ],
      [
        createVolatilityBreakoutStrategy(variantOptions.volatilityBreakout),
        {
          strategyId: "volatility_breakout",
          features: {
            volatility_expansion_bps: "20",
            breakout_direction: "UP",
            breakout_lookback_buckets: "20",
          },
        },
      ],
      [
        createOrderbookImbalanceMomentumStrategy(variantOptions.orderbookImbalanceMomentum),
        {
          strategyId: "orderbook_imbalance_momentum",
          features: {
            trade_strength: "1.3",
            orderbook_imbalance: "-0.12",
          },
        },
      ],
      [
        createLiquidityReversionStrategy(variantOptions.liquidityReversion),
        {
          strategyId: "liquidity_reversion",
          features: {
            spread_bps: "3",
            depth_krw: "100000000",
            liquidity_reversion_bps: "-20",
          },
        },
      ],
    ];

    for (const [strategy, context] of cases) {
      const decision = await evaluate(strategy, contextFor(strategy.id, context));

      expect(decision.kind).toBe("ORDER_INTENT");
      expect(decision).toMatchObject({
        orderIntents: [
          {
            orderType: "LIMIT",
            requestedPrice: "10000000",
            postOnly: true,
            timeInForce: "GTC",
          },
        ],
      });
      expect(decision.kind === "ORDER_INTENT" ? decision.orderIntents[0]?.idempotencyKey : "").toContain(
        `${strategy.id}:upbit_krw_spot:KRW-BTC:`,
      );
    }
  });

  it("keeps trend following on HOLD without breakout direction evidence", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_lookback_buckets: "20",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "HOLD",
      reason: "breakout_direction_absent",
    });
  });

  it("keeps short trend breakout lookback evidence on HOLD", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_direction: "UP",
          breakout_lookback_buckets: "5",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "HOLD",
      reason: "breakout_lookback_below_threshold",
    });
  });

  it("keeps short volatility breakout lookback evidence on HOLD", async () => {
    const strategy = createVolatilityBreakoutStrategy(variantOptions.volatilityBreakout);
    const decision = await evaluate(
      strategy,
      contextFor("volatility_breakout", {
        features: {
          volatility_expansion_bps: "20",
          breakout_direction: "UP",
          breakout_lookback_buckets: "5",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "HOLD",
      reason: "breakout_lookback_below_threshold",
    });
  });

  it("keeps trend following on HOLD when volatility expansion is weak", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_direction: "UP",
          breakout_lookback_buckets: "20",
          volatility_expansion_bps: "10",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "HOLD",
      reason: "volatility_expansion_below_threshold",
      metadata: {
        min_volatility_expansion_bps: "18",
        volatility_expansion_bps: "10",
      },
    });
  });

  it("blocks negative spread feature snapshots before signal evaluation", async () => {
    const strategy = createTrendFollowingStrategy(variantOptions.trendFollowing);
    const decision = await evaluate(
      strategy,
      contextFor("trend_following", {
        features: {
          spread_bps: "-1",
          trade_strength: "1.4",
          orderbook_imbalance: "0.12",
          breakout_direction: "UP",
          breakout_lookback_buckets: "20",
          volatility_expansion_bps: "20",
        },
      }),
    );

    expect(decision).toMatchObject({
      kind: "BLOCK",
      reasonCode: "spread_negative",
    });
  });

  it("keeps neutral zero signed signals on HOLD even when the imbalance threshold is zero", async () => {
    const trend = createTrendFollowingStrategy({
      ...variantOptions.trendFollowing,
      minOrderbookImbalance: "0",
    });
    const momentum = createOrderbookImbalanceMomentumStrategy({
      ...variantOptions.orderbookImbalanceMomentum,
      minOrderbookImbalance: "0",
    });

    await expect(
      evaluate(
        trend,
        contextFor("trend_following", {
          features: {
            trade_strength: "1.4",
            orderbook_imbalance: "0",
            breakout_direction: "UP",
            breakout_lookback_buckets: "20",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "orderbook_imbalance_below_threshold",
    });
    await expect(
      evaluate(
        momentum,
        contextFor("orderbook_imbalance_momentum", {
          features: {
            trade_strength: "1.4",
            orderbook_imbalance: "0",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "orderbook_imbalance_below_threshold",
    });
  });

  it("keeps zero trade strength on HOLD even when the strength threshold is zero", async () => {
    const trend = createTrendFollowingStrategy({
      ...variantOptions.trendFollowing,
      minTradeStrength: "0",
    });
    const momentum = createOrderbookImbalanceMomentumStrategy({
      ...variantOptions.orderbookImbalanceMomentum,
      minTradeStrength: "0",
    });

    await expect(
      evaluate(
        trend,
        contextFor("trend_following", {
          features: {
            trade_strength: "0",
            orderbook_imbalance: "0.12",
            breakout_direction: "UP",
            breakout_lookback_buckets: "20",
            volatility_expansion_bps: "20",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "trade_strength_below_threshold",
    });
    await expect(
      evaluate(
        momentum,
        contextFor("orderbook_imbalance_momentum", {
          features: {
            trade_strength: "0",
            orderbook_imbalance: "0.12",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "trade_strength_below_threshold",
    });
  });

  it("keeps neutral zero reversion signals on HOLD even when entry thresholds are zero", async () => {
    const meanReversion = createMeanReversionStrategy({
      ...variantOptions.meanReversion,
      entryDeviationBps: "0",
    });
    const liquidityReversion = createLiquidityReversionStrategy({
      ...variantOptions.liquidityReversion,
      entryDeviationBps: "0",
    });

    await expect(
      evaluate(
        meanReversion,
        contextFor("mean_reversion", {
          features: {
            spread_bps: "3",
            depth_krw: "80000000",
            mean_reversion_deviation_bps: "0",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "mean_reversion_deviation_below_threshold",
    });
    await expect(
      evaluate(
        liquidityReversion,
        contextFor("liquidity_reversion", {
          features: {
            spread_bps: "3",
            depth_krw: "100000000",
            liquidity_reversion_bps: "0",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "liquidity_reversion_below_threshold",
    });
  });

  it("uses the mean reversion exit threshold for SELL candidates", async () => {
    const strategy = createMeanReversionStrategy(variantOptions.meanReversion);

    await expect(
      evaluate(
        strategy,
        contextFor("mean_reversion", {
          features: {
            spread_bps: "3",
            depth_krw: "80000000",
            mean_reversion_deviation_bps: "9",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "ORDER_INTENT",
      orderIntents: [
        {
          side: "SELL",
        },
      ],
    });
    await expect(
      evaluate(
        strategy,
        contextFor("mean_reversion", {
          features: {
            spread_bps: "3",
            depth_krw: "80000000",
            mean_reversion_deviation_bps: "7",
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: "HOLD",
      reason: "mean_reversion_deviation_below_threshold",
    });
  });
});

describe("strategy decision to order intents", () => {
  it("promotes validated LIMIT intents and attaches audit metadata", () => {
    const decision: StrategyDecision = {
      kind: "ORDER_INTENT",
      strategyId: "trend_following",
      reason: "fixture_signal",
      metadata: {
        signal: "fixture",
      },
      orderIntents: [limitIntent()],
    };

    const result = convertStrategyDecisionToOrderIntents(decision, {
      metadata: {
        rule_chain_id: "fixture-rules",
      },
    });

    expect(result).toMatchObject({
      status: "PROMOTED",
      reasonCode: "order_intent_promoted",
      orderIntents: [
        {
          metadata: {
            signal: "fixture",
            rule_chain_id: "fixture-rules",
            strategy_decision_kind: "ORDER_INTENT",
            strategy_decision_reason: "fixture_signal",
          },
        },
      ],
    });
  });

  it("rejects market orders by default", () => {
    const result = convertStrategyDecisionToOrderIntents({
      kind: "ORDER_INTENT",
      strategyId: "trend_following",
      reason: "fixture_signal",
      orderIntents: [
        {
          exchangeId: "upbit_krw_spot",
          market: "KRW-BTC",
          strategyId: "trend_following",
          side: "BUY",
          orderType: "MARKET",
          requestedQuantity: "0.001",
          requestedNotional: "10000",
          idempotencyKey: "market-order-fixture",
          reason: "fixture",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "REJECTED",
      reasonCode: "order_intent_validation_failed",
      rejections: [
        {
          reasonCode: "market_order_disabled",
        },
      ],
    });
  });

  it("rejects missing idempotency key and non-positive financial fields", () => {
    const result = convertStrategyDecisionToOrderIntents({
      kind: "ORDER_INTENT",
      strategyId: "trend_following",
      reason: "fixture_signal",
      orderIntents: [
        limitIntent({
          idempotencyKey: "",
          requestedQuantity: "0",
          requestedNotional: "-1",
          requestedPrice: "0",
        }),
      ],
    });

    expect(result.status).toBe("REJECTED");
    expect(result.rejections.map((rejection) => rejection.reasonCode)).toEqual([
      "idempotency_key_missing",
      "requested_quantity_invalid",
      "requested_notional_invalid",
      "requested_price_invalid",
    ]);
  });
});

async function evaluate(strategy: Strategy, context: StrategyContext): Promise<StrategyDecision> {
  return Promise.resolve(strategy.evaluate(context));
}

function contextFor(
  strategyId: string,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    strategyId,
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    observedAt,
    marketEvents: [],
    features: {
      spread_bps: "2",
      depth_krw: "100000000",
      candle_momentum_bps: "30",
      realized_volatility_bps: "20",
      volume_spike_ratio: "1",
      bid_depth_slope_krw_per_bps: "1",
      ask_depth_slope_krw_per_bps: "1",
      depth_change_rate_ratio: "0",
      vwap_deviation_bps: "0",
      trade_direction_imbalance_ratio: "0.2",
      market_regime: "trend_up",
      session_liquidity_score: "1",
      cost_adjusted_margin_bps: "10",
      limit_price: "10000000",
      requested_quantity: "0.001",
      requested_notional: "10000",
      ...overrides.features,
    },
    ...(overrides.positions === undefined ? {} : { positions: overrides.positions }),
    ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
  };
}

function limitIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.001",
    requestedNotional: "10000",
    requestedPrice: "10000000",
    idempotencyKey: "limit-order-fixture",
    reason: "fixture",
    ...overrides,
  } as OrderIntent;
}
