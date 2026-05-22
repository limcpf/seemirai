import type {
  AlertCooldownStore,
  AlertDispatchServiceOptions,
  AuditEventReceipt,
  AuditLogPort,
  NotificationRetryJobEnqueueReceipt,
  NotificationRetryJobPlan,
  NotificationRetryJobQueue,
  NotifierPort,
} from "../../application/index.js";
import {
  NotificationRetryPayloadError,
  dispatchNotificationRetryJob,
  notificationRetryJobType,
} from "../../application/index.js";
import {
  PostgresAlertCooldownRepository,
  PostgresAuditLogRepository,
  claimPendingJobs,
  completeJob,
  enqueueJob,
  failJob,
} from "../../infrastructure/index.js";
import type {
  ClaimPendingJobsOptions,
  CompleteJobOptions,
  Database,
  EnqueueJobResult,
  FailJobOptions,
  JobRecord,
} from "../../infrastructure/index.js";

export const PAPER_NO_KEY_NOTIFICATION_RETRY_WORKER_ID = "paper_no_key_notification_retry_worker";
export const NOTIFICATION_RETRY_FAILURE_DELAY_MS = 60_000;

export type NotificationRetryRuntimeJobStatus =
  | "DELIVERED"
  | "COOLDOWN_SKIPPED"
  | "RETRY_SCHEDULED"
  | "MANUAL_REVIEW_REQUIRED"
  | "INVALID_PAYLOAD";

/**
 * notification retry runtime의 queue adapter가 구현해야 하는 job lifecycle 경계다.
 *
 * application layer의 enqueue port에 claim/complete/fail을 더해 worker runtime이 PostgreSQL jobs table 또는 테스트용 in-memory
 * queue를 같은 방식으로 다룰 수 있게 한다. 구현체는 `notification_retry` job type만 claim해야 하며, 다른 job type을 처리하면
 * daily report나 policy worker 책임 row와 side effect가 섞인다.
 */
export interface NotificationRetryRuntimeJobQueue extends NotificationRetryJobQueue {
  claimDueNotificationRetryJobs(options: NotificationRetryRuntimeQueueClaimOptions): Promise<JobRecord[]>;
  completeNotificationRetryJob(options: CompleteJobOptions): Promise<JobRecord>;
  failNotificationRetryJob(options: FailJobOptions): Promise<JobRecord>;
}

/**
 * notification retry queue claim 조건이다.
 *
 * workerId는 jobs lock 소유권 검증에 쓰이고, limit/now는 due job 조회에만 적용된다. runtime은 한 job씩 claim하고 실행해
 * provider side effect가 중간 crash 때 어떤 row까지 진행됐는지 명확하게 남긴다.
 */
export interface NotificationRetryRuntimeQueueClaimOptions {
  workerId: string;
  limit?: number;
  now?: Date | string;
}

/**
 * notification retry runtime 조립에 필요한 외부 의존성이다.
 *
 * database는 jobs lifecycle, durable cooldown, audit evidence를 같은 PostgreSQL에 남긴다. notifier는 Telegram 같은 외부
 * provider side effect를 수행하고, retry worker는 이 실패를 원 업무 commit과 분리해 jobs 상태로 수렴시킨다.
 */
export interface NotificationRetryRuntimeDependencies {
  database: Database;
  notifier: NotifierPort;
  durableCooldownStore?: AlertCooldownStore;
  memoryCooldownStore?: AlertCooldownStore;
  auditLog?: AuditLogPort;
  jobQueue?: NotificationRetryRuntimeJobQueue;
  workerId?: string;
  clock?: () => Date;
  actor?: string;
}

/**
 * scheduler가 현재 due 상태인 notification retry job을 처리할 때 쓰는 조건이다.
 *
 * limit가 1보다 커도 runtime은 claim과 실행을 한 건 단위로 반복한다. 배치 전체를 먼저 RUNNING으로 바꾸지 않아야 중간 crash 때
 * 아직 실행하지 않은 row가 재claim 불가능한 상태로 남지 않는다.
 */
export interface RunDueNotificationRetryJobsOptions {
  limit?: number;
  now?: Date | string;
}

/**
 * claim된 notification retry job 하나의 실행 결과다.
 *
 * job은 claim 직후 상태, finalJob은 complete/fail 전이 후 상태다. auditEventReceipts는 retry worker 자체가 남긴 job evidence만
 * 포함하며, alert dispatch 내부의 delivery audit은 별도 port 호출로 기록된다.
 */
export interface ClaimedNotificationRetryJobRunResult {
  job: JobRecord;
  status: NotificationRetryRuntimeJobStatus;
  finalJob: JobRecord;
  auditEventReceipts: AuditEventReceipt[];
  errorMessage?: string;
}

/**
 * PAPER_NO_KEY notification retry runtime public contract다.
 *
 * alert dispatch는 P0/P1 provider failure를 `enqueueNotificationRetryJob`으로 예약하고, scheduler는
 * `runDueNotificationRetryJobs`를 주기적으로 호출한다. runtime은 Telegram provider 실패를 원 주문/리스크/kill switch commit과
 * 분리하고, 재시도 한도 소진 시 manual review evidence를 남긴다.
 */
export interface PaperNoKeyNotificationRetryRuntime extends NotificationRetryJobQueue {
  runDueNotificationRetryJobs(
    options?: RunDueNotificationRetryJobsOptions,
  ): Promise<ClaimedNotificationRetryJobRunResult[]>;
}

/**
 * PostgreSQL jobs queue를 notification retry job queue port로 감싼다.
 *
 * enqueue는 `notification_retry` job plan의 idempotency key를 그대로 사용하고, claim은 job type을 항상 고정해 공용 jobs table의
 * 다른 worker row를 가져오지 않는다.
 */
export function createPostgresNotificationRetryJobQueue(
  database: Database,
): NotificationRetryRuntimeJobQueue {
  return {
    async enqueueNotificationRetryJob(plan) {
      const result = await enqueueJob(database, {
        jobType: plan.jobType,
        idempotencyKey: plan.idempotencyKey,
        payloadJson: plan.payloadJson,
        runAfter: plan.runAfter,
        maxAttempts: plan.maxAttempts,
      });
      return toNotificationRetryJobEnqueueReceipt(result);
    },
    claimDueNotificationRetryJobs(options) {
      const claimOptions: ClaimPendingJobsOptions = {
        workerId: options.workerId,
        jobType: notificationRetryJobType,
        limit: options.limit ?? 1,
        ...(options.now === undefined ? {} : { now: options.now }),
      };
      return claimPendingJobs(database, claimOptions);
    },
    completeNotificationRetryJob(options) {
      return completeJob(database, options);
    },
    failNotificationRetryJob(options) {
      return failJob(database, options);
    },
  };
}

/**
 * PostgreSQL jobs queue와 NotifierPort를 notification retry worker로 조립한다.
 *
 * 반환된 runtime은 live/private exchange API를 사용하지 않고 Telegram outbound 재전송만 수행한다. retry 실패는 jobs row
 * 상태와 audit evidence로 남기며, 원 업무 commit이나 이전 alert audit을 되돌리지 않는다.
 */
export function createPaperNoKeyNotificationRetryRuntime(
  dependencies: NotificationRetryRuntimeDependencies,
): PaperNoKeyNotificationRetryRuntime {
  const workerId = dependencies.workerId ?? PAPER_NO_KEY_NOTIFICATION_RETRY_WORKER_ID;
  const queue = dependencies.jobQueue ?? createPostgresNotificationRetryJobQueue(dependencies.database);
  const auditLog = dependencies.auditLog ?? new PostgresAuditLogRepository(dependencies.database);
  const durableCooldownStore = dependencies.durableCooldownStore
    ?? new PostgresAlertCooldownRepository(dependencies.database);

  return {
    enqueueNotificationRetryJob(plan) {
      return queue.enqueueNotificationRetryJob(plan);
    },

    async runDueNotificationRetryJobs(options = {}) {
      const limit = options.limit ?? 1;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("notification retry job run limit must be a positive safe integer");
      }

      const results: ClaimedNotificationRetryJobRunResult[] = [];
      for (let claimedCount = 0; claimedCount < limit; claimedCount += 1) {
        const [job] = await queue.claimDueNotificationRetryJobs({
          workerId,
          limit: 1,
          ...(options.now === undefined ? {} : { now: options.now }),
        });

        if (job === undefined) {
          break;
        }

        results.push(
          await runClaimedNotificationRetryJob({
            job,
            workerId,
            queue,
            auditLog,
            alertDispatch: {
              notifier: dependencies.notifier,
              durableCooldownStore,
              ...(dependencies.memoryCooldownStore === undefined
                ? {}
                : { memoryCooldownStore: dependencies.memoryCooldownStore }),
              auditLog,
              ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
            },
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
            ...(options.now === undefined ? {} : { claimNow: options.now }),
            ...(dependencies.actor === undefined ? {} : { actor: dependencies.actor }),
          }),
        );
      }

      return results;
    },
  };
}

async function runClaimedNotificationRetryJob(input: {
  job: JobRecord;
  workerId: string;
  queue: NotificationRetryRuntimeJobQueue;
  auditLog: AuditLogPort;
  alertDispatch: AlertDispatchServiceOptions;
  clock?: () => Date;
  claimNow?: Date | string;
  actor?: string;
}): Promise<ClaimedNotificationRetryJobRunResult> {
  try {
    const dispatchResult = await dispatchNotificationRetryJob({
      alertDispatch: input.alertDispatch,
      payloadJson: input.job.payload_json,
    });
    const occurredAt = resolveWorkerTimestamp(
      input.clock,
      input.job.locked_at ?? input.claimNow,
    );

    if (dispatchResult.status === "DELIVERED" || dispatchResult.status === "COOLDOWN_SKIPPED") {
      // provider 성공 또는 cooldown skip은 같은 retry row를 다시 실행하지 않도록 완료 상태로 고정한다.
      const finalJob = await input.queue.completeNotificationRetryJob({
        jobId: input.job.id,
        workerId: input.workerId,
        completedAt: occurredAt,
      });
      const auditEventReceipts = await appendNotificationRetryAuditSafely(input.auditLog, {
        job: input.job,
        finalJob,
        workerId: input.workerId,
        occurredAt,
        reasonCode: dispatchResult.status === "DELIVERED"
          ? "notification_retry_delivered"
          : "notification_retry_cooldown_skipped",
        severity: "INFO",
        metadata: {
          delivered: dispatchResult.alertDispatch.notification.delivered,
          cooldown_hit: dispatchResult.alertDispatch.cooldownHit,
          skipped_reason: dispatchResult.alertDispatch.notification.skippedReason ?? null,
          provider_message_id: dispatchResult.alertDispatch.notification.providerMessageId ?? null,
          fingerprint: dispatchResult.alertDispatch.fingerprint,
        },
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      });

      return {
        job: input.job,
        status: dispatchResult.status,
        finalJob,
        auditEventReceipts,
      };
    }

    const failed = await failNotificationRetryJobWithEvidence(input, {
      occurredAt,
      errorMessage: dispatchResult.errorMessage ?? "notification retry failed",
      dispatchMetadata: {
        delivered: dispatchResult.alertDispatch.notification.delivered,
        skipped_reason: dispatchResult.alertDispatch.notification.skippedReason ?? null,
        fingerprint: dispatchResult.alertDispatch.fingerprint,
      },
    });

    return failed;
  } catch (error) {
    const occurredAt = resolveWorkerTimestamp(
      input.clock,
      input.job.locked_at ?? input.claimNow,
    );
    return failNotificationRetryJobWithEvidence(input, {
      occurredAt,
      errorMessage: `notification retry worker failed: ${toErrorMessage(error)}`,
      dispatchMetadata: {},
      invalidPayload: error instanceof NotificationRetryPayloadError,
    });
  }
}

async function failNotificationRetryJobWithEvidence(
  input: {
    job: JobRecord;
    workerId: string;
    queue: NotificationRetryRuntimeJobQueue;
    auditLog: AuditLogPort;
    clock?: () => Date;
    actor?: string;
  },
  failure: {
    occurredAt: Date;
    errorMessage: string;
    dispatchMetadata: Record<string, unknown>;
    invalidPayload?: boolean;
  },
): Promise<ClaimedNotificationRetryJobRunResult> {
  const finalJob = await input.queue.failNotificationRetryJob({
    jobId: input.job.id,
    workerId: input.workerId,
    errorMessage: failure.errorMessage,
    failedAt: failure.occurredAt,
    retryAfter: new Date(failure.occurredAt.getTime() + NOTIFICATION_RETRY_FAILURE_DELAY_MS),
  });
  const manualReviewRequired = finalJob.status === "FAILED";
  const reasonCode = manualReviewRequired
    ? "notification_retry_manual_review_required"
    : "notification_retry_failed";
  const auditEventReceipts = await appendNotificationRetryAuditSafely(input.auditLog, {
    job: input.job,
    finalJob,
    workerId: input.workerId,
    occurredAt: failure.occurredAt,
    reasonCode,
    severity: manualReviewRequired ? "CRITICAL" : "ERROR",
    metadata: {
      ...failure.dispatchMetadata,
      error_message: failure.errorMessage,
      retry_after: finalJob.status === "PENDING" ? finalJob.run_after.toISOString() : null,
      manual_review_reason_code: manualReviewRequired ? "notification_consecutive_failure" : null,
      invalid_payload: failure.invalidPayload === true,
    },
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });

  return {
    job: input.job,
    status: failure.invalidPayload === true
      ? "INVALID_PAYLOAD"
      : manualReviewRequired
        ? "MANUAL_REVIEW_REQUIRED"
        : "RETRY_SCHEDULED",
    finalJob,
    auditEventReceipts,
    errorMessage: failure.errorMessage,
  };
}

async function appendNotificationRetryAuditSafely(
  auditLog: AuditLogPort,
  input: {
    job: JobRecord;
    finalJob: JobRecord;
    workerId: string;
    occurredAt: Date;
    actor?: string;
    reasonCode: string;
    severity: "INFO" | "ERROR" | "CRITICAL";
    metadata: Record<string, unknown>;
  },
): Promise<AuditEventReceipt[]> {
  try {
    const correlationId = readCorrelationId(input.job);
    return [
      await auditLog.appendEvent({
        eventType: "NOTIFICATION_DELIVERY",
        severity: input.severity,
        occurredAt: input.occurredAt,
        actor: input.actor ?? "notification_retry_worker",
        reasonCode: input.reasonCode,
        ...(correlationId === undefined ? {} : { correlationId }),
        metadata: {
          job_id: input.job.id,
          job_type: input.job.job_type,
          idempotency_key: input.job.idempotency_key,
          worker_id: input.workerId,
          attempt_count: input.job.attempt_count,
          max_attempts: input.job.max_attempts,
          final_status: input.finalJob.status,
          ...input.metadata,
        },
      }),
    ];
  } catch {
    // 이미 provider와 job 상태 전이가 끝났으므로 audit 저장 실패 때문에 같은 Telegram retry를 반복하지 않는다.
    return [];
  }
}

function toNotificationRetryJobEnqueueReceipt(
  result: EnqueueJobResult,
): NotificationRetryJobEnqueueReceipt {
  return {
    jobType: notificationRetryJobType,
    idempotencyKey: result.job.idempotency_key,
    jobId: result.job.id,
    created: result.created,
  };
}

function readCorrelationId(job: JobRecord): string | undefined {
  const value = job.payload_json.correlation_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveWorkerTimestamp(
  clock: (() => Date) | undefined,
  lowerBound: Date | string | null | undefined,
): Date {
  const current = clock?.() ?? new Date();
  if (lowerBound === null || lowerBound === undefined) {
    return current;
  }

  const lowerBoundDate = toDate(lowerBound);
  // claim 시각보다 과거로 재예약하면 같은 due row를 즉시 재claim할 수 있으므로 worker 시각의 하한을 claim 시각으로 둔다.
  return current.getTime() >= lowerBoundDate.getTime() ? current : lowerBoundDate;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
