import { createHash } from "node:crypto";
import type {
  TelegramInboundAllowlist,
  TelegramInboundAuthorizationResult,
  TelegramInboundCommandMessage,
} from "./types.js";

/**
 * Telegram sender가 owner allowlist를 통과하는지 확인한다.
 *
 * chat id allowlist가 비어 있으면 inbound control surface가 열린 것으로 보지 않고 fail-closed 한다. user id allowlist가 지정된
 * 경우에는 chat이 허용되어도 user id가 맞아야 하며, 이 결과는 audit evidence로만 쓰고 provider raw update는 저장하지 않는다.
 */
export function evaluateTelegramInboundAuthorization(
  message: Pick<TelegramInboundCommandMessage, "chatId" | "userId">,
  allowlist: TelegramInboundAllowlist,
): TelegramInboundAuthorizationResult {
  const ownerChatIds = normalizeAllowlist(allowlist.ownerChatIds);
  if (ownerChatIds.length === 0) {
    // allowlist 누락은 운영자 오설정이므로 어떤 명령도 실행하지 않는다.
    return {
      ok: false,
      reasonCode: "telegram_inbound_owner_chat_allowlist_empty",
      userMessage: "Telegram 명령을 실행할 운영자 채팅이 설정되지 않아 요청을 거부했습니다.",
    };
  }

  if (!ownerChatIds.includes(message.chatId.trim())) {
    // 허용되지 않은 chat은 명령 내용과 무관하게 실행하지 않고 감사 근거만 남긴다.
    return {
      ok: false,
      reasonCode: "telegram_inbound_chat_not_allowed",
      userMessage: "허용된 운영자 채팅이 아니어서 Telegram 명령을 실행하지 않았습니다.",
    };
  }

  const ownerUserIds = normalizeAllowlist(allowlist.ownerUserIds ?? []);
  if (ownerUserIds.length > 0 && (message.userId === undefined || !ownerUserIds.includes(message.userId.trim()))) {
    // 그룹 chat에서 owner user까지 좁힌 경우 user id mismatch는 control 명령 재전송도 차단한다.
    return {
      ok: false,
      reasonCode: "telegram_inbound_user_not_allowed",
      userMessage: "허용된 운영자 계정이 아니어서 Telegram 명령을 실행하지 않았습니다.",
    };
  }

  return {
    ok: true,
    reasonCode: "telegram_inbound_authorized",
  };
}

/**
 * chat id, user id처럼 audit 추적에는 필요하지만 원문 저장을 피해야 하는 식별자를 안정 hash로 축약한다.
 *
 * salt 없는 SHA-256은 동일 운영 식별자의 중복 여부를 추적하기 위한 projection이며, token이나 raw update를 복구할 수 있는 값을
 * 저장하지 않는다.
 */
export function hashTelegramInboundIdentifier(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeAllowlist(values: readonly string[]): readonly string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}
