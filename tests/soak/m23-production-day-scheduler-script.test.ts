import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repositoryRoot, "scripts", "run-m23-production-day-scheduler.mjs");

describe("M23 production day scheduler script", () => {
  it("KST 날짜를 월 경계에서도 연속으로 만든다", async () => {
    const output = await runModuleExpression(`
      process.stdout.write(JSON.stringify(module.createDaySequence("2026-07-30", 4)));
    `);
    expect(output).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("알 수 없는 CLI 인자와 잘못된 재시도 값을 fail-fast 한다", async () => {
    const output = await runModuleExpression(`
      const errors = [];
      for (const args of [["--unknown"], ["--day-count", "0"], ["--closeout-delay-ms", "-1"]]) {
        try { module.parseProductionDaySchedulerArgs(args); } catch (error) { errors.push(error.message); }
      }
      process.stdout.write(JSON.stringify(errors));
    `) as string[];
    expect(output[0]).toContain("알 수 없는 인자");
    expect(output[1]).toContain("양의 정수");
    expect(output[2]).toContain("0 이상의 정수");
  });

  it("fixture scheduler가 날짜별 create-only artifact와 완료 상태를 남긴다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-scheduler-"));
    const artifactDir = path.join(home, "artifacts");
    const statusFile = path.join(home, "scheduler-status.json");
    const eventLogFile = path.join(home, "scheduler-events.jsonl");
    const pidFile = path.join(home, "scheduler.pid");
    const result = await execFileAsync(
      process.execPath,
      [
        scriptPath,
        "--fixture-smoke",
        "--first-day", "2026-07-01",
        "--day-count", "2",
        "--closeout-delay-ms", "0",
        "--artifact-dir", artifactDir,
        "--scheduler-status-file", statusFile,
        "--scheduler-event-log-file", eventLogFile,
        "--scheduler-pid-file", pidFile,
        "--json",
      ],
      { cwd: repositoryRoot, env: process.env },
    );
    const output = JSON.parse(result.stdout) as { status: string; completedDays: string[] };
    const status = JSON.parse(await readFile(statusFile, "utf8")) as typeof output;
    const events = (await readFile(eventLogFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(output.status).toBe("completed");
    expect(status.completedDays).toEqual(["2026-07-01", "2026-07-02"]);
    expect(events.map((event) => event.type)).toEqual([
      "scheduler_started",
      "production_day_completed",
      "production_day_completed",
      "scheduler_completed",
    ]);
    await expect(readFile(path.join(artifactDir, "production-day-2026-07-01.json"), "utf8")).resolves.toContain('"status": "passed"');
    for (const filePath of [
      statusFile,
      eventLogFile,
      pidFile,
      path.join(artifactDir, "production-day-2026-07-01.json"),
      path.join(artifactDir, "production-day-2026-07-02.json"),
    ]) {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("한 day가 재시도 한도를 소진하면 다음 day로 건너뛰지 않는다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-production-scheduler-failure-"));
    const artifactDir = path.join(home, "artifacts");
    const statusFile = path.join(home, "scheduler-status.json");
    const eventLogFile = path.join(home, "scheduler-events.jsonl");
    const pidFile = path.join(home, "scheduler.pid");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "production-day-2026-07-01.json"), '{"status":"failed"}\n', "utf8");

    await expect(execFileAsync(
      process.execPath,
      [
        scriptPath,
        "--fixture-smoke",
        "--first-day", "2026-07-01",
        "--day-count", "2",
        "--closeout-delay-ms", "0",
        "--retry-delay-ms", "1",
        "--max-attempts-per-day", "2",
        "--artifact-dir", artifactDir,
        "--scheduler-status-file", statusFile,
        "--scheduler-event-log-file", eventLogFile,
        "--scheduler-pid-file", pidFile,
      ],
      { cwd: repositoryRoot, env: process.env },
    )).rejects.toMatchObject({ code: 1 });

    const status = JSON.parse(await readFile(statusFile, "utf8")) as {
      status: string;
      currentDay: string;
      currentAttempt: number;
      completedDays: string[];
    };
    const eventTypes = (await readFile(eventLogFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    expect(status).toMatchObject({
      status: "failed",
      currentDay: "2026-07-01",
      currentAttempt: 2,
      completedDays: [],
    });
    expect(eventTypes).toEqual([
      "scheduler_started",
      "production_day_retry_planned",
      "production_day_failed",
    ]);
    await expect(access(path.join(artifactDir, "production-day-2026-07-02.json"))).rejects.toThrow();
  });

  it("actual mode는 두 명시 guard 없이 실행되지 않는다", async () => {
    await expect(execFileAsync(
      process.execPath,
      [scriptPath, "--first-day", "2026-07-15"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          SEEMIRAI_RUN_M23_PRODUCTION_DAY_SCHEDULER: "0",
          SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT: "0",
        },
      },
    )).rejects.toMatchObject({ code: 1 });
  });
});

async function runModuleExpression(expression: string): Promise<any> {
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(scriptPath)}); ${expression}`,
    ],
    { cwd: repositoryRoot, env: process.env },
  );
  return JSON.parse(result.stdout);
}
