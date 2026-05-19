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

interface PersistInputOptions {
  idempotencyKey?: string;
  brokerOrderId?: string;
  requestedQuantity?: string;
  requestedNotional?: string;
  filledQuantity?: string;
  totalFillNotional?: string;
  totalFee?: string;
}

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
    await expect(
      repository.persistPaperExecution(
        createPersistInput({
          idempotencyKey: "execution-integration-1",
          brokerOrderId: "paper-order-conflict",
          requestedQuantity: "0.001",
          requestedNotional: "10000",
          filledQuantity: "0.001",
          totalFillNotional: "9990",
          totalFee: "4.995",
        }),
      ),
    ).rejects.toThrow("paper execution idempotency key conflict");
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

  it("rejects broker orders that do not match the submitted intent", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput();

    await expect(
      repository.persistPaperExecution({
        ...input,
        brokerOrder: {
          ...input.brokerOrder,
          market: "KRW-ETH",
        },
      }),
    ).rejects.toThrow("broker order does not match execution submission");

    await expectTableCount(db, "orders", 0);
  });

  it("rejects filled broker statuses without fill evidence", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput();

    await expect(
      repository.persistPaperExecution({
        ...input,
        brokerOrder: {
          ...input.brokerOrder,
          metadata: {
            source: "missing-fill-evidence-test",
          },
        },
      }),
    ).rejects.toThrow("filled paper execution requires fill evidence");

    await expectTableCount(db, "orders", 0);
  });

  it("rejects simulation quantities that do not match broker order accounting", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput();
    const simulation = readSimulation(input);
    const invalidSimulation: PaperFillSimulationResult = {
      ...simulation,
      filledQuantity: "0.003",
      fills: [
        {
          price: "9990000",
          quantity: "0.003",
          notional: "29970",
          fee: "14.985",
          liquidity: "TAKER",
        },
      ],
    };

    await expect(
      repository.persistPaperExecution({
        ...input,
        brokerOrder: {
          ...input.brokerOrder,
          metadata: {
            ...(input.brokerOrder.metadata ?? {}),
            paper_fill_simulation: invalidSimulation,
          },
        },
      }),
    ).rejects.toThrow("paper simulation quantities do not add up to requested quantity");

    await expectTableCount(db, "orders", 0);
  });

  it("rejects broker and simulation final status mismatches", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput();
    const simulation = readSimulation(input);

    await expect(
      repository.persistPaperExecution({
        ...input,
        brokerOrder: {
          ...input.brokerOrder,
          metadata: {
            ...(input.brokerOrder.metadata ?? {}),
            paper_fill_simulation: {
              ...simulation,
              orderStatus: "CANCELED",
            },
          },
        },
      }),
    ).rejects.toThrow("paper simulation order status does not match broker order status");

    await expectTableCount(db, "orders", 0);
  });

  it("allows idempotent retries after DB notional scale normalization", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const input = createPersistInput({
      idempotencyKey: "execution-scale-retry-1",
      brokerOrderId: "paper-order-scale-retry-1",
      requestedNotional: "20000.123456789",
    });

    const receipt = await repository.persistPaperExecution(input);
    const retryReceipt = await repository.persistPaperExecution(input);

    expect(receipt.created).toBe(true);
    expect(retryReceipt).toMatchObject({
      created: false,
      order: {
        id: receipt.order.id,
      },
    });
    await expectTableCount(db, "orders", 1);
  });

  it("keeps first BUY position writes atomic for concurrent fills", async () => {
    const db = await getDatabase();
    const repository = new PostgresExecutionPersistenceRepository(db);
    const firstInput = createPersistInput({
      idempotencyKey: "execution-concurrent-1",
      brokerOrderId: "paper-order-concurrent-1",
      requestedQuantity: "0.001",
      requestedNotional: "10000",
      filledQuantity: "0.001",
      totalFillNotional: "9990",
      totalFee: "4.995",
    });
    const secondInput = createPersistInput({
      idempotencyKey: "execution-concurrent-2",
      brokerOrderId: "paper-order-concurrent-2",
      requestedQuantity: "0.002",
      requestedNotional: "20000",
      filledQuantity: "0.002",
      totalFillNotional: "19980",
      totalFee: "9.99",
    });

    await Promise.all([
      repository.persistPaperExecution(firstInput),
      repository.persistPaperExecution(secondInput),
    ]);

    const position = await db
      .selectFrom("positions")
      .selectAll()
      .where("exchange", "=", "upbit_krw_spot")
      .where("market", "=", "KRW-BTC")
      .where("strategy_id", "=", "trend_following")
      .executeTakeFirstOrThrow();
    const orderCount = await db
      .selectFrom("orders")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const fillCount = await db
      .selectFrom("fills")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(Number(orderCount.count)).toBe(2);
    expect(Number(fillCount.count)).toBe(2);
    expectNumericEqual(position.quantity, "0.003");
    expectNumericEqual(position.average_entry_price, "9990000");
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

async function expectTableCount(
  database: Database,
  table: "orders" | "paper_orders" | "fills" | "positions" | "order_events",
  expectedCount: number,
): Promise<void> {
  const rowCount = await database
    .selectFrom(table)
    .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();

  expect(Number(rowCount.count)).toBe(expectedCount);
}

function expectNumericEqual(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  expect(parseFinancialDecimal(actual).eq(parseFinancialDecimal(expected))).toBe(true);
}

function readSimulation(input: PersistPaperExecutionInput): PaperFillSimulationResult {
  return input.brokerOrder.metadata?.paper_fill_simulation as PaperFillSimulationResult;
}

function createPersistInput(options: PersistInputOptions = {}): PersistPaperExecutionInput {
  const idempotencyKey = options.idempotencyKey ?? "execution-integration-1";
  const brokerOrderId = options.brokerOrderId ?? "paper-order-1";
  const requestedQuantity = options.requestedQuantity ?? "0.002";
  const requestedNotional = options.requestedNotional ?? "20000";
  const filledQuantity = options.filledQuantity ?? requestedQuantity;
  const totalFillNotional = options.totalFillNotional ?? "19980";
  const totalFee = options.totalFee ?? "9.99";
  const intent: LimitOrderIntent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "trend_following",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "10000000",
    requestedQuantity,
    requestedNotional,
    idempotencyKey,
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
    requestedQuantity,
    filledQuantity,
    openQuantity: "0",
    canceledQuantity: "0",
    averageFillPrice: "9990000",
    totalFillNotional,
    totalFee,
    fills: [
      {
        price: "9990000",
        quantity: filledQuantity,
        notional: totalFillNotional,
        fee: totalFee,
        liquidity: "TAKER",
      },
    ],
    orderbookReceivedAt,
  };
  const brokerOrder: BrokerOrder = {
    brokerOrderId,
    idempotencyKey,
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "FILLED",
    requestedQuantity,
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
