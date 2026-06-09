import { createHash } from "node:crypto";
import type {
  ParsedTelegramInboundCommand,
  TelegramInboundCommandDedupeInput,
  TelegramInboundCommandDedupeResult,
  TelegramInboundCommandDedupeStore,
  TelegramInboundCommandMessage,
} from "./types.js";

/**
 * Telegram command idempotency key를 만들기 위한 입력이다.
 *
 * raw message text 대신 parser가 만든 normalized command text를 hash해, 같은 Telegram update 재전달이 같은 key로 수렴하게 한다.
 */
export interface CreateTelegramInboundCommandIdempotencyKeyInput {
  message: Pick<TelegramInboundCommandMessage, "updateId" | "messageId" | "chatId">;
  command: ParsedTelegramInboundCommand;
}

/**
 * Telegram inbound command dedupe key를 생성한다.
 *
 * Telegram update id와 message id는 재전달 중복 차단의 기준이고, chat/command는 hash projection으로만 넣어 jobs table이나
 * audit trace에 raw chat id와 raw text가 남지 않게 한다.
 */
export function createTelegramInboundCommandIdempotencyKey(
  input: CreateTelegramInboundCommandIdempotencyKeyInput,
): string {
  const chatHash = shortHash(input.message.chatId);
  const commandHash = shortHash(input.command.normalizedText);
  return [
    "telegram.inbound.v1",
    `update:${input.message.updateId}`,
    `message:${input.message.messageId}`,
    `chat:${chatHash}`,
    `command:${input.command.name}`,
    `text:${commandHash}`,
  ].join(":");
}

/**
 * 테스트와 memory-only fake runtime에서 쓰는 Telegram inbound dedupe store를 만든다.
 *
 * production runtime은 이 구현을 durable store로 쓰면 안 된다. 중단 후 재시작해도 command 중복 실행을 막아야 하는 경계에서는
 * jobs table 기반 구현을 사용해야 한다.
 */
export function createInMemoryTelegramInboundDedupeStore(
  clock: () => Date = () => new Date(),
): TelegramInboundCommandDedupeStore {
  const keys = new Set<string>();

  return {
    async record(input: TelegramInboundCommandDedupeInput): Promise<TelegramInboundCommandDedupeResult> {
      const duplicate = keys.has(input.idempotencyKey);
      if (!duplicate) {
        // memory fake도 실제 handler와 같은 분기 구조를 갖도록 첫 관찰에서만 key를 선점한다.
        keys.add(input.idempotencyKey);
      }

      return {
        idempotencyKey: input.idempotencyKey,
        duplicate,
        storedAt: clock().toISOString(),
        store: "memory",
      };
    },
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
