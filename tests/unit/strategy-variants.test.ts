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
  },
  meanReversion: {
    maxSpreadBps: "6",
    minDepthKrw: "70000000",
    entryDeviationBps: "25",
    exitDeviationBps: "8",
    stopLossBps: "35",
  },
  volatilityBreakout: {
    maxSpreadBps: "8",
    minDepthKrw: "50000000",
    breakoutLookbackBuckets: 20,
    minVolatilityExpansionBps: "18",
  },
  orderbookImbalanceMomentum: {
    maxSpreadBps: "7",
    minDepthKrw: "60000000",
    minTradeStrength: "1.25",
    minOrderbookImbalance: "0.1",
  },
  liquidityReversion: {
    maxSpreadBps: "5",
    minDepthKrw: "90000000",
    entryDeviationBps: "18",
    stopLossBps: "30",
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

  it("creates centered LIMIT order intents from each strategy signal", async () => {
    const cases: readonly [Strategy, Partial<StrategyContext>][] = [
      [
        createTrendFollowingStrategy(variantOptions.trendFollowing),
        {
          strategyId: "trend_following",
          features: {
            trade_strength: "1.4",
            orderbook_imbalance: "0.12",
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
