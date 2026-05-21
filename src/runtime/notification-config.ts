import type { TelegramNotifierOptions } from "../infrastructure/index.js";
import type { RuntimeConfig } from "./config.js";

export interface RuntimeNotificationConfig {
  telegram?: Pick<TelegramNotifierOptions, "botToken" | "chatId" | "providerTimeoutMs">;
}

/**
 * runtime config와 process env에서 outbound notification 설정을 만든다.
 *
 * Telegram bot token은 secret이므로 env를 우선하고, config에 들어온 값도 `/status`나 로그에 노출하지 않는다. chat id는 env 또는
 * runtime config에서 받을 수 있지만, notifier 조립 전까지는 원문을 별도 문서나 PR body에 남기지 않는다.
 */
export function loadRuntimeNotificationConfig(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeNotificationConfig {
  const botToken =
    nonEmptyEnvValue(env.SEEMIRAI_TELEGRAM_BOT_TOKEN) ??
    nonEmptyEnvValue(env.TELEGRAM_BOT_TOKEN) ??
    nonEmptyEnvValue(config.secrets.telegram_bot_token);
  const chatId =
    nonEmptyEnvValue(env.SEEMIRAI_TELEGRAM_CHAT_ID) ??
    nonEmptyEnvValue(env.TELEGRAM_CHAT_ID) ??
    nonEmptyEnvValue(config.telegram.chat_id);

  if (botToken === undefined || chatId === undefined) {
    return {};
  }

  return {
    telegram: {
      botToken,
      chatId,
      providerTimeoutMs: config.telegram.provider_timeout_ms,
    },
  };
}

function nonEmptyEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
