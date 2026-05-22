import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  applyMigrations,
  claimJobByIdempotencyKey,
  claimPendingJobs,
  completeJob,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  enqueueJob,
  failJob,
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

  it("claims only the requested job type when a worker is scoped", async () => {
    const db = await getDatabase();
    const now = new Date("2026-05-16T00:00:00.000Z");

    await enqueueJob(db, {
      jobType: "report.daily",
      idempotencyKey: "report.daily:2026-05-16",
      runAfter: new Date("2026-05-15T23:59:00.000Z"),
    });
    await enqueueJob(db, {
      jobType: "policy.sync",
      idempotencyKey: "policy.sync:UPBIT",
      runAfter: new Date("2026-05-15T23:59:00.000Z"),
    });

    const claimed = await claimPendingJobs(db, {
      workerId: "daily-report-worker",
      jobType: "report.daily",
      limit: 10,
      now,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.job_type).toBe("report.daily");
  });

  it("claims by idempotency key and records retryable failures", async () => {
    const db = await getDatabase();
    const enqueued = await enqueueJob(db, {
      jobType: "report.daily",
      idempotencyKey: "report.daily:2026-05-17",
      runAfter: new Date("2026-05-16T00:00:00.000Z"),
      maxAttempts: 2,
    });
    const firstClaim = await claimJobByIdempotencyKey(db, {
      workerId: "daily-report-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      now: new Date("2026-05-16T00:01:00.000Z"),
    });

    expect(firstClaim?.status).toBe("RUNNING");
    expect(firstClaim?.attempt_count).toBe(1);

    const retryable = await failJob(db, {
      jobId: enqueued.job.id,
      workerId: "daily-report-worker",
      errorMessage: "fixture generation failed",
      failedAt: new Date("2026-05-16T00:02:00.000Z"),
      retryAfter: new Date("2026-05-16T00:03:00.000Z"),
    });

    expect(retryable.status).toBe("PENDING");
    expect(retryable.last_error).toBe("fixture generation failed");
    expect(new Date(retryable.run_after).toISOString()).toBe("2026-05-16T00:03:00.000Z");

    const secondClaim = await claimJobByIdempotencyKey(db, {
      workerId: "daily-report-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      now: new Date("2026-05-16T00:03:00.000Z"),
    });

    expect(secondClaim?.attempt_count).toBe(2);

    const exhausted = await failJob(db, {
      jobId: enqueued.job.id,
      workerId: "daily-report-worker",
      errorMessage: "fixture generation failed again",
      failedAt: new Date("2026-05-16T00:04:00.000Z"),
    });

    expect(exhausted.status).toBe("FAILED");
    expect(exhausted.locked_by).toBeNull();
    expect(exhausted.last_error).toBe("fixture generation failed again");
  });

  it("does not claim an idempotency key outside the requested job type", async () => {
    const db = await getDatabase();
    const enqueued = await enqueueJob(db, {
      jobType: "policy.sync",
      idempotencyKey: "report.daily:foreign-owner",
      runAfter: new Date("2026-05-16T00:00:00.000Z"),
    });

    const dailyReportClaim = await claimJobByIdempotencyKey(db, {
      workerId: "daily-report-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      jobType: "report.daily",
      now: new Date("2026-05-16T00:01:00.000Z"),
    });
    const policyClaim = await claimJobByIdempotencyKey(db, {
      workerId: "policy-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      jobType: "policy.sync",
      now: new Date("2026-05-16T00:01:00.000Z"),
    });

    expect(dailyReportClaim).toBeUndefined();
    expect(policyClaim?.status).toBe("RUNNING");
    expect(policyClaim?.job_type).toBe("policy.sync");
    expect(policyClaim?.locked_by).toBe("policy-worker");
  });

  it("can claim a pending idempotency key immediately for manual execution", async () => {
    const db = await getDatabase();
    const enqueued = await enqueueJob(db, {
      jobType: "report.daily",
      idempotencyKey: "report.daily:2026-05-18",
      runAfter: new Date("2026-05-18T15:00:00.000Z"),
    });

    const scheduledClaim = await claimJobByIdempotencyKey(db, {
      workerId: "daily-report-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      now: new Date("2026-05-18T14:00:00.000Z"),
    });
    const manualClaim = await claimJobByIdempotencyKey(db, {
      workerId: "daily-report-worker",
      idempotencyKey: enqueued.job.idempotency_key,
      now: new Date("2026-05-18T14:00:00.000Z"),
      ignoreRunAfter: true,
    });

    expect(scheduledClaim).toBeUndefined();
    expect(manualClaim?.status).toBe("RUNNING");
    expect(manualClaim?.locked_by).toBe("daily-report-worker");
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
