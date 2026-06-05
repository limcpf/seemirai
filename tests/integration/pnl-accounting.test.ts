import { afterAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Pool } from "pg";
import type { PnLAccountingOutput } from "../../src/application/index.js";
import {
  applyMigrations,
  computePnlSnapshotSourceFingerprint,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
  PostgresPnlAccountingRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("PnL accounting PostgreSQL integration", () => {
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

  it("same source fingerprint concurrent retries create one pnl snapshot", async () => {
    const db = await getDatabase();
    const repository = new PostgresPnlAccountingRepository(db);
    const strategyId = `pnl_accounting_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const capturedAt = "2026-06-05T00:00:00.000Z";
    const capturedAtDate = new Date(capturedAt);
    const output = createCalculatedOutput(strategyId, capturedAt);
    const sourceFingerprint = computePnlSnapshotSourceFingerprint(output, capturedAt);

    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.persistPnlSnapshot({
            output,
            capturedAt,
            sourceFingerprint,
          }),
        ),
      );

      const rows = await db
        .selectFrom("pnl_snapshots")
        .selectAll()
        .where("strategy_id", "=", strategyId)
        .where("captured_at", "=", capturedAtDate)
        .where("market", "is", null)
        .where(sql<string>`payload_json ->> 'sourceFingerprint'`, "=", sourceFingerprint)
        .execute();

      expect(rows).toHaveLength(1);
      expect(results.filter((result) => result.inserted)).toHaveLength(1);
      expect(results.every((result) => result.snapshots.length === 1)).toBe(true);
    } finally {
      await db
        .deleteFrom("pnl_snapshots")
        .where("strategy_id", "=", strategyId)
        .execute();
    }
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

function createCalculatedOutput(
  strategyId: string,
  capturedAt: string,
): PnLAccountingOutput {
  return {
    scopes: [
      {
        strategyId,
        market: null,
        capturedAt,
        source: "fills",
        status: "CALCULATED",
      },
    ],
    status: "CALCULATED",
    realizedPnlKrw: "1200",
    unrealizedPnlKrw: "300",
    totalPnlKrw: "1500",
    cashKrw: "990000",
    positionMarketValueKrw: "10000",
    equityKrw: "1000000",
    positions: [],
    feeTotals: [],
    spreadCost: unavailableMetric(),
    slippage: unavailableMetric(),
    cancelRequote: unavailableMetric(),
    missingReasons: [],
    trace: {
      runId: "integration-run",
      sourceTables: ["fills", "positions"],
      lastSourceTimestamp: capturedAt,
    },
  };
}

function unavailableMetric(): PnLAccountingOutput["spreadCost"] {
  return {
    value: null,
    available: false,
    sampleCount: 0,
    source: "unavailable",
  };
}
