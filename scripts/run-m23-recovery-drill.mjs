#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m23-recovery-drill");
const runGuardEnv = "SEEMIRAI_RUN_M23_RECOVERY_DRILL";
const requiredFailClosedScenarios = ["upbit_maintenance", "market_warning", "stale_data"];
const allowedFailClosedResults = new Set(["ENTRY_BLOCKED", "NEW_ORDERS_BLOCKED", "MANUAL_REVIEW_REQUIRED"]);
const sensitivePatterns = [
  /access[_-]?key/i,
  /secret[_-]?key/i,
  /authorization/i,
  /\bjwt\b/i,
  /telegram[_-]?bot[_-]?token/i,
  /database[_-]?url/i,
  /postgres(?:ql)?:\/\/[^\s"']+/i,
  /\bpassword\b/i,
  /db[_-]?password/i,
  /raw[_-]?provider/i,
  /raw[_-]?order/i,
  /raw[_-]?update/i,
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
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_M23_RECOVERY_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });

  if (options.fixtureSmoke) {
    const fixturePaths = await writeFixtureEventLogs(artifacts, startedAt);
    const summary = await buildAndWriteSummary({
      runId,
      startedAt,
      inputMode: "fixture_smoke",
      options: {
        ...options,
        beforeEventLogPath: fixturePaths.beforeEventLogPath,
        afterEventLogPath: fixturePaths.afterEventLogPath,
        backupRestoreStatus: options.backupRestoreStatus ?? "blocked",
        backupRestoreEvidence: options.backupRestoreEvidence ?? "fixture-disposable-restore-db-not-provisioned",
      },
      artifacts,
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
        runGuard: skippedCheck("M23 recovery drill guard가 꺼져 있어 artifact 검증을 실행하지 않았다.", {
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
    inputMode: "recovery_artifacts",
    options,
    artifacts,
  });
  printSummary(summary, options);
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

async function buildAndWriteSummary(input) {
  const beforePath = input.options.beforeEventLogPath;
  const afterPath = input.options.afterEventLogPath;
  const checks = {
    runGuard: input.inputMode === "fixture_smoke"
      ? okCheck("fixture smoke는 live/API guard를 열지 않고 결정적 artifact만 검증한다.", { fixtureSmoke: true })
      : okCheck("명시 env guard가 확인되어 M23 recovery artifact 검증을 시작한다.", { requiredEnv: `${runGuardEnv}=1` }),
  };

  if (beforePath === undefined || afterPath === undefined) {
    checks.eventLogInputs = failCheck("restart 전후 event log 경로가 모두 필요하다.", {
      missing: [
        ...(beforePath === undefined ? ["--before-event-log"] : []),
        ...(afterPath === undefined ? ["--after-event-log"] : []),
      ],
    });
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

  const beforeLog = await readEventLog(beforePath);
  const afterLog = await readEventLog(afterPath);
  const metrics = createMetrics(beforeLog, afterLog);
  Object.assign(checks, createRecoveryChecks({
    beforeLog,
    afterLog,
    metrics,
    backupRestoreStatus: input.options.backupRestoreStatus,
    backupRestoreEvidence: input.options.backupRestoreEvidence,
  }));

  const summary = createSummary({
    runId: input.runId,
    startedAt: input.startedAt,
    inputMode: input.inputMode,
    artifacts: {
      ...input.artifacts,
      beforeEventLogPath: path.resolve(expandHome(beforePath)),
      afterEventLogPath: path.resolve(expandHome(afterPath)),
    },
    metrics,
    checks,
  });
  await writeArtifacts(summary, input.artifacts);
  return summary;
}

function createRecoveryChecks(input) {
  return {
    eventLogsParsed: input.beforeLog.parseErrors.length === 0 && input.afterLog.parseErrors.length === 0
      ? okCheck("restart 전후 event log를 모두 파싱했다.", {
          beforeEventCount: input.beforeLog.events.length,
          afterEventCount: input.afterLog.events.length,
        })
      : failCheck("restart 전후 event log에 JSON 파싱 실패가 있다.", {
          beforeParseErrors: input.beforeLog.parseErrors,
          afterParseErrors: input.afterLog.parseErrors,
        }),
    restartEvidence: createRestartEvidenceCheck(input.beforeLog.events, input.afterLog.events),
    heartbeatRecovery: createHeartbeatRecoveryCheck(input.afterLog.events),
    duplicateLiveOrder: createDuplicateLiveOrderCheck(input.beforeLog.events, input.afterLog.events),
    reconcileRecovery: createReconcileRecoveryCheck(input.afterLog.events),
    statusRecovery: createStatusRecoveryCheck(input.afterLog.events),
    dailyReportRecovery: createDailyReportRecoveryCheck(input.afterLog.events),
    failClosedDrills: createFailClosedDrillCheck(input.afterLog.events),
    backupRestore: createBackupRestoreCheck(input.backupRestoreStatus, input.backupRestoreEvidence),
    closeoutZeroCounters: createCloseoutZeroCounterCheck(input.metrics),
    secretScan: createSecretScanCheck(input.beforeLog.rawText, input.afterLog.rawText),
  };
}

function createRestartEvidenceCheck(beforeEvents, afterEvents) {
  const beforeCheckpoint = beforeEvents.find((event) => event.type === "m23_restart_checkpoint" && event.phase === "before_restart");
  const afterCheckpoint = afterEvents.find((event) => event.type === "m23_restart_checkpoint" && event.phase === "after_restart");
  const restartDetected = afterEvents.find((event) => event.type === "live_ops_event" && event.eventKind === "RUNTIME_RESTART_DETECTED");
  const recovered = afterEvents.find((event) => event.type === "live_ops_event" && event.eventKind === "RUNTIME_RECOVERED");

  if (beforeCheckpoint === undefined || afterCheckpoint === undefined || restartDetected === undefined || recovered === undefined) {
    return failCheck("restart 감지와 복구 Telegram/status evidence가 모두 필요하다.", {
      beforeCheckpoint: beforeCheckpoint !== undefined,
      afterCheckpoint: afterCheckpoint !== undefined,
      restartDetected: restartDetected !== undefined,
      recovered: recovered !== undefined,
    });
  }

  const restartEvidence = {
    beforeCheckpoint: readString(beforeCheckpoint.restartId),
    afterCheckpoint: readString(afterCheckpoint.restartId),
    restartDetected: readString(restartDetected.restartId),
    recovered: readString(recovered.restartId),
  };
  const missingRestartIds = Object.entries(restartEvidence)
    .filter(([, restartId]) => restartId === undefined)
    .map(([name]) => name);
  if (missingRestartIds.length > 0) {
    return failCheck("restart evidence마다 restart id가 있어야 한다.", {
      missingRestartIds,
    });
  }

  const restartIds = new Set(Object.values(restartEvidence));
  if (restartIds.size !== 1) {
    return failCheck("restart 전후 evidence는 같은 restart id로 묶여야 한다.", {
      restartIds: Array.from(restartIds),
    });
  }

  const recoveryReuseEvidence = {
    beforeOrderAttemptId: readString(beforeCheckpoint.orderAttemptId),
    afterOrderAttemptId: readString(afterCheckpoint.orderAttemptId),
    beforeReconcileRunId: readString(beforeCheckpoint.reconcileRunId),
    afterReconcileRunId: readString(afterCheckpoint.reconcileRunId),
  };
  const missingRecoveryFields = Object.entries(recoveryReuseEvidence)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missingRecoveryFields.length > 0) {
    return failCheck("restart checkpoint마다 기존 order attempt와 reconcile snapshot id가 있어야 한다.", {
      missingRecoveryFields,
    });
  }

  if (recoveryReuseEvidence.beforeOrderAttemptId !== recoveryReuseEvidence.afterOrderAttemptId
    || recoveryReuseEvidence.beforeReconcileRunId !== recoveryReuseEvidence.afterReconcileRunId) {
    return failCheck("restart 전후 durable reservation/reconcile snapshot id가 같아야 한다.", {
      ...recoveryReuseEvidence,
    });
  }

  return okCheck("restart 전후 감지와 복구 evidence가 같은 restart id와 기존 reservation/snapshot으로 연결됐다.", {
    restartId: Array.from(restartIds)[0],
    orderAttemptId: recoveryReuseEvidence.beforeOrderAttemptId,
    reconcileRunId: recoveryReuseEvidence.beforeReconcileRunId,
  });
}

function createHeartbeatRecoveryCheck(afterEvents) {
  const heartbeatCount = afterEvents.filter((event) => event.type === "m22_pilot_heartbeat").length;
  return heartbeatCount > 0
    ? okCheck("restart 후 heartbeat evidence가 재개됐다.", { heartbeatCount })
    : failCheck("restart 후 heartbeat evidence가 없다.", { requiredEventType: "m22_pilot_heartbeat" });
}

function createDuplicateLiveOrderCheck(beforeEvents, afterEvents) {
  const evidence = createDuplicateLiveOrderEvidence(beforeEvents, afterEvents);

  if (evidence.duplicateIds.length > 0) {
    return failCheck("restart 전후 같은 live order identifier가 다시 제출됐다.", {
      ...evidence,
    });
  }

  return okCheck("restart 후 기존 order attempt가 duplicate live order로 재제출되지 않았다.", {
    beforeSubmissionCount: evidence.beforeSubmissionCount,
    afterSubmissionCount: evidence.afterSubmissionCount,
  });
}

function createDuplicateLiveOrderEvidence(beforeEvents, afterEvents) {
  const beforeIds = collectSubmissionIds(beforeEvents);
  const afterIds = collectSubmissionIds(afterEvents);
  // broker_submission/order_submitted 한 쌍은 같은 주문의 lifecycle evidence이므로 category별 반복 제출만 duplicate로 센다.
  const duplicateAfterRestart = collectDuplicateSubmissionIds(afterEvents);
  const repeatedAfterRestart = [...new Set(afterIds.filter((id) => beforeIds.includes(id)))];
  const duplicateIds = [...new Set([...duplicateAfterRestart, ...repeatedAfterRestart])];

  return {
    duplicateIds,
    duplicateAfterRestart,
    repeatedAfterRestart,
    beforeSubmissionCount: beforeIds.length,
    afterSubmissionCount: afterIds.length,
  };
}

function createReconcileRecoveryCheck(afterEvents) {
  const events = afterEvents.filter((candidate) => candidate.type === "live_reconcile_completed");
  if (events.length === 0) {
    return failCheck("restart 후 reconcile 성공 evidence가 없다.", {
      requiredEventType: "live_reconcile_completed",
      acceptedResults: ["SUCCESS", "CLEAN"],
    });
  }

  const failures = events.filter((event) => {
    const result = readString(event.result);
    const mismatchCount = Number(event.mismatchCount ?? 0);
    return !["SUCCESS", "CLEAN"].includes(result ?? "") || !Number.isFinite(mismatchCount) || mismatchCount !== 0;
  });
  if (failures.length > 0) {
    return failCheck("restart 후 reconcile 완료 evidence 중 실패 또는 mismatch가 남아 있다.", {
      failureCount: failures.length,
      failures: failures.map((event) => ({
        result: event.result,
        mismatchCount: event.mismatchCount,
        runId: readString(event.runId),
      })),
    });
  }

  return okCheck("restart 후 모든 reconcile 완료 evidence가 mismatch 0건으로 복구됐다.", {
    completedCount: events.length,
    latestRunId: readString(events.at(-1)?.runId),
  });
}

function createStatusRecoveryCheck(afterEvents) {
  const events = afterEvents.filter((candidate) => candidate.type === "live_ops_status_summary");
  const event = events.at(-1);
  if (event === undefined) {
    return failCheck("restart 후 live ops status summary evidence가 없다.", {
      requiredEventType: "live_ops_status_summary",
    });
  }

  if (event.liveOrderCapable !== true || readString(event.mode) !== "live_order_capable") {
    return failCheck("restart 후 status가 live order capable 복구 상태를 표시하지 않는다.", {
      mode: event.mode,
      liveOrderCapable: event.liveOrderCapable,
    });
  }

  return okCheck("restart 후 status summary가 live order capable 상태를 복구했다.", {
    mode: event.mode,
    liveOrderCapable: true,
    statusSummaryCount: events.length,
  });
}

function createDailyReportRecoveryCheck(afterEvents) {
  const count = afterEvents.filter((event) => event.type === "daily_report_generated").length;
  return count > 0
    ? okCheck("restart 후 daily report marker가 다시 생성됐다.", { dailyReportGeneratedCount: count })
    : failCheck("restart 후 daily report marker가 없다.", { requiredEventType: "daily_report_generated" });
}

function createFailClosedDrillCheck(afterEvents) {
  const drillEvents = afterEvents.filter((event) => event.type === "fail_closed_drill");
  const passedScenarios = new Set(
    drillEvents
      .filter((event) => allowedFailClosedResults.has(readString(event.result) ?? "") && hasText(event.alertEvidenceId))
      .map((event) => readString(event.scenario))
      .filter((scenario) => scenario !== undefined),
  );
  const missing = requiredFailClosedScenarios.filter((scenario) => !passedScenarios.has(scenario));

  if (missing.length > 0) {
    return failCheck("Upbit 장애/market warning/stale data fail-closed drill evidence가 부족하다.", {
      missing,
      required: requiredFailClosedScenarios,
    });
  }

  return okCheck("Upbit 장애/market warning/stale data가 신규 entry 차단과 alert evidence로 수렴했다.", {
    scenarios: Array.from(passedScenarios),
  });
}

function createBackupRestoreCheck(status, evidence) {
  if (status === "passed" && hasText(evidence)) {
    return okCheck("DB backup/restore smoke가 disposable restore DB에서 통과했다.", {
      status,
      evidence,
    });
  }

  if (status === "blocked" && hasText(evidence)) {
    return okCheck("DB backup/restore smoke 실행 불가 blocker와 재시도 evidence를 기록했다.", {
      status,
      evidence,
    });
  }

  return failCheck("DB backup/restore smoke 결과 또는 blocker evidence가 필요하다.", {
    status: status ?? null,
    evidence: evidence ?? null,
    acceptedStatus: ["passed", "blocked"],
  });
}

function createCloseoutZeroCounterCheck(metrics) {
  const counters = {
    crashCount: metrics.crashCount,
    unhandledRejectionCount: metrics.unhandledRejectionCount,
    riskGateBypassCount: metrics.riskGateBypassCount,
    reconcileMismatchCount: metrics.reconcileMismatchCount,
    duplicateOrderCount: metrics.duplicateOrderCount,
    untrackedFillCount: metrics.untrackedFillCount,
    liveOrderCleanupFailureCount: metrics.liveOrderCleanupFailureCount,
  };
  const failed = Object.entries(counters).filter(([, value]) => value !== 0);

  if (failed.length > 0) {
    return failCheck("M23 recovery drill closeout 0건 조건을 충족하지 못했다.", {
      counters,
    });
  }

  return okCheck("M23 recovery drill closeout 0건 조건을 충족했다.", {
    counters,
  });
}

function createSecretScanCheck(beforeRaw, afterRaw) {
  const rawText = `${beforeRaw}\n${afterRaw}`;
  const matchedPatterns = sensitivePatterns
    .filter((pattern) => pattern.test(rawText))
    .map((pattern) => pattern.source);
  if (matchedPatterns.length > 0) {
    return failCheck("recovery drill artifact에 secret/raw provider 후보 문자열이 있다.", {
      matchedPatterns,
    });
  }

  return okCheck("recovery drill artifact에 secret/raw provider 후보 문자열이 없다.", {
    scannedBytes: Buffer.byteLength(rawText, "utf8"),
  });
}

function createMetrics(beforeLog, afterLog) {
  const events = [...beforeLog.events, ...afterLog.events];
  const duplicateOrderEvidence = createDuplicateLiveOrderEvidence(beforeLog.events, afterLog.events);
  return {
    heartbeatCount: events.filter((event) => event.type === "m22_pilot_heartbeat").length,
    orderSubmissionCount: collectSubmissionIds(events).length,
    restartCheckpointCount: events.filter((event) => event.type === "m23_restart_checkpoint").length,
    reconcileRecoveryCount: afterLog.events.filter((event) => event.type === "live_reconcile_completed").length,
    statusSummaryCount: afterLog.events.filter((event) => event.type === "live_ops_status_summary").length,
    dailyReportGeneratedCount: afterLog.events.filter((event) => event.type === "daily_report_generated").length,
    failClosedDrillCount: afterLog.events.filter((event) => event.type === "fail_closed_drill").length,
    crashCount: events.filter((event) => event.type === "runtime_crash" || event.type === "crash").length,
    unhandledRejectionCount: events.filter((event) => event.type === "unhandled_rejection" || event.unhandledRejection === true).length,
    riskGateBypassCount: events.filter((event) => event.type === "risk_gate_bypass").length,
    reconcileMismatchCount: events.filter((event) => event.type === "live_reconcile_mismatch" || event.type === "reconcile_mismatch").length
      + events.filter((event) => event.type === "live_reconcile_completed").filter((event) => {
        const mismatchCount = Number(event.mismatchCount ?? 0);
        return !Number.isFinite(mismatchCount) || mismatchCount !== 0 || !["SUCCESS", "CLEAN"].includes(readString(event.result) ?? "");
      }).length,
    duplicateOrderCount: duplicateOrderEvidence.duplicateIds.length
      + events.filter((event) => event.type === "duplicate_order").length,
    untrackedFillCount: events.filter((event) => event.type === "untracked_fill").length,
    liveOrderCleanupFailureCount: events.filter((event) =>
      event.type === "live_order_cleanup_failure"
      || event.type === "order_cancel_failed"
      || event.type === "order_cancel_unconfirmed").length,
    parseErrorCount: beforeLog.parseErrors.length + afterLog.parseErrors.length,
  };
}

function createEmptyMetrics() {
  return {
    heartbeatCount: 0,
    orderSubmissionCount: 0,
    restartCheckpointCount: 0,
    reconcileRecoveryCount: 0,
    statusSummaryCount: 0,
    dailyReportGeneratedCount: 0,
    failClosedDrillCount: 0,
    crashCount: 0,
    unhandledRejectionCount: 0,
    riskGateBypassCount: 0,
    reconcileMismatchCount: 0,
    duplicateOrderCount: 0,
    untrackedFillCount: 0,
    liveOrderCleanupFailureCount: 0,
    parseErrorCount: 0,
  };
}

function collectSubmissionIds(events) {
  const brokerSubmissionIds = events
    .filter((event) => event.type === "broker_submission")
    .map((event) => readString(event.idempotencyKey) ?? readString(event.identifier))
    .filter((value) => value !== undefined);
  const orderSubmittedIds = events
    .filter((event) => event.type === "order_submitted")
    .map((event) => readString(event.identifier) ?? readString(event.idempotencyKey))
    .filter((value) => value !== undefined);

  return Array.from(new Set([...brokerSubmissionIds, ...orderSubmittedIds]));
}

function collectDuplicateSubmissionIds(events) {
  const brokerSubmissionIds = events
    .filter((event) => event.type === "broker_submission")
    .map((event) => readString(event.idempotencyKey) ?? readString(event.identifier))
    .filter((value) => value !== undefined);
  const orderSubmittedIds = events
    .filter((event) => event.type === "order_submitted")
    .map((event) => readString(event.identifier) ?? readString(event.idempotencyKey))
    .filter((value) => value !== undefined);

  return [...new Set([
    ...collectDuplicateValues(brokerSubmissionIds),
    ...collectDuplicateValues(orderSubmittedIds),
  ])];
}

function collectDuplicateValues(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

async function readEventLog(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  let rawText = "";
  try {
    rawText = await readFile(resolved, "utf8");
  } catch (error) {
    return {
      filePath: resolved,
      rawText,
      events: [],
      parseErrors: [{ line: 0, message: toErrorMessage(error) }],
    };
  }

  const events = [];
  const parseErrors = [];
  const lines = rawText.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) {
        events.push(parsed);
      } else {
        parseErrors.push({ line: index + 1, message: "JSON object가 아닙니다" });
      }
    } catch (error) {
      parseErrors.push({ line: index + 1, message: toErrorMessage(error) });
    }
  });

  return {
    filePath: resolved,
    rawText,
    events,
    parseErrors,
  };
}

async function writeFixtureEventLogs(artifacts, startedAt) {
  const beforeEventLogPath = artifacts.beforeEventLogPath;
  const afterEventLogPath = artifacts.afterEventLogPath;
  const restartId = "m23-restart-fixture-001";
  const identifier = "m22a-recoveryfixture000001";
  const beforeEvents = [
    {
      type: "m22_pilot_heartbeat",
      observedAt: startedAt.toISOString(),
      runtimeReady: true,
      market: "KRW-BTC",
      segment: "before_restart",
    },
    {
      type: "broker_submission",
      observedAt: startedAt.toISOString(),
      market: "KRW-BTC",
      side: "BUY",
      idempotencyKey: identifier,
      requestedNotionalKrw: "10000",
      dryRun: false,
      candidateId: "candidate-before-restart",
    },
    {
      type: "order_submitted",
      observedAt: startedAt.toISOString(),
      market: "KRW-BTC",
      status: "SUBMITTED",
      identifier,
      candidateId: "candidate-before-restart",
    },
    {
      type: "m23_restart_checkpoint",
      observedAt: startedAt.toISOString(),
      phase: "before_restart",
      restartId,
      orderAttemptId: identifier,
      reconcileRunId: "reconcile-snapshot-001",
    },
  ];
  const afterEvents = [
    {
      type: "m23_restart_checkpoint",
      observedAt: addSeconds(startedAt, 5).toISOString(),
      phase: "after_restart",
      restartId,
      orderAttemptId: identifier,
      reconcileRunId: "reconcile-snapshot-001",
    },
    {
      type: "live_ops_event",
      observedAt: addSeconds(startedAt, 6).toISOString(),
      eventKind: "RUNTIME_RESTART_DETECTED",
      restartId,
      safeSummary: "M23 runtime 재시작을 감지했습니다.",
    },
    {
      type: "live_reconcile_completed",
      observedAt: addSeconds(startedAt, 7).toISOString(),
      result: "SUCCESS",
      mismatchCount: 0,
      runId: "reconcile-snapshot-001",
    },
    {
      type: "live_ops_status_summary",
      observedAt: addSeconds(startedAt, 8).toISOString(),
      mode: "live_order_capable",
      liveOrderCapable: true,
      latestHeartbeatAt: addSeconds(startedAt, 8).toISOString(),
    },
    {
      type: "m22_pilot_heartbeat",
      observedAt: addSeconds(startedAt, 9).toISOString(),
      runtimeReady: true,
      market: "KRW-BTC",
      segment: "after_restart",
    },
    {
      type: "live_ops_event",
      observedAt: addSeconds(startedAt, 10).toISOString(),
      eventKind: "RUNTIME_RECOVERED",
      restartId,
      safeSummary: "M23 runtime이 reconcile/status 복구를 완료했습니다.",
    },
    {
      type: "fail_closed_drill",
      observedAt: addSeconds(startedAt, 11).toISOString(),
      scenario: "upbit_maintenance",
      result: "NEW_ORDERS_BLOCKED",
      alertEvidenceId: "m23-drill-upbit-maintenance",
    },
    {
      type: "fail_closed_drill",
      observedAt: addSeconds(startedAt, 12).toISOString(),
      scenario: "market_warning",
      result: "ENTRY_BLOCKED",
      alertEvidenceId: "m23-drill-market-warning",
    },
    {
      type: "fail_closed_drill",
      observedAt: addSeconds(startedAt, 13).toISOString(),
      scenario: "stale_data",
      result: "NEW_ORDERS_BLOCKED",
      alertEvidenceId: "m23-drill-stale-data",
    },
    {
      type: "daily_report_generated",
      observedAt: addSeconds(startedAt, 14).toISOString(),
      reportDate: toKstDate(addSeconds(startedAt, 14)),
    },
  ];

  await writeJsonLines(beforeEventLogPath, beforeEvents);
  await writeJsonLines(afterEventLogPath, afterEvents);
  return { beforeEventLogPath, afterEventLogPath };
}

async function writeJsonLines(filePath, events) {
  await writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
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
    issue: 188,
    milestone: "M23",
    drill: "restart_recovery",
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
  return `# M23 restart/recovery drill report

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
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_M23_RECOVERY_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });
  const summary = createSummary({
    runId,
    startedAt,
    inputMode: "runner_fatal",
    artifacts,
    metrics: createEmptyMetrics(),
    checks: {
      fatalError: failCheck("M23 recovery drill runner 예외가 발생했다.", {
        message: toErrorMessage(error),
      }),
    },
  });
  await writeArtifacts(summary, artifacts);
  return summary;
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

function createArtifactPaths(input) {
  const timestamp = input.startedAt.toISOString().replace(/[:.]/gu, "-");
  const prefix = `m23-recovery-${timestamp}-${input.runId}`;
  return {
    summaryPath: path.join(input.artifactDir, `${prefix}-summary.json`),
    reportPath: path.join(input.artifactDir, `${prefix}-report.md`),
    beforeEventLogPath: path.join(input.artifactDir, `${prefix}-before-events.jsonl`),
    afterEventLogPath: path.join(input.artifactDir, `${prefix}-after-events.jsonl`),
  };
}

function parseArgs(argv) {
  const options = {
    fixtureSmoke: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--before-event-log":
        options.beforeEventLogPath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--after-event-log":
        options.afterEventLogPath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--backup-restore-status":
        options.backupRestoreStatus = readValue(argv, index, arg);
        index += 1;
        break;
      case "--backup-restore-evidence":
        options.backupRestoreEvidence = readValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }

  if (
    options.backupRestoreStatus !== undefined &&
    !["passed", "blocked", "failed"].includes(options.backupRestoreStatus)
  ) {
    throw new Error("--backup-restore-status는 passed, blocked, failed 중 하나여야 한다.");
  }

  return options;
}

function parseArgsForFailure(argv) {
  try {
    return parseArgs(argv);
  } catch {
    return parseFailureOutputOptions(argv);
  }
}

function parseFailureOutputOptions(argv) {
  const options = {
    fixtureSmoke: argv.includes("--fixture-smoke"),
    json: argv.includes("--json"),
  };
  const artifactDirIndex = argv.indexOf("--artifact-dir");
  const artifactDir = artifactDirIndex >= 0 ? argv[artifactDirIndex + 1] : undefined;
  if (artifactDir !== undefined && !artifactDir.startsWith("--")) {
    options.artifactDir = artifactDir;
  }
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} 값이 필요하다.`);
  }
  return value;
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }

  process.stdout.write(`M23 recovery drill: ${summary.status}\n`);
  process.stdout.write(`summary: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`report: ${summary.artifacts.reportPath}\n`);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/run-m23-recovery-drill.mjs [options]

M23 restart/recovery drill artifact validator.

Options:
  --fixture-smoke                 결정적 fixture event log를 생성하고 검증한다.
  --json                          summary JSON을 stdout으로 출력한다.
  --artifact-dir <path>            summary/report/event log 출력 디렉터리.
  --before-event-log <path>        restart 전 event log JSONL.
  --after-event-log <path>         restart 후 event log JSONL.
  --backup-restore-status <value>  passed 또는 blocked. failed는 실패로 판정한다.
  --backup-restore-evidence <id>   backup/restore smoke 결과 또는 blocker evidence id.
`);
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasText(value) {
  return readString(value) !== undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(input) {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function toKstDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
