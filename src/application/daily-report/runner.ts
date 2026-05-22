import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import type {
  AuditEventReceipt,
  AuditLogPort,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../ports/index.js";
import { buildDailyReportNotification } from "./service.js";
import type {
  DailyReportAggregate,
  DailyReportSourceData,
  DailyReportWindow,
} from "./types.js";
import type { DailyReportDataProvider } from "./service.js";

export type DailyReportRunTrigger = "manual" | "scheduler";

export type DailyReportRunStatus =
  | "DELIVERED"
  | "NOTIFICATION_FAILED"
  | "GENERATION_FAILED";

/**
 * daily report 실행이 연결된 jobs queue 문맥이다.
 *
 * scheduler worker와 수동 실행 경계가 같은 `report.daily:<reportDate>` idempotency key를 쓰는지 audit에서 검증할 수 있게
 * job ID, key, attempt, worker 정보를 전송/실패 evidence에 함께 남긴다. 이 타입은 저장소를 직접 갱신하지 않는다.
 */
export interface DailyReportRunJobContext {
  jobId: string;
  idempotencyKey: string;
  attemptCount?: number;
  workerId?: string;
}

/**
 * daily report 단건 실행 입력이다.
 *
 * application runner는 DB fact 조회, deterministic report 생성, NotifierPort 호출, audit evidence 기록을 하나의 use case로
 * 묶는다. jobs row 완료/실패 전이는 runtime boundary가 담당하므로 이 함수는 job status side effect를 직접 수행하지 않는다.
 */
export interface RunDailyReportOptions {
  reportDate: string;
  dataProvider: DailyReportDataProvider;
  notifier: NotifierPort;
  auditLog: AuditLogPort;
  trigger: DailyReportRunTrigger;
  generatedAt?: Date | string;
  clock?: () => Date;
  actor?: string;
  correlationId?: string;
  job?: DailyReportRunJobContext;
}

/**
 * daily report 실행 결과다.
 *
 * `GENERATION_FAILED`는 report fact 조회 또는 집계/formatting 실패라 job retry 대상이고, `NOTIFICATION_FAILED`는 리포트
 * 생성은 성공했지만 provider가 전송하지 못한 상태라 audit에 분리해 남긴 뒤 runtime이 job 완료 여부를 결정한다.
 */
export interface RunDailyReportResult {
  status: DailyReportRunStatus;
  reportDate: string;
  report?: DailyReportAggregate;
  notification?: DailyReportNotification;
  notificationResult?: NotificationResult;
  auditEventReceipts: readonly AuditEventReceipt[];
  errorMessage?: string;
}

/**
 * daily report를 생성하고 Telegram 같은 outbound notifier로 전송한다.
 *
 * report 생성 실패와 provider 실패를 서로 다른 audit reason으로 기록해야 scheduler 재시도와 운영자 대응이 섞이지 않는다.
 * NotifierPort 예외는 정규화해 `NOTIFICATION_FAILED`로 반환하지만, audit 저장 실패는 운영 evidence 누락이므로 caller에게
 * 그대로 전파한다.
 */
export async function runDailyReport(options: RunDailyReportOptions): Promise<RunDailyReportResult> {
  const occurredAt = options.clock?.() ?? new Date();
  const auditEventReceipts: AuditEventReceipt[] = [];
  let built: Awaited<ReturnType<typeof buildDailyReportNotification>>;

  try {
    built = await buildDailyReportNotification({
      reportDate: options.reportDate,
      dataProvider: options.dataProvider,
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    auditEventReceipts.push(
      await appendDailyReportAudit(options, {
        severity: "ERROR",
        reasonCode: "daily_report_generation_failed",
        occurredAt,
        metadata: {
          error_message: errorMessage,
        },
      }),
    );

    return {
      status: "GENERATION_FAILED",
      reportDate: options.reportDate,
      auditEventReceipts,
      errorMessage,
    };
  }

  auditEventReceipts.push(
    await appendDailyReportAudit(options, {
      severity: "INFO",
      reasonCode: "daily_report_generated",
      occurredAt,
      metadata: {
        order_count: built.report.orderCount,
        fill_count: built.report.fillCount,
        discarded_candidate_count: built.report.discardedCandidates.total,
        risk_event_count: built.report.riskEvents.total,
      },
    }),
  );

  const notificationResult = await sendDailyReportNotification(options.notifier, built.notification);
  auditEventReceipts.push(
    await appendDailyReportAudit(options, {
      eventType: "NOTIFICATION_DELIVERY",
      severity: notificationResult.delivered ? "INFO" : "WARN",
      reasonCode: notificationResult.delivered
        ? "daily_report_notification_delivered"
        : "daily_report_notification_failed",
      occurredAt,
      metadata: {
        delivered: notificationResult.delivered,
        ...(notificationResult.providerMessageId === undefined
          ? {}
          : { provider_message_id: notificationResult.providerMessageId }),
        ...(notificationResult.skippedReason === undefined
          ? {}
          : { skipped_reason: notificationResult.skippedReason }),
      },
    }),
  );

  return {
    status: notificationResult.delivered ? "DELIVERED" : "NOTIFICATION_FAILED",
    reportDate: options.reportDate,
    report: built.report,
    notification: built.notification,
    notificationResult,
    auditEventReceipts,
  };
}

async function sendDailyReportNotification(
  notifier: NotifierPort,
  notification: DailyReportNotification,
): Promise<NotificationResult> {
  try {
    return await notifier.sendDailyReport(notification);
  } catch (error) {
    return {
      delivered: false,
      skippedReason: `notifier_exception:${toErrorMessage(error)}`,
    };
  }
}

async function appendDailyReportAudit(
  options: RunDailyReportOptions,
  input: {
    eventType?: "DAILY_REPORT" | "NOTIFICATION_DELIVERY";
    severity: "INFO" | "WARN" | "ERROR";
    reasonCode: string;
    occurredAt: TimestampInput;
    metadata: JsonRecord;
  },
): Promise<AuditEventReceipt> {
  return options.auditLog.appendEvent({
    eventType: input.eventType ?? "DAILY_REPORT",
    severity: input.severity,
    occurredAt: input.occurredAt,
    actor: options.actor ?? "daily_report_runner",
    reasonCode: input.reasonCode,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    metadata: {
      report_date: options.reportDate,
      trigger: options.trigger,
      ...toJobMetadata(options.job),
      ...input.metadata,
    },
  });
}

function toJobMetadata(job: DailyReportRunJobContext | undefined): JsonRecord {
  if (job === undefined) {
    return {};
  }

  return {
    job_id: job.jobId,
    idempotency_key: job.idempotencyKey,
    ...(job.attemptCount === undefined ? {} : { attempt_count: job.attemptCount }),
    ...(job.workerId === undefined ? {} : { worker_id: job.workerId }),
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
