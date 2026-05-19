import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PaperFillSimulationResult } from "../../src/application/index.js";
import type {
  BrokerOrder,
  LimitOrderIntent,
  OrderSubmission,
} from "../../src/domain/index.js";
import { parseFinancialDecimal } from "../../src/shared/index.js";
import {
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
  PostgresExecutionPersistenceRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database, PersistPaperExecutionInput } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;
const submittedAt = "2026-05-19T02:00:00.000Z";
const updatedAt = "2026-05-19T02:00:02.000Z";
const orderbookReceivedAt = "2026-05-19T02:00:01.000Z";

describeDb("execution persistence integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("fills").execute();
    await db.deleteFrom("paper_orders").execute();
    await db.deleteFrom("order_events").execute();
    await db.deleteFrom("positions").execute();
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

  it("persists paper execution rows once per idempotency key", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput();

    const receipt = await repository.persistPaperExecution(input);
    const duplicateReceipt = await repository.persistPaperExecution(input);

    const order = await db
      .selectFrom("orders")
      .selectAll()
      .where("id", "=", receipt.order.id)
      .executeTakeFirstOrThrow();
    const paperOrder = await db
      .selectFrom("paper_orders")
      .selectAll()
      .where("order_id", "=", receipt.order.id)
      .executeTakeFirstOrThrow();
    const fills = await db
      .selectFrom("fills")
      .selectAll()
      .where("order_id", "=", receipt.order.id)
      .execute();
    const events = await db
      .selectFrom("order_events")
      .selectAll()
      .where("order_id", "=", receipt.order.id)
      .execute();
    const position = await db
      .selectFrom("positions")
      .selectAll()
      .where("exchange", "=", "upbit_krw_spot")
      .where("market", "=", "KRW-BTC")
      .where("strategy_id", "=", "trend_following")
      .executeTakeFirstOrThrow();

    expect(receipt.created).toBe(true);
    expect(duplicateReceipt).toMatchObject({
      created: false,
      order: {
        id: receipt.order.id,
      },
      fills: [],
      orderEvents: [],
    });
    expect(order.status).toBe("FILLED");
    expect(paperOrder).toMatchObject({
      order_id: receipt.order.id,
      post_only: false,
      time_in_force: "GTC",
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      fee_currency: "KRW",
      liquidity: "TAKER",
    });
    expectNumericEqual(fills[0]?.price, "9990000");
    expectNumericEqual(fills[0]?.quantity, "0.002");
    expectNumericEqual(fills[0]?.fee, "9.99");
    expect(receipt.orderEvents.map((event) => `${event.from_status}->${event.to_status}`)).toEqual([
      "RISK_APPROVED->SUBMITTED",
      "SUBMITTED->ACCEPTED",
      "ACCEPTED->FILLED",
    ]);
    expect(events).toHaveLength(3);
    expect(position).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend_following",
    });
    expectNumericEqual(position.quantity, "0.002");
    expectNumericEqual(position.average_entry_price, "9990000");
    expectNumericEqual(position.realized_pnl, "0");
    await expectSingleExecutionRows(db);
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

async function expectSingleExecutionRows(database: Database): Promise<void> {
  const orderCount = await database
    .selectFrom("orders")
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const paperOrderCount = await database
    .selectFrom("paper_orders")
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const fillCount = await database
    .selectFrom("fills")
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const positionCount = await database
    .selectFrom("positions")
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const orderEventCount = await database
    .selectFrom("order_events")
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();

  expect(Number(orderCount.count)).toBe(1);
  expect(Number(paperOrderCount.count)).toBe(1);
  expect(Number(fillCount.count)).toBe(1);
  expect(Number(positionCount.count)).toBe(1);
  expect(Number(orderEventCount.count)).toBe(3);
}

function expectNumericEqual(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(parseFinancialDecimal(actual).eq(parseFinancialDecimal(expected))).toBe(true);
}

function createPersistInput(): PersistPaperExecutionInput {
  const intent: LimitOrderIntent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity: "0.002",
    requestedNotional: "20000",
    idempotencyKey: "execution-integration-1",
    reason: "integration-test-order",
    timeInForce: "GTC",
  };
  const submission: OrderSubmission = {
    intent,
    costSnapshot: {
      trade_allowed: true,
      source: "cost-model",
    },
    riskApproval: {
      status: "APPROVED",
      source: "risk-gate",
    },
    expectedLossBpsOfEquity: "12",
    submittedAt,
  };
  const simulation: PaperFillSimulationResult = {
    status: "FILLED",
    orderStatus: "FILLED",
    reasonCode: "limit_crossed_full",
    requestedQuantity: "0.002",
    filledQuantity: "0.002",
    openQuantity: "0",
    canceledQuantity: "0",
    averageFillPrice: "9990000",
    totalFillNotional: "19980",
    totalFee: "9.99",
    fills: [
      {
        price: "9990000",
        quantity: "0.002",
        notional: "19980",
        fee: "9.99",
        liquidity: "TAKER",
      },
    ],
    orderbookReceivedAt,
  };
  const brokerOrder: BrokerOrder = {
    brokerOrderId: "paper-order-1",
    idempotencyKey: "execution-integration-1",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "FILLED",
    requestedQuantity: "0.002",
    remainingQuantity: "0",
    requestedPrice: "10000000",
    acceptedAt: updatedAt,
    updatedAt,
    metadata: {
      paper_fill_simulation: simulation,
      balance_mutation_applied: true,
    },
  };

  return {
    submission,
    brokerOrder,
    correlationId: "candidate-integration-1",
  };
}
