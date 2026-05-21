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
      const report = aggregateDailyReport(window, {
        ...sourceData,
        positions: sourceData.positions.filter((position) => position.strategyId === strategyId),
      });

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

  it("loads execution quality by fill time and ignores unfilled orders", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const strategyId = createFixtureStrategyId();
      const repository = new PostgresDailyReportRepository(transaction);
      const filledOrder = await transaction
        .insertInto("orders")
        .values({
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          strategy_id: strategyId,
          side: "BUY",
          order_type: "LIMIT",
          status: "FILLED",
          idempotency_key: `daily-report-filled-quality-${strategyId}`,
          requested_price: "1000",
          requested_quantity: "1",
          requested_notional: "1000",
          reason_json: {
            cost_snapshot: {
              spread_cost_bps_p75: "4.4",
              expected_slippage_bps_p95: "9.9",
              cancel_requote_penalty_bps: "0.7",
            },
          },
          created_at: "2026-05-20T14:30:00.000Z",
          updated_at: "2026-05-20T15:30:00.000Z",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("paper_orders")
        .values({
          order_id: filledOrder.id,
          post_only: false,
          time_in_force: "GTC",
          fill_model_json: {
            paper_fill_simulation: {
              status: "FILLED",
              slippageBps: "1.25",
            },
          },
          submitted_at: "2026-05-20T14:30:00.000Z",
          accepted_at: "2026-05-20T14:31:00.000Z",
          completed_at: "2026-05-20T15:30:00.000Z",
        })
        .execute();

      await transaction
        .insertInto("fills")
        .values({
          order_id: filledOrder.id,
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          side: "BUY",
          price: "1000",
          quantity: "1",
          fee: "5",
          fee_currency: "KRW",
          liquidity: "TAKER",
          filled_at: "2026-05-20T15:30:00.000Z",
        })
        .execute();

      await transaction
        .insertInto("orders")
        .values({
          exchange: "upbit_krw_spot",
          market: "KRW-ETH",
          strategy_id: strategyId,
          side: "SELL",
          order_type: "LIMIT",
          status: "CANCELED",
          idempotency_key: `daily-report-unfilled-quality-${strategyId}`,
          requested_price: "2000",
          requested_quantity: "1",
          requested_notional: "2000",
          reason_json: {
            cost_snapshot: {
              spread_cost_bps_p75: "99",
              expected_slippage_bps_p95: "88",
              cancel_requote_penalty_bps: "77",
            },
          },
          created_at: "2026-05-21T01:00:00.000Z",
          updated_at: "2026-05-21T01:01:00.000Z",
        })
        .execute();

      const sourceData = await repository.loadDailyReportSourceData(createDailyReportWindow("2026-05-21"));

      expect(sourceData.executionQuality).toEqual([
        {
          strategyId,
          market: "KRW-BTC",
          slippageBps: "1.25",
          spreadCostBps: "4.4",
          cancelRequotePenaltyBps: "0.7",
        },
      ]);
      expect(sourceData.fills.filter((fill) => fill.strategyId === strategyId)).toHaveLength(1);
    });
  });

  it("reconstructs order status at the report window end from order events", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const strategyId = createFixtureStrategyId();
      const repository = new PostgresDailyReportRepository(transaction);
      const order = await transaction
        .insertInto("orders")
        .values({
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          strategy_id: strategyId,
          side: "BUY",
          order_type: "LIMIT",
          status: "FILLED",
          idempotency_key: `daily-report-status-as-of-${strategyId}`,
          requested_price: "1000",
          requested_quantity: "1",
          requested_notional: "1000",
          reason_json: {},
          created_at: "2026-05-21T14:00:00.000Z",
          updated_at: "2026-05-21T15:30:00.000Z",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("order_events")
        .values([
          {
            order_id: order.id,
            event_type: "ORDER_STATE_TRANSITION",
            from_status: "RISK_APPROVED",
            to_status: "SUBMITTED",
            accepted: true,
            reason_code: "submitted",
            message: "submitted before report window end",
            correlation_id: null,
            payload_json: {},
            occurred_at: "2026-05-21T14:30:00.000Z",
          },
          {
            order_id: order.id,
            event_type: "ORDER_STATE_TRANSITION",
            from_status: "SUBMITTED",
            to_status: "FILLED",
            accepted: true,
            reason_code: "filled",
            message: "filled after report window end",
            correlation_id: null,
            payload_json: {},
            occurred_at: "2026-05-21T15:30:00.000Z",
          },
        ])
        .execute();

      const window = createDailyReportWindow("2026-05-21");
      const sourceData = await repository.loadDailyReportSourceData(window);
      const report = aggregateDailyReport(window, sourceData);

      expect(sourceData.orders.find((fact) => fact.strategyId === strategyId)?.status).toBe("SUBMITTED");
      expect(report.orderStatusCounts).toContainEqual({
        code: "SUBMITTED",
        label: "제출됨 (SUBMITTED)",
        count: 1,
      });
    });
  });

  it("orders same-timestamp state events by lifecycle rank instead of UUID", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const strategyId = createFixtureStrategyId();
      const repository = new PostgresDailyReportRepository(transaction);
      const order = await transaction
        .insertInto("orders")
        .values({
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          strategy_id: strategyId,
          side: "BUY",
          order_type: "LIMIT",
          status: "FILLED",
          idempotency_key: `daily-report-same-time-status-${strategyId}`,
          requested_price: "1000",
          requested_quantity: "1",
          requested_notional: "1000",
          reason_json: {},
          created_at: "2026-05-21T14:00:00.000Z",
          updated_at: "2026-05-21T14:40:00.000Z",
        })
        .returning(["id"])
        .executeTakeFirstOrThrow();

      await transaction
        .insertInto("order_events")
        .values([
          {
            id: "00000000-0000-0000-0000-000000000010",
            order_id: order.id,
            event_type: "ORDER_STATE_TRANSITION",
            from_status: "RISK_APPROVED",
            to_status: "SUBMITTED",
            accepted: true,
            reason_code: "submitted",
            message: "submitted before same-time terminal events",
            correlation_id: null,
            payload_json: {},
            occurred_at: "2026-05-21T14:30:00.000Z",
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            order_id: order.id,
            event_type: "ORDER_STATE_TRANSITION",
            from_status: "SUBMITTED",
            to_status: "ACCEPTED",
            accepted: true,
            reason_code: "accepted",
            message: "accepted at same timestamp",
            correlation_id: null,
            payload_json: {},
            occurred_at: "2026-05-21T14:40:00.000Z",
          },
          {
            id: "00000000-0000-0000-0000-000000000001",
            order_id: order.id,
            event_type: "ORDER_STATE_TRANSITION",
            from_status: "ACCEPTED",
            to_status: "FILLED",
            accepted: true,
            reason_code: "filled",
            message: "filled at same timestamp",
            correlation_id: null,
            payload_json: {},
            occurred_at: "2026-05-21T14:40:00.000Z",
          },
        ])
        .execute();

      const sourceData = await repository.loadDailyReportSourceData(createDailyReportWindow("2026-05-21"));

      expect(sourceData.orders.find((fact) => fact.strategyId === strategyId)?.status).toBe("FILLED");
    });
  });

  it("keeps positions updated after the report window as current fallback facts", async () => {
    const db = await getDatabase();
    await withRollback(db, async (transaction) => {
      const strategyId = createFixtureStrategyId();
      const repository = new PostgresDailyReportRepository(transaction);

      await transaction
        .insertInto("positions")
        .values({
          exchange: "upbit_krw_spot",
          market: "KRW-BTC",
          strategy_id: strategyId,
          quantity: "1",
          average_entry_price: "1000",
          realized_pnl: "42",
          unrealized_pnl: "7",
          updated_at: "2026-05-22T01:00:00.000Z",
        })
        .execute();

      const window = createDailyReportWindow("2026-05-21");
      const sourceData = await repository.loadDailyReportSourceData(window);
      const report = aggregateDailyReport(window, {
        ...sourceData,
        positions: sourceData.positions.filter((position) => position.strategyId === strategyId),
      });
      const position = sourceData.positions.find((candidate) => candidate.strategyId === strategyId);

      expect(position).toMatchObject({
        realizedPnl: "42.00000000",
        unrealizedPnl: "7.00000000",
      });
      expect(new Date(String(position?.updatedAt)).toISOString()).toBe("2026-05-22T01:00:00.000Z");
      expect(report.realizedPnl).toMatchObject({
        value: "42",
        source: "positions",
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
