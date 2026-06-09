import type {
  TelegramInboundReplyInput,
  TelegramInboundReplyPort,
  TelegramInboundReplyResult,
} from "../../application/index.js";
import { enforceTelegramMessageLimit } from "./message-format.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TelegramReplySenderOptions {
  botToken: string;
  fetchImpl?: FetchLike;
  providerTimeoutMs?: number;
}

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: {
    message_id?: number | string;
  };
}

/**
 * Telegram inbound command 응답 전용 `sendMessage` adapter다.
 *
 * outbound alert notifier와 달리 수신 message의 chat id로 답장을 보내지만, bot token과 provider raw response는 URL 구성과
 * 내부 파싱 경계에만 사용한다. 반환값은 provider message id 또는 정규화된 실패 reason만 담는다.
 */
export class TelegramReplySender implements TelegramInboundReplyPort {
  private readonly fetchImpl: FetchLike;
  private readonly providerTimeoutMs: number;

  public constructor(private readonly options: TelegramReplySenderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
  }

  /**
   * Telegram command 처리 결과를 원 message thread에 plain text로 답장한다.
   *
   * HTML/Markdown parse mode를 쓰지 않아 command 응답에 포함된 내부 식별자가 Telegram formatting 오류로 잘리거나 숨겨지지
   * 않게 한다.
   */
  public async sendReply(input: TelegramInboundReplyInput): Promise<TelegramInboundReplyResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.providerTimeoutMs);

    try {
      const response = await this.fetchImpl(createTelegramSendMessageUrl(this.options.botToken), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: input.chatId,
          text: enforceTelegramMessageLimit(input.text),
          disable_web_page_preview: true,
          ...(input.replyToMessageId === undefined ? {} : { reply_to_message_id: input.replyToMessageId }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // provider body는 token 또는 raw Telegram error를 포함할 수 있어 HTTP status만 남긴다.
        return {
          delivered: false,
          skippedReason: `telegram_reply_http_${response.status}`,
        };
      }

      const payload = await readTelegramSendMessageResponse(response);
      if (!payload.ok) {
        return {
          delivered: false,
          skippedReason: "telegram_reply_api_error",
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
          skippedReason: "telegram_reply_timeout",
        };
      }

      return {
        delivered: false,
        skippedReason: "telegram_reply_provider_error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Telegram inbound reply sender를 만든다.
 */
export function createTelegramReplySender(options: TelegramReplySenderOptions): TelegramReplySender {
  return new TelegramReplySender(options);
}

function createTelegramSendMessageUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

async function readTelegramSendMessageResponse(response: Response): Promise<TelegramSendMessageResponse> {
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
