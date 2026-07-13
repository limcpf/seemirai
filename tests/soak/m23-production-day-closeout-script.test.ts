import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repositoryRoot, "scripts", "run-m23-production-day-closeout.mjs");
const validatorPath = path.join(repositoryRoot, "scripts", "run-m23-stability-closeout.mjs");
const runtimeProvenance = {
  sourceCommitSha: "a".repeat(40),
  configFingerprint: `sha256:${"b".repeat(64)}`,
  envFingerprint: `sha256:${"c".repeat(64)}`,
  expectedMigrationVersion: 14,
  appliedMigrationVersion: 14,
};

describe("M23 production day closeout script", () => {
  it("KST day를 정확한 UTC half-open window로 변환한다", async () => {
    const output = await runModuleExpression(`
      const valid = module.createKstDayWindow("2026-07-15");
      let invalidError;
      try { module.createKstDayWindow("2026-02-30"); } catch (error) { invalidError = error.message; }
      process.stdout.write(JSON.stringify({ valid, invalidError }));
    `);
    expect(output.valid).toMatchObject({
      day: "2026-07-15",
      startedAt: "2026-07-14T15:00:00.000Z",
      finishedAt: "2026-07-15T15:00:00.000Z",
    });
    expect(output.invalidError).toContain("유효한 달력 날짜");
  });

  it("알 수 없는 CLI 인자와 값 누락을 fail-fast 한다", async () => {
    const output = await runModuleExpression(`
      const errors = [];
      for (const args of [["--unknown"], ["--day"]]) {
        try { module.parseProductionDayCloseoutArgs(args); } catch (error) { errors.push(error.message); }
      }
      process.stdout.write(JSON.stringify(errors));
    `) as string[];
    expect(output[0]).toContain("알 수 없는 인자");
    expect(output[1]).toContain("--day 값이 필요");
  });

  it("fixture summary가 actual validator의 production segment contract를 만족한다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-days-"));
    const segmentDays = Array.from({ length: 7 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
    const segments = [];

    for (const day of segmentDays) {
      const dayWindow = createTestKstDayWindow(day);
      const generatedAt = new Date(dayWindow.endMs + 5_000).toISOString();
      await execFileAsync(
        process.execPath,
        [scriptPath, "--fixture-smoke", "--day", day, "--artifact-dir", artifactDir, "--json"],
        {
          cwd: repositoryRoot,
          env: process.env,
        },
      );
      const summaryPath = path.join(artifactDir, `production-day-${day}.json`);
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
        finishedAt: string;
        dailyReportGeneratedAt: string;
        decisionEvidenceGeneratedAt: string;
        evidenceIds: {
          decisionEvidenceId: string;
          dailyReportEvidenceId: string;
          alertEvidenceIds: string[];
        };
      };
      // fixture CLI clock은 고정돼 있으므로 validator day 종료 조건을 각 segment의 실제 종료 이후 시각으로 맞춘다.
      summary.finishedAt = generatedAt;
      summary.dailyReportGeneratedAt = generatedAt;
      summary.decisionEvidenceGeneratedAt = generatedAt;
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      segments.push({
        day,
        summaryPath: path.basename(summaryPath),
        decisionEvidenceId: summary.evidenceIds.decisionEvidenceId,
        decisionEvidenceDay: day,
        dailyReportEvidenceId: summary.evidenceIds.dailyReportEvidenceId,
        alertEvidenceIds: summary.evidenceIds.alertEvidenceIds,
        runtimeProvenance,
      });
    }

    const startupPath = path.join(artifactDir, "startup.json");
    await writeFile(startupPath, `${JSON.stringify({
      kind: "live_ops_daemon_startup",
      status: "ready",
      startedAt: "2026-06-30T14:00:00.000Z",
      runtimeProvenance,
    }, null, 2)}\n`, "utf8");
    const recoveryPath = path.join(artifactDir, "recovery.json");
    await writeFile(recoveryPath, `${JSON.stringify(createRecoverySummary(), null, 2)}\n`, "utf8");
    const manifestPath = path.join(artifactDir, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({
      issue: 267,
      mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
      startupArtifactPath: path.basename(startupPath),
      runtimeProvenance,
      liveArmedEvidenceId: "production-live-armed-evidence",
      keyScopeEvidenceId: "production-key-scope-evidence",
      operatorArmEvidenceId: "production-operator-arm-evidence",
      budgetEvidenceId: "production-budget-evidence",
      segments,
      recoveryDrillSummaryPath: path.basename(recoveryPath),
      backupRestore: { status: "passed", evidenceId: "production-db-backup-restore-evidence" },
      sourceScan: {
        evidenceId: "production-source-scan-evidence",
        liveOrderApiGuarded: true,
        marketBestOrderDefaultOpened: false,
        withdrawalOrDepositPathOpened: false,
        rawSecretExposure: false,
      },
    }, null, 2)}\n`, "utf8");

    const validator = await execFileAsync(
      process.execPath,
      [validatorPath, "--manifest", manifestPath, "--artifact-dir", artifactDir, "--json"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT: "1" },
      },
    );
    const summary = JSON.parse(validator.stdout) as { status: string; checks: Record<string, { status: string }> };
    expect(summary.status).toBe("passed");
    expect(summary.checks.segmentDuration?.status).toBe("ok");
    expect(summary.checks.segmentCompleteness?.status).toBe("ok");
  });

  it("fixture artifact는 create-only이고 운영 계정 전용 mode로 기록된다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-create-only-"));
    const args = [scriptPath, "--fixture-smoke", "--day", "2026-07-01", "--artifact-dir", artifactDir, "--json"];
    await execFileAsync(process.execPath, args, { cwd: repositoryRoot, env: process.env });
    await expect(execFileAsync(process.execPath, args, { cwd: repositoryRoot, env: process.env })).rejects.toMatchObject({ code: 1 });
    const fileStat = await stat(path.join(artifactDir, "production-day-2026-07-01.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("actual mode는 명시 guard 없이 provider 경계를 열지 않는다", async () => {
    await expect(execFileAsync(
      process.execPath,
      [scriptPath, "--day", "2026-07-01"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT: "0" },
      },
    )).rejects.toMatchObject({ code: 1 });
  });
});

async function runModuleExpression(expression: string): Promise<any> {
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(scriptPath)}); ${expression}`,
    ],
    { cwd: repositoryRoot, env: process.env },
  );
  return JSON.parse(result.stdout);
}

function createTestKstDayWindow(day: string) {
  const endMs = Date.parse(`${day}T00:00:00.000Z`) - (9 * 60 * 60 * 1_000) + 86_400_000;
  return { endMs };
}

function createRecoverySummary() {
  const checks = [
    "eventLogsParsed",
    "restartEvidence",
    "heartbeatRecovery",
    "duplicateLiveOrder",
    "reconcileRecovery",
    "statusRecovery",
    "dailyReportRecovery",
    "failClosedDrills",
    "backupRestore",
    "closeoutZeroCounters",
    "secretScan",
  ];
  return {
    status: "passed",
    input: "recovery_artifacts",
    checks: Object.fromEntries(checks.map((check) => [check, { status: "ok" }])),
  };
}
