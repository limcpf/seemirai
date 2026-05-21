import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "soak-paper-24h.mjs");

describe("M8 paper soak script", () => {
  it("skips the 24h soak path unless SEEMIRAI_RUN_SOAK is explicitly enabled", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const { stdout } = await runSoak(["--json", "--log-dir", logDir], {
      SEEMIRAI_RUN_SOAK: "0",
    });

    const summary = JSON.parse(stdout) as SoakSummary;
    const longRunGuard = getCheck(summary, "longRunGuard");

    expect(summary.status).toBe("skipped");
    expect(longRunGuard.status).toBe("skipped");
    expect(longRunGuard.evidence.requiredEnv).toBe("SEEMIRAI_RUN_SOAK=1");
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("runs a deterministic fixture smoke with stale-data block and live-order count evidence", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const { stdout } = await runSoak(["--fixture-smoke", "--json", "--log-dir", logDir]);

    const summary = JSON.parse(stdout) as SoakSummary;

    expect(summary.status).toBe("passed");
    expect(summary.input).toBe("fixture_smoke");
    expect(summary.metrics.liveOrderApiCalls).toBe(0);
    expect(getCheck(summary, "configSafety").status).toBe("ok");
    expect(getCheck(summary, "liveOrderApiCalls")).toMatchObject({
      status: "ok",
      evidence: {
        count: 0,
      },
    });
    expect(getCheck(summary, "staleDataBlocked")).toMatchObject({
      status: "ok",
      evidence: {
        blockedEvents: 1,
      },
    });
    expect(getCheck(summary, "auditMissing")).toMatchObject({
      status: "ok",
      evidence: {
        count: 0,
      },
    });
    expect(getCheck(summary, "telegramInboundAbsent").status).toBe("ok");
    expect(getCheck(summary, "dailyReportGenerated").status).toBe("skipped");

    const rawLog = await readFile(summary.artifacts.rawLogPath, "utf8");
    expect(rawLog.trim().split("\n")).toHaveLength(4);
    await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
    await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
  });

  it("probes control URL without posting a state-changing kill-switch request", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      response.writeHead(500);
      response.end();
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoak([
        "--fixture-smoke",
        "--json",
        "--log-dir",
        logDir,
        "--control-url",
        controlUrl,
        "--control-probe-timeout-ms",
        "500",
      ]);
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("passed");
      expect(requests).toEqual(["GET /status"]);
      expect(getCheck(summary, "statusEndpoint").status).toBe("ok");
      expect(getCheck(summary, "killSwitchEndpoint")).toMatchObject({
        status: "ok",
        evidence: {
          stateChangingProbeSkipped: true,
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("records control probe timeouts as failed checks while still writing artifacts", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-soak-"));
    const server = createServer(() => {
      // timeout 검증용 서버는 일부러 응답하지 않는다. soak script는 이 상태를 실패 check로 기록해야 한다.
    });
    const controlUrl = await listenOnLocalhost(server);

    try {
      const { stdout } = await runSoakExpectFailure([
        "--fixture-smoke",
        "--json",
        "--log-dir",
        logDir,
        "--control-url",
        controlUrl,
        "--control-probe-timeout-ms",
        "50",
      ]);
      const summary = JSON.parse(stdout) as SoakSummary;

      expect(summary.status).toBe("failed");
      expect(getCheck(summary, "statusEndpoint")).toMatchObject({
        status: "fail",
        evidence: {
          timeoutMs: 50,
        },
      });
      await expect(stat(summary.artifacts.summaryPath)).resolves.toBeDefined();
      await expect(stat(summary.artifacts.reportPath)).resolves.toBeDefined();
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });
});

async function runSoak(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
  });
}

async function runSoakExpectFailure(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try {
    await runSoak(args, env);
  } catch (error) {
    return error as ExecFileFailure;
  }
  throw new Error("Expected soak script to fail");
}

function listenOnLocalhost(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function getCheck(summary: SoakSummary, name: string): SoakCheck {
  const check = summary.checks[name];
  expect(check).toBeDefined();
  return check!;
}

interface SoakSummary {
  status: "skipped" | "passed" | "failed";
  input: string;
  metrics: {
    liveOrderApiCalls: number;
  };
  artifacts: {
    rawLogPath: string;
    summaryPath: string;
    reportPath: string;
  };
  checks: Record<string, SoakCheck>;
}

interface SoakCheck {
  status: "ok" | "skipped" | "fail";
  message: string;
  evidence: Record<string, unknown>;
}

interface ExecFileFailure extends Error {
  stdout: string;
  stderr: string;
  code: number;
}
