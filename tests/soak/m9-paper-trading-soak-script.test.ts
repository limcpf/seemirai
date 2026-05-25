import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "run-m9-paper-trading-soak.mjs");
const compareScriptPath = path.join(process.cwd(), "scripts", "compare-m9-paper-reports.mjs");
const fixturePath = path.join(process.cwd(), "tests", "fixtures", "m9", "paper-decision-runner.json");
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

  it("fails day summaries when public orderbook input is unavailable", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-trading-soak-websocket-"));
    const summary = await runScriptExpectingFailure(
      [
        "--json",
        "--daily-report-generated",
        "--duration-ms",
        "50",
        "--day-ms",
        "50",
        "--days",
        "1",
        "--cycle-interval-ms",
        "10",
        "--websocket-url",
        "ws://127.0.0.1:1",
        "--artifact-dir",
        artifactDir,
      ],
      {
        SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK: "1",
      },
    );
    const daySummary = JSON.parse(await readFile(summary.artifacts.dailySummaryPaths[0]!, "utf8")) as {
      status: string;
      checks: { marketDataSource: { status: string; evidence: { orderbookMessages: number } } };
    };

    expect(summary.status).toBe("failed");
    expect(summary.checks.marketDataSource.status).toBe("fail");
    expect(daySummary.status).toBe("failed");
    expect(daySummary.checks.marketDataSource).toMatchObject({
      status: "fail",
      evidence: {
        orderbookMessages: 0,
      },
    });
  }, 40_000);

  it("skips stale public orderbook snapshots before a paper cycle", async () => {
    const server = await startOrderbookWebSocketServer([createOrderbookPayload()]);
    try {
      const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-trading-soak-stale-"));
      const summary = await runScriptExpectingFailure(
        [
          "--json",
          "--daily-report-generated",
          "--duration-ms",
          "140",
          "--day-ms",
          "140",
          "--days",
          "1",
          "--cycle-interval-ms",
          "20",
          "--max-orderbook-staleness-ms",
          "1",
          "--websocket-url",
          server.url,
          "--artifact-dir",
          artifactDir,
        ],
        {
          SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK: "1",
        },
      );
      const rawLog = await readFile(summary.artifacts.rawLogPath, "utf8");

      expect(summary.metrics.cyclesSkippedStaleOrderbook).toBeGreaterThan(0);
      expect(rawLog).toContain("\"reason\":\"orderbook_stale\"");
    } finally {
      await server.close();
    }
  }, 40_000);

  it("uses bid price for SELL order frames fed by live orderbook", async () => {
    const server = await startOrderbookWebSocketServer([createOrderbookPayload()]);
    try {
      const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-trading-soak-sell-"));
      const sellFixturePath = path.join(artifactDir, "sell-fixture.json");
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
        initialBalances: Array<{ currency: string; available: string }>;
        frames: Array<{ features?: { paper_decision_signal?: string; side?: string } }>;
      };
      fixture.initialBalances = [
        { currency: "KRW", available: "1000000" },
        { currency: "BTC", available: "1" },
      ];
      for (const frame of fixture.frames) {
        if (frame.features?.paper_decision_signal === "ORDER") {
          frame.features.side = "SELL";
        }
      }
      await writeFile(sellFixturePath, JSON.stringify(fixture), "utf8");

      const { stdout } = await execFileAsync(
        "node",
        [
          scriptPath,
          "--json",
          "--daily-report-generated",
          "--fixture",
          sellFixturePath,
          "--duration-ms",
          "1000",
          "--days",
          "1",
          "--max-cycles",
          "1",
          "--cycle-interval-ms",
          "20",
          "--max-orderbook-staleness-ms",
          "1000",
          "--websocket-url",
          server.url,
          "--artifact-dir",
          artifactDir,
        ],
        {
          env: {
            ...process.env,
            SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK: "1",
          },
        },
      );
      const summary = JSON.parse(stdout) as {
        status: string;
        metrics: { paperTradingCycles: number; paperOrderSubmittedCount: number; paperFillCount: number };
      };

      expect(summary.status).toBe("passed");
      expect(summary.metrics).toMatchObject({
        paperTradingCycles: 1,
        paperOrderSubmittedCount: 1,
        paperFillCount: 1,
      });
    } finally {
      await server.close();
    }
  }, 40_000);
});

async function readCompileTempDirs() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(compileTempPrefix))
      .map((entry) => entry.name),
  );
}

async function runScriptExpectingFailure(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try {
    await execFileAsync("node", [scriptPath, ...args], {
      env: {
        ...process.env,
        ...env,
      },
    });
  } catch (error) {
    const executionError = error as Error & { code?: number; stdout?: string };
    expect(executionError.code).toBe(1);
    return JSON.parse(executionError.stdout ?? "{}") as {
      status: string;
      artifacts: { dailySummaryPaths: string[]; rawLogPath: string };
      metrics: { cyclesSkippedStaleOrderbook: number };
      checks: { marketDataSource: { status: string } };
    };
  }

  throw new Error("script unexpectedly passed");
}

async function startOrderbookWebSocketServer(payloads: readonly unknown[]) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let handshaken = false;
    socket.on("data", (data) => {
      if (handshaken) {
        return;
      }
      handshaken = true;
      const request = data.toString("utf8");
      const key = request.match(/^Sec-WebSocket-Key: (.+)$/im)?.[1]?.trim();
      if (key === undefined) {
        socket.destroy();
        return;
      }
      socket.write(createWebSocketHandshakeResponse(key));
      payloads.forEach((payload, index) => {
        setTimeout(() => {
          if (!socket.destroyed) {
            socket.write(encodeWebSocketTextFrame(JSON.stringify(payload)));
          }
        }, index * 5);
      });
      setTimeout(() => {
        socket.end();
      }, Math.max(50, payloads.length * 5 + 20));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test WebSocket server did not expose a TCP address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function createWebSocketHandshakeResponse(key: string): string {
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n");
}

function encodeWebSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  return Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
}

function createOrderbookPayload() {
  return {
    type: "orderbook",
    code: "KRW-BTC",
    timestamp: Date.now(),
    orderbook_units: [
      {
        ask_price: 100_000_000,
        ask_size: 1,
        bid_price: 99_990_000,
        bid_size: 1,
      },
    ],
  };
}
