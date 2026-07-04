import { describe, expect, it } from "vitest";

import { loadLiveOpsRuntimeAdapterInputs } from "../../src/runtime/index.js";
import type { LiveOpsCliOptions } from "../../src/runtime/live-ops-cli/types.js";

type RuntimeAdapterForTest = {
  resolvePath(value: string): string;
  loadConfigFile(path: string): Promise<Record<string, unknown>>;
  loadEnvFile(path: string): Promise<Record<string, string>>;
  validateConfig(config: Record<string, unknown>): void;
  validateEnv(env: Record<string, string>): void;
  suppressStartupTelegramAlert(config: Record<string, unknown>): Record<string, unknown>;
  loadAttachReadonlyInputs(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateDbReadiness(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  assertDbReadinessReady(summary: Record<string, unknown>): void;
  evaluateMarketData(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  assertMarketDataReady(summary: Record<string, unknown>, options: { fixtureSmoke?: boolean }): void;
  evaluateBrokerGuard(input: Record<string, unknown>): Record<string, unknown>;
  createProductionRuntime(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  createDecisionHistoryWriter?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  collectAutonomousAnalysisPreflight(input: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  evaluateAnalysisDecision(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAnalysisOrderIntents(summary: Record<string, unknown>): unknown[];
  createProductionExecutionInputs(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateLiveExecution(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateReconcilePnlStatus(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateTelegramAlert(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  closeProductionRuntime(runtime: Record<string, unknown>): Promise<void>;
  closeDecisionHistoryWriter?(writer: Record<string, unknown>): Promise<void>;
};

function createRuntimeAdapterForTest(calls: string[], overrides: Partial<RuntimeAdapterForTest> = {}): RuntimeAdapterForTest {
  const adapter: RuntimeAdapterForTest = {
    resolvePath(value) {
      calls.push(`resolve:${value}`);
      return `/resolved/${value}`;
    },
    async loadConfigFile(path) {
      calls.push(`loadConfig:${path}`);
      return { mode: "LIVE_AUTONOMOUS_SMALL_BUDGET", universe: { default_market: "KRW-BTC" } };
    },
    async loadEnvFile(path) {
      calls.push(`loadEnv:${path}`);
      return { SEEMIRAI_DATABASE_URL: "postgres://fixture" };
    },
    validateConfig() {
      calls.push("validateConfig");
    },
    validateEnv() {
      calls.push("validateEnv");
    },
    suppressStartupTelegramAlert(config) {
      calls.push("suppressStartupTelegramAlert");
      return { ...config, telegram: { startup_alert_enabled: false } };
    },
    async loadAttachReadonlyInputs(input) {
      calls.push(`attach:${String(input.attach)}`);
      return { attachStatusSourcePath: "/resolved/status.json", dbReadiness: { ready: true } };
    },
    async evaluateDbReadiness() {
      calls.push("dbReadiness");
      return { ready: true };
    },
    assertDbReadinessReady() {
      calls.push("assertDbReadiness");
    },
    async evaluateMarketData() {
      calls.push("marketData");
      return { ready: true };
    },
    assertMarketDataReady(_summary, options) {
      calls.push(`assertMarketData:${String(options.fixtureSmoke)}`);
    },
    evaluateBrokerGuard() {
      calls.push("brokerGuard");
      return { ready: true };
    },
    async createProductionRuntime() {
      calls.push("createRuntime");
      return { runtimeId: "runtime" };
    },
    async collectAutonomousAnalysisPreflight(input) {
      calls.push(`analysisPreflight:${String(input.productionRuntime !== undefined)}`);
      return undefined;
    },
    async evaluateAnalysisDecision() {
      calls.push("analysisDecision");
      return { ready: true };
    },
    getAnalysisOrderIntents() {
      calls.push("orderIntents");
      return [];
    },
    async createProductionExecutionInputs() {
      calls.push("executionInputs");
      return { orderIntents: [], budgetSnapshot: { used: 0 } };
    },
    async evaluateLiveExecution() {
      calls.push("liveExecution");
      return { ready: true, liveOrderCapable: false };
    },
    async evaluateReconcilePnlStatus() {
      calls.push("reconcilePnlStatus");
      return { ready: true };
    },
    async evaluateTelegramAlert() {
      calls.push("telegramAlert");
      return { ready: true };
    },
    async closeProductionRuntime() {
      calls.push("closeRuntime");
    },
  };
  return { ...adapter, ...overrides };
}

describe("Live Ops runtime adapter service", () => {
  it("fixture smoke lifecycle input을 TypeScript adapter 순서로 조립한다", async () => {
    const calls: string[] = [];
    const adapter = createRuntimeAdapterForTest(calls);

    const result = await loadLiveOpsRuntimeAdapterInputs({
      adapter,
      options: {
        configPath: "config.json",
        envFilePath: "fixture.env",
        fixtureSmoke: true,
      },
    });

    expect(result).toMatchObject({
      configPath: "/resolved/config.json",
      envFilePath: "/resolved/fixture.env",
      dbReadiness: { ready: true },
      marketData: { ready: true },
      analysisDecision: { ready: true },
      liveExecution: { ready: true },
      reconcilePnlStatus: { ready: true },
      telegramAlert: { ready: true },
    });
    expect(calls).toEqual([
      "resolve:config.json",
      "resolve:fixture.env",
      "loadConfig:/resolved/config.json",
      "loadEnv:/resolved/fixture.env",
      "validateConfig",
      "validateEnv",
      "dbReadiness",
      "assertDbReadiness",
      "marketData",
      "assertMarketData:true",
      "brokerGuard",
      "analysisPreflight:false",
      "analysisDecision",
      "orderIntents",
      "executionInputs",
      "liveExecution",
      "reconcilePnlStatus",
      "telegramAlert",
    ]);
  });

  it("broker guard 차단 시 production runtime 없이 decision history writer만 fallback으로 전달한다", async () => {
    const calls: string[] = [];
    let liveExecutionInput: Record<string, unknown> | undefined;
    const adapter = createRuntimeAdapterForTest(calls, {
      evaluateBrokerGuard() {
        calls.push("brokerGuardBlocked");
        return { ready: false };
      },
      async createProductionRuntime() {
        throw new Error("production runtime should not be created");
      },
      async createDecisionHistoryWriter(input) {
        calls.push(`decisionHistoryWriter:${String(input.databaseUrl)}`);
        return { writerId: "fallback-writer" };
      },
      async createProductionExecutionInputs() {
        calls.push("executionInputs");
        return { orderIntents: [] };
      },
      async evaluateLiveExecution(input) {
        calls.push("liveExecution");
        liveExecutionInput = input;
        return { ready: false, liveOrderCapable: false };
      },
      async closeDecisionHistoryWriter(writer) {
        calls.push(`closeDecisionHistoryWriter:${String(writer.writerId)}`);
      },
    });

    await loadLiveOpsRuntimeAdapterInputs({
      options: {
        configPath: "config.json",
        envFilePath: "fixture.env",
        fixtureSmoke: false,
      },
      adapter,
    });

    expect(liveExecutionInput?.decisionHistoryWriter).toMatchObject({ writerId: "fallback-writer" });
    expect(calls).toContain("decisionHistoryWriter:postgres://fixture");
    expect(calls).toContain("closeDecisionHistoryWriter:fallback-writer");
    expect(calls).not.toContain("createRuntime");
  });

  it("production runtime을 만든 뒤 downstream이 실패해도 close를 보장한다", async () => {
    const calls: string[] = [];
    const adapter = createRuntimeAdapterForTest(calls, {
      async evaluateLiveExecution() {
        calls.push("liveExecutionFailed");
        throw new Error("execution failed");
      },
    });

    await expect(loadLiveOpsRuntimeAdapterInputs({
      adapter,
      options: {
        configPath: "config.json",
        envFilePath: "fixture.env",
        fixtureSmoke: false,
      },
    })).rejects.toThrow("execution failed");
    expect(calls).toContain("createRuntime");
    expect(calls.at(-1)).toBe("closeRuntime");
  });

  it("attach readonly 경로는 DB/provider readiness 전에 status source로 종료한다", async () => {
    const calls: string[] = [];
    const adapter = createRuntimeAdapterForTest(calls);

    const result = await loadLiveOpsRuntimeAdapterInputs({
      adapter,
      options: {
        configPath: "config.json",
        envFilePath: "fixture.env",
        attach: "status.json",
        attachReadonly: true,
        fixtureSmoke: false,
      },
    });

    expect(result).toMatchObject({
      attachStatusSourcePath: "/resolved/status.json",
      dbReadiness: { ready: true },
    });
    expect(calls).toEqual([
      "resolve:config.json",
      "resolve:fixture.env",
      "loadConfig:/resolved/config.json",
      "loadEnv:/resolved/fixture.env",
      "validateConfig",
      "validateEnv",
      "attach:status.json",
    ]);
  });
});
