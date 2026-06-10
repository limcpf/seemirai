import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsafeLiveAutonomousRuntimeConfigError,
  assertLiveAutonomousRuntimeReady,
  createLiveAutonomousRuntimeSafeSummary,
  evaluateLiveAutonomousRuntimeGuard,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";

const observedAt = "2026-06-10T11:10:00.000Z";

describe("M22 live autonomous runtime guard", () => {
  it("기본 PAPER_NO_KEY config에서는 M22 runtime을 비활성으로 닫는다", () => {
    const input = createGuardInput({ config: loadRuntimeConfig({}) });
    const result = evaluateLiveAutonomousRuntimeGuard(input);

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected disabled guard");
    expect(result.violations).toEqual(["M22 제한적 완전 자동매매 설정이 비활성입니다"]);

    const summary = createLiveAutonomousRuntimeSafeSummary(input);
    expect(summary).toMatchObject({
      enabled: false,
      ready: false,
      statusLabel: "M22 비활성",
      allowedMarkets: ["KRW-BTC"],
      maxOrderKrw: "10000",
      dailyAutonomousNotionalLimitKrw: "30000",
      maxOpenPositionNotionalKrw: "30000",
    });
  });

  it("enabled=true 여도 evidence와 readiness가 없으면 private client 조립 전 fail-closed 한다", () => {
    const result = evaluateLiveAutonomousRuntimeGuard(
      createGuardInput({
        config: createEnabledConfig(),
        telegramInboundReady: false,
        reconcileFresh: false,
        pnlStatusReady: false,
        decisionLedgerReady: false,
        exitEngineReady: false,
      }),
    );

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked guard");
    expect(result.violations).toEqual([
      "M22에는 M21 1주 gate evidence가 필요합니다",
      "M22에는 operator arm evidence가 필요합니다",
      "M22에는 budget evidence가 필요합니다",
      "M22에는 key scope evidence가 필요합니다",
      "M22에는 M20 Telegram inbound readiness가 필요합니다",
      "M22에는 최신 reconcile 상태가 필요합니다",
      "M22에는 PnL status readiness가 필요합니다",
      "M22에는 decision ledger readiness가 필요합니다",
      "M22에는 M19 exit engine readiness가 필요합니다",
    ]);
  });

  it("모든 evidence와 readiness가 있으면 runtime ready config를 반환한다", () => {
    const input = createReadyGuardInput();
    const result = evaluateLiveAutonomousRuntimeGuard(input);

    expect(result.ready).toBe(true);
    if (!result.ready) throw new Error("expected ready guard");
    expect(result.config.enabled).toBe(true);
    expect(assertLiveAutonomousRuntimeReady(input)).toMatchObject({
      enabled: true,
      allowed_markets: ["KRW-BTC"],
    });
  });

  it("guard 실패 시 assert helper가 한국어 violation을 가진 오류를 던진다", () => {
    expect(() => assertLiveAutonomousRuntimeReady(createGuardInput({ config: createEnabledConfig() }))).toThrow(
      UnsafeLiveAutonomousRuntimeConfigError,
    );
  });

  it("safe summary는 evidence id 원문 없이 readiness와 action을 노출한다", () => {
    const input = createReadyGuardInput();
    const summary = createLiveAutonomousRuntimeSafeSummary(input);

    expect(summary).toMatchObject({
      enabled: true,
      ready: true,
      statusLabel: "M22 자동매매 준비",
      m21WeekGateEvidenceConfigured: true,
      operatorArmEvidenceConfigured: true,
      budgetEvidenceConfigured: true,
      keyScopeEvidenceConfigured: true,
      telegramInboundReady: true,
      reconcileFresh: true,
      pnlStatusReady: true,
      decisionLedgerReady: true,
      exitEngineReady: true,
    });
    expect(JSON.stringify(summary)).not.toContain("m21-week-gate-evidence-001");
    expect(JSON.stringify(summary)).not.toContain("operator-arm-evidence-001");
    expect(JSON.stringify(summary)).not.toContain("budget-evidence-001");
    expect(JSON.stringify(summary)).not.toContain("key-scope-evidence-001");
  });

  it("M22 guard module은 PAPER_NO_KEY 기본 경계에서 live order API 호출 경로를 만들지 않는다", async () => {
    const guardSource = await readFile(
      path.join(process.cwd(), "src", "runtime", "live-autonomous-config", "guard.ts"),
      "utf8",
    );
    const summarySource = await readFile(
      path.join(process.cwd(), "src", "runtime", "live-autonomous-config", "summary.ts"),
      "utf8",
    );
    const combinedSource = `${guardSource}\n${summarySource}`;

    expect(combinedSource).not.toMatch(/POST \/v1\/orders|DELETE \/v1\/order|submitOrder\(|cancelOrder\(/u);
    expect(combinedSource).not.toMatch(/UpbitPrivateRestClient|createGuardedUpbitLiveBrokerRuntime/u);
  });
});

function createEnabledConfig() {
  return loadRuntimeConfig({
    live_autonomous: {
      enabled: true,
    },
  });
}

function createGuardInput(
  overrides: Partial<Parameters<typeof evaluateLiveAutonomousRuntimeGuard>[0]> = {},
): Parameters<typeof evaluateLiveAutonomousRuntimeGuard>[0] {
  return {
    config: loadRuntimeConfig({}),
    observedAt,
    telegramInboundReady: true,
    reconcileFresh: true,
    pnlStatusReady: true,
    decisionLedgerReady: true,
    exitEngineReady: true,
    ...overrides,
  };
}

function createReadyGuardInput(): Parameters<typeof evaluateLiveAutonomousRuntimeGuard>[0] {
  return createGuardInput({
    config: createEnabledConfig(),
    m21WeekGateEvidenceId: "m21-week-gate-evidence-001",
    operatorArmEvidenceId: "operator-arm-evidence-001",
    budgetEvidenceId: "budget-evidence-001",
    keyScopeEvidenceId: "key-scope-evidence-001",
  });
}
