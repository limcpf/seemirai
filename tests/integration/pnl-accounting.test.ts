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
    const sourceFingerprint = computePnlSnapshotSourceFingerprint(output, capturedAt, "4");

    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.persistPnlSnapshot({
            output,
            capturedAt,
            drawdownBps: "4",
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
      expect(rows[0]!.drawdown_bps).toBe("4.000000");
      expect(results.filter((result) => result.inserted)).toHaveLength(1);
      expect(results.every((result) => result.snapshots.length === 1)).toBe(true);
    } finally {
      await db
        .deleteFrom("pnl_snapshots")
        .where("strategy_id", "=", strategyId)
        .execute();
    }
  });

  it("latest reconcile facts are deduplicated by strategy and market with quantity preserved", async () => {
    const db = await getDatabase();
    const repository = new PostgresPnlAccountingRepository(db);
    const strategyId = `pnl_reconcile_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const olderRunId = "10000000-0000-4000-8000-000000000101";
    const latestRunId = "10000000-0000-4000-8000-000000000102";
    const failedRunId = "10000000-0000-4000-8000-000000000103";
    const runningRunId = "10000000-0000-4000-8000-000000000104";

    try {
      await db
        .insertInto("live_reconcile_runs")
        .values([
          {
            id: olderRunId,
            idempotency_key: `${strategyId}:older`,
            status: "MANUAL_REVIEW_REQUIRED",
            started_at: "2026-06-05T00:00:00.000Z",
            finished_at: "2026-06-05T00:00:10.000Z",
          },
          {
            id: latestRunId,
            idempotency_key: `${strategyId}:latest`,
            status: "COMPLETED",
            started_at: "2026-06-05T00:01:00.000Z",
            finished_at: "2026-06-05T00:01:10.000Z",
          },
          {
            id: failedRunId,
            idempotency_key: `${strategyId}:failed`,
            status: "FAILED",
            started_at: "2026-06-05T00:02:00.000Z",
          },
          {
            id: runningRunId,
            idempotency_key: `${strategyId}:running`,
            status: "RUNNING",
            started_at: "2026-06-05T00:03:00.000Z",
          },
        ])
        .execute();

      await db
        .insertInto("live_reconcile_position_snapshots")
        .values([
          {
            run_id: olderRunId,
            exchange: "upbit_krw_spot",
            market: "KRW-BTC",
            strategy_id: strategyId,
            quantity: "0.01",
            average_entry_price: null,
            recovery_status: "MANUAL_REVIEW_REQUIRED",
            source: "manual_review",
            captured_at: "2026-06-05T00:01:00.000Z",
            evidence_json: { manualReviewEvidenceId: "ev-old" },
          },
          {
            run_id: latestRunId,
            exchange: "upbit_krw_spot",
            market: "KRW-BTC",
            strategy_id: strategyId,
            quantity: "0.02",
            average_entry_price: "100000000",
            recovery_status: "RECOVERABLE",
            source: "fills",
            captured_at: "2026-06-05T00:01:00.000Z",
          },
          {
            run_id: failedRunId,
            exchange: "upbit_krw_spot",
            market: "KRW-BTC",
            strategy_id: strategyId,
            quantity: "0.03",
            average_entry_price: "100000000",
            recovery_status: "RECOVERABLE",
            source: "fills",
            captured_at: "2026-06-05T00:02:00.000Z",
          },
          {
            run_id: runningRunId,
            exchange: "upbit_krw_spot",
            market: "KRW-BTC",
            strategy_id: strategyId,
            quantity: "0.04",
            average_entry_price: "100000000",
            recovery_status: "RECOVERABLE",
            source: "fills",
            captured_at: "2026-06-05T00:03:00.000Z",
          },
        ])
        .execute();

      const result = await repository.loadReconcileFacts({ strategyId });

      expect(result.records).toHaveLength(2);
      expect(result.reconcileFacts).toEqual([
        expect.objectContaining({
          strategyId,
          market: "KRW-BTC",
          quantity: "0.020000000000000000",
          recoveryStatus: "RECOVERABLE",
          averageEntryPrice: "100000000.000000000000000000",
          averageEntrySource: "fills",
        }),
      ]);
    } finally {
      await db
        .deleteFrom("live_reconcile_runs")
        .where("idempotency_key", "like", `${strategyId}:%`)
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
