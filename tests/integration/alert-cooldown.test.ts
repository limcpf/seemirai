import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PostgresAlertCooldownRepository,
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("alert cooldown integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("alert_cooldowns").execute();
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

  it("persists P0/P1 alert cooldown state by fingerprint", async () => {
    const db = await getDatabase();
    const repository = new PostgresAlertCooldownRepository(db);
    const input = {
      fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
      severity: "P0" as const,
      alertType: "db",
      market: null,
      strategyId: null,
      reasonCode: "db_write_failure",
      occurredAt: "2026-05-21T00:00:00.000Z",
      payloadJson: {
        correlation_id: "corr-alert",
      },
    };

    const sent = await repository.recordSent(input);
    const skipped = await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:00:30.000Z",
    });
    const loaded = await repository.findByFingerprint(input.fingerprint);

    expect(sent.lastSentAt).toEqual(new Date("2026-05-21T00:00:00.000Z"));
    expect(skipped.lastSkippedAt).toEqual(new Date("2026-05-21T00:00:30.000Z"));
    expect(loaded).toMatchObject({
      fingerprint: input.fingerprint,
      severity: "P0",
      reasonCode: "db_write_failure",
    });
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
