import {
  dailyReportJobType,
  runDailyReport,
} from "../../application/index.js";
import type {
  AuditEventReceipt,
  AuditLogPort,
  DailyReportDataProvider,
  LiveOpsStatusSummary,
  NotifierPort,
  RunDailyReportResult,
} from "../../application/index.js";
import {
  PostgresAuditLogRepository,
  PostgresDailyReportRepository,
  claimJobByIdempotencyKey,
  claimPendingJobs,
  completeJob,
  failJob,
  requeueFailedJobByIdempotencyKey,
} from "../../infrastructure/index.js";
import type {
  Database,
  EnqueueDailyReportJobResult,
  JobRecord,
} from "../../infrastructure/index.js";

export const PAPER_NO_KEY_DAILY_REPORT_WORKER_ID = "paper_no_key_daily_report_worker";
const SCHEDULER_FAILURE_RETRY_DELAY_MS = 60_000;

export type DailyReportRuntimeJobStatus =
  | "RUN"
  | "SKIPPED_EXISTING_JOB"
  | "NOT_CLAIMABLE";

/**
 * daily report runtime이 M23 live ops 상태를 읽는 provider다.
 *
 * HTTP `/status.liveOps`와 같은 secret-safe summary를 반환해야 하며, provider 실패나 미구성은 report 생성 실패로 확대하지 않고
 * 본문 섹션 생략으로 낮춘다. provider는 읽기 전용이어야 하고 DB write, broker 호출, notification side effect를 만들면 안 된다.
 */
export interface DailyReportLiveOpsStatusProvider {
  getLiveOpsStatus(): Promise<LiveOpsStatusSummary | null>;
}

/**
 * daily report runtime 조립에 필요한 외부 의존성이다.
 *
 * database는 report facts, jobs lifecycle, audit evidence를 같은 PostgreSQL 경계에 남긴다. notifier는 Telegram 같은 외부
 * provider side effect를 수행하므로 이 runtime은 provider 실패를 report 생성 실패와 분리해 audit에 남겨야 한다.
 */
export interface DailyReportRuntimeDependencies {
  database: Database;
  notifier: NotifierPort;
  auditLog?: AuditLogPort;
  /**
   * daily report fact 조회 범위를 대체하는 선택 provider다.
   *
   * 기본값은 전체 운영 DB를 읽는 PostgreSQL repository다. 특정 rollout이 전략/마켓 범위를 좁혀야 할 때만 주입하며,
   * job 예약과 완료 전이는 계속 `database` 기반 공통 repository가 담당해 `report.daily:<date>` 멱등 경계를 유지한다.
   * provider는 DB read 외 side effect를 만들면 안 된다.
   */
  dataProvider?: DailyReportDataProvider;
  workerId?: string;
  clock?: () => Date;
  actor?: string;
  /**
   * M23 live ops safe summary provider다.
   *
   * 지정하면 manual/scheduler daily report가 같은 provider에서 최신 M23 상태를 읽어 본문에 포함한다. provider 장애는
   * notification 중복이나 job retry로 번지지 않도록 report 생성 경계에서 null로 낮춘다.
   */
  liveOpsStatusProvider?: DailyReportLiveOpsStatusProvider;
}

/**
 * 수동 daily report 실행 입력이다.
 *
 * manual path도 먼저 `report.daily:<reportDate>` job을 예약/재사용한 뒤 같은 key를 claim한다. 이 invariant가 있어야 같은
 * 기준일을 운영자가 반복 실행해도 Telegram daily report 중복 전송으로 이어지지 않는다.
 */
export interface RunManualDailyReportOptions {
  reportDate: string;
  runAfter?: Date | string;
  maxAttempts?: number;
  correlationId?: string;
}

/**
 * scheduler가 daily report job을 예약할 때 쓰는 입력이다.
 *
 * 수동 실행과 같은 `reportDate`를 넘기면 같은 idempotency key로 수렴한다. `runAfter`는 scheduler가 job을 claim할 수 있는
 * 시각이고, manual runner는 필요할 때 같은 key의 PENDING job을 즉시 claim할 수 있다.
 */
export interface ScheduleDailyReportOptions {
  reportDate: string;
  runAfter?: Date | string;
  maxAttempts?: number;
}

/**
 * scheduler worker가 현재 실행 가능한 daily report job을 처리할 때 쓰는 조건이다.
 *
 * `now`와 `limit`은 claim query에만 적용된다. 완료/실패 evidence 시각은 runtime clock을 사용해 테스트와 운영 재생이
 * 일관되게 같은 시계를 주입할 수 있게 한다.
 */
export interface RunDueDailyReportJobsOptions {
  limit?: number;
  now?: Date | string;
}

/**
 * claim된 daily report job 하나의 실행 결과다.
 *
 * `job`은 claim 직후 상태, `result`는 report 생성/전송 결과, `finalJob`은 completion 또는 failure 전이 후 상태다.
 */
export interface ClaimedDailyReportJobRunResult {
  job: JobRecord;
  result: RunDailyReportResult;
  finalJob: JobRecord;
}

/**
 * 수동 daily report 실행 결과다.
 *
 * `SKIPPED_EXISTING_JOB`은 같은 기준일 job이 이미 완료되어 provider 재전송을 막았다는 뜻이고, `NOT_CLAIMABLE`은 같은 key의
 * job이 이미 다른 worker에서 실행 중이거나 재시도 한도를 소진했다는 뜻이다.
 */
export interface RunManualDailyReportResult {
  status: DailyReportRuntimeJobStatus;
  enqueueResult: EnqueueDailyReportJobResult;
  claimed?: ClaimedDailyReportJobRunResult;
}

/**
 * PAPER_NO_KEY daily report runtime public contract다.
 *
 * scheduler는 `runDueDailyReportJobs`를 주기적으로 호출하고, 운영자 수동 실행은 `runManualDailyReport`를 호출한다. 두 경로는
 * 같은 DB job idempotency key와 같은 report 생성/전송 service를 공유한다.
 */
export interface PaperNoKeyDailyReportRuntime {
  scheduleDailyReport(options: ScheduleDailyReportOptions): Promise<EnqueueDailyReportJobResult>;
  runManualDailyReport(options: RunManualDailyReportOptions): Promise<RunManualDailyReportResult>;
  runDueDailyReportJobs(options?: RunDueDailyReportJobsOptions): Promise<ClaimedDailyReportJobRunResult[]>;
}

/**
 * PostgreSQL jobs queue와 NotifierPort를 daily report runner로 조립한다.
 *
 * 반환된 runtime은 live order API나 private Upbit API를 사용하지 않는다. DB fact 조회와 Telegram outbound만 수행하며,
 * Telegram 실패는 audit evidence로 분리해 이미 생성된 deterministic report 사실을 덮어쓰지 않는다.
 */
export function createPaperNoKeyDailyReportRuntime(
  dependencies: DailyReportRuntimeDependencies,
): PaperNoKeyDailyReportRuntime {
  const jobRepository = new PostgresDailyReportRepository(dependencies.database);
  const dataProvider = dependencies.dataProvider ?? jobRepository;
  const auditLog = dependencies.auditLog ?? new PostgresAuditLogRepository(dependencies.database);
  const workerId = dependencies.workerId ?? PAPER_NO_KEY_DAILY_REPORT_WORKER_ID;
  const scheduleDailyReportJob = async (
    options: ScheduleDailyReportOptions,
  ): Promise<EnqueueDailyReportJobResult> =>
    jobRepository.enqueueDailyReportJob({
      reportDate: options.reportDate,
      ...(options.runAfter === undefined ? {} : { runAfter: options.runAfter }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    });

  return {
    scheduleDailyReport: scheduleDailyReportJob,

    async runManualDailyReport(options) {
      const now = dependencies.clock?.() ?? new Date();
      let enqueueResult = await scheduleDailyReportJob({
        reportDate: options.reportDate,
        runAfter: options.runAfter ?? now,
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      });

      if (!enqueueResult.created && enqueueResult.job.status === "COMPLETED") {
        return {
          status: "SKIPPED_EXISTING_JOB",
          enqueueResult,
        };
      }

      if (!enqueueResult.created && enqueueResult.job.status === "FAILED") {
        const requeuedJob = await requeueFailedJobByIdempotencyKey(dependencies.database, {
          idempotencyKey: enqueueResult.plan.idempotencyKey,
          jobType: dailyReportJobType,
          runAfter: options.runAfter ?? now,
          requeuedAt: now,
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        });

        if (requeuedJob === undefined) {
          return {
            status: "NOT_CLAIMABLE",
            enqueueResult,
          };
        }

        enqueueResult = {
          ...enqueueResult,
          job: requeuedJob,
        };
      }

      const claimedJob = await claimJobByIdempotencyKey(dependencies.database, {
        workerId,
        idempotencyKey: enqueueResult.plan.idempotencyKey,
        jobType: dailyReportJobType,
        now,
        ignoreRunAfter: true,
      });

      if (claimedJob === undefined) {
        return {
          status: "NOT_CLAIMABLE",
          enqueueResult,
        };
      }

      return {
        status: "RUN",
        enqueueResult,
        claimed: await runClaimedDailyReportJob({
          database: dependencies.database,
          dataProvider,
          auditLog,
          notifier: dependencies.notifier,
          workerId,
          job: claimedJob,
          trigger: "manual",
          ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
          ...(dependencies.actor === undefined ? {} : { actor: dependencies.actor }),
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          ...(dependencies.liveOpsStatusProvider === undefined
            ? {}
            : { liveOpsStatusProvider: dependencies.liveOpsStatusProvider }),
        }),
      };
    },

    async runDueDailyReportJobs(options = {}) {
      const limit = options.limit ?? 1;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("daily report job run limit must be a positive safe integer");
      }
      const results: ClaimedDailyReportJobRunResult[] = [];
      for (let claimedCount = 0; claimedCount < limit; claimedCount += 1) {
        const [job] = await claimPendingJobs(dependencies.database, {
          workerId,
          jobType: dailyReportJobType,
          limit: 1,
          ...(options.now === undefined ? {} : { now: options.now }),
        });

        if (job === undefined) {
          break;
        }

        results.push(
          await runClaimedDailyReportJob({
            database: dependencies.database,
            dataProvider,
            auditLog,
            notifier: dependencies.notifier,
            workerId,
            job,
            trigger: "scheduler",
            ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
            ...(dependencies.actor === undefined ? {} : { actor: dependencies.actor }),
            ...(dependencies.liveOpsStatusProvider === undefined
              ? {}
              : { liveOpsStatusProvider: dependencies.liveOpsStatusProvider }),
          }),
        );
      }

      return results;
    },
  };
}

async function runClaimedDailyReportJob(input: {
  database: Database;
  dataProvider: DailyReportDataProvider;
  auditLog: AuditLogPort;
  notifier: NotifierPort;
  workerId: string;
  job: JobRecord;
  trigger: "manual" | "scheduler";
  clock?: () => Date;
  actor?: string;
  correlationId?: string;
  liveOpsStatusProvider?: DailyReportLiveOpsStatusProvider;
}): Promise<ClaimedDailyReportJobRunResult> {
  const reportDate = readReportDate(input.job);
  if (reportDate === undefined) {
    const errorMessage = "daily report job payload must include report_date";
    const failureTiming = resolveFailureTiming(input);
    const occurredAt = failureTiming.failedAt;
    const auditEventReceipts: AuditEventReceipt[] = [];
    let failureMessage = errorMessage;
    try {
      auditEventReceipts.push(
        await input.auditLog.appendEvent({
          eventType: "DAILY_REPORT",
          severity: "ERROR",
          occurredAt,
          actor: input.actor ?? "daily_report_runner",
          reasonCode: "daily_report_job_payload_invalid",
          ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          metadata: {
            job_id: input.job.id,
            idempotency_key: input.job.idempotency_key,
            worker_id: input.workerId,
            trigger: input.trigger,
            error_message: errorMessage,
          },
        }),
      );
    } catch (error) {
      // payload 자체가 invalid이면 audit 저장 실패보다 queue lock 회수가 우선이라 실패 사유에 audit 오류를 합쳐 남긴다.
      failureMessage = `${errorMessage}; audit append failed: ${toErrorMessage(error)}`;
    }
    const finalJob = await failJob(input.database, {
      jobId: input.job.id,
      workerId: input.workerId,
      errorMessage: failureMessage,
      failedAt: occurredAt,
      ...(failureTiming.retryAfter === undefined ? {} : { retryAfter: failureTiming.retryAfter }),
    });

    return {
      job: input.job,
      result: {
        status: "GENERATION_FAILED",
        reportDate: "unknown",
        auditEventReceipts,
        errorMessage: failureMessage,
      },
      finalJob,
    };
  }

  let result: RunDailyReportResult;
  try {
    const liveOps = await readDailyReportLiveOpsStatus(input.liveOpsStatusProvider);
    result = await runDailyReport({
      reportDate,
      dataProvider: input.dataProvider,
      notifier: input.notifier,
      auditLog: input.auditLog,
      trigger: input.trigger,
      ...(liveOps === null ? {} : { liveOps }),
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      job: {
        jobId: input.job.id,
        idempotencyKey: input.job.idempotency_key,
        attemptCount: input.job.attempt_count,
        workerId: input.workerId,
      },
    });
  } catch (error) {
    const errorMessage = `daily report runner failed: ${toErrorMessage(error)}`;
    const failureTiming = resolveFailureTiming(input);
    // audit 저장소 장애처럼 application runner가 예외를 던져도 queue lock은 반드시 해제해 재시도/수동 복구 경로를 남긴다.
    const finalJob = await failJob(input.database, {
      jobId: input.job.id,
      workerId: input.workerId,
      errorMessage,
      failedAt: failureTiming.failedAt,
      ...(failureTiming.retryAfter === undefined ? {} : { retryAfter: failureTiming.retryAfter }),
    });

    return {
      job: input.job,
      result: {
        status: "GENERATION_FAILED",
        reportDate,
        auditEventReceipts: [],
        errorMessage,
      },
      finalJob,
    };
  }

  const finalJob =
    result.status === "GENERATION_FAILED"
      ? await failJob(input.database, {
          jobId: input.job.id,
          workerId: input.workerId,
          errorMessage: result.errorMessage ?? "daily report generation failed",
          ...toFailJobTimingOptions(resolveFailureTiming(input)),
        })
      : await completeJob(input.database, {
          jobId: input.job.id,
          workerId: input.workerId,
          completedAt: input.clock?.() ?? new Date(),
        });

  return {
    job: input.job,
    result,
    finalJob,
  };
}

async function readDailyReportLiveOpsStatus(
  provider: DailyReportLiveOpsStatusProvider | undefined,
): Promise<LiveOpsStatusSummary | null> {
  if (provider === undefined) {
    return null;
  }

  try {
    return await provider.getLiveOpsStatus();
  } catch {
    // status provider 장애는 이미 생성 가능한 daily report와 Telegram 전송을 막지 않도록 M23 섹션만 생략한다.
    return null;
  }
}

function readReportDate(job: JobRecord): string | undefined {
  const reportDate = job.payload_json.report_date;
  if (typeof reportDate === "string" && reportDate.length > 0) {
    return reportDate;
  }

  const fromKey = job.idempotency_key.startsWith(`${dailyReportJobType}:`)
    ? job.idempotency_key.slice(`${dailyReportJobType}:`.length)
    : "";
  return fromKey.length > 0 ? fromKey : undefined;
}

function resolveFailureTiming(input: { trigger: "manual" | "scheduler"; clock?: () => Date }): {
  failedAt: Date;
  retryAfter?: Date;
} {
  const failedAt = input.clock?.() ?? new Date();
  if (input.trigger === "manual") {
    return { failedAt };
  }

  // scheduler sweep 안에서 같은 실패 row를 즉시 재claim하면 attempt를 한 번에 소진하므로 최소 다음 tick으로 미룬다.
  return {
    failedAt,
    retryAfter: new Date(failedAt.getTime() + SCHEDULER_FAILURE_RETRY_DELAY_MS),
  };
}

function toFailJobTimingOptions(timing: { failedAt: Date; retryAfter?: Date }): {
  failedAt: Date;
  retryAfter?: Date;
} {
  return {
    failedAt: timing.failedAt,
    ...(timing.retryAfter === undefined ? {} : { retryAfter: timing.retryAfter }),
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
