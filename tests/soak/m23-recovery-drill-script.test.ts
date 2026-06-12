import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m23-recovery-drill.mjs");

describe("M23 recovery drill script", () => {
  it("skips artifact validation unless the explicit M23 recovery guard is enabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-skip-"));
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir], {
      SEEMIRAI_RUN_M23_RECOVERY_DRILL: "0",
    });
    const summary = JSON.parse(stdout) as M23RecoveryDrillSummary;

    expect(summary.status).toBe("skipped");
    expect(summary.checks.runGuard).toMatchObject({
      status: "skipped",
      evidence: { requiredEnv: "SEEMIRAI_RUN_M23_RECOVERY_DRILL=1" },
    });
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("runs deterministic fixture smoke for restart, recovery, fail-closed, and backup blocker evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-fixture-"));
    const { stdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const summary = JSON.parse(stdout) as M23RecoveryDrillSummary;
    const report = await readFile(summary.artifacts.reportPath, "utf8");

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(summary.metrics).toMatchObject({
      heartbeatCount: 2,
      orderSubmissionCount: 1,
      duplicateOrderCount: 0,
      reconcileMismatchCount: 0,
      failClosedDrillCount: 3,
      dailyReportGeneratedCount: 1,
    });
    expect(getCheck(summary, "restartEvidence").status).toBe("ok");
    expect(getCheck(summary, "duplicateLiveOrder").status).toBe("ok");
    expect(getCheck(summary, "reconcileRecovery").status).toBe("ok");
    expect(getCheck(summary, "statusRecovery").status).toBe("ok");
    expect(getCheck(summary, "failClosedDrills").status).toBe("ok");
    expect(getCheck(summary, "backupRestore")).toMatchObject({
      status: "ok",
      evidence: { status: "blocked" },
    });
    expect(report).toContain("M23 restart/recovery drill report");
  });

  it("fails when restart submits the same live order identifier again", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-duplicate-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, [
      { type: "m22_pilot_heartbeat", observedAt: "2026-06-13T00:00:00.000Z" },
      { type: "broker_submission", observedAt: "2026-06-13T00:00:01.000Z", idempotencyKey: "m22a-duplicate" },
      { type: "m23_restart_checkpoint", phase: "before_restart", restartId: "restart-dup" },
    ]);
    await writeEventLog(afterPath, [
      { type: "m23_restart_checkpoint", phase: "after_restart", restartId: "restart-dup" },
      { type: "live_ops_event", eventKind: "RUNTIME_RESTART_DETECTED", restartId: "restart-dup" },
      { type: "live_reconcile_completed", result: "SUCCESS", mismatchCount: 0 },
      { type: "live_ops_status_summary", mode: "live_order_capable", liveOrderCapable: true },
      { type: "m22_pilot_heartbeat", observedAt: "2026-06-13T00:00:02.000Z" },
      { type: "live_ops_event", eventKind: "RUNTIME_RECOVERED", restartId: "restart-dup" },
      { type: "broker_submission", observedAt: "2026-06-13T00:00:03.000Z", idempotencyKey: "m22a-duplicate" },
      { type: "fail_closed_drill", scenario: "upbit_maintenance", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "upbit" },
      { type: "fail_closed_drill", scenario: "market_warning", result: "ENTRY_BLOCKED", alertEvidenceId: "market" },
      { type: "fail_closed_drill", scenario: "stale_data", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "stale" },
      { type: "daily_report_generated", observedAt: "2026-06-13T00:00:04.000Z" },
    ]);

    const summary = await runScriptExpectingFailure([
      "--json",
      "--artifact-dir",
      artifactDir,
      "--before-event-log",
      beforePath,
      "--after-event-log",
      afterPath,
      "--backup-restore-status",
      "passed",
      "--backup-restore-evidence",
      "restore-smoke-001",
    ]);

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "duplicateLiveOrder")).toMatchObject({
      status: "fail",
      evidence: { repeatedAfterRestart: ["m22a-duplicate"] },
    });
  });

  it("fails when backup/restore smoke result or blocker evidence is missing", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-backup-"));
    const { stdout: fixtureStdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const fixture = JSON.parse(fixtureStdout) as M23RecoveryDrillSummary;

    const summary = await runScriptExpectingFailure([
      "--json",
      "--artifact-dir",
      artifactDir,
      "--before-event-log",
      fixture.artifacts.beforeEventLogPath,
      "--after-event-log",
      fixture.artifacts.afterEventLogPath,
    ]);

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "backupRestore")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when restart lifecycle evidence is not tied to the restart id", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-restart-id-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-missing-id"));
    await writeEventLog(afterPath, validAfterRestartEvents("restart-missing-id").map((event) =>
      event.type === "live_ops_event" && event.eventKind === "RUNTIME_RECOVERED"
        ? omit(event, "restartId")
        : event));

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "restartEvidence")).toMatchObject({
      status: "fail",
      evidence: { missingRestartIds: ["recovered"] },
    });
  });

  it("fails when heartbeat does not resume after restart", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-heartbeat-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-no-heartbeat"));
    await writeEventLog(afterPath, validAfterRestartEvents("restart-no-heartbeat").filter((event) => event.type !== "m22_pilot_heartbeat"));

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "heartbeatRecovery")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when any reconcile completion after restart reports mismatch", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-reconcile-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-reconcile-mismatch"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-reconcile-mismatch"),
      { type: "live_reconcile_completed", result: "SUCCESS", mismatchCount: 1, runId: "reconcile-late-mismatch" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "reconcileRecovery")).toMatchObject({
      status: "fail",
    });
    expect(summary.metrics.reconcileMismatchCount).toBe(1);
  });

  it("uses the latest status summary so transient heartbeat-only recovery states do not fail a recovered run", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-status-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    const afterEvents = validAfterRestartEvents("restart-status-transient");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-status-transient"));
    await writeEventLog(afterPath, [
      { type: "live_ops_status_summary", mode: "heartbeat_only", liveOrderCapable: false },
      ...afterEvents,
    ]);

    const { stdout } = await runScript(validArtifactArgs(artifactDir, beforePath, afterPath), {
      SEEMIRAI_RUN_M23_RECOVERY_DRILL: "1",
    });
    const summary = JSON.parse(stdout) as M23RecoveryDrillSummary;

    expect(summary.status).toBe("passed");
    expect(getCheck(summary, "statusRecovery")).toMatchObject({
      status: "ok",
      evidence: { statusSummaryCount: 2 },
    });
  });

  it("counts documented risk gate bypass and crash events as closeout failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-counters-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-counters"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-counters"),
      { type: "risk_gate_bypass", observedAt: "2026-06-13T00:00:10.000Z" },
      { type: "crash", observedAt: "2026-06-13T00:00:11.000Z" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics).toMatchObject({
      riskGateBypassCount: 1,
      crashCount: 1,
    });
    expect(getCheck(summary, "closeoutZeroCounters")).toMatchObject({
      status: "fail",
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

async function runScriptExpectingFailure(args: readonly string[]) {
  try {
    await runScript(args, {
      SEEMIRAI_RUN_M23_RECOVERY_DRILL: "1",
    });
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as M23RecoveryDrillSummary;
  }

  throw new Error("script unexpectedly passed");
}

async function writeEventLog(filePath: string, events: readonly Record<string, unknown>[]) {
  await writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function validArtifactArgs(artifactDir: string, beforePath: string, afterPath: string): string[] {
  return [
    "--json",
    "--artifact-dir",
    artifactDir,
    "--before-event-log",
    beforePath,
    "--after-event-log",
    afterPath,
    "--backup-restore-status",
    "passed",
    "--backup-restore-evidence",
    "restore-smoke-001",
  ];
}

function validBeforeRestartEvents(restartId: string): Record<string, unknown>[] {
  return [
    { type: "m22_pilot_heartbeat", observedAt: "2026-06-13T00:00:00.000Z" },
    { type: "broker_submission", observedAt: "2026-06-13T00:00:01.000Z", idempotencyKey: `m22a-${restartId}` },
    { type: "m23_restart_checkpoint", phase: "before_restart", restartId },
  ];
}

function validAfterRestartEvents(restartId: string): Record<string, unknown>[] {
  return [
    { type: "m23_restart_checkpoint", phase: "after_restart", restartId },
    { type: "live_ops_event", eventKind: "RUNTIME_RESTART_DETECTED", restartId },
    { type: "live_reconcile_completed", result: "SUCCESS", mismatchCount: 0, runId: `reconcile-${restartId}` },
    { type: "m22_pilot_heartbeat", observedAt: "2026-06-13T00:00:02.000Z" },
    { type: "live_ops_status_summary", mode: "live_order_capable", liveOrderCapable: true },
    { type: "live_ops_event", eventKind: "RUNTIME_RECOVERED", restartId },
    { type: "fail_closed_drill", scenario: "upbit_maintenance", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "upbit" },
    { type: "fail_closed_drill", scenario: "market_warning", result: "ENTRY_BLOCKED", alertEvidenceId: "market" },
    { type: "fail_closed_drill", scenario: "stale_data", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "stale" },
    { type: "daily_report_generated", observedAt: "2026-06-13T00:00:04.000Z" },
  ];
}

function omit(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...input };
  delete clone[key];
  return clone;
}

function getCheck(summary: M23RecoveryDrillSummary, name: string): { status: string; evidence?: Record<string, unknown> } {
  const check = summary.checks[name];
  if (check === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return check;
}

interface M23RecoveryDrillSummary {
  status: string;
  input: string;
  artifacts: {
    summaryPath: string;
    reportPath: string;
    beforeEventLogPath: string;
    afterEventLogPath: string;
  };
  metrics: {
    heartbeatCount: number;
    orderSubmissionCount: number;
    duplicateOrderCount: number;
    riskGateBypassCount: number;
    crashCount: number;
    reconcileMismatchCount: number;
    failClosedDrillCount: number;
    dailyReportGeneratedCount: number;
  };
  checks: Record<string, { status: string; evidence?: Record<string, unknown> }>;
}
