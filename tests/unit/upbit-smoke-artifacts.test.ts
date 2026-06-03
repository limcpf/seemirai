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

  it("secret key 원문이 artifact에 들어가면 저장 전에 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          profile: "PILOT_READ_ONLY",
          metadata: {
            key: "secret-key-raw-value",
          },
        },
        env,
      ),
    ).toThrow("SEEMIRAI_UPBIT_SECRET_KEY 원문");
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

  it("Bearer prefix 없는 긴 JWT token도 Authorization 패턴으로 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          authorization: "bearer eyJhbGciOiJIUzI1NiJ9.eyJhY2Nlc3Nfa2V5IjoiZmFrZSIsIm5vbmNlIjoidXVpZCJ9.signature",
        },
        env,
      ),
    ).toThrow("raw Authorization header");
  });

  it("raw JWT field가 artifact에 들어가면 저장 전에 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          jwt: "eyJhbGciOiJIUzUxMiJ9.eyJhY2Nlc3Nfa2V5IjoiZmFrZSJ9.signature",
        },
        env,
      ),
    ).toThrow("raw JWT field");
  });

  it("중첩된 raw provider payload 안의 Authorization 헤더도 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          profile: "PILOT_ORDER_SMOKE",
          providerResponse: {
            headers: {
              authorization: "Bearer eyJhbGciOiJIUzUxMiJ9.rawJwtPayload.signature",
            },
            body: {
              uuid: "order-001",
              state: "wait",
            },
          },
        },
        env,
      ),
    ).toThrow("raw Authorization header");
  });

  it("중첩된 payload 안의 raw JWT field도 차단한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          profile: "PILOT_ORDER_SMOKE",
          websocket: {
            auth: {
              jwt: "eyJhbGciOiJIUzUxMiJ9.somePayload.signature",
            },
          },
        },
        env,
      ),
    ).toThrow("raw JWT field");
  });

  it("안전한 필드와 redacted evidence id는 허용한다", () => {
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

  it("reconcile smoke artifact safe summary는 허용한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          schemaVersion: 1,
          kind: "UPBIT_LIVE_RECONCILE_SMOKE",
          status: "PASSED",
          keyScopeEvidenceId: "scope-evidence-2026-06-01",
          accounts: {
            accountCount: 3,
            currencies: ["BTC", "ETH", "KRW"],
            krwAccountPresent: true,
          },
          openOrders: {
            count: 0,
            markets: [],
            states: [],
          },
          noOrderSideEffectVerified: true,
          redactionVerified: true,
        },
        env,
      ),
    ).not.toThrow();
  });

  it("access key substring 8자 미만은 credential 전체와 달라 차단하지 않는다", () => {
    // 7자 이하 substring은 credential 원문과 다르며 false positive 차단을 만들지 않는다.
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          partialMatch: "access-",
        },
        env,
      ),
    ).not.toThrow();
  });

  it("한국어 메시지와 추적 정보만 있는 artifact는 허용한다", () => {
    expect(() =>
      assertUpbitSmokeArtifactHasNoSecretText(
        {
          schemaVersion: 1,
          kind: "UPBIT_LIVE_RECONCILE_SKIP",
          status: "SKIPPED",
          message: "SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1 guard가 꺼져 있어 live reconcile smoke를 실행하지 않습니다.",
          action: "실계좌 상태 대조 smoke가 필요할 때 SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1과 SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 guard를 설정하세요.",
          correlationId: "redacted-correlation-id",
          redactionVerified: true,
        },
        env,
      ),
    ).not.toThrow();
  });
});
