import { afterAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  aggregateDailyReport,
  createDailyReportWindow,
} from "../../src/application/index.js";
import {
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
  PostgresDailyReportRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("daily report PostgreSQL integration", () => {
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

  it("loads report facts from orders, fills, positions, audit, risk, and pnl snapshots", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const strategyId = createFixtureStrategyId();
      const repository = new PostgresDailyReportRepository(transaction);
      await insertReportFixture(transaction, strategyId);

      const window = createDailyReportWindow("2026-05-21");
      const sourceData = await repository.loadDailyReportSourceData(window);
      const report = aggregateDailyReport(window, sourceData);

      expect(sourceData.orders).toHaveLength(1);
      expect(sourceData.fills).toHaveLength(1);
      expect(sourceData.positions.filter((position) => position.strategyId === strategyId)).toHaveLength(1);
      expect(sourceData.auditEvents).toHaveLength(1);
      expect(sourceData.riskEvents).toHaveLength(1);
      expect(sourceData.pnlSnapshots).toHaveLength(1);
      expect(sourceData.executionQuality).toEqual([
        {
          strategyId,
          market: "KRW-BTC",
          slippageBps: "1.5",
          spreadCostBps: "2.5",
          cancelRequotePenaltyBps: "0.5",
        },
      ]);
      expect(report).toMatchObject({
        orderCount: 1,
        fillCount: 1,
        realizedPnl: {
          value: "1300",
          source: "pnl_snapshots",
        },
        estimatedPnl: {
          value: "250",
          source: "pnl_snapshots.unrealized_pnl",
        },
        discardedCandidates: {
          total: 1,
        },
        riskEvents: {
          total: 1,
        },
      });
    });
  });

  it("enqueues one daily report job per report date", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const repository = new PostgresDailyReportRepository(transaction);
      const reportDate = "2026-05-22";

      const first = await repository.enqueueDailyReportJob({
        reportDate,
        runAfter: "2026-05-22T15:01:00.000Z",
      });
      const duplicate = await repository.enqueueDailyReportJob({
        reportDate,
        runAfter: "2026-05-22T15:02:00.000Z",
      });
      const count = await transaction
        .selectFrom("jobs")
        .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
        .where("idempotency_key", "=", first.plan.idempotencyKey)
        .executeTakeFirstOrThrow();

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.job.id).toBe(first.job.id);
      expect(first.plan.idempotencyKey).toBe("report.daily:2026-05-22");
      expect(first.job.payload_json).toMatchObject({
        report_date: "2026-05-22",
        utc_start_at: "2026-05-21T15:00:00.000Z",
        utc_end_at: "2026-05-22T15:00:00.000Z",
      });
      expect(Number(count.count)).toBe(1);
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

class RollbackDailyReportIntegration extends Error {
  public constructor() {
    super("rollback daily report integration fixture");
    this.name = "RollbackDailyReportIntegration";
  }
}

/**
 * 공유 integration DB를 더럽히지 않기 위해 fixture 작업을 rollback transaction 안에서 실행한다.
 *
 * 다른 integration 파일도 `orders`/`jobs`를 사용하므로 커밋된 fixture를 cleanup하는 방식은 병렬 실행 중 FK 경합을 만들 수 있다.
 * 이 helper는 테스트가 자기 transaction 안에서만 writes를 보고, 마지막에 의도적으로 rollback해 파일 간 간섭을 줄인다.
 */
async function withRollback(db: Database, work: (transaction: Database) => Promise<void>): Promise<void> {
  try {
    await db.transaction().execute(async (transaction) => {
      await work(transaction as unknown as Database);
      throw new RollbackDailyReportIntegration();
    });
  } catch (error) {
    if (error instanceof RollbackDailyReportIntegration) {
      return;
    }

    throw error;
  }
}

function createFixtureStrategyId(): string {
  return `daily_report_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function insertReportFixture(db: Database, strategyId: string): Promise<void> {
  const order = await db
    .insertInto("orders")
    .values({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: strategyId,
      side: "BUY",
      order_type: "LIMIT",
      status: "FILLED",
      idempotency_key: `daily-report-order-${strategyId}`,
      requested_price: "1000",
      requested_quantity: "2",
      requested_notional: "2000",
      reason_json: {
        cost_snapshot: {
          spread_cost_bps_p75: "2.5",
          expected_slippage_bps_p95: "3.5",
          cancel_requote_penalty_bps: "0.5",
        },
      },
      created_at: "2026-05-21T01:00:00.000Z",
      updated_at: "2026-05-21T01:00:01.000Z",
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  await db
    .insertInto("paper_orders")
    .values({
      order_id: order.id,
      post_only: false,
      time_in_force: "GTC",
      fill_model_json: {
        paper_fill_simulation: {
          status: "FILLED",
          slippageBps: "1.5",
        },
      },
      submitted_at: "2026-05-21T01:00:00.000Z",
      accepted_at: "2026-05-21T01:00:01.000Z",
      completed_at: "2026-05-21T01:00:02.000Z",
    })
    .execute();

  await db
    .insertInto("fills")
    .values({
      order_id: order.id,
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      price: "1000",
      quantity: "2",
      fee: "10",
      fee_currency: "KRW",
      liquidity: "TAKER",
      filled_at: "2026-05-21T01:00:02.000Z",
    })
    .execute();

  await db
    .insertInto("positions")
    .values({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: strategyId,
      quantity: "2",
      average_entry_price: "1000",
      realized_pnl: "1200",
      unrealized_pnl: "200",
      updated_at: "2026-05-21T01:00:02.000Z",
    })
    .execute();

  await db
    .insertInto("pnl_snapshots")
    .values({
      strategy_id: strategyId,
      market: "KRW-BTC",
      captured_at: "2026-05-21T14:00:00.000Z",
      equity: "100000",
      realized_pnl: "1300",
      unrealized_pnl: "250",
      drawdown_bps: "5",
      payload_json: {
        source: "daily-report-test",
      },
    })
    .execute();

  await db
    .insertInto("audit_events")
    .values({
      event_type: "ORDER_DECISION",
      severity: "WARN",
      order_id: order.id,
      correlation_id: "daily-report-corr-1",
      payload_json: {
        audit_kind: "ORDER_CANDIDATE_DISCARDED",
        reason_code: "spread_too_wide",
      },
      occurred_at: "2026-05-21T02:00:00.000Z",
    })
    .execute();

  await db
    .insertInto("risk_events")
    .values({
      risk_type: "spread",
      severity: "WARN",
      market: "KRW-BTC",
      strategy_id: strategyId,
      order_id: order.id,
      action: "BLOCK_ORDER",
      payload_json: {
        reason_code: "spread_too_wide",
      },
      occurred_at: "2026-05-21T02:00:00.000Z",
    })
    .execute();
}
