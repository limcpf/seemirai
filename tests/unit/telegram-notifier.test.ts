import { describe, expect, it } from "vitest";
import {
  createTelegramNotifier,
  formatAlertMessage,
  formatDailyReportMessage,
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
        "[P0] DB write failed",
        "risk evidence cannot be persisted",
        "fingerprint: alert:prod:paper:P0:db:global:global:db_write_failure",
        "occurred_at: 2026-05-21T00:00:00.000Z",
      ].join("\n"),
    );
    expect(
      formatDailyReportMessage({
        reportDate: "2026-05-21",
        summary: "orders: 0",
        generatedAt: "2026-05-21T15:00:00.000Z",
      }),
    ).toBe(["[DAILY_REPORT] 2026-05-21", "orders: 0", "generated_at: 2026-05-21T15:00:00.000Z"].join("\n"));
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
      text: expect.stringContaining("[P1] WebSocket lag"),
    });
    expect(Object.keys(notifier).join(" ")).not.toContain("webhook");
    expect(Object.keys(notifier).join(" ")).not.toContain("polling");
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

function sendFixtureAlert(notifier: ReturnType<typeof createTelegramNotifier>) {
  return notifier.sendAlert({
    severity: "P0",
    title: "DB write failed",
    body: "risk evidence cannot be persisted",
    fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
    occurredAt: "2026-05-21T00:00:00.000Z",
  });
}
