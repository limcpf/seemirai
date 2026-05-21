import { describe, expect, it } from "vitest";
import type {
  AlertCooldownRecordInput,
  AlertCooldownReservationInput,
  AlertCooldownReservationResult,
  AlertCooldownState,
  AlertCooldownStore,
  AlertNotification,
  AuditEvent,
  AuditEventReceipt,
  AuditLogPort,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import {
  createKillSwitchControlDecision,
  createAlertFingerprint,
  createInMemoryAlertCooldownStore,
  createNotificationRetryJobPlan,
  dispatchKillSwitchControlAlert,
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

  it("escapes fingerprint separators inside normalized dimensions", () => {
    const marketWithSeparator = createAlertFingerprint({
      environment: "prod",
      runMode: "paper",
      severity: "P1",
      alertType: "risk",
      market: "a:b",
      strategyId: "c",
      reasonCode: "stale_market_data",
    });
    const strategyWithSeparator = createAlertFingerprint({
      environment: "prod",
      runMode: "paper",
      severity: "P1",
      alertType: "risk",
      market: "a",
      strategyId: "b:c",
      reasonCode: "stale_market_data",
    });

    expect(marketWithSeparator).toContain("a%3ab");
    expect(strategyWithSeparator).toContain("b%3ac");
    expect(marketWithSeparator).not.toBe(strategyWithSeparator);
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

  it("reserves a fingerprint before provider send to suppress concurrent duplicates", async () => {
    const notifier = new BlockingNotifier();
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
    };

    const first = dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      request,
    );
    await notifier.sendStarted;
    const duplicate = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      request,
    );
    notifier.resolveDelivery();

    await expect(first).resolves.toMatchObject({
      cooldownHit: false,
      notification: {
        delivered: true,
      },
    });
    expect(duplicate).toMatchObject({
      cooldownHit: true,
      notification: {
        delivered: false,
        skippedReason: "alert_delivery_reserved",
      },
    });
    expect(notifier.alerts).toHaveLength(1);
  });

  it("retries reservation once when a released lease makes the rejected state non-blocking", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = new ReservationRaceCooldownStore();
    const request = {
      environment: "prod",
      runMode: "paper_trading",
      severity: "P0" as const,
      alertType: "db_write_failure",
      reasonCode: "db_write_failure",
      title: "DB write failed",
      body: "risk evidence cannot be persisted",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };

    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      request,
    );

    expect(result).toMatchObject({
      cooldownHit: false,
      notification: {
        delivered: true,
      },
    });
    expect(cooldownStore.reserveCalls).toBe(2);
    expect(notifier.alerts).toHaveLength(1);
  });

  it("clears delivery reservations after provider failure so immediate retry can send", async () => {
    const notifier = new RecordingNotifier();
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
    };
    notifier.nextResult = {
      delivered: false,
      skippedReason: "telegram_http_500",
    };

    const failed = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      request,
    );
    const stateAfterFailure = await cooldownStore.findByFingerprint(failed.fingerprint);
    notifier.nextResult = {
      delivered: true,
      providerMessageId: "telegram-2",
    };
    const retry = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      {
        ...request,
        occurredAt: "2026-05-21T00:00:01.000Z",
      },
    );

    expect(failed.notification).toMatchObject({
      delivered: false,
      skippedReason: "telegram_http_500",
    });
    expect(stateAfterFailure?.deliveryReservedUntil).toBeNull();
    expect(retry).toMatchObject({
      cooldownHit: false,
      notification: {
        delivered: true,
      },
    });
    expect(notifier.alerts).toHaveLength(2);
  });

  it("records cooldown timestamps from delivery time while preserving alert occurrence time", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const deliveredAt = new Date("2026-05-21T00:10:00.000Z");
    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        clock: () => deliveredAt,
      },
      {
        environment: "prod",
        runMode: "paper_trading",
        severity: "P0",
        alertType: "db_write_failure",
        reasonCode: "db_write_failure",
        title: "DB write failed",
        body: "risk evidence cannot be persisted",
        occurredAt: "2026-05-21T00:00:00.000Z",
      },
    );
    const state = await cooldownStore.findByFingerprint(result.fingerprint);

    expect(notifier.alerts[0]?.occurredAt).toBe("2026-05-21T00:00:00.000Z");
    expect(state?.lastSentAt).toEqual(deliveredAt);
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

  it("normalizes notifier exceptions into failure audit and retry handling", async () => {
    const notifier = new ThrowingNotifier();
    const auditLog = new RecordingAuditLog();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        auditLog,
      },
      {
        environment: "prod",
        runMode: "paper_trading",
        severity: "P0",
        alertType: "db_write_failure",
        reasonCode: "db_write_failure",
        title: "DB write failed",
        body: "risk evidence cannot be persisted",
        occurredAt: "2026-05-21T00:00:00.000Z",
        correlationId: "corr-provider-exception",
      },
    );
    const state = await cooldownStore.findByFingerprint(result.fingerprint);

    expect(result.notification).toMatchObject({
      delivered: false,
      skippedReason: "notification_provider_exception",
    });
    expect(result.retryJobPlan).toMatchObject({
      jobType: notificationRetryJobType,
    });
    expect(result.failureEvaluation.state.consecutiveFailures).toBe(1);
    expect(state?.deliveryReservedUntil).toBeNull();
    expect(auditLog.events.at(-1)).toMatchObject({
      eventType: "NOTIFICATION_DELIVERY",
      severity: "ERROR",
      reasonCode: "notification_failure",
    });
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

  it("dispatches accepted kill switch control transitions as operational alerts", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const controlRequest = {
      targetState: "HARD_STOP" as const,
      reasonCode: "db_write_failure",
      correlationId: "corr-kill-switch-alert",
      actor: "operator",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };
    const controlResult = {
      ...createKillSwitchControlDecision({
        currentState: "NORMAL",
        ...controlRequest,
      }),
      auditEventId: "audit-1",
      riskEventId: "risk-1",
    };

    const result = await dispatchKillSwitchControlAlert({
      alertDispatch: {
        environment: "prod",
        runMode: "paper_trading",
        notifier,
        durableCooldownStore: cooldownStore,
      },
      controlRequest,
      controlResult,
    });

    expect(result).toMatchObject({
      cooldownHit: false,
      notification: {
        delivered: true,
      },
    });
    expect(notifier.alerts[0]).toMatchObject({
      severity: "P0",
      title: "Kill switch HARD_STOP",
      metadata: {
        source: "kill_switch_control",
        audit_event_id: "audit-1",
        risk_event_id: "risk-1",
      },
    });
  });

  it("accumulates notification failure state across runtime kill switch alert calls", async () => {
    const notifier = new RecordingNotifier();
    notifier.nextResult = {
      delivered: false,
      skippedReason: "telegram_timeout",
    };
    const alertDispatch = {
      environment: "prod",
      runMode: "paper_trading",
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
    };
    const controlRequest = {
      targetState: "HARD_STOP" as const,
      reasonCode: "db_write_failure",
      correlationId: "corr-kill-switch-alert-failure",
      actor: "operator",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };
    const controlResult = {
      ...createKillSwitchControlDecision({
        currentState: "NORMAL",
        ...controlRequest,
      }),
      auditEventId: "audit-1",
      riskEventId: "risk-1",
    };

    await dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult });
    await dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult });
    const third = await dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult });

    expect(third?.failureEvaluation).toMatchObject({
      manualReviewReasonCode: "notification_consecutive_failure",
      state: {
        consecutiveFailures: 3,
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

class BlockingNotifier extends RecordingNotifier {
  public readonly sendStarted: Promise<void>;
  private resolveStarted: (() => void) | undefined;
  private resolveResult: ((result: NotificationResult) => void) | undefined;

  public constructor() {
    super();
    this.sendStarted = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  public override async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    this.alerts.push(notification);
    this.resolveStarted?.();
    return new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  public resolveDelivery(): void {
    this.resolveResult?.(this.nextResult);
  }
}

class ThrowingNotifier extends RecordingNotifier {
  public override async sendAlert(_notification: AlertNotification): Promise<NotificationResult> {
    throw new Error("provider exploded");
  }
}

class ReservationRaceCooldownStore implements AlertCooldownStore {
  private readonly delegate = createInMemoryAlertCooldownStore();
  public reserveCalls = 0;

  public async findByFingerprint(fingerprint: string): Promise<AlertCooldownState | undefined> {
    return this.delegate.findByFingerprint(fingerprint);
  }

  public async reserveDelivery(
    input: AlertCooldownReservationInput,
  ): Promise<AlertCooldownReservationResult> {
    this.reserveCalls += 1;
    if (this.reserveCalls === 1) {
      return {
        reserved: false,
        state: {
          fingerprint: input.fingerprint,
          severity: input.severity,
          alertType: input.alertType,
          market: input.market,
          strategyId: input.strategyId,
          reasonCode: input.reasonCode,
          lastSentAt: null,
          lastSkippedAt: null,
          deliveryReservedUntil: null,
          payloadJson: input.payloadJson ?? {},
        },
      };
    }

    return this.delegate.reserveDelivery(input);
  }

  public async releaseDeliveryReservation(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.releaseDeliveryReservation(input);
  }

  public async recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSent(input);
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSkipped(input);
  }
}
