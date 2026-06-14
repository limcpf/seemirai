import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production live ops script skeleton", () => {
  it("live:ops skeleton은 fixture smoke에서 provider 호출 없이 config/env contract를 검증한다", () => {
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
    expect(result.stdout).toContain("production live ops config/env 계약을 통과했습니다");
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
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
});

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? path.join(process.cwd(), "test-results"),
  };
}
