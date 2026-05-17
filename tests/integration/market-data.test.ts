import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  UpbitMarketListResponseSchema,
  UpbitOrderbookInstrumentsResponseSchema,
  UpbitWebSocketOrderbookSchema,
  UpbitWebSocketTradeSchema,
  applyMigrations,
  createDatabase,
  createPostgresPool,
  createUpbitPublicPolicySnapshot,
  destroyDatabase,
  insertTrade,
  loadLocalDatabaseConfig,
  parseRemainingReqHeader,
  savePolicySnapshot,
  toOrderbookEvent,
  toPolicySnapshotInput,
  toRestRateLimitPolicy,
  toTradeEvent,
  upsertOrderbookMetric,
  upsertOrderbookSnapshot,
} from "../../src/infrastructure/index.js";
import type { Database } from "../../src/infrastructure/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;
const observedAt = "2026-05-17T07:20:00.000Z";
const orderbookReceivedAt = "2025-05-07T07:06:14.804Z";
const krwPriceTickPolicy = {
  kind: "PRICE_BANDS",
  bands: [
    {
      minPrice: "0",
      maxPrice: "1000",
      tickSize: "1",
    },
    {
      minPrice: "1000",
      tickSize: "5",
    },
  ],
} as const;

describeDb("market data persistence integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("policy_snapshots").execute();
    await db.deleteFrom("trades").execute();
    await db.deleteFrom("orderbook_metrics").execute();
    await db.deleteFrom("orderbook_snapshots").execute();
  });

  afterAll(async () => {
    if (database !== undefined) {
      await destroyDatabase(database);
      database = undefined;
      pool = undefined;
      return;
    }

    await pool?.end();
    pool = undefined;
  });

  it("stores policy snapshots idempotently by checksum", async () => {
    const db = await getDatabase();
    const input = toPolicySnapshotInput(await createPolicySnapshot());

    const first = await savePolicySnapshot(db, input);
    const duplicate = await savePolicySnapshot(db, input);
    const count = await db
      .selectFrom("policy_snapshots")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.snapshot.id).toBe(first.snapshot.id);
    expect(Number(count.count)).toBe(1);
  });

  it("stores WebSocket trades idempotently", async () => {
    const db = await getDatabase();
    const event = await createTradeEvent();

    const first = await insertTrade(db, event);
    const duplicate = await insertTrade(db, event);
    const count = await db
      .selectFrom("trades")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.trade.trade_id).toBe(first.trade.trade_id);
    expect(duplicate.trade.side).toBe("BUY");
    expect(Number(count.count)).toBe(1);
  });

  it("upserts 1 second orderbook metrics and 5 second snapshots", async () => {
    const db = await getDatabase();
    const event = await createOrderbookEvent();

    const firstMetric = await upsertOrderbookMetric(db, event, { websocketLagMs: 1000 });
    const secondMetric = await upsertOrderbookMetric(db, event, { websocketLagMs: 2000, reconnectCount: 1 });
    const firstSnapshot = await upsertOrderbookSnapshot(db, event);
    const secondSnapshot = await upsertOrderbookSnapshot(db, event);
    const metricCount = await db
      .selectFrom("orderbook_metrics")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const snapshotCount = await db
      .selectFrom("orderbook_snapshots")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(firstMetric.bucket_at.toISOString()).toBe("2025-05-07T07:06:13.000Z");
    expect(secondMetric.websocket_lag_ms).toBe(2000);
    expect(secondMetric.reconnect_count).toBe(1);
    expect(Number(metricCount.count)).toBe(1);
    expect(firstSnapshot.captured_at.toISOString()).toBe("2025-05-07T07:06:10.000Z");
    expect(secondSnapshot.captured_at.getTime()).toBe(firstSnapshot.captured_at.getTime());
    expect(Number(snapshotCount.count)).toBe(1);
  });

  async function getDatabase(): Promise<Database> {
    if (database !== undefined) {
      return database;
    }

    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);
    await applyMigrations(pool);
    database = createDatabase(pool);
    return database;
  }
});

async function createPolicySnapshot() {
  const markets = UpbitMarketListResponseSchema.parse(await readJsonFixture("market-all-details.json"));
  const instruments = UpbitOrderbookInstrumentsResponseSchema.parse(
    await readJsonFixture("orderbook-instruments.json"),
  );

  return createUpbitPublicPolicySnapshot(markets[1]!, instruments[0]!, {
    observedAt,
    capturedAt: observedAt,
    minimumOrderNotional: "5000",
    priceTickPolicy: krwPriceTickPolicy,
    rateLimits: [
      toRestRateLimitPolicy("upbit_krw_spot", parseRemainingReqHeader("group=market; min=600; sec=9")),
    ],
  });
}

async function createTradeEvent() {
  const payload = UpbitWebSocketTradeSchema.parse(await readJsonFixture("websocket-trade.json"));
  return toTradeEvent(payload, { receivedAt: observedAt });
}

async function createOrderbookEvent() {
  const payload = UpbitWebSocketOrderbookSchema.parse(await readJsonFixture("websocket-orderbook.json"));
  return toOrderbookEvent(payload, { receivedAt: orderbookReceivedAt });
}

async function readJsonFixture(filename: string): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "upbit", filename);
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}
