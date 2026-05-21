import { describe, expect, it } from "vitest";
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
