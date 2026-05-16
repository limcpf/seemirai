import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exchangeRegistry,
  registeredRuleIds,
  registeredStrategyIds,
  ruleRegistry,
  strategyRegistry,
} from "../../src/application/index.js";
import type { BrokerPort, MarketDataPort } from "../../src/application/index.js";
import type { OrderIntent, OrderSubmission, Rule, Strategy } from "../../src/domain/index.js";
import {
  RegistryActivationConfigSchema,
  defaultRegistryActivationConfig,
  resolveRegistryActivationConfig,
} from "../../src/runtime/index.js";
import { loadDefaultRuntimeConfig } from "../../src/runtime/index.js";

describe("registry foundation", () => {
  it("contains the MVP exchange, strategy, and rule ids", () => {
    expect(exchangeRegistry.upbit_krw_spot.id).toBe("upbit_krw_spot");
    expect(registeredStrategyIds).toEqual(["trend_following", "mean_reversion"]);
    expect(registeredRuleIds).toEqual([
      "universe_allowed",
      "market_warning_absent",
      "spread_ok",
      "depth_sufficient",
      "cost_margin_ok",
      "risk_ok",
      "stop_loss",
      "take_profit",
    ]);
    expect(strategyRegistry.trend_following.requiredFeatures.length).toBeGreaterThan(0);
    expect(ruleRegistry.risk_ok.defaultSeverity).toBe("BLOCKING");
  });

  it("resolves the default registry activation config", () => {
    const resolution = resolveRegistryActivationConfig(defaultRegistryActivationConfig);

    expect(resolution.exchange.id).toBe("upbit_krw_spot");
    expect(resolution.activeStrategies.map((entry) => entry.strategy.id)).toEqual([
      "trend_following",
      "mean_reversion",
    ]);
    expect(resolution.activeStrategies.every((entry) => entry.rules.length > 0)).toBe(true);
  });

  it("rejects unknown exchange ids", () => {
    expect(() =>
      RegistryActivationConfigSchema.parse({
        ...defaultRegistryActivationConfig,
        exchangeId: "binance_spot",
      }),
    ).toThrow();
  });

  it("rejects unknown strategy ids", () => {
    expect(() =>
      RegistryActivationConfigSchema.parse({
        exchangeId: "upbit_krw_spot",
        strategies: [
          {
            id: "scalping",
            enabled: true,
            ruleIds: ["risk_ok"],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects unknown rule ids", () => {
    expect(() =>
      RegistryActivationConfigSchema.parse({
        exchangeId: "upbit_krw_spot",
        strategies: [
          {
            id: "trend_following",
            enabled: true,
            ruleIds: ["risk_ok", "unknown_rule"],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects empty rule compositions", () => {
    expect(() =>
      RegistryActivationConfigSchema.parse({
        exchangeId: "upbit_krw_spot",
        strategies: [
          {
            id: "trend_following",
            enabled: true,
            ruleIds: [],
          },
        ],
      }),
    ).toThrow("strategy rule composition must not be empty");
  });

  it("excludes disabled strategies from active resolution", () => {
    const resolution = resolveRegistryActivationConfig({
      exchangeId: "upbit_krw_spot",
      strategies: [
        {
          id: "trend_following",
          enabled: false,
          ruleIds: ["risk_ok"],
        },
        {
          id: "mean_reversion",
          enabled: true,
          ruleIds: ["risk_ok"],
        },
      ],
    });

    expect(resolution.activeStrategies.map((entry) => entry.strategy.id)).toEqual(["mean_reversion"]);
  });

  it("loads registry activation through the default paper runtime config", async () => {
    const config = await loadDefaultRuntimeConfig();

    expect(config.registry.exchangeId).toBe("upbit_krw_spot");
    expect(config.registry.strategies.map((strategy) => strategy.id)).toEqual([
      "trend_following",
      "mean_reversion",
    ]);
  });
});

describe("strategy and rule contracts", () => {
  it("keeps strategies limited to decisions and order intent candidates", async () => {
    const strategy: Strategy = {
      id: "trend_following",
      version: "0.1.0",
      requiredFeatures: ["spread_bps"],
      evaluate: () => ({
        kind: "ORDER_INTENT",
        strategyId: "trend_following",
        reason: "fixture decision",
        orderIntents: [
          {
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            strategyId: "trend_following",
            side: "BUY",
            orderType: "LIMIT",
            requestedQuantity: "0.001",
            requestedNotional: "10000",
            requestedPrice: "10000000",
            idempotencyKey: "strategy-fixture-1",
            reason: "fixture intent",
          },
        ],
      }),
    };

    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      observedAt: new Date("2026-05-16T00:00:00.000Z"),
      marketEvents: [],
      features: {
        spread_bps: "1",
      },
    });

    expect(decision.kind).toBe("ORDER_INTENT");
    expect("submitOrder" in strategy).toBe(false);
  });

  it("represents rule PASS, FAIL, and WARN results with reasons", async () => {
    const results = ["PASS", "FAIL", "WARN"] as const;

    for (const status of results) {
      const rule: Rule = {
        id: `fixture_${status.toLowerCase()}`,
        evaluate: () => ({
          status,
          reasonCode: `fixture_${status.toLowerCase()}`,
          message: "fixture rule result",
        }),
      };

      await expect(
        Promise.resolve(
          rule.evaluate({
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            observedAt: new Date("2026-05-16T00:00:00.000Z"),
          }),
        ),
      ).resolves.toMatchObject({
        status,
        reasonCode: `fixture_${status.toLowerCase()}`,
      });
    }
  });

  it("keeps the strategy contract independent from broker and Upbit implementations", async () => {
    const strategyContract = await readFile(
      path.join(process.cwd(), "src", "domain", "strategy.ts"),
      "utf8",
    );

    expect(strategyContract).not.toMatch(/from\s+["'][^"']*(broker|upbit)/iu);
    expect(strategyContract).not.toMatch(/\b(BrokerPort|submitOrder|cancelOrder|Upbit)\b/u);
  });

  it("requires validated broker submission evidence and exposes snapshot ports", async () => {
    const observedAt = new Date("2026-05-16T00:00:00.000Z");
    const intent: OrderIntent = {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "BUY",
      orderType: "LIMIT",
      requestedQuantity: "0.001",
      requestedNotional: "10000",
      requestedPrice: "10000000",
      idempotencyKey: "validated-submission-fixture-1",
      reason: "fixture intent",
    };
    const submission: OrderSubmission = {
      intent,
      costSnapshot: {
        cost_bps: "5",
      },
      riskApproval: {
        approved: true,
      },
      submittedAt: observedAt,
    };

    const broker: BrokerPort = {
      submitOrder: async (order) => {
        const brokerOrder = {
          brokerOrderId: "paper-order-1",
          idempotencyKey: order.intent.idempotencyKey,
          exchangeId: order.intent.exchangeId,
          market: order.intent.market,
          side: order.intent.side,
          orderType: order.intent.orderType,
          status: "SUBMITTED" as const,
          requestedQuantity: order.intent.requestedQuantity,
          remainingQuantity: order.intent.requestedQuantity,
          updatedAt: observedAt,
        };

        if (order.intent.orderType === "LIMIT") {
          return {
            ...brokerOrder,
            requestedPrice: order.intent.requestedPrice,
          };
        }

        return brokerOrder;
      },
      cancelOrder: async (orderId) => ({
        brokerOrderId: orderId,
        idempotencyKey: "validated-submission-fixture-1",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        status: "CANCELED",
        requestedQuantity: "0.001",
        remainingQuantity: "0",
        requestedPrice: "10000000",
        updatedAt: observedAt,
      }),
      getOrder: async () => undefined,
      listOpenOrders: async () => [],
      getBalances: async () => ({
        exchangeId: "upbit_krw_spot",
        balances: [
          {
            currency: "KRW",
            available: "1000000",
            locked: "0",
            total: "1000000",
            updatedAt: observedAt,
          },
        ],
        capturedAt: observedAt,
      }),
    };
    const marketData: MarketDataPort = {
      streamTrades: async function* streamTrades() {
        return;
      },
      streamOrderbook: async function* streamOrderbook() {
        return;
      },
      getOrderbook: async (market) => ({
        type: "ORDERBOOK",
        exchangeId: "upbit_krw_spot",
        market,
        asks: [],
        bids: [],
        exchangeTimestamp: observedAt,
        receivedAt: observedAt,
      }),
      getTicker: async (market) => ({
        exchangeId: "upbit_krw_spot",
        market,
        tradePrice: "10000000",
        exchangeTimestamp: observedAt,
        receivedAt: observedAt,
      }),
    };

    await expect(broker.submitOrder(submission)).resolves.toMatchObject({
      idempotencyKey: "validated-submission-fixture-1",
      requestedPrice: "10000000",
    });
    await expect(broker.getBalances()).resolves.toMatchObject({
      exchangeId: "upbit_krw_spot",
    });
    await expect(marketData.getOrderbook("KRW-BTC")).resolves.toMatchObject({
      type: "ORDERBOOK",
      market: "KRW-BTC",
    });
  });
});

// @ts-expect-error LIMIT intent는 requestedPrice가 필수다.
const invalidLimitIntent: OrderIntent = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  strategyId: "trend_following",
  side: "BUY",
  orderType: "LIMIT",
  requestedQuantity: "0.001",
  requestedNotional: "10000",
  idempotencyKey: "invalid-limit-intent",
  reason: "invalid fixture",
};

void invalidLimitIntent;

// @ts-expect-error broker 제출 요청은 비용 snapshot과 risk 승인 근거가 필수다.
const invalidSubmission: OrderSubmission = {
  intent: {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.001",
    requestedNotional: "10000",
    requestedPrice: "10000000",
    idempotencyKey: "invalid-submission",
    reason: "invalid fixture",
  },
  submittedAt: new Date("2026-05-16T00:00:00.000Z"),
};

void invalidSubmission;
