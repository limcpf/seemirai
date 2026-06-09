/**
 * M19 exit pilot guard smoke test — guarded live pilot guard 검증.
 *
 * 실제 Upbit private API를 호출하지 않고 M19 guard 조건만 검증한다. Sub PR 03의 핵심 invariant:
 * - 기본 PAPER_NO_KEY runtime은 live order API 0회를 유지한다.
 * - M19 exit pilot은 명시 env guard 없이 열리지 않는다.
 * - guarded buy smoke는 별도 approval evidence 없이 fail-closed 한다.
 * - 매도/축소 경로는 기존 보유 포지션 source 우선이지만 API 호출 전 guard는 통과해야 한다.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JsonRecord } from "../../src/domain/index.js";
import {
  UnsafePilotRuntimeConfigError,
  createM19ExitPilotGuardSafeSummary,
  loadM19ExitPilotGuardConfigFromEnv,
  validateM19GuardedBuySmokeGuard,
} from "../../src/runtime/index.js";
import type {
  M19ExitPilotGuardConfig,
  M19ExitPilotGuardConfigResult,
  M19GuardedBuySmokeValidation,
} from "../../src/runtime/index.js";

describe("M19 exit pilot guard", () => {
  it("SEEMIRAI_RUN_M19_EXIT_PILOT=1 이 없으면 비활성 config를 반환한다", () => {
    const config = loadM19ExitPilotGuardConfigFromEnv({});

    expect(config.enabled).toBe(false);
  });

  it("SEEMIRAI_RUN_M19_EXIT_PILOT=1 만 있고 나머지 env가 없으면 예외를 던진다", () => {
    expect(() =>
      loadM19ExitPilotGuardConfigFromEnv({
        SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("position source, max KRW, operator evidence id가 모두 있으면 활성 config를 반환한다", () => {
    const config = loadM19ExitPilotGuardConfigFromEnv({
      SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
      SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE: "PAPER_FIXTURE",
      SEEMIRAI_M19_EXIT_PILOT_MAX_KRW: "10000",
      SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID: "m19-evidence-001",
    });

    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("expected enabled config");

    expect(config.positionSource).toBe("PAPER_FIXTURE");
    expect(config.maxKrw).toBe("10000");
    expect(config.operatorEvidenceId).toBe("m19-evidence-001");
    expect(config.guardedBuySmokeEnabled).toBe(false);
  });

  it("position source로 EXISTING_SMALL_POSITION 을 선택할 수 있다", () => {
    const config = createValidM19ExitPilotGuardConfig({
      positionSource: "EXISTING_SMALL_POSITION",
      positionEvidenceId: "m16-reconcile-evidence-001",
    });

    expect(config.positionSource).toBe("EXISTING_SMALL_POSITION");
    expect(config.positionEvidenceId).toBe("m16-reconcile-evidence-001");
  });

  it("EXISTING_SMALL_POSITION 은 M16 reconcile 또는 position evidence 없이는 예외를 던진다", () => {
    expect(() =>
      createValidM19ExitPilotGuardConfig({
        positionSource: "EXISTING_SMALL_POSITION",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("M19 exit pilot 없이 guarded buy smoke만 켜면 예외를 던진다", () => {
    expect(() =>
      loadM19ExitPilotGuardConfigFromEnv({
        SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE: "1",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("잘못된 position source는 예외를 던진다", () => {
    expect(() =>
      loadM19ExitPilotGuardConfigFromEnv({
        SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
        SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE: "INVALID_SOURCE",
        SEEMIRAI_M19_EXIT_PILOT_MAX_KRW: "10000",
        SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID: "m19-evidence-001",
      }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("M19 max KRW가 5000 미만이면 예외를 던진다", () => {
    expect(() =>
      createValidM19ExitPilotGuardConfig({ maxKrw: "1000" }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("M19 max KRW가 50000 초과이면 예외를 던진다", () => {
    expect(() =>
      createValidM19ExitPilotGuardConfig({ maxKrw: "60000" }),
    ).toThrow(UnsafePilotRuntimeConfigError);
  });

  it("guarded buy smoke approval 누락은 loader throw 없이 valid config를 반환한다", () => {
    // F1 수정: approval evidence 누락은 config load 예외가 아니라 guard의 FAILED_CLOSED로 판단한다.
    const config = loadM19ExitPilotGuardConfigFromEnv({
      SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
      SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE: "PAPER_FIXTURE",
      SEEMIRAI_M19_EXIT_PILOT_MAX_KRW: "10000",
      SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID: "m19-evidence-001",
      SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE: "1",
      // SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID 의도적 누락
    });

    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error("expected enabled config");
    expect(config.guardedBuySmokeEnabled).toBe(true);
    expect(config.guardedBuyApprovalEvidenceId).toBeUndefined();

    // guard function이 FAILED_CLOSED로 판단하는지 확인
    const result = validateM19GuardedBuySmokeGuard(config, "bid");
    expect(result.result).toBe("FAILED_CLOSED");
    expect(result.sideEffectPossible).toBe(false);
  });
});

describe("M19 guarded buy smoke guard", () => {
  it("M19 guard가 비활성이면 buy side는 SKIPPED 를 반환한다", () => {
    // loadM19ExitPilotGuardConfigFromEnv({}) 반환값과 동일한 disabled config
    const result = validateM19GuardedBuySmokeGuard({ enabled: false }, "bid");

    expect(result.result).toBe("SKIPPED");
    expect(result.sideEffectPossible).toBe(false);
  });

  it("M19 guard가 비활성이면 ask side도 SKIPPED 를 반환한다", () => {
    const result = validateM19GuardedBuySmokeGuard({ enabled: false }, "ask");

    expect(result.result).toBe("SKIPPED");
    expect(result.sideEffectPossible).toBe(false);
  });

  it("매도(side=ask)는 M19 guard 활성 시 PASSED", () => {
    const guard = createM19ExitPilotGuardConfigStub();
    const result = validateM19GuardedBuySmokeGuard(guard, "ask");

    expect(result.result).toBe("PASSED");
    expect(result.sideEffectPossible).toBe(true);
    expect(result.reason).toBe("exit_side_allowed");
  });

  it("guarded buy smoke가 꺼져 있으면 buy side는 SKIPPED", () => {
    const guard = createM19ExitPilotGuardConfigStub({
      guardedBuySmokeEnabled: false,
    });
    const result = validateM19GuardedBuySmokeGuard(guard, "bid");

    expect(result.result).toBe("SKIPPED");
    expect(result.reason).toBe("guarded_buy_not_enabled");
    expect(result.sideEffectPossible).toBe(false);
  });

  it("guarded buy smoke가 켜졌지만 approval evidence가 없으면 FAILED_CLOSED", () => {
    // guardedBuyApprovalEvidenceId를 생략해 undefined로 평가되게 한다.
    const guard: M19ExitPilotGuardConfig = {
      enabled: true,
      positionSource: "PAPER_FIXTURE",
      maxKrw: "10000",
      operatorEvidenceId: "m19-evidence-001",
      guardedBuySmokeEnabled: true,
    };
    const result = validateM19GuardedBuySmokeGuard(guard, "bid");

    expect(result.result).toBe("FAILED_CLOSED");
    expect(result.reason).toBe("guarded_buy_approval_missing");
    expect(result.sideEffectPossible).toBe(false);
  });

  it("guarded buy smoke가 켜지고 approval evidence가 있으면 PASSED", () => {
    const guard = createM19ExitPilotGuardConfigStub({
      guardedBuySmokeEnabled: true,
      guardedBuyApprovalEvidenceId: "buy-approval-001",
    });
    const result = validateM19GuardedBuySmokeGuard(guard, "bid");

    expect(result.result).toBe("PASSED");
    expect(result.reason).toBe("guarded_buy_approved");
    expect(result.sideEffectPossible).toBe(true);
  });
});

describe("M19 exit pilot guard safe summary", () => {
  it("비활성 config의 safe summary는 credential 원문을 포함하지 않는다", () => {
    const config: M19ExitPilotGuardConfigResult = { enabled: false };
    const summary = createM19ExitPilotGuardSafeSummary(config);

    expect(summary.enabled).toBe(false);
    expect(summary.positionSource).toBeNull();
    expect(summary.maxKrw).toBeNull();
    expect(summary.operatorEvidenceConfigured).toBe(false);
    expect(summary.positionEvidenceConfigured).toBe(false);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("m19-evidence");
  });

  it("활성 config의 safe summary는 operator evidence id를 boolean으로 낮춘다", () => {
    const config = createM19ExitPilotGuardConfigStub({
      operatorEvidenceId: "secret-evidence-xyz",
    });
    const summary = createM19ExitPilotGuardSafeSummary(config);

    expect(summary.enabled).toBe(true);
    expect(summary.operatorEvidenceConfigured).toBe(true);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-evidence-xyz");
  });

  it("guarded buy approval evidence가 없으면 guardedBuyApprovalConfigured=false", () => {
    const config: M19ExitPilotGuardConfig = {
      enabled: true,
      positionSource: "PAPER_FIXTURE",
      maxKrw: "10000",
      operatorEvidenceId: "m19-evidence-001",
      guardedBuySmokeEnabled: true,
    };
    const summary = createM19ExitPilotGuardSafeSummary(config);

    expect(summary.guardedBuyApprovalConfigured).toBe(false);
  });

  it("기존 포지션 evidence id는 safe summary에서 boolean으로만 노출한다", () => {
    const config = createM19ExitPilotGuardConfigStub({
      positionSource: "EXISTING_SMALL_POSITION",
      positionEvidenceId: "m16-secret-position-evidence",
    });
    const summary = createM19ExitPilotGuardSafeSummary(config);

    expect(summary.positionEvidenceConfigured).toBe(true);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("m16-secret-position-evidence");
  });
});

describe("M19 exit pilot guard contract invariants", () => {
  it("guard 검증 실패는 violation 목록을 한국어로 반환한다", () => {
    try {
      loadM19ExitPilotGuardConfigFromEnv({
        SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
      });
      expect.unreachable("expected UnsafePilotRuntimeConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafePilotRuntimeConfigError);
      const pilotError = error as UnsafePilotRuntimeConfigError;
      expect(pilotError.violations.length).toBeGreaterThan(0);
      // 한국어 violation 문구 확인
      expect(pilotError.violations.some((v) => v.includes("필요합니다"))).toBe(true);
    }
  });

  it("기본 PAPER_NO_KEY runtime은 M19 guard 조회만으로 live API를 호출하지 않는다", () => {
    // loadM19ExitPilotGuardConfigFromEnv는 순수 env 해석 함수이므로 어떤 API 호출도 만들지 않는다.
    const config = loadM19ExitPilotGuardConfigFromEnv({});
    expect(config.enabled).toBe(false);
  });
});

// ----- helpers -----

function createM19ExitPilotGuardConfigStub(
  overrides: Partial<M19ExitPilotGuardConfig> = {},
): M19ExitPilotGuardConfig {
  return {
    enabled: true,
    positionSource: "PAPER_FIXTURE",
    maxKrw: "10000",
    operatorEvidenceId: "m19-evidence-001",
    guardedBuySmokeEnabled: false,
    ...overrides,
  };
}

function createValidM19ExitPilotGuardConfig(
  overrides: Partial<{
    positionSource: string;
    maxKrw: string;
    operatorEvidenceId: string;
    positionEvidenceId: string;
  }> = {},
): M19ExitPilotGuardConfig {
  const env: NodeJS.ProcessEnv = {
    SEEMIRAI_RUN_M19_EXIT_PILOT: "1",
    SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE: overrides.positionSource ?? "PAPER_FIXTURE",
    SEEMIRAI_M19_EXIT_PILOT_MAX_KRW: overrides.maxKrw ?? "10000",
    SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID: overrides.operatorEvidenceId ?? "m19-evidence-001",
  };

  if (overrides.positionEvidenceId !== undefined) {
    env.SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID = overrides.positionEvidenceId;
  }

  return loadM19ExitPilotGuardConfigFromEnv(env) as M19ExitPilotGuardConfig;
}
