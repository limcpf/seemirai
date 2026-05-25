import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateM11FeatureSnapshot } from "../../src/application/index.js";
import type { FeatureResult } from "../../src/application/index.js";
import type { MarketDataEvent, OrderbookEvent, TradeEvent } from "../../src/domain/index.js";

describe("M11 feature calculator", () => {
  it("calculates deterministic feature values from a fixed market fixture", () => {
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events: createFeatureFixtureEvents(),
      cost: {
        expectedReturnBps: "40",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "2",
        expectedSlippageBpsP95: "3",
        cancelRequotePenaltyBps: "0.5",
        safetyBufferBps: "10",
      },
    });

    expect(result.status).toBe("ok");
    expect(result.failureReasons).toEqual([]);
    expect(result.features).toMatchObject({
      candle_momentum_bps: "1000",
      volume_spike_ratio: "2.2",
      bid_depth_slope_krw_per_bps: "2.98",
      ask_depth_slope_krw_per_bps: expectedAskDepthSlope(),
      depth_change_rate_ratio: "1",
      trade_direction_imbalance_ratio: "1",
      market_regime: "trend_up",
      session_liquidity_score: "1",
      session_liquidity_state: "normal",
      cost_adjusted_expected_return_bps: "24.5",
      cost_adjusted_margin_bps: "14.5",
    });
    expect(result.features.realized_volatility_bps).toBe(expectedRealizedVolatility());
    expect(result.features.vwap_deviation_bps).toBe(expectedVwapDeviation());
  });

  it("returns explicit failure results instead of filling missing inputs with zero", () => {
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events: [],
      cost: {
        expectedReturnBps: "40",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "2",
        expectedSlippageBpsP95: "3",
        cancelRequotePenaltyBps: "0.5",
        safetyBufferBps: "10",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.features.candle_momentum_bps).toBeUndefined();
    expect(findResult(result.results, "candle_momentum_bps")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
    });
    expect(findResult(result.results, "bid_depth_slope_krw_per_bps")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
    });
  });

  it("classifies invalid decimal strings as calculator failures", () => {
    const events = createFeatureFixtureEvents();
    const firstTradeIndex = events.findIndex((event) => event.type === "TRADE");
    const invalidFirst = {
      ...events[firstTradeIndex]!,
      price: "not-a-decimal",
    } as TradeEvent;
    events.splice(firstTradeIndex, 1, invalidFirst);
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events,
      cost: {
        expectedReturnBps: "40",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "2",
        expectedSlippageBpsP95: "3",
        cancelRequotePenaltyBps: "0.5",
        safetyBufferBps: "10",
      },
    });

    expect(result.status).toBe("failed");
    expect(findResult(result.results, "volume_spike_ratio")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INVALID_DECIMAL",
    });
  });

  it("returns a failed snapshot when input normalization cannot parse timestamps or options", () => {
    const invalidObservedAt = calculateM11FeatureSnapshot({
      observedAt: "not-a-timestamp",
      events: createFeatureFixtureEvents(),
      cost: createCostInput(),
    });
    const invalidOption = calculateM11FeatureSnapshot(
      {
        observedAt: "2026-05-25T00:21:00.000Z",
        events: createFeatureFixtureEvents(),
        cost: createCostInput(),
      },
      {
        volatileSpreadBps: "not-a-decimal",
      },
    );
    const invalidEventTimestamp = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events: [
        {
          ...createFeatureFixtureEvents()[0]!,
          exchangeTimestamp: "not-a-timestamp",
        } as OrderbookEvent,
      ],
      cost: createCostInput(),
    });

    expect(invalidObservedAt.status).toBe("failed");
    expect(invalidObservedAt.observedAt).toBe("not-a-timestamp");
    expect(invalidObservedAt.failureReasons).toHaveLength(13);
    expect(invalidObservedAt.failureReasons.every((failure) => failure.reasonCode === "FEATURE_INVALID_MARKET_VALUE")).toBe(
      true,
    );
    expect(invalidOption.failureReasons.every((failure) => failure.reasonCode === "FEATURE_INVALID_DECIMAL")).toBe(true);
    expect(invalidEventTimestamp.failureReasons.every((failure) => failure.reasonCode === "FEATURE_INVALID_MARKET_VALUE")).toBe(
      true,
    );
  });

  it("fails closed when stale market data is inside the calculation window", () => {
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events: [
        ...createFeatureFixtureEvents(),
        {
          type: "STATUS",
          exchangeId: "upbit_krw_spot",
          market: "KRW-BTC",
          status: "STALE",
          observedAt: "2026-05-25T00:20:30.000Z",
          reasonCode: "fixture_stale",
        },
      ],
      cost: {
        expectedReturnBps: "40",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "2",
        expectedSlippageBpsP95: "3",
        cancelRequotePenaltyBps: "0.5",
        safetyBufferBps: "10",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.features).toEqual({});
    expect(result.failureReasons).toHaveLength(13);
    expect(result.failureReasons.every((failure) => failure.reasonCode === "FEATURE_MARKET_DATA_STALE")).toBe(true);
  });

  it("keeps cost-adjusted features failed when required cost inputs are missing", () => {
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events: createFeatureFixtureEvents(),
      cost: {
        expectedReturnBps: "40",
        entryFeeBps: "5",
        exitFeeBps: "5",
        spreadCostBpsP75: "2",
        expectedSlippageBpsP95: "3",
        cancelRequotePenaltyBps: "0.5",
      },
    });

    expect(result.status).toBe("failed");
    expect(findResult(result.results, "cost_adjusted_expected_return_bps")).toMatchObject({
      status: "ok",
      value: "24.5",
    });
    expect(findResult(result.results, "cost_adjusted_margin_bps")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
    });
  });

  it("fails depth change when current and reference windows reuse the same orderbook snapshot", () => {
    const events = createFeatureFixtureEvents().filter(
      (event) => event.type !== "ORDERBOOK" || event.exchangeTimestamp === "2026-05-25T00:15:00.000Z",
    );
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events,
      cost: createCostInput(),
    });

    expect(findResult(result.results, "depth_change_rate_ratio")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
    });
  });

  it("limits session liquidity depth baseline to the recent feature window", () => {
    const events: MarketDataEvent[] = createFeatureFixtureEvents().filter((event) => event.type !== "ORDERBOOK");
    events.unshift(
      createOrderbook("2026-05-25T00:00:00.000Z", "10"),
      createOrderbook("2026-05-25T00:20:50.000Z", "1"),
    );
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events,
      cost: createCostInput(),
    });

    expect(findResult(result.results, "session_liquidity_score")).toMatchObject({
      status: "failed",
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
    });
  });

  it("classifies market regime with session liquidity stress before trend signals", () => {
    const events: MarketDataEvent[] = createFeatureFixtureEvents().filter((event) => event.type !== "ORDERBOOK");
    events.unshift(
      createOrderbook("2026-05-25T00:02:00.000Z", "10"),
      createOrderbook("2026-05-25T00:15:00.000Z", "1"),
      createOrderbook("2026-05-25T00:20:50.000Z", "1"),
    );
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events,
      cost: createCostInput(),
    });

    expect(findResult(result.results, "session_liquidity_score")).toMatchObject({
      status: "ok",
      value: "0.18181818181818181818",
    });
    expect(findResult(result.results, "market_regime")).toMatchObject({
      status: "ok",
      value: "liquidity_stress",
    });
  });

  it("classifies widened spread as volatile before trend signals", () => {
    const events = createFeatureFixtureEvents();
    const latestOrderbookIndex = events.findIndex(
      (event) => event.type === "ORDERBOOK" && event.exchangeTimestamp === "2026-05-25T00:20:50.000Z",
    );
    events.splice(latestOrderbookIndex, 1, createOrderbook("2026-05-25T00:20:50.000Z", "1", "103"));
    const result = calculateM11FeatureSnapshot({
      observedAt: "2026-05-25T00:21:00.000Z",
      events,
      cost: createCostInput(),
    });

    expect(findResult(result.results, "market_regime")).toMatchObject({
      status: "ok",
      value: "volatile",
    });
  });

  it("keeps large VWAP deviations out of range classification", () => {
    const events: MarketDataEvent[] = [
      createOrderbook("2026-05-25T00:15:00.000Z", "1"),
      createOrderbook("2026-05-25T00:20:50.000Z", "1"),
    ];

    for (let minute = 1; minute <= 21; minute += 1) {
      events.push(
        createTrade({
          tradeId: `neutral-${minute}`,
          observedAt: `2026-05-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
          price: minute === 21 ? "105" : "100",
          quantity: "1",
          side: minute % 2 === 0 ? "BID" : "ASK",
        }),
      );
    }

    const result = calculateM11FeatureSnapshot(
      {
        observedAt: "2026-05-25T00:21:00.000Z",
        events,
        cost: createCostInput(),
      },
      {
        trendMomentumBps: "1000",
      },
    );

    expect(findResult(result.results, "market_regime")).toMatchObject({
      status: "ok",
      value: "volatile",
    });
  });
});

function createFeatureFixtureEvents(): MarketDataEvent[] {
  const events: MarketDataEvent[] = [
    createOrderbook("2026-05-25T00:15:00.000Z", "0.5"),
    createOrderbook("2026-05-25T00:20:50.000Z", "1"),
  ];

  for (let minute = 1; minute <= 21; minute += 1) {
    const isLatest = minute === 21;
    events.push(
      createTrade({
        tradeId: `trade-${minute}`,
        observedAt: `2026-05-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
        price: isLatest ? "110" : "100",
        quantity: isLatest ? "2" : "1",
        side: "BID",
      }),
    );
  }

  return events;
}

function createTrade(input: {
  tradeId: string;
  observedAt: string;
  price: string;
  quantity: string;
  side: TradeEvent["side"];
}): TradeEvent {
  return {
    type: "TRADE",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    tradeId: input.tradeId,
    price: input.price,
    quantity: input.quantity,
    side: input.side,
    exchangeTimestamp: input.observedAt,
    receivedAt: input.observedAt,
  };
}

function createOrderbook(observedAt: string, sizeMultiplier: string, bestAskPrice = "101"): OrderbookEvent {
  const multiplier = new Decimal(sizeMultiplier);
  const secondAskPrice = new Decimal(bestAskPrice).plus(1).toFixed();
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    bids: [
      { price: "100", size: multiplier.toFixed() },
      { price: "99", size: multiplier.mul(2).toFixed() },
    ],
    asks: [
      { price: bestAskPrice, size: multiplier.toFixed() },
      { price: secondAskPrice, size: multiplier.mul(2).toFixed() },
    ],
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
  };
}

function findResult(results: readonly FeatureResult[], key: string): FeatureResult | undefined {
  return results.find((result) => result.key === key);
}

function createCostInput() {
  return {
    expectedReturnBps: "40",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "2",
    expectedSlippageBpsP95: "3",
    cancelRequotePenaltyBps: "0.5",
    safetyBufferBps: "10",
  };
}

function expectedRealizedVolatility(): string {
  const returns = Array.from({ length: 18 }, () => new Decimal(0)).concat(new Decimal("0.1"));
  const mean = returns.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(returns.length);
  const variance = returns
    .reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), new Decimal(0))
    .div(returns.length);

  return variance.sqrt().mul(10_000).toFixed();
}

function expectedVwapDeviation(): string {
  const totalNotional = new Decimal(19).mul(100).plus(220);
  const totalQuantity = new Decimal(19).plus(2);
  const vwap = totalNotional.div(totalQuantity);

  return new Decimal(110).minus(vwap).div(vwap).mul(10_000).toFixed();
}

function expectedAskDepthSlope(): string {
  const distanceBps = new Decimal(102).minus(101).div(101).mul(10_000);
  const notional = new Decimal(101).plus(new Decimal(102).mul(2));

  return notional.div(distanceBps).toFixed();
}
