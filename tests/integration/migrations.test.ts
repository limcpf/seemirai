import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createPostgresPool,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import type { Pool } from "pg";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;
const expectedMigrationCount = 8;

describeDb("database migrations integration", () => {
  let pool: Pool | undefined;

  afterAll(async () => {
    await pool?.end();
  });

  it("applies every migration and skips already applied migrations", async () => {
    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);

    const firstRun = await applyMigrations(pool);
    const secondRun = await applyMigrations(pool);
    const migrationCount = await pool.query<{ count: string }>("SELECT count(*) FROM schema_migrations");

    expect(firstRun.applied.length + firstRun.skipped.length).toBe(expectedMigrationCount);
    expect(secondRun.applied).toHaveLength(0);
    expect(secondRun.skipped).toHaveLength(expectedMigrationCount);
    expect(Number(migrationCount.rows[0]?.count)).toBe(expectedMigrationCount);
  });
});
