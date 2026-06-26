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
  dispatchScheduledLiveOpsTelegramBriefing,
  planScheduledLiveOpsTelegramBriefing,
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

  it("후속 cancel 상태는 cancel requested/confirmed Telegram dispatch request로 낮춘다", () => {
    const cancelRequested = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "submitted",
        ready: true,
        liveOrderCapable: false,
        attemptedOrderCount: 1,
        submittedOrderCount: 1,
        attemptStatus: "CANCEL_REQUESTED",
        attemptId: "ops-attempt-1",
        idempotencyKey: "ops-idem-1",
        brokerOrderId: "upbit-order-1",
        message: "운영 cleanup이 미체결 주문 취소를 요청했습니다.",
      }),
      orderIntent: createOrderIntent(),
      tradeEventKind: "CANCEL_REQUESTED",
      tradeEvidenceId: "cancel-requested-evidence-1",
    }));
    const cancelConfirmed = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "submitted",
        ready: true,
        liveOrderCapable: false,
        attemptedOrderCount: 1,
        submittedOrderCount: 1,
        attemptStatus: "CANCEL_CONFIRMED",
        attemptId: "ops-attempt-1",
        idempotencyKey: "ops-idem-1",
        brokerOrderId: "upbit-order-1",
        message: "reconcile이 주문 취소 terminal 상태를 확인했습니다.",
      }),
      orderIntent: createOrderIntent(),
      tradeEventKind: "CANCEL_CONFIRMED",
      tradeEvidenceId: "cancel-confirmed-evidence-1",
    }));

    expect(cancelRequested.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "CANCEL_REQUESTED",
    ]);
    expect(cancelRequested.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
      "live_order_cancel_requested",
    ]);
    expect(cancelRequested.requests[1]).toMatchObject({
      market: "KRW-BTC",
      strategyId: "fixture_order_strategy",
      dedupeKey: "ops-idem-1",
      metadata: {
        event_kind: "CANCEL_REQUESTED",
        evidence_id: "cancel-requested-evidence-1",
      },
    });
    expect(cancelRequested.requests[1]?.body).toContain("취소 요청");

    expect(cancelConfirmed.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "CANCEL_CONFIRMED",
    ]);
    expect(cancelConfirmed.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
      "live_order_cancel_confirmed",
    ]);
    expect(cancelConfirmed.requests[1]).toMatchObject({
      market: "KRW-BTC",
      strategyId: "fixture_order_strategy",
      dedupeKey: "ops-idem-1",
      metadata: {
        event_kind: "CANCEL_CONFIRMED",
        evidence_id: "cancel-confirmed-evidence-1",
      },
    });
    expect(cancelConfirmed.requests[1]?.body).toContain("취소 완료 상태");
  });

  it("generic blocked execution은 RiskGate alert로 추정하지 않는다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "blocked",
        ready: false,
        liveOrderCapable: false,
        attemptedOrderCount: 0,
        submittedOrderCount: 0,
        attemptStatus: null,
        message: "live broker port가 연결되지 않아 broker 제출을 중단했습니다.",
      }),
      orderIntent: createOrderIntent(),
    }));

    expect(plan).toMatchObject({
      status: "ready",
      lifecycleAlertCount: 1,
      tradeAlertCount: 0,
      alertCount: 1,
    });
    expect(plan.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
    ]);
    expect(plan.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
    ]);
    expect(JSON.stringify(plan)).not.toContain("RISK_BLOCKED");
  });

  it("runtime BLOCKED attempt는 실제 차단 alert로 낮춘다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "blocked",
        ready: false,
        liveOrderCapable: false,
        attemptedOrderCount: 1,
        submittedOrderCount: 0,
        attemptStatus: "BLOCKED",
        message: "현재 CostModel/RiskGate 입력이 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
      }),
      orderIntent: createOrderIntent(),
      tradeEvidenceId: "blocked-attempt-evidence-1",
    }));

    expect(plan).toMatchObject({
      status: "ready",
      lifecycleAlertCount: 1,
      tradeAlertCount: 1,
      alertCount: 2,
    });
    expect(plan.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "RISK_BLOCKED",
    ]);
    expect(plan.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
      "live_order_risk_blocked",
    ]);
  });

  it("rejected execution은 명시적인 RiskGate 차단 alert로 낮춘다", () => {
    const plan = planLiveOpsTelegramAlerts(createPlanInput({
      liveExecution: liveExecutionSummary({
        status: "rejected",
        ready: false,
        liveOrderCapable: false,
        attemptedOrderCount: 1,
        submittedOrderCount: 0,
        attemptStatus: "REJECTED",
        message: "현재 CostModel/RiskGate 입력이 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
      }),
      orderIntent: createOrderIntent(),
      tradeEvidenceId: "risk-block-evidence-1",
    }));

    expect(plan).toMatchObject({
      status: "ready",
      lifecycleAlertCount: 1,
      tradeAlertCount: 1,
      alertCount: 2,
    });
    expect(plan.events.map((event) => event.eventKind)).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "RISK_BLOCKED",
    ]);
    expect(plan.requests.map((request) => request.reasonCode)).toEqual([
      "telegram_connection_ready",
      "live_order_risk_blocked",
    ]);
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

describe("scheduled Live Ops Telegram briefing dispatch", () => {
  it("keeps scheduled briefing disabled unless config explicitly enables it", () => {
    const plan = planScheduledLiveOpsTelegramBriefing(createScheduledBriefingPlanInput({
      config: {
        scheduledEnabled: false,
        scheduleKey: "ops-hourly",
      },
    }));

    expect(plan).toMatchObject({
      status: "disabled",
      ready: false,
      alertCount: 0,
      message: "정기 Live Ops Telegram 브리핑은 설정에서 비활성입니다.",
    });
    expect(plan.requests).toHaveLength(0);
  });

  it("uses alert cooldown fingerprinting so repeated scheduled briefings do not spam Telegram", async () => {
    const notifier = new RecordingNotifier();
    const cooldownStore = createInMemoryAlertCooldownStore();
    const plan = planScheduledLiveOpsTelegramBriefing(createScheduledBriefingPlanInput());

    expect(plan).toMatchObject({
      status: "ready",
      ready: true,
      alertCount: 1,
    });
    expect(plan.requests[0]).toMatchObject({
      severity: "P3",
      alertType: "live_ops_briefing",
      reasonCode: "scheduled_live_ops_briefing",
      dedupeKey: "ops-hourly",
      title: "Live Ops 정기 브리핑",
      metadata: {
        source: "live_ops_briefing",
        briefing_source_fingerprint: "sha256:briefing-fixture",
      },
    });

    const first = await dispatchScheduledLiveOpsTelegramBriefing({
      plan,
      alertDispatch: {
        notifier,
        durableCooldownStore: cooldownStore,
        memoryCooldownStore: cooldownStore,
        clock: () => new Date(observedAt),
      },
    });
    const duplicate = await dispatchScheduledLiveOpsTelegramBriefing({
      plan,
      alertDispatch: {
        notifier,
        durableCooldownStore: cooldownStore,
        memoryCooldownStore: cooldownStore,
        clock: () => new Date(observedAt),
      },
    });

    expect(first).toMatchObject({
      status: "sent",
      attemptedCount: 1,
      deliveredCount: 1,
      cooldownHitCount: 0,
    });
    expect(duplicate).toMatchObject({
      status: "skipped",
      attemptedCount: 1,
      deliveredCount: 0,
      cooldownHitCount: 1,
    });
    expect(notifier.alerts).toHaveLength(1);
    expect(notifier.alerts[0]?.body).toContain("Live Ops 브리핑");
    expect(notifier.alerts[0]?.body).toContain("상태: 실매매 가능");
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

function createScheduledBriefingPlanInput(
  overrides: Partial<Parameters<typeof planScheduledLiveOpsTelegramBriefing>[0]> = {},
): Parameters<typeof planScheduledLiveOpsTelegramBriefing>[0] {
  return {
    config: {
      scheduledEnabled: true,
      scheduleKey: "ops-hourly",
    },
    environment: "prod",
    runMode: "live_autonomous_small_budget",
    observedAt,
    briefingText: [
      "Live Ops 브리핑",
      "상태: 실매매 가능",
      "원인: deterministic snapshot 기준입니다.",
      "영향: 주문 side effect 없이 조회만 완료했습니다.",
      "필요 조치: 추적 정보를 확인하세요.",
    ].join("\n"),
    briefingSourceFingerprint: "sha256:briefing-fixture",
    correlationId: "corr-live-ops-briefing",
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
