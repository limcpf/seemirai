import pino from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

export const SECRET_REDACTION_PATHS = [
  "upbit.accessKey",
  "upbit.secretKey",
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
  "env.TELEGRAM_BOT_TOKEN",
  "env.SEEMIRAI_TELEGRAM_BOT_TOKEN",
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
