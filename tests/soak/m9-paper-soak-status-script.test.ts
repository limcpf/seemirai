import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "report-m9-paper-soak-status.mjs");

describe("M9 paper soak status script", () => {
  it("reports an in-progress run from raw log without writing artifacts", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-status-"));
    const prefix = "m9-paper-trading-soak-2026-05-26T01-02-03-004Z-deadbeef";
    const rawLogPath = path.join(artifactDir, `${prefix}-events.jsonl`);
    await writeFile(
      rawLogPath,
      [
        JSON.stringify({
          kind: "PAPER_TRADING_CYCLE",
          startedAt: "2026-05-26T01:02:04.000Z",
          finishedAt: "2026-05-26T01:02:05.000Z",
        }),
        JSON.stringify({
          kind: "CYCLE_SKIPPED",
          occurredAt: "2026-05-26T01:02:06.000Z",
          reason: "orderbook_not_ready",
        }),
        JSON.stringify({
          kind: "MARKET_DATA",
          receivedAt: "2026-05-26T01:02:07.000Z",
          type: "orderbook",
          market: "KRW-BTC",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const before = await snapshotDirectory(artifactDir);

    const { stdout } = await execFileAsync("node", [scriptPath, "--artifact-dir", artifactDir, "--json"]);
    const after = await snapshotDirectory(artifactDir);
    const status = JSON.parse(stdout) as {
      statusCode: string;
      statusLabel: string;
      progress: {
        lastEventAt: string;
        lastEventLabel: string;
        daySummaryGeneratedCount: number;
        expectedDayCount: number;
      };
      signals: { recentSkips: Array<{ message: string; reasonCode: string }> };
      artifacts: { rawLogPath: string; summaryPath: string | null };
    };

    expect(after).toEqual(before);
    expect(status.statusCode).toBe("running");
    expect(status.statusLabel).toBe("진행 중");
    expect(status.progress.lastEventAt).toBe("2026-05-26T01:02:07.000Z");
    expect(status.progress.lastEventLabel).toBe("시장 데이터 수신");
    expect(status.progress.daySummaryGeneratedCount).toBe(0);
    expect(status.progress.expectedDayCount).toBe(3);
    expect(status.signals.recentSkips[0]).toMatchObject({
      message: "호가가 아직 준비되지 않아 cycle을 건너뛰었다.",
      reasonCode: "orderbook_not_ready",
    });
    expect(status.artifacts).toMatchObject({
      rawLogPath,
      summaryPath: null,
    });
  });

  it("renders Korean operator text and failed checks from completed summaries", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-status-failed-"));
    const prefix = "m9-paper-trading-soak-2026-05-26T02-00-00-000Z-feedcafe";
    const summaryPath = path.join(artifactDir, `${prefix}-summary.json`);
    const reportPath = path.join(artifactDir, `${prefix}-report.md`);
    const dayOneSummaryPath = path.join(artifactDir, `${prefix}-day-1-summary.json`);
    const rawLogPath = path.join(artifactDir, `${prefix}-events.jsonl`);
    await writeFile(
      summaryPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          runId: "failed-run",
          status: "failed",
          startedAt: "2026-05-26T02:00:00.000Z",
          finishedAt: "2026-05-26T02:01:00.000Z",
          durationMsRequested: 259_200_000,
          durationMsObserved: 60_000,
          artifacts: {
            rawLogPath,
            summaryPath,
            reportPath,
            dailySummaryPaths: [dayOneSummaryPath],
          },
          metrics: {
            paperTradingCycleAttempts: 2,
            paperTradingCycles: 0,
            paperOrderSubmittedCount: 0,
            paperFillCount: 0,
            liveOrderApiCalls: 0,
            cyclesSkippedNoOrderbook: 2,
            cyclesSkippedStaleOrderbook: 0,
          },
          checks: {
            durationCompleted: {
              status: "fail",
              message: "요청한 duration 전에 runner가 종료됐다.",
              evidence: { durationMsObserved: 60_000 },
            },
            liveOrderApiCalls: {
              status: "ok",
              message: "PaperBroker만 사용했고 live order API 호출이 없다.",
              evidence: { count: 0 },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      dayOneSummaryPath,
      JSON.stringify(
        {
          status: "failed",
          startedAt: "2026-05-26T02:00:00.000Z",
          finishedAt: "2026-05-26T02:01:00.000Z",
          checks: {
            marketDataSource: {
              status: "fail",
              message: "public WebSocket orderbook 기반 paper decision cycle을 최신성 기준 안에서 만들지 못했다.",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(reportPath, "# report\n", "utf8");
    await writeFile(
      rawLogPath,
      `${JSON.stringify({
        kind: "RUNNER_FATAL",
        status: "ERROR",
        occurredAt: "2026-05-26T02:01:00.000Z",
        message: "fixture failure",
      })}\n`,
      "utf8",
    );

    const { stdout } = await execFileAsync("node", [scriptPath, "--artifact-dir", artifactDir]);
    const jsonRun = await execFileAsync("node", [scriptPath, "--artifact-dir", artifactDir, "--json"]);
    const status = JSON.parse(jsonRun.stdout) as {
      statusCode: string;
      metrics: { liveOrderApiCalls: number };
      signals: { recentFailures: Array<{ message: string }> };
      progress: { daySummaryGeneratedCount: number };
    };

    expect(stdout).toContain("M9 paper soak 상태: 실패");
    expect(stdout).toContain("최근 artifact에서 실패 신호가 확인됐다.");
    expect(stdout).toContain("요청한 duration 전에 runner가 종료됐다.");
    expect(stdout).toContain("추적 정보");
    expect(status.statusCode).toBe("failed");
    expect(status.metrics.liveOrderApiCalls).toBe(0);
    expect(status.progress.daySummaryGeneratedCount).toBe(1);
    expect(status.signals.recentFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "runner가 실패 event를 raw log에 기록했다.",
        }),
      ]),
    );
  });
});

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
