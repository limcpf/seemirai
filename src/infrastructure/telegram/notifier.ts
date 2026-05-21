import type {
  AlertNotification,
  DailyReportNotification,
  NotificationResult,
  NotifierPort,
} from "../../application/index.js";
import type { TimestampInput } from "../../domain/index.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  fetchImpl?: FetchLike;
  providerTimeoutMs?: number;
}

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: {
    message_id?: number | string;
  };
  description?: string;
}

/**
 * Telegram `sendMessage` outbound API만 사용하는 notifier adapter다.
 *
 * 이 adapter는 webhook, polling, command 수신 경로를 만들지 않는다. alert/daily report payload를 plain text로 변환해
 * Telegram provider에 POST하고, token은 URL 내부에서만 사용하며 결과나 error message에 노출하지 않는다.
 */
export class TelegramNotifier implements NotifierPort {
  private readonly fetchImpl: FetchLike;
  private readonly providerTimeoutMs: number;

  public constructor(private readonly options: TelegramNotifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
  }

  public async sendAlert(notification: AlertNotification): Promise<NotificationResult> {
    return this.sendPlainText(formatAlertMessage(notification));
  }

  public async sendDailyReport(notification: DailyReportNotification): Promise<NotificationResult> {
    return this.sendPlainText(formatDailyReportMessage(notification));
  }

  private async sendPlainText(text: string): Promise<NotificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.providerTimeoutMs);

    try {
      const response = await this.fetchImpl(createTelegramSendMessageUrl(this.options.botToken), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // HTTP status만 남기고 Telegram token이나 provider 응답 원문은 결과에 담지 않는다.
        return {
          delivered: false,
          skippedReason: `telegram_http_${response.status}`,
        };
      }

      const payload = await readTelegramResponse(response);
      if (!payload.ok) {
        return {
          delivered: false,
          skippedReason: "telegram_api_error",
        };
      }

      return {
        delivered: true,
        ...(payload.result?.message_id === undefined
          ? {}
          : { providerMessageId: String(payload.result.message_id) }),
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          delivered: false,
          skippedReason: "telegram_timeout",
        };
      }

      return {
        delivered: false,
        skippedReason: "telegram_provider_error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Telegram outbound notifier를 만든다.
 */
export function createTelegramNotifier(options: TelegramNotifierOptions): TelegramNotifier {
  return new TelegramNotifier(options);
}

/**
 * Telegram alert plain text를 만든다.
 *
 * HTML/Markdown parse mode를 쓰지 않아 escaping 오류나 command-like text 해석을 피한다.
 */
export function formatAlertMessage(notification: AlertNotification): string {
  return [
    `[${notification.severity}] ${notification.title}`,
    notification.body,
    `fingerprint: ${notification.fingerprint}`,
    `occurred_at: ${toIsoTimestamp(notification.occurredAt)}`,
  ].join("\n");
}

/**
 * Telegram daily report plain text를 만든다.
 *
 * daily report aggregator는 후속 sub PR 범위이므로 여기서는 NotifierPort contract에 맞춘 전송 format만 제공한다.
 */
export function formatDailyReportMessage(notification: DailyReportNotification): string {
  return [
    `[DAILY_REPORT] ${notification.reportDate}`,
    notification.summary,
    `generated_at: ${toIsoTimestamp(notification.generatedAt)}`,
  ].join("\n");
}

function createTelegramSendMessageUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

async function readTelegramResponse(response: Response): Promise<TelegramSendMessageResponse> {
  const payload: unknown = await response.json();
  if (!isTelegramSendMessageResponse(payload)) {
    return { ok: false };
  }

  return payload;
}

function isTelegramSendMessageResponse(value: unknown): value is TelegramSendMessageResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  return typeof (value as { ok: unknown }).ok === "boolean";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

function toIsoTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}
