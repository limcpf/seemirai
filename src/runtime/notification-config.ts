import type { TelegramNotifierOptions } from "../infrastructure/index.js";
import type { RuntimeConfig } from "./config.js";

export interface RuntimeNotificationConfig {
  telegram?: Pick<TelegramNotifierOptions, "botToken" | "chatId" | "providerTimeoutMs">;
}

/**
 * Telegram inbound polling runtime 설정이다.
 *
 * disabled 상태는 bot token이나 owner allowlist가 없어도 안전한 기본값이다. enabled 상태는 polling provider와 command auth에
 * 필요한 값이 모두 채워져야 하며, raw token은 status/log surface로 반환하지 않는다.
 */
export type RuntimeTelegramInboundConfig =
  | {
      enabled: false;
      reasonCode: "telegram_inbound_disabled";
    }
  | {
      enabled: true;
      botToken: string;
      ownerChatIds: readonly string[];
      ownerUserIds: readonly string[];
      providerTimeoutMs: number;
      pollingIntervalMs: number;
      pollingTimeoutSeconds: number;
      maxUpdatesPerPoll: number;
    };

/**
 * Telegram inbound가 켜질 수 없는 설정을 설명하는 startup guard error다.
 *
 * 이 error message는 secret 원문을 담지 않고 누락된 guard 이름만 포함한다.
 */
export class UnsafeTelegramInboundConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe Telegram inbound config: ${violations.join(", ")}`);
    this.name = "UnsafeTelegramInboundConfigError";
    this.violations = violations;
  }
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

/**
 * runtime config와 process env에서 Telegram inbound polling 설정을 만든다.
 *
 * inbound는 기본 비활성이며, `SEEMIRAI_TELEGRAM_INBOUND_ENABLED=1` 또는 config enable이 있어야 열린다. 활성화된 상태에서 token
 * 또는 owner chat allowlist가 없으면 polling 시작 전 fail-closed 한다.
 */
export function loadRuntimeTelegramInboundConfig(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTelegramInboundConfig {
  const inbound = config.telegram.inbound;
  const enabled = readBooleanEnv(env.SEEMIRAI_TELEGRAM_INBOUND_ENABLED) ?? inbound.enabled;
  if (!enabled) {
    return {
      enabled: false,
      reasonCode: "telegram_inbound_disabled",
    };
  }

  const botToken =
    nonEmptyEnvValue(env.SEEMIRAI_TELEGRAM_BOT_TOKEN) ??
    nonEmptyEnvValue(env.TELEGRAM_BOT_TOKEN) ??
    nonEmptyEnvValue(config.secrets.telegram_bot_token);
  const ownerChatIds =
    readCsvEnv(env.SEEMIRAI_TELEGRAM_INBOUND_OWNER_CHAT_IDS) ?? inbound.owner_chat_ids;
  const ownerUserIds =
    readCsvEnv(env.SEEMIRAI_TELEGRAM_INBOUND_OWNER_USER_IDS) ?? inbound.owner_user_ids;
  const violations: string[] = [];

  if (botToken === undefined) {
    violations.push("telegram bot token is required when inbound polling is enabled");
  }

  if (ownerChatIds.length === 0) {
    // inbound polling은 허용된 owner chat 없이 시작하면 외부 입력 실행면이 열리므로 startup에서 차단한다.
    violations.push("owner chat id allowlist is required when inbound polling is enabled");
  }

  const pollingIntervalMs =
    readPositiveIntegerEnv(env.SEEMIRAI_TELEGRAM_INBOUND_POLLING_INTERVAL_MS) ??
    inbound.polling_interval_ms;
  const pollingTimeoutSeconds =
    readPositiveIntegerEnv(env.SEEMIRAI_TELEGRAM_INBOUND_POLLING_TIMEOUT_SECONDS, 50) ??
    inbound.polling_timeout_seconds;
  const maxUpdatesPerPoll =
    readPositiveIntegerEnv(env.SEEMIRAI_TELEGRAM_INBOUND_MAX_UPDATES_PER_POLL, 100) ??
    inbound.max_updates_per_poll;

  if (violations.length > 0 || botToken === undefined) {
    throw new UnsafeTelegramInboundConfigError(violations);
  }

  return {
    enabled: true,
    botToken,
    ownerChatIds,
    ownerUserIds,
    providerTimeoutMs: config.telegram.provider_timeout_ms,
    pollingIntervalMs,
    pollingTimeoutSeconds,
    maxUpdatesPerPoll,
  };
}

function nonEmptyEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readCsvEnv(value: string | undefined): readonly string[] | undefined {
  const raw = nonEmptyEnvValue(value);
  if (raw === undefined) {
    return undefined;
  }

  return raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  const raw = nonEmptyEnvValue(value);
  if (raw === undefined) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) {
    return false;
  }

  throw new UnsafeTelegramInboundConfigError([
    "SEEMIRAI_TELEGRAM_INBOUND_ENABLED must be a boolean-like value",
  ]);
}

function readPositiveIntegerEnv(value: string | undefined, maxValue?: number): number | undefined {
  const raw = nonEmptyEnvValue(value);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new UnsafeTelegramInboundConfigError([
      "Telegram inbound numeric env values must be positive integers",
    ]);
  }

  if (maxValue !== undefined && parsed > maxValue) {
    throw new UnsafeTelegramInboundConfigError([
      `Telegram inbound numeric env values must be less than or equal to ${maxValue}`,
    ]);
  }

  return parsed;
}
