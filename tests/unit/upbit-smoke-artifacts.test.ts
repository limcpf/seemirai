import { describe, expect, it } from "vitest";
import { assertUpbitSmokeArtifactHasNoSecretText } from "../helpers/upbit-smoke-artifacts.js";

describe("upbit smoke artifact redaction", () => {
  const env = {
    SEEMIRAI_UPBIT_ACCESS_KEY: "access-key-raw-value",
    SEEMIRAI_UPBIT_SECRET_KEY: "secret-key-raw-value",
  } satisfies NodeJS.ProcessEnv;

  it("raw Upbit credential 값이 artifact에 들어가면 저장 전에 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          profile: "PILOT_READ_ONLY",
          leaked: "access-key-raw-value",
        },
        env,
      ),
    ).toThrow("SEEMIRAI_UPBIT_ACCESS_KEY 원문");
  });

  it("raw Authorization header field가 artifact에 들어가면 저장 전에 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          authorization: "Bearer eyJhbGciOiJIUzUxMiJ9.payload.signature",
        },
        env,
      ),
    ).toThrow("raw Authorization header");
  });

  it("safe summary와 redacted evidence id는 허용한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          profile: "PILOT_ORDER_SMOKE",
          keyScopeEvidenceId: "scope-evidence-2026-06-01",
          redactionVerified: true,
        },
        env,
      ),
    ).not.toThrow();
  });
});
