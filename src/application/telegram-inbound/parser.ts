import {
  telegramInboundControlCommands,
  telegramInboundReadOnlyCommands,
} from "./types.js";
import type {
  ParsedTelegramInboundCommand,
  TelegramInboundCommandName,
  TelegramInboundCommandScope,
  TelegramInboundParseResult,
} from "./types.js";

const commandPattern = /^\/(?<name>[A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(?<argument>.*))?$/u;
const krwMarketPattern = /^KRW-[A-Z0-9]+$/u;

/**
 * Telegram text를 M20 inbound command contract로 정규화한다.
 *
 * 이 함수는 provider 호출이나 audit 저장을 하지 않는 순수 parser다. slash command 형식, command allowlist, `/why` 대상만
 * 통과시키고, 실패는 한국어 안내와 내부 reason code로 반환해 raw enum/code가 사용자 첫 화면을 대체하지 않게 한다.
 */
export function parseTelegramInboundCommand(text: string): TelegramInboundParseResult {
  const normalizedText = normalizeCommandText(text);
  const match = commandPattern.exec(normalizedText);

  if (match?.groups?.name === undefined) {
    return malformed(
      "telegram_command_prefix_required",
      "명령은 /status 처럼 슬래시로 시작해야 합니다.",
      normalizedText,
    );
  }

  const name = match.groups.name.toLowerCase();
  if (!isTelegramInboundCommandName(name)) {
    return {
      status: "UNKNOWN",
      reasonCode: "telegram_command_unknown",
      userMessage:
        "지원하지 않는 명령입니다. 상태 조회는 /status, 판단 이유 조회는 /why KRW-BTC 또는 /why cash를 사용해 주세요.",
      normalizedText,
    };
  }

  const argument = match.groups.argument?.trim();
  const scope = resolveCommandScope(name);
  if (name === "why") {
    return parseWhyCommand(name, scope, argument, normalizedText);
  }

  if (argument !== undefined && argument !== "") {
    return malformed(
      "telegram_command_unexpected_argument",
      `/${name} 명령은 추가 입력 없이 사용해 주세요.`,
      normalizedText,
    );
  }

  return parsed({
    name,
    scope,
    normalizedText: `/${name}`,
  });
}

/**
 * parser 결과를 Telegram 응답 첫 화면에 쓸 한국어 안내로 변환한다.
 *
 * 정상 command는 이 함수가 성공 안내를 만들지 않는다. handler layer가 실제 조회/제어 결과를 별도로 구성해야 하기 때문이다.
 */
export function toTelegramCommandUserMessage(result: TelegramInboundParseResult): string | null {
  if (result.status === "PARSED") {
    return null;
  }

  return result.userMessage;
}

function parseWhyCommand(
  name: "why",
  scope: TelegramInboundCommandScope,
  argument: string | undefined,
  normalizedText: string,
): TelegramInboundParseResult {
  if (argument === undefined || argument === "") {
    return malformed(
      "telegram_why_target_required",
      "판단 이유를 보려면 /why KRW-BTC 또는 /why cash처럼 대상을 함께 입력해 주세요.",
      normalizedText,
    );
  }

  const target = argument.toUpperCase();
  if (target === "CASH") {
    return parsed({
      name,
      scope,
      normalizedText: "/why cash",
      argument: {
        kind: "cash",
      },
    });
  }

  if (!krwMarketPattern.test(target)) {
    return malformed(
      "telegram_why_target_invalid",
      "판단 이유 대상은 cash 또는 KRW-BTC 같은 KRW 마켓 코드여야 합니다.",
      normalizedText,
    );
  }

  return parsed({
    name,
    scope,
    normalizedText: `/why ${target}`,
    argument: {
      kind: "market",
      market: target,
    },
  });
}

function parsed(command: ParsedTelegramInboundCommand): TelegramInboundParseResult {
  return {
    status: "PARSED",
    command,
  };
}

function malformed(
  reasonCode: string,
  userMessage: string,
  normalizedText: string,
): TelegramInboundParseResult {
  return {
    status: "MALFORMED",
    reasonCode,
    userMessage,
    normalizedText,
  };
}

function normalizeCommandText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function isTelegramInboundCommandName(value: string): value is TelegramInboundCommandName {
  return (
    (telegramInboundReadOnlyCommands as readonly string[]).includes(value) ||
    (telegramInboundControlCommands as readonly string[]).includes(value)
  );
}

function resolveCommandScope(command: TelegramInboundCommandName): TelegramInboundCommandScope {
  return (telegramInboundControlCommands as readonly string[]).includes(command)
    ? "CONTROL"
    : "READ_ONLY";
}
