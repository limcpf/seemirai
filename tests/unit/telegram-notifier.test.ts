import { describe, expect, it } from "vitest";
import {
  createAlertFingerprint,
  createLiveOpsAlertRequest,
  createPaperTradeAlertRequest,
} from "../../src/application/index.js";
import {
  createTelegramNotifier,
  enforceTelegramMessageLimit,
  formatAlertMessage,
  formatDailyReportMessage,
  telegramMessageMaxLength,
} from "../../src/infrastructure/index.js";

describe("Telegram outbound notifier", () => {
  it("formats alert and daily report messages as plain text", () => {
    expect(
      formatAlertMessage({
        severity: "P0",
        title: "DB write failed",
        body: "risk evidence cannot be persisted",
        fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
        occurredAt: "2026-05-21T00:00:00.000Z",
      }),
    ).toBe(
      [
        "[P0 긴급] 거래 기록 저장 실패",
        "",
        "내용: 주문/리스크 증거를 저장하지 못해 거래 상태를 보수적으로 제한했습니다.",
        "원문: risk evidence cannot be persisted",
        "원인: 거래 기록 저장 실패",
        "",
        "추적 정보",
        "알림 식별자: alert:prod:paper:P0:db:global:global:db_write_failure",
        "발생 시각: 2026-05-21T00:00:00.000Z",
      ].join("\n"),
    );
    expect(
      formatDailyReportMessage({
        reportDate: "2026-05-21",
        summary: "orders: 0",
        generatedAt: "2026-05-21T15:00:00.000Z",
      }),
    ).toBe(
      [
        "[운영 일간 리포트] 2026-05-21",
        "",
        "요약",
        "orders: 0",
        "",
        "추적 정보",
        "생성 시각: 2026-05-21T15:00:00.000Z",
      ].join("\n"),
    );
  });

  it("formats kill switch control alerts as user-facing Korean guidance", () => {
    expect(
      formatAlertMessage({
        severity: "P0",
        title: "Kill switch HARD_STOP",
        body: "state: NORMAL -> HARD_STOP",
        fingerprint: "alert:prod:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
        occurredAt: "2026-05-21T00:00:00.000Z",
        metadata: {
          source: "kill_switch_control",
          actor: "operator",
          correlation_id: "corr-kill-switch-alert",
          from_state: "NORMAL",
          to_state: "HARD_STOP",
          reason_code: "db_write_failure",
          audit_event_id: "audit-1",
          risk_event_id: "risk-1",
          action_plan: {
            new_orders_blocked: true,
            strategy_evaluation_blocked: true,
            cancel_pending_paper_orders: true,
            auto_liquidate_open_positions: false,
            requires_manual_review: true,
          },
        },
      }),
    ).toBe(
      [
        "[P0 긴급] 거래 상태가 거래 불가능 상태로 바뀌었습니다",
        "",
        "현재 상태: 거래 불가능",
        "이전 상태: 정상 거래 가능",
        "원인: 거래 기록 저장 실패",
        "영향:",
        "- 신규 주문이 차단됩니다.",
        "- 자동 전략 평가가 중단됩니다.",
        "- 대기 중인 모의 주문 취소가 예약됩니다.",
        "- 보유 포지션은 자동 청산하지 않습니다.",
        "- 수동 점검 전까지 복구를 보류합니다.",
        "필요 조치: DB 상태와 최근 감사/리스크 이벤트 저장 여부를 확인해 주세요.",
        "",
        "추적 정보",
        "알림 식별자: alert:prod:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
        "발생 시각: 2026-05-21T00:00:00.000Z",
        "요청 ID: corr-kill-switch-alert",
        "감사 이벤트: audit-1",
        "리스크 이벤트: risk-1",
        "요청자: operator",
      ].join("\n"),
    );
  });

  it("formats paper trade event alerts with tracking details separated", () => {
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

    expect(
      formatAlertMessage({
        severity: request.severity,
        title: request.title,
        body: request.body,
        fingerprint: createAlertFingerprint(request),
        occurredAt: "2026-05-22T00:00:00.000Z",
        metadata: request.metadata ?? {},
      }),
    ).toBe(
      [
        "[P1 중요] PAPER 매매 알림: 슬리피지 임계값 초과",
        "",
        "상태: PAPER 주문 체결 품질이 기준을 벗어났습니다.",
        "원인: 실제 체결가가 요청 가격 대비 허용 슬리피지를 초과했습니다.",
        "영향: 전략 기대값이 비용 차감 후 음수로 바뀔 수 있습니다.",
        "필요 조치: 해당 전략과 마켓의 가격/호가 상태를 확인하고 필요하면 전략을 일시 중지해 주세요.",
        "주문: PAPER KRW-BTC 매수(BUY) 0.01",
        "가격: 지정가 100000000 체결가 100250000",
        "비용: 수수료 25 KRW 슬리피지 25 bps",
        "잔량: 0",
        "",
        "추적 정보",
        "알림 식별자: alert:prod:paper_trading:P1:paper_trade_event:krw-btc:breakout-v1:paper_slippage_threshold_exceeded",
        "발생 시각: 2026-05-22T00:00:00.000Z",
        "주문 ID: paper-order-1",
        "주문 키: paper-idem-1",
        "요청 ID: corr-paper-1",
        "이벤트 코드: SLIPPAGE_THRESHOLD_EXCEEDED",
        "사유 코드: paper_slippage_threshold_exceeded",
      ].join("\n"),
    );
  });

  it("formats M23 live ops event alerts with tracking details separated", () => {
    const request = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "ORDER_FILLED",
      operatingMode: "live_order_capable",
      liveOrderCapable: true,
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      side: "BUY",
      quantity: "0.0001",
      requestedPrice: "100000000",
      fillPrice: "100010000",
      filledQuantity: "0.0001",
      notionalKrw: "10000",
      feeAmount: "5",
      feeCurrency: "KRW",
      slippageBps: "1",
      remainingQuantity: "0",
      orderId: "local-order-1",
      brokerOrderId: "upbit-order-1",
      idempotencyKey: "idem-live-1",
      auditEventId: "audit-live-1",
      riskEventId: "risk-live-1",
      evidenceId: "fill-live-1",
      correlationId: "corr-live-fill",
      occurredAt: "2026-06-13T00:05:00.000Z",
    });

    expect(
      formatAlertMessage({
        severity: request.severity,
        title: request.title,
        body: request.body,
        fingerprint: createAlertFingerprint(request),
        occurredAt: "2026-06-13T00:05:00.000Z",
        metadata: request.metadata ?? {},
      }),
    ).toBe(
      [
        "[P1 중요] M23 live 운영 알림: 전체 체결",
        "",
        "상태: M23 live 주문이 전체 체결됐습니다.",
        "원인: 거래소 체결 또는 reconcile이 주문 잔량 0 상태를 확인했습니다.",
        "영향: 포지션, 수수료, realized/unrealized PnL이 daily report와 budget surface에 반영되어야 합니다.",
        "필요 조치: 체결가, 수수료, open exposure, PnL snapshot이 기대 범위인지 확인해 주세요.",
        "M23 상태: 실주문 가능 주문 가능 예",
        "주문: KRW-BTC 매수(BUY) 0.0001",
        "가격: 지정가 100000000 체결가 100010000 체결 수량 0.0001",
        "비용: 명목 금액 10000 KRW 수수료 5 KRW 슬리피지 1 bps",
        "잔량: 0",
        "",
        "추적 정보",
        "알림 식별자: alert:prod:live_autonomous_small_budget:P1:live_ops_event:krw-btc:m23-small-budget:live_order_filled:idem-live-1",
        "발생 시각: 2026-06-13T00:05:00.000Z",
        "마켓: KRW-BTC",
        "전략: m23-small-budget",
        "주문 ID: local-order-1",
        "거래소 주문: upbit-order-1",
        "주문 키: idem-live-1",
        "요청 ID: corr-live-fill",
        "감사 이벤트: audit-live-1",
        "리스크 이벤트: risk-live-1",
        "증거 ID: fill-live-1",
        "이벤트 코드: ORDER_FILLED",
        "사유 코드: live_order_filled",
      ].join("\n"),
    );

    const blocked = createLiveOpsAlertRequest({
      environment: "prod",
      runMode: "live_autonomous_small_budget",
      eventKind: "RECONCILE_BLOCKED",
      market: "KRW-BTC",
      strategyId: "m23-small-budget",
      blockedReason: "미체결 주문이 남아 있습니다.",
      evidenceId: "reconcile-block-1",
      occurredAt: "2026-06-13T00:06:00.000Z",
    });

    expect(
      formatAlertMessage({
        severity: blocked.severity,
        title: blocked.title,
        body: blocked.body,
        fingerprint: createAlertFingerprint(blocked),
        occurredAt: "2026-06-13T00:06:00.000Z",
        metadata: blocked.metadata ?? {},
      }),
    ).toContain("차단 사유: 미체결 주문이 남아 있습니다.");
  });

  it("sends Telegram sendMessage requests without adding inbound command behavior", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const notifier = createTelegramNotifier({
      botToken: "secret-token",
      chatId: "chat-1",
      async fetchImpl(input, init) {
        requests.push({ url: input, init });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });

    const result = await notifier.sendAlert({
      severity: "P1",
      title: "WebSocket lag",
      body: "lag exceeded threshold",
      fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
      occurredAt: "2026-05-21T00:00:00.000Z",
    });

    expect(result).toEqual({
      delivered: true,
      providerMessageId: "123",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.telegram.org/botsecret-token/sendMessage");
    expect(requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      chat_id: "chat-1",
      disable_web_page_preview: true,
      text: expect.stringContaining("[P1 중요] 실시간 시세 수신 지연"),
    });
    expect(Object.keys(notifier).join(" ")).not.toContain("webhook");
    expect(Object.keys(notifier).join(" ")).not.toContain("polling");
  });

  it("truncates oversized Telegram text before provider submission", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const notifier = createTelegramNotifier({
      botToken: "secret-token",
      chatId: "chat-1",
      async fetchImpl(input, init) {
        requests.push({ url: input, init });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
    });
    const longBody = "x".repeat(telegramMessageMaxLength + 200);

    await sendFixtureAlert(notifier, longBody);

    const payload = JSON.parse(String(requests[0]?.init.body)) as { text: string };
    expect(Array.from(payload.text)).toHaveLength(telegramMessageMaxLength);
    expect(payload.text.endsWith("\n... [truncated]")).toBe(true);
    expect(enforceTelegramMessageLimit("short")).toBe("short");
  });

  it("returns safe failure reasons for provider errors and timeouts", async () => {
    const httpFailure = createTelegramNotifier({
      botToken: "secret-token",
      chatId: "chat-1",
      async fetchImpl() {
        return new Response("provider failed with secret-token", { status: 500 });
      },
    });
    const timeout = createTelegramNotifier({
      botToken: "secret-token",
      chatId: "chat-1",
      async fetchImpl() {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });

    await expect(sendFixtureAlert(httpFailure)).resolves.toEqual({
      delivered: false,
      skippedReason: "telegram_http_500",
    });
    await expect(sendFixtureAlert(timeout)).resolves.toEqual({
      delivered: false,
      skippedReason: "telegram_timeout",
    });
  });
});

function sendFixtureAlert(
  notifier: ReturnType<typeof createTelegramNotifier>,
  body = "risk evidence cannot be persisted",
) {
  return notifier.sendAlert({
    severity: "P0",
    title: "DB write failed",
    body,
    fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
    occurredAt: "2026-05-21T00:00:00.000Z",
  });
}
