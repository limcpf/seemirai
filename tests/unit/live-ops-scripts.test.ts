import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production live ops script skeleton", () => {
  it("live:ops --tui는 fixture smoke에서 provider 호출 없이 운영 dashboard 첫 화면을 출력한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
        "--tui",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Seemirai Live Ops");
    expect(result.stdout).toContain("운영 dashboard");
    expect(result.stdout).toContain("DB readiness: 통과");
    expect(result.stdout).toContain("Pending migration: 없음");
    expect(result.stdout).toContain("후속 provider 연결 전까지 신규 실주문은 제출되지 않습니다");
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
    expect(result.stdout).not.toContain("LIVE_AUTONOMOUS_SMALL_BUDGET");
  });

  it("live:ops JSON 경로는 dashboard 없이 machine-readable summary를 유지한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout) as {
      configPath: string;
      envFilePath: string;
      dbReadiness: {
        ready: boolean;
        fixtureSmoke: boolean;
        migration: { expectedLatestVersion: number | null; pendingVersions: number[] };
        checks: Array<{ code: string }>;
      };
    };
    expect(path.isAbsolute(summary.configPath)).toBe(true);
    expect(path.isAbsolute(summary.envFilePath)).toBe(true);
    expect(summary.dbReadiness.ready).toBe(true);
    expect(summary.dbReadiness.fixtureSmoke).toBe(true);
    expect(summary.dbReadiness.migration.expectedLatestVersion).toBeGreaterThan(0);
    expect(summary.dbReadiness.migration.pendingVersions).toEqual([]);
    expect(summary.dbReadiness.checks.map((check) => check.code)).toContain("db_connection_fixture_skipped");
  });

  it("live:ops:tui attach는 같은 dashboard를 attach 대상으로 렌더링한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-tui.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
        "--attach",
        "fixture",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Seemirai Live Ops");
    expect(result.stdout).toContain("attach=fixture");
    expect(result.stdout).toMatch(/DB schema: 적용 v\d+ \/ 기준 v\d+/u);
    expect(result.stdout).not.toContain("fake-local-control-token");
  });

  it("live:ops:tui attach skeleton은 attach 대상 없이는 실패한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-tui.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--attach");
  });

  it("legacy M22 readiness env가 섞이면 production live ops script가 fail-closed 한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_M22_DECISION_LEDGER_READY: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("실제 readiness probe로 대체해야 합니다");
  });

  it("예산 상한을 완화한 운영 JSON은 CLI contract에서도 fail-closed 한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.budget.max_order_krw = "100000000";
    const configPath = path.join(tempDir, "unsafe-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("budget.max_order_krw");
  });

  it("더 보수적인 운영 중지 ceiling은 CLI contract에서도 허용한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.budget.operations_stop_ceiling_krw = "40000";
    const configPath = path.join(tempDir, "conservative-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("strict runtime config와 다른 exchange/unknown key는 CLI contract에서도 fail-closed 한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.exchange = "BINANCE";
    config.operator_note = "not part of runtime contract";
    const configPath = path.join(tempDir, "unsafe-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange는 UPBIT");
    expect(result.stderr).toContain("$.operator_note");
  });

  it("모든 SEEMIRAI_RUN_UPBIT_*_SMOKE env가 production CLI에서 fail-closed 된다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production live ops smoke/readiness");
  });

  it("process env의 smoke flag는 env file override로 숨길 수 없다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-env-"));
    const envFileContent = await readFile(path.join(process.cwd(), "tests", "fixtures", "live-ops", "fake.env"), "utf8");
    const envFilePath = path.join(tempDir, "override.env");
    await writeFile(envFilePath, `${envFileContent}\nSEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=0\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        envFilePath,
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE");
  });
});

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? path.join(process.cwd(), "test-results"),
  };
}
