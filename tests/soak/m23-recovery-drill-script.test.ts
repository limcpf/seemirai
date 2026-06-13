import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m23-recovery-drill.mjs");

describe("M23 recovery drill script", () => {
  it("uses explicit operator home paths in the systemd service template", async () => {
    const servicePath = path.join(process.cwd(), "deploy", "systemd", "seemirai-m23-live-small-budget.service.example");
    const unit = await readFile(servicePath, "utf8");

    expect(unit).toContain("User=lim");
    expect(unit).toContain("EnvironmentFile=/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/m22.env");
    expect(unit).toContain("ExecStart=/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/run-24h-pilot.sh");
    expect(unit).toContain("EnvironmentFile=/home/lim/vaults/99_운영/seemirai-m22-live-autonomous/m23-segment.env");
    expect(unit).toContain("--candidate-file ${SEEMIRAI_M23_SEGMENT_CANDIDATE_FILE}");
    expect(unit).toContain("--candidate-start end");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("%h/");
    expect(unit).not.toContain("Restart=always");
  });

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
      failClosedDrillCount: 4,
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
      {
        type: "m23_restart_checkpoint",
        phase: "before_restart",
        restartId: "restart-dup",
        orderAttemptId: "m22a-duplicate",
        reconcileRunId: "reconcile-restart-dup",
      },
    ]);
    await writeEventLog(afterPath, [
      {
        type: "m23_restart_checkpoint",
        phase: "after_restart",
        restartId: "restart-dup",
        orderAttemptId: "m22a-duplicate",
        reconcileRunId: "reconcile-restart-dup",
      },
      { type: "live_ops_event", eventKind: "RUNTIME_RESTART_DETECTED", restartId: "restart-dup" },
      { type: "live_reconcile_completed", result: "SUCCESS", mismatchCount: 0, runId: "reconcile-restart-dup" },
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

  it("fails when order_submitted repeats a pre-restart identifier even if broker_submission has a new id", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-mixed-duplicate-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-mixed-duplicate"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-mixed-duplicate"),
      { type: "broker_submission", observedAt: "2026-06-13T00:00:10.000Z", idempotencyKey: "m22a-new-after-restart" },
      { type: "order_submitted", observedAt: "2026-06-13T00:00:11.000Z", identifier: "m22a-restart-mixed-duplicate" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics.duplicateOrderCount).toBe(1);
    expect(getCheck(summary, "duplicateLiveOrder")).toMatchObject({
      status: "fail",
      evidence: { repeatedAfterRestart: ["m22a-restart-mixed-duplicate"] },
    });
  });

  it("fails when broker_submission repeats the same identifier after restart", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-after-duplicate-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-after-duplicate"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-after-duplicate"),
      { type: "broker_submission", observedAt: "2026-06-13T00:00:10.000Z", idempotencyKey: "m22a-after-restart-duplicate" },
      { type: "broker_submission", observedAt: "2026-06-13T00:00:11.000Z", idempotencyKey: "m22a-after-restart-duplicate" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics.duplicateOrderCount).toBe(1);
    expect(getCheck(summary, "duplicateLiveOrder")).toMatchObject({
      status: "fail",
      evidence: {
        duplicateAfterRestart: ["m22a-after-restart-duplicate"],
      },
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

  it("fails secret scan when database credentials are present in recovery artifacts", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-secret-db-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-db-secret"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-db-secret"),
      { type: "db_restore_attempt", databaseUrl: "postgres://operator:password@localhost:5432/seemirai_restore" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "secretScan")).toMatchObject({
      status: "fail",
    });
  });

  it("fails secret scan and redacts backup evidence when CLI evidence contains credentials", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-secret-evidence-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-evidence-secret"));
    await writeEventLog(afterPath, validAfterRestartEvents("restart-evidence-secret"));

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
      "postgres://operator:password@localhost:5432/seemirai_restore",
    ]);

    expect(getCheck(summary, "backupRestore")).toMatchObject({
      status: "ok",
      evidence: { evidence: "[REDACTED_BY_M23_SECRET_SCAN]" },
    });
    expect(getCheck(summary, "secretScan")).toMatchObject({
      status: "fail",
    });
  });

  it("preserves JSON output for argument parsing failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-arg-error-"));

    try {
      await runScript([
        "--json",
        "--artifact-dir",
        artifactDir,
        "--backup-restore-status",
        "invalid-status",
      ]);
    } catch (error) {
      const executionError = error as Error & { code?: number; stdout?: string };
      expect(executionError.code).toBe(1);
      const summary = JSON.parse(executionError.stdout ?? "{}") as M23RecoveryDrillSummary;

      expect(summary.status).toBe("failed");
      expect(summary.input).toBe("runner_fatal");
      expect(summary.artifacts.summaryPath).toContain(artifactDir);
      expect(getCheck(summary, "fatalError")).toMatchObject({
        status: "fail",
      });
      return;
    }

    throw new Error("script unexpectedly passed");
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

  it("fails when the latest restart is missing recovered evidence even if an earlier restart recovered", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-latest-restart-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, [
      ...validBeforeRestartEvents("restart-earlier"),
      ...validBeforeRestartEvents("restart-latest"),
    ]);
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-earlier"),
      ...validAfterRestartEvents("restart-latest").filter((event) =>
        !(event.type === "live_ops_event" && event.eventKind === "RUNTIME_RECOVERED")),
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "restartEvidence")).toMatchObject({
      status: "fail",
      evidence: { recovered: false },
    });
  });

  it("fails when restart checkpoint changes the durable reservation or reconcile snapshot id", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-reuse-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-reuse"));
    await writeEventLog(afterPath, validAfterRestartEvents("restart-reuse").map((event) =>
      event.type === "m23_restart_checkpoint"
        ? { ...event, orderAttemptId: "m22a-new-attempt", reconcileRunId: "reconcile-new-snapshot" }
        : event));

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "restartEvidence")).toMatchObject({
      status: "fail",
      evidence: {
        beforeOrderAttemptId: "m22a-restart-reuse",
        afterOrderAttemptId: "m22a-new-attempt",
        beforeReconcileRunId: "reconcile-restart-reuse",
        afterReconcileRunId: "reconcile-new-snapshot",
      },
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

  it("counts documented reconcile_mismatch events as closeout failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-reconcile-event-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-reconcile-event"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-reconcile-event"),
      { type: "reconcile_mismatch", observedAt: "2026-06-13T00:00:10.000Z" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics.reconcileMismatchCount).toBe(1);
    expect(getCheck(summary, "closeoutZeroCounters")).toMatchObject({
      status: "fail",
    });
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

  it("fails when restart creates a new status summary instead of reusing the previous evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-status-reuse-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-status-reuse"));
    await writeEventLog(afterPath, validAfterRestartEvents("restart-status-reuse").map((event) =>
      event.type === "live_ops_status_summary"
        ? { ...event, statusSummaryId: "status-summary-new-after-restart" }
        : event));

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "statusRecovery")).toMatchObject({
      status: "fail",
      evidence: {
        beforeStatusSummaryId: "status-restart-status-reuse",
        afterStatusSummaryId: "status-summary-new-after-restart",
      },
    });
  });

  it("fails when any required fail-closed drill event has a bad result or missing alert evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-fail-closed-invalid-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-fail-closed-invalid"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-fail-closed-invalid"),
      { type: "fail_closed_drill", scenario: "api_error", result: "ENTRY_ALLOWED", alertEvidenceId: "api-error-unblocked" },
      { type: "fail_closed_drill", scenario: "stale_data", result: "NEW_ORDERS_BLOCKED" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(getCheck(summary, "failClosedDrills")).toMatchObject({
      status: "fail",
      evidence: {
        invalidDrillCount: 2,
        invalidDrills: [
          { scenario: "api_error", result: "ENTRY_ALLOWED", alertEvidenceId: "api-error-unblocked" },
          { scenario: "stale_data", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: null },
        ],
      },
    });
  });

  it("counts documented duplicate order and cancel failure events as closeout failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-order-cleanup-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-order-cleanup"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-order-cleanup"),
      { type: "duplicate_order", observedAt: "2026-06-13T00:00:10.000Z" },
      { type: "order_cancel_failed", observedAt: "2026-06-13T00:00:11.000Z" },
      { type: "order_cancel_unconfirmed", observedAt: "2026-06-13T00:00:12.000Z" },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics).toMatchObject({
      duplicateOrderCount: 1,
      liveOrderCleanupFailureCount: 2,
    });
    expect(getCheck(summary, "closeoutZeroCounters")).toMatchObject({
      status: "fail",
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

  it("counts legacy unhandledRejection flags as closeout failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-unhandled-flag-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-unhandled-flag"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-unhandled-flag"),
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:10.000Z", unhandledRejection: true },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics.unhandledRejectionCount).toBe(1);
    expect(getCheck(summary, "closeoutZeroCounters")).toMatchObject({
      status: "fail",
    });
  });

  it("counts legacy eventType and boolean failure flags as closeout failures", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-recovery-legacy-failures-"));
    const beforePath = path.join(artifactDir, "before.jsonl");
    const afterPath = path.join(artifactDir, "after.jsonl");
    await writeEventLog(beforePath, validBeforeRestartEvents("restart-legacy-failures"));
    await writeEventLog(afterPath, [
      ...validAfterRestartEvents("restart-legacy-failures"),
      { eventType: "crash", observedAt: "2026-06-13T00:00:10.000Z" },
      { eventType: "duplicate_order", observedAt: "2026-06-13T00:00:11.000Z" },
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:12.000Z", riskGateBypass: true },
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:13.000Z", untrackedFill: true },
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:14.000Z", crash: true },
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:15.000Z", reconcileMismatch: true },
      { type: "live_ops_event", observedAt: "2026-06-13T00:00:16.000Z", duplicateOrder: true },
    ]);

    const summary = await runScriptExpectingFailure(validArtifactArgs(artifactDir, beforePath, afterPath));

    expect(summary.metrics).toMatchObject({
      crashCount: 2,
      duplicateOrderCount: 2,
      reconcileMismatchCount: 1,
      riskGateBypassCount: 1,
      untrackedFillCount: 1,
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
    {
      type: "live_ops_status_summary",
      observedAt: "2026-06-13T00:00:01.500Z",
      statusSummaryId: `status-${restartId}`,
      mode: "live_order_capable",
      liveOrderCapable: true,
    },
    {
      type: "m23_restart_checkpoint",
      phase: "before_restart",
      restartId,
      orderAttemptId: `m22a-${restartId}`,
      reconcileRunId: `reconcile-${restartId}`,
    },
  ];
}

function validAfterRestartEvents(restartId: string): Record<string, unknown>[] {
  return [
    {
      type: "m23_restart_checkpoint",
      phase: "after_restart",
      restartId,
      orderAttemptId: `m22a-${restartId}`,
      reconcileRunId: `reconcile-${restartId}`,
    },
    { type: "live_ops_event", eventKind: "RUNTIME_RESTART_DETECTED", restartId },
    { type: "live_reconcile_completed", result: "SUCCESS", mismatchCount: 0, runId: `reconcile-${restartId}` },
    { type: "m22_pilot_heartbeat", observedAt: "2026-06-13T00:00:02.000Z" },
    { type: "live_ops_status_summary", statusSummaryId: `status-${restartId}`, mode: "live_order_capable", liveOrderCapable: true },
    { type: "live_ops_event", eventKind: "RUNTIME_RECOVERED", restartId },
    { type: "fail_closed_drill", scenario: "upbit_maintenance", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "upbit" },
    { type: "fail_closed_drill", scenario: "market_warning", result: "ENTRY_BLOCKED", alertEvidenceId: "market" },
    { type: "fail_closed_drill", scenario: "stale_data", result: "NEW_ORDERS_BLOCKED", alertEvidenceId: "stale" },
    { type: "fail_closed_drill", scenario: "api_error", result: "MANUAL_REVIEW_REQUIRED", alertEvidenceId: "api-error" },
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
    unhandledRejectionCount: number;
    reconcileMismatchCount: number;
    untrackedFillCount: number;
    liveOrderCleanupFailureCount: number;
    failClosedDrillCount: number;
    dailyReportGeneratedCount: number;
  };
  checks: Record<string, { status: string; evidence?: Record<string, unknown> }>;
}
