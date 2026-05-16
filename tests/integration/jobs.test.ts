import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  applyMigrations,
  claimPendingJobs,
  completeJob,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  enqueueJob,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("jobs queue integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("jobs").execute();
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

  it("blocks duplicate jobs by idempotency key", async () => {
    const db = await getDatabase();

    const first = await enqueueJob(db, {
      jobType: "policy.sync",
      idempotencyKey: "policy.sync:UPBIT:KRW-BTC",
      payloadJson: { attempt: 1 },
    });
    const duplicate = await enqueueJob(db, {
      jobType: "policy.sync",
      idempotencyKey: "policy.sync:UPBIT:KRW-BTC",
      payloadJson: { attempt: 2 },
    });
    const count = await db
      .selectFrom("jobs")
      .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    expect(Number(count.count)).toBe(1);
  });

  it("claims pending jobs without duplicate execution", async () => {
    const db = await getDatabase();
    const now = new Date("2026-05-16T00:00:00.000Z");

    await enqueueJob(db, {
      jobType: "market.backfill",
      idempotencyKey: "market.backfill:UPBIT:KRW-BTC:1",
      runAfter: new Date("2026-05-15T23:59:00.000Z"),
    });
    await enqueueJob(db, {
      jobType: "market.backfill",
      idempotencyKey: "market.backfill:UPBIT:KRW-BTC:2",
      runAfter: new Date("2026-05-15T23:59:30.000Z"),
    });
    await enqueueJob(db, {
      jobType: "market.backfill",
      idempotencyKey: "market.backfill:UPBIT:KRW-BTC:future",
      runAfter: new Date("2026-05-16T00:01:00.000Z"),
    });

    const firstClaim = await claimPendingJobs(db, {
      workerId: "worker-a",
      limit: 10,
      now,
    });
    const secondClaim = await claimPendingJobs(db, {
      workerId: "worker-b",
      limit: 10,
      now,
    });

    expect(firstClaim).toHaveLength(2);
    expect(firstClaim.map((job) => job.status)).toEqual(["RUNNING", "RUNNING"]);
    expect(firstClaim.map((job) => job.locked_by)).toEqual(["worker-a", "worker-a"]);
    expect(firstClaim.map((job) => job.attempt_count)).toEqual([1, 1]);
    expect(secondClaim).toEqual([]);
  });

  it("clears worker lock when a job completes", async () => {
    const db = await getDatabase();

    const enqueued = await enqueueJob(db, {
      jobType: "report.daily",
      idempotencyKey: "report.daily:2026-05-16",
      runAfter: new Date("2026-05-15T23:59:00.000Z"),
    });
    const [claimed] = await claimPendingJobs(db, {
      workerId: "worker-a",
      limit: 1,
      now: new Date("2026-05-16T00:00:00.000Z"),
    });

    expect(claimed?.id).toBe(enqueued.job.id);

    await expect(
      completeJob(db, {
        jobId: enqueued.job.id,
        workerId: "worker-b",
        completedAt: new Date("2026-05-16T00:01:00.000Z"),
      }),
    ).rejects.toThrow("running job lock was not found for the worker");

    const completed = await completeJob(db, {
      jobId: enqueued.job.id,
      workerId: "worker-a",
      completedAt: new Date("2026-05-16T00:01:00.000Z"),
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.locked_at).toBeNull();
    expect(completed.locked_by).toBeNull();
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
