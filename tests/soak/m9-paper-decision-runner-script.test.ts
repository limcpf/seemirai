import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m9-paper-decision-runner.mjs");
const compileTempPrefix = "seemirai-m9-paper-decision-compile-";

describe("M9 paper decision runner script", () => {
  it("writes summary, report, and trace to separately created artifact directories", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-decision-script-"));
    const summaryPath = path.join(workDir, "summary", "summary.json");
    const reportPath = path.join(workDir, "report", "report.md");
    const rawLogPath = path.join(workDir, "trace", "trace.jsonl");
    const tempDirsBefore = await readCompileTempDirs();
    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--fixture-smoke",
      "--json",
      "--daily-report-generated",
      "--summary-path",
      summaryPath,
      "--report-path",
      reportPath,
      "--raw-log-path",
      rawLogPath,
    ]);
    const tempDirsAfter = await readCompileTempDirs();

    const summary = JSON.parse(stdout) as {
      status: string;
      metrics: {
        paperOrderSubmittedCount: number;
        paperFillCount: number;
        liveOrderApiCalls: number;
        pnlSummary: {
          totalPnlKrw: string | null;
          totalFeesKrw: string;
          submittedOrderCount: number;
          filledOrderCount: number;
        };
      };
      checks: {
        zeroOrderReasonsExplained: { status: string };
        liveOrderApiCalls: { status: string; evidence: { count: number } };
        auditMissing: { status: string; evidence: { traceRecords: number } };
      };
    };
    const persistedSummary = JSON.parse(await readFile(summaryPath, "utf8")) as typeof summary;
    const trace = await readFile(rawLogPath, "utf8");
    const report = await readFile(reportPath, "utf8");

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      paperOrderSubmittedCount: 1,
      paperFillCount: 1,
      liveOrderApiCalls: 0,
      pnlSummary: {
        totalPnlKrw: "-6",
        totalFeesKrw: "5",
        submittedOrderCount: 1,
        filledOrderCount: 1,
      },
    });
    expect(summary.checks.zeroOrderReasonsExplained.status).toBe("ok");
    expect(summary.checks.liveOrderApiCalls).toMatchObject({
      status: "ok",
      evidence: { count: 0 },
    });
    expect(summary.checks.auditMissing.evidence.traceRecords).toBeGreaterThan(0);
    expect(persistedSummary.status).toBe("passed");
    expect(trace.trim().split("\n").length).toBeGreaterThan(0);
    await expect(stat(reportPath)).resolves.toBeDefined();
    expect(report).toContain("## KRW 손익 요약");
    expect(report).toContain("| 총 손익 | -6 KRW |");
    expect(report).toContain("| 수수료 | 5 KRW |");
    expect([...tempDirsAfter].filter((entry) => !tempDirsBefore.has(entry))).toEqual([]);
  }, 30_000);

  it("fails controlled smoke when no zero-order frame is present", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-decision-script-"));
    const fixture = JSON.parse(
      await readFile(path.join(process.cwd(), "tests", "fixtures", "m9", "paper-decision-runner.json"), "utf8"),
    );
    fixture.frames = [fixture.frames[3]];
    const fixturePath = path.join(workDir, "all-submitted-fixture.json");
    const summaryPath = path.join(workDir, "summary.json");
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const summary = await runScriptExpectingFailure([
      "--fixture-smoke",
      "--json",
      "--fixture",
      fixturePath,
      "--summary-path",
      summaryPath,
    ]);

    expect(summary.status).toBe("failed");
    expect(summary.checks.zeroOrderReasonsExplained).toMatchObject({
      status: "fail",
      evidence: { zeroOrderFrameCount: 0 },
    });
  }, 30_000);

  it("explains duplicate-suppressed execution frames as zero-order reasons", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-decision-duplicate-"));
    const fixture = JSON.parse(
      await readFile(path.join(process.cwd(), "tests", "fixtures", "m9", "paper-decision-runner.json"), "utf8"),
    );
    const submittedFrame = fixture.frames[3];
    fixture.frames = [
      submittedFrame,
      {
        ...submittedFrame,
        id: "frame-submit-and-fill-duplicate",
        observedAt: "2026-05-22T00:00:00.400Z",
      },
    ];
    const fixturePath = path.join(workDir, "duplicate-suppressed-fixture.json");
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--fixture-smoke",
      "--json",
      "--fixture",
      fixturePath,
      "--artifact-dir",
      workDir,
    ]);
    const summary = JSON.parse(stdout) as {
      status: string;
      checks: {
        zeroOrderReasonsExplained: {
          status: string;
          evidence: {
            zeroOrderFrameCount: number;
            reasonCounts: Record<string, number>;
          };
        };
      };
    };

    expect(summary.status).toBe("passed");
    expect(summary.checks.zeroOrderReasonsExplained).toMatchObject({
      status: "ok",
      evidence: {
        zeroOrderFrameCount: 1,
      },
    });
    expect(Object.keys(summary.checks.zeroOrderReasonsExplained.evidence.reasonCounts)).toContain(
      "discard:duplicate_broker_order",
    );
  }, 30_000);

  it("writes a failed summary and raw fatal log when setup throws", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-decision-fatal-"));
    const summary = await runScriptExpectingFatalSummary([
      "--fixture-smoke",
      "--json",
      "--fixture",
      path.join(workDir, "missing-fixture.json"),
      "--artifact-dir",
      workDir,
    ]);
    const rawLog = await readFile(summary.artifacts.rawLogPath, "utf8");

    expect(summary.status).toBe("failed");
    expect(summary.checks.fatalError.status).toBe("fail");
    expect(rawLog).toContain("RUNNER_FATAL");
  }, 30_000);
});

async function readCompileTempDirs() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(compileTempPrefix))
      .map((entry) => entry.name),
  );
}

async function runScriptExpectingFailure(args: readonly string[]) {
  try {
    await execFileAsync("node", [scriptPath, ...args]);
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as {
      status: string;
      checks: {
        zeroOrderReasonsExplained: {
          status: string;
          evidence: {
            zeroOrderFrameCount: number;
          };
        };
      };
    };
  }

  throw new Error("script unexpectedly passed");
}

async function runScriptExpectingFatalSummary(args: readonly string[]) {
  try {
    await execFileAsync("node", [scriptPath, ...args]);
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as {
      status: string;
      artifacts: { rawLogPath: string };
      checks: { fatalError: { status: string } };
    };
  }

  throw new Error("script unexpectedly passed");
}
