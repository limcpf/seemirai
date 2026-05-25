import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  BacktestOrchestrator,
  calculateM11FeatureSnapshot,
  createFixtureHistoricalEventSource,
} from "../../src/application/index.js";
import type {
  FeatureCalculationResult,
  FeatureCostInput,
  FeatureResult,
  M11FeatureKey,
} from "../../src/application/index.js";
import { evaluateCost } from "../../src/domain/index.js";
import type {
  CostModelInput,
  CostSnapshot,
  MarketDataEvent,
  MarketEvent,
  MarketOrderbookSnapshotEvent,
  MarketStatusReplayEvent,
  MarketTradeEvent,
  OrderbookEvent,
  Strategy,
  StrategyContext,
  TradeEvent,
} from "../../src/domain/index.js";

const exchangeId = "upbit_krw_spot";
const market = "KRW-BTC";
const strategyId = "m11_feature_parity_probe";
const observedAt = "2026-05-25T00:21:00.001Z";

describe("M11 backtest/paper feature parity", () => {
  it("calculates identical feature snapshots from the same backtest and paper fixture window", async () => {
    const cost = createFeatureCostInput();
    const backtestSnapshot = await calculateBacktestFeatureSnapshot({
      events: createParityMarketEvents(),
      cost,
    });
    const paperSnapshot = calculatePaperFeatureSnapshot({
      events: createPaperFeatureEvents(),
      cost,
    });
    const costDecision = evaluateCost(createCostModelInput());

    expect(backtestSnapshot).toEqual(paperSnapshot);
    expect(backtestSnapshot.status).toBe("ok");
    expect(backtestSnapshot.failureReasons).toEqual([]);
    expect(backtestSnapshot.results.every((result) => result.observedAt === observedAt)).toBe(true);
    expect(backtestSnapshot.results.every((result) => result.windowEndAt === observedAt)).toBe(true);
    expect(backtestSnapshot.features).toMatchObject({
      candle_momentum_bps: "1000",
      volume_spike_ratio: "2.2",
      market_regime: "trend_up",
      session_liquidity_state: "normal",
      cost_adjusted_expected_return_bps: "24.5",
      cost_adjusted_margin_bps: "14.5",
    });
    expect(backtestSnapshot.features.realized_volatility_bps).toBe(expectedRealizedVolatility());
    expect(backtestSnapshot.features.vwap_deviation_bps).toBe(expectedVwapDeviation());
    expect(extractCostInputSnapshot(costDecision.snapshot)).toEqual({
      expected_return_bps: cost.expectedReturnBps,
      entry_fee_bps: cost.entryFeeBps,
      exit_fee_bps: cost.exitFeeBps,
      spread_cost_bps_p75: cost.spreadCostBpsP75,
      expected_slippage_bps_p95: cost.expectedSlippageBpsP95,
      cancel_requote_penalty_bps: cost.cancelRequotePenaltyBps,
      safety_buffer_bps: cost.safetyBufferBps,
    });
    expect(backtestSnapshot.features.cost_adjusted_margin_bps).toBe(costDecision.snapshot.margin_bps);
    expect(backtestSnapshot.features.cost_adjusted_expected_return_bps).toBe(
      new Decimal(String(costDecision.snapshot.expected_return_bps)).minus(String(costDecision.snapshot.cost_bps)).toFixed(),
    );
  });

  it("keeps unavailable metrics failed in both paths instead of filling zero values", async () => {
    const cost = createFeatureCostInput();
    const backtestSnapshot = await calculateBacktestFeatureSnapshot({
      events: createParityMarketEvents({ includeOrderbooks: false }),
      cost,
    });
    const paperSnapshot = calculatePaperFeatureSnapshot({
      events: createPaperFeatureEvents({ includeOrderbooks: false }),
      cost,
    });
    const unavailableKeys: readonly M11FeatureKey[] = [
      "bid_depth_slope_krw_per_bps",
      "ask_depth_slope_krw_per_bps",
      "depth_change_rate_ratio",
      "session_liquidity_score",
      "session_liquidity_state",
    ];

    expect(backtestSnapshot).toEqual(paperSnapshot);
    expect(backtestSnapshot.status).toBe("failed");
    for (const key of unavailableKeys) {
      const result = requireFeatureResult(backtestSnapshot, key);

      expect(result).toMatchObject({
        status: "failed",
        reasonCode: "FEATURE_INSUFFICIENT_INPUT",
      });
      expect(backtestSnapshot.features[key]).toBeUndefined();
      expect(readFeatureValue(result)).not.toBe("0");
    }
  });

  it("matches stale market data failure reasons and boundaries in both paths", async () => {
    const cost = createFeatureCostInput();
    const backtestSnapshot = await calculateBacktestFeatureSnapshot({
      events: createParityMarketEvents({ includeStaleStatus: true }),
      cost,
    });
    const paperSnapshot = calculatePaperFeatureSnapshot({
      events: createPaperFeatureEvents({ includeStaleStatus: true }),
      cost,
    });

    expect(backtestSnapshot).toEqual(paperSnapshot);
    expect(backtestSnapshot.status).toBe("failed");
    expect(backtestSnapshot.features).toEqual({});
    expect(backtestSnapshot.failureReasons).toHaveLength(13);
    expect(
      backtestSnapshot.failureReasons.every(
        (failure) =>
          failure.reasonCode === "FEATURE_MARKET_DATA_STALE" &&
          failure.observedAt === observedAt &&
          failure.windowEndAt === observedAt,
      ),
    ).toBe(true);
  });
});

async function calculateBacktestFeatureSnapshot(input: {
  events: readonly MarketEvent[];
  cost: FeatureCostInput;
}): Promise<FeatureCalculationResult> {
  const orchestrator = new BacktestOrchestrator({
    source: createFixtureHistoricalEventSource({
      schemaVersion: 1,
      events: input.events,
    }),
    strategies: [createParityStrategy()],
  });
  const result = await orchestrator.run({
    createStrategyContext: ({ event, strategy, state }): StrategyContext | undefined => {
      if (event.kind !== "ORDERBOOK_METRIC") {
        return undefined;
      }

      return {
        strategyId: strategy.id,
        exchangeId: event.exchangeId,
        market: event.market,
        observedAt: event.eventTimestamp,
        marketEvents: state.latestMarketDataEvents,
        features: {},
      };
    },
    createCostInput: () => createCostModelInput(),
    createRiskGateContext: () => {
      throw new Error("feature parity probe must not promote order intents");
    },
    historyLimits: {
      marketDataEvents: 128,
    },
  });
  const context = result.strategyEvaluations[0]?.context;

  if (context === undefined) {
    throw new Error("feature parity trigger event did not produce a strategy context");
  }

  return calculateM11FeatureSnapshot({
    observedAt: context.observedAt,
    events: context.marketEvents,
    cost: input.cost,
  });
}

function calculatePaperFeatureSnapshot(input: {
  events: readonly MarketDataEvent[];
  cost: FeatureCostInput;
}): FeatureCalculationResult {
  return calculateM11FeatureSnapshot({
    observedAt,
    events: input.events,
    cost: input.cost,
  });
}

function createParityStrategy(): Strategy {
  return {
    id: strategyId,
    version: "1",
    requiredFeatures: [],
    evaluate(context: StrategyContext) {
      return {
        kind: "HOLD",
        strategyId: context.strategyId,
        reason: "feature parity probe",
      };
    },
  };
}

function createParityMarketEvents(options: {
  includeOrderbooks?: boolean;
  includeStaleStatus?: boolean;
} = {}): MarketEvent[] {
  const includeOrderbooks = options.includeOrderbooks ?? true;
  const events: MarketEvent[] = [];

  for (let minute = 1; minute <= 21; minute += 1) {
    if (includeOrderbooks) {
      events.push(createMarketOrderbook(minute));
    }

    events.push(createMarketTrade(minute));
  }

  if (options.includeStaleStatus === true) {
    events.push(createStaleMarketStatus(events.length));
  }

  events.push(createTriggerMetric(events.length));
  return events;
}

function createPaperFeatureEvents(options: {
  includeOrderbooks?: boolean;
  includeStaleStatus?: boolean;
} = {}): MarketDataEvent[] {
  return createParityMarketEvents(options)
    .map(toPaperFeatureEvent)
    .filter((event): event is MarketDataEvent => event !== undefined);
}

function toPaperFeatureEvent(event: MarketEvent): MarketDataEvent | undefined {
  switch (event.kind) {
    case "TRADE":
      return {
        type: "TRADE",
        exchangeId: event.exchangeId,
        market: event.market,
        tradeId: event.tradeId,
        price: event.price,
        quantity: event.quantity,
        side: event.side,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
      } satisfies TradeEvent;
    case "ORDERBOOK_SNAPSHOT":
      return {
        type: "ORDERBOOK",
        exchangeId: event.exchangeId,
        market: event.market,
        asks: event.asks,
        bids: event.bids,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
      } satisfies OrderbookEvent;
    case "STATUS":
      return {
        type: "STATUS",
        exchangeId: event.exchangeId,
        status: event.status,
        observedAt: event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
        ...(event.market === undefined ? {} : { market: event.market }),
        ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
      };
    case "ORDERBOOK_METRIC":
    case "POLICY_CANDIDATE":
    case "TICKER":
      return undefined;
  }
}

function createMarketTrade(minute: number): MarketTradeEvent {
  const isLatest = minute === 21;

  return {
    kind: "TRADE",
    exchangeId,
    market,
    tradeId: `trade-${minute}`,
    price: isLatest ? "110" : "100",
    quantity: isLatest ? "2" : "1",
    side: "BID",
    eventTimestamp: formatMinuteTimestamp(minute),
    receivedAt: formatMinuteTimestamp(minute),
    sequence: String(minute * 10 + 1),
    tieBreakKey: `trade:${minute}`,
    source: source(minute * 10 + 1),
  };
}

function createMarketOrderbook(minute: number): MarketOrderbookSnapshotEvent {
  const sizeMultiplier = minute === 21 ? "1" : "0.5";

  return {
    kind: "ORDERBOOK_SNAPSHOT",
    exchangeId,
    market,
    asks: createAskLevels(sizeMultiplier),
    bids: createBidLevels(sizeMultiplier),
    eventTimestamp: formatMinuteTimestamp(minute),
    receivedAt: formatMinuteTimestamp(minute),
    sequence: String(minute * 10),
    tieBreakKey: `orderbook:${minute}`,
    source: source(minute * 10),
  };
}

function createStaleMarketStatus(sourceIndex: number): MarketStatusReplayEvent {
  return {
    kind: "STATUS",
    exchangeId,
    market,
    status: "STALE",
    reasonCode: "fixture_stale",
    eventTimestamp: "2026-05-25T00:20:30.000Z",
    sequence: "205",
    tieBreakKey: "status:stale",
    source: source(sourceIndex),
  };
}

function createTriggerMetric(sourceIndex: number): MarketEvent {
  return {
    kind: "ORDERBOOK_METRIC",
    exchangeId,
    market,
    eventTimestamp: observedAt,
    receivedAt: observedAt,
    sequence: "999",
    tieBreakKey: "metric:parity-trigger",
    source: source(sourceIndex),
    bestBidPrice: "100",
    bestAskPrice: "101",
    spreadBps: "100",
    bidDepth1: "100",
    askDepth1: "101",
  };
}

function createBidLevels(sizeMultiplier: string): OrderbookEvent["bids"] {
  const multiplier = new Decimal(sizeMultiplier);

  return [
    { price: "100", size: multiplier.toFixed() },
    { price: "99", size: multiplier.mul(2).toFixed() },
  ];
}

function createAskLevels(sizeMultiplier: string): OrderbookEvent["asks"] {
  const multiplier = new Decimal(sizeMultiplier);

  return [
    { price: "101", size: multiplier.toFixed() },
    { price: "102", size: multiplier.mul(2).toFixed() },
  ];
}

function formatMinuteTimestamp(minute: number): string {
  return `2026-05-25T00:${String(minute).padStart(2, "0")}:00.000Z`;
}

function source(sourceIndex: number): MarketEvent["source"] {
  return {
    sourceKind: "FIXTURE",
    sourceId: "m11-feature-parity",
    sourceIndex,
  };
}

function createFeatureCostInput(): Required<FeatureCostInput> {
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

function createCostModelInput(): CostModelInput {
  return {
    exchangeId,
    market,
    expectedReturnBps: "40",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "2",
    expectedSlippageBpsP95: "3",
    cancelRequotePenaltyBps: "0.5",
    safetyBufferBps: "10",
    evaluatedAt: observedAt,
  };
}

function extractCostInputSnapshot(snapshot: CostSnapshot): Record<string, unknown> {
  return {
    expected_return_bps: snapshot.expected_return_bps,
    entry_fee_bps: snapshot.entry_fee_bps,
    exit_fee_bps: snapshot.exit_fee_bps,
    spread_cost_bps_p75: snapshot.spread_cost_bps_p75,
    expected_slippage_bps_p95: snapshot.expected_slippage_bps_p95,
    cancel_requote_penalty_bps: snapshot.cancel_requote_penalty_bps,
    safety_buffer_bps: snapshot.safety_buffer_bps,
  };
}

function requireFeatureResult(snapshot: FeatureCalculationResult, key: M11FeatureKey): FeatureResult {
  const result = snapshot.results.find((candidate) => candidate.key === key);

  if (result === undefined) {
    throw new Error(`missing feature result: ${key}`);
  }

  return result;
}

function readFeatureValue(result: FeatureResult): string | undefined {
  return result.status === "ok" ? String(result.value) : undefined;
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
