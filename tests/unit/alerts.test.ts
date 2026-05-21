import { describe, expect, it } from "vitest";
import type {
  AlertNotification,
  AuditEvent,
  AuditEventReceipt,
  AuditLogPort,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import {
  createAlertFingerprint,
  createInMemoryAlertCooldownStore,
  createNotificationRetryJobPlan,
  dispatchAlertWithCooldown,
  evaluateNotificationFailure,
  getDefaultAlertCooldownMs,
  notificationRetryJobType,
} from "../../src/application/index.js";

describe("alert cooldown and notification policy", () => {
  it("creates canonical alert fingerprints from operational dimensions", () => {
    expect(
      createAlertFingerprint({
        environment: "Prod",
        runMode: "PAPER_TRADING",
        severity: "P0",
        alertType: "DB Write Failure",
        market: "KRW-BTC",
        strategyId: "Trend Following",
        reasonCode: "DB_WRITE_FAILURE",
      }),
    ).toBe("alert:prod:paper_trading:P0:db_write_failure:krw-btc:trend_following:db_write_failure");
  });

  it("keeps severity cooldown windows aligned with M8 policy", () => {
    expect(getDefaultAlertCooldownMs("P0")).toBe(60_000);
    expect(getDefaultAlertCooldownMs("P1")).toBe(5 * 60_000);
    expect(getDefaultAlertCooldownMs("P2")).toBe(60 * 60_000);
    expect(getDefaultAlertCooldownMs("P3")).toBe(6 * 60 * 60_000);
  });

  it("skips duplicate P0 alerts during durable cooldown and audits the skip", async () => {
    const notifier = new RecordingNotifier();
    const auditLog = new RecordingAuditLog();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const request = {
      environment: "prod",
      runMode: "paper_trading",
      severity: "P0" as const,
      alertType: "db_write_failure",
      reasonCode: "db_write_failure",
      title: "DB write failed",
      body: "risk evidence cannot be persisted",
      occurredAt: "2026-05-21T00:00:00.000Z",
      correlationId: "corr-alert",
    };

    const first = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        auditLog,
      },
      request,
    );
    const duplicate = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        auditLog,
        failureState: {
          consecutiveFailures: 2,
          firstFailureAt: "2026-05-20T23:50:00.000Z",
          lastFailureAt: "2026-05-20T23:55:00.000Z",
        },
      },
      {
        ...request,
        occurredAt: "2026-05-21T00:00:30.000Z",
      },
    );

    expect(first.notification.delivered).toBe(true);
    expect(duplicate).toMatchObject({
      cooldownHit: true,
      notification: {
        delivered: false,
        skippedReason: "alert_cooldown_active",
      },
    });
    expect(duplicate.failureEvaluation.state).toMatchObject({
      consecutiveFailures: 2,
      firstFailureAt: "2026-05-20T23:50:00.000Z",
    });
    expect(notifier.alerts).toHaveLength(1);
    expect(auditLog.events.map((event) => event.eventType)).toEqual([
      "NOTIFICATION_DELIVERY",
      "ALERT_COOLDOWN",
    ]);
  });

  it("allows severity escalation to bypass an existing lower-severity cooldown", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const baseRequest = {
      environment: "prod",
      runMode: "paper_trading",
      alertType: "websocket_lag",
      market: "KRW-BTC",
      reasonCode: "public_websocket_lag",
      title: "WebSocket lag",
      body: "lag exceeded threshold",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };

    await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      {
        ...baseRequest,
        severity: "P1",
      },
    );
    const escalated = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      {
        ...baseRequest,
        severity: "P0",
        occurredAt: "2026-05-21T00:00:30.000Z",
      },
    );

    expect(escalated.cooldownHit).toBe(false);
    expect(notifier.alerts.map((alert) => alert.severity)).toEqual(["P1", "P0"]);
  });

  it("creates retry job candidates for P0/P1 notification provider failures", async () => {
    const retryJobPlan = createNotificationRetryJobPlan({
      fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
      occurredAt: "2026-05-21T00:00:00.000Z",
      request: {
        environment: "prod",
        runMode: "paper",
        severity: "P0",
        alertType: "db",
        reasonCode: "db_write_failure",
        title: "DB write failed",
        body: "risk evidence cannot be persisted",
        correlationId: "corr-retry",
      },
    });

    expect(retryJobPlan).toMatchObject({
      jobType: notificationRetryJobType,
      idempotencyKey:
        "notification_retry:alert:prod:paper:P0:db:global:global:db_write_failure:2026-05-21T00:00:00.000Z",
      maxAttempts: 3,
      payloadJson: {
        severity: "P0",
        fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
        correlation_id: "corr-retry",
      },
    });
  });

  it("marks repeated notification failures as manual review candidates", () => {
    const first = evaluateNotificationFailure(
      undefined,
      { delivered: false, skippedReason: "telegram_timeout" },
      "2026-05-21T00:00:00.000Z",
    );
    const second = evaluateNotificationFailure(
      first.state,
      { delivered: false, skippedReason: "telegram_timeout" },
      "2026-05-21T00:01:00.000Z",
    );
    const third = evaluateNotificationFailure(
      second.state,
      { delivered: false, skippedReason: "telegram_timeout" },
      "2026-05-21T00:02:00.000Z",
    );
    const longOutage = evaluateNotificationFailure(
      first.state,
      { delivered: false, skippedReason: "telegram_timeout" },
      "2026-05-21T00:10:00.000Z",
    );

    expect(third).toMatchObject({
      manualReviewReasonCode: "notification_consecutive_failure",
      state: {
        consecutiveFailures: 3,
      },
    });
    expect(longOutage.manualReviewReasonCode).toBe("notification_failure_threshold_exceeded");
    expect(
      evaluateNotificationFailure(third.state, { delivered: true }, "2026-05-21T00:11:00.000Z"),
    ).toMatchObject({
      state: {
        consecutiveFailures: 0,
        firstFailureAt: null,
      },
    });
  });
});

class RecordingNotifier implements NotifierPort {
  public readonly alerts: AlertNotification[] = [];
  public nextResult: NotificationResult = {
    delivered: true,
    providerMessageId: "telegram-1",
  };

  public async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    this.alerts.push(notification);
    return this.nextResult;
  }

  public async sendDailyReport(_notification: DailyReportNotification): Promise<NotificationResult> {
    return this.nextResult;
  }
}

class RecordingAuditLog implements AuditLogPort {
  public readonly events: AuditEvent[] = [];

  public async appendEvent(event: AuditEvent): Promise<AuditEventReceipt> {
    this.events.push(event);
    return {
      auditEventId: `audit-${this.events.length}`,
      appendedAt: event.occurredAt,
    };
  }
}
