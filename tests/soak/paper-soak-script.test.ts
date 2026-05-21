import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
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
