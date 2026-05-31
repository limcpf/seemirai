import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CalibrationEvidenceInput,
  CalibrationMetricSummary,
  CalibrationRunSummary,
  CalibrationSourceArtifacts,
} from "./types.js";

/**
 * 내부 evidence 문서를 M11 calibration 입력 contract로 읽는다.
 *
 * 기본값은 저장소 안 문서만 읽어 vault artifact 의존 없이 동작한다. `readSourceArtifacts`를 켜면 문서의
 * Source artifacts 경로에서 aggregate/day summary JSON을 다시 읽어 원천 artifact 기반 입력으로 교체한다.
 */
export async function readCalibrationEvidenceInput(options: {
  evidencePath: string;
  readSourceArtifacts?: boolean;
}): Promise<CalibrationEvidenceInput> {
  const evidencePath = path.resolve(options.evidencePath);
  const markdown = await readFile(evidencePath, "utf8");
  const sourceArtifacts = parseSourceArtifacts(markdown);

  if (options.readSourceArtifacts === true) {
    const aggregate = await readCalibrationArtifactSummary({
      summaryPath: requirePath(sourceArtifacts.aggregateSummaryPath, "aggregate summary"),
      day: null,
    });
    const days = await Promise.all(
      sourceArtifacts.daySummaryPaths
        .slice()
        .sort((left, right) => left.day - right.day)
        .map((entry) => readCalibrationArtifactSummary({ summaryPath: entry.path, day: entry.day })),
    );
    return createInput({ evidencePath, markdown, sourceArtifacts, aggregate, days });
  }

  const documentAggregate = parseDocumentAggregateSummary({ evidencePath, markdown });
  const documentDays = parseDocumentDaySummaries({ evidencePath, markdown });

  return createInput({
    evidencePath,
    markdown,
    sourceArtifacts,
    aggregate: documentAggregate,
    days: documentDays,
  });
}

/**
 * M9 paper summary JSON artifact를 calibration summary로 정규화한다.
 *
 * summary JSON은 runner가 만든 원천 artifact이며, reader는 `metrics` 아래 필수 필드를 그대로 읽는다. 필드가 없거나
 * 타입이 맞지 않으면 예외를 던져 호출자가 fail-closed 상태로 기록하게 한다.
 */
export async function readCalibrationArtifactSummary(options: { summaryPath: string; day?: number | null }): Promise<CalibrationRunSummary> {
  const summaryPath = path.resolve(options.summaryPath);
  const parsed = JSON.parse(await readFile(summaryPath, "utf8")) as unknown;
  const record = requireRecord(parsed, "summary");
  const metrics = parseMetrics(requireRecord(record.metrics, "summary.metrics"), `artifact:${summaryPath}`);
  const sourceDay = readNullableNumber(record.day);
  if (options.day !== undefined && options.day !== null && sourceDay !== null && sourceDay !== options.day) {
    // 파일명에서 기대한 Day와 artifact 내부 Day가 다르면 동일 run shape 증거가 섞인 것이므로 즉시 차단한다.
    throw new Error(`artifact:${summaryPath}.day must match expected Day ${options.day}`);
  }

  return {
    sourceKind: "artifact_summary",
    sourcePath: summaryPath,
    day: options.day ?? sourceDay,
    status: requireString(record.status, "summary.status"),
    startedAt: readNullableString(record.startedAt),
    finishedAt: readNullableString(record.finishedAt),
    metrics,
    trace: {
      input: readNullableString(record.input),
      runId: readNullableString(record.runId),
    },
  };
}

function createInput(input: {
  evidencePath: string;
  markdown: string;
  sourceArtifacts: CalibrationSourceArtifacts;
  aggregate: CalibrationRunSummary;
  days: readonly CalibrationRunSummary[];
}): CalibrationEvidenceInput {
  return {
    evidencePath: input.evidencePath,
    targetIssue: parseLineValue(input.markdown, "- 대상 issue:"),
    runPrefix: parseLineValue(input.markdown, "- run prefix:"),
    status: parseLineValue(input.markdown, "- 판정:"),
    sourceArtifacts: input.sourceArtifacts,
    validationCommand: parseValidationCommand(input.markdown),
    aggregate: input.aggregate,
    days: input.days,
  };
}

function parseDocumentAggregateSummary(input: { evidencePath: string; markdown: string }): CalibrationRunSummary {
  const aggregate = parseTable(input.markdown, "## Aggregate result");
  const cost = parseTable(input.markdown, "## Cost, slippage, and blocking");
  const metricRecord = {
    costSummary: {
      evaluatedCount: readTableNumber(cost, "costSummary.evaluatedCount"),
      allowedCount: readTableNumber(cost, "costSummary.allowedCount"),
      rejectedCount: readTableNumber(cost, "costSummary.rejectedCount"),
      averageCostBps: readTableNullableString(cost, "averageCostBps"),
      averageRequiredReturnBps: readTableNullableString(cost, "averageRequiredReturnBps"),
      averageMarginBps: readTableNullableString(cost, "averageMarginBps"),
    },
    slippageSummary: {
      observedFillCount: readTableNumber(cost, "slippageSummary.observedFillCount"),
      averageSlippageBps: readTableNullableString(cost, "averageSlippageBps"),
      minSlippageBps: readTableNullableString(cost, "minSlippageBps"),
      maxSlippageBps: readTableNullableString(cost, "maxSlippageBps"),
    },
    holdReasonCounts: readTableJsonRecord(cost, "holdReasonCounts"),
    discardReasonCounts: readTableJsonRecord(cost, "discardReasonCounts"),
    blockingReasonCounts: readTableJsonRecord(cost, "blockingReasonCounts"),
    costRejectedCount: readTableNumber(cost, "costRejectedCount"),
    riskRejectedCount: readTableNumber(cost, "riskRejectedCount"),
    paperOrderSubmittedCount: readTableNumber(aggregate, "paperOrderSubmittedCount"),
    paperFillCount: readTableNumber(aggregate, "paperFillCount"),
    fillRate: readTableNumber(aggregate, "fillRate"),
    liveOrderApiCalls: readTableNumber(aggregate, "liveOrderApiCalls"),
  };

  return {
    sourceKind: "evidence_document",
    sourcePath: input.evidencePath,
    day: null,
    status: readTableString(aggregate, "status"),
    startedAt: readTableNullableString(aggregate, "startedAt"),
    finishedAt: readTableNullableString(aggregate, "finishedAt"),
    metrics: parseMetrics(metricRecord, `document:${input.evidencePath}:aggregate`),
  };
}

function parseDocumentDaySummaries(input: { evidencePath: string; markdown: string }): CalibrationRunSummary[] {
  const table = parseTableRows(input.markdown, "## Day comparison");
  return table.map((row) => {
    const day = parseDayLabel(row["일차"] ?? "");
    const [startedAt, finishedAt] = (row["기간"] ?? "").split(" - ").map((value) => stripCode(value.trim()));
    const submittedAndFill = parseSubmittedAndFillCell(row["submitted/fill"] ?? "");
    const blockingReasonCounts = parseBlockingReasonText(row["주요 차단 사유"] ?? "");
    const costRejectedCount = sumReasonCounts(blockingReasonCounts, "cost");
    const costEvaluatedCount = parseInteger(row["cost evaluated"], "day.costSummary.evaluatedCount");

    const metricRecord = {
      costSummary: {
        evaluatedCount: costEvaluatedCount,
        allowedCount: costEvaluatedCount - costRejectedCount,
        rejectedCount: costRejectedCount,
        averageCostBps: null,
        averageRequiredReturnBps: null,
        averageMarginBps: stripCode(row.averageMarginBps ?? ""),
      },
      slippageSummary: {
        observedFillCount: requireArrayNumber(submittedAndFill, 1, "day.slippageSummary.observedFillCount"),
        averageSlippageBps: null,
        minSlippageBps: null,
        maxSlippageBps: null,
      },
      holdReasonCounts: filterBlockingCounts(blockingReasonCounts, "hold"),
      discardReasonCounts: filterBlockingCounts(blockingReasonCounts, "discard"),
      blockingReasonCounts,
      costRejectedCount,
      riskRejectedCount: parseInteger(row.riskRejectedCount, "day.riskRejectedCount"),
      paperOrderSubmittedCount: requireArrayNumber(submittedAndFill, 0, "day.paperOrderSubmittedCount"),
      paperFillCount: requireArrayNumber(submittedAndFill, 1, "day.paperFillCount"),
      fillRate: parseFiniteNumber(row.fillRate, "day.fillRate"),
      liveOrderApiCalls: 0,
    };

    return {
      sourceKind: "evidence_document",
      sourcePath: input.evidencePath,
      day,
      status: stripCode(row.status ?? ""),
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null,
      metrics: parseMetrics(metricRecord, `document:${input.evidencePath}:day:${day}`),
      trace: { dayComparisonRow: row },
    };
  });
}

function parseDayLabel(value: string): number {
  const match = /^Day (?<day>[1-3])$/u.exec(stripCode(value));
  if (match?.groups?.day === undefined) {
    throw new Error("day.label must match Day N");
  }
  return parseInteger(match.groups.day, "day.label");
}

function filterBlockingCounts(counts: Record<string, number>, prefix: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([key, value]) => [key.slice(prefix.length + 1), value]),
  );
}

function parseMetrics(value: unknown, context: string): CalibrationMetricSummary {
  const record = requireRecord(value, `${context}.metrics`);
  const costSummary = requireRecord(record.costSummary, `${context}.metrics.costSummary`);
  const slippageSummary = requireRecord(record.slippageSummary, `${context}.metrics.slippageSummary`);

  return {
    costSummary: {
      evaluatedCount: requireSafeInteger(costSummary.evaluatedCount, `${context}.metrics.costSummary.evaluatedCount`),
      allowedCount: requireSafeInteger(costSummary.allowedCount, `${context}.metrics.costSummary.allowedCount`),
      rejectedCount: requireSafeInteger(costSummary.rejectedCount, `${context}.metrics.costSummary.rejectedCount`),
      averageCostBps: readNullableDecimalString(costSummary.averageCostBps, `${context}.metrics.costSummary.averageCostBps`),
      averageRequiredReturnBps: readNullableDecimalString(
        costSummary.averageRequiredReturnBps,
        `${context}.metrics.costSummary.averageRequiredReturnBps`,
      ),
      averageMarginBps: readNullableDecimalString(costSummary.averageMarginBps, `${context}.metrics.costSummary.averageMarginBps`),
    },
    slippageSummary: {
      observedFillCount: requireSafeInteger(slippageSummary.observedFillCount, `${context}.metrics.slippageSummary.observedFillCount`),
      averageSlippageBps: readNullableDecimalString(
        slippageSummary.averageSlippageBps,
        `${context}.metrics.slippageSummary.averageSlippageBps`,
      ),
      minSlippageBps: readNullableDecimalString(slippageSummary.minSlippageBps, `${context}.metrics.slippageSummary.minSlippageBps`),
      maxSlippageBps: readNullableDecimalString(slippageSummary.maxSlippageBps, `${context}.metrics.slippageSummary.maxSlippageBps`),
    },
    holdReasonCounts: requireCountRecord(record.holdReasonCounts, `${context}.metrics.holdReasonCounts`),
    discardReasonCounts: requireCountRecord(record.discardReasonCounts, `${context}.metrics.discardReasonCounts`),
    blockingReasonCounts: requireCountRecord(record.blockingReasonCounts, `${context}.metrics.blockingReasonCounts`),
    costRejectedCount: requireSafeInteger(record.costRejectedCount, `${context}.metrics.costRejectedCount`),
    riskRejectedCount: requireSafeInteger(record.riskRejectedCount, `${context}.metrics.riskRejectedCount`),
    paperOrderSubmittedCount: requireSafeInteger(record.paperOrderSubmittedCount, `${context}.metrics.paperOrderSubmittedCount`),
    paperFillCount: requireSafeInteger(record.paperFillCount, `${context}.metrics.paperFillCount`),
    fillRate: requireFiniteNumber(record.fillRate, `${context}.metrics.fillRate`),
    liveOrderApiCalls: requireSafeInteger(record.liveOrderApiCalls, `${context}.metrics.liveOrderApiCalls`),
  };
}

function parseSourceArtifacts(markdown: string): CalibrationSourceArtifacts {
  const sourceSection = readSection(markdown, "## Source artifacts");
  const sourceEntries = new Map<string, string>();
  const sourcePattern = /^- ([^:]+): `([^`]+)`$/gmu;
  for (const match of sourceSection.matchAll(sourcePattern)) {
    sourceEntries.set(match[1] ?? "", match[2] ?? "");
  }

  return {
    aggregateSummaryPath: sourceEntries.get("aggregate summary") ?? null,
    aggregateReportPath: sourceEntries.get("aggregate report") ?? null,
    daySummaryPaths: expandDayPaths(sourceEntries.get("day summaries") ?? null),
    dayReportPaths: expandDayPaths(sourceEntries.get("day reports") ?? null),
    comparisonReportPath: sourceEntries.get("3일 비교 report") ?? null,
    rawEventLogPath: sourceEntries.get("raw event log") ?? null,
  };
}

function expandDayPaths(pattern: string | null): { day: number; path: string }[] {
  if (pattern === null) {
    return [];
  }
  return [1, 2, 3].map((day) => ({
    day,
    path: pattern.replace("{1,2,3}", String(day)),
  }));
}

function parseTable(markdown: string, heading: string): Map<string, string> {
  const rows = parseTableRows(markdown, heading);
  const entries = rows.map((row) => [row["항목"], row["값"]] as const).filter((entry): entry is readonly [string, string] => entry[0] !== undefined && entry[1] !== undefined);
  return new Map(entries);
}

function parseTableRows(markdown: string, heading: string): Record<string, string>[] {
  const section = readSection(markdown, heading);
  const lines = section
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (lines.length < 2) {
    return [];
  }
  const headers = splitTableRow(lines[0] ?? "");
  return lines.slice(2).map((line) => {
    const cells = splitTableRow(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function splitTableRow(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function readSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) {
    return "";
  }
  const next = markdown.indexOf("\n## ", start + heading.length);
  return next < 0 ? markdown.slice(start) : markdown.slice(start, next);
}

function parseLineValue(markdown: string, prefix: string): string | null {
  const line = markdown.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : stripCode(line.slice(prefix.length).trim());
}

function parseValidationCommand(markdown: string): string | null {
  const section = readSection(markdown, "## Validation command");
  const match = /```sh\n([\s\S]*?)\n```/u.exec(section);
  return match?.[1]?.trim() ?? null;
}

function readTableString(table: Map<string, string>, key: string): string {
  return stripCode(requireValue(table.get(key), `table.${key}`));
}

function readTableNullableString(table: Map<string, string>, key: string): string | null {
  const value = table.get(key);
  if (value === undefined) {
    return null;
  }
  const stripped = stripCode(value);
  return stripped === "null" || stripped === "" ? null : stripped;
}

function readTableNumber(table: Map<string, string>, key: string): number {
  return parseFiniteNumber(requireValue(table.get(key), `table.${key}`), `table.${key}`);
}

function readTableJsonRecord(table: Map<string, string>, key: string): Record<string, number> {
  const value = readTableString(table, key);
  return requireCountRecord(JSON.parse(value), `table.${key}`);
}

function parseBlockingReasonText(value: string): Record<string, number> {
  const stripped = stripCode(value);
  if (stripped.length === 0) {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const entry of stripped.split(",")) {
    const parts = entry.split("=").map((part) => stripCode(part.trim()));
    if (parts.length !== 2) {
      throw new Error("blockingReason.item must match reason=count");
    }
    const [rawKey, count] = parts;
    const key = requireValue(rawKey, "blocking reason key");
    if (key in counts) {
      throw new Error(`blockingReason.${key} must be unique`);
    }
    counts[key] = parseInteger(count, `blockingReasonCounts.${key}`);
  }
  return counts;
}

function parseSubmittedAndFillCell(value: string): [number, number] {
  const parts = stripCode(value).split("/");
  if (parts.length !== 2) {
    throw new Error("day.submittedFill must match submitted / fill");
  }
  return [
    parseInteger(parts[0]?.trim(), "day.paperOrderSubmittedCount"),
    parseInteger(parts[1]?.trim(), "day.paperFillCount"),
  ];
}

function sumReasonCounts(counts: Record<string, number>, prefix: string): number {
  return Object.entries(counts)
    .filter(([key]) => key.startsWith(`${prefix}:`))
    .reduce((total, [, count]) => total + count, 0);
}

function stripCode(value: string): string {
  return value.trim().replace(/^`|`$/gu, "");
}

function parseFiniteNumber(value: unknown, fieldPath: string): number {
  if (typeof value === "string") {
    const stripped = stripCode(value);
    if (stripped.length === 0) {
      throw new Error(`${fieldPath} is required`);
    }
    if (!/^-?\d+(?:\.\d+)?$/u.test(stripped)) {
      throw new Error(`${fieldPath} must be a decimal number`);
    }
    return requireFiniteNumber(Number(stripped), fieldPath);
  }
  return requireFiniteNumber(value, fieldPath);
}

function parseInteger(value: unknown, fieldPath: string): number {
  if (typeof value === "string") {
    const stripped = stripCode(value);
    if (stripped.length === 0) {
      throw new Error(`${fieldPath} is required`);
    }
    if (!/^-?\d+$/u.test(stripped)) {
      throw new Error(`${fieldPath} must be a safe integer`);
    }
    return requireSafeInteger(Number.parseInt(stripped, 10), fieldPath);
  }
  return requireSafeInteger(value, fieldPath);
}

function requireArrayNumber(values: readonly number[], index: number, fieldPath: string): number {
  return requireSafeInteger(values[index], fieldPath);
}

function requirePath(value: string | null, label: string): string {
  if (value === null) {
    throw new Error(`${label} source artifact path is missing`);
  }
  return value;
}

function requireValue<T>(value: T | null | undefined, fieldPath: string): T {
  if (value === undefined || value === null) {
    throw new Error(`${fieldPath} is required`);
  }
  return value;
}

function requireRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireCountRecord(value: unknown, fieldPath: string): Record<string, number> {
  const record = requireRecord(value, fieldPath);
  return Object.fromEntries(
    Object.entries(record).map(([key, count]) => [key, requireSafeInteger(count, `${fieldPath}.${key}`)]),
  );
}

function requireSafeInteger(value: unknown, fieldPath: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") {
    throw new Error(`${fieldPath} must be a safe integer`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, fieldPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldPath} must be a finite number`);
  }
  return value;
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableDecimalString(value: unknown, fieldPath: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldPath} must be a decimal string or null`);
  }
  if (value.length === 0 || !Number.isFinite(Number(value))) {
    throw new Error(`${fieldPath} must be a finite decimal string`);
  }
  return value;
}
