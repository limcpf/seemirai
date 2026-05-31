#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultOutputDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper");
const minimumSummaryCount = 3;

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const comparison = await compareReports(options.summaryPaths);
  const markdown = renderMarkdownComparison(comparison);
  const outputPath = options.outputPath ?? path.join(defaultOutputDir, `m9-3day-comparison-${comparison.generatedAt}.md`);

  if (options.outputPath !== undefined) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, "utf8");
    comparison.outputPath = outputPath;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
  }

  if (comparison.status === "failed") {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    summaryPaths: [],
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--summary":
        options.summaryPaths.push(path.resolve(readValue(argv, index, arg)));
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readValue(argv, index, arg));
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
        options.summaryPaths.push(path.resolve(arg));
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

async function compareReports(summaryPaths) {
  const generatedAt = new Date().toISOString().replace(/[:.]/gu, "-");
  const rows = [];
  const failures = [];
  const warnings = [];

  if (summaryPaths.length < minimumSummaryCount) {
    failures.push({
      code: "summary_count_below_3",
      message: `3일 비교에는 summary JSON이 최소 ${minimumSummaryCount}개 필요하다.`,
      evidence: { count: summaryPaths.length },
    });
  }
  failures.push(...findDuplicateSummaryPathFailures(summaryPaths));

  for (const [index, summaryPath] of summaryPaths.entries()) {
    const summary = await readJsonFile(summaryPath);
    const row = createComparisonRow({ index, summaryPath, summary });
    rows.push(row);
  }
  rows.sort(compareRowsByStartedAt);
  relabelRows(rows);
  failures.push(...findDuplicateSummaryDateFailures(rows));
  failures.push(...findNonConsecutiveDateFailures(rows));
  failures.push(...findMetricFormatFailures(rows));
  for (const row of rows) {
    failures.push(...row.failures);
    warnings.push(...row.warnings);
  }

  return {
    schemaVersion: 1,
    status: failures.length === 0 ? "passed" : "failed",
    generatedAt,
    inputCount: summaryPaths.length,
    rows,
    failures,
    warnings,
  };
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function findDuplicateSummaryPathFailures(summaryPaths) {
  const seen = new Set();
  const failures = [];
  for (const summaryPath of summaryPaths) {
    if (seen.has(summaryPath)) {
      failures.push({
        code: "duplicate_summary_path",
        message: "같은 summary JSON 경로가 중복 입력됐다.",
        evidence: { summaryPath },
      });
      continue;
    }
    seen.add(summaryPath);
  }
  return failures;
}

function findDuplicateSummaryDateFailures(rows) {
  const seen = new Map();
  const failures = [];
  for (const row of rows) {
    if (row.date === "unknown") {
      continue;
    }
    const previous = seen.get(row.date);
    if (previous !== undefined) {
      failures.push(
        rowFailure(row, "duplicate_summary_date", "같은 날짜의 summary가 중복 입력됐다.", {
          date: row.date,
          previousSummaryPath: previous.summaryPath,
        }),
      );
      continue;
    }
    seen.set(row.date, row);
  }
  return failures;
}

function findNonConsecutiveDateFailures(rows) {
  const failures = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previousDate = rows[index - 1].date;
    const currentDate = rows[index].date;
    if (previousDate === "unknown" || currentDate === "unknown") {
      continue;
    }
    if (dateToEpochDay(currentDate) - dateToEpochDay(previousDate) !== 1) {
      failures.push(
        rowFailure(rows[index], "non_consecutive_summary_date", "summary 날짜가 직전 day와 연속되지 않는다.", {
          previousDate,
          currentDate,
        }),
      );
    }
  }
  return failures;
}

function findMetricFormatFailures(rows) {
  const failures = [];
  for (const metricName of ["cost", "slippage", "fillRate", "blockingReasons", "pnlSummary"]) {
    const first = rows.find((row) => row.metricFormats[metricName] !== "unavailable");
    if (first === undefined) {
      continue;
    }
    for (const row of rows) {
      const current = row.metricFormats[metricName];
      if (current !== "unavailable" && current !== first.metricFormats[metricName]) {
        failures.push(
          rowFailure(row, "metric_format_mismatch", `${metricName} metric 포맷이 다른 day와 일치하지 않는다.`, {
            metricName,
            expectedFormat: first.metricFormats[metricName],
            actualFormat: current,
          }),
        );
      }
    }
  }
  return failures;
}

function compareRowsByStartedAt(left, right) {
  const leftTime = toSortableTimestamp(left.startedAt);
  const rightTime = toSortableTimestamp(right.startedAt);
  if (leftTime !== rightTime) {
    return leftTime.localeCompare(rightTime);
  }

  return left.summaryPath.localeCompare(right.summaryPath);
}

function toSortableTimestamp(value) {
  return typeof value === "string" && value.length > 0 ? value : "9999-12-31T23:59:59.999Z";
}

function relabelRows(rows) {
  rows.forEach((row, index) => {
    row.day = `Day ${index + 1}`;
    for (const failure of row.failures) {
      failure.day = row.day;
    }
    for (const warning of row.warnings) {
      warning.day = row.day;
    }
  });
}

function createComparisonRow({ index, summaryPath, summary }) {
  const checks = readRecord(summary.checks);
  const metrics = readRecord(summary.metrics);
  const artifacts = readRecord(summary.artifacts);
  const git = readRecord(summary.git);
  const runtimeExceptions = readRecord(checks.runtimeExceptions?.evidence);
  const auditMissing = readRecord(checks.auditMissing?.evidence);
  const notificationFailures = readRecord(checks.notificationFailures?.evidence);
  const dailyReportGenerated = checks.dailyReportGenerated?.evidence?.generated === true;
  const notificationFailureCount = readNumber(notificationFailures.count);
  const notificationResolved = hasNotificationResolutionEvidence(checks, summary);
  const cost = readComparableMetric(metrics, ["cost", "costSummary", "costBps", "totalCost"]);
  const slippage = readComparableMetric(metrics, ["slippage", "slippageSummary", "slippageBps"]);
  const fillRate = readComparableMetric(metrics, ["fillRate", "fillRatePct", "fillRatePercent"]);
  const blockingReasons = readComparableMetric(metrics, ["blockingReasons", "blockingReasonCounts", "discardReasons"]);
  const pnlSummary = readComparablePnlSummaryMetric(metrics);

  const row = {
    day: `Day ${index + 1}`,
    startedAt: typeof summary.startedAt === "string" ? summary.startedAt : null,
    date: readDateLabel(summary.startedAt),
    summaryPath,
    status: summary.status ?? "unknown",
    commit: typeof git.commit === "string" ? git.commit : "unknown",
    branch: typeof git.branch === "string" ? git.branch : "unknown",
    reportArtifact: typeof artifacts.reportPath === "string" && artifacts.reportPath.length > 0 ? artifacts.reportPath : null,
    crashCount: readNumber(runtimeExceptions.crashCount),
    unhandledRejectionCount: readNumber(runtimeExceptions.unhandledRejectionCount),
    liveOrderApiCalls: readNumber(metrics.liveOrderApiCalls),
    auditMissingCount: readNumber(auditMissing.count),
    notificationFailureCount,
    notificationResolved,
    dailyReportGenerated,
    cost: cost.value,
    slippage: slippage.value,
    fillRate: fillRate.value,
    blockingReasons: blockingReasons.value,
    pnlSummary: pnlSummary.value,
    metricFormats: {
      cost: cost.format,
      slippage: slippage.format,
      fillRate: fillRate.format,
      blockingReasons: blockingReasons.format,
      pnlSummary: pnlSummary.format,
    },
    failures: [],
    warnings: [],
  };

  if (row.status !== "passed") {
    row.failures.push(rowFailure(row, "summary_not_passed", "soak summary 상태가 명시적 passed가 아니다.", { status: row.status }));
  }
  if (row.reportArtifact === null) {
    row.failures.push(rowFailure(row, "report_artifact_missing", "report artifact 경로가 없다."));
  }
  if (row.date === "unknown") {
    row.failures.push(rowFailure(row, "summary_date_missing", "summary startedAt 날짜를 확인할 수 없다."));
  }
  if (row.crashCount !== 0) {
    row.failures.push(rowFailure(row, "crash_observed", "crash가 0회가 아니다.", { crashCount: row.crashCount }));
  }
  if (row.unhandledRejectionCount !== 0) {
    row.failures.push(
      rowFailure(row, "unhandled_rejection_observed", "unhandled rejection이 0회가 아니다.", {
        unhandledRejectionCount: row.unhandledRejectionCount,
      }),
    );
  }
  if (row.liveOrderApiCalls !== 0) {
    row.failures.push(
      rowFailure(row, "live_order_api_observed", "M9 paper 운영 중 live order API 호출이 관측됐다.", {
        liveOrderApiCalls: row.liveOrderApiCalls,
      }),
    );
  }
  if (row.auditMissingCount !== 0) {
    row.failures.push(
      rowFailure(row, "audit_missing_observed", "차단/장애 status evidence 누락이 0건이 아니다.", {
        auditMissingCount: row.auditMissingCount,
      }),
    );
  }
  if (!row.dailyReportGenerated) {
    row.failures.push(rowFailure(row, "daily_report_missing", "daily report 생성 evidence가 없다."));
  }
  if (row.notificationFailureCount === null) {
    row.failures.push(rowFailure(row, "notification_failure_count_missing", "notification failure count evidence가 없다."));
  }
  if (row.notificationFailureCount > 0 && !row.notificationResolved) {
    row.failures.push(
      rowFailure(row, "notification_failure_unresolved", "notification failure에 대한 retry 또는 완료된 manual review evidence가 없다.", {
        notificationFailureCount: row.notificationFailureCount,
      }),
    );
  }

  for (const [name, value] of [
    ["cost", row.cost],
    ["slippage", row.slippage],
    ["fillRate", row.fillRate],
    ["blockingReasons", row.blockingReasons],
    ["pnlSummary", row.pnlSummary],
  ]) {
    if (value === "unavailable") {
      row.failures.push(rowFailure(row, `${name}_unavailable`, `${name} 비교 입력이 summary에 없다.`));
    }
  }
  if (row.metricFormats.pnlSummary === "invalid") {
    row.failures.push(rowFailure(row, "pnlSummary_invalid", "pnlSummary 비교 입력의 필수 shape가 유효하지 않다."));
  }

  return row;
}

function readRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readDateLabel(value) {
  if (typeof value !== "string" || value.length < 10) {
    return "unknown";
  }

  const dateLabel = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateLabel)) {
    return "unknown";
  }

  return Number.isFinite(dateToEpochDay(dateLabel)) ? dateLabel : "unknown";
}

function dateToEpochDay(dateLabel) {
  const [year, month, day] = dateLabel.split("-").map((part) => Number(part));
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return Number.NaN;
  }

  return Math.floor(timestamp / 86_400_000);
}

function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readComparableMetric(metrics, keys) {
  for (const key of keys) {
    if (metrics[key] !== undefined) {
      return {
        value: stringifyMetric(metrics[key]),
        format: readMetricFormat(metrics[key]),
      };
    }
  }

  return {
    value: "unavailable",
    format: "unavailable",
  };
}

function readComparablePnlSummaryMetric(metrics) {
  if (metrics.pnlSummary === undefined) {
    return {
      value: "unavailable",
      format: "unavailable",
    };
  }

  // compare report만 보고도 손익 증거 누락을 알 수 있어야 하므로 null/부분 shape는 통과시키지 않는다.
  if (!hasValidPnlSummaryShape(metrics.pnlSummary)) {
    return {
      value: stringifyMetric(metrics.pnlSummary),
      format: "invalid",
    };
  }

  return {
    value: stringifyMetric(metrics.pnlSummary),
    format: readMetricFormat(metrics.pnlSummary),
  };
}

function hasValidPnlSummaryShape(value) {
  if (!readRecordOrNull(value)) {
    return false;
  }

  for (const field of ["startingCashKrw", "endingCashKrw", "totalFeesKrw"]) {
    if (!isNumericEvidenceValue(value[field])) {
      return false;
    }
  }

  for (const field of ["positionMarketValueKrw", "realizedPnlKrw", "unrealizedPnlKrw", "totalPnlKrw", "totalReturnBps"]) {
    if (value[field] !== null && !isNumericEvidenceValue(value[field])) {
      return false;
    }
  }

  for (const field of ["submittedOrderCount", "filledOrderCount"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      return false;
    }
  }

  return true;
}

function readRecordOrNull(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function isNumericEvidenceValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  return Number.isFinite(Number(value));
}

function readMetricFormat(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function stringifyMetric(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function hasNotificationResolutionEvidence(checks, summary) {
  if (
    checks.notificationRetry?.status === "ok" ||
    checks.notificationRetryWorker?.status === "ok" ||
    checks.notificationFailureResolved?.status === "ok" ||
    checks.notificationManualReviewCompleted?.status === "ok"
  ) {
    return true;
  }

  const metrics = readRecord(summary.metrics);
  return metrics.notificationRetryResolved === true || metrics.notificationManualReviewCompleted === true;
}

function rowFailure(row, code, message, evidence = {}) {
  return {
    day: row.day,
    code,
    message,
    evidence: {
      summaryPath: row.summaryPath,
      ...evidence,
    },
  };
}

function rowWarning(row, code, message) {
  return {
    day: row.day,
    code,
    message,
    evidence: {
      summaryPath: row.summaryPath,
    },
  };
}

function renderMarkdownComparison(comparison) {
  const rows = comparison.rows
    .map(
      (row) =>
        `| ${row.day} | ${row.date} | ${shortCommit(row.commit)} | ${escapeTable(row.reportArtifact ?? "missing")} | ${formatCount(
          row.crashCount,
        )} | ${formatCount(row.unhandledRejectionCount)} | ${formatCount(row.liveOrderApiCalls)} | ${formatCount(
          row.auditMissingCount,
        )} | ${formatNotification(row)} | ${row.dailyReportGenerated ? "yes" : "no"} | ${escapeTable(row.pnlSummary)} | ${escapeTable(row.cost)} | ${escapeTable(
          row.slippage,
        )} | ${escapeTable(row.fillRate)} | ${escapeTable(row.blockingReasons)} |`,
    )
    .join("\n");
  const failureRows =
    comparison.failures.length === 0
      ? "- 없음"
      : comparison.failures.map((failure) => `- ${failure.day ?? "전체"}: ${failure.message} (${failure.code})`).join("\n");
  const warningRows =
    comparison.warnings.length === 0
      ? "- 없음"
      : comparison.warnings.map((warning) => `- ${warning.day}: ${warning.message} (${warning.code})`).join("\n");

  return `# M9 3일 Paper Report 비교

- 비교 상태: ${comparison.status}
- 입력 summary: ${comparison.inputCount}
- 생성 시각: ${comparison.generatedAt}

| 일차 | 날짜 | commit | report artifact | crash | unhandled rejection | live order API | audit missing | notification failure | daily report | KRW 손익 요약 | 비용 | 슬리피지 | 체결률 | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## 완료 판단

${failureRows}

## 추가 확인

${warningRows}
`;
}

function shortCommit(commit) {
  return commit === "unknown" ? commit : commit.slice(0, 12);
}

function formatCount(value) {
  return value === null ? "unknown" : String(value);
}

function formatNotification(row) {
  const suffix = row.notificationResolved ? " resolved" : "";
  return `${formatCount(row.notificationFailureCount)}${suffix}`;
}

function escapeTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/compare-m9-paper-reports.mjs --summary day1.json --summary day2.json --summary day3.json [options]

Options:
  --summary <path>  Soak summary JSON path. Repeat at least 3 times. Positional paths are also accepted.
  --output <path>   Write Markdown comparison report to this path.
  --json            Print machine-readable comparison JSON.
  --help, -h        Show this help.
`);
}
