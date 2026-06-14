import { describe, expect, it } from "vitest";
import {
  createInMemoryAlertCooldownStore,
} from "../../src/application/index.js";
import type {
  AlertNotification,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";
import type {
  OrderIntent,
} from "../../src/domain/index.js";
import {
  defaultLiveOpsConfig,
  dispatchLiveOpsTelegramAlerts,
  planLiveOpsTelegramAlerts,
} from "../../src/runtime/index.js";
import type {
  LiveOpsLiveExecutionSummary,
  LiveOpsTelegramAlertPlanInput,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-14T00:00:00.000Z";

describe("production live ops Telegram alert mapper", () => {
  it("Telegram outbound readiness가 없으면 provider 호출 전 blocked plan으로 닫는다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      telegramReady: false,
    }));

    expect(plan).toMatchObject({
      status: "blocked",
      ready: false,
      alertCount: 0,
      providerDispatchAttempted: false,
    });
    expect(plan.checks.map((check) => check.code)).toContain("live_ops_telegram_not_ready");
    expect(plan.events).toHaveLength(0);
    expect(plan.requests).toHaveLength(0);
  });

  it("idle execution에서는 startup lifecycle alert만 계획하고 trade alert는 만들지 않는다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "idle",
        liveOrderCapable: false,
        attemptedOrderCount: 0,
      }),
    }));

    expect(plan).toMatchObject({
      status: "ready",
      ready: true,
      lifecycleAlertCount: 1,
      tradeAlertCount: 0,
      alertCount: 1,
    });
    expect(plan.events[0]).toMatchObject({
      eventKind: "TELEGRAM_CONNECTION_READY",
      liveOrderCapable: false,
    });
    expect(plan.requests[0]).toMatchObject({
      severity: "P2",
      reasonCode: "telegram_connection_ready",
      metadata: {
        source: "live_ops_event",
        event_kind: "TELEGRAM_CONNECTION_READY",
      },
    });
  });

  it("submitted execution은 lifecycle capable alert와 order submitted trade alert로 낮춘다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "submitted",
        ready: true,
        liveOrderCapable: true,
        attemptedOrderCount: 1,
        submittedOrderCount: 1,
        attemptStatus: "SUBMITTED",
        attemptId: "ops-attempt-1",
        idempotencyKey: "ops-idem-1",
        brokerOrderId: "upbit-order-1",
      }),
      orderIntent: createOrderIntent(),
      liveOrderCapableEvidenceId: "live-capable-evidence-1",
      tradeEvidenceId: "trade-evidence-1",
    }));

    expect(plan).toMatchObject({
      status: "ready",
      lifecycleAlertCount: 2,
      tradeAlertCount: 1,
      alertCount: 3,
    });
    expect(plan.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "LIVE_ORDER_CAPABLE_STARTED",
      "ORDER_SUBMITTED",
    ]);
    expect(plan.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
      "live_order_capable_started",
      "live_order_submitted",
    ]);
    expect(plan.requests[2]).toMatchObject({
      market: "KRW-BTC",
      strategyId: "fixture_order_strategy",
      dedupeKey: "ops-idem-1",
      metadata: {
        order_id: "ops-attempt-1",
        broker_order_id: "upbit-order-1",
        idempotency_key: "ops-idem-1",
        evidence_id: "trade-evidence-1",
      },
    });
    expect(plan.requests[2]?.body).toContain("주문: KRW-BTC 매수(BUY) 0.0001");
    expect(JSON.stringify(plan)).not.toContain("fake-upbit-secret-key");
  });

  it("fake notifier로 planned alert를 dispatch하고 provider 결과를 요약한다", async () => {
    const notifier = new RecordingNotifier();
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "submitted",
        ready: true,
        liveOrderCapable: true,
        attemptedOrderCount: 1,
        submittedOrderCount: 1,
        attemptStatus: "SUBMITTED",
        attemptId: "ops-attempt-1",
        idempotencyKey: "ops-idem-1",
        brokerOrderId: "upbit-order-1",
      }),
      orderIntent: createOrderIntent(),
    }));

    const result = await dispatchLiveOpsTelegramAlerts({
      plan,
      alertDispatch: {
        notifier,
        durableCooldownStore: createInMemoryAlertCooldownStore(),
        memoryCooldownStore: createInMemoryAlertCooldownStore(),
        clock: () => new Date(observedAt),
      },
    });

    expect(result).toMatchObject({
      status: "sent",
      attemptedCount: 3,
      deliveredCount: 3,
      cooldownHitCount: 0,
      retryPlannedCount: 0,
      failureCount: 0,
    });
    expect(notifier.alerts).toHaveLength(3);
    expect(notifier.alerts.map((alert) => alert.metadata?.source)).toEqual([
      "live_ops_event",
      "live_ops_event",
      "live_ops_event",
    ]);
  });
});

function createPlanInput(
  overrides: Partial<LiveOpsTelegramAlertPlanInput> = {},
): LiveOpsTelegramAlertPlanInput {
  return {
    config: defaultLiveOpsConfig,
    environment: "prod",
    runMode: "live_autonomous_small_budget",
    observedAt,
    telegramReady: true,
    liveExecution: liveExecutionSummary(),
    correlationId: "corr-live-ops",
    telegramConnectionEvidenceId: "telegram-ready-1",
    ...overrides,
  };
}

function liveExecutionSummary(
  overrides: Partial<LiveOpsLiveExecutionSummary> = {},
): LiveOpsLiveExecutionSummary {
  return {
    status: "idle",
    ready: true,
    liveOrderCapable: false,
    market: "KRW-BTC",
    observedAt,
    latestExecutionAt: null,
    orderIntentCount: 0,
    attemptedOrderCount: 0,
    submittedOrderCount: 0,
    attemptStatus: null,
    attemptId: null,
    idempotencyKey: null,
    brokerOrderId: null,
    message: "주문 후보가 없어 실주문 제출은 발생하지 않았습니다.",
    action: "다음 decision tick에서 다시 확인합니다.",
    checks: [],
    trace: {
      source: "live_ops_live_execution",
    },
    ...overrides,
  };
}

function createOrderIntent(): Extract<OrderIntent, { orderType: "LIMIT" }> {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "fixture_order_strategy",
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    requestedPrice: "100000000",
    idempotencyKey: "decision-fixture-order-intent",
    reason: "fixture order",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      expected_loss_bps_of_equity: "5",
    },
  };
}

class RecordingNotifier implements NotifierPort {
  public readonly alerts: AlertNotification[] = [];

  public async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    this.alerts.push(notification);
    return { delivered: true, providerMessageId: `message-${this.alerts.length}` };
  }

  public async sendDailyReport(_notification: DailyReportNotification): Promise<NotificationResult> {
    return { delivered: true };
  }
}
