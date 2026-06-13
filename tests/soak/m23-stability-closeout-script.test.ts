import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m23-stability-closeout.mjs");
const oneDayMs = 86_400_000;

describe("M23 stability closeout script", () => {
  it("skips actual closeout validation unless the explicit M23 guard is enabled", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-skip-"));
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir], {
      SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT: "0",
    });
    const summary = JSON.parse(stdout) as M23StabilityCloseoutSummary;

    expect(summary.status).toBe("skipped");
    expect(getCheck(summary, "runGuard")).toMatchObject({
      status: "skipped",
      evidence: { requiredEnv: "SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT=1" },
    });
  });

  it("runs deterministic fixture smoke without live side effects", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-fixture-"));
    const { stdout } = await runScript(["--fixture-smoke", "--json", "--artifact-dir", artifactDir]);
    const summary = JSON.parse(stdout) as M23StabilityCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(summary.metrics.segmentCount).toBe(7);
    expect(getCheck(summary, "segmentCompleteness").status).toBe("ok");
    expect(getCheck(summary, "sourceScan").status).toBe("ok");
  });

  it("passes a complete seven day closeout manifest", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-pass-"));
    const manifestPath = await writeCloseoutFixture(artifactDir);
    const { stdout } = await runScript(["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath], createReadyEnv());
    const summary = JSON.parse(stdout) as M23StabilityCloseoutSummary;

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      segmentCount: 7,
      dailyReportGeneratedCount: 7,
    });
    expect(getCheck(summary, "recoveryDrill").status).toBe("ok");
    expect(getCheck(summary, "backupRestore").status).toBe("ok");
  });

  it("fails when the manifest has fewer than seven unique day segments", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-short-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, { segmentCount: 6 });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentCompleteness")).toMatchObject({
      status: "fail",
      evidence: { requiredSegmentCount: 7 },
    });
  });

  it("fails when seven manifest days reuse the same summary artifact", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-duplicate-summary-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, { duplicateSummaryPath: true });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentCompleteness")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when seven manifest days reuse one summary through normalized path variants", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-normalized-summary-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, { normalizedDuplicateSummaryPath: true });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentCompleteness")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when segment days are not consecutive", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-nonconsecutive-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      dayMutator: (day, index) => index === 3 ? "2026-07-01" : day,
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentCompleteness")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when source scan evidence records a newly opened unsafe boundary", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-source-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      sourceScan: { marketBestOrderDefaultOpened: true },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "sourceScan")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when any segment has a non-zero closeout failure counter", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-counter-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => {
        if (index !== 2) {
          return summary;
        }

        const metrics = summary.metrics as Record<string, unknown>;
        return { ...summary, metrics: { ...metrics, crashCount: 1 } };
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentZeroCounters")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when alert evidence is missing from a segment", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-alert-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentManifestMutator: (segment, index) => index === 5 ? { ...segment, alertEvidenceIds: [] } : segment,
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "decisionEvidence")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when a segment observed duration is shorter than 24 hours", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-duration-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => {
        if (index !== 1) {
          return summary;
        }

        const metrics = summary.metrics as Record<string, unknown>;
        const pilotProcess = metrics.pilotProcess as Record<string, unknown>;
        return { ...summary, metrics: { ...metrics, pilotProcess: { ...pilotProcess, durationMsObserved: 600_000 } } };
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentDuration")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when a segment is not a live autonomous M23 execution", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-mode-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => index === 4
        ? { ...summary, input: "fixture_smoke", mode: "PAPER_NO_KEY" }
        : summary,
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentLiveArmedGuards")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when a segment does not provide explicit M23 mode evidence", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-missing-mode-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => {
        if (index !== 2) {
          return summary;
        }

        const clone = { ...summary };
        delete clone.mode;
        return clone;
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentLiveArmedGuards")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when open position notional guard evidence is missing", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-open-exposure-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => {
        if (index !== 3) {
          return summary;
        }

        const checks = summary.checks as Record<string, Record<string, unknown>>;
        const configSafety = checks.configSafety as Record<string, unknown>;
        const evidence = configSafety.evidence as Record<string, unknown>;
        return {
          ...summary,
          checks: {
            ...checks,
            configSafety: {
              ...configSafety,
              evidence: { ...evidence, maxOpenPositionNotionalKrw: "90000" },
            },
          },
        };
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentLiveArmedGuards")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when operational env evidence is missing from a segment", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-operational-env-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      segmentMutator: (summary, index) => {
        if (index !== 6) {
          return summary;
        }

        const checks = summary.checks as Record<string, unknown>;
        return { ...summary, checks: { ...checks, operationalEnv: { status: "fail" } } };
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "segmentLiveArmedGuards")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when the closeout manifest contains raw secret fields", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-secret-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      manifestPatch: {
        authorization: "Bearer raw-token-value",
        jwt: "raw-jwt-value",
        rawProviderPayload: { status: "raw" },
        upbit_access_key: "raw-access-key-value",
        upbit_secret_key: "raw-secret-key-value",
      },
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "secretScan")).toMatchObject({
      status: "fail",
    });
  });

  it("fails when recovery drill summary is fixture input instead of guarded artifact input", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-stability-recovery-fixture-"));
    const manifestPath = await writeCloseoutFixture(artifactDir, {
      recoveryMutator: (summary) => ({ ...summary, input: "fixture_smoke" }),
    });
    const summary = await runScriptExpectingFailure(
      ["--json", "--artifact-dir", artifactDir, "--manifest", manifestPath],
      createReadyEnv(),
    );

    expect(summary.status).toBe("failed");
    expect(getCheck(summary, "recoveryDrill")).toMatchObject({
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

async function runScriptExpectingFailure(args: readonly string[], env: Record<string, string>) {
  try {
    await runScript(args, env);
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as M23StabilityCloseoutSummary;
  }

  throw new Error("script unexpectedly passed");
}

function createReadyEnv(): Record<string, string> {
  return {
    SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT: "1",
  };
}

async function writeCloseoutFixture(
  artifactDir: string,
  options: {
    segmentCount?: number;
    sourceScan?: Partial<Record<string, unknown>>;
    manifestPatch?: Partial<Record<string, unknown>>;
    segmentMutator?: (summary: Record<string, unknown>, index: number) => Record<string, unknown>;
    segmentManifestMutator?: (segment: Record<string, unknown>, index: number) => Record<string, unknown>;
    recoveryMutator?: (summary: Record<string, unknown>) => Record<string, unknown>;
    duplicateSummaryPath?: boolean;
    normalizedDuplicateSummaryPath?: boolean;
    dayMutator?: (day: string, index: number) => string;
  } = {},
) {
  const segmentCount = options.segmentCount ?? 7;
  const recoveryPath = path.join(artifactDir, "recovery-summary.json");
  await mkdir(path.join(artifactDir, "nested", "sub"), { recursive: true });
  const normalizedDuplicatePaths = [
    "segment-1-summary.json",
    "./segment-1-summary.json",
    "nested/../segment-1-summary.json",
    "./nested/../segment-1-summary.json",
    "nested/./../segment-1-summary.json",
    "nested/sub/../../segment-1-summary.json",
    "./nested/sub/../../segment-1-summary.json",
  ];
  const segments: Record<string, unknown>[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const summaryPath = path.join(artifactDir, `segment-${index + 1}-summary.json`);
    const segmentSummary = options.segmentMutator?.(createSegmentSummary(index), index) ?? createSegmentSummary(index);
    await writeFile(summaryPath, `${JSON.stringify(segmentSummary, null, 2)}\n`, "utf8");
    const defaultDay = `2026-06-${String(13 + index).padStart(2, "0")}`;
    const segment = {
      day: options.dayMutator?.(defaultDay, index) ?? defaultDay,
      summaryPath: options.normalizedDuplicateSummaryPath
        ? (normalizedDuplicatePaths[index] ?? "segment-1-summary.json")
        : options.duplicateSummaryPath
          ? "segment-1-summary.json"
          : path.basename(summaryPath),
      decisionEvidenceId: `decision-evidence-${index + 1}`,
      dailyReportEvidenceId: `daily-report-${index + 1}`,
      alertEvidenceIds: [`alert-evidence-${index + 1}`],
    };
    segments.push(options.segmentManifestMutator?.(segment, index) ?? segment);
  }

  const recoverySummary = options.recoveryMutator?.(createRecoverySummary()) ?? createRecoverySummary();
  await writeFile(recoveryPath, `${JSON.stringify(recoverySummary, null, 2)}\n`, "utf8");
  const manifest = {
    issue: 188,
    mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    liveArmedEvidenceId: "live-armed-evidence",
    keyScopeEvidenceId: "key-scope-evidence",
    operatorArmEvidenceId: "operator-arm-evidence",
    budgetEvidenceId: "budget-evidence",
    segments,
    recoveryDrillSummaryPath: path.basename(recoveryPath),
    backupRestore: {
      status: "blocked",
      evidenceId: "db-restore-blocker",
      blockerReason: "disposable restore DB is not provisioned",
      requiredOperatorAction: "prepare disposable restore DB",
      retryPlanEvidenceId: "db-restore-retry-plan",
    },
    sourceScan: {
      evidenceId: "source-scan-evidence",
      liveOrderApiGuarded: true,
      marketBestOrderDefaultOpened: false,
      withdrawalOrDepositPathOpened: false,
      rawSecretExposure: false,
      ...options.sourceScan,
    },
    ...options.manifestPatch,
  };
  const manifestPath = path.join(artifactDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function createSegmentSummary(index: number): Record<string, unknown> {
  return {
    status: "passed",
    input: "live_autonomous_command",
    mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    metrics: {
      heartbeatCount: 1440 + index,
      orderSubmittedCount: index === 0 ? 1 : 0,
      brokerSubmissionCount: index === 0 ? 1 : 0,
      dailyReportGeneratedCount: 1,
      crashCount: 0,
      unhandledRejectionCount: 0,
      riskGateBypassCount: 0,
      reconcileMismatchCount: 0,
      duplicateOrderCount: 0,
      untrackedFillCount: 0,
      liveOrderCleanupFailureCount: 0,
      pilotProcess: {
        durationMsRequested: oneDayMs,
        durationMsObserved: oneDayMs + 10,
        ranFullDuration: true,
      },
    },
    checks: {
      configSafety: {
        status: "ok",
        evidence: {
          enabled: true,
          allowedMarkets: ["KRW-BTC"],
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          maxOpenPositionNotionalKrw: "30000",
        },
      },
      evidenceEnv: { status: "ok" },
      pilotProfileEnv: { status: "ok" },
      operationalEnv: { status: "ok" },
      readinessEnv: { status: "ok" },
    },
  };
}

function createRecoverySummary(): Record<string, unknown> {
  const required = [
    "restartEvidence",
    "duplicateLiveOrder",
    "reconcileRecovery",
    "statusRecovery",
    "dailyReportRecovery",
    "failClosedDrills",
    "backupRestore",
    "secretScan",
  ];
  return {
    status: "passed",
    input: "recovery_artifacts",
    checks: Object.fromEntries(required.map((checkName) => [checkName, { status: "ok" }])),
  };
}

function getCheck(summary: M23StabilityCloseoutSummary, name: string): { status: string; evidence?: Record<string, unknown> } {
  const check = summary.checks[name];
  if (check === undefined) {
    throw new Error(`missing check: ${name}`);
  }
  return check;
}

interface M23StabilityCloseoutSummary {
  status: string;
  input: string;
  metrics: {
    segmentCount: number;
    dailyReportGeneratedCount: number;
  };
  checks: Record<string, { status: string; evidence?: Record<string, unknown> }>;
}
