import { z } from "zod";
import type { MarketEvent } from "../../domain/index.js";
import { assertUniqueMarketEventOrderKeys, sortMarketEvents } from "../../domain/index.js";

const TimestampSchema = z.union([z.string().min(1), z.date()]);
const NumericStringSchema = z.string().min(1);
const JsonRecordSchema = z.record(z.string(), z.unknown());
const MarketEventSourceMetadataSchema = z
  .object({
    sourceKind: z.enum(["RUNTIME", "FIXTURE", "DATABASE", "ADAPTER"]),
    sourceId: z.string().min(1),
    sourceIndex: z.number().int().nonnegative().optional(),
    raw: JsonRecordSchema.optional(),
  })
  .strict();

const MarketEventBaseSchema = {
  exchangeId: z.string().min(1),
  market: z.string().min(1),
  eventTimestamp: TimestampSchema,
  receivedAt: TimestampSchema.optional(),
  sequence: z.string().min(1),
  tieBreakKey: z.string().min(1),
  source: MarketEventSourceMetadataSchema,
  metadata: JsonRecordSchema.optional(),
};

const OrderbookLevelSchema = z
  .object({
    price: NumericStringSchema,
    size: NumericStringSchema,
  })
  .strict();

export const MarketEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("TRADE"),
      ...MarketEventBaseSchema,
      tradeId: z.string().min(1),
      price: NumericStringSchema,
      quantity: NumericStringSchema,
      side: z.enum(["BID", "ASK", "UNKNOWN"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ORDERBOOK_SNAPSHOT"),
      ...MarketEventBaseSchema,
      asks: z.array(OrderbookLevelSchema).min(1),
      bids: z.array(OrderbookLevelSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ORDERBOOK_METRIC"),
      ...MarketEventBaseSchema,
      bestBidPrice: NumericStringSchema.optional(),
      bestAskPrice: NumericStringSchema.optional(),
      spreadBps: NumericStringSchema.optional(),
      bidDepth1: NumericStringSchema.optional(),
      askDepth1: NumericStringSchema.optional(),
      bidDepth5: NumericStringSchema.optional(),
      askDepth5: NumericStringSchema.optional(),
      imbalance5: NumericStringSchema.optional(),
      metrics: JsonRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("TICKER"),
      ...MarketEventBaseSchema,
      tradePrice: NumericStringSchema,
      changeRate: NumericStringSchema.optional(),
      accTradePrice24h: NumericStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("POLICY_CANDIDATE"),
      ...MarketEventBaseSchema,
      tradable: z.boolean(),
      warning: z.boolean(),
      caution: z.boolean(),
      reasonCodes: z.array(z.string().min(1)),
      minimumOrderNotional: NumericStringSchema.optional(),
      bidFeeBps: NumericStringSchema.optional(),
      askFeeBps: NumericStringSchema.optional(),
      policy: JsonRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("STATUS"),
      ...MarketEventBaseSchema,
      status: z.enum(["CONNECTED", "STALE", "RECONNECTING", "DISCONNECTED"]),
      reasonCode: z.string().min(1).optional(),
      websocketLagMs: z.number().int().nonnegative().optional(),
      reconnectCount: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

export const MarketEventFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    events: z.array(MarketEventSchema).min(1),
  })
  .strict();

export interface MarketEventFixture {
  schemaVersion: 1;
  events: readonly MarketEvent[];
}

/**
 * backtest fixture JSON을 MarketEvent fixture contract로 검증한다.
 *
 * schema 검증 뒤 order key 중복을 한 번 더 막는다. 정렬은 호출자가 명시적으로 수행하게 두어 원본 fixture 순서와
 * replay 순서 차이가 테스트에서 드러나게 한다.
 */
export function parseMarketEventFixture(input: unknown): MarketEventFixture {
  const fixture = MarketEventFixtureSchema.parse(input) as MarketEventFixture;
  assertUniqueMarketEventOrderKeys(fixture.events);

  return fixture;
}

/**
 * fixture event를 deterministic replay 순서로 반환한다.
 */
export function sortMarketEventFixtureEvents(fixture: MarketEventFixture): readonly MarketEvent[] {
  assertUniqueMarketEventOrderKeys(fixture.events);
  return sortMarketEvents(fixture.events);
}
