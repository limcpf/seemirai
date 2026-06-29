#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "config", "paper.json");
const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m22-live-autonomous");
const defaultDurationMs = 24 * 60 * 60 * 1000;
const defaultTerminationGraceMs = 5_000;
const m22RunGuardEnv = "SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT";
const requiredEvidenceEnv = [
  "SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID",
  "SEEMIRAI_M22_BUDGET_EVIDENCE_ID",
  "SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID",
  "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID",
];
const requiredPilotEnv = [
  "SEEMIRAI_PILOT_PROFILE",
  "SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE",
  "SEEMIRAI_RUN_UPBIT_ORDER_SMOKE",
];
const requiredOperationalEnv = ["SEEMIRAI_DATABASE_URL", "SEEMIRAI_TELEGRAM_BOT_TOKEN"];
const requiredReadinessEnv = [
  "SEEMIRAI_M22_TELEGRAM_INBOUND_READY",
  "SEEMIRAI_M22_RECONCILE_FRESH",
  "SEEMIRAI_M22_PNL_STATUS_READY",
  "SEEMIRAI_M22_DECISION_LEDGER_READY",
  "SEEMIRAI_M22_EXIT_ENGINE_READY",
];
const sensitiveEnvCandidates = [
  "SEEMIRAI_DATABASE_URL",
  "SEEMIRAI_TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "SEEMIRAI_UPBIT_ACCESS_KEY",
  "SEEMIRAI_UPBIT_SECRET_KEY",
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY",
  "SEEMIRAI_LOCAL_CONTROL_TOKEN",
];
const runtimeCounters = {
  unhandledRejections: 0,
  uncaughtExceptions: 0,
};

process.on("unhandledRejection", (reason) => {
  runtimeCounters.unhandledRejections += 1;
  process.stderr.write(`M22 live autonomous pilot runner unhandled rejection: ${toErrorMessage(reason)}\n`);
});

process.on("uncaughtException", (error) => {
  runtimeCounters.uncaughtExceptions += 1;
  process.stderr.write(`M22 live autonomous pilot runner uncaught exception: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});

try {
  await main();
} catch (error) {
  await handleFatalError(error);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const artifactDir = path.resolve(options.artifactDir ?? process.env.SEEMIRAI_M22_ARTIFACT_DIR ?? defaultArtifactDir);
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId, options });
  const git = await readGitContext();
  const longRunEnabled = process.env[m22RunGuardEnv] === "1";
  const inputMode = options.fixtureSmoke ? "fixture_smoke" : "live_autonomous_command";

  await ensureArtifactDirectories(artifacts);

  if (options.fixtureSmoke) {
    await writeFixtureEvents(artifacts.eventLogPath, startedAt);
    const eventLog = await readEventLog(artifacts.eventLogPath);
    const summary = createSummary({
      runId,
      startedAt,
      inputMode,
      options,
      git,
      artifacts,
      checks: {
        longRunGuard: okCheck("fixture smoke는 live guard를 열지 않는 짧은 검증 경로다.", { fixtureSmoke: true }),
        configSafety: okCheck("fixture smoke config가 M22 소액 자동매매 상한을 만족한다.", createFixtureConfigEvidence()),
        evidenceEnv: skippedCheck("fixture smoke에서는 저장소 밖 evidence id를 요구하지 않는다."),
        readinessEnv: skippedCheck("fixture smoke에서는 외부 readiness provider를 조회하지 않는다."),
        pilotCommand: skippedCheck("fixture smoke에서는 live autonomous command를 실행하지 않는다."),
        ...createEventChecks(eventLog, {
          requireDailyReport: options.requireDailyReport,
          includeCarriedBudgetEnv: false,
        }),
        runtimeExceptions: runtimeExceptionCheck(),
      },
      metrics: createMetrics(eventLog, undefined, { includeCarriedBudgetEnv: false }),
    });
    await writeArtifacts({ summary, artifacts });
    printSummary(summary, options);
    if (summary.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  if (!longRunEnabled) {
    const checks = {
      longRunGuard: skippedCheck(
        "`SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1`이 아니어서 24시간 live autonomous pilot을 실행하지 않았다.",
        { requiredEnv: `${m22RunGuardEnv}=1` },
      ),
      runtimeExceptions: runtimeExceptionCheck(),
    };
    const summary = createSummary({
      runId,
      startedAt,
      inputMode,
      options,
      git,
      artifacts,
      checks,
      metrics: createEmptyMetrics(),
    });
    await writeProcessLog(artifacts.processLogPath, {
      stage: "guard_skipped",
      status: "SKIPPED",
      message: checks.longRunGuard.message,
      occurredAt: summary.finishedAt,
    });
    await writeArtifacts({ summary, artifacts });
    printSummary(summary, options);
    return;
  }

  const config = await readJsonFile(options.configPath);
  const preflightChecks = {
    longRunGuard: okCheck("명시 env guard가 확인되어 M22 pilot preflight를 시작한다.", {
      requiredEnv: `${m22RunGuardEnv}=1`,
    }),
    configSafety: createConfigSafetyCheck(config),
    evidenceEnv: createEnvPresenceCheck("M22 저장소 밖 evidence id가 설정됐다.", requiredEvidenceEnv),
    pilotProfileEnv: createEnvPresenceCheck("M22 pilot/private/order smoke guard env가 설정됐다.", requiredPilotEnv),
    operationalEnv: createEnvPresenceCheck("M22 운영에 필요한 DB와 Telegram env가 설정됐다.", requiredOperationalEnv),
    readinessEnv: createReadinessEnvCheck(),
    pilotCommand: createPilotCommandPreflightCheck(options),
  };

  if (Object.values(preflightChecks).some((check) => check.status === "fail")) {
    const summary = createSummary({
      runId,
      startedAt,
      inputMode,
      options,
      git,
      artifacts,
      checks: {
        ...preflightChecks,
        runtimeExceptions: runtimeExceptionCheck(),
      },
      metrics: createEmptyMetrics(),
    });
    await writeProcessLog(artifacts.processLogPath, {
      stage: "preflight_failed",
      status: "FAILED",
      message: "M22 pilot preflight가 실패해 live command를 실행하지 않았다.",
      failedChecks: Object.entries(preflightChecks)
        .filter(([, check]) => check.status === "fail")
        .map(([name]) => name),
      occurredAt: summary.finishedAt,
    });
    await writeArtifacts({ summary, artifacts });
    printSummary(summary, options);
    process.exitCode = 1;
    return;
  }

  const pilotProcess = await runPilotCommand({ options, artifacts, runId });
  const eventLog = await readEventLog(artifacts.eventLogPath);
  const metrics = createMetrics(eventLog, pilotProcess);
  const checks = {
    ...preflightChecks,
    pilotCommand: createPilotCommandResultCheck(pilotProcess),
    ...createEventChecks(eventLog, { requireDailyReport: options.requireDailyReport }),
    runtimeExceptions: runtimeExceptionCheck(metrics),
  };
  const summary = createSummary({
    runId,
    startedAt,
    inputMode,
    options,
    git,
    artifacts,
    checks,
    metrics,
  });

  await writeArtifacts({ summary, artifacts });
  printSummary(summary, options);

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

async function handleFatalError(error) {
  runtimeCounters.uncaughtExceptions += 1;
  const startedAt = new Date();
  const runId = randomUUID();
  const options = parseArgsForFailure(process.argv.slice(2));
  const artifactDir = path.resolve(options.artifactDir ?? process.env.SEEMIRAI_M22_ARTIFACT_DIR ?? defaultArtifactDir);
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId, options });
  const git = await readGitContext();
  await ensureArtifactDirectories(artifacts);

  const summary = createSummary({
    runId,
    startedAt,
    inputMode: options.fixtureSmoke ? "fixture_smoke" : "live_autonomous_command",
    options,
    git,
    artifacts,
    checks: {
      fatalError: failCheck("runner 예외가 발생해 실패 summary를 기록했다.", {
        message: toErrorMessage(error),
      }),
      runtimeExceptions: runtimeExceptionCheck(),
    },
    metrics: createEmptyMetrics(),
  });
  await writeProcessLog(artifacts.processLogPath, {
    stage: "runner_fatal",
    status: "FAILED",
    message: toErrorMessage(error),
    occurredAt: summary.finishedAt,
  });
  await writeArtifacts({ summary, artifacts });
  printSummary(summary, options);
  process.exitCode = 1;
}

function parseArgsForFailure(argv) {
  try {
    return parseArgs(argv);
  } catch {
    return {
      configPath: defaultConfigPath,
      durationMs: defaultDurationMs,
      terminationGraceMs: defaultTerminationGraceMs,
      fixtureSmoke: argv.includes("--fixture-smoke"),
      json: argv.includes("--json"),
      help: false,
      pilotArgs: [],
      requireDailyReport: argv.includes("--require-daily-report"),
    };
  }
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    durationMs: defaultDurationMs,
    terminationGraceMs: defaultTerminationGraceMs,
    fixtureSmoke: false,
    json: false,
    help: false,
    pilotArgs: [],
    requireDailyReport: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--duration-ms":
        options.durationMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--termination-grace-ms":
        options.terminationGraceMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--pilot-command":
        options.pilotCommand = readValue(argv, index, arg);
        index += 1;
        break;
      case "--pilot-arg":
        options.pilotArgs.push(readValue(argv, index, arg));
        index += 1;
        break;
      case "--":
        options.pilotArgs.push(...argv.slice(index + 1));
        index = argv.length;
        break;
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--summary-path":
        options.summaryPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--report-path":
        options.reportPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--event-log-path":
        options.eventLogPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--process-log-path":
        options.processLogPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--require-daily-report":
        options.requireDailyReport = true;
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
        throw new Error(`Unknown option: ${arg}`);
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

function readPositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function runPilotCommand({ options, artifacts, runId }) {
  const startedAt = new Date();
  const command = options.pilotCommand;
  const args = options.pilotArgs;
  let durationElapsed = false;
  let forceKilled = false;
  let terminationTimer;
  let forceKillTimer;

  const logStream = createWriteStream(artifacts.processLogPath, { flags: "a", encoding: "utf8" });
  const writeLog = (record) => {
    logStream.write(`${JSON.stringify(redactRecord(record))}\n`);
  };

  writeLog({
    stage: "pilot_process_started",
    status: "RUNNING",
    command,
    args,
    runId,
    eventLogPath: artifacts.eventLogPath,
    startedAt: startedAt.toISOString(),
  });

  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      SEEMIRAI_M22_PILOT_RUN_ID: runId,
      SEEMIRAI_M22_PILOT_EVENT_LOG: artifacts.eventLogPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError;

  child.stdout?.on("data", (chunk) => {
    writeLog({
      stage: "pilot_stdout",
      status: "OUTPUT",
      stream: "stdout",
      data: redactText(chunk.toString("utf8")),
      observedAt: new Date().toISOString(),
    });
  });
  child.stderr?.on("data", (chunk) => {
    writeLog({
      stage: "pilot_stderr",
      status: "OUTPUT",
      stream: "stderr",
      data: redactText(chunk.toString("utf8")),
      observedAt: new Date().toISOString(),
    });
  });

  const closePromise = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  terminationTimer = setTimeout(() => {
    durationElapsed = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      forceKilled = true;
      child.kill("SIGKILL");
    }, options.terminationGraceMs);
  }, options.durationMs);

  const closeResult = await closePromise;
  clearTimeout(terminationTimer);
  clearTimeout(forceKillTimer);

  const finishedAt = new Date();
  const result = {
    command,
    args,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMsRequested: options.durationMs,
    durationMsObserved: finishedAt.getTime() - startedAt.getTime(),
    ranFullDuration: durationElapsed,
    exitCode: closeResult.code,
    signal: closeResult.signal,
    forceKilled,
    spawnError: spawnError === undefined ? null : toErrorMessage(spawnError),
  };

  writeLog({
    stage: "pilot_process_finished",
    status: result.ranFullDuration ? "COMPLETED_DURATION" : "ENDED_EARLY",
    ...result,
  });
  logStream.end();
  await finished(logStream);
  return result;
}

function createPilotCommandPreflightCheck(options) {
  if (options.pilotCommand === undefined) {
    return failCheck("M22 live autonomous pilot command가 지정되지 않아 실행하지 않는다.", {
      requiredOption: "--pilot-command",
    });
  }

  return okCheck("M22 live autonomous pilot command가 지정됐다.", {
    command: options.pilotCommand,
    argCount: options.pilotArgs.length,
  });
}

function createPilotCommandResultCheck(result) {
  if (result.spawnError !== null) {
    return failCheck("pilot command를 시작하지 못했다.", {
      error: result.spawnError,
    });
  }

  if (!result.ranFullDuration) {
    return failCheck("pilot command가 요청한 시간 전에 종료됐다.", {
      durationMsRequested: result.durationMsRequested,
      durationMsObserved: result.durationMsObserved,
      exitCode: result.exitCode,
      signal: result.signal,
    });
  }

  if (result.forceKilled) {
    return failCheck("pilot command가 종료 grace 안에 멈추지 않아 강제 종료됐다.", {
      signal: "SIGKILL",
    });
  }

  return okCheck("pilot command가 요청한 시간 동안 실행됐고 runner가 정상 종료 신호를 보냈다.", {
    durationMsRequested: result.durationMsRequested,
    durationMsObserved: result.durationMsObserved,
    stopSignal: "SIGTERM",
  });
}

function createConfigSafetyCheck(config) {
  const liveAutonomous = config?.live_autonomous;
  if (!isRecord(liveAutonomous)) {
    return failCheck("runtime config에 live_autonomous 설정이 없다.", {
      path: "live_autonomous",
    });
  }

  const violations = [];
  if (liveAutonomous.enabled !== true) {
    violations.push("live_autonomous.enabled must be true for a live M22 pilot config");
  }
  if (!arrayEquals(liveAutonomous.allowed_markets, ["KRW-BTC"])) {
    violations.push("allowed_markets must be exactly KRW-BTC for M22");
  }
  if (liveAutonomous.max_order_krw !== "10000") {
    violations.push("max_order_krw must be 10000");
  }
  if (liveAutonomous.daily_autonomous_notional_limit_krw !== "30000") {
    violations.push("daily_autonomous_notional_limit_krw must be 30000");
  }
  if (liveAutonomous.max_open_position_notional_krw !== "30000") {
    violations.push("max_open_position_notional_krw must be 30000");
  }
  if (liveAutonomous.identifier_max_length !== 32) {
    violations.push("identifier_max_length must be 32");
  }
  for (const key of [
    "require_m21_week_gate_evidence",
    "require_m20_inbound_readiness",
    "require_reconcile_freshness",
    "require_pnl_status_ready",
    "require_decision_ledger_ready",
    "require_exit_engine_ready",
    "require_operator_arm_evidence_id",
    "require_budget_evidence_id",
    "require_key_scope_evidence_id",
  ]) {
    if (liveAutonomous[key] !== true) {
      violations.push(`${key} must remain true`);
    }
  }

  if (config?.withdrawal_enabled === true) {
    violations.push("withdrawal_enabled must remain false");
  }
  if (config?.futures_enabled === true || config?.leverage_enabled === true) {
    violations.push("futures/leverage must remain false");
  }
  if (config?.market_order_enabled === true || config?.entry_market_order_enabled === true) {
    violations.push("market order toggles must remain false");
  }

  if (violations.length > 0) {
    return failCheck("M22 live autonomous config가 소액 pilot 안전 조건을 만족하지 않는다.", {
      violations,
    });
  }

  return okCheck("M22 live autonomous config가 KRW-BTC 단일 소액 pilot 조건을 만족한다.", {
    enabled: true,
    allowedMarkets: ["KRW-BTC"],
    maxOrderKrw: liveAutonomous.max_order_krw,
    dailyAutonomousNotionalLimitKrw: liveAutonomous.daily_autonomous_notional_limit_krw,
    maxOpenPositionNotionalKrw: liveAutonomous.max_open_position_notional_krw,
    identifierMaxLength: liveAutonomous.identifier_max_length,
  });
}

function createEnvPresenceCheck(message, names) {
  const missing = names.filter((name) => !hasEnvValue(name));
  if (missing.length > 0) {
    return failCheck(`${message} 필요한 env가 누락됐다.`, {
      missing,
      present: names.filter((name) => hasEnvValue(name)),
    });
  }

  return okCheck(message, {
    present: names,
  });
}

function createReadinessEnvCheck() {
  const missingOrFalse = requiredReadinessEnv.filter((name) => process.env[name] !== "1");
  if (missingOrFalse.length > 0) {
    return failCheck("M20/M16/M17/M18/M19 readiness가 모두 통과해야 M22 pilot을 열 수 있다.", {
      missingOrFalse,
      expectedValue: "1",
    });
  }

  return okCheck("M20/M16/M17/M18/M19 readiness env가 모두 통과 상태다.", {
    ready: requiredReadinessEnv,
  });
}

function createEventChecks(eventLog, options = {}) {
  const metrics = createMetrics(eventLog, undefined, {
    includeCarriedBudgetEnv: options.includeCarriedBudgetEnv !== false,
  });
  const checks = {
    eventLogParsed:
      eventLog.parseErrors.length === 0
        ? okCheck("M22 pilot event log를 파싱했다.", {
            eventCount: eventLog.events.length,
          })
        : failCheck("M22 pilot event log에 JSON 파싱 실패 line이 있다.", {
            parseErrors: eventLog.parseErrors,
          }),
    heartbeat:
      metrics.heartbeatCount > 0
        ? okCheck("M22 pilot heartbeat evidence가 있다.", {
            heartbeatCount: metrics.heartbeatCount,
          })
        : failCheck("M22 pilot heartbeat evidence가 없다.", {
            requiredEventType: "m22_pilot_heartbeat",
          }),
    closeoutZeroCounters: createCloseoutZeroCounterCheck(metrics),
  };

  if (options.requireDailyReport) {
    checks.dailyReportGenerated =
      metrics.dailyReportGeneratedCount > 0
        ? okCheck("M22 pilot daily report 생성 evidence가 있다.", {
            dailyReportGeneratedCount: metrics.dailyReportGeneratedCount,
          })
        : failCheck("M22 pilot daily report 생성 evidence가 없다.", {
            requiredEventType: "daily_report_generated",
          });
  } else {
    checks.dailyReportGenerated = skippedCheck("daily report evidence는 --require-daily-report에서 필수로 판정한다.", {
      dailyReportGeneratedCount: metrics.dailyReportGeneratedCount,
    });
  }

  return checks;
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
    return failCheck("M22 24시간 pilot closeout 0건 조건을 충족하지 못했다.", {
      counters,
    });
  }

  return okCheck("M22 24시간 pilot closeout 0건 조건을 충족했다.", {
    counters,
  });
}

function createMetrics(eventLog, pilotProcess, options = {}) {
  const counts = countPilotEvents(eventLog.events);
  const budget = summarizeBudgetExposure(eventLog.events, {
    includeCarriedBudgetEnv: options.includeCarriedBudgetEnv !== false,
  });
  const liveMode = summarizeLiveOrderCapability(eventLog.events);
  const dailyReport = summarizeDailyReportEvidence(eventLog.events);
  const childCrashCount =
    pilotProcess !== undefined && !pilotProcess.ranFullDuration && pilotProcess.exitCode !== 0 ? 1 : 0;

  return {
    heartbeatCount: counts.heartbeat,
    orderSubmittedCount: counts.orderSubmitted,
    brokerSubmissionCount: counts.brokerSubmission,
    manualReviewRequiredCount: counts.manualReviewRequired,
    dailyReportGeneratedCount: counts.dailyReportGenerated,
    dailyReportDate: dailyReport.dailyReportDate ?? null,
    dailyReportDateEvidenceCount: dailyReport.dailyReportDateEvidenceCount,
    dryRun: liveMode.dryRun,
    liveOrderCapable: liveMode.liveOrderCapable,
    explicitDryRunEventCount: liveMode.explicitDryRunEventCount,
    explicitNonDryRunEventCount: liveMode.explicitNonDryRunEventCount,
    liveOrderCapableEventCount: liveMode.liveOrderCapableEventCount,
    dailyRealizedLossKrw: budget.dailyRealizedLossKrw,
    dailyRealizedLossEvidenceCount: budget.dailyRealizedLossEvidenceCount,
    weeklyRealizedLossKrw: budget.weeklyRealizedLossKrw,
    weeklyRealizedLossEvidenceCount: budget.weeklyRealizedLossEvidenceCount,
    openPositionNotionalKrw: budget.maxOpenPositionNotionalKrw ?? null,
    latestOpenPositionNotionalKrw: budget.latestOpenPositionNotionalKrw ?? null,
    openPositionNotionalEvidenceCount: budget.openPositionNotionalEvidenceCount,
    crashCount: runtimeCounters.uncaughtExceptions + counts.crash + childCrashCount,
    unhandledRejectionCount: runtimeCounters.unhandledRejections + counts.unhandledRejection,
    riskGateBypassCount: counts.riskGateBypass,
    reconcileMismatchCount: counts.reconcileMismatch,
    duplicateOrderCount: counts.duplicateOrder,
    untrackedFillCount: counts.untrackedFill,
    liveOrderCleanupFailureCount: counts.liveOrderCleanupFailure,
    parseErrorCount: eventLog.parseErrors.length,
    pilotProcess: pilotProcess ?? null,
  };
}

function createEmptyMetrics() {
  return {
    heartbeatCount: 0,
    orderSubmittedCount: 0,
    brokerSubmissionCount: 0,
    manualReviewRequiredCount: 0,
    dailyReportGeneratedCount: 0,
    dailyReportDate: null,
    dailyReportDateEvidenceCount: 0,
    dryRun: null,
    liveOrderCapable: false,
    explicitDryRunEventCount: 0,
    explicitNonDryRunEventCount: 0,
    liveOrderCapableEventCount: 0,
    dailyRealizedLossKrw: 0,
    dailyRealizedLossEvidenceCount: 0,
    weeklyRealizedLossKrw: null,
    weeklyRealizedLossEvidenceCount: 0,
    openPositionNotionalKrw: null,
    latestOpenPositionNotionalKrw: null,
    openPositionNotionalEvidenceCount: 0,
    crashCount: runtimeCounters.uncaughtExceptions,
    unhandledRejectionCount: runtimeCounters.unhandledRejections,
    riskGateBypassCount: 0,
    reconcileMismatchCount: 0,
    duplicateOrderCount: 0,
    untrackedFillCount: 0,
    liveOrderCleanupFailureCount: 0,
    parseErrorCount: 0,
    pilotProcess: null,
  };
}

function countPilotEvents(events) {
  const counts = {
    heartbeat: 0,
    orderSubmitted: 0,
    brokerSubmission: 0,
    manualReviewRequired: 0,
    dailyReportGenerated: 0,
    crash: 0,
    unhandledRejection: 0,
    riskGateBypass: 0,
    reconcileMismatch: 0,
    duplicateOrder: 0,
    untrackedFill: 0,
    liveOrderCleanupFailure: 0,
  };

  for (const event of events) {
    const type = String(event.type ?? event.eventType ?? "");
    if (type === "m22_pilot_heartbeat") counts.heartbeat += 1;
    if (type === "order_submitted") counts.orderSubmitted += 1;
    if (type === "broker_submission") counts.brokerSubmission += 1;
    if (type === "manual_review_required") counts.manualReviewRequired += 1;
    if (type === "daily_report_generated") counts.dailyReportGenerated += 1;
    if (type === "crash" || event.crash === true) counts.crash += 1;
    if (type === "unhandled_rejection" || event.unhandledRejection === true) counts.unhandledRejection += 1;
    if (type === "risk_gate_bypass" || event.riskGateBypass === true) counts.riskGateBypass += 1;
    if (type === "reconcile_mismatch" || event.reconcileMismatch === true) counts.reconcileMismatch += 1;
    if (type === "duplicate_order" || event.duplicateOrder === true) counts.duplicateOrder += 1;
    if (type === "untracked_fill" || event.untrackedFill === true) counts.untrackedFill += 1;
    if (type === "order_cancel_failed" || type === "order_cancel_unconfirmed") counts.liveOrderCleanupFailure += 1;
  }

  return counts;
}

function summarizeDailyReportEvidence(events) {
  let dailyReportDate;
  let dailyReportDateEvidenceCount = 0;

  for (const event of events) {
    const type = String(event.type ?? event.eventType ?? "");
    if (type !== "daily_report_generated") {
      continue;
    }

    const eventDay = readIsoDay(event.reportDate) ?? readIsoDay(event.dailyReportDate);
    if (eventDay !== undefined) {
      // M23 closeout은 startedAt fallback 없이 daily report 기준일 자체를 검증해야 하므로 event date를 summary로 승격한다.
      dailyReportDate = eventDay;
      dailyReportDateEvidenceCount += 1;
    }
  }

  return { dailyReportDate, dailyReportDateEvidenceCount };
}

function summarizeLiveOrderCapability(events) {
  let explicitDryRunEventCount = 0;
  let explicitNonDryRunEventCount = 0;
  let liveOrderCapableEventCount = 0;

  for (const event of events) {
    const dryRun = readBoolean(event.dryRun);
    if (dryRun === true) {
      explicitDryRunEventCount += 1;
    }
    if (dryRun === false) {
      explicitNonDryRunEventCount += 1;
    }
    if (readBoolean(event.liveOrderCapable) === true) {
      liveOrderCapableEventCount += 1;
    }
  }

  const dryRun =
    explicitDryRunEventCount > 0
      ? true
      : explicitNonDryRunEventCount > 0
        ? false
        : null;
  return {
    dryRun,
    // M23 closeout은 dry-run 혼입을 막아야 하므로 명시적인 비 dry-run event를 live-order-capable evidence로 승격한다.
    liveOrderCapable: dryRun === false || liveOrderCapableEventCount > 0,
    explicitDryRunEventCount,
    explicitNonDryRunEventCount,
    liveOrderCapableEventCount,
  };
}

function summarizeBudgetExposure(events, options = {}) {
  let carriedDailyRealizedLossKrw = 0;
  let dailyRealizedLossSnapshotKrw = 0;
  let perEventRealizedLossKrw = 0;
  let dailyRealizedLossEvidenceCount = 0;
  let weeklyRealizedLossKrw;
  let weeklyRealizedLossEvidenceCount = 0;
  let maxOpenPositionNotionalKrw;
  let latestOpenPositionNotionalKrw;
  let openPositionNotionalEvidenceCount = 0;

  if (options.includeCarriedBudgetEnv !== false) {
    const carriedDailyLoss = readNonNegativeEnvNumber("SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW");
    if (carriedDailyLoss !== undefined) {
      // M23 segment는 시작 시점 carry-forward loss를 closeout ceiling에 포함해야 하므로 env evidence를 summary에 보존한다.
      carriedDailyRealizedLossKrw = carriedDailyLoss;
      dailyRealizedLossEvidenceCount += 1;
    }

    const carriedWeeklyLoss = readNonNegativeEnvNumber("SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW");
    if (carriedWeeklyLoss !== undefined) {
      // 7일 closeout ceiling은 누적 손실 기준이므로 후보가 없는 날도 주간 carry-forward를 artifact로 남겨야 한다.
      weeklyRealizedLossKrw = Math.max(weeklyRealizedLossKrw ?? 0, carriedWeeklyLoss);
      weeklyRealizedLossEvidenceCount += 1;
    }
  }

  for (const event of events) {
    const realizedLossSnapshot = readDailyRealizedLossSnapshotKrw(event);
    if (realizedLossSnapshot !== undefined) {
      dailyRealizedLossSnapshotKrw = Math.max(dailyRealizedLossSnapshotKrw, realizedLossSnapshot);
      dailyRealizedLossEvidenceCount += 1;
    }

    const perEventLoss = readPerEventRealizedLossKrw(event);
    if (perEventLoss !== undefined) {
      // fill별 손실은 누적 스냅샷이 아니므로 max로 축소하지 않고 segment 내 합계로 ceiling evidence에 반영한다.
      perEventRealizedLossKrw += perEventLoss;
      dailyRealizedLossEvidenceCount += 1;
    }

    const cumulativeLoss = readCumulativeRealizedLossKrw(event);
    if (cumulativeLoss !== undefined) {
      weeklyRealizedLossKrw = Math.max(weeklyRealizedLossKrw ?? 0, cumulativeLoss);
      weeklyRealizedLossEvidenceCount += 1;
    }

    const openPosition = readNonNegativeNumber(event.openPositionNotionalKrw);
    if (openPosition !== undefined) {
      latestOpenPositionNotionalKrw = openPosition;
      maxOpenPositionNotionalKrw = Math.max(maxOpenPositionNotionalKrw ?? 0, openPosition);
      openPositionNotionalEvidenceCount += 1;
    }
  }

  const dailyRealizedLossKrw = Math.max(
    carriedDailyRealizedLossKrw + perEventRealizedLossKrw,
    dailyRealizedLossSnapshotKrw,
  );

  return {
    dailyRealizedLossKrw,
    dailyRealizedLossEvidenceCount,
    weeklyRealizedLossKrw: weeklyRealizedLossKrw ?? null,
    weeklyRealizedLossEvidenceCount,
    maxOpenPositionNotionalKrw,
    latestOpenPositionNotionalKrw,
    openPositionNotionalEvidenceCount,
  };
}

function readCumulativeRealizedLossKrw(event) {
  return readNonNegativeNumber(event.weeklyRealizedLossKrw)
    ?? readNonNegativeNumber(event.cumulativeRealizedLossKrw);
}

function readDailyRealizedLossSnapshotKrw(event) {
  return readNonNegativeNumber(event.dailyRealizedLossKrw)
    ?? readNonNegativeNumber(event.realizedLossKrw);
}

function readPerEventRealizedLossKrw(event) {
  const explicitLoss = readNonNegativeNumber(event.lossKrw);
  if (explicitLoss !== undefined) {
    return explicitLoss;
  }
  const realizedPnl = readFiniteNumber(event.realizedPnlKrw);
  return realizedPnl !== undefined && realizedPnl < 0 ? Math.abs(realizedPnl) : undefined;
}

function readNonNegativeNumber(value) {
  const parsed = readFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function readNonNegativeEnvNumber(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    return undefined;
  }

  return readNonNegativeNumber(process.env[name]);
}

function readIsoDay(value) {
  const text = readString(value);
  if (text === undefined) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return text;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : undefined;
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return undefined;
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

function runtimeExceptionCheck(metrics = createEmptyMetrics()) {
  if (metrics.crashCount > 0 || metrics.unhandledRejectionCount > 0) {
    return failCheck("runner 또는 pilot 실행 중 처리되지 않은 예외가 관측됐다.", {
      crashCount: metrics.crashCount,
      unhandledRejectionCount: metrics.unhandledRejectionCount,
    });
  }

  return okCheck("crash와 unhandled rejection이 관측되지 않았다.", {
    crashCount: 0,
    unhandledRejectionCount: 0,
  });
}

async function readEventLog(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { events: [], parseErrors: [] };
    }
    throw error;
  }

  const events = [];
  const parseErrors = [];
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (isRecord(parsed)) {
        events.push(parsed);
      } else {
        parseErrors.push({ line: index + 1, message: "event line is not a JSON object" });
      }
    } catch (error) {
      parseErrors.push({ line: index + 1, message: toErrorMessage(error) });
    }
  }

  return { events, parseErrors };
}

async function writeFixtureEvents(filePath, startedAt) {
  const events = [
    {
      type: "m22_pilot_heartbeat",
      observedAt: startedAt.toISOString(),
      runtimeReady: true,
      market: "KRW-BTC",
      openPositionNotionalKrw: "0",
      note: "fixture smoke heartbeat",
    },
    {
      type: "daily_report_generated",
      observedAt: new Date(startedAt.getTime() + 1_000).toISOString(),
      reportDate: startedAt.toISOString().slice(0, 10),
      note: "fixture smoke daily report marker",
    },
  ];
  await writeFile(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function createFixtureConfigEvidence() {
  return {
    enabled: true,
    allowedMarkets: ["KRW-BTC"],
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    maxOpenPositionNotionalKrw: "30000",
    identifierMaxLength: 32,
  };
}

function createSummary({ runId, startedAt, inputMode, options, git, artifacts, checks, metrics }) {
  const finishedAt = new Date();
  return {
    schemaVersion: 1,
    runId,
    status: deriveStatus(checks),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMsRequested: options.fixtureSmoke ? 0 : options.durationMs,
    durationMsObserved: finishedAt.getTime() - startedAt.getTime(),
    mode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    input: inputMode,
    dailyReportDate: metrics.dailyReportDate ?? null,
    git,
    artifacts,
    metrics,
    checks,
  };
}

function deriveStatus(checks) {
  if (Object.values(checks).some((check) => check.status === "fail")) {
    return "failed";
  }

  if (checks.longRunGuard?.status === "skipped") {
    return "skipped";
  }

  return "passed";
}

async function ensureArtifactDirectories(artifacts) {
  await mkdir(path.dirname(artifacts.summaryPath), { recursive: true });
  await mkdir(path.dirname(artifacts.reportPath), { recursive: true });
  await mkdir(path.dirname(artifacts.eventLogPath), { recursive: true });
  await mkdir(path.dirname(artifacts.processLogPath), { recursive: true });
}

async function writeArtifacts({ summary, artifacts }) {
  await writeFile(artifacts.reportPath, renderMarkdownReport(summary), "utf8");
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function writeProcessLog(filePath, record) {
  await appendFile(filePath, `${JSON.stringify(redactRecord(record))}\n`, "utf8");
}

function renderMarkdownReport(summary) {
  const metricRows = [
    ["heartbeatCount", summary.metrics.heartbeatCount],
    ["orderSubmittedCount", summary.metrics.orderSubmittedCount],
    ["brokerSubmissionCount", summary.metrics.brokerSubmissionCount],
    ["manualReviewRequiredCount", summary.metrics.manualReviewRequiredCount],
    ["dailyReportGeneratedCount", summary.metrics.dailyReportGeneratedCount],
    ["crashCount", summary.metrics.crashCount],
    ["unhandledRejectionCount", summary.metrics.unhandledRejectionCount],
    ["riskGateBypassCount", summary.metrics.riskGateBypassCount],
    ["reconcileMismatchCount", summary.metrics.reconcileMismatchCount],
    ["duplicateOrderCount", summary.metrics.duplicateOrderCount],
    ["untrackedFillCount", summary.metrics.untrackedFillCount],
    ["liveOrderCleanupFailureCount", summary.metrics.liveOrderCleanupFailureCount],
    ["parseErrorCount", summary.metrics.parseErrorCount],
  ]
    .map(([name, value]) => `| ${name} | ${escapeMarkdownTable(value)} |`)
    .join("\n");
  const checkRows = Object.entries(summary.checks)
    .map(([name, check]) => `| ${name} | ${check.status} | ${escapeMarkdownTable(check.message)} |`)
    .join("\n");

  return `# M22 Live Autonomous Pilot 결과

- 실행 상태: ${summary.status}
- 실행 모드: ${summary.mode}
- 입력: ${summary.input}
- 시작: ${summary.startedAt}
- 종료: ${summary.finishedAt}
- Git branch: ${summary.git.branch ?? "unknown"}
- Git commit: ${summary.git.commit ?? "unknown"}
- event log: ${summary.artifacts.eventLogPath}
- process log: ${summary.artifacts.processLogPath}

## 핵심 metric

| 항목 | 값 |
| --- | --- |
${metricRows}

## 체크 결과

| 항목 | 결과 | 요약 |
| --- | --- | --- |
${checkRows}
`;
}

function createArtifactPaths({ artifactDir, startedAt, runId, options }) {
  const timestamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const prefix = `m22-live-autonomous-${timestamp}-${runId.slice(0, 8)}`;
  return {
    eventLogPath: options.eventLogPath ?? path.join(artifactDir, `${prefix}-events.jsonl`),
    processLogPath: options.processLogPath ?? path.join(artifactDir, `${prefix}-process.jsonl`),
    summaryPath: options.summaryPath ?? path.join(artifactDir, `${prefix}-summary.json`),
    reportPath: options.reportPath ?? path.join(artifactDir, `${prefix}-report.md`),
  };
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`M22 Live Autonomous Pilot 결과: ${summary.status}\n`);
  process.stdout.write(`- 요약 JSON: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`- 리포트: ${summary.artifacts.reportPath}\n`);
  process.stdout.write(`- event log: ${summary.artifacts.eventLogPath}\n`);
  process.stdout.write(`- heartbeat: ${summary.metrics.heartbeatCount}\n`);
  process.stdout.write(
    `- closeout 위반: ${
      summary.metrics.riskGateBypassCount +
      summary.metrics.reconcileMismatchCount +
      summary.metrics.duplicateOrderCount +
      summary.metrics.untrackedFillCount +
      summary.metrics.liveOrderCleanupFailureCount
    }\n`,
  );
}

function okCheck(message, evidence = {}) {
  return {
    status: "ok",
    message,
    evidence,
  };
}

function skippedCheck(message, evidence = {}) {
  return {
    status: "skipped",
    message,
    evidence,
  };
}

function failCheck(message, evidence = {}) {
  return {
    status: "fail",
    message,
    evidence,
  };
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readGitContext() {
  const [branch, commit] = await Promise.all([
    execFileAsync("git", ["branch", "--show-current"], { cwd: repoRoot }).then(({ stdout }) => stdout.trim()).catch(() => null),
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).then(({ stdout }) => stdout.trim()).catch(() => null),
  ]);
  return { branch, commit };
}

function hasEnvValue(name) {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayEquals(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function redactRecord(record) {
  return JSON.parse(JSON.stringify(record, (_key, value) => (typeof value === "string" ? redactText(value) : value)));
}

function redactText(value) {
  let redacted = value;
  for (const envName of sensitiveEnvCandidates) {
    const secret = process.env[envName];
    if (secret !== undefined && secret.length >= 4) {
      redacted = redacted.split(secret).join("<redacted>");
    }
  }
  return redacted
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/giu, "$1<redacted>")
    .replace(/("(?:access_key|secret_key|telegram_bot_token|jwt|authorization)"\s*:\s*")[^"]+(")/giu, "$1<redacted>$2")
    .replace(/((?:access_key|secret_key|telegram_bot_token|jwt|authorization)\s*=\s*)[^\s"']+/giu, "$1<redacted>");
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/run-m22-live-autonomous-pilot.mjs [options]

M22 제한적 완전 자동매매 24시간 pilot을 guard 뒤에서 실행하고 closeout artifact를 남긴다.

Options:
  --config <path>                 Legacy M22 pilot runtime config JSON. Defaults to config/paper.json safety profile; production uses live:ops config.
  --duration-ms <ms>              Pilot duration. Defaults to 86400000.
  --pilot-command <cmd>           Long-running live autonomous command to wrap.
  --pilot-arg <value>             Argument for --pilot-command. Repeat for multiple args.
  -- <args...>                    Pass remaining args directly to --pilot-command.
  --artifact-dir <path>           Artifact directory. Defaults to SEEMIRAI_M22_ARTIFACT_DIR or ~/vaults/99_운영/seemirai-m22-live-autonomous.
  --summary-path <path>           Explicit summary JSON path.
  --report-path <path>            Explicit Markdown report path.
  --event-log-path <path>         Explicit JSONL event evidence path.
  --process-log-path <path>       Explicit runner process log path.
  --require-daily-report          Fail unless event log contains daily_report_generated.
  --fixture-smoke                 Run deterministic no-live smoke and write artifact.
  --json                          Print summary JSON.
  --help                          Show this help.

Live execution requires SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1 and all M22 evidence/readiness env documented in docs/runbooks/m22-live-autonomous-pilot.md.
The wrapped command receives SEEMIRAI_M22_PILOT_EVENT_LOG and must append JSONL events such as {"type":"m22_pilot_heartbeat","observedAt":"..."}.
`);
}
