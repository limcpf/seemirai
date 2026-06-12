import { describe, expect, it } from "vitest";
import {
  createLiveAutonomousExitStatusSummary,
  createLiveOpsStatusSummary,
  runDailyReport,
} from "../../src/application/index.js";
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
      liveAutonomousExit: createLiveAutonomousExitStatusSummary({
        enabled: true,
        runtimeReady: true,
        exitEngineReady: true,
        observedAt: "2026-05-21T15:00:00.000Z",
        reconcile: {
          result: "SKIPPED",
          mismatchCount: null,
          openOrderCount: null,
          balanceStatus: "UNAVAILABLE",
          websocketStatus: "DISCONNECTED",
          lastReconcileAt: null,
        },
      }),
      liveOps: liveOpsSummary(),
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
    expect(notifier.dailyReports[0]?.summary).toContain("M22 자동매매/청산");
    expect(notifier.dailyReports[0]?.summary).toContain("자동 청산 상태: reconcile 확인 필요");
    expect(notifier.dailyReports[0]?.summary).toContain("M23 live 운영 상태");
    expect(notifier.dailyReports[0]?.summary).toContain("상태: 실매매 가능");
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

  it("does not turn a delivered notification into a retry when notification audit append fails", async () => {
    const auditLog = new FailingOnNthAuditLog(2);
    const notifier = new CapturingNotifier({ delivered: true, providerMessageId: "telegram-1" });

    const result = await runDailyReport({
      reportDate: "2026-05-21",
      dataProvider: new FixtureDailyReportDataProvider(emptySourceData()),
      notifier,
      auditLog,
      trigger: "scheduler",
      clock: () => new Date("2026-05-21T15:02:00.000Z"),
    });

    expect(result.status).toBe("DELIVERED");
    expect(result.errorMessage).toContain("daily report notification audit append failed");
    expect(result.auditEventReceipts).toHaveLength(1);
    expect(notifier.dailyReports).toHaveLength(1);
    expect(auditLog.events.map((event) => event.reasonCode)).toEqual(["daily_report_generated"]);
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

class FailingOnNthAuditLog extends CapturingAuditLog {
  public constructor(private readonly failOnCall: number) {
    super();
  }

  public override async appendEvent(event: AuditEvent): Promise<AuditEventReceipt> {
    if (this.events.length + 1 === this.failOnCall) {
      throw new Error("audit append failed");
    }

    return super.appendEvent(event);
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

function liveOpsSummary() {
  return createLiveOpsStatusSummary({
    observedAt: "2026-05-21T15:00:00.000Z",
    runtimeMode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    paperNoKey: false,
    liveTradingEnabled: true,
    liveAutonomous: {
      enabled: true,
      ready: true,
      allowedMarkets: ["KRW-BTC"],
      maxOrderKrw: "10000",
      dailyAutonomousNotionalLimitKrw: "30000",
      maxOpenPositionNotionalKrw: "30000",
      keyScopeEvidenceConfigured: true,
      telegramInboundReady: true,
      reconcileFresh: true,
      pnlStatusReady: true,
      decisionLedgerReady: true,
      exitEngineReady: true,
      statusLabel: "M23 guard 통과",
      message: "M23 guard evidence가 모두 준비됐습니다.",
      action: null,
      trace: {
        source: "live_autonomous_runtime_guard",
        reason: "live_autonomous_guard_ready",
      },
    },
    marketData: {
      connectionStatus: "CONNECTED",
      lagMs: 50,
      updatedAt: "2026-05-21T14:59:30.000Z",
    },
    reconcile: {
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: 0,
      lastReconcileAt: "2026-05-21T14:59:00.000Z",
      actionRequired: "정상",
    },
    pnl: {
      statusLabel: "조회 가능",
      latestCapturedAt: "2026-05-21T14:58:00.000Z",
      latestEquityKrw: "1000000",
      latestRealizedPnlKrw: "1200",
      latestUnrealizedPnlKrw: "-300",
    },
    tradingState: {
      killSwitchState: "NORMAL",
      newOrdersBlocked: false,
      requiresManualReview: false,
      blockedReason: null,
    },
    alerts: {
      statusLabel: "조회 가능",
      lastSentAt: "2026-05-21T14:57:00.000Z",
      lastSkippedAt: null,
      action: null,
    },
  });
}
