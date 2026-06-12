import { describe, expect, it } from "vitest";
import type {
  AlertCooldownReleaseInput,
  AlertCooldownRecordInput,
  AlertCooldownReservationInput,
  AlertCooldownReservationResult,
  AlertCooldownState,
  AlertCooldownStore,
  AlertDispatchServiceOptions,
  AlertNotification,
  AuditEvent,
  AuditEventReceipt,
  AuditLogPort,
  DailyReportNotification,
  KillSwitchAlertDispatchOptions,
  NotificationRetryJobPlan,
  NotificationRetryJobQueue,
  NotificationRetryJobEnqueueReceipt,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import {
  createAlertDispatchRequestFromNotificationRetryPayload,
  createKillSwitchControlDecision,
  createAlertFingerprint,
  createInMemoryAlertCooldownStore,
  createLiveOpsAlertRequest,
  createNotificationRetryJobPlan,
  createPaperTradeAlertRequest,
  dispatchKillSwitchControlAlert,
  dispatchAlertWithCooldown,
  dispatchLiveOpsAlert,
  dispatchNotificationRetryJob,
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

  it("maps P1 paper trade events to immediate Telegram alert candidates", () => {
    const request = createPaperTradeAlertRequest({
      environment: "prod",
      runMode: "paper_trading",
      eventKind: "SLIPPAGE_THRESHOLD_EXCEEDED",
      market: "KRW-BTC",
      strategyId: "breakout-v1",
      side: "BUY",
      quantity: "0.01",
      requestedPrice: "100000000",
      fillPrice: "100250000",
      feeAmount: "25",
      feeCurrency: "KRW",
      slippageBps: "25",
      remainingQuantity: "0",
      orderId: "paper-order-1",
      idempotencyKey: "paper-idem-1",
      correlationId: "corr-paper-1",
      occurredAt: "2026-05-22T00:00:00.000Z",
    });

    expect(request).toMatchObject({
      severity: "P1",
      alertType: "paper_trade_event",
      reasonCode: "paper_slippage_threshold_exceeded",
      market: "KRW-BTC",
      strategyId: "breakout-v1",
      title: "PAPER 매매 알림: 슬리피지 임계값 초과",
      metadata: {
        source: "paper_trade_event",
        paper_mode: "PAPER",
        event_kind: "SLIPPAGE_THRESHOLD_EXCEEDED",
        delivery_policy: "immediate",
        order_id: "paper-order-1",
        idempotency_key: "paper-idem-1",
        correlation_id: "corr-paper-1",
      },
    });
    expect(request.body).toContain("주문: PAPER KRW-BTC BUY 0.01");
    expect(request.body).toContain("필요 조치: 해당 전략과 마켓의 가격/호가 상태를 확인");
  });

  it("uses P2 cooldown policy for normal paper lifecycle alerts", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const request = createPaperTradeAlertRequest({
      environment: "prod",
      runMode: "paper_trading",
      eventKind: "ORDER_SUBMITTED",
      market: "KRW-ETH",
      strategyId: "mean-reversion-v1",
      side: "SELL",
      quantity: "0.2",
      requestedPrice: "5000000",
      orderId: "paper-order-2",
      idempotencyKey: "paper-idem-2",
      correlationId: "corr-paper-2",
      occurredAt: "2026-05-22T00:00:00.000Z",
    });

    const first = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        memoryCooldownStore: cooldownStore,
      },
      request,
    );
    const duplicate = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
        memoryCooldownStore: cooldownStore,
      },
      {
        ...request,
        occurredAt: "2026-05-22T00:01:00.000Z",
      },
    );

    expect(request.metadata).toMatchObject({
      delivery_policy: "cooldown",
    });
    expect(first.notification.delivered).toBe(true);
    expect(duplicate).toMatchObject({
      cooldownHit: true,
      notification: {
        delivered: false,
        skippedReason: "alert_cooldown_active",
      },
    });
    expect(notifier.alerts).toHaveLength(1);
  });

  it("maps low-priority paper event noise to P3 summary alert candidates", () => {
    const request = createPaperTradeAlertRequest({
      environment: "prod",
      runMode: "paper_trading",
      eventKind: "DISCARDED_CANDIDATES_SUMMARY",
      market: "KRW-BTC",
      strategyId: "breakout-v1",
      side: "BUY",
      quantity: "3 candidates",
      correlationId: "corr-paper-summary",
      occurredAt: "2026-05-22T00:00:00.000Z",
    });

    expect(request).toMatchObject({
      severity: "P3",
      reasonCode: "paper_discarded_candidates_summary",
      metadata: {
        delivery_policy: "summary",
        event_label: "폐기 후보 요약",
      },
    });
  });

  it("separates M23 Telegram connection and live order capable lifecycle alerts", () => {
    const connection = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "TELEGRAM_CONNECTION_READY",
      operatingMode: "live_armed",
      liveOrderCapable: false,
      correlationId: "corr-live-connection",
      occurredAt: "2026-06-13T00:00:00.000Z",
    });
    const liveOrderCapable = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "LIVE_ORDER_CAPABLE_STARTED",
      operatingMode: "live_order_capable",
      liveOrderCapable: true,
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      auditEventId: "audit-live-1",
      evidenceId: "live-ops-status-1",
      correlationId: "corr-live-capable",
      occurredAt: "2026-06-13T00:01:00.000Z",
    });

    expect(connection).toMatchObject({
      severity: "P2",
      alertType: "live_ops_event",
      reasonCode: "telegram_connection_ready",
      title: "M23 live 운영 알림: Telegram 연결 확인",
      metadata: {
        source: "live_ops_event",
        event_kind: "TELEGRAM_CONNECTION_READY",
        delivery_policy: "cooldown",
        operating_mode: "live_armed",
        live_order_capable: false,
      },
    });
    expect(liveOrderCapable).toMatchObject({
      severity: "P1",
      alertType: "live_ops_event",
      reasonCode: "live_order_capable_started",
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      metadata: {
        source: "live_ops_event",
        event_kind: "LIVE_ORDER_CAPABLE_STARTED",
        delivery_policy: "immediate",
        audit_event_id: "audit-live-1",
        evidence_id: "live-ops-status-1",
      },
    });
    expect(connection.body).toContain("상태: Telegram 운영 알림 채널이 연결됐습니다.");
    expect(liveOrderCapable.body).toContain("필요 조치: 손실 ceiling");
    expect(createAlertFingerprint(connection)).not.toBe(createAlertFingerprint(liveOrderCapable));
  });

  it("maps M23 live trade lifecycle events to safe alert payloads", () => {
    const submitted = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "ORDER_SUBMITTED",
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      side: "BUY",
      quantity: "0.0001",
      requestedPrice: "100000000",
      notionalKrw: "10000",
      orderId: "local-order-1",
      brokerOrderId: "upbit-order-1",
      idempotencyKey: "idem-live-1",
      correlationId: "corr-live-order",
      occurredAt: "2026-06-13T00:02:00.000Z",
    });
    const blocked = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "RECONCILE_BLOCKED",
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      blockedReason: "미체결 주문이 남아 있습니다.",
      riskEventId: "risk-live-1",
      safeSummary: "미체결 주문이 남아 신규 entry를 보류했습니다.",
      occurredAt: "2026-06-13T00:03:00.000Z",
    });
    const secondSubmitted = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "ORDER_SUBMITTED",
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      side: "BUY",
      quantity: "0.0001",
      requestedPrice: "100000000",
      notionalKrw: "10000",
      idempotencyKey: "idem-live-2",
      orderId: "local-order-2",
      brokerOrderId: "upbit-order-2",
      correlationId: "corr-live-order-2",
      occurredAt: "2026-06-13T00:02:10.000Z",
    });

    expect(submitted).toMatchObject({
      severity: "P1",
      reasonCode: "live_order_submitted",
      dedupeKey: "idem-live-1",
      metadata: {
        event_group: "trade",
        order_id: "local-order-1",
        broker_order_id: "upbit-order-1",
        idempotency_key: "idem-live-1",
      },
    });
    expect(submitted.body).toContain("주문: KRW-BTC 매수(BUY) 0.0001");
    expect(submitted.body).toContain("비용: 명목 금액 10000 KRW");
    expect(blocked).toMatchObject({
      severity: "P1",
      reasonCode: "live_order_reconcile_blocked",
      metadata: {
        blocked_reason: "미체결 주문이 남아 있습니다.",
        risk_event_id: "risk-live-1",
        safe_summary: "미체결 주문이 남아 신규 entry를 보류했습니다.",
      },
    });
    expect(blocked.body).toContain("상태: M23 live 주문 후보가 reconcile 조건 때문에 차단됐습니다.");
    expect(blocked.body).toContain("요약: 미체결 주문이 남아 신규 entry를 보류했습니다.");
    expect(createAlertFingerprint(submitted)).toContain(":live_order_submitted:idem-live-1");
    expect(createAlertFingerprint(secondSubmitted)).toContain(":live_order_submitted:idem-live-2");
    expect(createAlertFingerprint(submitted)).not.toBe(createAlertFingerprint(secondSubmitted));
  });

  it("keeps P1 paper alert provider failures isolated and returns retry candidates", async () => {
    const notifier = new ThrowingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const request = createPaperTradeAlertRequest({
      environment: "prod",
      runMode: "paper_trading",
      eventKind: "CANCEL_REQUOTE_FAILED",
      market: "KRW-BTC",
      strategyId: "breakout-v1",
      side: "BUY",
      quantity: "0.01",
      orderId: "paper-order-3",
      idempotencyKey: "paper-idem-3",
      correlationId: "corr-paper-3",
      occurredAt: "2026-05-22T00:00:00.000Z",
    });

    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      request,
    );

    expect(result.notification).toMatchObject({
      delivered: false,
      skippedReason: "notification_provider_exception",
    });
    expect(result.retryJobPlan).toMatchObject({
      jobType: notificationRetryJobType,
      payloadJson: {
        correlation_id: "corr-paper-3",
        metadata: {
          order_id: "paper-order-3",
          idempotency_key: "paper-idem-3",
        },
      },
    });
    expect(result.failureEvaluation.state.consecutiveFailures).toBe(1);
  });

  it("keeps M23 P0/P1 lifecycle alert failures on the notification retry path", async () => {
    const notifier = new ThrowingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const event = {
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "CRASH_DETECTED",
      restartId: "restart-live-1",
      evidenceId: "supervisor-crash-1",
      correlationId: "corr-live-crash",
      occurredAt: "2026-06-13T00:04:00.000Z",
    } as const;

    const result = await dispatchLiveOpsAlert({
      alertDispatch: {
        notifier,
        durableCooldownStore: cooldownStore,
      },
      event,
    });

    expect(result.notification).toMatchObject({
      delivered: false,
      skippedReason: "notification_provider_exception",
    });
    expect(result.retryJobPlan).toMatchObject({
      jobType: notificationRetryJobType,
      payloadJson: {
        severity: "P0",
        alert_type: "live_ops_event",
        correlation_id: "corr-live-crash",
        metadata: {
          source: "live_ops_event",
          event_kind: "CRASH_DETECTED",
          restart_id: "restart-live-1",
          evidence_id: "supervisor-crash-1",
        },
      },
    });
    expect(result.failureEvaluation.state.consecutiveFailures).toBe(1);
  });

  it("accumulates M23 live ops alert provider failures across wrapper calls", async () => {
    const notifier = new ThrowingNotifier();
    const alertDispatch: AlertDispatchServiceOptions = {
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
    };
    const event = {
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "TELEGRAM_PROVIDER_FAILURE_SUSTAINED" as const,
      correlationId: "corr-live-telegram-failure",
      occurredAt: "2026-06-13T00:06:00.000Z",
    };

    await dispatchLiveOpsAlert({ alertDispatch, event });
    await dispatchLiveOpsAlert({ alertDispatch, event });
    const third = await dispatchLiveOpsAlert({ alertDispatch, event });

    expect(third.failureEvaluation).toMatchObject({
      manualReviewReasonCode: "notification_consecutive_failure",
      state: {
        consecutiveFailures: 3,
      },
    });
    expect(alertDispatch.failureState).toMatchObject({
      consecutiveFailures: 3,
    });
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

  it("keeps notification retry jobs pending when delivery is blocked by reservation race", async () => {
    const retryJobPlan = createNotificationRetryJobPlan({
      fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
      occurredAt: "2026-05-21T00:00:00.000Z",
      request: {
        environment: "prod",
        runMode: "paper",
        severity: "P1",
        alertType: "lag",
        market: "KRW-BTC",
        reasonCode: "public_websocket_lag",
        title: "WebSocket lag",
        body: "lag exceeded threshold",
      },
    });
    const notifier = new RecordingNotifier();

    const result = await dispatchNotificationRetryJob({
      alertDispatch: {
        notifier,
        durableCooldownStore: new PersistentReservationRaceCooldownStore(),
      },
      payloadJson: retryJobPlan.payloadJson,
    });

    expect(result).toMatchObject({
      status: "FAILED",
      alertDispatch: {
        cooldownHit: true,
        notification: {
          delivered: false,
          skippedReason: "alert_reservation_race",
        },
      },
      errorMessage: "notification retry deferred: alert_reservation_race",
    });
    expect(notifier.alerts).toHaveLength(0);
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

  it("keeps a newer memory reservation when an older release arrives late", async () => {
    const cooldownStore = createInMemoryAlertCooldownStore();
    const input: AlertCooldownRecordInput = {
      fingerprint: "alert:prod:paper:P0:db:global:global:late_provider_failure",
      severity: "P0",
      alertType: "db",
      market: null,
      strategyId: null,
      reasonCode: "late_provider_failure",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };

    await cooldownStore.reserveDelivery({
      ...input,
      cooldownMs: 60_000,
      reserveUntil: "2026-05-21T00:01:00.000Z",
    });
    await cooldownStore.reserveDelivery({
      ...input,
      occurredAt: "2026-05-21T00:01:01.000Z",
      cooldownMs: 60_000,
      reserveUntil: "2026-05-21T00:02:01.000Z",
    });
    const staleRelease = await cooldownStore.releaseDeliveryReservation({
      ...input,
      occurredAt: "2026-05-21T00:01:02.000Z",
      reservedUntil: "2026-05-21T00:01:00.000Z",
    });

    expect(staleRelease.deliveryReservedUntil).toBe("2026-05-21T00:02:01.000Z");
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

  it("persists retry job dimensions so workers can reconstruct alert dispatch requests", () => {
    const retryJobPlan = createNotificationRetryJobPlan({
      fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
      occurredAt: "2026-05-21T00:00:00.000Z",
      request: {
        environment: "prod",
        runMode: "paper",
        severity: "P1",
        alertType: "lag",
        market: "KRW-BTC",
        reasonCode: "public_websocket_lag",
        title: "WebSocket lag",
        body: "lag exceeded threshold",
        correlationId: "corr-retry-payload",
        metadata: {
          source: "market_data_runtime",
        },
      },
    });

    expect(retryJobPlan.payloadJson).toMatchObject({
      environment: "prod",
      run_mode: "paper",
      severity: "P1",
      alert_type: "lag",
      market: "KRW-BTC",
      strategy_id: null,
      reason_code: "public_websocket_lag",
      correlation_id: "corr-retry-payload",
    });
    expect(createAlertDispatchRequestFromNotificationRetryPayload(retryJobPlan.payloadJson)).toMatchObject({
      environment: "prod",
      runMode: "paper",
      severity: "P1",
      alertType: "lag",
      market: "KRW-BTC",
      reasonCode: "public_websocket_lag",
      correlationId: "corr-retry-payload",
      metadata: {
        source: "market_data_runtime",
      },
    });
  });

  it("enqueues P0/P1 retry jobs when a runtime queue is attached", async () => {
    const notifier = new ThrowingNotifier();
    const retryJobQueue = new RecordingNotificationRetryJobQueue();
    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: createInMemoryAlertCooldownStore(),
        retryJobQueue,
      },
      {
        environment: "prod",
        runMode: "paper",
        severity: "P1",
        alertType: "lag",
        market: "KRW-BTC",
        reasonCode: "public_websocket_lag",
        title: "WebSocket lag",
        body: "lag exceeded threshold",
        occurredAt: "2026-05-21T00:00:00.000Z",
        correlationId: "corr-retry-enqueue",
      },
    );

    expect(retryJobQueue.plans).toHaveLength(1);
    expect(result.retryJobEnqueueReceipt).toMatchObject({
      jobType: "notification_retry",
      idempotencyKey:
        "notification_retry:alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag:2026-05-21T00:00:00.000Z",
      created: true,
      jobId: "notification-retry-job-1",
    });
  });

  it("does not fail original alert dispatch when retry enqueue fails", async () => {
    const notifier = new ThrowingNotifier();
    const auditLog = new RecordingAuditLog();
    const result = await dispatchAlertWithCooldown(
      {
        notifier,
        durableCooldownStore: createInMemoryAlertCooldownStore(),
        retryJobQueue: new ThrowingNotificationRetryJobQueue(),
        auditLog,
      },
      {
        environment: "prod",
        runMode: "paper",
        severity: "P0",
        alertType: "db",
        reasonCode: "db_write_failure",
        title: "DB write failed",
        body: "risk evidence cannot be persisted",
        occurredAt: "2026-05-21T00:00:00.000Z",
      },
    );

    expect(result.notification.delivered).toBe(false);
    expect(result.retryJobEnqueueFailure).toMatchObject({
      reasonCode: "notification_retry_enqueue_failed",
      message: "queue unavailable",
    });
    expect(auditLog.events.at(-1)?.metadata).toMatchObject({
      retry_job_enqueue_failure: {
        reasonCode: "notification_retry_enqueue_failed",
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
    expect(controlResult.actionPlan).toMatchObject({
      newOrdersBlocked: true,
      cancelPendingPaperOrders: true,
      requiresManualReview: true,
    });
    expect(notifier.alerts[0]).toMatchObject({
      severity: "P0",
      title: "Kill switch HARD_STOP",
      metadata: {
        source: "kill_switch_control",
        correlation_id: "corr-kill-switch-alert",
        reason_code: "db_write_failure",
        audit_event_id: "audit-1",
        risk_event_id: "risk-1",
        action_plan: {
          new_orders_blocked: true,
          cancel_pending_paper_orders: true,
          requires_manual_review: true,
        },
      },
    });
    expect(notifier.alerts[0]?.body).toContain("new_orders_blocked: true");
  });

  it("accumulates notification failure state across runtime kill switch alert calls", async () => {
    const notifier = new RecordingNotifier();
    notifier.nextResult = {
      delivered: false,
      skippedReason: "telegram_timeout",
    };
    const alertDispatch: KillSwitchAlertDispatchOptions = {
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

  it("serializes concurrent runtime failure-state updates", async () => {
    const notifier = new RecordingNotifier();
    notifier.nextResult = {
      delivered: false,
      skippedReason: "telegram_timeout",
    };
    const alertDispatch: KillSwitchAlertDispatchOptions = {
      environment: "prod",
      runMode: "paper_trading",
      notifier,
      durableCooldownStore: createInMemoryAlertCooldownStore(),
    };
    const controlRequest = {
      targetState: "HARD_STOP" as const,
      reasonCode: "db_write_failure",
      correlationId: "corr-kill-switch-alert-concurrent-failure",
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

    const results = await Promise.all([
      dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult }),
      dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult }),
      dispatchKillSwitchControlAlert({ alertDispatch, controlRequest, controlResult }),
    ]);

    expect(results.map((result) => result?.failureEvaluation.state.consecutiveFailures)).toEqual([
      1,
      2,
      3,
    ]);
    expect(alertDispatch.failureState).toMatchObject({
      consecutiveFailures: 3,
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

class RecordingNotificationRetryJobQueue implements NotificationRetryJobQueue {
  public readonly plans: NotificationRetryJobPlan[] = [];

  public async enqueueNotificationRetryJob(
    plan: NotificationRetryJobPlan,
  ): Promise<NotificationRetryJobEnqueueReceipt> {
    this.plans.push(plan);
    return {
      jobType: "notification_retry",
      idempotencyKey: plan.idempotencyKey,
      created: true,
      jobId: `notification-retry-job-${this.plans.length}`,
    };
  }
}

class ThrowingNotificationRetryJobQueue implements NotificationRetryJobQueue {
  public async enqueueNotificationRetryJob(
    _plan: NotificationRetryJobPlan,
  ): Promise<NotificationRetryJobEnqueueReceipt> {
    throw new Error("queue unavailable");
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

  public async releaseDeliveryReservation(input: AlertCooldownReleaseInput): Promise<AlertCooldownState> {
    return this.delegate.releaseDeliveryReservation(input);
  }

  public async recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSent(input);
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSkipped(input);
  }
}

class PersistentReservationRaceCooldownStore implements AlertCooldownStore {
  private readonly delegate = createInMemoryAlertCooldownStore();

  public async findByFingerprint(fingerprint: string): Promise<AlertCooldownState | undefined> {
    return this.delegate.findByFingerprint(fingerprint);
  }

  public async reserveDelivery(
    input: AlertCooldownReservationInput,
  ): Promise<AlertCooldownReservationResult> {
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

  public async releaseDeliveryReservation(input: AlertCooldownReleaseInput): Promise<AlertCooldownState> {
    return this.delegate.releaseDeliveryReservation(input);
  }

  public async recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSent(input);
  }

  public async recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState> {
    return this.delegate.recordSkipped(input);
  }
}
