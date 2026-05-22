import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "compare-m9-paper-reports.mjs");

describe("M9 paper report comparison script", () => {
  it("renders a 3-day comparison from soak summary JSON artifacts", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-compare-"));
    const summaries = await writeSummaries(workDir, [createSummary(3), createSummary(1), createSummary(2)]);
    const outputPath = path.join(workDir, "comparison.md");

    const { stdout } = await runCompare([
      "--summary",
      summaries[0]!,
      "--summary",
      summaries[1]!,
      "--summary",
      summaries[2]!,
      "--output",
      outputPath,
      "--json",
    ]);
    const comparison = JSON.parse(stdout) as ComparisonSummary;
    const markdown = await readFile(outputPath, "utf8");

    expect(comparison.status).toBe("passed");
    expect(comparison.rows).toHaveLength(3);
    expect(comparison.rows.map((row) => row.date)).toEqual(["2026-05-20", "2026-05-21", "2026-05-22"]);
    expect(comparison.rows[0]).toMatchObject({
      day: "Day 1",
      liveOrderApiCalls: 0,
      dailyReportGenerated: true,
    });
    expect(markdown).toContain("M9 3일 Paper Report 비교");
    expect(markdown).toContain("Day 3");
    expect(markdown).toContain("report-day-1.md");
    await expect(stat(outputPath)).resolves.toBeDefined();
  });

  it("fails when fewer than 3 summaries are provided", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-compare-"));
    const summaries = await writeSummaries(workDir, [createSummary(1), createSummary(2)]);

    const { stdout } = await runCompareExpectFailure(["--summary", summaries[0]!, "--summary", summaries[1]!, "--json"]);
    const comparison = JSON.parse(stdout) as ComparisonSummary;

    expect(comparison.status).toBe("failed");
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        code: "summary_count_below_3",
      }),
    );
  });

  it("fails when a day contains live order API evidence", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-compare-"));
    const summaries = await writeSummaries(workDir, [
      createSummary(1),
      createSummary(2, { liveOrderApiCalls: 1 }),
      createSummary(3),
    ]);

    const { stdout } = await runCompareExpectFailure([
      "--summary",
      summaries[0]!,
      "--summary",
      summaries[1]!,
      "--summary",
      summaries[2]!,
      "--json",
    ]);
    const comparison = JSON.parse(stdout) as ComparisonSummary;

    expect(comparison.status).toBe("failed");
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        day: "Day 2",
        code: "live_order_api_observed",
      }),
    );
  });

  it("fails when the same summary path is provided more than once", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-compare-"));
    const summaries = await writeSummaries(workDir, [createSummary(1), createSummary(2), createSummary(3)]);

    const { stdout } = await runCompareExpectFailure([
      "--summary",
      summaries[0]!,
      "--summary",
      summaries[0]!,
      "--summary",
      summaries[2]!,
      "--json",
    ]);
    const comparison = JSON.parse(stdout) as ComparisonSummary;

    expect(comparison.status).toBe("failed");
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        code: "duplicate_summary_path",
      }),
    );
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        code: "duplicate_summary_date",
      }),
    );
  });

  it("fails when notification failure evidence is missing or only marked manual-review-required", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-compare-"));
    const summaries = await writeSummaries(workDir, [
      createSummary(1),
      createSummary(2, { omitNotificationFailures: true }),
      createSummary(3, { notificationFailures: 1, notificationManualReviewRequired: true }),
    ]);

    const { stdout } = await runCompareExpectFailure([
      "--summary",
      summaries[0]!,
      "--summary",
      summaries[1]!,
      "--summary",
      summaries[2]!,
      "--json",
    ]);
    const comparison = JSON.parse(stdout) as ComparisonSummary;

    expect(comparison.status).toBe("failed");
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        day: "Day 2",
        code: "notification_failure_count_missing",
      }),
    );
    expect(comparison.failures).toContainEqual(
      expect.objectContaining({
        day: "Day 3",
        code: "notification_failure_unresolved",
      }),
    );
  });
});

async function runCompare(args: readonly string[]) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
  });
}

async function runCompareExpectFailure(args: readonly string[]) {
  try {
    await runCompare(args);
  } catch (error) {
    return error as ExecFileFailure;
  }
  throw new Error("Expected M9 comparison script to fail");
}

async function writeSummaries(workDir: string, summaries: readonly Record<string, unknown>[]) {
  const paths: string[] = [];
  for (const [index, summary] of summaries.entries()) {
    const summaryPath = path.join(workDir, `summary-day-${index + 1}.json`);
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    paths.push(summaryPath);
  }
  return paths;
}

function createSummary(
  day: number,
  overrides: {
    liveOrderApiCalls?: number;
    notificationFailures?: number;
    notificationManualReviewRequired?: boolean;
    omitNotificationFailures?: boolean;
  } = {},
) {
  const metrics: Record<string, unknown> = {
    liveOrderApiCalls: overrides.liveOrderApiCalls ?? 0,
    cost: {
      feeKrw: day * 10,
    },
    slippage: {
      bps: day,
    },
    fillRate: "100%",
    blockingReasons: {
      stale_market_data: day,
    },
  };
  if (overrides.notificationManualReviewRequired === true) {
    metrics.notificationManualReviewRequired = true;
  }

  const checks: Record<string, unknown> = {
    runtimeExceptions: {
      evidence: {
        crashCount: 0,
        unhandledRejectionCount: 0,
      },
    },
    auditMissing: {
      evidence: {
        count: 0,
      },
    },
    dailyReportGenerated: {
      evidence: {
        generated: true,
      },
    },
  };
  if (overrides.omitNotificationFailures !== true) {
    checks.notificationFailures = {
      evidence: {
        count: overrides.notificationFailures ?? 0,
      },
    };
  }

  return {
    schemaVersion: 1,
    status: "passed",
    startedAt: `2026-05-${String(19 + day).padStart(2, "0")}T00:00:00.000Z`,
    git: {
      branch: "issue-51-mother",
      commit: `abcdef123456789${day}`,
    },
    artifacts: {
      reportPath: `/vaults/seemirai-m9-paper/report-day-${day}.md`,
    },
    metrics,
    checks,
  };
}

/**
 * 비교 스크립트가 stdout으로 반환하는 핵심 JSON shape이다.
 *
 * 테스트는 CLI 출력 전체가 아니라 완료 판정, 일차별 safety metric, 실패 reason code만 검증한다. 이 타입은 파일을 쓰거나
 * 외부 side effect를 만들지 않는 테스트 경계용 표현이다.
 */
interface ComparisonSummary {
  status: "passed" | "failed";
  rows: Array<{
    day: string;
    date: string;
    liveOrderApiCalls: number | null;
    dailyReportGenerated: boolean;
  }>;
  failures: Array<{
    day?: string;
    code: string;
  }>;
}

/**
 * 실패 exit code를 기대하는 CLI 테스트에서 stdout/stderr를 보존하기 위한 Node execFile 오류 shape이다.
 */
interface ExecFileFailure extends Error {
  stdout: string;
  stderr: string;
  code: number;
}
