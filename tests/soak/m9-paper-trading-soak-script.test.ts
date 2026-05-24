import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m9-paper-trading-soak.mjs");
const compareScriptPath = path.join(process.cwd(), "scripts", "compare-m9-paper-reports.mjs");
const compileTempPrefix = "seemirai-m9-paper-trading-soak-compile-";

describe("M9 paper trading soak script", () => {
  it("runs deterministic paper trading cycles and emits comparable day summaries", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-trading-soak-"));
    const tempDirsBefore = await readCompileTempDirs();
    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--fixture-smoke",
      "--json",
      "--daily-report-generated",
      "--days",
      "3",
      "--cycles-per-day",
      "1",
      "--max-cycles",
      "3",
      "--cycle-interval-ms",
      "1",
      "--artifact-dir",
      artifactDir,
    ]);
    const tempDirsAfter = await readCompileTempDirs();

    const summary = JSON.parse(stdout) as {
      status: string;
      artifacts: {
        dailySummaryPaths: string[];
        reportPath: string;
        rawLogPath: string;
      };
      metrics: {
        paperTradingCycles: number;
        paperOrderSubmittedCount: number;
        paperFillCount: number;
        liveOrderApiCalls: number;
        costSummary: { evaluatedCount: number };
        slippageSummary: { observedFillCount: number };
      };
      checks: {
        paperTradingPath: { status: string };
        liveOrderApiCalls: { status: string };
        dailyReportGenerated: { status: string };
      };
    };

    expect(summary.status).toBe("passed");
    expect(summary.metrics).toMatchObject({
      paperTradingCycles: 3,
      paperOrderSubmittedCount: 3,
      paperFillCount: 3,
      liveOrderApiCalls: 0,
    });
    expect(summary.metrics.costSummary.evaluatedCount).toBe(9);
    expect(summary.metrics.slippageSummary.observedFillCount).toBe(3);
    expect(summary.checks.paperTradingPath.status).toBe("ok");
    expect(summary.checks.liveOrderApiCalls.status).toBe("ok");
    expect(summary.checks.dailyReportGenerated.status).toBe("ok");
    expect(summary.artifacts.dailySummaryPaths).toHaveLength(3);
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.rawLogPath)).resolves.toBeDefined();
    expect([...tempDirsAfter].filter((entry) => !tempDirsBefore.has(entry))).toEqual([]);

    const comparison = await execFileAsync("node", [
      compareScriptPath,
      "--summary",
      summary.artifacts.dailySummaryPaths[0]!,
      "--summary",
      summary.artifacts.dailySummaryPaths[1]!,
      "--summary",
      summary.artifacts.dailySummaryPaths[2]!,
      "--output",
      path.join(artifactDir, "m9-3day-comparison.md"),
      "--json",
    ]);
    const comparisonSummary = JSON.parse(comparison.stdout) as { status: string; inputCount: number };
    expect(comparisonSummary).toMatchObject({
      status: "passed",
      inputCount: 3,
    });
  }, 40_000);

  it("does not start the 3-day runner without the explicit safety env", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-trading-soak-guard-"));
    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--json",
      "--duration-ms",
      "1000",
      "--artifact-dir",
      artifactDir,
    ]);
    const summary = JSON.parse(stdout) as {
      status: string;
      artifacts: { summaryPath: string };
      checks: { longRunGuard: { status: string } };
    };

    expect(summary.status).toBe("skipped");
    expect(summary.checks.longRunGuard.status).toBe("skipped");
    await expect(readFile(summary.artifacts.summaryPath, "utf8")).resolves.toContain(
      "SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1",
    );
  });
});

async function readCompileTempDirs() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(compileTempPrefix))
      .map((entry) => entry.name),
  );
}
