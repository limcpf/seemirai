import { describe, expect, it } from "vitest";
import { runDailyReport } from "../../src/application/index.js";
import type {
  AuditEvent,
  AuditEventReceipt,
  AuditLogPort,
  DailyReportDataProvider,
  DailyReportNotification,
  DailyReportSourceData,
  DailyReportWindow,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";

describe("daily report runner", () => {
  it("records separate generated and notification-delivered audit evidence", async () => {
    const auditLog = new CapturingAuditLog();
    const notifier = new CapturingNotifier({ delivered: true, providerMessageId: "telegram-1" });

    const result = await runDailyReport({
      reportDate: "2026-05-21",
      dataProvider: new FixtureDailyReportDataProvider(emptySourceData()),
      notifier,
      auditLog,
      trigger: "manual",
      generatedAt: "2026-05-21T15:01:00.000Z",
      clock: () => new Date("2026-05-21T15:02:00.000Z"),
      correlationId: "daily-report-corr-1",
      job: {
        jobId: "job-1",
        idempotencyKey: "report.daily:2026-05-21",
        attemptCount: 1,
        workerId: "worker-a",
      },
    });

    expect(result.status).toBe("DELIVERED");
    expect(notifier.dailyReports).toHaveLength(1);
    expect(auditLog.events).toHaveLength(2);
    expect(auditLog.events[0]).toMatchObject({
      eventType: "DAILY_REPORT",
      reasonCode: "daily_report_generated",
      correlationId: "daily-report-corr-1",
      metadata: {
        report_date: "2026-05-21",
        trigger: "manual",
        idempotency_key: "report.daily:2026-05-21",
      },
    });
    expect(auditLog.events[1]).toMatchObject({
      eventType: "NOTIFICATION_DELIVERY",
      reasonCode: "daily_report_notification_delivered",
      metadata: {
        delivered: true,
        provider_message_id: "telegram-1",
      },
    });
  });

  it("keeps provider failure separate from report generation success", async () => {
    const auditLog = new CapturingAuditLog();
    const notifier = new CapturingNotifier({
      delivered: false,
      skippedReason: "telegram_http_500",
    });

    const result = await runDailyReport({
      reportDate: "2026-05-21",
      dataProvider: new FixtureDailyReportDataProvider(emptySourceData()),
      notifier,
      auditLog,
      trigger: "scheduler",
      clock: () => new Date("2026-05-21T15:02:00.000Z"),
    });

    expect(result.status).toBe("NOTIFICATION_FAILED");
    expect(result.report).toBeDefined();
    expect(auditLog.events.map((event) => event.reasonCode)).toEqual([
      "daily_report_generated",
      "daily_report_notification_failed",
    ]);
    expect(auditLog.events[1]?.metadata).toMatchObject({
      delivered: false,
      skipped_reason: "telegram_http_500",
    });
  });

  it("records generation failure without calling the notifier", async () => {
    const auditLog = new CapturingAuditLog();
    const notifier = new CapturingNotifier({ delivered: true });

    const result = await runDailyReport({
      reportDate: "2026-05-21",
      dataProvider: new ThrowingDailyReportDataProvider(),
      notifier,
      auditLog,
      trigger: "scheduler",
      clock: () => new Date("2026-05-21T15:02:00.000Z"),
    });

    expect(result.status).toBe("GENERATION_FAILED");
    expect(result.errorMessage).toBe("fixture load failed");
    expect(notifier.dailyReports).toHaveLength(0);
    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      eventType: "DAILY_REPORT",
      severity: "ERROR",
      reasonCode: "daily_report_generation_failed",
      metadata: {
        error_message: "fixture load failed",
      },
    });
  });
});

class FixtureDailyReportDataProvider implements DailyReportDataProvider {
  public constructor(private readonly sourceData: DailyReportSourceData) {}

  public async loadDailyReportSourceData(_window: DailyReportWindow): Promise<DailyReportSourceData> {
    return this.sourceData;
  }
}

class ThrowingDailyReportDataProvider implements DailyReportDataProvider {
  public async loadDailyReportSourceData(_window: DailyReportWindow): Promise<DailyReportSourceData> {
    throw new Error("fixture load failed");
  }
}

class CapturingNotifier implements NotifierPort {
  public readonly dailyReports: DailyReportNotification[] = [];

  public constructor(private readonly result: NotificationResult) {}

  public async sendAlert(): Promise<NotificationResult> {
    return { delivered: true };
  }

  public async sendDailyReport(notification: DailyReportNotification): Promise<NotificationResult> {
    this.dailyReports.push(notification);
    return this.result;
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

function emptySourceData(): DailyReportSourceData {
  return {
    orders: [],
    fills: [],
    positions: [],
    pnlSnapshots: [],
    auditEvents: [],
    riskEvents: [],
    executionQuality: [],
  };
}
