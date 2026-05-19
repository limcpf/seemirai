import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  appendAuditEvent,
  appendOrderStateTransitionEvent,
  appendRiskEvent,
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  listOrderEventsByOrderId,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import { transitionOrderState } from "../../src/domain/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;
const occurredAt = "2026-05-19T01:30:00.000Z";

describeDb("state transition persistence integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("order_events").execute();
    await db.deleteFrom("audit_events").execute();
    await db.deleteFrom("risk_events").execute();
    await db.deleteFrom("orders").execute();
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

  it("appends order, audit, and risk events for state transition evidence", async () => {
    const db = await getDatabase();
    const order = await insertOrder(db);
    const decision = transitionOrderState({
      fromState: "VALIDATED",
      toState: "RISK_REJECTED",
      occurredAt,
      reasonCode: "risk_limit_daily_loss_exceeded",
      metadata: {
        threshold_snapshot_id: "threshold-1",
      },
    });

    const orderEvent = await appendOrderStateTransitionEvent(db, {
      orderId: order.id,
      correlationId: "candidate-1",
      event: decision.event,
    });
    await appendAuditEvent(db, {
      eventType: "STATE_TRANSITION",
      severity: "WARN",
      occurredAt,
      actor: "risk-gate",
      reasonCode: "risk_limit_daily_loss_exceeded",
      orderId: order.id,
      correlationId: "candidate-1",
      metadata: {
        order_event_id: orderEvent.id,
      },
    });
    await appendRiskEvent(db, {
      riskType: "daily_loss_limit_exceeded",
      severity: "CRITICAL",
      action: "BLOCK_NEW_ORDER",
      orderId: order.id,
      occurredAt,
      payloadJson: {
        order_event_id: orderEvent.id,
      },
    });

    const events = await listOrderEventsByOrderId(db, { orderId: order.id });
    const auditCount = await db
      .selectFrom("audit_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const riskCount = await db
      .selectFrom("risk_events")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: orderEvent.id,
      order_id: order.id,
      from_status: "VALIDATED",
      to_status: "RISK_REJECTED",
      accepted: true,
      reason_code: "risk_limit_daily_loss_exceeded",
      correlation_id: "candidate-1",
    });
    expect(Number(auditCount.count)).toBe(1);
    expect(Number(riskCount.count)).toBe(1);
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

async function insertOrder(database: Database): Promise<{ id: string }> {
  return database
    .insertInto("orders")
    .values({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
      side: "BUY",
      order_type: "LIMIT",
      status: "VALIDATED",
      idempotency_key: "candidate-1",
      requested_price: "10000000",
      requested_quantity: "0.001",
      requested_notional: "10000",
      reason_json: {
        source: "integration-test",
      },
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}
