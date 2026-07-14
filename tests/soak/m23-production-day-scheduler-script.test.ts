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

  it("scheduler 운영 경로가 외부 symlink를 통해 저장소를 가리키면 차단한다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-scheduler-symlink-"));
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const linkPath = ${JSON.stringify(path.join(home, "repository-link"))};
      await fs.symlink(${JSON.stringify(repositoryRoot)}, linkPath, "dir");
      let message;
      try { await module.assertPathOutsideRepository(path.join(linkPath, "scheduler-events.jsonl")); }
      catch (error) { message = error.message; }
      process.stdout.write(JSON.stringify({ message }));
    `);
    expect(output.message).toContain("저장소 밖 실제 경로");
  });

  it("scheduler output symlink가 config 같은 보호 입력을 가리키면 차단한다", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "seemirai-m23-scheduler-protected-"));
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const home = ${JSON.stringify(home)};
      const configPath = path.join(home, "live-ops.config.json");
      const statusPath = path.join(home, "scheduler-status.json");
      await fs.writeFile(configPath, "{}\\n");
      await fs.symlink(configPath, statusPath, "file");
      let message;
      try {
        await module.assertDistinctSchedulerOutputs({
          configPath,
          envFilePath: path.join(home, "live-ops.env"),
          daemonStatusFilePath: path.join(home, "daemon-status.json"),
          startupArtifactFilePath: path.join(home, "startup.json"),
          daemonPidFilePath: path.join(home, "daemon.pid"),
          artifactDir: path.join(home, "artifacts"),
          schedulerStatusFilePath: statusPath,
          schedulerEventLogFilePath: path.join(home, "scheduler-events.jsonl"),
          schedulerPidFilePath: path.join(home, "scheduler.pid"),
        });
      } catch (error) { message = error.message; }
      process.stdout.write(JSON.stringify({ message }));
    `);
    expect(output.message).toContain("덮어쓸 수 없습니다");
  });

  it("daemon counter 경계는 같은 시각에 한 번만 기록하고 다음 day에서 재사용한다", async () => {
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "m23-boundary-"));
      const statusPath = path.join(home, "status.json");
      const startupPath = path.join(home, "startup.json");
      const pidPath = path.join(home, "daemon.pid");
      const eventPath = path.join(home, "events.jsonl");
      const sourceCommitSha = "a".repeat(40);
      const runtimeProvenance = { sourceCommitSha };
      const counters = {
        tickCount: 100, successCount: 100, holdCount: 100, blockCount: 0,
        manualReviewCount: 0, transientFailureCount: 0, submittedOrderCount: 0,
        exitRequoteCount: 0, duplicateOrderCount: 0, reconcileMismatchCount: 0,
        untrackedFillCount: 0, liveOrderCleanupFailureCount: 0, crashCount: 0,
        unhandledRejectionCount: 0,
      };
      const options = {
        daemonStatusFilePath: statusPath,
        startupArtifactFilePath: startupPath,
        daemonPidFilePath: pidPath,
        schedulerEventLogFilePath: eventPath,
        expectedSourceCommitSha: sourceCommitSha,
      };
      const writeStatus = async (latestTickStartedAt, nextCounters) => fs.writeFile(statusPath, JSON.stringify({
        status: "running", latestError: null, latestSummary: { status: "ready" },
        startedAt: "2026-07-13T20:00:00.000Z", latestTickStartedAt,
        startupArtifactFilePath: startupPath, runtimeProvenance, counters: nextCounters,
      }));
      await fs.writeFile(startupPath, JSON.stringify({ runtimeProvenance }));
      await fs.writeFile(pidPath, String(process.pid));
      await fs.writeFile(eventPath, JSON.stringify({ type: "scheduler_started" }) + "\\n");
      await writeStatus("2026-07-14T14:59:30.000Z", counters);
      await fs.utimes(statusPath, new Date("2026-07-14T15:00:00.500Z"), new Date("2026-07-14T15:00:00.500Z"));
      const start = await module.ensureDaemonCounterBoundary({
        options, boundaryAt: "2026-07-14T15:00:00.000Z",
        clock: () => new Date("2026-07-14T15:00:01.000Z"),
      });
      const reused = await module.ensureDaemonCounterBoundary({
        options, boundaryAt: "2026-07-14T15:00:00.000Z",
        clock: () => new Date("2026-07-15T15:01:00.000Z"),
      });
      await writeStatus("2026-07-15T14:59:30.000Z", { ...counters, tickCount: 1540, successCount: 1540, holdCount: 1540 });
      await fs.utimes(statusPath, new Date("2026-07-15T15:00:00.500Z"), new Date("2026-07-15T15:00:00.500Z"));
      const finish = await module.ensureDaemonCounterBoundary({
        options, boundaryAt: "2026-07-15T15:00:00.000Z",
        clock: () => new Date("2026-07-15T15:00:01.000Z"),
      });
      const events = (await fs.readFile(eventPath, "utf8")).trim().split("\\n").map(JSON.parse);
      process.stdout.write(JSON.stringify({ start, reused, finish, eventTypes: events.map((event) => event.type) }));
    `);
    expect(output.start.boundaryAt).toBe("2026-07-14T15:00:00.000Z");
    expect(output.reused).toEqual(output.start);
    expect(output.finish.counters.tickCount).toBe(1540);
    expect(output.eventTypes).toEqual([
      "scheduler_started",
      "daemon_counter_boundary",
      "daemon_counter_boundary",
    ]);
  });

  it("경계를 걸친 tick의 counter status write를 확인한 뒤 boundary를 기록한다", async () => {
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "m23-boundary-crossing-tick-"));
      const statusPath = path.join(home, "status.json");
      const startupPath = path.join(home, "startup.json");
      const pidPath = path.join(home, "daemon.pid");
      const eventPath = path.join(home, "events.jsonl");
      const sourceCommitSha = "a".repeat(40);
      const runtimeProvenance = { sourceCommitSha };
      const boundaryAt = "2026-07-14T15:00:00.000Z";
      const boundaryMs = Date.parse(boundaryAt);
      let nowMs = boundaryMs - 50;
      const createCounters = (tickCount) => ({
        tickCount, successCount: tickCount, holdCount: tickCount, blockCount: 0,
        manualReviewCount: 0, transientFailureCount: 0, submittedOrderCount: tickCount === 101 ? 1 : 0,
        exitRequoteCount: 0, duplicateOrderCount: 0, reconcileMismatchCount: 0,
        untrackedFillCount: 0, liveOrderCleanupFailureCount: 0, crashCount: 0,
        unhandledRejectionCount: 0,
      });
      const writeStatus = async (counters) => fs.writeFile(statusPath, JSON.stringify({
        status: "running", latestError: null, latestSummary: { status: "ready" },
        startedAt: "2026-07-13T20:00:00.000Z", latestTickStartedAt: "2026-07-14T14:59:59.900Z",
        startupArtifactFilePath: startupPath, runtimeProvenance, counters,
      }));
      await fs.writeFile(startupPath, JSON.stringify({ runtimeProvenance }));
      await fs.writeFile(pidPath, String(process.pid));
      await fs.writeFile(eventPath, JSON.stringify({ type: "scheduler_started" }) + "\\n");
      await writeStatus(createCounters(100));
      await fs.utimes(statusPath, new Date(boundaryMs - 100), new Date(boundaryMs - 100));
      let committed = false;
      const event = await module.ensureDaemonCounterBoundary({
        options: {
          daemonStatusFilePath: statusPath, startupArtifactFilePath: startupPath,
          daemonPidFilePath: pidPath, schedulerEventLogFilePath: eventPath,
          expectedSourceCommitSha: sourceCommitSha,
        },
        boundaryAt,
        clock: () => new Date(nowMs),
        sleeper: async (durationMs) => {
          nowMs += durationMs;
          if (!committed && nowMs >= boundaryMs) {
            committed = true;
            await writeStatus(createCounters(101));
            await fs.utimes(statusPath, new Date(boundaryMs + 10), new Date(boundaryMs + 10));
            nowMs = boundaryMs + 10;
          }
        },
      });
      process.stdout.write(JSON.stringify({ event, committed }));
    `);
    expect(output.committed).toBe(true);
    expect(output.event.counters).toMatchObject({ tickCount: 101, submittedOrderCount: 1 });
    expect(output.event.snapshotObservedAt).toBe("2026-07-14T15:00:00.010Z");
    const snapshotObservedMs = Date.parse(output.event.snapshotObservedAt);
    const counterAttributionCutoffMs = Date.parse(output.event.counterAttributionCutoffAt);
    expect(counterAttributionCutoffMs).toBeGreaterThanOrEqual(snapshotObservedMs);
    expect(counterAttributionCutoffMs).toBeLessThanOrEqual(snapshotObservedMs + 1);
  });

  it("경계 시각에 시작한 tick은 half-open 다음 day로 귀속한다", async () => {
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "m23-boundary-exact-tick-"));
      const statusPath = path.join(home, "status.json");
      const startupPath = path.join(home, "startup.json");
      const pidPath = path.join(home, "daemon.pid");
      const eventPath = path.join(home, "events.jsonl");
      const sourceCommitSha = "a".repeat(40);
      const runtimeProvenance = { sourceCommitSha };
      const boundaryAt = "2026-07-14T15:00:00.000Z";
      const boundaryMs = Date.parse(boundaryAt);
      let nowMs = boundaryMs - 50;
      const createCounters = (tickCount) => ({
        tickCount, successCount: tickCount, holdCount: tickCount, blockCount: 0,
        manualReviewCount: 0, transientFailureCount: 0, submittedOrderCount: tickCount === 101 ? 1 : 0,
        exitRequoteCount: 0, duplicateOrderCount: 0, reconcileMismatchCount: 0,
        untrackedFillCount: 0, liveOrderCleanupFailureCount: 0, crashCount: 0,
        unhandledRejectionCount: 0,
      });
      const writeStatus = async (latestTickStartedAt, counters) => fs.writeFile(statusPath, JSON.stringify({
        status: "running", latestError: null, latestSummary: { status: "ready" },
        startedAt: "2026-07-13T20:00:00.000Z", latestTickStartedAt,
        startupArtifactFilePath: startupPath, runtimeProvenance, counters,
      }));
      await fs.writeFile(startupPath, JSON.stringify({ runtimeProvenance }));
      await fs.writeFile(pidPath, String(process.pid));
      await fs.writeFile(eventPath, JSON.stringify({ type: "scheduler_started" }) + "\\n");
      await writeStatus("2026-07-14T14:59:59.900Z", createCounters(100));
      await fs.utimes(statusPath, new Date(boundaryMs - 100), new Date(boundaryMs - 100));
      let nextDayTickCommitted = false;
      const event = await module.ensureDaemonCounterBoundary({
        options: {
          daemonStatusFilePath: statusPath, startupArtifactFilePath: startupPath,
          daemonPidFilePath: pidPath, schedulerEventLogFilePath: eventPath,
          expectedSourceCommitSha: sourceCommitSha,
        },
        boundaryAt,
        clock: () => new Date(nowMs),
        sleeper: async (durationMs) => {
          nowMs += durationMs;
          if (!nextDayTickCommitted && nowMs >= boundaryMs) {
            nextDayTickCommitted = true;
            await writeStatus(boundaryAt, createCounters(101));
            await fs.utimes(statusPath, new Date(boundaryMs + 10), new Date(boundaryMs + 10));
            nowMs = boundaryMs + 10;
          }
        },
      });
      process.stdout.write(JSON.stringify({ event, nextDayTickCommitted }));
    `);
    expect(output.nextDayTickCommitted).toBe(true);
    expect(output.event.counters).toMatchObject({ tickCount: 100, submittedOrderCount: 0 });
    expect(output.event.latestTickStartedAt).toBe("2026-07-14T14:59:59.900Z");
  });

  it("경계 polling이 daemon status의 부분 JSON과 겹치면 tolerance 안에서 재시도한다", async () => {
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "m23-boundary-partial-status-"));
      const statusPath = path.join(home, "status.json");
      const startupPath = path.join(home, "startup.json");
      const pidPath = path.join(home, "daemon.pid");
      const eventPath = path.join(home, "events.jsonl");
      const boundaryAt = "2026-07-14T15:00:00.000Z";
      const boundaryMs = Date.parse(boundaryAt);
      const runtimeProvenance = { sourceCommitSha: "a".repeat(40) };
      let nowMs = boundaryMs - 50;
      let retryCount = 0;
      await fs.writeFile(statusPath, "{");
      await fs.writeFile(startupPath, JSON.stringify({ runtimeProvenance }));
      await fs.writeFile(pidPath, String(process.pid));
      await fs.writeFile(eventPath, JSON.stringify({ type: "scheduler_started" }) + "\\n");
      const result = await module.ensureDaemonCounterBoundary({
        options: {
          daemonStatusFilePath: statusPath, startupArtifactFilePath: startupPath,
          daemonPidFilePath: pidPath, schedulerEventLogFilePath: eventPath,
          expectedSourceCommitSha: runtimeProvenance.sourceCommitSha,
        },
        boundaryAt,
        clock: () => new Date(nowMs),
        sleeper: async (durationMs) => {
          retryCount += 1;
          nowMs += durationMs + 10;
          await fs.writeFile(statusPath, JSON.stringify({
            status: "running", latestError: null, latestSummary: { status: "ready" },
            startedAt: "2026-07-13T20:00:00.000Z", latestTickStartedAt: "2026-07-14T14:59:59.900Z",
            startupArtifactFilePath: startupPath, runtimeProvenance,
            counters: {
              tickCount: 101, successCount: 101, holdCount: 101, blockCount: 0,
              manualReviewCount: 0, transientFailureCount: 0, submittedOrderCount: 0,
              exitRequoteCount: 0, duplicateOrderCount: 0, reconcileMismatchCount: 0,
              untrackedFillCount: 0, liveOrderCleanupFailureCount: 0, crashCount: 0,
              unhandledRejectionCount: 0,
            },
          }));
          await fs.utimes(statusPath, new Date(boundaryMs + 10), new Date(boundaryMs + 10));
        },
      });
      process.stdout.write(JSON.stringify({ result, retryCount }));
    `);
    expect(output.retryCount).toBe(1);
    expect(output.result.counters).toMatchObject({ tickCount: 101, transientFailureCount: 0 });
  });

  it("status read 전후 file version이 바뀌면 경계 snapshot으로 사용하지 않는다", async () => {
    const output = await runModuleExpression(`
      const first = { dev: 1n, ino: 2n, size: 100n, mtimeNs: 10_000_000n, ctimeNs: 10_000_000n };
      const second = { ...first, mtimeNs: 11_000_000n, ctimeNs: 11_000_000n };
      let statCall = 0;
      const raced = await module.readStableJsonFileSnapshot("ignored", {
        readText: async () => JSON.stringify({ counters: { tickCount: 100 } }),
        statFile: async () => [first, second][statCall++],
      });
      const stable = await module.readStableJsonFileSnapshot("ignored", {
        readText: async () => JSON.stringify({ counters: { tickCount: 101 } }),
        statFile: async () => second,
      });
      process.stdout.write(JSON.stringify({ raced: raced ?? null, stable }));
    `);
    expect(output.raced).toBeNull();
    expect(output.stable).toEqual({ value: { counters: { tickCount: 101 } }, modifiedAtMs: 11 });
  });

  it("경계 polling 중 scheduler stop은 failure 대신 정상 중지 sentinel을 반환한다", async () => {
    const output = await runModuleExpression(`
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "m23-boundary-stop-"));
      const statusPath = path.join(home, "status.json");
      const startupPath = path.join(home, "startup.json");
      const pidPath = path.join(home, "daemon.pid");
      const eventPath = path.join(home, "events.jsonl");
      const boundaryAt = "2026-07-14T15:00:00.000Z";
      const boundaryMs = Date.parse(boundaryAt);
      const runtimeProvenance = { sourceCommitSha: "a".repeat(40) };
      await fs.writeFile(statusPath, JSON.stringify({
        status: "running", latestError: null, latestSummary: { status: "ready" },
        startedAt: "2026-07-13T20:00:00.000Z", latestTickStartedAt: "2026-07-14T14:59:59.000Z",
        startupArtifactFilePath: startupPath, runtimeProvenance,
        counters: {
          tickCount: 1, successCount: 1, holdCount: 1, blockCount: 0, manualReviewCount: 0,
          transientFailureCount: 0, submittedOrderCount: 0, exitRequoteCount: 0, duplicateOrderCount: 0,
          reconcileMismatchCount: 0, untrackedFillCount: 0, liveOrderCleanupFailureCount: 0,
          crashCount: 0, unhandledRejectionCount: 0,
        },
      }));
      await fs.utimes(statusPath, new Date(boundaryMs - 100), new Date(boundaryMs - 100));
      await fs.writeFile(startupPath, JSON.stringify({ runtimeProvenance }));
      await fs.writeFile(pidPath, String(process.pid));
      await fs.writeFile(eventPath, JSON.stringify({ type: "scheduler_started" }) + "\\n");
      const stopControl = { requested: false, signal: "SIGTERM" };
      const result = await module.ensureDaemonCounterBoundary({
        options: {
          daemonStatusFilePath: statusPath, startupArtifactFilePath: startupPath,
          daemonPidFilePath: pidPath, schedulerEventLogFilePath: eventPath,
          expectedSourceCommitSha: runtimeProvenance.sourceCommitSha,
        },
        boundaryAt,
        clock: () => new Date(boundaryMs - 50),
        sleeper: async () => { stopControl.requested = true; },
        stopControl,
      });
      const events = (await fs.readFile(eventPath, "utf8")).trim().split("\\n").map(JSON.parse);
      process.stdout.write(JSON.stringify({ result: result ?? null, eventTypes: events.map((event) => event.type) }));
    `);
    expect(output).toEqual({ result: null, eventTypes: ["scheduler_started"] });
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
