import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAppLogger } from "../../src/shared/logger.js";

describe("app logger", () => {
  it("redacts configured secret fields from structured logs", () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createAppLogger({ destination: stream });

    logger.info(
      {
        upbit: {
          accessKey: "upbit-access-key",
          secretKey: "upbit-secret-key",
        },
        telegram: {
          botToken: "telegram-token",
        },
        control: {
          localToken: "control-token",
        },
        secrets: {
          upbit_access_key: "config-upbit-access-key",
          upbit_secret_key: "config-upbit-secret-key",
          telegram_bot_token: "config-telegram-token",
          local_control_token: "config-control-token",
        },
        authorization: "Bearer root-jwt-token",
        headers: {
          authorization: "Bearer header-jwt-token",
        },
        req: {
          headers: {
            Authorization: "Bearer req-jwt-token",
          },
        },
        request: {
          headers: {
            authorization: "Bearer request-jwt-token",
          },
        },
        jwt: "plain-jwt-token",
        auth: {
          jwt: "nested-jwt-token",
        },
        env: {
          TELEGRAM_BOT_TOKEN: "legacy-telegram-env-token",
          SEEMIRAI_TELEGRAM_BOT_TOKEN: "scoped-telegram-env-token",
        },
      },
      "redaction check",
    );

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("upbit-access-key");
    expect(output).not.toContain("upbit-secret-key");
    expect(output).not.toContain("telegram-token");
    expect(output).not.toContain("control-token");
    expect(output).not.toContain("config-upbit-access-key");
    expect(output).not.toContain("config-upbit-secret-key");
    expect(output).not.toContain("config-telegram-token");
    expect(output).not.toContain("config-control-token");
    expect(output).not.toContain("root-jwt-token");
    expect(output).not.toContain("header-jwt-token");
    expect(output).not.toContain("req-jwt-token");
    expect(output).not.toContain("request-jwt-token");
    expect(output).not.toContain("plain-jwt-token");
    expect(output).not.toContain("nested-jwt-token");
    expect(output).not.toContain("legacy-telegram-env-token");
    expect(output).not.toContain("scoped-telegram-env-token");
  });
});
