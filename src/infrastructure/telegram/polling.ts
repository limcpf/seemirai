import type { TelegramInboundCommandMessage } from "../../application/index.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Telegram getUpdates polling 요청 입력이다.
 *
 * offset은 마지막 처리 update 다음 값을 의미하며, timeout/limit은 provider long polling과 batch 크기를 제한해 무한 대기나
 * 대량 update 처리로 runtime loop가 막히지 않게 한다.
 */
export interface TelegramPollingRequest {
  offset?: number;
  timeoutSeconds: number;
  limit: number;
}

/**
 * Telegram polling provider가 반환하는 성공 batch다.
 *
 * raw provider payload는 포함하지 않고, command parser가 필요한 최소 message projection만 보존한다.
 */
export interface TelegramPollingOkResult {
  status: "ok";
  updates: readonly TelegramInboundCommandMessage[];
  nextOffset: number | null;
}

/**
 * Telegram polling provider 실패 결과다.
 *
 * HTTP status 또는 정규화된 reason code만 남기고 provider response body나 bot token을 포함하지 않는다.
 */
export interface TelegramPollingFailedResult {
  status: "failed";
  reasonCode: string;
}

/**
 * Telegram polling provider 결과 union이다.
 *
 * caller는 실패를 exception이 아니라 audit/status evidence로 처리할 수 있으며, 성공 batch도 raw update 없이 처리한다.
 */
export type TelegramPollingResult = TelegramPollingOkResult | TelegramPollingFailedResult;

/**
 * Telegram inbound polling transport port다.
 *
 * 구현체는 getUpdates provider 호출과 safe projection만 담당하고, command parse/auth/dedupe/control side effect는 application
 * layer로 넘긴다.
 */
export interface TelegramPollingProvider {
  getUpdates(input: TelegramPollingRequest): Promise<TelegramPollingResult>;
}

/**
 * 실제 Telegram Bot API `getUpdates`를 호출하는 polling provider 옵션이다.
 *
 * bot token은 URL 구성에만 쓰고 결과, error, audit metadata로 반환하지 않는다. 테스트는 fetchImpl을 주입해 외부 API 없이
 * provider projection을 검증한다.
 */
export interface TelegramGetUpdatesPollingProviderOptions {
  botToken: string;
  fetchImpl?: FetchLike;
  providerTimeoutMs?: number;
  clock?: () => Date;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown;
}

/**
 * Telegram Bot API `getUpdates` 기반 inbound polling adapter다.
 *
 * 이 adapter는 public webhook endpoint를 만들지 않는다. provider raw response는 즉시 최소 projection으로 줄이고, token이나
 * raw update를 저장 가능한 객체로 반환하지 않는 것이 invariant다.
 */
export class TelegramGetUpdatesPollingProvider implements TelegramPollingProvider {
  private readonly fetchImpl: FetchLike;
  private readonly providerTimeoutMs: number;
  private readonly clock: () => Date;

  public constructor(private readonly options: TelegramGetUpdatesPollingProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.providerTimeoutMs = options.providerTimeoutMs ?? 5_000;
    this.clock = options.clock ?? (() => new Date());
  }

  public async getUpdates(input: TelegramPollingRequest): Promise<TelegramPollingResult> {
    const controller = new AbortController();
    // Telegram long polling이 정상 idle 응답을 기다릴 수 있도록 provider abort는 요청 timeout보다 길게 잡는다.
    const effectiveTimeoutMs = Math.max(this.providerTimeoutMs, input.timeoutSeconds * 1_000 + 1_000);
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const response = await this.fetchImpl(createTelegramGetUpdatesUrl(this.options.botToken), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          timeout: input.timeoutSeconds,
          limit: input.limit,
          allowed_updates: ["message"],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // provider body는 token이나 raw error를 포함할 수 있으므로 HTTP status만 실패 근거로 남긴다.
        return {
          status: "failed",
          reasonCode: `telegram_get_updates_http_${response.status}`,
        };
      }

      const payload = await readTelegramGetUpdatesResponse(response);
      if (!payload.ok || !Array.isArray(payload.result)) {
        return {
          status: "failed",
          reasonCode: "telegram_get_updates_invalid_response",
        };
      }

      const updates = payload.result.flatMap((update) => toInboundCommandMessage(update, this.clock));
      const nextOffset = readNextOffset(payload.result);
      return {
        status: "ok",
        updates,
        nextOffset,
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          status: "failed",
          reasonCode: "telegram_get_updates_timeout",
        };
      }

      return {
        status: "failed",
        reasonCode: "telegram_get_updates_provider_error",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 테스트와 fake runtime에서 쓰는 deterministic Telegram polling provider다.
 *
 * 미리 주입한 batch를 순서대로 반환하며 외부 network side effect가 없다. 반환 shape은 실제 provider와 같아 handler loop 테스트에
 * 그대로 사용할 수 있다.
 */
export class FakeTelegramPollingProvider implements TelegramPollingProvider {
  private index = 0;

  public constructor(private readonly batches: readonly TelegramPollingResult[]) {}

  public async getUpdates(_input: TelegramPollingRequest): Promise<TelegramPollingResult> {
    const batch = this.batches[this.index];
    this.index += 1;
    return (
      batch ?? {
        status: "ok",
        updates: [],
        nextOffset: null,
      }
    );
  }
}

/**
 * Telegram polling provider를 만든다.
 */
export function createTelegramGetUpdatesPollingProvider(
  options: TelegramGetUpdatesPollingProviderOptions,
): TelegramGetUpdatesPollingProvider {
  return new TelegramGetUpdatesPollingProvider(options);
}

function createTelegramGetUpdatesUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/getUpdates`;
}

async function readTelegramGetUpdatesResponse(response: Response): Promise<TelegramGetUpdatesResponse> {
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    return { ok: false };
  }

  return {
    ok: payload.ok,
    result: payload.result,
  };
}

function toInboundCommandMessage(
  update: unknown,
  clock: () => Date,
): readonly TelegramInboundCommandMessage[] {
  if (!isRecord(update) || typeof update.update_id !== "number" || !isRecord(update.message)) {
    return [];
  }

  const message = update.message;
  if (
    typeof message.message_id !== "number" ||
    typeof message.text !== "string" ||
    !isRecord(message.chat) ||
    (typeof message.chat.id !== "number" && typeof message.chat.id !== "string")
  ) {
    return [];
  }

  const from = isRecord(message.from) ? message.from : undefined;
  const userId = readTelegramIdentifier(from?.id);
  const username = typeof from?.username === "string" ? from.username : undefined;

  return [
    {
      updateId: update.update_id,
      messageId: message.message_id,
      chatId: String(message.chat.id),
      text: message.text,
      receivedAt: readTelegramMessageDate(message.date, clock),
      ...(userId === undefined ? {} : { userId }),
      ...(username === undefined ? {} : { username }),
    },
  ];
}

function readNextOffset(updates: readonly unknown[]): number | null {
  let latest: number | null = null;
  for (const update of updates) {
    if (!isRecord(update) || typeof update.update_id !== "number") {
      continue;
    }
    latest = latest === null ? update.update_id : Math.max(latest, update.update_id);
  }

  return latest === null ? null : latest + 1;
}

function readTelegramMessageDate(value: unknown, clock: () => Date): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1_000).toISOString();
  }

  return clock().toISOString();
}

function readTelegramIdentifier(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
