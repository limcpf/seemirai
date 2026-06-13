#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m23-stability-closeout");
const runGuardEnv = "SEEMIRAI_RUN_M23_STABILITY_CLOSEOUT";
const requiredSegmentCount = 7;
const oneDayMs = 86_400_000;
const expectedIssue = 188;
const expectedMode = "LIVE_AUTONOMOUS_SMALL_BUDGET";
const requiredRecoveryChecks = [
  "restartEvidence",
  "duplicateLiveOrder",
  "reconcileRecovery",
  "statusRecovery",
  "dailyReportRecovery",
  "failClosedDrills",
  "backupRestore",
  "secretScan",
];
const closeoutCounterNames = [
  "crashCount",
  "unhandledRejectionCount",
  "riskGateBypassCount",
  "reconcileMismatchCount",
  "duplicateOrderCount",
  "untrackedFillCount",
  "liveOrderCleanupFailureCount",
];
const sensitivePatterns = [
  { label: "access_key field", pattern: /"(?:upbit_)?access_key"\s*:\s*"(?!<redacted>|redacted)[^"]{4,}"/i },
  { label: "secret_key field", pattern: /"(?:upbit_)?secret_key"\s*:\s*"(?!<redacted>|redacted)[^"]{4,}"/i },
  { label: "telegram token field", pattern: /"telegram_bot_token"\s*:\s*"(?!<redacted>|redacted)[^"]{4,}"/i },
  { label: "jwt field", pattern: /"jwt"\s*:\s*"(?!<redacted>|redacted)[^"]{4,}"/i },
  { label: "authorization bearer", pattern: /authorization:\s*bearer\s+(?!<redacted>|redacted)[^\s"']+/i },
  { label: "authorization json field", pattern: /"authorization"\s*:\s*"(?!<redacted>|redacted)[^"]{4,}"/i },
  { label: "postgres credential url", pattern: /postgres(?:ql)?:\/\/[^:\s"']+:[^@\s"']+@/i },
  { label: "raw provider field", pattern: /raw[_-]?provider\s*[:=]/i },
  { label: "raw provider json field", pattern: /"raw(?:_|-)?provider(?:payload)?"\s*:/i },
  { label: "raw provider camel json field", pattern: /"rawProviderPayload"\s*:/i },
  { label: "raw order field", pattern: /raw[_-]?order\s*[:=]/i },
  { label: "raw order json field", pattern: /"raw(?:_|-)?order(?:detail|payload)?"\s*:/i },
  { label: "raw update field", pattern: /raw[_-]?update\s*[:=]/i },
  { label: "raw update json field", pattern: /"raw(?:_|-)?update"\s*:/i },
];

try {
  await main();
} catch (error) {
  const summary = await writeFailureSummary(error);
  printSummary(summary, parseArgsForFailure(process.argv.slice(2)));
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_M23_STABILITY_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });

  if (options.fixtureSmoke) {
    const fixture = await writeFixtureManifest(artifactDir, startedAt);
    const summary = await buildAndWriteSummary({
      runId,
      startedAt,
      inputMode: "fixture_smoke",
      manifestPath: fixture.manifestPath,
      artifacts,
      guarded: false,
    });
    printSummary(summary, options);
    if (summary.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  if (process.env[runGuardEnv] !== "1") {
    const summary = createSummary({
      runId,
      startedAt,
      inputMode: "guard_skipped",
      artifacts,
      metrics: createEmptyMetrics(),
      checks: {
        runGuard: skippedCheck("M23 7일 closeout guard가 꺼져 있어 운영 artifact 검증을 실행하지 않았다.", {
          requiredEnv: `${runGuardEnv}=1`,
        }),
      },
    });
    await writeArtifacts(summary, artifacts);
    printSummary(summary, options);
    return;
  }

  const summary = await buildAndWriteSummary({
    runId,
    startedAt,
    inputMode: "stability_closeout_manifest",
    manifestPath: options.manifestPath,
    artifacts,
    guarded: true,
  });
  printSummary(summary, options);
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

async function buildAndWriteSummary(input) {
  const checks = {
    runGuard: input.guarded
      ? okCheck("명시 env guard가 확인되어 M23 7일 closeout manifest 검증을 시작한다.", { requiredEnv: `${runGuardEnv}=1` })
      : okCheck("fixture smoke는 live/API guard를 열지 않고 결정적 manifest만 검증한다.", { fixtureSmoke: true }),
  };

  if (!hasText(input.manifestPath)) {
    checks.manifestInput = failCheck("M23 closeout manifest 경로가 필요하다.", { requiredArg: "--manifest" });
    const summary = createSummary({
      runId: input.runId,
      startedAt: input.startedAt,
      inputMode: input.inputMode,
      artifacts: input.artifacts,
      metrics: createEmptyMetrics(),
      checks,
    });
    await writeArtifacts(summary, input.artifacts);
    return summary;
  }

  const manifestFile = await readJsonFile(input.manifestPath, process.cwd());
  checks.manifestInput = manifestFile.error === undefined
    ? okCheck("M23 closeout manifest를 파싱했다.", { manifestPath: manifestFile.filePath })
    : failCheck("M23 closeout manifest를 파싱하지 못했다.", {
        manifestPath: manifestFile.filePath,
        error: manifestFile.error,
      });

  let metrics = createEmptyMetrics();
  if (manifestFile.error === undefined && isRecord(manifestFile.value)) {
    const validation = await validateManifest(manifestFile.value, manifestFile.filePath, manifestFile.rawText);
    Object.assign(checks, validation.checks);
    metrics = validation.metrics;
  } else if (manifestFile.error === undefined) {
    checks.manifestShape = failCheck("M23 closeout manifest는 JSON object여야 한다.", {
      actualType: Array.isArray(manifestFile.value) ? "array" : typeof manifestFile.value,
    });
  }

  const summary = createSummary({
    runId: input.runId,
    startedAt: input.startedAt,
    inputMode: input.inputMode,
    artifacts: {
      ...input.artifacts,
      manifestPath: manifestFile.filePath,
    },
    metrics,
    checks,
  });
  await writeArtifacts(summary, input.artifacts);
  return summary;
}

async function validateManifest(manifest, manifestPath, manifestRawText) {
  const baseDir = path.dirname(manifestPath);
  const segmentRecords = Array.isArray(manifest.segments) ? manifest.segments.filter(isRecord) : [];
  const segmentFiles = await readSegmentSummaries(segmentRecords, baseDir);
  const recoveryFile = hasText(manifest.recoveryDrillSummaryPath)
    ? await readJsonFile(manifest.recoveryDrillSummaryPath, baseDir)
    : undefined;
  const segmentSummaries = segmentFiles
    .filter((file) => file.error === undefined && isRecord(file.value))
    .map((file) => file.value);
  const metrics = createMetrics(segmentSummaries, recoveryFile);
  const checks = {
    manifestShape: createManifestShapeCheck(manifest),
    liveArmedEvidence: createLiveArmedEvidenceCheck(manifest),
    segmentCompleteness: createSegmentCompletenessCheck(segmentRecords, segmentFiles),
    segmentSummariesParsed: createSegmentSummariesParsedCheck(segmentFiles, segmentRecords.length),
    segmentDuration: createSegmentDurationCheck(segmentFiles),
    segmentDailyReports: createSegmentDailyReportsCheck(segmentFiles),
    segmentZeroCounters: createSegmentZeroCountersCheck(segmentFiles),
    segmentLiveArmedGuards: createSegmentLiveArmedGuardCheck(segmentFiles),
    decisionEvidence: createDecisionEvidenceCheck(segmentRecords),
    recoveryDrill: createRecoveryDrillCheck(manifest, recoveryFile),
    backupRestore: createBackupRestoreCheck(manifest.backupRestore),
    sourceScan: createSourceScanCheck(manifest.sourceScan),
    secretScan: createSecretScanCheck([
      { label: "manifest", rawText: manifestRawText },
      ...segmentFiles.map((file, index) => ({ label: `segment-${index + 1}`, rawText: file.rawText })),
      ...(recoveryFile === undefined ? [] : [{ label: "recovery", rawText: recoveryFile.rawText }]),
    ]),
  };

  return { metrics, checks };
}

function createManifestShapeCheck(manifest) {
  const actual = {
    issue: manifest.issue,
    mode: manifest.mode,
    segmentArray: Array.isArray(manifest.segments),
  };
  if (manifest.issue === expectedIssue && manifest.mode === expectedMode && Array.isArray(manifest.segments)) {
    return okCheck("M23 closeout manifest가 issue/mode/segment 기본 contract를 만족한다.", actual);
  }

  return failCheck("M23 closeout manifest issue/mode/segment contract가 맞지 않는다.", {
    expected: { issue: expectedIssue, mode: expectedMode, segments: "array" },
    actual,
  });
}

function createLiveArmedEvidenceCheck(manifest) {
  const required = {
    liveArmedEvidenceId: readString(manifest.liveArmedEvidenceId),
    keyScopeEvidenceId: readString(manifest.keyScopeEvidenceId),
    operatorArmEvidenceId: readString(manifest.operatorArmEvidenceId),
    budgetEvidenceId: readString(manifest.budgetEvidenceId),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !hasText(value))
    .map(([name]) => name);
  if (missing.length === 0) {
    return okCheck("live-armed, key scope, operator arm, budget evidence id가 모두 있다.", required);
  }

  return failCheck("M23 7일 closeout에는 live-armed/key/budget/operator evidence id가 모두 필요하다.", { missing });
}

function createSegmentCompletenessCheck(segments, segmentFiles) {
  const days = segments
    .map((segment) => readString(segment.day))
    .filter((day) => day !== undefined);
  const uniqueDays = Array.from(new Set(days));
  const invalidDays = days.filter((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day));
  const summaryPaths = segmentFiles.map((file) => file.realFilePath ?? file.filePath).filter((value) => value !== "");
  const decisionEvidenceIds = segments.map((segment) => readString(segment.decisionEvidenceId)).filter((value) => value !== undefined);
  const dailyReportEvidenceIds = segments.map((segment) => readString(segment.dailyReportEvidenceId)).filter((value) => value !== undefined);
  const duplicateSummaryPaths = collectDuplicateValues(summaryPaths);
  const duplicateDecisionEvidenceIds = collectDuplicateValues(decisionEvidenceIds);
  const duplicateDailyReportEvidenceIds = collectDuplicateValues(dailyReportEvidenceIds);
  const consecutiveDays = areConsecutiveDays(uniqueDays);
  if (
    segments.length >= requiredSegmentCount
    && uniqueDays.length >= requiredSegmentCount
    && invalidDays.length === 0
    && duplicateSummaryPaths.length === 0
    && duplicateDecisionEvidenceIds.length === 0
    && duplicateDailyReportEvidenceIds.length === 0
    && consecutiveDays
  ) {
    return okCheck("7일 이상 segment manifest가 있고 day, summary, evidence가 연속/고유하게 기록됐다.", {
      segmentCount: segments.length,
      uniqueDayCount: uniqueDays.length,
      consecutiveDays,
    });
  }

  return failCheck("M23 7일 closeout에는 연속된 7개 day와 고유한 segment summary/evidence가 필요하다.", {
    segmentCount: segments.length,
    uniqueDayCount: uniqueDays.length,
    invalidDays,
    duplicateSummaryPaths,
    duplicateDecisionEvidenceIds,
    duplicateDailyReportEvidenceIds,
    consecutiveDays,
    requiredSegmentCount,
  });
}

function createSegmentSummariesParsedCheck(segmentFiles, expectedCount) {
  const failures = segmentFiles
    .filter((file) => file.error !== undefined || !isRecord(file.value))
    .map((file) => ({
      filePath: file.filePath,
      error: file.error ?? "JSON object가 아닙니다",
    }));
  if (failures.length === 0 && segmentFiles.length === expectedCount) {
    return okCheck("모든 24시간 segment summary를 파싱했다.", { summaryCount: segmentFiles.length });
  }

  return failCheck("24시간 segment summary를 모두 파싱하지 못했다.", {
    expectedCount,
    parsedCount: segmentFiles.length - failures.length,
    failures,
  });
}

function createSegmentDurationCheck(segmentFiles) {
  const invalid = parsedSegmentEntries(segmentFiles)
    .filter(({ summary }) => {
      const pilotProcess = isRecord(summary.metrics) && isRecord(summary.metrics.pilotProcess) ? summary.metrics.pilotProcess : {};
      const requested = readFiniteNumber(pilotProcess.durationMsRequested);
      const observed = readFiniteNumber(pilotProcess.durationMsObserved);
      return summary.status !== "passed"
        || pilotProcess.ranFullDuration !== true
        || requested === undefined
        || requested < oneDayMs
        || observed === undefined
        || observed < oneDayMs;
    })
    .map(({ index, file, summary }) => ({
      segment: index + 1,
      filePath: file.filePath,
      status: summary.status,
      ranFullDuration: isRecord(summary.metrics) && isRecord(summary.metrics.pilotProcess)
        ? summary.metrics.pilotProcess.ranFullDuration
        : undefined,
      durationMsRequested: isRecord(summary.metrics) && isRecord(summary.metrics.pilotProcess)
        ? summary.metrics.pilotProcess.durationMsRequested
        : undefined,
      durationMsObserved: isRecord(summary.metrics) && isRecord(summary.metrics.pilotProcess)
        ? summary.metrics.pilotProcess.durationMsObserved
        : undefined,
    }));
  if (invalid.length === 0 && segmentFiles.length >= requiredSegmentCount) {
    return okCheck("각 segment가 24시간 요청 duration과 정상 종료 evidence를 가진다.", { segmentCount: segmentFiles.length });
  }

  return failCheck("24시간을 채우지 못했거나 실패한 segment summary가 있다.", { invalid });
}

function createSegmentDailyReportsCheck(segmentFiles) {
  const missing = parsedSegmentEntries(segmentFiles)
    .filter(({ summary }) => readFiniteNumber(readMetrics(summary).dailyReportGeneratedCount) === undefined
      || readFiniteNumber(readMetrics(summary).dailyReportGeneratedCount) < 1)
    .map(({ index, file, summary }) => ({
      segment: index + 1,
      filePath: file.filePath,
      dailyReportGeneratedCount: readMetrics(summary).dailyReportGeneratedCount,
    }));
  if (missing.length === 0 && segmentFiles.length >= requiredSegmentCount) {
    return okCheck("모든 segment에 daily report 생성 evidence가 있다.", { segmentCount: segmentFiles.length });
  }

  return failCheck("daily report 생성 evidence가 없는 segment가 있다.", { missing });
}

function createSegmentZeroCountersCheck(segmentFiles) {
  const invalid = [];
  for (const { index, file, summary } of parsedSegmentEntries(segmentFiles)) {
    const metrics = readMetrics(summary);
    for (const counterName of closeoutCounterNames) {
      const value = readFiniteNumber(metrics[counterName]);
      if (value === undefined || value !== 0) {
        invalid.push({
          segment: index + 1,
          filePath: file.filePath,
          counterName,
          value: metrics[counterName] ?? null,
        });
      }
    }
  }

  if (invalid.length === 0 && segmentFiles.length >= requiredSegmentCount) {
    return okCheck("7일 closeout failure counter가 모두 명시적 0건이다.", {
      counters: closeoutCounterNames,
      segmentCount: segmentFiles.length,
    });
  }

  return failCheck("7일 closeout failure counter가 누락됐거나 0이 아닌 segment가 있다.", { invalid });
}

function createSegmentLiveArmedGuardCheck(segmentFiles) {
  const invalid = parsedSegmentEntries(segmentFiles)
    .filter(({ summary }) => !hasOkCheck(summary, "configSafety")
      || !hasOkCheck(summary, "evidenceEnv")
      || !hasOkCheck(summary, "pilotProfileEnv")
      || !hasOkCheck(summary, "operationalEnv")
      || !hasOkCheck(summary, "readinessEnv")
      || !hasExpectedConfigSafety(summary)
      || !hasLiveAutonomousInput(summary)
      || !hasM23Mode(summary)
      || isExplicitDryRun(summary))
    .map(({ index, file, summary }) => ({
      segment: index + 1,
      filePath: file.filePath,
      input: readString(summary.input) ?? null,
      mode: readSegmentMode(summary) ?? null,
      dryRun: readBoolean(summary.dryRun) ?? readBoolean(readMetrics(summary).dryRun) ?? null,
      configSafety: readCheckStatus(summary, "configSafety"),
      evidenceEnv: readCheckStatus(summary, "evidenceEnv"),
      pilotProfileEnv: readCheckStatus(summary, "pilotProfileEnv"),
      operationalEnv: readCheckStatus(summary, "operationalEnv"),
      readinessEnv: readCheckStatus(summary, "readinessEnv"),
    }));
  if (invalid.length === 0 && segmentFiles.length >= requiredSegmentCount) {
    return okCheck("모든 segment가 live small-budget guard와 readiness evidence를 통과했다.", { segmentCount: segmentFiles.length });
  }

  return failCheck("live-armed guard/readiness/config evidence가 부족한 segment가 있다.", { invalid });
}

function createDecisionEvidenceCheck(segments) {
  const invalid = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => !hasText(segment.decisionEvidenceId)
      || !hasText(segment.dailyReportEvidenceId)
      || !hasEvidenceArray(segment.alertEvidenceIds))
    .map(({ segment, index }) => ({
      segment: index + 1,
      day: readString(segment.day) ?? null,
      decisionEvidenceId: readString(segment.decisionEvidenceId) ?? null,
      dailyReportEvidenceId: readString(segment.dailyReportEvidenceId) ?? null,
      alertEvidenceIds: Array.isArray(segment.alertEvidenceIds) ? segment.alertEvidenceIds : null,
    }));
  if (invalid.length === 0 && segments.length >= requiredSegmentCount) {
    return okCheck("decision, daily report, alert evidence id가 segment마다 있다.", {
      segmentCount: segments.length,
    });
  }

  return failCheck("segment마다 decision, daily report, alert evidence id가 필요하다.", { invalid });
}

function createRecoveryDrillCheck(manifest, recoveryFile) {
  if (!hasText(manifest.recoveryDrillSummaryPath)) {
    return failCheck("M23 closeout에는 recovery drill summary 경로가 필요하다.", {
      requiredField: "recoveryDrillSummaryPath",
    });
  }

  if (recoveryFile === undefined || recoveryFile.error !== undefined || !isRecord(recoveryFile.value)) {
    return failCheck("M23 recovery drill summary를 파싱하지 못했다.", {
      recoveryDrillSummaryPath: recoveryFile?.filePath ?? manifest.recoveryDrillSummaryPath,
      error: recoveryFile?.error ?? "JSON object가 아닙니다",
    });
  }

  const summary = recoveryFile.value;
  const missingOrFailedChecks = requiredRecoveryChecks
    .filter((checkName) => !hasOkCheck(summary, checkName))
    .map((checkName) => ({ checkName, status: readCheckStatus(summary, checkName) }));
  if (summary.status === "passed" && summary.input === "recovery_artifacts" && missingOrFailedChecks.length === 0) {
    return okCheck("restart/recovery drill summary가 closeout 요구 check를 통과했다.", {
      recoveryDrillSummaryPath: recoveryFile.filePath,
      input: summary.input,
      requiredChecks: requiredRecoveryChecks,
    });
  }

  return failCheck("restart/recovery drill summary가 통과 상태가 아니거나 필수 check가 실패했다.", {
    recoveryDrillSummaryPath: recoveryFile.filePath,
    status: summary.status,
    input: summary.input ?? null,
    missingOrFailedChecks,
  });
}

function createBackupRestoreCheck(backupRestore) {
  if (!isRecord(backupRestore)) {
    return failCheck("DB backup/restore smoke 결과 또는 blocker object가 필요하다.", {
      requiredField: "backupRestore",
    });
  }

  const status = readString(backupRestore.status);
  const evidenceId = readString(backupRestore.evidenceId);
  if (status === "passed" && hasText(evidenceId)) {
    return okCheck("DB backup/restore smoke가 통과 evidence를 남겼다.", { status, evidenceId });
  }

  if (status === "blocked") {
    const requiredBlockedFields = {
      evidenceId,
      blockerReason: readString(backupRestore.blockerReason),
      requiredOperatorAction: readString(backupRestore.requiredOperatorAction),
      retryPlanEvidenceId: readString(backupRestore.retryPlanEvidenceId),
    };
    const missing = Object.entries(requiredBlockedFields)
      .filter(([, value]) => !hasText(value))
      .map(([name]) => name);
    if (missing.length === 0) {
      return okCheck("DB backup/restore smoke 미실행 blocker와 재시도 계획이 기록됐다.", requiredBlockedFields);
    }

    return failCheck("DB backup/restore blocker는 이유, 필요한 조치, 재시도 계획 evidence를 포함해야 한다.", { missing });
  }

  return failCheck("DB backup/restore status는 passed 또는 blocked여야 하며 evidence id가 필요하다.", {
    status: status ?? null,
    evidenceId: evidenceId ?? null,
  });
}

function createSourceScanCheck(sourceScan) {
  if (!isRecord(sourceScan)) {
    return failCheck("M23 closeout source scan 결과 object가 필요하다.", { requiredField: "sourceScan" });
  }

  const expected = {
    liveOrderApiGuarded: true,
    marketBestOrderDefaultOpened: false,
    withdrawalOrDepositPathOpened: false,
    rawSecretExposure: false,
  };
  const actual = {
    liveOrderApiGuarded: sourceScan.liveOrderApiGuarded,
    marketBestOrderDefaultOpened: sourceScan.marketBestOrderDefaultOpened,
    withdrawalOrDepositPathOpened: sourceScan.withdrawalOrDepositPathOpened,
    rawSecretExposure: sourceScan.rawSecretExposure,
  };
  const mismatches = Object.entries(expected)
    .filter(([name, value]) => actual[name] !== value)
    .map(([name, value]) => ({ name, expected: value, actual: actual[name] ?? null }));
  if (mismatches.length === 0 && hasText(sourceScan.evidenceId)) {
    return okCheck("source scan 결과가 M23 금지 경계를 새로 열지 않았음을 기록했다.", {
      evidenceId: sourceScan.evidenceId,
      ...actual,
    });
  }

  return failCheck("source scan 결과가 없거나 M23 금지 경계가 열린 것으로 기록됐다.", {
    evidenceId: readString(sourceScan.evidenceId) ?? null,
    mismatches,
  });
}

function createSecretScanCheck(inputs) {
  const matches = [];
  for (const input of inputs) {
    for (const { label, pattern } of sensitivePatterns) {
      if (pattern.test(input.rawText)) {
        matches.push({ input: input.label, pattern: label });
      }
    }
  }

  if (matches.length === 0) {
    return okCheck("closeout manifest와 참조 summary에 raw secret 후보 문자열이 없다.", {
      scannedInputs: inputs.map((input) => input.label),
    });
  }

  return failCheck("closeout manifest 또는 summary에 raw secret 후보 문자열이 있다.", { matches });
}

async function readSegmentSummaries(segments, baseDir) {
  const files = [];
  for (const segment of segments) {
    if (!hasText(segment.summaryPath)) {
      files.push({
        filePath: "",
        rawText: "",
        value: undefined,
        error: "segment summaryPath가 없습니다",
      });
      continue;
    }

    // manifest 상대 경로는 운영 artifact bundle을 그대로 옮겨도 검증할 수 있게 manifest 위치 기준으로 해석한다.
    files.push(await readJsonFile(segment.summaryPath, baseDir));
  }
  return files;
}

function createMetrics(segmentSummaries, recoveryFile) {
  const counters = Object.fromEntries(closeoutCounterNames.map((name) => [name, sumMetric(segmentSummaries, name)]));
  return {
    segmentCount: segmentSummaries.length,
    dailyReportGeneratedCount: sumMetric(segmentSummaries, "dailyReportGeneratedCount"),
    heartbeatCount: sumMetric(segmentSummaries, "heartbeatCount"),
    orderSubmittedCount: sumMetric(segmentSummaries, "orderSubmittedCount"),
    brokerSubmissionCount: sumMetric(segmentSummaries, "brokerSubmissionCount"),
    closeoutCounters: counters,
    recoveryStatus: isRecord(recoveryFile?.value) ? recoveryFile.value.status ?? null : null,
  };
}

function createEmptyMetrics() {
  return {
    segmentCount: 0,
    dailyReportGeneratedCount: 0,
    heartbeatCount: 0,
    orderSubmittedCount: 0,
    brokerSubmissionCount: 0,
    closeoutCounters: Object.fromEntries(closeoutCounterNames.map((name) => [name, 0])),
    recoveryStatus: null,
  };
}

function parsedSegmentEntries(segmentFiles) {
  return segmentFiles
    .map((file, index) => ({ file, index, summary: file.value }))
    .filter(({ file, summary }) => file.error === undefined && isRecord(summary));
}

function hasExpectedConfigSafety(summary) {
  const check = readCheck(summary, "configSafety");
  const evidence = isRecord(check?.evidence) ? check.evidence : {};
  const allowedMarkets = Array.isArray(evidence.allowedMarkets) ? evidence.allowedMarkets : [];
  return evidence.enabled === true
    && allowedMarkets.length === 1
    && allowedMarkets[0] === "KRW-BTC"
    && String(evidence.maxOrderKrw) === "10000"
    && String(evidence.dailyAutonomousNotionalLimitKrw) === "30000"
    && String(evidence.maxOpenPositionNotionalKrw) === "30000";
}

function hasEvidenceArray(value) {
  return Array.isArray(value) && value.some((item) => hasText(item));
}

function hasLiveAutonomousInput(summary) {
  return readString(summary.input) === "live_autonomous_command";
}

function hasM23Mode(summary) {
  return readSegmentMode(summary) === expectedMode;
}

function isExplicitDryRun(summary) {
  return readBoolean(summary.dryRun) === true || readBoolean(readMetrics(summary).dryRun) === true;
}

function readSegmentMode(summary) {
  const pilotProfileEvidence = isRecord(readCheck(summary, "pilotProfileEnv")?.evidence)
    ? readCheck(summary, "pilotProfileEnv").evidence
    : {};
  return readString(summary.mode)
    ?? readString(summary.profile)
    ?? readString(summary.runtimeMode)
    ?? readString(pilotProfileEvidence.mode)
    ?? readString(pilotProfileEvidence.profile)
    ?? readString(pilotProfileEvidence.pilotProfile);
}

function hasOkCheck(summary, checkName) {
  return readCheckStatus(summary, checkName) === "ok";
}

function readCheckStatus(summary, checkName) {
  return readCheck(summary, checkName)?.status;
}

function readCheck(summary, checkName) {
  const checks = isRecord(summary.checks) ? summary.checks : {};
  return isRecord(checks[checkName]) ? checks[checkName] : undefined;
}

function readMetrics(summary) {
  return isRecord(summary.metrics) ? summary.metrics : {};
}

function sumMetric(summaries, name) {
  return summaries.reduce((sum, summary) => sum + (readFiniteNumber(readMetrics(summary)[name]) ?? 0), 0);
}

function collectDuplicateValues(values) {
  return Array.from(new Set(values.filter((value, index) => values.indexOf(value) !== index)));
}

function areConsecutiveDays(days) {
  if (days.length < requiredSegmentCount) {
    return false;
  }

  const timestamps = days.map((day) => parseDayToUtcMs(day));
  if (timestamps.some((timestamp) => timestamp === undefined)) {
    return false;
  }

  const sorted = timestamps.toSorted((left, right) => left - right);
  return sorted.every((timestamp, index) => index === 0 || timestamp - sorted[index - 1] === oneDayMs);
}

function parseDayToUtcMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return undefined;
  }

  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(timestamp).toISOString().slice(0, 10) === day ? timestamp : undefined;
}

async function readJsonFile(filePath, baseDir) {
  const resolved = resolveInputPath(filePath, baseDir);
  let rawText = "";
  let realFilePath;
  try {
    realFilePath = await realpath(resolved);
    rawText = await readFile(resolved, "utf8");
    return {
      filePath: resolved,
      realFilePath,
      rawText,
      value: JSON.parse(rawText),
      error: undefined,
    };
  } catch (error) {
    return {
      filePath: resolved,
      realFilePath,
      rawText,
      value: undefined,
      error: toErrorMessage(error),
    };
  }
}

function resolveInputPath(filePath, baseDir) {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

async function writeFixtureManifest(artifactDir, startedAt) {
  const manifestPath = path.join(artifactDir, "m23-stability-closeout-manifest.fixture.json");
  const recoveryPath = path.join(artifactDir, "m23-recovery-summary.fixture.json");
  const segments = [];
  for (let index = 0; index < requiredSegmentCount; index += 1) {
    const day = new Date(startedAt.getTime() + index * oneDayMs).toISOString().slice(0, 10);
    const summaryPath = path.join(artifactDir, `m23-segment-${index + 1}-summary.fixture.json`);
    await writeFile(summaryPath, `${JSON.stringify(createFixtureSegmentSummary(index), null, 2)}\n`, "utf8");
    segments.push({
      day,
      summaryPath: path.basename(summaryPath),
      decisionEvidenceId: `m23-decision-evidence-${index + 1}`,
      dailyReportEvidenceId: `m23-daily-report-${index + 1}`,
      alertEvidenceIds: [`m23-alert-evidence-${index + 1}`],
    });
  }

  await writeFile(recoveryPath, `${JSON.stringify(createFixtureRecoverySummary(), null, 2)}\n`, "utf8");
  const manifest = {
    issue: expectedIssue,
    mode: expectedMode,
    liveArmedEvidenceId: "m23-live-armed-evidence",
    keyScopeEvidenceId: "m23-key-scope-evidence",
    operatorArmEvidenceId: "m23-operator-arm-evidence",
    budgetEvidenceId: "m23-budget-evidence",
    segments,
    recoveryDrillSummaryPath: path.basename(recoveryPath),
    backupRestore: {
      status: "blocked",
      evidenceId: "m23-db-restore-blocker",
      blockerReason: "fixture disposable restore DB is not provisioned",
      requiredOperatorAction: "prepare disposable restore DB",
      retryPlanEvidenceId: "m23-db-restore-retry-plan",
    },
    sourceScan: {
      evidenceId: "m23-source-scan-fixture",
      liveOrderApiGuarded: true,
      marketBestOrderDefaultOpened: false,
      withdrawalOrDepositPathOpened: false,
      rawSecretExposure: false,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestPath };
}

function createFixtureSegmentSummary(index) {
  return {
    status: "passed",
    input: "live_autonomous_command",
    mode: expectedMode,
    metrics: {
      heartbeatCount: 1440 + index,
      orderSubmittedCount: index === 0 ? 1 : 0,
      brokerSubmissionCount: index === 0 ? 1 : 0,
      manualReviewRequiredCount: 0,
      dailyReportGeneratedCount: 1,
      crashCount: 0,
      unhandledRejectionCount: 0,
      riskGateBypassCount: 0,
      reconcileMismatchCount: 0,
      duplicateOrderCount: 0,
      untrackedFillCount: 0,
      liveOrderCleanupFailureCount: 0,
      pilotProcess: {
        durationMsRequested: oneDayMs,
        durationMsObserved: oneDayMs + 32,
        ranFullDuration: true,
        exitCode: 0,
        forceKilled: false,
      },
    },
    checks: {
      configSafety: {
        status: "ok",
        evidence: {
          enabled: true,
          allowedMarkets: ["KRW-BTC"],
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          maxOpenPositionNotionalKrw: "30000",
        },
      },
      evidenceEnv: { status: "ok" },
      pilotProfileEnv: { status: "ok" },
      operationalEnv: { status: "ok" },
      readinessEnv: { status: "ok" },
      dailyReportGenerated: { status: "ok" },
      closeoutZeroCounters: { status: "ok" },
    },
  };
}

function createFixtureRecoverySummary() {
  return {
    status: "passed",
    input: "recovery_artifacts",
    drill: "restart_recovery",
    checks: Object.fromEntries(requiredRecoveryChecks.map((checkName) => [checkName, { status: "ok" }])),
  };
}

function createSummary(input) {
  const finishedAt = new Date();
  const checkValues = Object.values(input.checks);
  const status = checkValues.some((check) => check.status === "fail")
    ? "failed"
    : checkValues.length > 0 && checkValues.every((check) => check.status === "skipped")
      ? "skipped"
      : "passed";
  return {
    schemaVersion: 1,
    issue: expectedIssue,
    milestone: "M23",
    closeout: "stability_7d",
    runId: input.runId,
    status,
    input: input.inputMode,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    artifacts: input.artifacts,
    metrics: input.metrics,
    checks: input.checks,
  };
}

async function writeArtifacts(summary, artifacts) {
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(artifacts.reportPath, renderReport(summary), "utf8");
}

function renderReport(summary) {
  const checkLines = Object.entries(summary.checks)
    .map(([name, check]) => `- ${name}: ${check.status} - ${check.message}`)
    .join("\n");
  return `# M23 7일 stability closeout report

- status: ${summary.status}
- run id: ${summary.runId}
- started: ${summary.startedAt}
- finished: ${summary.finishedAt}
- input: ${summary.input}

## Metrics

\`\`\`json
${JSON.stringify(summary.metrics, null, 2)}
\`\`\`

## Checks

${checkLines}
`;
}

async function writeFailureSummary(error) {
  const startedAt = new Date();
  const runId = randomUUID();
  const options = parseArgsForFailure(process.argv.slice(2));
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_M23_STABILITY_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });
  const summary = createSummary({
    runId,
    startedAt,
    inputMode: "runner_fatal",
    artifacts,
    metrics: createEmptyMetrics(),
    checks: {
      fatalError: failCheck("M23 stability closeout runner 예외가 발생했다.", {
        message: toErrorMessage(error),
      }),
    },
  });
  await writeArtifacts(summary, artifacts);
  return summary;
}

function createArtifactPaths(input) {
  const stamp = input.startedAt.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const prefix = `m23-stability-closeout-${stamp}-${input.runId}`;
  return {
    artifactDir: input.artifactDir,
    summaryPath: path.join(input.artifactDir, `${prefix}-summary.json`),
    reportPath: path.join(input.artifactDir, `${prefix}-report.md`),
  };
}

function okCheck(message, evidence = {}) {
  return { status: "ok", message, evidence };
}

function failCheck(message, evidence = {}) {
  return { status: "fail", message, evidence };
}

function skippedCheck(message, evidence = {}) {
  return { status: "skipped", message, evidence };
}

function parseArgs(argv) {
  const options = {
    fixtureSmoke: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
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
      case "--artifact-dir":
        options.artifactDir = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--manifest":
        options.manifestPath = readArgValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseArgsForFailure(argv) {
  try {
    return parseArgs(argv);
  } catch {
    return {
      fixtureSmoke: argv.includes("--fixture-smoke"),
      json: argv.includes("--json"),
      help: false,
      artifactDir: readOptionalArg(argv, "--artifact-dir"),
      manifestPath: readOptionalArg(argv, "--manifest"),
    };
  }
}

function readArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function readOptionalArg(argv, arg) {
  const index = argv.indexOf(arg);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printSummary(summary, options) {
  if (options.json) {
    console.log(JSON.stringify(summary));
    return;
  }

  console.log(`M23 stability closeout: ${summary.status}`);
  console.log(`summary: ${summary.artifacts.summaryPath}`);
  console.log(`report: ${summary.artifacts.reportPath}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-m23-stability-closeout.mjs [options]

Options:
  --fixture-smoke             결정적 7일 closeout fixture manifest를 생성하고 검증한다.
  --manifest <path>           M23 7일 closeout manifest JSON.
  --artifact-dir <path>       summary/report 출력 디렉터리.
  --json                      summary JSON을 stdout으로 출력한다.
  --help                      도움말을 출력한다.

Actual closeout validation requires ${runGuardEnv}=1.
`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function readFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return undefined;
}

function expandHome(value) {
  if (typeof value !== "string") {
    return value;
  }

  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
