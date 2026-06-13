import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m22-live-autonomous-pilot.mjs");

describe("M22 live autonomous pilot runner script", () => {
  it("skips live execution unless the explicit M22 pilot guard is enabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-pilot-skip-"));
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir], {
      SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT: "0",
    });
    const summary = JSON.parse(stdout) as M22PilotSummary;

    expect(summary.status).toBe("skipped");
    expect(summary.checks.longRunGuard).toMatchObject({
      status: "skipped",
      evidence: { requiredEnv: "SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1" },
    });
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("runs deterministic fixture smoke without opening live side effects", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-pilot-fixture-"));
    const { stdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const summary = JSON.parse(stdout) as M22PilotSummary;
    const events = await readFile(summary.artifacts.eventLogPath, "utf8");

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(summary.metrics).toMatchObject({
      heartbeatCount: 1,
      crashCount: 0,
      unhandledRejectionCount: 0,
      riskGateBypassCount: 0,
      reconcileMismatchCount: 0,
      duplicateOrderCount: 0,
      untrackedFillCount: 0,
      dailyRealizedLossKrw: 0,
      openPositionNotionalKrw: 0,
    });
    expect(getCheck(summary, "configSafety")).toMatchObject({
      status: "ok",
      evidence: { maxOpenPositionNotionalKrw: "30000" },
    });
    expect(getCheck(summary, "closeoutZeroCounters").status).toBe("ok");
    expect(events).toContain("m22_pilot_heartbeat");
  });

  it("fails before running a command when live autonomous config remains disabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-pilot-preflight-"));
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--pilot-command", process.execPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "configSafety").status).toBe("fail");
    expect(getCheck(summary, "pilotCommand").status).toBe("ok");
  });

  it("wraps a short live command and validates event-log closeout counters", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-pilot-live-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const childPath = path.join(artifactDir, "pilot-child.mjs");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(
      childPath,
      `import { appendFile } from "node:fs/promises";
await appendFile(process.env.SEEMIRAI_M22_PILOT_EVENT_LOG, JSON.stringify({ type: "m22_pilot_heartbeat", observedAt: new Date().toISOString() }) + "\\n", "utf8");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const { stdout } = await runScript(
      [
        "--json",
        "--artifact-dir",
        artifactDir,
        "--config",
        configPath,
        "--duration-ms",
        "1000",
        "--termination-grace-ms",
        "500",
        "--pilot-command",
        process.execPath,
        "--",
        childPath,
        "--daemon-option",
        "value",
      ],
      createReadyEnv(),
    );
    const summary = JSON.parse(stdout) as M22PilotSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "pilotCommand").status).toBe("ok");
    expect(getCheck(summary, "heartbeat").status).toBe("ok");
    expect(getCheck(summary, "closeoutZeroCounters").status).toBe("ok");
    expect(summary.metrics.pilotProcess?.ranFullDuration).toBe(true);
  });

  it("summarizes budget loss and exposure from the wrapped command event log", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-pilot-budget-events-"));
    const configPath = path.join(artifactDir, "m22-config.json");
    const childPath = path.join(artifactDir, "pilot-budget-child.mjs");
    await writeFile(configPath, `${JSON.stringify(createEnabledM22Config(), null, 2)}\n`, "utf8");
    await writeFile(
      childPath,
      `import { appendFile } from "node:fs/promises";
const write = async (event) => appendFile(process.env.SEEMIRAI_M22_PILOT_EVENT_LOG, JSON.stringify(event) + "\\n", "utf8");
await write({ type: "m22_pilot_heartbeat", observedAt: new Date().toISOString(), openPositionNotionalKrw: "8000" });
await write({ type: "daily_report_generated", observedAt: new Date().toISOString(), openPositionNotionalKrw: "12000", dailyRealizedLossKrw: "3000" });
await write({ type: "m22_pilot_heartbeat", observedAt: new Date().toISOString(), openPositionNotionalKrw: "7000", realizedPnlKrw: "-5000" });
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const { stdout } = await runScript(
      [
        "--json",
        "--artifact-dir",
        artifactDir,
        "--config",
        configPath,
        "--duration-ms",
        "1000",
        "--termination-grace-ms",
        "500",
        "--pilot-command",
        process.execPath,
        "--",
        childPath,
      ],
      createReadyEnv(),
    );
    const summary = JSON.parse(stdout) as M22PilotSummary;

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      dailyRealizedLossKrw: 5000,
      openPositionNotionalKrw: 12000,
      latestOpenPositionNotionalKrw: 7000,
    });
  });
});

async function runScript(args: readonly string[], env: Record<string, string> = {}) {
  return await execFileAsync("node", [scriptPath, ...args], {
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function runScriptExpectingFailure(args: readonly string[], env: Record<string, string>) {
  try {
    await runScript(args, env);
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as M22PilotSummary;
  }

  throw new Error("script unexpectedly passed");
}

function createReadyEnv(): Record<string, string> {
  return {
    SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT: "1",
    SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID: "operator-arm-evidence",
    SEEMIRAI_M22_BUDGET_EVIDENCE_ID: "budget-evidence",
    SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID: "m21-week-gate-evidence",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "key-scope-evidence",
    SEEMIRAI_PILOT_PROFILE: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
    SEEMIRAI_RUN_UPBIT_ORDER_SMOKE: "1",
    SEEMIRAI_DATABASE_URL: "postgres://redacted:secret@127.0.0.1:55432/seemirai",
    SEEMIRAI_TELEGRAM_BOT_TOKEN: "telegram-secret-token",
    SEEMIRAI_M22_TELEGRAM_INBOUND_READY: "1",
    SEEMIRAI_M22_RECONCILE_FRESH: "1",
    SEEMIRAI_M22_PNL_STATUS_READY: "1",
    SEEMIRAI_M22_DECISION_LEDGER_READY: "1",
    SEEMIRAI_M22_EXIT_ENGINE_READY: "1",
  };
}

function getCheck(summary: M22PilotSummary, name: string): { status: string; evidence?: Record<string, unknown> } {
  const check = summary.checks[name];
  if (check === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return check;
}

function createEnabledM22Config(): Record<string, unknown> {
  return {
    withdrawal_enabled: false,
    futures_enabled: false,
    leverage_enabled: false,
    market_order_enabled: false,
    entry_market_order_enabled: false,
    live_autonomous: {
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      enabled: true,
      allowed_markets: ["KRW-BTC"],
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
      max_daily_loss_krw: "10000",
      max_weekly_loss_krw: "30000",
      max_price_deviation_bps: "30",
      require_m21_week_gate_evidence: true,
      require_m20_inbound_readiness: true,
      require_reconcile_freshness: true,
      require_pnl_status_ready: true,
      require_decision_ledger_ready: true,
      require_exit_engine_ready: true,
      require_operator_arm_evidence_id: true,
      require_budget_evidence_id: true,
      require_key_scope_evidence_id: true,
      identifier_prefix: "m22a-",
      identifier_max_length: 32,
    },
  };
}

interface M22PilotSummary {
  status: string;
  input: string;
  artifacts: {
    eventLogPath: string;
    reportPath: string;
    summaryPath: string;
  };
  metrics: {
    heartbeatCount: number;
    crashCount: number;
    unhandledRejectionCount: number;
    riskGateBypassCount: number;
    reconcileMismatchCount: number;
    duplicateOrderCount: number;
    untrackedFillCount: number;
    dailyRealizedLossKrw: number;
    openPositionNotionalKrw: number;
    latestOpenPositionNotionalKrw?: number;
    pilotProcess: null | {
      ranFullDuration: boolean;
    };
  };
  checks: Record<string, { status: string; evidence?: Record<string, unknown> }>;
}
