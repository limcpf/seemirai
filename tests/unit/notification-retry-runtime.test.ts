import { describe, expect, it } from "vitest";
import type {
  AlertNotification,
  AuditEvent,
  AuditEventReceipt,
  AuditLogPort,
  DailyReportNotification,
  NotificationResult,
  NotificationRetryJobPlan,
  NotifierPort,
} from "../../src/application/index.js";
import {
  createInMemoryAlertCooldownStore,
  createNotificationRetryJobPlan,
} from "../../src/application/index.js";
import type { JobRecord } from "../../src/infrastructure/index.js";
import {
  createPaperNoKeyNotificationRetryRuntime,
  type NotificationRetryRuntimeJobQueue,
} from "../../src/runtime/index.js";

describe("notification retry runtime", () => {
  it("claims notification_retry jobs and completes them after provider delivery", async () => {
    const jobQueue = new MemoryNotificationRetryJobQueue();
    const notifier = new SequenceNotifier([{ delivered: true, providerMessageId: "telegram-retry-1" }]);
    const auditLog = new CapturingAuditLog();
    const runtime = createPaperNoKeyNotificationRetryRuntime({
      database: {} as never,
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
      auditLog,
      jobQueue,
      clock: () => new Date("2026-05-22T00:01:00.000Z"),
    });

    await runtime.enqueueNotificationRetryJob(createRetryPlan({ maxAttempts: 2 }));
    const results = await runtime.runDueNotificationRetryJobs({
      now: "2026-05-22T00:01:00.000Z",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "DELIVERED",
      finalJob: {
        status: "COMPLETED",
        attempt_count: 1,
      },
    });
    expect(notifier.alerts).toHaveLength(1);
    expect(auditLog.events.map((event) => event.reasonCode)).toContain("notification_retry_delivered");
  });

  it("reschedules failed retry jobs and emits manual review evidence when attempts are exhausted", async () => {
    const jobQueue = new MemoryNotificationRetryJobQueue();
    const notifier = new SequenceNotifier([
      { delivered: false, skippedReason: "telegram_http_500" },
      { delivered: false, skippedReason: "telegram_http_500" },
    ]);
    const auditLog = new CapturingAuditLog();
    const runtime = createPaperNoKeyNotificationRetryRuntime({
      database: {} as never,
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
      auditLog,
      jobQueue,
      clock: () => new Date("2026-05-22T00:01:00.000Z"),
    });

    await runtime.enqueueNotificationRetryJob(createRetryPlan({ maxAttempts: 2 }));
    const [first] = await runtime.runDueNotificationRetryJobs({
      now: "2026-05-22T00:01:00.000Z",
    });
    const [second] = await runtime.runDueNotificationRetryJobs({
      now: "2026-05-22T00:02:00.000Z",
    });

    expect(first).toMatchObject({
      status: "RETRY_SCHEDULED",
      finalJob: {
        status: "PENDING",
        attempt_count: 1,
        last_error: "notification retry failed: telegram_http_500",
      },
    });
    expect(second).toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
      finalJob: {
        status: "FAILED",
        attempt_count: 2,
        last_error: "notification retry failed: telegram_http_500",
      },
    });
    expect(auditLog.events.at(-1)).toMatchObject({
      eventType: "NOTIFICATION_DELIVERY",
      severity: "CRITICAL",
      reasonCode: "notification_retry_manual_review_required",
      correlationId: "corr-notification-retry",
      metadata: {
        final_status: "FAILED",
        manual_review_reason_code: "notification_consecutive_failure",
      },
    });
  });

  it("keeps malformed retry payloads in job failure evidence without provider calls", async () => {
    const jobQueue = new MemoryNotificationRetryJobQueue();
    const notifier = new SequenceNotifier([{ delivered: true }]);
    const runtime = createPaperNoKeyNotificationRetryRuntime({
      database: {} as never,
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
      auditLog: new CapturingAuditLog(),
      jobQueue,
      clock: () => new Date("2026-05-22T00:01:00.000Z"),
    });

    await jobQueue.enqueueNotificationRetryJob({
      jobType: "notification_retry",
      idempotencyKey: "notification_retry:invalid",
      payloadJson: {},
      runAfter: "2026-05-22T00:00:00.000Z",
      maxAttempts: 1,
    });
    const [result] = await runtime.runDueNotificationRetryJobs({
      now: "2026-05-22T00:01:00.000Z",
    });

    expect(result).toMatchObject({
      status: "INVALID_PAYLOAD",
      finalJob: {
        status: "FAILED",
      },
    });
    expect(result?.errorMessage).toContain("notification retry payload field severity");
    expect(notifier.alerts).toHaveLength(0);
  });
});

class MemoryNotificationRetryJobQueue implements NotificationRetryRuntimeJobQueue {
  public readonly jobs: JobRecord[] = [];

  public async enqueueNotificationRetryJob(plan: NotificationRetryJobPlan) {
    const existing = this.jobs.find((job) => job.idempotency_key === plan.idempotencyKey);
    if (existing !== undefined) {
      return {
        jobType: "notification_retry" as const,
        idempotencyKey: existing.idempotency_key,
        created: false,
        jobId: existing.id,
      };
    }

    const now = new Date("2026-05-22T00:00:00.000Z");
    const job: JobRecord = {
      id: `job-${this.jobs.length + 1}`,
      job_type: plan.jobType,
      idempotency_key: plan.idempotencyKey,
      payload_json: plan.payloadJson,
      status: "PENDING",
      run_after: toDate(plan.runAfter),
      locked_at: null,
      locked_by: null,
      attempt_count: 0,
      max_attempts: plan.maxAttempts,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.jobs.push(job);

    return {
      jobType: "notification_retry" as const,
      idempotencyKey: job.idempotency_key,
      created: true,
      jobId: job.id,
    };
  }

  public async claimDueNotificationRetryJobs(options: { workerId: string; limit?: number; now?: Date | string }) {
    const now = toDate(options.now ?? new Date());
    const limit = options.limit ?? 1;
    const claimable = this.jobs
      .filter((job) => (
        job.job_type === "notification_retry" &&
        job.status === "PENDING" &&
        job.run_after.getTime() <= now.getTime() &&
        job.attempt_count < job.max_attempts
      ))
      .sort((left, right) => left.run_after.getTime() - right.run_after.getTime())
      .slice(0, limit);

    for (const job of claimable) {
      job.status = "RUNNING";
      job.locked_at = now;
      job.locked_by = options.workerId;
      job.attempt_count += 1;
      job.updated_at = now;
    }

    return claimable.map((job) => ({ ...job }));
  }

  public async completeNotificationRetryJob(options: { jobId: string; workerId: string; completedAt?: Date | string }) {
    const job = this.findRunningJob(options.jobId, options.workerId);
    const completedAt = toDate(options.completedAt ?? new Date());
    job.status = "COMPLETED";
    job.locked_at = null;
    job.locked_by = null;
    job.updated_at = completedAt;
    return { ...job };
  }

  public async failNotificationRetryJob(options: {
    jobId: string;
    workerId: string;
    errorMessage: string;
    failedAt?: Date | string;
    retryAfter?: Date | string;
  }) {
    const job = this.findRunningJob(options.jobId, options.workerId);
    const failedAt = toDate(options.failedAt ?? new Date());
    job.status = job.attempt_count < job.max_attempts ? "PENDING" : "FAILED";
    job.run_after = toDate(options.retryAfter ?? failedAt);
    job.locked_at = null;
    job.locked_by = null;
    job.last_error = options.errorMessage;
    job.updated_at = failedAt;
    return { ...job };
  }

  private findRunningJob(jobId: string, workerId: string): JobRecord {
    const job = this.jobs.find((candidate) => (
      candidate.id === jobId &&
      candidate.status === "RUNNING" &&
      candidate.locked_by === workerId
    ));
    if (job === undefined) {
      throw new Error("running job lock was not found for the worker");
    }

    return job;
  }
}

class SequenceNotifier implements NotifierPort {
  public readonly alerts: AlertNotification[] = [];

  public constructor(private readonly results: NotificationResult[]) {}

  public async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    this.alerts.push(notification);
    return this.results.shift() ?? { delivered: true };
  }

  public async sendDailyReport(_notification: DailyReportNotification): Promise<NotificationResult> {
    return { delivered: true };
  }
}

class CapturingAuditLog implements AuditLogPort {
  public readonly events: AuditEvent[] = [];

  public async appendEvent(event: AuditEvent): Promise<AuditEventReceipt> {
    this.events.push(event);
    return {
      auditEventId: `audit-${this.events.length}`,
      appendedAt: event.occurredAt,
    };
  }
}

function createRetryPlan(options: { maxAttempts: number }): NotificationRetryJobPlan {
  const plan = createNotificationRetryJobPlan({
    fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
    occurredAt: "2026-05-22T00:00:00.000Z",
    request: {
      environment: "prod",
      runMode: "paper",
      severity: "P1",
      alertType: "lag",
      market: "KRW-BTC",
      reasonCode: "public_websocket_lag",
      title: "WebSocket lag",
      body: "lag exceeded threshold",
      correlationId: "corr-notification-retry",
    },
  });

  return {
    ...plan,
    maxAttempts: options.maxAttempts,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
