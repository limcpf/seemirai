import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "validate-m9-paper-soak-evidence.mjs");

describe("M9 paper soak evidence validator", () => {
  it("passes complete #68 evidence and renders an issue comment without writing artifacts", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-evidence-passed-"));
    const prefix = "m9-paper-trading-soak-2026-05-26T07-00-00-000Z-aabbccdd";
    await writeCompleteRunArtifacts({ artifactDir, prefix });
    const before = await snapshotDirectory(artifactDir);

    const { stdout } = await execFileAsync("node", [scriptPath, "--artifact-dir", artifactDir, "--json"]);
    const after = await snapshotDirectory(artifactDir);
    const validation = JSON.parse(stdout) as {
      statusCode: string;
      statusLabel: string;
      issueComment: string;
      checks: Array<{ id: string; status: string }>;
      artifacts: { comparisonReportPath: string };
    };
    const issueComment = await execFileAsync("node", [scriptPath, "--artifact-dir", artifactDir, "--issue-comment"]);

    expect(after).toEqual(before);
    expect(validation.statusCode).toBe("passed");
    expect(validation.statusLabel).toBe("통과");
    expect(validation.checks.every((check) => check.status === "passed")).toBe(true);
    expect(validation.artifacts.comparisonReportPath).toBe(path.join(artifactDir, "m9-3day-trading-soak-comparison.md"));
    expect(validation.issueComment).toContain("#68 M9 paper trading 관측 증거 검증");
    expect(issueComment.stdout).toContain("판정: 통과");
    expect(issueComment.stdout).toContain("live order API 호출");
  });

  it("returns incomplete while the latest run only has a raw log", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-evidence-running-"));
    const prefix = "m9-paper-trading-soak-2026-05-26T08-00-00-000Z-bbccddee";
    await writeFile(
      path.join(artifactDir, `${prefix}-events.jsonl`),
      `${JSON.stringify({ kind: "MARKET_DATA", receivedAt: "2026-05-26T08:00:01.000Z" })}\n`,
      "utf8",
    );

    const result = await runScriptAllowingFailure(["--artifact-dir", artifactDir, "--json"]);
    const validation = JSON.parse(result.stdout) as {
      statusCode: string;
      action: string;
      checks: Array<{ id: string; status: string }>;
    };

    expect(result.code).toBe(2);
    expect(validation.statusCode).toBe("incomplete");
    expect(validation.action).toContain("다시 실행");
    expect(validation.checks.find((check) => check.id === "aggregateSummary")?.status).toBe("incomplete");
  });

  it("fails completed evidence when live order calls or comparison report evidence are missing", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-evidence-failed-"));
    const prefix = "m9-paper-trading-soak-2026-05-26T09-00-00-000Z-ccddeeff";
    await writeCompleteRunArtifacts({
      artifactDir,
      prefix,
      writeComparisonReport: false,
      dayOverrides: {
        2: {
          metrics: {
            liveOrderApiCalls: 1,
          },
        },
      },
    });

    const result = await runScriptAllowingFailure(["--artifact-dir", artifactDir, "--json"]);
    const validation = JSON.parse(result.stdout) as {
      statusCode: string;
      checks: Array<{ id: string; status: string; message: string }>;
    };

    expect(result.code).toBe(1);
    expect(validation.statusCode).toBe("failed");
    expect(validation.checks.find((check) => check.id === "liveOrderApiCalls")).toMatchObject({
      status: "failed",
    });
    expect(validation.checks.find((check) => check.id === "comparisonReport")).toMatchObject({
      status: "failed",
    });
  });

  it("returns structured incomplete status for invalid artifact directories", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-evidence-invalid-"));
    const notDirectoryPath = path.join(artifactDir, "artifact-file");
    await writeFile(notDirectoryPath, "not a directory", "utf8");

    const result = await runScriptAllowingFailure(["--artifact-dir", notDirectoryPath, "--json"]);
    const validation = JSON.parse(result.stdout) as {
      statusCode: string;
      checks: Array<{ id: string; status: string; trace: { reason: string; detail: string } }>;
    };

    expect(result.code).toBe(2);
    expect(validation.statusCode).toBe("incomplete");
    expect(validation.checks[0]).toMatchObject({
      id: "artifactDirectory",
      status: "incomplete",
      trace: {
        reason: "artifact_dir_unreadable",
      },
    });
    expect(validation.checks[0]?.trace.detail).toContain("ENOTDIR");
  });
});

async function runScriptAllowingFailure(args: string[]) {
  try {
    const { stdout } = await execFileAsync("node", [scriptPath, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    return { code: executionError.code ?? 1, stdout: executionError.stdout ?? "" };
  }
}

async function writeCompleteRunArtifacts({
  artifactDir,
  prefix,
  writeComparisonReport = true,
  dayOverrides = {},
}: {
  artifactDir: string;
  prefix: string;
  writeComparisonReport?: boolean;
  dayOverrides?: Record<number, Record<string, unknown>>;
}) {
  const rawLogPath = path.join(artifactDir, `${prefix}-events.jsonl`);
  const summaryPath = path.join(artifactDir, `${prefix}-summary.json`);
  const reportPath = path.join(artifactDir, `${prefix}-report.md`);
  const dailySummaryPaths = [1, 2, 3].map((day) => path.join(artifactDir, `${prefix}-day-${day}-summary.json`));
  const dailyReportPaths = [1, 2, 3].map((day) => path.join(artifactDir, `${prefix}-day-${day}-report.md`));

  await writeFile(rawLogPath, `${JSON.stringify({ kind: "RUNNER_COMPLETED", occurredAt: "2026-05-26T10:00:00.000Z" })}\n`, "utf8");
  await writeFile(reportPath, "# aggregate report\n", "utf8");
  await Promise.all(dailyReportPaths.map((dailyReportPath, index) => writeFile(dailyReportPath, `# day ${index + 1} report\n`, "utf8")));

  for (const [index, dailySummaryPath] of dailySummaryPaths.entries()) {
    const day = index + 1;
    const override = dayOverrides[day] ?? {};
    await writeFile(
      dailySummaryPath,
      JSON.stringify(
        deepMerge(
          createSummary({
            runId: `run:day-${day}`,
            summaryPath: dailySummaryPath,
            reportPath: dailyReportPaths[index]!,
            rawLogPath,
            startedAt: `2026-05-${25 + day}T00:00:00.000Z`,
            finishedAt: `2026-05-${25 + day}T01:00:00.000Z`,
          }),
          override,
        ),
        null,
        2,
      ),
      "utf8",
    );
  }

  await writeFile(
    summaryPath,
    JSON.stringify(
      createSummary({
        runId: "run",
        summaryPath,
        reportPath,
        rawLogPath,
        dailySummaryPaths,
        startedAt: "2026-05-26T00:00:00.000Z",
        finishedAt: "2026-05-29T00:00:00.000Z",
        durationMsObserved: 259_200_000,
      }),
      null,
      2,
    ),
    "utf8",
  );

  if (writeComparisonReport) {
    await writeFile(
      path.join(artifactDir, "m9-3day-trading-soak-comparison.md"),
      "# M9 3일 Paper Report 비교\n\n- 비교 상태: passed\n",
      "utf8",
    );
  }
}

function createSummary({
  runId,
  summaryPath,
  reportPath,
  rawLogPath,
  dailySummaryPaths,
  startedAt,
  finishedAt,
  durationMsObserved = 3_600_000,
}: {
  runId: string;
  summaryPath: string;
  reportPath: string;
  rawLogPath: string;
  dailySummaryPaths?: string[];
  startedAt: string;
  finishedAt: string;
  durationMsObserved?: number;
}) {
  return {
    schemaVersion: 1,
    runId,
    status: "passed",
    startedAt,
    finishedAt,
    durationMsRequested: durationMsObserved,
    durationMsObserved,
    mode: "PAPER_TRADING",
    artifacts: {
      rawLogPath,
      summaryPath,
      reportPath,
      dailySummaryPaths,
    },
    metrics: {
      holdReasonCounts: {},
      discardReasonCounts: { strategy_hold: 1 },
      blockingReasonCounts: { risk_rejected: 1 },
      paperOrderSubmittedCount: 3,
      paperFillCount: 3,
      liveOrderApiCalls: 0,
      fillRate: 1,
      costSummary: {
        evaluatedCount: 3,
        allowedCount: 3,
        rejectedCount: 0,
        averageCostBps: 12,
      },
      slippageSummary: {
        observedFillCount: 3,
        averageSlippageBps: 2,
      },
    },
    checks: {
      liveOrderApiCalls: {
        status: "ok",
        message: "PaperBroker만 사용했고 live order API 호출이 없다.",
        evidence: { count: 0 },
      },
      dailyReportGenerated: {
        status: "ok",
        message: "운영자가 이 paper trading soak summary를 daily report artifact와 연결했다.",
        evidence: { generated: true },
      },
      runtimeExceptions: {
        status: "ok",
        message: "runtime exception이 관측되지 않았다.",
        evidence: { crashCount: 0, unhandledRejectionCount: 0 },
      },
    },
  };
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = output[key];
    if (isRecord(current) && isRecord(value)) {
      output[key] = deepMerge(current, value);
      continue;
    }
    output[key] = value;
  }
  return output as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function snapshotDirectory(directory: string) {
  const entries = await readdir(directory);
  const snapshot: Record<string, { size: number; mtimeMs: number }> = {};
  for (const entry of entries.sort()) {
    const fileStat = await stat(path.join(directory, entry));
    snapshot[entry] = {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }
  return snapshot;
}
