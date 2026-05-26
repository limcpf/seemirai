#!/usr/bin/env node
import { access, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper", "trading-soak");
const artifactNamePattern =
  /^(m9-paper-trading-soak-.+?-[0-9a-f]{8})(?:-day-(\d+))?-(summary\.json|report\.md|events\.jsonl)$/u;
const expectedDayCount = 3;
const defaultComparisonReportNames = [
  "m9-3day-trading-soak-comparison.md",
  "m9-3day-comparison.md",
];

try {
  await main();
} catch (error) {
  process.stderr.write(`M9 paper soak 증거 검증 실패: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const validation = await validateEvidence(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  } else if (options.issueComment) {
    process.stdout.write(validation.issueComment);
  } else {
    process.stdout.write(renderTextValidation(validation));
  }

  if (validation.statusCode === "failed") {
    process.exitCode = 1;
  }
  if (validation.statusCode === "incomplete") {
    process.exitCode = 2;
  }
}

function parseArgs(argv) {
  const options = {
    artifactDir: defaultArtifactDir,
    comparisonReportPath: null,
    json: false,
    issueComment: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact-dir":
        options.artifactDir = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--comparison-report":
        options.comparisonReportPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--issue-comment":
        options.issueComment = true;
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

async function validateEvidence(options) {
  const artifactDir = path.resolve(options.artifactDir);
  const generatedAt = new Date().toISOString();
  const discovered = await discoverRuns(artifactDir);
  if (discovered.statusCode === "incomplete") {
    // evidence validator는 운영자가 재시도할 수 있도록 경로 문제도 프로세스 예외가 아니라 증거 부족으로 반환한다.
    return completeValidation({
      generatedAt,
      artifactDir,
      run: null,
      aggregate: { ok: false, value: null, error: discovered.detail },
      daySummaries: [],
      comparisonReport: { path: options.comparisonReportPath, ok: false, error: discovered.detail },
      checks: [
        createCheck({
          id: "artifactDirectory",
          label: "artifact 디렉터리",
          status: "incomplete",
          message: "M9 paper soak artifact 디렉터리를 아직 읽을 수 없다.",
          action: "경로가 맞는지 확인하고 runner가 한 번 이상 artifact를 남겼는지 확인한다.",
          evidence: { artifactDir },
          trace: { reason: discovered.reason, detail: discovered.detail },
        }),
      ],
    });
  }

  const run = selectLatestRun(discovered.runs);
  if (run === null) {
    return completeValidation({
      generatedAt,
      artifactDir,
      run: null,
      aggregate: { ok: false, value: null, error: "artifact_not_found" },
      daySummaries: [],
      comparisonReport: { path: options.comparisonReportPath, ok: false, error: "artifact_not_found" },
      checks: [
        createCheck({
          id: "artifactDiscovery",
          label: "최신 실행 artifact",
          status: "incomplete",
          message: "검증할 M9 paper soak 실행 artifact를 아직 찾지 못했다.",
          action: "runner가 시작됐는지 확인한 뒤 artifact 디렉터리를 다시 검증한다.",
          evidence: { artifactDir },
          trace: { reason: "artifact_not_found" },
        }),
      ],
    });
  }

  const aggregate = await readJsonArtifact(run.summaryPath);
  const daySummaries = await readDaySummaries({ run, aggregate: aggregate.value });
  const aggregateCompleted = isAggregateCompleted(aggregate.value);
  const comparisonReport = await readComparisonReport({ artifactDir, explicitPath: options.comparisonReportPath });
  const checks = [
    createAggregateSummaryCheck(aggregate),
    await createAggregateReportCheck({ run, aggregate, aggregateCompleted }),
    ...createDaySummaryChecks({ daySummaries, aggregateCompleted }),
    ...(await createDayReportChecks({ run, aggregate: aggregate.value, aggregateCompleted })),
    createComparisonReportCheck({ comparisonReport, aggregateCompleted }),
    createLiveOrderApiCheck({ aggregate, daySummaries, aggregateCompleted }),
    createRuntimeExceptionCheck({ aggregate, daySummaries, aggregateCompleted }),
    createDailyReportEvidenceCheck({ aggregate, daySummaries, aggregateCompleted }),
    createComparisonMetricCheck({ daySummaries, aggregateCompleted }),
    createPaperTradingMetricCheck({ aggregate, daySummaries, aggregateCompleted }),
  ];

  return completeValidation({
    generatedAt,
    artifactDir,
    run,
    aggregate,
    daySummaries,
    comparisonReport,
    checks,
  });
}

function completeValidation({ generatedAt, artifactDir, run, aggregate, daySummaries, comparisonReport, checks }) {
  const statusCode = deriveStatusCode(checks);
  const validation = {
    schemaVersion: 1,
    generatedAt,
    artifactDir,
    statusCode,
    statusLabel: toStatusLabel(statusCode),
    operatorMessage: createOperatorMessage(statusCode),
    action: createOperatorAction(statusCode),
    checks,
    artifacts: {
      prefix: run?.prefix ?? null,
      rawLogPath: run?.rawLogPath ?? readString(aggregate.value?.artifacts?.rawLogPath),
      summaryPath: run?.summaryPath ?? null,
      reportPath: run?.reportPath ?? readString(aggregate.value?.artifacts?.reportPath),
      dailySummaryPaths: daySummaries.map((day) => ({
        day: day.day,
        path: day.path,
        readable: day.summary.ok,
        status: readString(day.summary.value?.status),
      })),
      dailyReportPaths: resolveDailyReportPaths({ run, aggregate: aggregate.value }),
      comparisonReportPath: comparisonReport.path,
    },
    trace: {
      aggregateSummaryReadable: aggregate.ok,
      aggregateSummaryError: aggregate.error,
      aggregateStatus: readString(aggregate.value?.status),
      comparisonReportReadable: comparisonReport.ok,
      comparisonReportError: comparisonReport.error,
    },
  };
  validation.issueComment = renderIssueComment(validation);
  return validation;
}

async function discoverRuns(artifactDir) {
  try {
    await access(artifactDir);
  } catch (error) {
    return {
      statusCode: "incomplete",
      reason: "artifact_dir_missing",
      detail: toErrorMessage(error),
    };
  }

  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    return {
      statusCode: "incomplete",
      reason: "artifact_dir_unreadable",
      detail: toErrorMessage(error),
    };
  }

  const runs = new Map();
  const statFailures = [];
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
      } catch (error) {
        if (isMissingArtifactStatError(error)) {
          // runner가 artifact를 교체하는 순간의 ENOENT만 경쟁 상태로 보고 검증 전체를 유지한다.
          return;
        }
        statFailures.push({
          path: filePath,
          detail: toErrorMessage(error),
        });
        return;
      }
      if (!fileStat.isFile()) {
        return;
      }
      const run = getOrCreateRun(runs, parsed.prefix);
      run.latestMtimeMs = Math.max(run.latestMtimeMs, fileStat.mtimeMs);
      assignRunFile(run, filePath, parsed);
    }),
  );

  if (statFailures.length > 0) {
    return {
      statusCode: "incomplete",
      reason: "artifact_file_stat_failed",
      detail: statFailures.map((failure) => `${failure.path}: ${failure.detail}`).join("; "),
    };
  }

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

function isMissingArtifactStatError(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isMissingFileError(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function readJsonArtifact(filePath) {
  if (filePath === null) {
    return { ok: false, value: null, error: null };
  }

  try {
    const raw = await readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    if (isMissingFileError(error)) {
      // runner가 아직 파일을 만들지 않은 상태는 손상과 구분해야 운영자가 불필요한 장애 대응을 하지 않는다.
      return { ok: false, value: null, error: null };
    }
    return { ok: false, value: null, error: toErrorMessage(error) };
  }
}

async function readTextArtifact(filePath) {
  if (filePath === null) {
    return { path: null, ok: false, value: null, error: null };
  }

  try {
    const value = await readFile(filePath, "utf8");
    return { path: filePath, ok: value.trim().length > 0, value, error: value.trim().length > 0 ? null : "empty_file" };
  } catch (error) {
    if (isMissingFileError(error)) {
      // report 생성 전 상태는 incomplete로 남겨 후속 비교 report 생성 절차를 안내한다.
      return { path: filePath, ok: false, value: null, error: null };
    }
    return { path: filePath, ok: false, value: null, error: toErrorMessage(error) };
  }
}

async function readDaySummaries({ run, aggregate }) {
  const aggregatePaths = Array.isArray(aggregate?.artifacts?.dailySummaryPaths)
    ? aggregate.artifacts.dailySummaryPaths
    : [];
  const days = [];
  await Promise.all(
    Array.from({ length: expectedDayCount }, async (_, index) => {
      const day = index + 1;
      const pathFromRun = run.dailySummaryPaths.get(day) ?? null;
      const summaryPath = pathFromRun ?? readString(aggregatePaths[index]) ?? expectedDailySummaryPath(run.prefix, day, run);
      days[index] = {
        day,
        path: summaryPath,
        summary: await readJsonArtifact(summaryPath),
      };
    }),
  );
  return days;
}

function expectedDailySummaryPath(prefix, day, run) {
  const rawPath = run.rawLogPath ?? run.summaryPath ?? run.reportPath;
  if (rawPath === null) {
    return null;
  }
  return path.join(path.dirname(rawPath), `${prefix}-day-${day}-summary.json`);
}

async function readComparisonReport({ artifactDir, explicitPath }) {
  if (explicitPath !== null) {
    return readTextArtifact(explicitPath);
  }

  for (const fileName of defaultComparisonReportNames) {
    const candidate = path.join(artifactDir, fileName);
    const report = await readTextArtifact(candidate);
    if (report.ok) {
      return report;
    }
  }

  let entries;
  try {
    entries = await readdir(artifactDir, { withFileTypes: true });
  } catch (error) {
    return { path: path.join(artifactDir, defaultComparisonReportNames[0]), ok: false, value: null, error: toErrorMessage(error) };
  }

  const candidates = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^m9-3day-.+comparison.*\.md$/u.test(entry.name)) {
        return;
      }
      const candidatePath = path.join(artifactDir, entry.name);
      try {
        const fileStat = await stat(candidatePath);
        candidates.push({ path: candidatePath, mtimeMs: fileStat.mtimeMs });
      } catch {
        // 비교 report 후보가 정리되는 순간은 다음 후보 확인으로 넘긴다.
      }
    }),
  );
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));

  return readTextArtifact(candidates[0]?.path ?? path.join(artifactDir, defaultComparisonReportNames[0]));
}

function createAggregateSummaryCheck(aggregate) {
  if (!aggregate.ok) {
    // aggregate가 없으면 실행 중일 수 있지만, 깨진 JSON이면 완료 판정 근거 자체가 손상된 것이다.
    return createCheck({
      id: "aggregateSummary",
      label: "aggregate summary",
      status: aggregate.error === null ? "incomplete" : "failed",
      message:
        aggregate.error === null
          ? "aggregate summary가 아직 생성되지 않았다."
          : "aggregate summary JSON을 읽지 못해 완료 판정을 신뢰할 수 없다.",
      action: "runner 완료 후 aggregate summary가 생성됐는지 확인한다.",
      evidence: {},
      trace: { reason: aggregate.error === null ? "aggregate_summary_missing" : "aggregate_summary_unreadable", detail: aggregate.error },
    });
  }

  const aggregateStatus = normalizeSummaryStatus(aggregate.value.status);
  if (aggregateStatus === "passed") {
    return createCheck({
      id: "aggregateSummary",
      label: "aggregate summary",
      status: "passed",
      message: "aggregate summary가 `passed` 상태로 생성됐다.",
      action: "다음 evidence 항목을 계속 확인한다.",
      evidence: readSummaryEvidence(aggregate.value),
      trace: { summaryStatus: aggregateStatus },
    });
  }
  if (aggregateStatus === "failed") {
    return createCheck({
      id: "aggregateSummary",
      label: "aggregate summary",
      status: "failed",
      message: "aggregate summary가 실패 상태로 종료됐다.",
      action: "실패 check와 raw log 원인을 확인하고 #68에 재실행 또는 폐기 판단을 남긴다.",
      evidence: readSummaryEvidence(aggregate.value),
      trace: { summaryStatus: aggregateStatus },
    });
  }

  return createCheck({
    id: "aggregateSummary",
    label: "aggregate summary",
    status: "incomplete",
    message: "aggregate summary가 아직 완료 상태가 아니다.",
    action: "runner가 완료될 때까지 기다린 뒤 다시 검증한다.",
    evidence: readSummaryEvidence(aggregate.value),
    trace: { summaryStatus: aggregateStatus },
  });
}

async function createAggregateReportCheck({ run, aggregate, aggregateCompleted }) {
  const reportPath = run.reportPath ?? readString(aggregate.value?.artifacts?.reportPath);
  const report = await readTextArtifact(reportPath);
  return evidenceFileCheck({
    id: "aggregateReport",
    label: "aggregate report",
    completed: aggregateCompleted,
    artifact: report,
    missingMessage: "aggregate report markdown이 아직 생성되지 않았다.",
    unreadableMessage: "aggregate report markdown을 읽지 못했다.",
    passedMessage: "aggregate report markdown이 생성됐다.",
  });
}

function createDaySummaryChecks({ daySummaries, aggregateCompleted }) {
  return daySummaries.map((day) => {
    if (!day.summary.ok) {
      return createCheck({
        id: `day${day.day}Summary`,
        label: `Day ${day.day} summary`,
        status: aggregateCompleted ? "failed" : "incomplete",
        message:
          day.summary.error === null
            ? `Day ${day.day} summary가 아직 생성되지 않았다.`
            : `Day ${day.day} summary JSON을 읽지 못했다.`,
        action: aggregateCompleted
          ? "완료된 run의 day summary 누락 또는 손상 여부를 확인한다."
          : "runner가 해당 day summary를 생성할 때까지 기다린다.",
        evidence: { path: day.path },
        trace: {
          reason: day.summary.error === null ? "day_summary_missing" : "day_summary_unreadable",
          detail: day.summary.error,
        },
      });
    }

    const summaryStatus = normalizeSummaryStatus(day.summary.value.status);
    return createCheck({
      id: `day${day.day}Summary`,
      label: `Day ${day.day} summary`,
      status: summaryStatus === "passed" ? "passed" : summaryStatus === "failed" ? "failed" : "incomplete",
      message:
        summaryStatus === "passed"
          ? `Day ${day.day} summary가 통과 상태로 생성됐다.`
          : summaryStatus === "failed"
          ? `Day ${day.day} summary가 실패 상태다.`
          : `Day ${day.day} summary가 아직 완료 상태가 아니다.`,
      action:
        summaryStatus === "passed"
          ? "다음 evidence 항목을 계속 확인한다."
          : "해당 day summary의 failed check와 raw log를 확인한다.",
      evidence: {
        path: day.path,
        ...readSummaryEvidence(day.summary.value),
      },
      trace: { summaryStatus },
    });
  });
}

async function createDayReportChecks({ run, aggregate, aggregateCompleted }) {
  const aggregateDailyReports = Array.isArray(aggregate?.artifacts?.dailyReportPaths)
    ? aggregate.artifacts.dailyReportPaths
    : [];
  return Promise.all(
    Array.from({ length: expectedDayCount }, async (_, index) => {
      const day = index + 1;
      const reportPath = run.dailyReportPaths.get(day) ?? readString(aggregateDailyReports[index]) ?? expectedDailyReportPath(run.prefix, day, run);
      const report = await readTextArtifact(reportPath);
      return evidenceFileCheck({
        id: `day${day}Report`,
        label: `Day ${day} report`,
        completed: aggregateCompleted,
        artifact: report,
        missingMessage: `Day ${day} report markdown이 아직 생성되지 않았다.`,
        unreadableMessage: `Day ${day} report markdown을 읽지 못했다.`,
        passedMessage: `Day ${day} report markdown이 생성됐다.`,
      });
    }),
  );
}

function expectedDailyReportPath(prefix, day, run) {
  const rawPath = run.rawLogPath ?? run.summaryPath ?? run.reportPath;
  if (rawPath === null) {
    return null;
  }
  return path.join(path.dirname(rawPath), `${prefix}-day-${day}-report.md`);
}

function createComparisonReportCheck({ comparisonReport, aggregateCompleted }) {
  return evidenceFileCheck({
    id: "comparisonReport",
    label: "3일 비교 report",
    completed: aggregateCompleted,
    artifact: comparisonReport,
    missingMessage: "3일 비교 report markdown이 아직 생성되지 않았다.",
    unreadableMessage: "3일 비교 report markdown을 읽지 못했거나 비어 있다.",
    passedMessage: "3일 비교 report markdown이 생성됐다.",
  });
}

function evidenceFileCheck({ id, label, completed, artifact, missingMessage, unreadableMessage, passedMessage }) {
  if (artifact.ok) {
    return createCheck({
      id,
      label,
      status: "passed",
      message: passedMessage,
      action: "다음 evidence 항목을 계속 확인한다.",
      evidence: { path: artifact.path },
      trace: {},
    });
  }

  const missing = artifact.error === null;
  return createCheck({
    id,
    label,
    // 완료된 run에서 evidence 파일이 없으면 진행 중이 아니라 closeout 조건 미충족으로 다룬다.
    status: completed ? "failed" : "incomplete",
    message: missing ? missingMessage : unreadableMessage,
    action: completed
      ? "완료된 run의 evidence artifact가 누락/손상됐는지 확인한다."
      : "runner 완료와 후속 비교 report 생성이 끝난 뒤 다시 검증한다.",
    evidence: { path: artifact.path },
    trace: { reason: missing ? "artifact_missing" : "artifact_unreadable", detail: artifact.error },
  });
}

function createLiveOrderApiCheck({ aggregate, daySummaries, aggregateCompleted }) {
  return createMetricZeroCheck({
    id: "liveOrderApiCalls",
    label: "live order API 호출",
    aggregate,
    daySummaries,
    aggregateCompleted,
    metricReader: (summary) => readNumber(summary.metrics?.liveOrderApiCalls),
    passedMessage: "aggregate와 Day 1/2/3 모두 live order API 호출이 0회다.",
    failedMessage: "live order API 호출이 0회가 아닌 summary가 있다.",
    missingMessage: "live order API 호출 metric을 확인하지 못한 summary가 있다.",
  });
}

function createRuntimeExceptionCheck({ aggregate, daySummaries, aggregateCompleted }) {
  const summaries = collectReadableSummaries({ aggregate, daySummaries });
  const missing = [];
  const nonZero = [];
  for (const summary of summaries) {
    const evidence = summary.value.checks?.runtimeExceptions?.evidence;
    const crashCount = readNumber(evidence?.crashCount);
    const unhandledRejectionCount = readNumber(evidence?.unhandledRejectionCount);
    if (crashCount === null || unhandledRejectionCount === null) {
      missing.push(summary.label);
      continue;
    }
    if (crashCount !== 0 || unhandledRejectionCount !== 0) {
      nonZero.push({ label: summary.label, crashCount, unhandledRejectionCount });
    }
  }

  if (nonZero.length > 0) {
    return createCheck({
      id: "runtimeExceptions",
      label: "crash/unhandled rejection",
      status: "failed",
      message: "crash 또는 unhandled rejection이 0회가 아닌 summary가 있다.",
      action: "runtime exception이 발생한 day의 raw log와 실패 check를 확인한다.",
      evidence: { nonZero },
      trace: { reason: "runtime_exception_observed" },
    });
  }

  if (missing.length > 0 || summaries.length < expectedDayCount + 1) {
    return createCheck({
      id: "runtimeExceptions",
      label: "crash/unhandled rejection",
      status: aggregateCompleted ? "failed" : "incomplete",
      message: "crash/unhandled rejection evidence를 확인하지 못한 summary가 있다.",
      action: aggregateCompleted
        ? "완료된 summary의 runtimeExceptions check 누락 여부를 확인한다."
        : "summary 생성이 완료된 뒤 다시 검증한다.",
      evidence: { missing, readableSummaryCount: summaries.length },
      trace: { reason: "runtime_exception_evidence_missing" },
    });
  }

  return createCheck({
    id: "runtimeExceptions",
    label: "crash/unhandled rejection",
    status: "passed",
    message: "aggregate와 Day 1/2/3 모두 crash와 unhandled rejection이 0회다.",
    action: "다음 evidence 항목을 계속 확인한다.",
    evidence: { checkedSummaryCount: summaries.length },
    trace: {},
  });
}

function createDailyReportEvidenceCheck({ aggregate, daySummaries, aggregateCompleted }) {
  const summaries = collectReadableSummaries({ aggregate, daySummaries });
  const missing = summaries
    .filter((summary) => summary.value.checks?.dailyReportGenerated?.evidence?.generated !== true)
    .map((summary) => summary.label);

  if (missing.length > 0 || summaries.length < expectedDayCount + 1) {
    return createCheck({
      id: "dailyReportEvidence",
      label: "daily report evidence",
      status: aggregateCompleted ? "failed" : "incomplete",
      message: "daily report 연결 evidence가 없는 summary가 있다.",
      action: aggregateCompleted
        ? "`--daily-report-generated` 근거와 실제 daily report 연결 상태를 확인한다."
        : "summary 생성이 완료된 뒤 다시 검증한다.",
      evidence: { missing, readableSummaryCount: summaries.length },
      trace: { reason: "daily_report_evidence_missing" },
    });
  }

  return createCheck({
    id: "dailyReportEvidence",
    label: "daily report evidence",
    status: "passed",
    message: "aggregate와 Day 1/2/3 모두 daily report 연결 evidence가 있다.",
    action: "다음 evidence 항목을 계속 확인한다.",
    evidence: { checkedSummaryCount: summaries.length },
    trace: {},
  });
}

function createComparisonMetricCheck({ daySummaries, aggregateCompleted }) {
  const missing = [];
  for (const day of daySummaries) {
    if (!day.summary.ok) {
      missing.push({ label: `Day ${day.day}`, metric: "summary" });
      continue;
    }
    const metrics = day.summary.value.metrics ?? {};
    for (const [metric, keys] of Object.entries({
      costSummary: ["costSummary", "cost", "costBps", "totalCost"],
      slippageSummary: ["slippageSummary", "slippage", "slippageBps"],
      fillRate: ["fillRate", "fillRatePct", "fillRatePercent"],
      blockingReasonCounts: ["blockingReasonCounts", "blockingReasons", "discardReasons"],
    })) {
      if (!hasAnyKey(metrics, keys)) {
        missing.push({ label: `Day ${day.day}`, metric });
      }
    }
  }

  if (missing.length > 0) {
    return createCheck({
      id: "comparisonMetrics",
      label: "3일 비교 metric",
      status: aggregateCompleted ? "failed" : "incomplete",
      message: "3일 비교 report에 필요한 metric이 누락된 day summary가 있다.",
      action: aggregateCompleted
        ? "비교 report 입력 summary가 올바른 run의 Day 1/2/3인지 확인한다."
        : "day summary 생성이 완료된 뒤 다시 검증한다.",
      evidence: { missing },
      trace: { reason: "comparison_metric_missing" },
    });
  }

  return createCheck({
    id: "comparisonMetrics",
    label: "3일 비교 metric",
    status: "passed",
    message: "Day 1/2/3 summary에 비용, 슬리피지, 체결률, 차단 사유 metric이 있다.",
    action: "다음 evidence 항목을 계속 확인한다.",
    evidence: { checkedDayCount: daySummaries.length },
    trace: {},
  });
}

function createPaperTradingMetricCheck({ aggregate, daySummaries, aggregateCompleted }) {
  const summaries = collectReadableSummaries({ aggregate, daySummaries });
  const failures = [];
  for (const summary of summaries) {
    const metrics = summary.value.metrics ?? {};
    const submitted = readNumber(metrics.paperOrderSubmittedCount);
    const fills = readNumber(metrics.paperFillCount);
    const hasReasonCounts =
      isRecord(metrics.holdReasonCounts) && isRecord(metrics.discardReasonCounts) && isRecord(metrics.blockingReasonCounts);
    if (submitted === null || submitted <= 0 || fills === null || fills <= 0 || !hasReasonCounts) {
      failures.push({
        label: summary.label,
        paperOrderSubmittedCount: submitted,
        paperFillCount: fills,
        hasReasonCounts,
      });
    }
  }

  if (failures.length > 0 || summaries.length < expectedDayCount + 1) {
    return createCheck({
      id: "paperTradingMetrics",
      label: "paper 주문/체결 metric",
      status: aggregateCompleted ? "failed" : "incomplete",
      message: "paper 주문/체결 또는 reason count evidence가 부족한 summary가 있다.",
      action: aggregateCompleted
        ? "PaperBroker 주문/체결 경로가 실제로 관측됐는지 확인한다."
        : "runner가 충분한 cycle을 실행한 뒤 다시 검증한다.",
      evidence: { failures, readableSummaryCount: summaries.length },
      trace: { reason: "paper_trading_metric_missing" },
    });
  }

  return createCheck({
    id: "paperTradingMetrics",
    label: "paper 주문/체결 metric",
    status: "passed",
    message: "aggregate와 Day 1/2/3 모두 paper 주문/체결과 reason count evidence가 있다.",
    action: "증거 검증을 마무리할 수 있다.",
    evidence: { checkedSummaryCount: summaries.length },
    trace: {},
  });
}

function createMetricZeroCheck({
  id,
  label,
  aggregate,
  daySummaries,
  aggregateCompleted,
  metricReader,
  passedMessage,
  failedMessage,
  missingMessage,
}) {
  const summaries = collectReadableSummaries({ aggregate, daySummaries });
  const missing = [];
  const nonZero = [];
  for (const summary of summaries) {
    const value = metricReader(summary.value);
    if (value === null) {
      missing.push(summary.label);
      continue;
    }
    if (value !== 0) {
      nonZero.push({ label: summary.label, value });
    }
  }

  if (nonZero.length > 0) {
    return createCheck({
      id,
      label,
      status: "failed",
      message: failedMessage,
      action: "live/private order API가 열렸는지 확인하고 해당 run을 #68 완료 증거에서 제외한다.",
      evidence: { nonZero },
      trace: { reason: "metric_non_zero" },
    });
  }

  if (missing.length > 0 || summaries.length < expectedDayCount + 1) {
    return createCheck({
      id,
      label,
      status: aggregateCompleted ? "failed" : "incomplete",
      message: missingMessage,
      action: aggregateCompleted ? "완료된 summary의 metric 누락 여부를 확인한다." : "summary 생성이 완료된 뒤 다시 검증한다.",
      evidence: { missing, readableSummaryCount: summaries.length },
      trace: { reason: "metric_missing" },
    });
  }

  return createCheck({
    id,
    label,
    status: "passed",
    message: passedMessage,
    action: "다음 evidence 항목을 계속 확인한다.",
    evidence: { checkedSummaryCount: summaries.length },
    trace: {},
  });
}

function collectReadableSummaries({ aggregate, daySummaries }) {
  const summaries = [];
  if (aggregate.ok) {
    summaries.push({ label: "aggregate", value: aggregate.value });
  }
  for (const day of daySummaries) {
    if (day.summary.ok) {
      summaries.push({ label: `Day ${day.day}`, value: day.summary.value });
    }
  }
  return summaries;
}

function createCheck({ id, label, status, message, action, evidence, trace }) {
  return {
    id,
    label,
    status,
    statusLabel: toStatusLabel(status),
    message,
    action,
    evidence,
    trace,
  };
}

function deriveStatusCode(checks) {
  // 완료 후 안전 조건 위반은 다른 증거가 부족한 상태보다 우선해 closeout을 차단한다.
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "incomplete")) {
    return "incomplete";
  }
  return "passed";
}

function isAggregateCompleted(summary) {
  const status = normalizeSummaryStatus(summary?.status);
  return status === "passed" || status === "failed";
}

function normalizeSummaryStatus(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function readSummaryEvidence(summary) {
  return {
    runId: readString(summary.runId),
    startedAt: readString(summary.startedAt),
    finishedAt: readString(summary.finishedAt),
    durationMsObserved: readNumber(summary.durationMsObserved),
    durationMsRequested: readNumber(summary.durationMsRequested),
  };
}

function resolveDailyReportPaths({ run, aggregate }) {
  const aggregateDailyReports = Array.isArray(aggregate?.artifacts?.dailyReportPaths)
    ? aggregate.artifacts.dailyReportPaths
    : [];
  return Array.from({ length: expectedDayCount }, (_, index) => {
    const day = index + 1;
    return {
      day,
      path: run?.dailyReportPaths?.get(day) ?? readString(aggregateDailyReports[index]) ?? null,
    };
  });
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasAnyKey(record, keys) {
  return keys.some((key) => record[key] !== undefined);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toStatusLabel(statusCode) {
  switch (statusCode) {
    case "passed":
      return "통과";
    case "failed":
      return "실패";
    case "incomplete":
      return "증거 부족";
    default:
      return "확인 불가";
  }
}

function createOperatorMessage(statusCode) {
  switch (statusCode) {
    case "passed":
      return "#68 완료 판단에 필요한 M9 paper soak 증거가 모두 충족됐다.";
    case "failed":
      return "완료된 M9 paper soak 증거 중 #68 조건을 충족하지 못한 항목이 있다.";
    case "incomplete":
      return "M9 paper soak가 아직 완료되지 않았거나 완료 증거가 부족하다.";
    default:
      return "M9 paper soak 증거를 판정할 수 없다.";
  }
}

function createOperatorAction(statusCode) {
  switch (statusCode) {
    case "passed":
      return "생성된 Markdown을 #68 댓글로 붙이고 M9 close 판단에 사용한다.";
    case "failed":
      return "실패 항목의 artifact와 raw log를 확인한 뒤 재실행 또는 후속 보강 이슈를 결정한다.";
    case "incomplete":
      return "runner 완료, day summary 3개, 비교 report 생성이 끝난 뒤 다시 실행한다.";
    default:
      return "artifact 경로와 권한을 확인한다.";
  }
}

function renderTextValidation(validation) {
  const rows = validation.checks
    .map((check) => `- [${check.statusLabel}] ${check.label}: ${check.message}`)
    .join("\n");
  return `M9 paper soak 증거 검증: ${validation.statusLabel}

운영 판단: ${validation.operatorMessage}
필요 조치: ${validation.action}

검사 결과:
${rows}

추적 정보:
- artifactDir: ${validation.artifactDir}
- run prefix: ${validation.artifacts.prefix ?? "unknown"}
- aggregate summary: ${validation.artifacts.summaryPath ?? "missing"}
- 3일 비교 report: ${validation.artifacts.comparisonReportPath ?? "missing"}
`;
}

function renderIssueComment(validation) {
  const checkRows = validation.checks
    .map(
      (check) =>
        `| ${escapeMarkdownTable(check.label)} | ${check.statusLabel} | ${escapeMarkdownTable(check.message)} | ${escapeMarkdownTable(
          check.action,
        )} |`,
    )
    .join("\n");
  const dayRows = validation.artifacts.dailySummaryPaths
    .map(
      (day) =>
        `| Day ${day.day} | ${day.status ?? "unknown"} | ${day.readable ? "yes" : "no"} | ${escapeMarkdownTable(
          day.path ?? "missing",
        )} |`,
    )
    .join("\n");

  return `## #68 M9 paper trading 관측 증거 검증

- 판정: ${validation.statusLabel}
- 운영 판단: ${validation.operatorMessage}
- 필요 조치: ${validation.action}
- 생성 시각: ${validation.generatedAt}

### 검사 결과

| 항목 | 상태 | 근거 | 필요 조치 |
| --- | --- | --- | --- |
${checkRows}

### Day Summary

| 일차 | summary 상태 | readable | 경로 |
| --- | --- | --- | --- |
${dayRows}

### Artifact

- aggregate summary: \`${validation.artifacts.summaryPath ?? "missing"}\`
- aggregate report: \`${validation.artifacts.reportPath ?? "missing"}\`
- 3일 비교 report: \`${validation.artifacts.comparisonReportPath ?? "missing"}\`
- raw log: \`${validation.artifacts.rawLogPath ?? "missing"}\`

### 추적 정보

- statusCode: \`${validation.statusCode}\`
- run prefix: \`${validation.artifacts.prefix ?? "unknown"}\`
- aggregateStatus: \`${validation.trace.aggregateStatus ?? "unknown"}\`
`;
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/validate-m9-paper-soak-evidence.mjs --artifact-dir <path> [options]

Options:
  --artifact-dir <path>        M9 paper soak artifact 디렉터리. 기본값은 ~/vaults/99_운영/seemirai-m9-paper/trading-soak.
  --comparison-report <path>   3일 비교 report markdown 경로. 생략하면 artifact dir의 m9-3day-trading-soak-comparison.md 또는 최신 comparison markdown을 찾는다.
  --issue-comment              GitHub issue #68에 붙일 Markdown만 출력한다.
  --json                       Machine-readable validation JSON을 출력한다.
  --help, -h                   도움말을 출력한다.

Exit codes:
  0  passed
  1  failed
  2  incomplete
`);
}
