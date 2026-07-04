import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
  PostgresLiveDecisionHistoryRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";
import { createLiveDecisionHistoryTick } from "../../src/application/live-decision-history.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("live decision history PostgreSQL integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

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

  it("같은 HOLD bucket tick은 중복 row를 만들지 않는다", async () => {
    const db = await getDatabase();
    const repository = new PostgresLiveDecisionHistoryRepository(db);
    const tick = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "HOLD",
      reasonCode: "autonomous_24x7_entry_signal_weak",
      featureSnapshot: { featureStatus: "ok" },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: `integration-hold-${Date.now()}`,
      trace: { source: "integration-test" },
    });

    const first = await repository.appendDecisionTick({ tick });
    const second = await repository.appendDecisionTick({ tick });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.record.id).toBe(first.record.id);
  });

  it("retention cutoff 이전 row를 삭제한다", async () => {
    const db = await getDatabase();
    const repository = new PostgresLiveDecisionHistoryRepository(db);
    const tick = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "BLOCK",
      reasonCode: "feature_stale",
      featureSnapshot: { featureStatus: "stale" },
      thresholds: { min_sample_count: 10 },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-29T00:00:05.000Z"),
      decisionAt: new Date("2026-06-29T00:00:05.100Z"),
      sourceTickId: `integration-block-${Date.now()}`,
      trace: { source: "integration-test" },
    });

    await repository.appendDecisionTick({ tick });
    const retention = await repository.applyRetention({
      olderThan: new Date("2026-06-30T00:00:00.000Z"),
    });
    const found = await repository.findDecisionTickByDedupeKey(tick.dedupeKey);

    expect(retention.deleted).toBeGreaterThanOrEqual(1);
    expect(found).toBeUndefined();
  });
});
