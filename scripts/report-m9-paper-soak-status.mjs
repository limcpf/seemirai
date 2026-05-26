#!/usr/bin/env node
import { access, open as openFile, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper", "trading-soak");
const artifactNamePattern =
  /^(m9-paper-trading-soak-.+?-[0-9a-f]{8})(?:-day-(\d+))?-(summary\.json|report\.md|events\.jsonl)$/u;
const defaultExpectedDayCount = 3;
const rawTailBytes = 1024 * 1024;
const rawTailLineLimit = 2_000;

try {
  await main();
} catch (error) {
  process.stderr.write(`M9 paper soak 상태 확인 실패: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const status = await reportStatus(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(renderTextStatus(status));
  }

  if (status.statusCode === "unavailable") {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    artifactDir: defaultArtifactDir,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact-dir":
        options.artifactDir = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.artifactDir = path.resolve(arg);
        break;
    }
  }

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function reportStatus(options) {
  const artifactDir = path.resolve(options.artifactDir);
  const discovered = await discoverRuns(artifactDir);
  if (discovered.statusCode === "unavailable") {
    return createUnavailableStatus({ artifactDir, reason: discovered.reason, detail: discovered.detail });
  }

  const selectedRun = selectLatestRun(discovered.runs);
  if (selectedRun === null) {
    return createUnavailableStatus({
      artifactDir,
      reason: "artifact_not_found",
      detail: "M9 paper soak artifact 파일을 찾지 못했다.",
    });
  }

  return buildRunStatus({ artifactDir, run: selectedRun });
}

async function discoverRuns(artifactDir) {
  try {
    await access(artifactDir);
  } catch (error) {
    return {
      statusCode: "unavailable",
      reason: "artifact_dir_missing",
      detail: toErrorMessage(error),
    };
  }

  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    return {
      statusCode: "unavailable",
      reason: "artifact_dir_unreadable",
      detail: toErrorMessage(error),
    };
  }

  const runs = new Map();
  await Promise.all(
    entries.map(async (entry) => {
      const parsed = parseArtifactName(entry.name);
      if (parsed === null) {
        return;
      }
      const filePath = path.join(artifactDir, entry.name);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        // 장시간 runner가 artifact를 교체/정리하는 순간에는 해당 entry만 건너뛰어 상태 JSON 생성을 유지한다.
        return;
      }
      if (!fileStat.isFile()) {
        return;
      }
      const run = getOrCreateRun(runs, parsed.prefix);
      run.latestMtimeMs = Math.max(run.latestMtimeMs, fileStat.mtimeMs);
      run.files.push({
        path: filePath,
        kind: parsed.kind,
        dayIndex: parsed.dayIndex,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
      assignRunFile(run, filePath, parsed);
    }),
  );

  return {
    statusCode: "ok",
    runs: [...runs.values()],
  };
}

function parseArtifactName(fileName) {
  const match = artifactNamePattern.exec(fileName);
  if (match === null) {
    return null;
  }

  const [, prefix, day, suffix] = match;
  const dayIndex = day === undefined ? null : Number(day);
  if (dayIndex !== null && (!Number.isInteger(dayIndex) || dayIndex < 1)) {
    return null;
  }

  return {
    prefix,
    dayIndex,
    kind: suffix,
  };
}

function getOrCreateRun(runs, prefix) {
  const existing = runs.get(prefix);
  if (existing !== undefined) {
    return existing;
  }

  const run = {
    prefix,
    latestMtimeMs: 0,
    files: [],
    summaryPath: null,
    reportPath: null,
    rawLogPath: null,
    dailySummaryPaths: new Map(),
    dailyReportPaths: new Map(),
  };
  runs.set(prefix, run);
  return run;
}

function assignRunFile(run, filePath, parsed) {
  if (parsed.kind === "events.jsonl") {
    run.rawLogPath = filePath;
    return;
  }

  if (parsed.kind === "summary.json" && parsed.dayIndex === null) {
    run.summaryPath = filePath;
    return;
  }

  if (parsed.kind === "report.md" && parsed.dayIndex === null) {
    run.reportPath = filePath;
    return;
  }

  if (parsed.kind === "summary.json" && parsed.dayIndex !== null) {
    run.dailySummaryPaths.set(parsed.dayIndex, filePath);
    return;
  }

  if (parsed.kind === "report.md" && parsed.dayIndex !== null) {
    run.dailyReportPaths.set(parsed.dayIndex, filePath);
  }
}

function selectLatestRun(runs) {
  if (runs.length === 0) {
    return null;
  }

  return [...runs].sort((left, right) => {
    if (right.latestMtimeMs !== left.latestMtimeMs) {
      return right.latestMtimeMs - left.latestMtimeMs;
    }
    return right.prefix.localeCompare(left.prefix);
  })[0];
}

async function buildRunStatus({ artifactDir, run }) {
  const aggregate = await readJsonArtifact(run.summaryPath);
  const dailySummaries = await readDailySummaries(run.dailySummaryPaths);
  const rawLogPath = resolveRawLogPath({ run, aggregate: aggregate.value });
  const rawLog = await readRecentRawEvents(rawLogPath);
  const rawEvents = rawLog.events;
  const expectedDayCount = resolveExpectedDayCount({ aggregate: aggregate.value, run });
  const daySummaryStatus = createDaySummaryStatus({ run, aggregate: aggregate.value, dailySummaries, expectedDayCount });
  const timing = resolveTiming({ run, aggregate: aggregate.value, rawEvents, expectedDayCount });
  const recentSkips = readRecentSkips(rawEvents);
  const recentFailures = readRecentFailures({ rawEvents, aggregate, rawLog, daySummaryStatus });
  const statusCode = resolveStatusCode({ run, aggregate, rawEvents, rawLog, daySummaryStatus });
  const statusLabel = toStatusLabel(statusCode);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifactDir,
    statusCode,
    statusLabel,
    operatorMessage: createOperatorMessage({ statusCode, aggregate, rawEvents, recentFailures }),
    action: createOperatorAction({ statusCode, recentFailures }),
    progress: {
      elapsedMs: timing.elapsedMs,
      elapsedText: formatDuration(timing.elapsedMs),
      requestedDurationMs: timing.requestedDurationMs,
      requestedDurationText: timing.requestedDurationMs === null ? null : formatDuration(timing.requestedDurationMs),
      startedAt: timing.startedAt,
      finishedAt: timing.finishedAt,
      lastEventAt: timing.lastEventAt,
      lastEventLabel: toEventKindLabel(timing.lastEventKind),
      currentDay: timing.currentDay,
      expectedDayCount,
      daySummaryGeneratedCount: daySummaryStatus.filter((day) => day.generated).length,
      daySummaries: daySummaryStatus,
    },
    metrics: readKeyMetrics(aggregate.value),
    signals: {
      recentSkips,
      recentFailures,
    },
    artifacts: {
      prefix: run.prefix,
      rawLogPath,
      summaryPath: run.summaryPath,
      reportPath: run.reportPath,
      dailySummaryPaths: daySummaryStatus.map((day) => ({
        day: day.day,
        path: day.summaryPath,
        generated: day.generated,
        status: day.status,
      })),
      dailyReportPaths: sortedDayPaths(run.dailyReportPaths).map(([day, reportPath]) => ({ day, reportPath })),
    },
    trace: {
      aggregateSummaryReadable: aggregate.ok,
      aggregateSummaryError: aggregate.error,
      rawLogReadable: rawLog.error === null,
      rawLogError: rawLog.error,
      recentRawEventCount: rawEvents.length,
    },
  };
}

function resolveRawLogPath({ run, aggregate }) {
  if (run.rawLogPath !== null) {
    return run.rawLogPath;
  }
  if (aggregate?.status === "skipped") {
    return null;
  }
  const rawLogPath = aggregate?.artifacts?.rawLogPath;
  return typeof rawLogPath === "string" && rawLogPath.length > 0 ? rawLogPath : null;
}

function createUnavailableStatus({ artifactDir, reason, detail }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    artifactDir,
    statusCode: "unavailable",
    statusLabel: "확인 불가",
    operatorMessage: "M9 paper soak artifact를 아직 찾지 못해 진행 상태를 판정할 수 없다.",
    action: "artifact 디렉터리 경로가 맞는지 확인한 뒤 runner가 한 번 이상 시작됐는지 확인한다.",
    progress: {
      elapsedMs: null,
      elapsedText: null,
      requestedDurationMs: null,
      requestedDurationText: null,
      startedAt: null,
      finishedAt: null,
      lastEventAt: null,
      lastEventLabel: null,
      currentDay: null,
      expectedDayCount: defaultExpectedDayCount,
      daySummaryGeneratedCount: 0,
      daySummaries: [],
    },
    metrics: readKeyMetrics(null),
    signals: {
      recentSkips: [],
      recentFailures: [
        {
          message: "상태 확인에 필요한 artifact가 없다.",
          occurredAt: null,
          detail,
        },
      ],
    },
    artifacts: {
      prefix: null,
      rawLogPath: null,
      summaryPath: null,
      reportPath: null,
      dailySummaryPaths: [],
      dailyReportPaths: [],
    },
    trace: {
      reason,
      detail,
    },
  };
}

async function readJsonArtifact(filePath) {
  if (filePath === null) {
    return { ok: false, value: null, error: null };
  }

  try {
    const raw = await readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    return { ok: false, value: null, error: toErrorMessage(error) };
  }
}

async function readDailySummaries(dailySummaryPaths) {
  const summaries = new Map();
  await Promise.all(
    sortedDayPaths(dailySummaryPaths).map(async ([day, filePath]) => {
      summaries.set(day, await readJsonArtifact(filePath));
    }),
  );
  return summaries;
}

async function readRecentRawEvents(rawLogPath) {
  if (rawLogPath === null) {
    return { events: [], error: null };
  }

  let lines;
  try {
    lines = await readTailLines(rawLogPath, rawTailBytes, rawTailLineLimit);
  } catch (error) {
    return { events: [], error: toErrorMessage(error) };
  }
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event !== null && typeof event === "object") {
        events.push(event);
      }
    } catch {
      // tail 첫 줄은 파일 중간에서 시작할 수 있으므로 깨진 JSON line은 최근 상태 근거에서 제외한다.
    }
  }
  return { events, error: null };
}

async function readTailLines(filePath, maxBytes, maxLines) {
  const handle = await openFile(filePath, "r");
  try {
    const fileStat = await handle.stat();
    const byteLength = Math.min(fileStat.size, maxBytes);
    const buffer = Buffer.alloc(byteLength);
    if (byteLength > 0) {
      await handle.read(buffer, 0, byteLength, fileStat.size - byteLength);
    }
    return buffer.toString("utf8").split(/\r?\n/u).filter(Boolean).slice(-maxLines);
  } finally {
    await handle.close();
  }
}

function resolveExpectedDayCount({ aggregate, run }) {
  const aggregateDailyPaths = aggregate?.artifacts?.dailySummaryPaths;
  if (Array.isArray(aggregateDailyPaths) && aggregateDailyPaths.length > 0) {
    return aggregateDailyPaths.length;
  }

  const discoveredMaxDay = Math.max(0, ...run.dailySummaryPaths.keys(), ...run.dailyReportPaths.keys());
  return discoveredMaxDay > 0 ? discoveredMaxDay : defaultExpectedDayCount;
}

function createDaySummaryStatus({ run, aggregate, dailySummaries, expectedDayCount }) {
  const aggregatePaths = Array.isArray(aggregate?.artifacts?.dailySummaryPaths)
    ? aggregate.artifacts.dailySummaryPaths
    : [];
  const statuses = [];
  for (let day = 1; day <= expectedDayCount; day += 1) {
    const discoveredPath = run.dailySummaryPaths.get(day) ?? null;
    const summaryPath = discoveredPath ?? aggregatePaths[day - 1] ?? expectedDailySummaryPath(run.prefix, day, run);
    const summary = dailySummaries.get(day);
    statuses.push({
      day,
      generated: discoveredPath !== null,
      readable: summary?.ok ?? false,
      status: summary?.value?.status ?? null,
      error: summary?.error ?? null,
      summaryPath,
      reportPath: run.dailyReportPaths.get(day) ?? null,
      startedAt: summary?.value?.startedAt ?? null,
      finishedAt: summary?.value?.finishedAt ?? null,
    });
  }
  return statuses;
}

function expectedDailySummaryPath(prefix, day, run) {
  const rawPath = run.rawLogPath ?? run.summaryPath ?? run.reportPath;
  if (rawPath === null) {
    return null;
  }
  return path.join(path.dirname(rawPath), `${prefix}-day-${day}-summary.json`);
}

function resolveTiming({ run, aggregate, rawEvents, expectedDayCount }) {
  const startedAt = readTimestamp(aggregate?.startedAt) ?? parseStartedAtFromPrefix(run.prefix);
  const finishedAt = readTimestamp(aggregate?.finishedAt);
  const lastEvent = rawEvents.length > 0 ? rawEvents[rawEvents.length - 1] : null;
  const lastEventAt = readEventTimestamp(lastEvent) ?? finishedAt;
  const nowMs = Date.now();
  const startedAtMs = startedAt === null ? null : Date.parse(startedAt);
  const finishedAtMs = finishedAt === null ? null : Date.parse(finishedAt);
  const lastEventMs = lastEventAt === null ? null : Date.parse(lastEventAt);
  const requestedDurationMs = readFiniteNumber(aggregate?.durationMsRequested);
  const elapsedMs = resolveElapsedMs({ startedAtMs, finishedAtMs, lastEventMs, nowMs, aggregate });
  const currentDay = resolveCurrentDay({ elapsedMs, requestedDurationMs, expectedDayCount });

  return {
    startedAt,
    finishedAt,
    lastEventAt,
    lastEventKind: typeof lastEvent?.kind === "string" ? lastEvent.kind : null,
    requestedDurationMs,
    elapsedMs,
    currentDay,
  };
}

function resolveElapsedMs({ startedAtMs, finishedAtMs, lastEventMs, nowMs, aggregate }) {
  const observed = readFiniteNumber(aggregate?.durationMsObserved);
  if (observed !== null) {
    return observed;
  }
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) {
    return null;
  }
  const endMs = finishedAtMs ?? lastEventMs ?? nowMs;
  if (!Number.isFinite(endMs)) {
    return null;
  }
  return Math.max(0, endMs - startedAtMs);
}

function resolveCurrentDay({ elapsedMs, requestedDurationMs, expectedDayCount }) {
  if (elapsedMs === null || requestedDurationMs === null || expectedDayCount < 1) {
    return null;
  }
  const dayMs = requestedDurationMs / expectedDayCount;
  if (!Number.isFinite(dayMs) || dayMs <= 0) {
    return null;
  }
  return Math.min(expectedDayCount, Math.floor(elapsedMs / dayMs) + 1);
}

function readEventTimestamp(event) {
  if (event === null || typeof event !== "object") {
    return null;
  }
  return (
    readTimestamp(event.occurredAt) ??
    readTimestamp(event.finishedAt) ??
    readTimestamp(event.startedAt) ??
    readTimestamp(event.receivedAt) ??
    readTimestamp(event.timestamp)
  );
}

function readTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseStartedAtFromPrefix(prefix) {
  const match =
    /^m9-paper-trading-soak-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)-[0-9a-f]{8}$/u.exec(prefix);
  if (match === null) {
    return null;
  }
  const [, dateHour, minute, second, milli] = match;
  return readTimestamp(`${dateHour}:${minute}:${second}.${milli}`);
}

function readRecentSkips(rawEvents) {
  return rawEvents
    .filter((event) => event.kind === "CYCLE_SKIPPED")
    .slice(-5)
    .reverse()
    .map((event) => ({
      message: toSkipReasonMessage(event.reason),
      occurredAt: readEventTimestamp(event),
      reasonCode: typeof event.reason === "string" ? event.reason : null,
      orderbookStalenessMs: readFiniteNumber(event.orderbookStalenessMs),
    }));
}

function readRecentFailures({ rawEvents, aggregate, rawLog, daySummaryStatus }) {
  const failures = [];
  if (rawLog.error !== null) {
    failures.push({
      message: "raw log를 읽지 못해 최근 진행 상태가 제한적으로만 확인된다.",
      occurredAt: null,
      detail: rawLog.error,
    });
  }

  for (const event of rawEvents) {
    if (event.kind === "RUNNER_FATAL" || event.status === "ERROR") {
      failures.push({
        message: "runner가 실패 event를 raw log에 기록했다.",
        occurredAt: readEventTimestamp(event),
        detail: typeof event.message === "string" ? event.message : null,
      });
    }
  }

  if (aggregate.error !== null) {
    failures.push({
      message: "aggregate summary JSON을 읽지 못했다.",
      occurredAt: null,
      detail: aggregate.error,
    });
  }

  if (aggregate.value?.status === "failed") {
    failures.push(...readFailedChecks(aggregate.value.checks, aggregate.value.finishedAt));
  }

  if (aggregate.value !== null && normalizeSummaryStatus(aggregate.value.status) !== "skipped") {
    failures.push(...readDaySummaryEvidenceFailures(daySummaryStatus, aggregate.value.finishedAt));
  }

  return failures.slice(-8).reverse();
}

function readDaySummaryEvidenceFailures(daySummaryStatus, occurredAt) {
  const failures = [];
  for (const daySummary of daySummaryStatus) {
    if (!daySummary.generated) {
      failures.push({
        message: `Day ${daySummary.day} summary가 아직 생성되지 않았거나 누락됐다.`,
        occurredAt: readTimestamp(occurredAt),
        detail: daySummary.summaryPath,
      });
      continue;
    }
    if (!daySummary.readable) {
      failures.push({
        message: `Day ${daySummary.day} summary JSON을 읽지 못했다.`,
        occurredAt: readTimestamp(occurredAt),
        detail: daySummary.error,
      });
      continue;
    }
    if (daySummary.status === "failed") {
      failures.push({
        message: `Day ${daySummary.day} summary가 실패 상태다.`,
        occurredAt: readTimestamp(daySummary.finishedAt ?? occurredAt),
        detail: daySummary.summaryPath,
      });
    }
  }
  return failures;
}

function readFailedChecks(checks, occurredAt) {
  if (checks === null || typeof checks !== "object") {
    return [];
  }

  return Object.entries(checks)
    .filter(([, check]) => check?.status === "fail")
    .map(([name, check]) => ({
      message: typeof check.message === "string" ? check.message : "실패 check가 기록됐다.",
      occurredAt: readTimestamp(occurredAt),
      detail: name,
    }));
}

function resolveStatusCode({ run, aggregate, rawEvents, rawLog, daySummaryStatus }) {
  if (rawLog.error !== null || daySummaryStatus.some((day) => day.generated && !day.readable)) {
    return "failed";
  }
  if (aggregate.value !== null) {
    const aggregateStatus = normalizeSummaryStatus(aggregate.value.status);
    if (aggregateStatus === "passed" && daySummaryStatus.some((day) => !day.generated)) {
      return "incomplete";
    }
    if (aggregateStatus === "passed" && daySummaryStatus.some((day) => day.status === "failed")) {
      return "failed";
    }
    return aggregateStatus;
  }
  if (aggregate.error !== null) {
    return "failed";
  }
  if (run.rawLogPath !== null || rawEvents.length > 0) {
    return "running";
  }
  return "unavailable";
}

function normalizeSummaryStatus(status) {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function readKeyMetrics(summary) {
  const metrics = summary?.metrics;
  return {
    paperTradingCycleAttempts: readFiniteNumber(metrics?.paperTradingCycleAttempts),
    paperTradingCycles: readFiniteNumber(metrics?.paperTradingCycles),
    paperOrderSubmittedCount: readFiniteNumber(metrics?.paperOrderSubmittedCount),
    paperFillCount: readFiniteNumber(metrics?.paperFillCount),
    liveOrderApiCalls: readFiniteNumber(metrics?.liveOrderApiCalls),
    cyclesSkippedNoOrderbook: readFiniteNumber(metrics?.cyclesSkippedNoOrderbook),
    cyclesSkippedStaleOrderbook: readFiniteNumber(metrics?.cyclesSkippedStaleOrderbook),
  };
}

function readFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sortedDayPaths(dayPaths) {
  return [...dayPaths.entries()].sort(([leftDay], [rightDay]) => leftDay - rightDay);
}

function toStatusLabel(statusCode) {
  switch (statusCode) {
    case "running":
      return "진행 중";
    case "passed":
      return "통과";
    case "failed":
      return "실패";
    case "skipped":
      return "시작 안 함";
    case "incomplete":
      return "증거 부족";
    case "unknown":
      return "판정 보류";
    default:
      return "확인 불가";
  }
}

function createOperatorMessage({ statusCode, aggregate, rawEvents, recentFailures }) {
  if (recentFailures.length > 0) {
    return "최근 artifact에서 실패 신호가 확인됐다. 실패 check와 raw log를 우선 확인해야 한다.";
  }
  if (statusCode === "running") {
    return rawEvents.length > 0
      ? "aggregate summary는 아직 없지만 raw log가 갱신되어 실행 중으로 본다."
      : "aggregate summary가 아직 없고 raw log 갱신 근거도 약해 실행 상태 확인이 제한적이다.";
  }
  if (statusCode === "passed") {
    return "aggregate summary가 통과 상태로 기록됐다.";
  }
  if (statusCode === "skipped") {
    return "runner가 안전 guard 때문에 장시간 실행을 시작하지 않았다.";
  }
  if (statusCode === "incomplete") {
    return "aggregate summary는 통과했지만 기대 day summary 증거가 부족해 완료로 판정하지 않는다.";
  }
  if (aggregate.error !== null) {
    return "aggregate summary가 있지만 JSON으로 읽지 못해 상태 판정이 실패했다.";
  }
  return "artifact만으로 상태를 확정하지 못했다.";
}

function createOperatorAction({ statusCode, recentFailures }) {
  if (recentFailures.length > 0) {
    return "실패 check의 원인과 raw log 마지막 event를 확인하고, #68 완료 증거로 쓰기 전에 재실행 또는 수동 판정을 남긴다.";
  }
  if (statusCode === "running") {
    return "마지막 이벤트 시각이 계속 갱신되는지 확인하고, day summary는 runner 종료 후 생성되는지 다시 확인한다.";
  }
  if (statusCode === "passed") {
    return "day summary 3개와 비교 report를 validator 입력으로 넘긴다.";
  }
  if (statusCode === "skipped") {
    return "`SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1` guard를 설정하지 않은 실행인지 확인한다.";
  }
  if (statusCode === "incomplete") {
    return "누락된 day summary 파일을 확인하고 완료 validator를 실행하기 전에 artifact를 복구하거나 재실행한다.";
  }
  return "artifact 경로와 runner 실행 여부를 확인한다.";
}

function toEventKindLabel(kind) {
  switch (kind) {
    case "PAPER_TRADING_CYCLE":
      return "paper cycle 완료";
    case "CYCLE_SKIPPED":
      return "cycle 건너뜀";
    case "RUNNER_FATAL":
      return "runner 실패";
    case "MARKET_DATA":
      return "시장 데이터 수신";
    default:
      return kind === null ? null : "raw log event";
  }
}

function toSkipReasonMessage(reason) {
  switch (reason) {
    case "orderbook_not_ready":
      return "호가가 아직 준비되지 않아 cycle을 건너뛰었다.";
    case "orderbook_stale":
      return "호가가 최신성 기준을 넘어 cycle을 건너뛰었다.";
    default:
      return "cycle을 건너뛴 신호가 있다.";
  }
}

function renderTextStatus(status) {
  const lines = [
    `M9 paper soak 상태: ${status.statusLabel}`,
    `- 현재 판단: ${status.operatorMessage}`,
    `- 필요 조치: ${status.action}`,
    `- 경과 시간: ${renderElapsed(status.progress)}`,
    `- 마지막 이벤트: ${renderLastEvent(status.progress)}`,
    `- day summary: ${status.progress.daySummaryGeneratedCount}/${status.progress.expectedDayCount} 생성`,
  ];

  lines.push(...renderSignalLines(status));
  lines.push(
    "",
    "Artifact",
    `- raw log: ${status.artifacts.rawLogPath ?? "아직 확인되지 않음"}`,
    `- aggregate summary: ${status.artifacts.summaryPath ?? "아직 생성되지 않음"}`,
    `- aggregate report: ${status.artifacts.reportPath ?? "아직 생성되지 않음"}`,
  );
  for (const day of status.artifacts.dailySummaryPaths) {
    lines.push(`- Day ${day.day} summary: ${day.generated ? day.path : "아직 생성되지 않음"}`);
  }
  lines.push(
    "",
    "추적 정보",
    `- statusCode: ${status.statusCode}`,
    `- artifactPrefix: ${status.artifacts.prefix ?? "n/a"}`,
    `- recentRawEventCount: ${status.trace.recentRawEventCount ?? 0}`,
  );

  return `${lines.join("\n")}\n`;
}

function renderElapsed(progress) {
  if (progress.elapsedText === null) {
    return "아직 계산할 수 없음";
  }
  if (progress.requestedDurationText === null) {
    return progress.elapsedText;
  }
  return `${progress.elapsedText} / ${progress.requestedDurationText}`;
}

function renderLastEvent(progress) {
  if (progress.lastEventAt === null) {
    return "아직 확인되지 않음";
  }
  const label = progress.lastEventLabel === null ? "event" : progress.lastEventLabel;
  return `${progress.lastEventAt} (${label})`;
}

function renderSignalLines(status) {
  const lines = [];
  if (status.signals.recentFailures.length === 0) {
    lines.push("- 최근 실패 신호: 없음");
  } else {
    lines.push("- 최근 실패 신호:");
    for (const failure of status.signals.recentFailures.slice(0, 3)) {
      lines.push(`  - ${failure.message}${failure.occurredAt === null ? "" : ` (${failure.occurredAt})`}`);
    }
  }

  if (status.signals.recentSkips.length === 0) {
    lines.push("- 최근 스킵 신호: 없음");
  } else {
    lines.push("- 최근 스킵 신호:");
    for (const skip of status.signals.recentSkips.slice(0, 3)) {
      lines.push(`  - ${skip.message}${skip.occurredAt === null ? "" : ` (${skip.occurredAt})`}`);
    }
  }
  return lines;
}

function formatDuration(value) {
  if (value === null) {
    return null;
  }
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}시간 ${minutes}분 ${seconds}초`;
}

function printHelp() {
  process.stdout.write(`M9 paper soak 상태를 artifact에서 read-only로 확인한다.

Usage:
  node scripts/report-m9-paper-soak-status.mjs [--artifact-dir <dir>] [--json]

Options:
  --artifact-dir <dir>  M9 paper trading soak artifact 디렉터리
  --json                JSON으로 출력
  -h, --help            도움말 출력
`);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
