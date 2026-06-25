import { describe, expect, it } from "vitest";

import {
  createLiveOpsAppCoreBootPlan,
  runLiveOpsForegroundAppCore,
  runLiveOpsTuiAppCore,
} from "../../src/runtime/index.js";
import type { LiveOpsCliOptions, LiveOpsSupportModule } from "../../src/runtime/live-ops-cli/types.js";

type FakeSupport = LiveOpsSupportModule & {
  calls: string[];
  lastLoadedOptions: LiveOpsCliOptions | undefined;
  lastSummaryInput: Record<string, unknown> | undefined;
};

function createFakeSupport(options: LiveOpsCliOptions): FakeSupport {
  const calls: string[] = [];
  const summary = {
    status: "ready",
    fixtureSmoke: options.fixtureSmoke === true,
    tui: options.tui === true,
  };
  let lastLoadedOptions: LiveOpsCliOptions | undefined;
  let lastSummaryInput: Record<string, unknown> | undefined;

  return {
    calls,
    get lastLoadedOptions() {
      return lastLoadedOptions;
    },
    get lastSummaryInput() {
      return lastSummaryInput;
    },
    parseArgs(argv) {
      calls.push(`parseArgs:${argv.join(" ")}`);
      return options;
    },
    async loadLiveOpsCliInputs(loadOptions) {
      calls.push(`loadInputs:attachReadonly=${String(loadOptions.attachReadonly)}`);
      lastLoadedOptions = loadOptions;
      return {
        config: { mode: "LIVE_AUTONOMOUS_SMALL_BUDGET" },
        dbReadiness: { ready: true },
      };
    },
    renderLiveOpsSummary(input) {
      calls.push("renderSummary");
      lastSummaryInput = input;
      return summary;
    },
    renderLiveOpsTuiDashboard(value) {
      calls.push("renderTui");
      return `dashboard:${JSON.stringify(value)}`;
    },
    assertLiveOpsCliSummaryReady(value, readinessOptions) {
      calls.push(`assertReady:${String(readinessOptions.fixtureSmoke)}:${JSON.stringify(value)}`);
    },
    printHelp(commandName) {
      calls.push(`printHelp:${commandName}`);
    },
    printJson(value) {
      calls.push(`printJson:${JSON.stringify(value)}`);
    },
    printText(text) {
      calls.push(`printText:${text}`);
    },
  };
}

describe("Live Ops app core contract", () => {
  it("boot plan은 production lifecycle side effect 순서를 TypeScript 계약으로 노출한다", () => {
    const plan = createLiveOpsAppCoreBootPlan({ commandName: "live:ops", renderMode: "json" });

    expect(plan.steps.map((step) => step.id)).toEqual([
      "config_env_validation",
      "db_readiness",
      "provider_readiness",
      "market_data",
      "analysis_decision",
      "live_execution",
      "reconcile_pnl_status",
      "telegram_alert",
      "tui_render",
    ]);
    expect(plan.steps.map((step) => step.owner)).toEqual([
      "support_shim",
      "support_shim",
      "support_shim",
      "support_shim",
      "support_shim",
      "support_shim",
      "support_shim",
      "support_shim",
      "app_core",
    ]);
  });

  it("foreground core는 기존 support side effect 순서를 유지하고 readiness assertion까지 실행한다", async () => {
    const support = createFakeSupport({
      configPath: "config/live-ops.example.json",
      envFilePath: "tests/fixtures/live-ops/fake.env",
      fixtureSmoke: true,
    });

    const result = await runLiveOpsForegroundAppCore({
      support,
      argv: ["--fixture-smoke"],
      commandName: "live:ops",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      commandName: "live:ops",
      renderMode: "json",
      summary: {
        status: "ready",
      },
    });
    expect(support.calls).toEqual([
      "parseArgs:--fixture-smoke",
      "loadInputs:attachReadonly=undefined",
      "renderSummary",
      'printJson:{"status":"ready","fixtureSmoke":true,"tui":false}',
      'assertReady:true:{"status":"ready","fixtureSmoke":true,"tui":false}',
    ]);
  });

  it("foreground core는 support가 structured runtime adapter를 제공하면 legacy input loader를 건너뛴다", async () => {
    const support = createFakeSupport({
      configPath: "config/live-ops.example.json",
      envFilePath: "tests/fixtures/live-ops/fake.env",
      fixtureSmoke: true,
    });
    support.loadLiveOpsCliInputs = async () => {
      support.calls.push("legacyLoadInputs");
      return { legacy: true };
    };
    const runtimeAdapter = createFakeSupportRuntimeAdapter(support.calls);
    const supportWithAdapter = Object.assign(support, {
      createLiveOpsRuntimeAdapter() {
        support.calls.push("createRuntimeAdapter");
        return runtimeAdapter;
      },
    });

    await runLiveOpsForegroundAppCore({
      support: supportWithAdapter,
      argv: ["--fixture-smoke"],
      commandName: "live:ops",
    });

    expect(support.calls).toContain("createRuntimeAdapter");
    expect(support.calls).toContain("runtimeAdapter:telegramAlert");
    expect(support.calls).not.toContain("legacyLoadInputs");
    expect(support.lastSummaryInput).toMatchObject({
      configPath: "config/live-ops.example.json",
      envFilePath: "tests/fixtures/live-ops/fake.env",
      telegramAlert: {
        ready: true,
      },
    });
  });

  it("TUI core는 attach 누락 시 provider와 broker side effect 전에 fail-closed 한다", async () => {
    const support = createFakeSupport({});

    await expect(runLiveOpsTuiAppCore({ support, argv: [], commandName: "live:ops:tui" })).rejects.toThrow(
      "--attach <run-id|socket|status-source> 값이 필요합니다.",
    );
    expect(support.calls).toEqual(["parseArgs:"]);
  });

  it("TUI core는 attach 읽기 전용 옵션을 강제하고 text dashboard만 출력한다", async () => {
    const support = createFakeSupport({ attach: "fixture", fixtureSmoke: true });

    const result = await runLiveOpsTuiAppCore({
      support,
      argv: ["--attach", "fixture", "--fixture-smoke"],
      commandName: "live:ops:tui",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      commandName: "live:ops:tui",
      renderMode: "text",
    });
    expect(support.lastLoadedOptions).toMatchObject({
      attach: "fixture",
      attachReadonly: true,
    });
    expect(support.lastSummaryInput).toMatchObject({
      tui: true,
      attach: "fixture",
    });
    expect(support.calls).toEqual([
      "parseArgs:--attach fixture --fixture-smoke",
      "loadInputs:attachReadonly=true",
      "renderSummary",
      "renderTui",
      'printText:dashboard:{"status":"ready","fixtureSmoke":true,"tui":false}',
    ]);
  });
});

function createFakeSupportRuntimeAdapter(calls: string[]) {
  return {
    resolvePath(value: string) {
      calls.push(`runtimeAdapter:resolve:${value}`);
      return value;
    },
    async loadConfigFile() {
      calls.push("runtimeAdapter:loadConfig");
      return { universe: { default_market: "KRW-BTC" } };
    },
    async loadEnvFile() {
      calls.push("runtimeAdapter:loadEnv");
      return { SEEMIRAI_DATABASE_URL: "postgres://fixture" };
    },
    validateConfig() {
      calls.push("runtimeAdapter:validateConfig");
    },
    validateEnv() {
      calls.push("runtimeAdapter:validateEnv");
    },
    suppressStartupTelegramAlert(config: Record<string, unknown>) {
      calls.push("runtimeAdapter:suppressStartupTelegramAlert");
      return config;
    },
    async loadAttachReadonlyInputs() {
      calls.push("runtimeAdapter:attach");
      return {};
    },
    async evaluateDbReadiness() {
      calls.push("runtimeAdapter:dbReadiness");
      return { ready: true };
    },
    assertDbReadinessReady() {
      calls.push("runtimeAdapter:assertDbReadiness");
    },
    async evaluateMarketData() {
      calls.push("runtimeAdapter:marketData");
      return { ready: true };
    },
    assertMarketDataReady() {
      calls.push("runtimeAdapter:assertMarketData");
    },
    evaluateBrokerGuard() {
      calls.push("runtimeAdapter:brokerGuard");
      return { ready: true };
    },
    async createProductionRuntime() {
      calls.push("runtimeAdapter:createRuntime");
      return {};
    },
    async collectAutonomousAnalysisPreflight() {
      calls.push("runtimeAdapter:analysisPreflight");
      return undefined;
    },
    async evaluateAnalysisDecision() {
      calls.push("runtimeAdapter:analysisDecision");
      return { ready: true };
    },
    getAnalysisOrderIntents() {
      calls.push("runtimeAdapter:orderIntents");
      return [];
    },
    async createProductionExecutionInputs() {
      calls.push("runtimeAdapter:executionInputs");
      return { orderIntents: [] };
    },
    async evaluateLiveExecution() {
      calls.push("runtimeAdapter:liveExecution");
      return { ready: true, liveOrderCapable: false };
    },
    async evaluateReconcilePnlStatus() {
      calls.push("runtimeAdapter:reconcilePnlStatus");
      return { ready: true };
    },
    async evaluateTelegramAlert() {
      calls.push("runtimeAdapter:telegramAlert");
      return { ready: true };
    },
    async closeProductionRuntime() {
      calls.push("runtimeAdapter:closeRuntime");
    },
  };
}
