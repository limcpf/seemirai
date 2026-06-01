import pino from "pino";
import type { Bindings, ChildLoggerOptions, DestinationStream, Logger, LoggerOptions } from "pino";

const REDACTED_LOG_VALUE = "[REDACTED]";

export const SECRET_REDACTION_PATHS = [
  "upbit.accessKey",
  "upbit.secretKey",
  "upbitAccessKey",
  "upbitSecretKey",
  "*.upbitAccessKey",
  "*.upbitSecretKey",
  "telegram.botToken",
  "control.localToken",
  "secrets.upbit_access_key",
  "secrets.upbit_secret_key",
  "secrets.telegram_bot_token",
  "secrets.local_control_token",
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "req.headers.Authorization",
  "request.headers.authorization",
  "request.headers.Authorization",
  "jwt",
  "auth.jwt",
  "env.UPBIT_ACCESS_KEY",
  "env.UPBIT_SECRET_KEY",
  "env.SEEMIRAI_UPBIT_ACCESS_KEY",
  "env.SEEMIRAI_UPBIT_SECRET_KEY",
  "env.TELEGRAM_BOT_TOKEN",
  "env.SEEMIRAI_TELEGRAM_BOT_TOKEN",
  "env.SEEMIRAI_LOCAL_CONTROL_TOKEN",
];

const RECURSIVE_SECRET_FIELD_NAMES = new Set([
  "upbitAccessKey",
  "upbitSecretKey",
  "upbit_access_key",
  "upbit_secret_key",
  "botToken",
  "localToken",
  "telegram_bot_token",
  "local_control_token",
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY",
  "SEEMIRAI_UPBIT_ACCESS_KEY",
  "SEEMIRAI_UPBIT_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "SEEMIRAI_TELEGRAM_BOT_TOKEN",
  "SEEMIRAI_LOCAL_CONTROL_TOKEN",
]);

const UPBIT_SECRET_FIELD_NAMES = new Set(["accessKey", "secretKey"]);

/**
 * 애플리케이션 logger 생성에 필요한 선택 입력이다.
 *
 * 호출자는 테스트 destination 또는 실행 로그 level만 주입할 수 있다. secret redaction 정책은 이 모듈 내부 invariant로
 * 고정되어 호출자가 비활성화할 수 없으며, 옵션 객체 자체는 외부 side effect를 만들지 않는다.
 */
export interface CreateAppLoggerOptions {
  level?: LoggerOptions["level"];
  destination?: DestinationStream;
}

/**
 * 공통 pino logger를 생성한다.
 *
 * 런타임 경계에서 구조화 로그와 child binding을 모두 secret-safe 형태로 변환한 뒤 pino에 넘긴다. Upbit pilot key,
 * Telegram token, local control token, authorization 값은 로그 객체 깊이에 의존하지 않고 가려야 하며, 이 함수의 외부
 * side effect는 지정된 destination으로 로그를 기록하는 것뿐이다.
 */
export function createAppLogger(options: CreateAppLoggerOptions = {}): Logger {
  const logger = pino(
    {
      level: options.level ?? "info",
      base: null,
      formatters: {
        bindings: redactSecretsInLogRecord,
        log: redactSecretsInLogRecord,
      },
      redact: {
        paths: SECRET_REDACTION_PATHS,
        censor: REDACTED_LOG_VALUE,
      },
    },
    options.destination,
  );

  return attachSecretSafeChildLogger(logger);
}

function redactSecretsInLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  return redactLogValue(record, [], new WeakMap()) as Record<string, unknown>;
}

function redactLogValue(
  value: unknown,
  path: readonly string[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (Array.isArray(value)) {
    const cached = seen.get(value);
    if (cached !== undefined) {
      return cached;
    }

    const redactedArray: unknown[] = [];
    seen.set(value, redactedArray);
    for (const item of value) {
      redactedArray.push(redactLogValue(item, path, seen));
    }
    return redactedArray;
  }

  if (!isPlainLogRecord(value)) {
    return value;
  }

  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached;
  }

  const redactedRecord: Record<string, unknown> = {};
  seen.set(value, redactedRecord);

  for (const [key, nestedValue] of Object.entries(value)) {
    if (shouldRedactLogField(path, key)) {
      // secret 필드는 로그 객체 깊이에 의존하지 않고 닫아야 하므로 pino 직렬화 전에 원문을 제거한다.
      redactedRecord[key] = REDACTED_LOG_VALUE;
      continue;
    }

    redactedRecord[key] = redactLogValue(nestedValue, [...path, key], seen);
  }

  return redactedRecord;
}

function isPlainLogRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (value instanceof Date || value instanceof Error || value instanceof RegExp || Buffer.isBuffer(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shouldRedactLogField(path: readonly string[], key: string): boolean {
  const normalizedKey = key.toLowerCase();

  if (normalizedKey === "authorization" || normalizedKey === "jwt") {
    return true;
  }

  if (RECURSIVE_SECRET_FIELD_NAMES.has(key)) {
    return true;
  }

  return UPBIT_SECRET_FIELD_NAMES.has(key) && path.some((segment) => segment.toLowerCase().includes("upbit"));
}

function attachSecretSafeChildLogger<CustomLevels extends string = never>(
  logger: Logger<CustomLevels>,
): Logger<CustomLevels> {
  const child = logger.child.bind(logger);

  logger.child = (<ChildCustomLevels extends string = never>(
    bindings: Bindings,
    childOptions?: ChildLoggerOptions<ChildCustomLevels>,
  ): Logger<CustomLevels | ChildCustomLevels> => {
    // child binding은 모든 로그 줄에 고정되므로 생성 경계에서 먼저 가려야 이후 로그가 누출되지 않는다.
    const redactedBindings = redactSecretsInLogRecord(bindings);
    const childLogger =
      childOptions === undefined
        ? child<ChildCustomLevels>(redactedBindings)
        : child<ChildCustomLevels>(redactedBindings, childOptions);
    return attachSecretSafeChildLogger(childLogger);
  }) as unknown as Logger<CustomLevels>["child"];

  return logger;
}
