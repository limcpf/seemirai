import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m9-paper-decision-runner.mjs");
const compileTempPrefix = "seemirai-m9-paper-decision-";

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
      };
      checks: {
        zeroOrderReasonsExplained: { status: string };
        liveOrderApiCalls: { status: string; evidence: { count: number } };
        auditMissing: { status: string; evidence: { traceRecords: number } };
      };
    };
    const persistedSummary = JSON.parse(await readFile(summaryPath, "utf8")) as typeof summary;
    const trace = await readFile(rawLogPath, "utf8");

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      paperOrderSubmittedCount: 1,
      paperFillCount: 1,
      liveOrderApiCalls: 0,
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
    expect([...tempDirsAfter].filter((entry) => !tempDirsBefore.has(entry))).toEqual([]);
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
