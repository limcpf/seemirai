#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Decimal } from "decimal.js";
import pg from "pg";

const { Pool } = pg;

const defaultStrategyId = "live_ops_autonomous_24x7_core";
const defaultMarket = "KRW-BTC";
const thresholdSpecs = [
  {
    thresholdKey: "min_entry_margin_bps",
    featureKey: "cost_adjusted_margin_bps",
    label: "비용 차감 후 margin",
  },
  {
    thresholdKey: "trend_confirmation_bps",
    featureKey: "trend_strength_bps",
    label: "추세 확인",
  },
  {
    thresholdKey: "mean_reversion_discount_bps",
    featureKey: "mean_reversion_discount_bps",
    label: "평균회귀 할인",
  },
];

if (isCliEntrypoint()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`live decision calibration report 생성 실패: ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const input = await readRunnerInput(options);
  const report = createLiveDecisionCalibrationReport({
    generatedAt: new Date().toISOString(),
    source: input.source,
    ticks: input.ticks,
    outcomes: input.outcomes,
    window: input.window,
  });
  const markdown = renderLiveDecisionCalibrationMarkdown(report);

  if (options.outputPath !== undefined) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, markdown, "utf8");
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
  }

  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    databaseUrl: undefined,
    help: false,
    inputPath: undefined,
    json: false,
    market: defaultMarket,
    outputPath: undefined,
    strategyId: defaultStrategyId,
    windowEndAt: undefined,
    windowStartAt: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--database-url":
        options.databaseUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--input":
        options.inputPath = path.resolve(readArgValue(argv, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--market":
        options.market = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readArgValue(argv, index, arg));
        index += 1;
        break;
      case "--strategy-id":
        options.strategyId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--window-end":
        options.windowEndAt = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--window-start":
        options.windowStartAt = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.inputPath = path.resolve(arg);
        break;
    }
  }

  return options;
}

function readArgValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readRunnerInput(options) {
  if (options.inputPath !== undefined) {
    const parsed = JSON.parse(await readFile(options.inputPath, "utf8"));
    return normalizeInputPayload(parsed, {
      source: {
        kind: "json",
        label: options.inputPath,
      },
      window: createWindow(options),
    });
  }

  if (options.databaseUrl !== undefined) {
    if (!hasText(options.windowStartAt) || !hasText(options.windowEndAt)) {
      throw new Error("--database-url requires --window-start and --window-end");
    }
    return readDatabaseInput(options);
  }

  throw new Error("--input 또는 --database-url 중 하나가 필요합니다.");
}

async function readDatabaseInput(options) {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: 3_000,
    max: 1,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
  });
  try {
    const [ticksResult, ordersResult, fillsResult] = await Promise.all([
      pool.query(
        `SELECT exchange, market, strategy_id, decision_kind, reason_code, feature_snapshot_json, threshold_json,
                order_intent_count, observed_at, decision_at, trace_json
           FROM live_decision_ticks
          WHERE market = $1
            AND strategy_id = $2
            AND observed_at >= $3
            AND observed_at <= $4
          ORDER BY observed_at ASC, decision_at ASC`,
        [options.market, options.strategyId, options.windowStartAt, options.windowEndAt],
      ),
      pool.query(
        `SELECT id, status, side, created_at
           FROM orders
          WHERE market = $1
            AND strategy_id = $2
            AND created_at >= $3
            AND created_at <= $4
          ORDER BY created_at ASC`,
        [options.market, options.strategyId, options.windowStartAt, options.windowEndAt],
      ),
      pool.query(
        `SELECT fills.id, fills.side, fills.price, fills.quantity, fills.filled_at
           FROM fills
           JOIN orders ON orders.id = fills.order_id
          WHERE orders.market = $1
            AND orders.strategy_id = $2
            AND fills.filled_at >= $3
            AND fills.filled_at <= $4
          ORDER BY fills.filled_at ASC`,
        [options.market, options.strategyId, options.windowStartAt, options.windowEndAt],
      ),
    ]);

    return {
      source: {
        kind: "database",
        label: "live_decision_ticks",
      },
      ticks: ticksResult.rows,
      outcomes: {
        fills: fillsResult.rows,
        orders: ordersResult.rows,
      },
      window: createWindow(options),
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function normalizeInputPayload(payload, fallback) {
  if (Array.isArray(payload)) {
    return {
      source: fallback.source,
      ticks: payload,
      outcomes: {},
      window: fallback.window,
    };
  }

  if (!isRecord(payload)) {
    throw new Error("input payload must be an array or object");
  }

  return {
    source: isRecord(payload.source) ? payload.source : fallback.source,
    ticks: Array.isArray(payload.ticks) ? payload.ticks : [],
    outcomes: isRecord(payload.outcomes) ? payload.outcomes : {},
    window: isRecord(payload.window) ? { ...fallback.window, ...payload.window } : fallback.window,
  };
}

function createWindow(options) {
  return {
    market: options.market ?? defaultMarket,
    strategyId: options.strategyId ?? defaultStrategyId,
    windowEndAt: options.windowEndAt ?? null,
    windowStartAt: options.windowStartAt ?? null,
  };
}

export function createLiveDecisionCalibrationReport(input) {
  const ticks = Array.isArray(input.ticks) ? input.ticks.map(normalizeTick) : [];
  const validation = validateReportInput(ticks);
  const decisionCounts = countBy(ticks, (tick) => tick.decisionKind);
  const reasonCounts = countBy(ticks, (tick) => tick.reasonCode ?? "unknown");
  const featureQuality = createFeatureQuality(ticks);
  const thresholdQuality = createThresholdQuality(ticks);
  const candidateOutcome = createCandidateOutcome(ticks, input.outcomes);
  const status = validation.failures.length === 0 ? "passed" : "failed";

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    status,
    statusLabel: status === "passed" ? "통과" : "실패",
    operatorSummary: status === "passed"
      ? "live decision tick 기준으로 threshold 품질과 후보/실현 결과를 재현 가능한 report로 생성했습니다."
      : "live decision tick이 부족해 calibration report를 생성할 수 없습니다.",
    action: status === "passed"
      ? "후보 수, feature source, threshold 통과율을 확인한 뒤 별도 승인 PR에서 설정 변경 여부를 판단하세요."
      : "먼저 live_decision_ticks 적재와 조회 window를 확인하세요.",
    source: input.source ?? { kind: "unknown", label: "unknown" },
    window: input.window ?? {},
    tickCount: ticks.length,
    decisionCounts,
    reasonCounts,
    featureQuality,
    thresholdQuality,
    candidateOutcome,
    validation,
    trace: {
      decisionKinds: Object.keys(decisionCounts).sort(),
      thresholdKeys: thresholdQuality.checks.map((check) => check.thresholdKey),
    },
  };
}

function normalizeTick(raw) {
  const featureSnapshot = readRecord(raw.feature_snapshot_json ?? raw.featureSnapshot);
  const thresholdSnapshot = readRecord(raw.threshold_json ?? raw.thresholdSnapshot ?? raw.threshold);
  const trace = readRecord(raw.trace_json ?? raw.trace);
  const decisionKind = String(raw.decision_kind ?? raw.decisionKind ?? "UNKNOWN").toUpperCase();
  const observedAt = normalizeTimestamp(raw.observed_at ?? raw.observedAt);

  return {
    decisionKind,
    featureSnapshot,
    market: stringOrNull(raw.market),
    observedAt,
    orderIntentCount: toSafeInteger(raw.order_intent_count ?? raw.orderIntentCount, 0),
    reasonCode: stringOrNull(raw.reason_code ?? raw.reasonCode),
    strategyId: stringOrNull(raw.strategy_id ?? raw.strategyId),
    thresholdSnapshot,
    trace,
  };
}

function validateReportInput(ticks) {
  const failures = [];
  if (ticks.length === 0) {
    failures.push({
      severity: "error",
      fieldPath: "ticks",
      message: "calibration report를 만들 live decision tick이 없습니다.",
    });
  }
  return {
    passed: failures.length === 0,
    failures,
  };
}

function createFeatureQuality(ticks) {
  const statusCounts = {};
  const sourceCounts = {};
  const failureReasonCounts = {};

  for (const tick of ticks) {
    const snapshot = tick.featureSnapshot;
    const status = typeof snapshot.status === "string"
      ? snapshot.status
      : isRecord(snapshot.features)
        ? "ok"
        : "not_run";
    increment(statusCounts, status);
    increment(sourceCounts, readFeatureSource(snapshot));

    const failures = Array.isArray(snapshot.failureReasons) ? snapshot.failureReasons : [];
    for (const failure of failures) {
      const reasonCode = isRecord(failure) && hasText(failure.reasonCode) ? failure.reasonCode : "unknown";
      increment(failureReasonCounts, reasonCode);
    }
  }

  return {
    failureReasonCounts,
    sourceCounts,
    statusCounts,
  };
}

function createThresholdQuality(ticks) {
  const checks = thresholdSpecs.map((spec) => {
    let missingCount = 0;
    let passCount = 0;
    let totalCount = 0;

    for (const tick of ticks) {
      const features = readRecord(tick.featureSnapshot.features);
      const thresholds = readStrategyThresholds(tick.thresholdSnapshot);
      const featureValue = readDecimal(features[spec.featureKey]);
      const thresholdValue = readDecimal(thresholds[spec.thresholdKey]);
      if (featureValue === undefined || thresholdValue === undefined) {
        missingCount += 1;
        continue;
      }

      totalCount += 1;
      if (featureValue.gte(thresholdValue)) {
        passCount += 1;
      }
    }

    return {
      featureKey: spec.featureKey,
      label: spec.label,
      missingCount,
      passCount,
      thresholdKey: spec.thresholdKey,
      totalCount,
      passRate: totalCount === 0 ? null : Number((passCount / totalCount).toFixed(6)),
    };
  });

  return {
    checks,
  };
}

function createCandidateOutcome(ticks, outcomes = {}) {
  const orders = Array.isArray(outcomes.orders) ? outcomes.orders : [];
  const fills = Array.isArray(outcomes.fills) ? outcomes.fills : [];
  const totalOrderIntentCount = ticks.reduce((sum, tick) => sum + tick.orderIntentCount, 0);
  const candidateTickCount = ticks.filter((tick) => tick.orderIntentCount > 0).length;

  return {
    candidateTickCount,
    fillCount: fills.length,
    orderCount: orders.length,
    orderStatusCounts: countBy(orders, (order) => isRecord(order) && hasText(order.status) ? String(order.status) : "unknown"),
    realizedFillRate: orders.length === 0 ? null : Number((fills.length / orders.length).toFixed(6)),
    totalOrderIntentCount,
  };
}

function readStrategyThresholds(snapshot) {
  if (isRecord(snapshot.strategyThresholds)) {
    return snapshot.strategyThresholds;
  }
  if (isRecord(snapshot.strategy_thresholds)) {
    return snapshot.strategy_thresholds;
  }
  return snapshot;
}

function readFeatureSource(snapshot) {
  const metadata = readRecord(snapshot.metadata);
  const features = readRecord(snapshot.features);
  if (hasText(metadata.feature_source)) {
    return metadata.feature_source;
  }
  if (hasText(metadata.source)) {
    return metadata.source;
  }
  if (hasText(features.feature_source)) {
    return features.feature_source;
  }
  return "unknown";
}

export function renderLiveDecisionCalibrationMarkdown(report) {
  const lines = [
    "# Live Decision Threshold Calibration Report",
    "",
    `- 판정: ${report.statusLabel}`,
    `- 생성 시각: ${report.generatedAt}`,
    `- 대상 market: ${report.window.market ?? "unknown"}`,
    `- 대상 strategy: ${report.window.strategyId ?? "unknown"}`,
    `- 조회 범위: ${report.window.windowStartAt ?? "unknown"} ~ ${report.window.windowEndAt ?? "unknown"}`,
    `- 요약: ${report.operatorSummary}`,
    `- 필요 조치: ${report.action}`,
    "",
    "## Decision 분포",
    "",
    renderCountTable(report.decisionCounts, "decision", "count"),
    "",
    "## Feature 품질",
    "",
    "### 상태",
    "",
    renderCountTable(report.featureQuality.statusCounts, "status", "count"),
    "",
    "### Source",
    "",
    renderCountTable(report.featureQuality.sourceCounts, "source", "count"),
    "",
    "### 실패 사유",
    "",
    renderCountTable(report.featureQuality.failureReasonCounts, "reason", "count"),
    "",
    "## Threshold 품질",
    "",
    "| threshold | feature | 통과/평가 | passRate | missing |",
    "| --- | --- | ---: | ---: | ---: |",
    ...report.thresholdQuality.checks.map((check) =>
      `| \`${check.thresholdKey}\` | \`${check.featureKey}\` | ${check.passCount}/${check.totalCount} | ${formatNullableNumber(check.passRate)} | ${check.missingCount} |`
    ),
    "",
    "## 후보/실현 결과",
    "",
    `- 후보 tick 수: ${report.candidateOutcome.candidateTickCount}`,
    `- 주문 후보 수 합계: ${report.candidateOutcome.totalOrderIntentCount}`,
    `- 주문 row 수: ${report.candidateOutcome.orderCount}`,
    `- 체결 row 수: ${report.candidateOutcome.fillCount}`,
    `- 실현 fill rate: ${formatNullableNumber(report.candidateOutcome.realizedFillRate)}`,
    "",
    "### 주문 상태",
    "",
    renderCountTable(report.candidateOutcome.orderStatusCounts, "status", "count"),
    "",
    "## 검증",
    "",
    report.validation.passed
      ? "- 입력 검증을 통과했습니다."
      : renderValidationFailures(report.validation.failures),
    "",
    "## 추적 정보",
    "",
    `- source kind: ${report.source.kind ?? "unknown"}`,
    `- source label: ${report.source.label ?? "unknown"}`,
    `- tick count: ${report.tickCount}`,
  ];

  return `${lines.join("\n")}\n`;
}

function renderCountTable(counts, keyLabel, valueLabel) {
  const entries = Object.entries(counts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "_없음_";
  }
  return [
    `| ${keyLabel} | ${valueLabel} |`,
    "| --- | ---: |",
    ...entries.map(([key, value]) => `| \`${key}\` | ${value} |`),
  ].join("\n");
}

function renderValidationFailures(failures) {
  return failures.map((failure) => `- ${failure.message} (추적 정보: \`${failure.fieldPath}\`)`).join("\n");
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    increment(counts, keyFn(item));
  }
  return counts;
}

function increment(counts, key, amount = 1) {
  const normalizedKey = hasText(key) ? String(key) : "unknown";
  counts[normalizedKey] = (counts[normalizedKey] ?? 0) + amount;
}

function readDecimal(value) {
  if (!hasText(value)) {
    return undefined;
  }
  try {
    return new Decimal(value);
  } catch {
    return undefined;
  }
}

function toSafeInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return hasText(value) ? String(value) : null;
}

function stringOrNull(value) {
  return hasText(value) ? String(value) : null;
}

function readRecord(value) {
  return isRecord(value) ? value : {};
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.length > 0;
}

function formatNullableNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/analyze-live-decision-calibration.mjs [options]\n\n`
    + "Options:\n"
    + "  --input <path>          live decision tick JSON input\n"
    + "  --database-url <url>    PostgreSQL URL to query live_decision_ticks/orders/fills\n"
    + "  --window-start <iso>    DB query window start\n"
    + "  --window-end <iso>      DB query window end\n"
    + "  --market <market>       target market (default KRW-BTC)\n"
    + "  --strategy-id <id>      target strategy (default live_ops_autonomous_24x7_core)\n"
    + "  --output <path>         write Markdown artifact\n"
    + "  --json                  print JSON report\n"
    + "  --help                  show help\n");
}

function isCliEntrypoint() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
