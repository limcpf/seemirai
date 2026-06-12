import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "prepare-m22-live-autonomous-local-files.mjs");

describe("M22 live autonomous local file preparer script", () => {
  it("creates repository-external env, key, config, evidence, and wrapper files", async () => {
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-local-files-"));
    const { stdout } = await runScript(["--dir", targetDir, "--json"]);
    const summary = JSON.parse(stdout) as M22LocalFileSummary;
    const env = await readFile(summary.files.env.path, "utf8");
    const keys = await readFile(summary.files.keys.path, "utf8");
    const config = JSON.parse(await readFile(summary.files.config.path, "utf8")) as M22RuntimeConfigTemplate;

    expect(summary.status).toBe("prepared");
    expect(summary.files.env.status).toBe("created");
    expect(summary.files.keys.status).toBe("created");
    expect(env).toContain('SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT="0"');
    expect(env).toContain('SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON="0"');
    expect(env).toContain('SEEMIRAI_PILOT_PROFILE="PILOT_ORDER_SMOKE"');
    expect(env).toContain('SEEMIRAI_UPBIT_KEY_SCOPE="자산조회,주문조회,주문하기"');
    expect(env).toContain("SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID");
    expect(keys).toContain('SEEMIRAI_DATABASE_URL="${SEEMIRAI_DATABASE_URL:-}"');
    expect(keys).toContain('SEEMIRAI_UPBIT_SECRET_KEY="${SEEMIRAI_UPBIT_SECRET_KEY:-}"');
    expect(config).toMatchObject({
      live_trading_enabled: false,
      withdrawal_enabled: false,
      futures_enabled: false,
      leverage_enabled: false,
      market_order_enabled: false,
      entry_market_order_enabled: false,
      secrets: {},
      live_autonomous: {
        enabled: true,
        allowed_markets: ["KRW-BTC"],
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        identifier_max_length: 32,
      },
    });
    await expect(stat(summary.files.upbitKeyScopeEvidence.path)).resolves.toBeDefined();
    await expect(readFile(summary.files.candidateFile.path, "utf8")).resolves.toContain("candidate JSONL");
    expect(await modeOf(summary.files.keys.path)).toBe(0o600);
    expect(await modeOf(summary.files.candidateFile.path)).toBe(0o600);
    expect(await modeOf(summary.files.run24hScript.path)).toBe(0o700);
    const run24hScript = await readFile(summary.files.run24hScript.path, "utf8");
    expect(run24hScript).toContain("unset SEEMIRAI_M22_ARTIFACT_DIR");
    expect(run24hScript).toContain("unset SEEMIRAI_UPBIT_SECRET_KEY");
    expect(run24hScript).toContain("scripts/run-m22-live-autonomous-daemon.mjs");
    await execFileAsync("bash", ["-n", summary.files.fixtureSmokeScript.path]);
    await execFileAsync("bash", ["-n", summary.files.run24hScript.path]);
    await execFileAsync("sh", ["-n", summary.files.fixtureSmokeScript.path]);
    await execFileAsync("sh", ["-n", summary.files.run24hScript.path]);
  });

  it("keeps existing files unless force is specified", async () => {
    const targetDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m22-local-files-keep-"));
    await mkdir(targetDir, { recursive: true });
    const keysPath = path.join(targetDir, "m22.keys.env");
    const existingKeys = 'export SEEMIRAI_DATABASE_URL="postgres://already-set"\n';
    await writeFile(keysPath, existingKeys, "utf8");

    const { stdout } = await runScript(["--dir", targetDir, "--json"]);
    const summary = JSON.parse(stdout) as M22LocalFileSummary;
    expect(summary.files.keys.status).toBe("kept");
    expect(await readFile(keysPath, "utf8")).toBe(existingKeys);

    const { stdout: forcedStdout } = await runScript(["--dir", targetDir, "--force", "--json"]);
    const forcedSummary = JSON.parse(forcedStdout) as M22LocalFileSummary;
    expect(forcedSummary.files.keys.status).toBe("overwritten");
    expect(await readFile(keysPath, "utf8")).toContain('SEEMIRAI_DATABASE_URL="${SEEMIRAI_DATABASE_URL:-}"');
  });

  it("refuses to create operational key files inside the repository by default", async () => {
    const repoLocalDir = path.join(process.cwd(), `.tmp-m22-local-files-${Date.now()}`);
    const error = await runScriptExpectingFailure(["--dir", repoLocalDir, "--json"]);

    expect(error.stderr).toContain("운영 env/key 파일은 저장소 내부에 만들지 않는다");
  });
});

async function runScript(args: readonly string[]) {
  return await execFileAsync("node", [scriptPath, ...args]);
}

async function runScriptExpectingFailure(args: readonly string[]) {
  try {
    await runScript(args);
  } catch (error) {
    return error as Error & { stderr?: string };
  }

  throw new Error("script unexpectedly passed");
}

async function modeOf(filePath: string): Promise<number> {
  const fileStat = await stat(filePath);
  return fileStat.mode & 0o777;
}

interface M22LocalFileSummary {
  status: string;
  files: {
    env: M22PreparedFileSummary;
    keys: M22PreparedFileSummary;
    config: M22PreparedFileSummary;
    readme: M22PreparedFileSummary;
    fixtureSmokeScript: M22PreparedFileSummary;
    run24hScript: M22PreparedFileSummary;
    candidateFile: M22PreparedFileSummary;
    operatorArmEvidence: M22PreparedFileSummary;
    budgetEvidence: M22PreparedFileSummary;
    m21WeekGateEvidence: M22PreparedFileSummary;
    upbitKeyScopeEvidence: M22PreparedFileSummary;
  };
}

interface M22PreparedFileSummary {
  path: string;
  status: string;
  mode: string;
}

interface M22RuntimeConfigTemplate {
  live_trading_enabled: boolean;
  withdrawal_enabled: boolean;
  futures_enabled: boolean;
  leverage_enabled: boolean;
  market_order_enabled: boolean;
  entry_market_order_enabled: boolean;
  secrets: Record<string, unknown>;
  live_autonomous: {
    enabled: boolean;
    allowed_markets: readonly string[];
    max_order_krw: string;
    daily_autonomous_notional_limit_krw: string;
    identifier_max_length: number;
  };
}
