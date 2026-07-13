#!/usr/bin/env node
import { access, appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createKstDayWindow,
  runProductionDayCloseoutCli,
} from "./run-m23-production-day-closeout.mjs";

const schedulerGuardEnv = "SEEMIRAI_RUN_M23_PRODUCTION_DAY_SCHEDULER";
const closeoutGuardEnv = "SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT";
const defaultDayCount = 7;
const defaultCloseoutDelayMs = 60_000;
const defaultRetryDelayMs = 5 * 60_000;
const defaultMaxAttemptsPerDay = 36;
const maxSleepChunkMs = 60 * 60_000;
const boundaryCaptureToleranceMs = 60_000;
const boundaryCaptureLeadMs = 5_000;
const boundaryCapturePollMs = 50;
const boundaryHeartbeatLagMs = 2 * 60_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceShaPattern = /^[a-f0-9]{40}$/u;
const daemonCounterNames = [
  "tickCount",
  "successCount",
  "holdCount",
  "blockCount",
  "manualReviewCount",
  "transientFailureCount",
  "submittedOrderCount",
  "exitRequoteCount",
  "duplicateOrderCount",
  "reconcileMismatchCount",
  "untrackedFillCount",
  "liveOrderCleanupFailureCount",
  "crashCount",
  "unhandledRejectionCount",
];
const requiredBuildFiles = [
  path.join(repositoryRoot, "dist", "application", "index.js"),
  path.join(repositoryRoot, "dist", "infrastructure", "index.js"),
  path.join(repositoryRoot, "dist", "runtime", "index.js"),
];

if (isDirectExecution()) {
  try {
    const result = await runProductionDaySchedulerCli(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`M23 production day scheduler 실패: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * 완료된 KST 날짜를 순차적으로 닫아 Issue #267 actual closeout artifact를 자동 수집한다.
 *
 * actual mode는 별도 scheduler/closeout guard와 저장소 밖 운영 파일을 요구한다. 거래 daemon을 시작하거나 중지하지 않으며,
 * 기존 일별 report idempotency 경계를 호출하고 secret-free scheduler 상태/event만 기록한다.
 */
export async function runProductionDaySchedulerCli(argv, io = {}) {
  const options = parseProductionDaySchedulerArgs(argv);
  const stdout = io.stdout ?? process.stdout;
  if (options.help) {
    stdout.write(formatProductionDaySchedulerHelp());
    return { exitCode: 0 };
  }

  if (!options.fixtureSmoke) {
    if (process.env[schedulerGuardEnv] !== "1" || process.env[closeoutGuardEnv] !== "1") {
      throw new Error(`${schedulerGuardEnv}=1 및 ${closeoutGuardEnv}=1 guard가 필요합니다.`);
    }
    assertActualOptions(options);
    for (const filePath of [
      options.configPath,
      options.envFilePath,
      options.daemonStatusFilePath,
      options.startupArtifactFilePath,
      options.daemonPidFilePath,
      options.artifactDir,
      options.schedulerStatusFilePath,
      options.schedulerEventLogFilePath,
      options.schedulerPidFilePath,
    ]) {
      assertPathOutsideRepository(filePath);
    }
    assertDistinctSchedulerOutputs(options);
    await assertActualSchedulerPreflight(options);
  } else {
    assertFixtureOptions(options);
  }

  const clock = io.clock ?? (() => new Date());
  const sleeper = io.sleep ?? sleep;
  const state = createInitialState(options, clock());
  await createSchedulerPidFile(options.schedulerPidFilePath);
  await writeSchedulerStatus(options.schedulerStatusFilePath, state);
  await appendSchedulerEvent(options.schedulerEventLogFilePath, {
    type: "scheduler_started",
    occurredAt: clock().toISOString(),
    processId: process.pid,
    firstDay: options.firstDay,
    dayCount: options.dayCount,
  });

  const stopControl = createStopControl();
  const removeSignalHandlers = installSignalHandlers(stopControl);
  try {
    for (const day of createDaySequence(options.firstDay, options.dayCount)) {
      if (stopControl.requested) {
        break;
      }
      const window = createKstDayWindow(day);
      if (!options.fixtureSmoke) {
        Object.assign(state, {
          status: "waiting_boundary",
          currentDay: day,
          waitingUntil: window.startedAt,
          currentAttempt: 0,
          updatedAt: clock().toISOString(),
        });
        await writeSchedulerStatus(options.schedulerStatusFilePath, state);
        await waitUntil(new Date(window.startMs - boundaryCaptureLeadMs), { clock, sleeper, stopControl });
        if (stopControl.requested) {
          break;
        }
        await ensureDaemonCounterBoundary({
          options,
          boundaryAt: window.startedAt,
          clock,
          sleeper,
          stopControl,
        });
        Object.assign(state, {
          status: "collecting_day",
          waitingUntil: window.finishedAt,
          updatedAt: clock().toISOString(),
        });
        await writeSchedulerStatus(options.schedulerStatusFilePath, state);
        await waitUntil(new Date(window.endMs - boundaryCaptureLeadMs), { clock, sleeper, stopControl });
        if (stopControl.requested) {
          break;
        }
        await ensureDaemonCounterBoundary({
          options,
          boundaryAt: window.finishedAt,
          clock,
          sleeper,
          stopControl,
        });
      }
      const closeoutAt = new Date(window.endMs + options.closeoutDelayMs);
      Object.assign(state, {
        status: "waiting",
        currentDay: day,
        waitingUntil: closeoutAt.toISOString(),
        currentAttempt: 0,
        updatedAt: clock().toISOString(),
      });
      await writeSchedulerStatus(options.schedulerStatusFilePath, state);
      await waitUntil(closeoutAt, { clock, sleeper, stopControl });

      if (stopControl.requested) {
        break;
      }
      let completed = false;
      for (let attempt = 1; attempt <= options.maxAttemptsPerDay; attempt += 1) {
        Object.assign(state, {
          status: "running",
          currentAttempt: attempt,
          waitingUntil: null,
          lastFailure: null,
          updatedAt: clock().toISOString(),
        });
        await writeSchedulerStatus(options.schedulerStatusFilePath, state);
        try {
          const closeout = await runProductionDayCloseoutCli(createCloseoutArgs(options, day), {
            clock,
            stdout: { write() {} },
          });
          if (closeout.exitCode !== 0 || closeout.summary?.status !== "passed") {
            throw new Error("production day closeout이 passed 상태를 반환하지 않았습니다.");
          }
          state.completedDays.push(day);
          Object.assign(state, {
            status: "day_completed",
            currentAttempt: attempt,
            lastCompletedAt: clock().toISOString(),
            updatedAt: clock().toISOString(),
          });
          await writeSchedulerStatus(options.schedulerStatusFilePath, state);
          await appendSchedulerEvent(options.schedulerEventLogFilePath, {
            type: "production_day_completed",
            occurredAt: clock().toISOString(),
            day,
            attempt,
            artifactFile: `production-day-${day}.json`,
          });
          completed = true;
          break;
        } catch (error) {
          const retryable = attempt < options.maxAttemptsPerDay;
          // provider/heartbeat 지연은 같은 day idempotency key로만 재시도해 누락을 막고 다음 day로 조용히 건너뛰지 않는다.
          Object.assign(state, {
            status: retryable ? "retry_wait" : "failed",
            currentAttempt: attempt,
            waitingUntil: retryable ? new Date(clock().getTime() + options.retryDelayMs).toISOString() : null,
            lastFailure: {
              name: safeErrorName(error),
              action: retryable
                ? "같은 기준일 closeout을 재시도합니다."
                : "운영자가 daemon, DB, provider, Telegram evidence를 확인해야 합니다.",
            },
            updatedAt: clock().toISOString(),
          });
          await writeSchedulerStatus(options.schedulerStatusFilePath, state);
          await appendSchedulerEvent(options.schedulerEventLogFilePath, {
            type: retryable ? "production_day_retry_planned" : "production_day_failed",
            occurredAt: clock().toISOString(),
            day,
            attempt,
            errorName: safeErrorName(error),
          });
          if (!retryable) {
            throw new Error(`${day} production day closeout 재시도 한도를 초과했습니다.`);
          }
          await waitFor(options.retryDelayMs, { clock, sleeper, stopControl });
          if (stopControl.requested) {
            break;
          }
        }
      }
      if (!completed || stopControl.requested) {
        break;
      }
    }

    if (stopControl.requested) {
      Object.assign(state, {
        status: "stopped",
        waitingUntil: null,
        stopSignal: stopControl.signal,
        updatedAt: clock().toISOString(),
      });
      await writeSchedulerStatus(options.schedulerStatusFilePath, state);
      await appendSchedulerEvent(options.schedulerEventLogFilePath, {
        type: "scheduler_stopped",
        occurredAt: clock().toISOString(),
        signal: stopControl.signal,
      });
      return { exitCode: 0, state };
    }

    Object.assign(state, {
      status: "completed",
      currentDay: null,
      currentAttempt: 0,
      waitingUntil: null,
      completedAt: clock().toISOString(),
      updatedAt: clock().toISOString(),
    });
    await writeSchedulerStatus(options.schedulerStatusFilePath, state);
    await appendSchedulerEvent(options.schedulerEventLogFilePath, {
      type: "scheduler_completed",
      occurredAt: clock().toISOString(),
      completedDays: state.completedDays,
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    }
    return { exitCode: 0, state };
  } catch (error) {
    if (state.status !== "failed") {
      Object.assign(state, {
        status: "failed",
        waitingUntil: null,
        lastFailure: {
          name: safeErrorName(error),
          action: "운영자가 scheduler 입력과 일별 closeout evidence를 확인해야 합니다.",
        },
        updatedAt: clock().toISOString(),
      });
      await writeSchedulerStatus(options.schedulerStatusFilePath, state);
    }
    throw error;
  } finally {
    removeSignalHandlers();
  }
}

/**
 * production day scheduler CLI 인자를 구조화한다.
 *
 * 날짜, 재시도 상한, 운영 파일 경로만 파싱하며 provider나 파일 system side effect는 만들지 않는다. 알 수 없는 인자를 거부해
 * 잘못된 daemon/status 경계로 실행되는 것을 막는다.
 */
export function parseProductionDaySchedulerArgs(argv) {
  const options = {
    firstDay: undefined,
    dayCount: defaultDayCount,
    closeoutDelayMs: defaultCloseoutDelayMs,
    retryDelayMs: defaultRetryDelayMs,
    maxAttemptsPerDay: defaultMaxAttemptsPerDay,
    configPath: undefined,
    envFilePath: undefined,
    daemonStatusFilePath: undefined,
    startupArtifactFilePath: undefined,
    daemonPidFilePath: undefined,
    artifactDir: undefined,
    expectedSourceCommitSha: undefined,
    schedulerStatusFilePath: undefined,
    schedulerEventLogFilePath: undefined,
    schedulerPidFilePath: undefined,
    fixtureSmoke: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--first-day":
        options.firstDay = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--day-count":
        options.dayCount = parsePositiveInteger(readArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--closeout-delay-ms":
        options.closeoutDelayMs = parseNonNegativeInteger(readArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--retry-delay-ms":
        options.retryDelayMs = parsePositiveInteger(readArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--max-attempts-per-day":
        options.maxAttemptsPerDay = parsePositiveInteger(readArgValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--config":
        options.configPath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--env-file":
        options.envFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--daemon-status-file":
        options.daemonStatusFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--startup-artifact-file":
        options.startupArtifactFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--daemon-pid-file":
        options.daemonPidFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--artifact-dir":
        options.artifactDir = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--expected-source-commit-sha":
        options.expectedSourceCommitSha = readArgValue(argv, index, arg).toLowerCase();
        index += 1;
        break;
      case "--scheduler-status-file":
        options.schedulerStatusFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--scheduler-event-log-file":
        options.schedulerEventLogFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--scheduler-pid-file":
        options.schedulerPidFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`알 수 없는 인자입니다: ${arg}`);
    }
  }
  if (options.firstDay !== undefined) {
    createKstDayWindow(options.firstDay);
  }
  return options;
}

/** KST 달력 날짜를 건너뛰지 않고 지정 개수만큼 만든다. 외부 side effect는 없다. */
export function createDaySequence(firstDay, dayCount) {
  createKstDayWindow(firstDay);
  const firstDayMs = Date.parse(`${firstDay}T00:00:00.000Z`);
  return Array.from({ length: dayCount }, (_, index) => new Date(firstDayMs + index * 86_400_000).toISOString().slice(0, 10));
}

function createCloseoutArgs(options, day) {
  if (options.fixtureSmoke) {
    return ["--fixture-smoke", "--day", day, "--artifact-dir", options.artifactDir, "--json"];
  }
  return [
    "--day", day,
    "--config", options.configPath,
    "--env-file", options.envFilePath,
    "--status-file", options.daemonStatusFilePath,
    "--startup-artifact-file", options.startupArtifactFilePath,
    "--pid-file", options.daemonPidFilePath,
    "--scheduler-event-log-file", options.schedulerEventLogFilePath,
    "--first-day", options.firstDay,
    "--artifact-dir", options.artifactDir,
    "--expected-source-commit-sha", options.expectedSourceCommitSha,
    "--json",
  ];
}

function createInitialState(options, now) {
  return {
    schemaVersion: 1,
    issue: 267,
    kind: "m23_production_day_scheduler",
    status: "starting",
    processId: process.pid,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    firstDay: options.firstDay,
    dayCount: options.dayCount,
    currentDay: null,
    currentAttempt: 0,
    waitingUntil: null,
    completedDays: [],
    lastFailure: null,
  };
}

async function waitUntil(target, context) {
  while (!context.stopControl.requested) {
    const remainingMs = target.getTime() - context.clock().getTime();
    if (remainingMs <= 0) {
      return;
    }
    await context.sleeper(Math.min(remainingMs, maxSleepChunkMs), context.stopControl);
  }
}

async function waitFor(durationMs, context) {
  const target = new Date(context.clock().getTime() + durationMs);
  await waitUntil(target, context);
}

function sleep(durationMs, stopControl) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stopControl.wake = undefined;
      resolve();
    }, durationMs);
    stopControl.wake = () => {
      clearTimeout(timer);
      stopControl.wake = undefined;
      resolve();
    };
  });
}

function createStopControl() {
  return { requested: false, signal: null, wake: undefined };
}

function installSignalHandlers(stopControl) {
  const handle = (signal) => {
    if (!stopControl.requested) {
      stopControl.requested = true;
      stopControl.signal = signal;
      stopControl.wake?.();
    }
  };
  const sigterm = () => handle("SIGTERM");
  const sigint = () => handle("SIGINT");
  process.once("SIGTERM", sigterm);
  process.once("SIGINT", sigint);
  return () => {
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
  };
}

async function createSchedulerPidFile(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // 동시에 두 scheduler가 같은 날짜의 Telegram report 경계를 호출하지 않도록 PID 파일은 create-only로 고정한다.
  await writeFile(filePath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function assertActualSchedulerPreflight(options) {
  if (!sourceShaPattern.test(options.expectedSourceCommitSha)) {
    throw new Error("expected source commit SHA가 40자리 lowercase hex가 아닙니다.");
  }
  await Promise.all([
    access(options.configPath),
    access(options.envFilePath),
    access(options.daemonStatusFilePath),
    access(options.startupArtifactFilePath),
    access(options.daemonPidFilePath),
    ...requiredBuildFiles.map((filePath) => access(filePath)),
  ]);
  const [statusRaw, startupRaw, pidRaw] = await Promise.all([
    readFile(options.daemonStatusFilePath, "utf8"),
    readFile(options.startupArtifactFilePath, "utf8"),
    readFile(options.daemonPidFilePath, "utf8"),
  ]);
  const status = JSON.parse(statusRaw);
  const startup = JSON.parse(startupRaw);
  if (status.status !== "running" || status.latestSummary?.status !== "ready") {
    throw new Error("daemon latest status가 running/ready가 아닙니다.");
  }
  if (status.startupArtifactFilePath !== options.startupArtifactFilePath) {
    throw new Error("daemon status와 scheduler startup artifact 경로가 다릅니다.");
  }
  if (JSON.stringify(status.runtimeProvenance) !== JSON.stringify(startup.runtimeProvenance)) {
    throw new Error("startup/status runtime provenance가 다릅니다.");
  }
  if (status.runtimeProvenance?.sourceCommitSha !== options.expectedSourceCommitSha) {
    throw new Error("daemon source commit SHA가 scheduler rollout SHA와 다릅니다.");
  }
  const pid = Number(pidRaw.trim());
  assertProcessRunning(pid);
}

/**
 * KST day 경계에서 daemon 누적 counter snapshot을 append-only event로 한 번만 기록한다.
 *
 * 같은 `boundaryAt` event가 있으면 다음 날짜나 scheduler 재개가 이를 재사용한다. 새 event는 경계 직후의 같은 daemon/source,
 * 경계 이전 최신 heartbeat, 살아 있는 PID를 확인한 뒤에만 기록하며 scheduler event log 외 side effect는 없다.
 */
export async function ensureDaemonCounterBoundary({
  options,
  boundaryAt,
  clock = () => new Date(),
  sleeper = sleep,
  stopControl = createStopControl(),
}) {
  const eventLogRaw = await readFile(options.schedulerEventLogFilePath, "utf8");
  const events = eventLogRaw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`scheduler event log ${index + 1}번째 줄이 JSON이 아닙니다.`);
      }
    });
  const existing = events.filter((event) => event?.type === "daemon_counter_boundary" && event.boundaryAt === boundaryAt);
  if (existing.length > 1) {
    throw new Error(`${boundaryAt} daemon counter boundary가 중복 기록됐습니다.`);
  }
  if (existing.length === 1) {
    return existing[0];
  }

  const boundaryMs = Date.parse(boundaryAt);
  if (!Number.isFinite(boundaryMs)) {
    throw new Error("daemon counter boundary 시각이 올바른 ISO timestamp가 아닙니다.");
  }
  let captured;
  while (!stopControl.requested) {
    const observedAt = clock();
    const [status, statusFileStat] = await Promise.all([
      readJsonFile(options.daemonStatusFilePath),
      stat(options.daemonStatusFilePath),
    ]);
    const latestTickMs = Date.parse(status.latestTickStartedAt);
    if (Number.isFinite(latestTickMs) && latestTickMs <= boundaryMs) {
      captured = { status, observedAt };
    }
    const crossedBoundary = observedAt.getTime() >= boundaryMs;
    const preBoundaryTickCommittedAfterBoundary = crossedBoundary
      && latestTickMs <= boundaryMs
      && statusFileStat.mtimeMs >= boundaryMs;
    const postBoundaryTickCommitted = crossedBoundary && latestTickMs > boundaryMs;
    if (preBoundaryTickCommittedAfterBoundary || (postBoundaryTickCommitted && captured !== undefined)) {
      // 경계를 걸친 tick의 counter write 또는 다음 tick write를 확인한 뒤에야 이전 day snapshot을 확정한다.
      break;
    }
    if (observedAt.getTime() - boundaryMs > boundaryCaptureToleranceMs) {
      throw new Error(`${boundaryAt} daemon counter boundary의 최종 status write를 60초 안에 확인하지 못했습니다.`);
    }
    const remainingMs = Math.max(boundaryMs - observedAt.getTime(), 0);
    await sleeper(remainingMs > 0 ? Math.min(remainingMs, boundaryCapturePollMs) : boundaryCapturePollMs, stopControl);
  }
  if (stopControl.requested) {
    throw new Error("daemon counter boundary 기록 전에 scheduler stop이 요청됐습니다.");
  }
  const now = clock();
  if (now.getTime() - boundaryMs > boundaryCaptureToleranceMs) {
    throw new Error(`${boundaryAt} daemon counter boundary를 60초 안에 기록하지 못했습니다.`);
  }
  if (captured === undefined) {
    throw new Error("daemon counter boundary 이전의 마지막 status snapshot을 확보하지 못했습니다.");
  }
  const status = captured.status;
  const [startup, pidText] = await Promise.all([
    readJsonFile(options.startupArtifactFilePath),
    readFile(options.daemonPidFilePath, "utf8"),
  ]);
  if (status.status !== "running" || status.latestError !== null || status.latestSummary?.status !== "ready") {
    throw new Error("daemon counter boundary에서 latest status가 running/ready가 아닙니다.");
  }
  if (status.startupArtifactFilePath !== options.startupArtifactFilePath
    || JSON.stringify(status.runtimeProvenance) !== JSON.stringify(startup.runtimeProvenance)
    || status.runtimeProvenance?.sourceCommitSha !== options.expectedSourceCommitSha) {
    throw new Error("daemon counter boundary의 startup/source provenance가 scheduler 입력과 다릅니다.");
  }
  const latestTickMs = Date.parse(status.latestTickStartedAt);
  if (!Number.isFinite(latestTickMs) || latestTickMs > boundaryMs || boundaryMs - latestTickMs > boundaryHeartbeatLagMs) {
    throw new Error("daemon counter boundary의 최신 heartbeat가 경계 이전 2분 범위를 충족하지 않습니다.");
  }
  const pid = Number(pidText.trim());
  assertProcessRunning(pid);
  const counters = Object.fromEntries(daemonCounterNames.map((name) => [
    name,
    readNonNegativeSafeInteger(status.counters?.[name], name),
  ]));
  const event = {
    type: "daemon_counter_boundary",
    boundaryAt,
    observedAt: now.toISOString(),
    snapshotObservedAt: captured.observedAt.toISOString(),
    daemonStartedAt: status.startedAt,
    latestTickStartedAt: status.latestTickStartedAt,
    sourceCommitSha: status.runtimeProvenance.sourceCommitSha,
    processId: pid,
    counters,
  };
  await appendSchedulerEvent(options.schedulerEventLogFilePath, event);
  return event;
}

function assertDistinctSchedulerOutputs(options) {
  const outputs = [
    options.schedulerStatusFilePath,
    options.schedulerEventLogFilePath,
    options.schedulerPidFilePath,
  ].map((filePath) => path.resolve(filePath));
  if (new Set(outputs).size !== outputs.length) {
    throw new Error("scheduler status, event log, PID는 서로 다른 경로여야 합니다.");
  }
  const protectedInputs = [
    options.configPath,
    options.envFilePath,
    options.daemonStatusFilePath,
    options.startupArtifactFilePath,
    options.daemonPidFilePath,
  ].map((filePath) => path.resolve(filePath));
  if (outputs.some((filePath) => protectedInputs.includes(filePath))) {
    throw new Error("scheduler 출력은 config/env/daemon evidence 경로를 덮어쓸 수 없습니다.");
  }
  const artifactDir = path.resolve(options.artifactDir);
  if (outputs.includes(artifactDir)) {
    throw new Error("scheduler 운영 파일 경로와 day artifact 디렉터리는 같을 수 없습니다.");
  }
}

async function writeSchedulerStatus(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

async function appendSchedulerEvent(filePath, event) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function assertActualOptions(options) {
  const required = [
    ["--first-day", options.firstDay],
    ["--config", options.configPath],
    ["--env-file", options.envFilePath],
    ["--daemon-status-file", options.daemonStatusFilePath],
    ["--startup-artifact-file", options.startupArtifactFilePath],
    ["--daemon-pid-file", options.daemonPidFilePath],
    ["--artifact-dir", options.artifactDir],
    ["--expected-source-commit-sha", options.expectedSourceCommitSha],
    ["--scheduler-status-file", options.schedulerStatusFilePath],
    ["--scheduler-event-log-file", options.schedulerEventLogFilePath],
    ["--scheduler-pid-file", options.schedulerPidFilePath],
  ];
  const missing = required.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`필수 인자가 없습니다: ${missing.join(", ")}`);
  }
}

function assertFixtureOptions(options) {
  const required = [
    ["--first-day", options.firstDay],
    ["--artifact-dir", options.artifactDir],
    ["--scheduler-status-file", options.schedulerStatusFilePath],
    ["--scheduler-event-log-file", options.schedulerEventLogFilePath],
    ["--scheduler-pid-file", options.schedulerPidFilePath],
  ];
  const missing = required.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`fixture 필수 인자가 없습니다: ${missing.join(", ")}`);
  }
}

function assertPathOutsideRepository(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("actual scheduler 운영 파일은 저장소 밖 경로에만 기록할 수 있습니다.");
  }
}

function readArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}

function parsePositiveInteger(value, arg) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${arg}는 양의 정수여야 합니다.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, arg) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${arg}는 0 이상의 정수여야 합니다.`);
  }
  return parsed;
}

function readNonNegativeSafeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} daemon counter가 0 이상의 안전한 정수가 아닙니다.`);
  }
  return parsed;
}

function assertProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("daemon supervisor PID가 올바르지 않습니다.");
  }
  try {
    process.kill(pid, 0);
  } catch {
    throw new Error("daemon supervisor process가 실행 중이 아닙니다.");
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function safeErrorName(error) {
  return error instanceof Error && error.name.length > 0 ? error.name : "Error";
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function formatProductionDaySchedulerHelp() {
  return `Usage: node scripts/run-m23-production-day-scheduler.mjs [options]

  --first-day <YYYY-MM-DD>             첫 completed KST 기준일
  --day-count <count>                  연속 수집 날짜 수, 기본 7
  --closeout-delay-ms <ms>             KST day 종료 후 첫 실행 지연, 기본 60000
  --retry-delay-ms <ms>                실패 뒤 같은 day 재시도 지연, 기본 300000
  --max-attempts-per-day <count>       day별 최대 시도 수, 기본 36
  --config <path>                      production live ops config
  --env-file <path>                    production live ops env
  --daemon-status-file <path>          daemon latest status
  --startup-artifact-file <path>       현재 daemon create-only startup artifact
  --daemon-pid-file <path>             daemon supervisor PID file
  --artifact-dir <path>                production day artifact 디렉터리
  --expected-source-commit-sha <sha>    rollout daemon source SHA
  --scheduler-status-file <path>        scheduler latest status
  --scheduler-event-log-file <path>     scheduler append-only event log
  --scheduler-pid-file <path>           scheduler create-only PID file
  --fixture-smoke                       외부 provider 없이 scheduler contract 실행
  --json                                완료 상태 JSON 출력
`;
}
