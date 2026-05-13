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
      },
      "redaction check",
    );

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("upbit-access-key");
    expect(output).not.toContain("upbit-secret-key");
    expect(output).not.toContain("telegram-token");
    expect(output).not.toContain("control-token");
  });
});
