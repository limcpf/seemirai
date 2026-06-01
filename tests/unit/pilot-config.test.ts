import { describe, expect, it } from "vitest";
import {
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
  UnsafePilotRuntimeConfigError,
  createPilotRuntimeSafeSummary,
  loadDefaultRuntimeConfig,
  loadPilotRuntimeConfigFromEnv,
} from "../../src/runtime/index.js";

describe("pilot runtime config", () => {
  it("keeps the default paper profile keyless and pilot disabled", async () => {
    const paperConfig = await loadDefaultRuntimeConfig();
    const pilotConfig = loadPilotRuntimeConfigFromEnv({});

    expect(paperConfig.paper_no_key).toBe(true);
    expect(paperConfig.live_trading_enabled).toBe(false);
    expect(paperConfig.secrets.upbit_access_key).toBeUndefined();
    expect(paperConfig.secrets.upbit_secret_key).toBeUndefined();
    expect(pilotConfig).toEqual({
      enabled: false,
      privateSmokeEnabled: false,
      orderSmokeEnabled: false,
    });
  });

  it("rejects partial private API env instead of opening a pilot profile implicitly", () => {
    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("loads a read-only pilot profile with explicit private smoke guard and scope evidence", () => {
    const pilotConfig = loadPilotRuntimeConfigFromEnv({
      SEEMIRAI_PILOT_PROFILE: "PILOT_READ_ONLY",
      SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
      SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
      SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
      SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER: "read-only-existing-order",
    });

    expect(pilotConfig).toMatchObject({
      enabled: true,
      profile: "PILOT_READ_ONLY",
      privateSmokeEnabled: true,
      orderSmokeEnabled: false,
      upbitAccessKey: "access-key",
      upbitSecretKey: "secret-key",
      keyScopes: ["자산조회", "주문조회"],
      keyScopeEvidenceId: "scope-evidence-2026-06-01",
      lookupOrderIdentifier: "read-only-existing-order",
    });
  });

  it("rejects read-only lookup identifiers that exceed the Upbit length limit", () => {
    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_READ_ONLY",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER: "x".repeat(UPBIT_PILOT_IDENTIFIER_MAX_LENGTH + 1),
      }),
    ).toThrow(`${UPBIT_PILOT_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  });

  it("fails closed when forbidden scopes or order guards appear in read-only pilot env", () => {
    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_READ_ONLY",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,출금하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      }),
    ).toThrow("금지된 Upbit key scope");

    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_READ_ONLY",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
      }),
    ).toThrow("PILOT_READ_ONLY 에서는 Upbit key scope 주문하기 권한을 사용할 수 없습니다");
  });

  it("requires standalone policy sync market before orders/chance can be used", () => {
    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_POLICY_SYNC",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      }),
    ).toThrow("SEEMIRAI_UPBIT_POLICY_SYNC_MARKET");

    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_POLICY_SYNC",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER: "existing-order",
      }),
    ).toThrow("PILOT_READ_ONLY 에서만 사용할 수 있습니다");

    expect(
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_POLICY_SYNC",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
      }),
    ).toMatchObject({
      enabled: true,
      profile: "PILOT_POLICY_SYNC",
      policySyncMarket: "KRW-BTC",
      orderSmokeEnabled: false,
    });
  });

  it("loads order smoke only when all explicit guards and small KRW limits are present", () => {
    const pilotConfig = loadPilotRuntimeConfigFromEnv({
      SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
      SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
      SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
      SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
      SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
      SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
      SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-BTC",
      SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "5000",
    });

    expect(pilotConfig).toMatchObject({
      enabled: true,
      profile: "PILOT_ORDER_SMOKE",
      privateSmokeEnabled: true,
      orderSmokeEnabled: true,
      orderSmokeMarket: "KRW-BTC",
      orderSmokeMaxKrw: "5000",
    });
  });

  it("rejects order smoke when market, guard, scope, or budget invariants are unsafe", () => {
    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-ETH",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "4999",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);

    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "4999",
      }),
    ).toThrow("5000 KRW 이상");

    expect(() =>
      loadPilotRuntimeConfigFromEnv({
        SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
        SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-BTC",
        SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "50001",
      }),
    ).toThrow("50000 KRW 이하");
  });

  it("documents the Upbit identifier limit that later order smoke idempotency must keep", () => {
    expect(UPBIT_PILOT_IDENTIFIER_MAX_LENGTH).toBe(32);
    expect(UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT).toBe(5000);
  });

  it("creates a disabled safe summary for the keyless PAPER_NO_KEY default", () => {
    const summary = createPilotRuntimeSafeSummary(loadPilotRuntimeConfigFromEnv({}), {
      generatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(summary).toEqual({
      enabled: false,
      profile: null,
      privateSmokeEnabled: false,
      orderSmokeEnabled: false,
      credentialsConfigured: false,
      keyScopes: [],
      keyScopeEvidenceId: null,
      policySyncMarket: null,
      orderSmokeMarket: null,
      orderSmokeMaxKrw: null,
      lookupOrderConfigured: false,
      statusLabel: "비활성",
      message: "pilot private API profile이 꺼져 있어 기본 PAPER_NO_KEY runtime이 API key 없이 동작한다.",
      action: null,
      lastEvidence: null,
      trace: {
        source: "pilot_runtime_config",
        reason: "pilot_profile_disabled",
        generatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
  });

  it("summarizes enabled pilot config and latest evidence without leaking keys or auth material", () => {
    const pilotConfig = loadPilotRuntimeConfigFromEnv({
      SEEMIRAI_PILOT_PROFILE: "PILOT_ORDER_SMOKE",
      SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
      SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
      SEEMIRAI_UPBIT_ACCESS_KEY: "access-key-raw",
      SEEMIRAI_UPBIT_SECRET_KEY: "secret-key-raw",
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
      SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
      SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET: "KRW-BTC",
      SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW: "5000",
    });
    const summary = createPilotRuntimeSafeSummary(pilotConfig, {
      generatedAt: "2026-06-01T00:00:00.000Z",
      lastEvidence: {
        profile: "PILOT_ORDER_SMOKE",
        status: "FAILED",
        occurredAt: "2026-06-01T00:01:00.000Z",
        correlationId: "pilot-order-smoke-correlation-123456",
        message: "pilot 주문 smoke가 실패했다.",
        action: "Upbit 주문 내역과 audit artifact를 대조한다.",
        auditEventId: "audit-1",
        reportArtifactId: "pilot-report-1",
        safeMetadata: {
          market: "KRW-BTC",
          authorization: "Bearer raw-token",
          nested: {
            upbitAccessKey: "nested-access-key",
          },
        },
      },
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      enabled: true,
      profile: "PILOT_ORDER_SMOKE",
      privateSmokeEnabled: true,
      orderSmokeEnabled: true,
      credentialsConfigured: true,
      keyScopes: ["자산조회", "주문조회", "주문하기"],
      keyScopeEvidenceId: "scope-evidence-2026-06-01",
      policySyncMarket: "KRW-BTC",
      orderSmokeMarket: "KRW-BTC",
      orderSmokeMaxKrw: "5000",
      lookupOrderConfigured: false,
      statusLabel: "주문 smoke 준비",
      lastEvidence: {
        status: "FAILED",
        statusLabel: "검증 실패",
        correlationId: "pilot-...3456",
        safeMetadata: {
          market: "KRW-BTC",
          authorization: "[REDACTED]",
          nested: {
            upbitAccessKey: "[REDACTED]",
          },
        },
      },
    });
    expect(serialized).not.toContain("access-key-raw");
    expect(serialized).not.toContain("secret-key-raw");
    expect(serialized).not.toContain("Bearer raw-token");
    expect(serialized).not.toContain("nested-access-key");
  });
});
