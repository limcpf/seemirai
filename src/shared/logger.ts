import pino from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

export const SECRET_REDACTION_PATHS = [
  "upbit.accessKey",
  "upbit.secretKey",
  "telegram.botToken",
  "control.localToken",
  "env.UPBIT_ACCESS_KEY",
  "env.UPBIT_SECRET_KEY",
  "env.TELEGRAM_BOT_TOKEN",
  "env.SEEMIRAI_LOCAL_CONTROL_TOKEN",
];

export interface CreateAppLoggerOptions {
  level?: LoggerOptions["level"];
  destination?: DestinationStream;
}

export function createAppLogger(options: CreateAppLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? "info",
      base: null,
      redact: {
        paths: SECRET_REDACTION_PATHS,
        censor: "[REDACTED]",
      },
    },
    options.destination,
  );
}
