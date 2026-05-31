#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultEvidencePath = "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md";
const defaultPaperConfigPath = "config/paper.json";
const defaultOutputDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper");
const knownReasonAxes = new Set(["cost", "risk", "hold", "discard"]);

try {
  await main();
} catch (error) {
  process.stderr.write(`M11 threshold calibration report 생성 실패: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const evidencePath = path.resolve(options.evidencePath ?? defaultEvidencePath);
  const input = await readCalibrationInput({ evidencePath, documentOnly: options.documentOnly });
  const report = createCalibrationReport({ input, generatedAt: new Date().toISOString() });
  report.profileProposal = await createInactiveProfileProposal({
    report,
    paperConfigPath: path.resolve(options.paperConfigPath ?? defaultPaperConfigPath),
  });
  const outputPath = options.outputPath ?? path.join(defaultOutputDir, `m11-threshold-calibration-report-${safeTimestamp(report.generatedAt)}.md`);

  if (options.proposalOutputPath !== undefined) {
    await mkdir(path.dirname(options.proposalOutputPath), { recursive: true });
    await writeFile(options.proposalOutputPath, `${JSON.stringify(report.profileProposal, null, 2)}\n`, "utf8");
    report.outputs.profileProposalPath = options.proposalOutputPath;
  }

  const markdown = renderMarkdownReport(report);

  if (options.outputPath !== undefined) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, "utf8");
    report.outputs.markdownPath = outputPath;
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
    evidencePath: undefined,
    outputPath: undefined,
    proposalOutputPath: undefined,
    paperConfigPath: undefined,
    json: false,
    documentOnly: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--evidence":
        options.evidencePath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--output":
        options.outputPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--proposal-output":
        options.proposalOutputPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--paper-config":
        options.paperConfigPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--document-only":
        options.documentOnly = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        options.evidencePath = arg;
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

async function readCalibrationInput({ evidencePath, documentOnly }) {
  const markdown = await readFile(evidencePath, "utf8");
  const sourceArtifacts = parseSourceArtifacts(markdown);
  const input = {
    evidencePath,
    targetIssue: parseLineValue(markdown, "- 대상 issue:"),
    runPrefix: parseLineValue(markdown, "- run prefix:"),
    status: parseLineValue(markdown, "- 판정:"),
    validationCommand: parseValidationCommand(markdown),
    sourceArtifacts,
  };

  if (documentOnly) {
    return {
      ...input,
      aggregate: parseDocumentAggregateSummary({ evidencePath, markdown }),
      days: parseDocumentDaySummaries({ evidencePath, markdown }),
    };
  }

  let aggregate;
  let days;
  try {
    aggregate = await readArtifactSummary({
      summaryPath: requirePath(sourceArtifacts.aggregateSummaryPath, "aggregate summary"),
      day: null,
    });
    days = await Promise.all(
      sourceArtifacts.daySummaryPaths
        .slice()
        .sort((left, right) => left.day - right.day)
        .map((entry) => readArtifactSummary({ summaryPath: entry.path, day: entry.day })),
    );
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    // 커밋된 evidence만 있는 fresh checkout에서도 report를 재현할 수 있게 source artifact 부재는 문서 표 파싱으로 낮춘다.
    return {
      ...input,
      aggregate: parseDocumentAggregateSummary({ evidencePath, markdown }),
      days: parseDocumentDaySummaries({ evidencePath, markdown }),
    };
  }

  return {
    ...input,
    aggregate,
    days,
  };
}

async function readArtifactSummary({ summaryPath, day }) {
  const resolvedPath = path.resolve(summaryPath);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf8"));
  return {
    sourceKind: "artifact_summary",
    sourcePath: resolvedPath,
    day: day ?? (Number.isSafeInteger(parsed.day) ? parsed.day : null),
    status: readString(parsed.status),
    startedAt: readNullableString(parsed.startedAt),
    finishedAt: readNullableString(parsed.finishedAt),
    metrics: parseMetrics(parsed.metrics, `artifact:${resolvedPath}`),
    trace: {
      input: readNullableString(parsed.input),
      runId: readNullableString(parsed.runId),
    },
  };
}

function createCalibrationReport({ input, generatedAt }) {
  const validation = validateInput(input);
  const analysis = validation.passed ? analyzePolicy(input) : createFailedAnalysis(input, validation);
  const status = validation.passed ? "passed" : "failed";

  return {
    schemaVersion: 1,
    generatedAt,
    status,
    statusLabel: status === "passed" ? "통과" : "실패",
    operatorSummary: analysis.operatorSummary,
    action: createOperatorAction({ status, analysis }),
    evidence: {
      evidencePath: input.evidencePath,
      targetIssue: input.targetIssue,
      runPrefix: input.runPrefix,
      status: input.status,
      validationCommand: input.validationCommand,
    },
    aggregate: createMetricSnapshot(input.aggregate),
    days: input.days.map(createMetricSnapshot),
    reasonBreakdown: analysis.aggregateReasonBreakdown ?? null,
    dayReasonBreakdowns: analysis.dayReasonBreakdowns,
    thresholdRelaxationBlocked: analysis.thresholdRelaxationBlocked,
    thresholdCandidates: analysis.candidates,
    riskInteractions: analysis.riskInteractions,
    validation,
    trace: {
      sourceArtifacts: input.sourceArtifacts,
      aggregateSourcePath: input.aggregate.sourcePath,
      daySourcePaths: input.days.map((day) => ({ day: day.day, path: day.sourcePath })),
    },
    outputs: {
      markdownPath: null,
      profileProposalPath: null,
    },
    profileProposal: null,
  };
}

function validateInput(input) {
  const failures = [];
  if (input.status !== "passed") {
    failures.push(failure("status", "내부 evidence 문서의 판정이 통과가 아니어서 calibration report를 생성할 수 없습니다.", { status: input.status }));
  }
  if (input.validationCommand === null) {
    failures.push(failure("validationCommand", "원천 artifact 재검증 명령이 없어 evidence를 재현할 수 없습니다."));
  }
  if (input.days.length !== 3) {
    failures.push(failure("days", "Day 1/2/3 summary가 모두 있어야 동일 run shape report를 생성할 수 있습니다.", { dayCount: input.days.length }));
  }
  const observedDays = input.days.map((day) => day.day);
  const sortedUniqueDays = [...new Set(observedDays)].sort();
  if (sortedUniqueDays.length !== 3 || sortedUniqueDays[0] !== 1 || sortedUniqueDays[1] !== 2 || sortedUniqueDays[2] !== 3) {
    failures.push(failure("days", "Day summary 번호는 정확히 Day 1/2/3을 한 번씩 포함해야 합니다.", { observedDays }));
  }
  validateRunSummary(input.aggregate, "aggregate", failures);
  input.days.forEach((day, index) => validateRunSummary(day, `days[${index}]`, failures));

  return {
    passed: failures.length === 0,
    failures,
  };
}

function validateRunSummary(summary, fieldPrefix, failures) {
  if (summary.status !== "passed") {
    failures.push(failure(`${fieldPrefix}.status`, "summary 판정이 통과가 아니어서 report 생성을 중단합니다.", { status: summary.status }));
  }

  const metrics = summary.metrics;
  for (const [field, value] of [
    ["costSummary.evaluatedCount", metrics.costSummary.evaluatedCount],
    ["costSummary.allowedCount", metrics.costSummary.allowedCount],
    ["costSummary.rejectedCount", metrics.costSummary.rejectedCount],
    ["slippageSummary.observedFillCount", metrics.slippageSummary.observedFillCount],
    ["costRejectedCount", metrics.costRejectedCount],
    ["riskRejectedCount", metrics.riskRejectedCount],
    ["paperOrderSubmittedCount", metrics.paperOrderSubmittedCount],
    ["paperFillCount", metrics.paperFillCount],
    ["liveOrderApiCalls", metrics.liveOrderApiCalls],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      failures.push(failure(`${fieldPrefix}.metrics.${field}`, "count metric은 0 이상의 안전한 정수여야 합니다.", { value }));
    }
  }

  if (metrics.costSummary.evaluatedCount > 0 && shouldRequireDetailedMetricFields(summary)) {
    for (const [field, value, message] of [
      ["costSummary.averageCostBps", metrics.costSummary.averageCostBps, "비용 평가가 있는 summary에는 평균 비용 bps가 있어야 합니다."],
      [
        "costSummary.averageRequiredReturnBps",
        metrics.costSummary.averageRequiredReturnBps,
        "비용 평가가 있는 summary에는 평균 요구수익률 bps가 있어야 합니다.",
      ],
      ["costSummary.averageMarginBps", metrics.costSummary.averageMarginBps, "비용 평가가 있는 summary에는 평균 margin bps가 있어야 합니다."],
    ]) {
      if (value === null) {
        failures.push(failure(`${fieldPrefix}.metrics.${field}`, message, { sourcePath: summary.sourcePath }));
      }
    }
  }

  if (metrics.slippageSummary.observedFillCount > 0 && shouldRequireDetailedMetricFields(summary)) {
    for (const [field, value, message] of [
      [
        "slippageSummary.averageSlippageBps",
        metrics.slippageSummary.averageSlippageBps,
        "체결이 있는 summary에는 평균 슬리피지 bps가 있어야 합니다.",
      ],
      ["slippageSummary.minSlippageBps", metrics.slippageSummary.minSlippageBps, "체결이 있는 summary에는 최소 슬리피지 bps가 있어야 합니다."],
      ["slippageSummary.maxSlippageBps", metrics.slippageSummary.maxSlippageBps, "체결이 있는 summary에는 최대 슬리피지 bps가 있어야 합니다."],
    ]) {
      if (value === null) {
        failures.push(failure(`${fieldPrefix}.metrics.${field}`, message, { sourcePath: summary.sourcePath }));
      }
    }
  }

  for (const [field, counts] of [
    ["holdReasonCounts", metrics.holdReasonCounts],
    ["discardReasonCounts", metrics.discardReasonCounts],
    ["blockingReasonCounts", metrics.blockingReasonCounts],
  ]) {
    for (const [key, count] of Object.entries(counts)) {
      if (!Number.isSafeInteger(count) || count < 0) {
        failures.push(failure(`${fieldPrefix}.metrics.${field}.${key}`, "reason count는 0 이상의 안전한 정수여야 합니다.", { count }));
      }
    }
  }

  if (metrics.liveOrderApiCalls > 0) {
    failures.push(
      failure(`${fieldPrefix}.metrics.liveOrderApiCalls`, "실거래 주문 API 호출이 감지되어 paper-only calibration report를 생성할 수 없습니다.", {
        count: metrics.liveOrderApiCalls,
        sourcePath: summary.sourcePath,
      }),
    );
  }
}

function shouldRequireDetailedMetricFields(summary) {
  // 커밋된 evidence 표는 vault artifact 경로를 안내하는 축약 view라 상세 평균/최소/최대 metric은 source artifact에서만 강제한다.
  return summary.sourceKind !== "evidence_document";
}

function createFailedAnalysis(input, validation) {
  return {
    status: "failed",
    validation,
    aggregateReasonBreakdown: splitReasonCounts(input.aggregate.metrics),
    dayReasonBreakdowns: input.days.map((day) => ({ day: day.day, breakdown: splitReasonCounts(day.metrics) })),
    thresholdRelaxationBlocked: true,
    candidates: [],
    riskInteractions: [],
    operatorSummary: "calibration 입력 검증이 실패해 threshold 후보 report 생성을 중단했습니다.",
  };
}

function analyzePolicy(input) {
  const aggregateReasonBreakdown = splitReasonCounts(input.aggregate.metrics);
  const averageMarginBps = input.aggregate.metrics.costSummary.averageMarginBps;
  const thresholdRelaxationBlocked = averageMarginBps === null || Number(averageMarginBps) < 0;
  const evidence = {
    averageMarginBps,
    costRejectedCount: input.aggregate.metrics.costRejectedCount,
    riskRejectedCount: input.aggregate.metrics.riskRejectedCount,
    paperOrderSubmittedCount: input.aggregate.metrics.paperOrderSubmittedCount,
    paperFillCount: input.aggregate.metrics.paperFillCount,
    fillRate: input.aggregate.metrics.fillRate,
    costBlockingCount: aggregateReasonBreakdown.cost.totalCount,
    riskBlockingCount: aggregateReasonBreakdown.risk.totalCount,
  };
  const candidates = [
    {
      key: "relax_alpha_thresholds",
      title: "전략 threshold 완화",
      status: thresholdRelaxationBlocked ? "blocked" : "separate_review",
      statusLabel: thresholdRelaxationBlocked ? "차단" : "별도 승인 필요",
      aggressiveness: "aggressive",
      aggressivenessLabel: "공격적",
      direction: "decrease_requires_approval",
      directionLabel: "후보 수를 늘리는 완화 방향",
      rationale: thresholdRelaxationBlocked
        ? "평균 margin이 음수이거나 산출되지 않아 후보 수를 늘리는 완화는 기본 제안으로 승격하지 않습니다."
        : "완화는 주문 수를 늘리는 공격적 변경이므로 별도 report 비교와 승인이 필요합니다.",
      metricEvidence: evidence,
    },
    ...[
      ["cost_safety_buffer_bps", "비용 안전마진", "increase_or_keep", "유지 또는 상향", "cost margin 부족이 반복되므로 안전마진은 낮추지 않고 유지하거나 높이는 방향만 검토합니다."],
      ["min_volume_spike_ratio", "거래대금 spike 하한", "increase_or_keep", "유지 또는 상향", "약한 유동성/관심도 후보를 줄이기 위해 거래대금 spike 기준은 보수적으로 유지하거나 높입니다."],
      [
        "min_session_liquidity_score",
        "세션 유동성 점수 하한",
        "increase_or_keep",
        "유지 또는 상향",
        "체결 품질 비교 전에는 얇은 시간대 후보를 늘리지 않도록 유동성 점수 하한을 낮추지 않습니다.",
      ],
      ["max_spread_bps", "스프레드 상한", "decrease_or_keep", "유지 또는 하향", "비용 차감 후 margin이 부족하므로 허용 spread 상한은 유지하거나 낮추는 방향만 검토합니다."],
      [
        "min_cost_adjusted_margin_bps",
        "비용 차감 후 margin 하한",
        "increase_or_keep",
        "유지 또는 상향",
        "비용 차감 후 기대값이 음수인 상태에서는 margin 하한을 낮춰 후보를 늘리지 않습니다.",
      ],
    ].map(([key, title, direction, directionLabel, rationale]) => ({
      key,
      title,
      status: "recommended",
      statusLabel: "보수 후보",
      aggressiveness: "conservative",
      aggressivenessLabel: "보수적",
      direction,
      directionLabel,
      rationale,
      metricEvidence: evidence,
    })),
  ];

  return {
    status: "ok",
    aggregateReasonBreakdown,
    dayReasonBreakdowns: input.days.map((day) => ({ day: day.day, breakdown: splitReasonCounts(day.metrics) })),
    thresholdRelaxationBlocked,
    candidates,
    riskInteractions: createRiskInteractions(aggregateReasonBreakdown),
    operatorSummary: thresholdRelaxationBlocked
      ? "비용 차감 후 margin이 음수이거나 산출되지 않아 threshold 완화 후보는 기본 제안으로 승격하지 않습니다."
      : "비용 차감 후 margin이 음수가 아니지만 기본 운영값 변경은 별도 승인과 report 비교가 필요합니다.",
  };
}

function createRiskInteractions(reasonBreakdown) {
  return Object.entries(reasonBreakdown.risk.counts)
    .filter(([, count]) => count > 0)
    .map(([reasonCode, count]) => {
      if (reasonCode === "expected_loss_limit_exceeded") {
        return {
          kind: "expected_loss_limit_review",
          title: "예상 손실 한도 검토",
          reasonCode,
          count,
          action: "예상 손실 한도와 전략 threshold 후보를 분리해 검토합니다.",
          rationale: "예상 손실 한도 초과는 alpha threshold 완화로 해결할 문제가 아니라 risk budget 검토 대상입니다.",
        };
      }
      if (reasonCode === "order_notional_limit_exceeded") {
        return {
          kind: "order_notional_limit_review",
          title: "주문 금액 한도 검토",
          reasonCode,
          count,
          action: "주문 금액 한도와 position sizing 설정을 별도 검토합니다.",
          rationale: "주문 금액 한도 초과는 전략 threshold보다 주문 크기와 risk gate 설정의 상호작용입니다.",
        };
      }
      return {
        kind: "risk_reason_review",
        title: "risk gate 차단 검토",
        reasonCode,
        count,
        action: "risk gate 차단 원인을 threshold 후보와 분리해 검토합니다.",
        rationale: "risk gate reason은 후보 생성 조건과 독립적인 운영 안전장치일 수 있습니다.",
      };
    });
}

function splitReasonCounts(metrics) {
  const groups = {
    cost: {},
    risk: {},
    hold: {},
    discard: {},
    unknown: {},
  };
  for (const [rawReason, count] of Object.entries(metrics.blockingReasonCounts)) {
    const parsed = parseBlockingReason(rawReason);
    groups[parsed.axis][parsed.reasonCode] = (groups[parsed.axis][parsed.reasonCode] ?? 0) + count;
  }
  return {
    cost: completeAxis(groups.cost),
    risk: completeAxis(groups.risk),
    hold: completeAxis(groups.hold),
    discard: completeAxis(groups.discard),
    unknown: completeAxis(groups.unknown),
    totals: {
      blockingCount: sumCounts(metrics.blockingReasonCounts),
      explicitHoldCount: sumCounts(metrics.holdReasonCounts),
      explicitDiscardCount: sumCounts(metrics.discardReasonCounts),
    },
  };
}

async function createInactiveProfileProposal({ report, paperConfigPath }) {
  const supportedCandidates = new Map(report.thresholdCandidates.map((candidate) => [candidate.key, candidate]));
  const strategyParameters = report.status === "passed" ? await readStrategyParameters(paperConfigPath) : {};
  const patchOperations = report.status === "passed" ? createConservativePatchOperations({ strategyParameters, supportedCandidates }) : [];
  const manualReviewItems = createManualReviewItems(supportedCandidates);
  const blockedCandidates = report.thresholdCandidates
    .filter((candidate) => candidate.status === "blocked" || candidate.aggressiveness === "aggressive")
    .map((candidate) => ({
      key: candidate.key,
      title: candidate.title,
      status: candidate.status,
      aggressiveness: candidate.aggressiveness,
      reason: candidate.rationale,
      metricEvidence: candidate.metricEvidence,
    }));

  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    active: false,
    activationRequired: true,
    status: report.status === "passed" ? "proposal_ready" : "blocked_by_validation",
    statusLabel: report.status === "passed" ? "비활성 제안 생성" : "입력 검증 실패로 제안 비활성",
    safety: {
      defaultConfigMutation: false,
      baseConfigPath: paperConfigPath,
      activationInstructions:
        "이 산출물은 검토용 후보입니다. 기본 paper config에 자동 적용하지 말고 별도 PR에서 동일 run shape report를 비교한 뒤 수동 승인합니다.",
    },
    source: {
      evidencePath: report.evidence.evidencePath,
      runPrefix: report.evidence.runPrefix,
      generatedAt: report.generatedAt,
      averageMarginBps: report.aggregate.metrics.costSummary.averageMarginBps,
      thresholdRelaxationBlocked: report.thresholdRelaxationBlocked,
    },
    candidateProfile: {
      id: "m11-issue-102-conservative-candidate",
      enabled: false,
      baseConfigPath: paperConfigPath,
      strategyParametersPatch: buildStrategyParametersPatch(patchOperations),
    },
    patchOperations,
    manualReviewItems,
    blockedCandidates,
  };
}

async function readStrategyParameters(paperConfigPath) {
  const parsed = JSON.parse(await readFile(paperConfigPath, "utf8"));
  return requireRecord(requireRecord(parsed, "paperConfig").strategyParameters, "paperConfig.strategyParameters");
}

function createConservativePatchOperations({ strategyParameters, supportedCandidates }) {
  const operations = [];
  const supportedRules = [
    {
      key: "max_spread_bps",
      mutate: (current) => Math.max(1, Number(current) - 1),
      shouldPatch: (current, next) => next < Number(current),
    },
    {
      key: "min_volume_spike_ratio",
      mutate: (current) => Math.max(Number(current), 1.1),
      shouldPatch: (current, next) => next > Number(current),
    },
    {
      key: "min_session_liquidity_score",
      mutate: (current) => Math.max(Number(current), 0.2),
      shouldPatch: (current, next) => next > Number(current),
    },
    {
      key: "min_cost_adjusted_margin_bps",
      mutate: (current) => Math.max(Number(current), 2),
      shouldPatch: (current, next) => next > Number(current),
    },
  ];

  for (const [strategy, parameters] of Object.entries(strategyParameters)) {
    const record = requireRecord(parameters, `paperConfig.strategyParameters.${strategy}`);
    for (const rule of supportedRules) {
      const candidate = supportedCandidates.get(rule.key);
      if (candidate === undefined || candidate.aggressiveness !== "conservative" || !(rule.key in record)) {
        continue;
      }
      const current = requireDecimalLike(record[rule.key], `paperConfig.strategyParameters.${strategy}.${rule.key}`);
      const next = rule.mutate(current);
      if (!Number.isFinite(next) || !rule.shouldPatch(current, next)) {
        continue;
      }
      operations.push({
        op: "replace",
        path: `/strategyParameters/${strategy}/${rule.key}`,
        value: formatDecimal(next),
        from: current,
        to: formatDecimal(next),
        candidateKey: rule.key,
        strategy,
        direction: candidate.direction,
        aggressiveness: candidate.aggressiveness,
        rationale: candidate.rationale,
      });
    }
  }

  return operations.sort((left, right) => left.path.localeCompare(right.path));
}

function createManualReviewItems(supportedCandidates) {
  const costSafetyBuffer = supportedCandidates.get("cost_safety_buffer_bps");
  if (costSafetyBuffer === undefined || costSafetyBuffer.aggressiveness !== "conservative") {
    return [];
  }
  return [
    {
      candidateKey: "cost_safety_buffer_bps",
      title: costSafetyBuffer.title,
      direction: costSafetyBuffer.direction,
      reason:
        "현재 paper strategyParameters에는 직접 대응되는 cost_safety_buffer_bps key가 없어 자동 patch로 만들지 않고 별도 설계 검토 항목으로 남깁니다.",
      metricEvidence: costSafetyBuffer.metricEvidence,
    },
  ];
}

function buildStrategyParametersPatch(patchOperations) {
  const patch = {};
  for (const operation of patchOperations) {
    if (operation.aggressiveness !== "conservative") {
      throw new Error(`profile proposal cannot include non-conservative operation: ${operation.path}`);
    }
    const strategyPatch = (patch[operation.strategy] ??= {});
    strategyPatch[operation.candidateKey] = operation.to;
  }
  return patch;
}

function requireDecimalLike(value, fieldPath) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${fieldPath} must be a decimal string or number`);
  }
  const normalized = String(value);
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error(`${fieldPath} must be a decimal string or number`);
  }
  return normalized;
}

function formatDecimal(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function renderMarkdownReport(report) {
  const candidateRows = report.thresholdCandidates
    .map(
      (candidate) =>
        `| ${escapeTable(candidate.title)} | ${escapeTable(candidate.statusLabel)} | ${escapeTable(candidate.aggressivenessLabel)} | ${escapeTable(
          candidate.directionLabel,
        )} | ${escapeTable(candidate.rationale)} |`,
    )
    .join("\n");
  const riskRows =
    report.riskInteractions.length === 0
      ? "| 없음 | 0 | - | - |"
      : report.riskInteractions
          .map((interaction) => `| ${escapeTable(interaction.title)} | ${interaction.count} | ${escapeTable(interaction.action)} | ${escapeTable(interaction.reasonCode)} |`)
          .join("\n");
  const validationRows =
    report.validation.failures.length === 0
      ? "- 없음"
      : report.validation.failures.map((item) => `- ${item.message} (추적 정보: \`${item.fieldPath}\`)`).join("\n");
  const proposalRows =
    report.profileProposal?.patchOperations.length === 0
      ? "| 없음 | - | - | - | - |"
      : report.profileProposal.patchOperations
          .map(
            (operation) =>
              `| ${escapeTable(operation.strategy)} | ${escapeTable(operation.candidateKey)} | ${escapeTable(operation.from)} | ${escapeTable(operation.to)} | ${escapeTable(
                operation.direction,
              )} |`,
          )
          .join("\n");
  const manualReviewRows =
    report.profileProposal?.manualReviewItems.length === 0
      ? "- 없음"
      : report.profileProposal.manualReviewItems.map((item) => `- ${item.title}: ${item.reason}`).join("\n");

  return `# M11 threshold calibration 리포트

- 판정: ${report.statusLabel}
- 생성 시각: ${report.generatedAt}
- 대상 evidence: \`${report.evidence.evidencePath}\`
- run prefix: \`${report.evidence.runPrefix ?? "unknown"}\`
- 운영 요약: ${report.operatorSummary}
- 필요 조치: ${report.action}

## 핵심 metric

| 항목 | 값 |
| --- | --- |
| paper 주문/체결 | ${report.aggregate.metrics.paperOrderSubmittedCount} / ${report.aggregate.metrics.paperFillCount} |
| 체결률 | ${report.aggregate.metrics.fillRate} |
| 비용 평가/차단 | ${report.aggregate.metrics.costSummary.evaluatedCount} / ${report.aggregate.metrics.costSummary.rejectedCount} |
| 평균 비용 bps | ${report.aggregate.metrics.costSummary.averageCostBps ?? "없음"} |
| 평균 요구수익률 bps | ${report.aggregate.metrics.costSummary.averageRequiredReturnBps ?? "없음"} |
| 평균 margin bps | ${report.aggregate.metrics.costSummary.averageMarginBps ?? "없음"} |
| live order API 호출 | ${report.aggregate.metrics.liveOrderApiCalls} |

## 차단 사유 분해

| 축 | 합계 | 주요 사유 |
| --- | --- | --- |
| 비용 | ${report.reasonBreakdown?.cost.totalCount ?? 0} | ${formatCounts(report.reasonBreakdown?.cost.counts ?? {})} |
| 리스크 | ${report.reasonBreakdown?.risk.totalCount ?? 0} | ${formatCounts(report.reasonBreakdown?.risk.counts ?? {})} |
| 보류 | ${report.reasonBreakdown?.hold.totalCount ?? 0} | ${formatCounts(report.reasonBreakdown?.hold.counts ?? {})} |
| 폐기 | ${report.reasonBreakdown?.discard.totalCount ?? 0} | ${formatCounts(report.reasonBreakdown?.discard.counts ?? {})} |
| 미분류 | ${report.reasonBreakdown?.unknown.totalCount ?? 0} | ${formatCounts(report.reasonBreakdown?.unknown.counts ?? {})} |

## threshold 후보

| 후보 | 상태 | 성격 | 방향 | 근거 |
| --- | --- | --- | --- | --- |
${candidateRows || "| 없음 | - | - | - | - |"}

## 비활성 profile proposal

- 상태: ${report.profileProposal?.statusLabel ?? "없음"}
- 활성화 여부: 비활성
- 기본 config 자동 변경: 없음
- proposal 파일: \`${report.outputs.profileProposalPath ?? "미생성"}\`

| 전략 | 후보 | 기존값 | 제안값 | 방향 |
| --- | --- | --- | --- | --- |
${proposalRows}

### 수동 검토 항목

${manualReviewRows}

## risk 상호작용

| 항목 | 건수 | 조치 | 추적 정보 |
| --- | --- | --- | --- |
${riskRows}

## 검증 실패

${validationRows}

## 추적 정보

- aggregate summary: \`${report.trace.aggregateSourcePath}\`
- day summaries: ${report.trace.daySourcePaths.map((entry) => `Day ${entry.day} \`${entry.path}\``).join(", ")}
- validation command:

\`\`\`sh
${report.evidence.validationCommand ?? "없음"}
\`\`\`
`;
}

function createMetricSnapshot(summary) {
  return {
    day: summary.day,
    sourceKind: summary.sourceKind,
    sourcePath: summary.sourcePath,
    status: summary.status,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    metrics: summary.metrics,
  };
}

function createOperatorAction({ status, analysis }) {
  if (status === "failed") {
    return "누락 metric과 live order API 호출 여부를 먼저 확인한 뒤 report를 다시 생성한다.";
  }
  if (analysis.thresholdRelaxationBlocked) {
    return "기본 threshold 완화는 보류하고, 비용/유동성/스프레드 기준을 보수적으로 비교하는 profile proposal만 검토한다.";
  }
  return "후보 profile을 별도 PR에서 생성하고 기본 운영값 활성화 전 동일 run shape report를 비교한다.";
}

function parseMetrics(value, context) {
  const record = requireRecord(value, `${context}.metrics`);
  const costSummary = requireRecord(record.costSummary, `${context}.metrics.costSummary`);
  const slippageSummary = requireRecord(record.slippageSummary, `${context}.metrics.slippageSummary`);
  return {
    costSummary: {
      evaluatedCount: requireSafeInteger(costSummary.evaluatedCount, `${context}.metrics.costSummary.evaluatedCount`),
      allowedCount: requireSafeInteger(costSummary.allowedCount, `${context}.metrics.costSummary.allowedCount`),
      rejectedCount: requireSafeInteger(costSummary.rejectedCount, `${context}.metrics.costSummary.rejectedCount`),
      averageCostBps: readNullableDecimalString(costSummary.averageCostBps, `${context}.metrics.costSummary.averageCostBps`),
      averageRequiredReturnBps: readNullableDecimalString(costSummary.averageRequiredReturnBps, `${context}.metrics.costSummary.averageRequiredReturnBps`),
      averageMarginBps: readNullableDecimalString(costSummary.averageMarginBps, `${context}.metrics.costSummary.averageMarginBps`),
    },
    slippageSummary: {
      observedFillCount: requireSafeInteger(slippageSummary.observedFillCount, `${context}.metrics.slippageSummary.observedFillCount`),
      averageSlippageBps: readNullableDecimalString(slippageSummary.averageSlippageBps, `${context}.metrics.slippageSummary.averageSlippageBps`),
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

function parseDocumentAggregateSummary({ evidencePath, markdown }) {
  const aggregate = parseTable(markdown, "## Aggregate result");
  const cost = parseTable(markdown, "## Cost, slippage, and blocking");
  return {
    sourceKind: "evidence_document",
    sourcePath: evidencePath,
    day: null,
    status: readTableString(aggregate, "status"),
    startedAt: readTableNullableString(aggregate, "startedAt"),
    finishedAt: readTableNullableString(aggregate, "finishedAt"),
    metrics: parseMetrics(
      {
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
      },
      `document:${evidencePath}:aggregate`,
    ),
  };
}

function parseDocumentDaySummaries({ evidencePath, markdown }) {
  return parseTableRows(markdown, "## Day comparison").map((row) => {
    const day = Number.parseInt(stripCode(row["일차"] ?? "").replace("Day ", ""), 10);
    const [startedAt, finishedAt] = (row["기간"] ?? "").split(" - ").map((value) => stripCode(value.trim()));
    const submittedAndFill = stripCode(row["submitted/fill"] ?? "")
      .split("/")
      .map((value) => Number.parseInt(value.trim(), 10));
    const blockingReasonCounts = parseBlockingReasonText(row["주요 차단 사유"] ?? "");
    const costRejectedCount = blockingReasonCounts["cost:cost_margin_insufficient"] ?? 0;
    const costEvaluatedCount = parseInteger(row["cost evaluated"], "day.costSummary.evaluatedCount");
    return {
      sourceKind: "evidence_document",
      sourcePath: evidencePath,
      day,
      status: stripCode(row.status ?? ""),
      startedAt: startedAt ?? null,
      finishedAt: finishedAt ?? null,
      metrics: parseMetrics(
        {
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
        },
        `document:${evidencePath}:day:${day}`,
      ),
    };
  });
}

function parseSourceArtifacts(markdown) {
  const aggregateSummaryPath = parseArtifactPath(markdown, "- aggregate summary:");
  return {
    aggregateSummaryPath,
    aggregateReportPath: parseArtifactPath(markdown, "- aggregate report:"),
    daySummaryPaths: expandDayArtifactPaths(parseArtifactPath(markdown, "- day summaries:")),
    dayReportPaths: expandDayArtifactPaths(parseArtifactPath(markdown, "- day reports:")),
    comparisonReportPath: parseArtifactPath(markdown, "- 3일 비교 report:"),
    rawEventLogPath: parseArtifactPath(markdown, "- raw event log:"),
  };
}

function expandDayArtifactPaths(pattern) {
  if (pattern === null) {
    return [];
  }
  return [1, 2, 3].map((day) => ({ day, path: pattern.replace("{1,2,3}", String(day)) }));
}

function parseArtifactPath(markdown, prefix) {
  return parseLineValue(markdown, prefix);
}

function parseBlockingReason(rawReason) {
  const separatorIndex = rawReason.indexOf(":");
  if (separatorIndex <= 0) {
    return { axis: "unknown", reasonCode: rawReason };
  }
  const axis = rawReason.slice(0, separatorIndex);
  const reasonCode = rawReason.slice(separatorIndex + 1);
  if (!knownReasonAxes.has(axis) || reasonCode.length === 0) {
    return { axis: "unknown", reasonCode: rawReason };
  }
  return { axis, reasonCode };
}

function completeAxis(counts) {
  return {
    counts: sortCounts(counts),
    totalCount: sumCounts(counts),
  };
}

function sortCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sumCounts(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function failure(fieldPath, message, trace) {
  return {
    severity: "error",
    fieldPath,
    message,
    ...(trace === undefined ? {} : { trace }),
  };
}

function parseTable(markdown, heading) {
  const rows = parseTableRows(markdown, heading);
  const table = new Map();
  for (const row of rows) {
    const key = row["항목"];
    if (key !== undefined) {
      table.set(stripCode(key), row["값"] ?? "");
    }
  }
  return table;
}

function parseTableRows(markdown, heading) {
  const section = readSection(markdown, heading);
  const lines = section.split(/\r?\n/u).filter((line) => line.trim().startsWith("|"));
  if (lines.length < 2) {
    return [];
  }
  const header = splitTableLine(lines[0]);
  return lines.slice(2).map((line) => Object.fromEntries(splitTableLine(line).map((cell, index) => [header[index] ?? `col${index}`, cell])));
}

function splitTableLine(line) {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function readSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) {
    return "";
  }
  const next = markdown.indexOf("\n## ", start + heading.length);
  return next < 0 ? markdown.slice(start) : markdown.slice(start, next);
}

function parseLineValue(markdown, prefix) {
  const line = markdown.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : stripCode(line.slice(prefix.length).trim());
}

function parseValidationCommand(markdown) {
  const section = readSection(markdown, "## Validation command");
  const match = /```sh\n([\s\S]*?)\n```/u.exec(section);
  return match?.[1]?.trim() ?? null;
}

function readTableString(table, key) {
  return stripCode(requireValue(table.get(key), `table.${key}`));
}

function readTableNullableString(table, key) {
  const value = table.get(key);
  if (value === undefined) {
    return null;
  }
  const stripped = stripCode(value);
  return stripped.length === 0 || stripped === "-" ? null : stripped;
}

function readTableNumber(table, key) {
  return parseFiniteNumber(requireValue(table.get(key), `table.${key}`), `table.${key}`);
}

function readTableJsonRecord(table, key) {
  const value = readTableNullableString(table, key);
  return value === null ? {} : requireCountRecord(JSON.parse(value), `table.${key}`);
}

function parseBlockingReasonText(value) {
  const counts = {};
  for (const item of value.split(",")) {
    const stripped = stripCode(item.trim());
    if (stripped.length === 0) {
      continue;
    }
    const [key, rawCount] = stripped.split("=");
    counts[requireValue(key, "blockingReason.key")] = parseInteger(rawCount, "blockingReason.count");
  }
  return counts;
}

function filterBlockingCounts(counts, prefix) {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([key]) => key.startsWith(`${prefix}:`))
      .map(([key, value]) => [key.slice(prefix.length + 1), value]),
  );
}

function requireRecord(value, fieldPath) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }
  return value;
}

function requireCountRecord(value, fieldPath) {
  const record = requireRecord(value, fieldPath);
  for (const [key, count] of Object.entries(record)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${fieldPath}.${key} must be a non-negative safe integer`);
    }
  }
  return record;
}

function requireSafeInteger(value, fieldPath) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${fieldPath} must be a safe integer`);
  }
  return value;
}

function requireFiniteNumber(value, fieldPath) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldPath} must be a finite number`);
  }
  return value;
}

function readNullableDecimalString(value, fieldPath) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${fieldPath} must be a decimal string`);
  }
  const normalized = String(value);
  if (!/^-?\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error(`${fieldPath} must be a decimal string`);
  }
  return normalized;
}

function parseInteger(value, fieldPath) {
  const normalized = stripCode(String(value ?? ""));
  if (normalized.length === 0) {
    throw new Error(`${fieldPath} is required`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${fieldPath} must be a safe integer`);
  }
  return parsed;
}

function parseFiniteNumber(value, fieldPath) {
  const normalized = stripCode(String(value ?? ""));
  if (normalized.length === 0) {
    throw new Error(`${fieldPath} is required`);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldPath} must be a finite number`);
  }
  return parsed;
}

function requireArrayNumber(values, index, fieldPath) {
  const value = values[index];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${fieldPath} must be a safe integer`);
  }
  return value;
}

function requireValue(value, fieldPath) {
  if (value === undefined || value === null) {
    throw new Error(`${fieldPath} is required`);
  }
  return value;
}

function requirePath(value, label) {
  if (value === null || value.length === 0) {
    throw new Error(`${label} path is required`);
  }
  return value;
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

function readNullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripCode(value) {
  return String(value)
    .trim()
    .replace(/^`/u, "")
    .replace(/`$/u, "")
    .trim();
}

function formatCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "없음" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function escapeTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function safeTimestamp(value) {
  return value.replace(/[:.]/gu, "-");
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/analyze-m11-threshold-calibration.mjs [options]

Options:
  --evidence <path>    Internal #68 evidence markdown path.
  --output <path>      Write Markdown report to the given path.
  --proposal-output <path>
                       Write inactive profile/patch proposal JSON to the given path.
  --paper-config <path>
                       Read base paper config for proposal generation. Defaults to config/paper.json.
  --json               Print structured JSON to stdout.
  --document-only      Use committed evidence tables without reading source artifact summaries.
  -h, --help           Show this help.
`);
}
