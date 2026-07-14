#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import pg from "pg";
import { verifyCurrentBuildProvenance } from "./build-provenance.mjs";

const { Pool: PgPool } = pg;
const runGuardEnv = "SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT";
const expectedMode = "LIVE_AUTONOMOUS_SMALL_BUDGET";
const expectedExchange = "UPBIT";
const expectedMarket = "KRW-BTC";
const expectedStrategyId = "live_ops_autonomous_24x7_core";
const expectedSourceShaPattern = /^[a-f0-9]{40}$/u;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const oneDayMs = 86_400_000;
const kstOffsetMs = 9 * 60 * 60 * 1_000;
const maxHeartbeatLagMs = 2 * 60 * 1_000;
const minimumDayDecisionCount = 1_380;
const maxDecisionCoverageGapMs = 3 * 60 * 1_000;
const lossCeilingKrw = new Decimal(50_000);
const deliveryRecoveryJobType = "report.daily.delivery_recovery";
const deliveryRecoveryRetryDelayMs = 5 * 60 * 1_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const zeroCounterNames = [
  "transientFailureCount",
  "crashCount",
  "unhandledRejectionCount",
  "reconcileMismatchCount",
  "duplicateOrderCount",
  "untrackedFillCount",
  "liveOrderCleanupFailureCount",
  "manualReviewCount",
];

if (isDirectExecution()) {
  try {
    const result = await runProductionDayCloseoutCli(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`M23 production day closeout 실패: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * 완료된 KST 날짜 하나를 production daemon, DB, private exchange, daily report evidence로 닫는다.
 *
 * 실제 경로는 명시 guard와 저장소 밖 artifact 디렉터리를 요구한다. fixture 경로는 외부 API와 DB를 열지 않고 validator가
 * 소비하는 contract만 만든다. 이 함수가 만드는 유일한 외부 side effect는 actual mode의 read-only provider 호출,
 * idempotent daily report Telegram 전송, create-only redacted artifact write다.
 */
export async function runProductionDayCloseoutCli(argv, io = {}) {
  const options = parseProductionDayCloseoutArgs(argv);
  const stdout = io.stdout ?? process.stdout;
  if (options.help) {
    stdout.write(formatProductionDayCloseoutHelp());
    return { exitCode: 0 };
  }

  if (options.fixtureSmoke) {
    const now = io.clock?.() ?? new Date("2026-07-16T00:00:05.000+09:00");
    const day = options.day ?? "2026-07-15";
    const summary = createFixtureProductionDaySummary({ day, generatedAt: now });
    if (options.artifactDir !== undefined) {
      await writeProductionDayArtifact({
        artifactDir: options.artifactDir,
        day,
        summary,
        allowRepositoryPath: true,
      });
    }
    stdout.write(`${JSON.stringify(summary, null, options.json ? 2 : 0)}\n`);
    return { exitCode: summary.status === "passed" ? 0 : 1, summary };
  }

  if (process.env[runGuardEnv] !== "1") {
    throw new Error(`${runGuardEnv}=1 guard가 필요합니다.`);
  }
  assertActualOptions(options);
  const summary = await runActualProductionDayCloseout({
    ...options,
    clock: io.clock ?? (() => new Date()),
  });
  stdout.write(`${JSON.stringify(summary, null, options.json ? 2 : 0)}\n`);
  return { exitCode: summary.status === "passed" ? 0 : 1, summary };
}

/**
 * production day closeout CLI 인자를 파싱한다.
 *
 * 경로와 날짜 문자열만 구조화하며 파일 조회나 provider 호출은 수행하지 않는다. 알 수 없는 인자를 거부해 운영 wrapper의
 * 오타가 다른 날짜 또는 artifact 경계로 확장되지 않게 한다.
 */
export function parseProductionDayCloseoutArgs(argv) {
  const options = {
    day: undefined,
    configPath: undefined,
    envFilePath: undefined,
    statusFilePath: undefined,
    startupArtifactFilePath: undefined,
    pidFilePath: undefined,
    schedulerEventLogFilePath: undefined,
    firstDay: undefined,
    artifactDir: undefined,
    expectedSourceCommitSha: undefined,
    closeoutSourceCommitSha: undefined,
    fixtureSmoke: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--day":
        options.day = readArgValue(argv, index, arg);
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
      case "--status-file":
        options.statusFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--startup-artifact-file":
        options.startupArtifactFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--pid-file":
        options.pidFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--scheduler-event-log-file":
        options.schedulerEventLogFilePath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--first-day":
        options.firstDay = readArgValue(argv, index, arg);
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
      case "--closeout-source-commit-sha":
        options.closeoutSourceCommitSha = readArgValue(argv, index, arg).toLowerCase();
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
  return options;
}

/**
 * `YYYY-MM-DD` KST 날짜를 검증하고 UTC half-open window로 변환한다.
 *
 * DB query와 validator segment가 같은 경계를 사용하도록 KST 00:00부터 다음 KST 00:00까지를 반환한다. 잘못된 날짜는 외부
 * side effect 전에 거부한다.
 */
export function createKstDayWindow(day) {
  if (!dayPattern.test(String(day))) {
    throw new Error("--day는 YYYY-MM-DD 형식이어야 합니다.");
  }
  const dayUtcMs = Date.parse(`${day}T00:00:00.000Z`);
  const startMs = dayUtcMs - kstOffsetMs;
  const startAt = new Date(startMs);
  const endAt = new Date(startMs + oneDayMs);
  const normalizedDay = new Date(startAt.getTime() + kstOffsetMs).toISOString().slice(0, 10);
  if (normalizedDay !== day) {
    throw new Error("--day는 유효한 달력 날짜여야 합니다.");
  }
  return {
    day,
    startedAt: startAt.toISOString(),
    finishedAt: endAt.toISOString(),
    startMs,
    endMs: endAt.getTime(),
  };
}

/** rollout 시작일부터 현재 기준일까지 최대 7개의 연속된 KST 날짜만 허용한다. 외부 side effect는 없다. */
function assertRolloutWindowDay({ firstWindow, window }) {
  const dayOffset = (window.startMs - firstWindow.startMs) / oneDayMs;
  if (!Number.isSafeInteger(dayOffset) || dayOffset < 0 || dayOffset >= 7) {
    throw new Error("--day는 --first-day부터 시작하는 7일 rollout window 안에 있어야 합니다.");
  }
}

/** 현재 기준일보다 앞선 rollout 연속 날짜를 순서대로 반환한다. 외부 side effect는 없다. */
export function createRolloutPreviousDays(firstDay, day) {
  const firstWindow = createKstDayWindow(firstDay);
  const window = createKstDayWindow(day);
  assertRolloutWindowDay({ firstWindow, window });
  const dayOffset = (window.startMs - firstWindow.startMs) / oneDayMs;
  return Array.from({ length: dayOffset }, (_, index) => new Date(firstWindow.startMs + kstOffsetMs + index * oneDayMs)
    .toISOString()
    .slice(0, 10));
}

/**
 * validator와 같은 production day segment shape를 fixture로 만든다.
 *
 * fixture는 provider 호출이나 durable write를 만들지 않으며, 날짜/provenance/counter contract 회귀를 CI에서 확인하는 용도다.
 */
export function createFixtureProductionDaySummary({ day, generatedAt }) {
  const window = createKstDayWindow(day);
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (generated.getTime() < window.endMs) {
    throw new Error("fixture generatedAt은 KST day 종료 이후여야 합니다.");
  }
  const provenance = {
    sourceCommitSha: "a".repeat(40),
    configFingerprint: `sha256:${"b".repeat(64)}`,
    envFingerprint: `sha256:${"c".repeat(64)}`,
    expectedMigrationVersion: 14,
    appliedMigrationVersion: 14,
  };
  const closeoutProvenance = {
    schemaVersion: 1,
    kind: "seemirai_typescript_build",
    sourceCommitSha: "d".repeat(40),
    sourceTreeFingerprint: `sha256:${"e".repeat(64)}`,
    distTreeFingerprint: `sha256:${"f".repeat(64)}`,
    generatedAt: "2026-07-14T00:00:00.000Z",
  };
  return createProductionDaySummary({
    day,
    firstDay: day,
    window,
    generatedAt: generated,
    runtimeProvenance: provenance,
    closeoutProvenance,
    configSafety: expectedConfigSafetyEvidence(),
    daemon: {
      processId: 12345,
      startedAt: "2026-07-13T20:12:29.954Z",
      latestTickStartedAt: new Date(window.endMs + 500).toISOString(),
      counters: createZeroCounters(1_440),
      boundaries: {
        startedAt: window.startedAt,
        finishedAt: window.finishedAt,
      },
    },
    database: {
      migrationVersion: 14,
      killSwitchState: "NORMAL",
      decisionScope: {
        exchange: expectedExchange,
        market: expectedMarket,
        strategyId: expectedStrategyId,
      },
      decisionCount: 1_440,
      actionableDecisionCount: 0,
      malformedActionableDecisionCount: 0,
      distinctDedupeCount: 1_440,
      firstDecisionAt: new Date(window.startMs + 1_000).toISOString(),
      latestDecisionAt: new Date(window.endMs - 1_000).toISOString(),
      maxDecisionGapMs: 60_000,
      orderSubmittedCount: 0,
      brokerSubmissionCount: 0,
      databaseOrderCount: 0,
      fillCount: 0,
      riskGateBypassCount: 0,
    },
    liveArtifacts: {
      cleanupSubmissionCount: 0,
      fillCount: 0,
      realizedLossKrw: "0",
      evidenceCount: 1,
      evidenceId: `live-cleanups:${day}:none`,
    },
    privateRead: {
      observedAt: generated.toISOString(),
      openOrderCount: 0,
      openOrderExposureKrw: "0",
      btcPositionExposureKrw: "0",
      openPositionNotionalKrw: "0",
    },
    dailyReport: {
      status: "DELIVERED",
      generatedAuditEventId: `test-report-${day}`,
      deliveryAuditEventIds: [`test-alert-${day}`],
      report: {
        orderCount: 0,
        fillCount: 0,
        realizedPnl: { value: null, available: false, sampleCount: 0 },
      },
    },
    dailyRealizedLossKrw: "0",
    dailyRealizedLossEvidenceCount: 1,
    weeklyRealizedLossKrw: "0",
    weeklyRealizedLossEvidenceCount: 1,
  });
}

async function runActualProductionDayCloseout(options) {
  await assertArtifactDirOutsideRepository(options.artifactDir);
  let database;
  try {
    await assertActualInputPathsOutsideRepository(options);
    const generatedAt = options.clock();
    const window = createKstDayWindow(options.day);
    const firstWindow = createKstDayWindow(options.firstDay);
    assertRolloutWindowDay({ firstWindow, window });
    if (generatedAt.getTime() < window.endMs) {
      throw new Error(`${options.day} KST day가 아직 종료되지 않았습니다.`);
    }

    const closeoutProvenance = await verifyCurrentBuildProvenance({
      repositoryRoot,
      expectedSourceCommitSha: options.closeoutSourceCommitSha,
    });

    const [configRawText, envRaw, status, startup, pidText, schedulerEventLogRaw] = await Promise.all([
      readFile(options.configPath, "utf8"),
      readFile(options.envFilePath, "utf8"),
      readJson(options.statusFilePath),
      readJson(options.startupArtifactFilePath),
      readFile(options.pidFilePath, "utf8"),
      readFile(options.schedulerEventLogFilePath, "utf8"),
    ]);
    const runtimeModule = await import("../dist/runtime/index.js");
    const infrastructureModule = await import("../dist/infrastructure/index.js");
    const applicationModule = await import("../dist/application/index.js");
    const configRaw = JSON.parse(configRawText);
    const envParsed = runtimeModule.parseLiveOpsEnvFileContent(envRaw);
    if (envParsed.errors.length > 0) {
      throw new Error(`env file 형식 오류가 있습니다: ${envParsed.errors.join("; ")}`);
    }
    const supervisorPid = Number(pidText.trim());
    assertProcessRunning(supervisorPid);
    const provenance = assertRuntimeProvenance({
      expectedSourceCommitSha: options.expectedSourceCommitSha,
      status,
      startup,
      startupArtifactFilePath: options.startupArtifactFilePath,
    });
    assertRuntimeInputFingerprints({ provenance, configRawText, envRawText: envRaw });
    const config = runtimeModule.loadLiveOpsConfig(configRaw);
    const configSafety = assertConfigSafety(config);
    assertDaemonWindow({ status, window, generatedAt });
    const daemonDay = deriveDaemonDayEvidence({
      eventLogRaw: schedulerEventLogRaw,
      window,
      daemonStartedAt: status.startedAt,
      sourceCommitSha: provenance.sourceCommitSha,
    });
    const existing = await readExistingPassedArtifact({
      artifactDir: options.artifactDir,
      day: options.day,
      firstDay: options.firstDay,
      window,
      runtimeProvenance: provenance,
      closeoutProvenance,
      daemonBoundaries: daemonDay.boundaries,
    });
    if (existing !== undefined) {
      return existing;
    }

    const secrets = runtimeModule.loadLiveOpsSecretsFromEnv(envParsed.values);
    const pool = new PgPool({
      connectionString: secrets.databaseUrl,
      application_name: "seemirai-m23-production-day-closeout",
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    database = infrastructureModule.createDatabase(pool);
    const [databaseRead, privateRead] = await Promise.all([
      readDatabaseEvidence(pool, window),
      readPrivateExchangeEvidence({
        infrastructureModule,
        secrets,
        referencePrice: status.latestSummary?.marketData?.referencePrice,
        observedAt: generatedAt,
      }),
    ]);
    const liveArtifacts = await readLiveArtifactEvidence(
      options.artifactDir,
      window,
      daemonDay.boundaries,
      databaseRead.actionableSubmissions,
    );
    const liveSubmission = assertLiveSubmissionEvidence({
      counters: daemonDay.counters,
      databaseEvidence: databaseRead,
      liveArtifacts,
    });
    const databaseEvidence = {
      ...databaseRead,
      orderSubmittedCount: liveSubmission.submittedOrderCount,
      brokerSubmissionCount: liveSubmission.submittedOrderCount,
      exitRequoteCount: liveSubmission.exitRequoteCount,
      riskGateBypassCount: liveSubmission.riskGateBypassCount,
    };
    assertActualPreconditions({
      provenance,
      window,
      daemonCounters: daemonDay.counters,
      databaseEvidence,
      privateRead,
    });

    const liveOpsStatus = createDailyReportLiveOpsStatus({
      applicationModule,
      status,
      config,
      databaseEvidence,
      liveArtifacts,
      privateRead,
      generatedAt,
    });
    const dailyReportDataProvider = createIssue267DailyReportDataProvider(
      new infrastructureModule.PostgresDailyReportRepository(database),
    );
    const reportBuilt = await applicationModule.buildDailyReportNotification({
      reportDate: options.day,
      dataProvider: dailyReportDataProvider,
      generatedAt,
      liveOps: liveOpsStatus,
    });

    const notifier = infrastructureModule.createTelegramNotifier({
      botToken: secrets.telegramBotToken,
      chatId: secrets.telegramChatId,
    });
    const notificationFingerprint = createIssue267NotificationFingerprint(reportBuilt.notification);
    const directAuditLog = createIssue267DailyReportAuditLog(
      new infrastructureModule.PostgresAuditLogRepository(database),
      notificationFingerprint,
    );
    const directNotifier = createIssue267FingerprintBoundNotifier(notifier, notificationFingerprint);
    const closeoutCorrelationId = `issue-267-production-day-${options.day}-${randomUUID()}`;
    const dailyReportRuntime = runtimeModule.createPaperNoKeyDailyReportRuntime({
      database,
      notifier: directNotifier,
      auditLog: directAuditLog,
      workerId: `issue_267_day_closeout_${options.day}`,
      actor: "codex-issue-267-day-closeout",
      dataProvider: dailyReportDataProvider,
      liveOpsStatusProvider: {
        async getLiveOpsStatus() {
          return liveOpsStatus;
        },
      },
    });
    const reportRun = await dailyReportRuntime.runManualDailyReport({
      reportDate: options.day,
      correlationId: closeoutCorrelationId,
    });
    const deliveredReport = resolveDailyReportRunPayload(reportRun, reportBuilt);
    let dailyReportEvidence = await readDailyReportEvidence(
      pool,
      options.day,
      window.finishedAt,
      reportRun,
      deliveredReport.report,
      deliveredReport.notification,
    );
    if (shouldRunDailyReportDeliveryRecovery(dailyReportEvidence.status)) {
      // 같은 날짜 일반 report가 먼저 완료돼도 M23 상태가 포함된 closeout notification은 별도 멱등 경계에서 한 번 보장한다.
      await runDailyReportDeliveryRecovery({
        database,
        infrastructureModule,
        notifier,
        notification: deliveredReport.notification,
        report: deliveredReport.report,
        day: options.day,
        generatedAt,
      });
      dailyReportEvidence = await readDailyReportEvidence(
        pool,
        options.day,
        window.finishedAt,
        reportRun,
        deliveredReport.report,
        deliveredReport.notification,
      );
    }
    if (dailyReportEvidence.status !== "DELIVERED") {
      throw new Error(`daily report가 owner chat 전달로 닫히지 않았습니다: ${dailyReportEvidence.status}`);
    }
    if (dailyReportEvidence.generatedAuditEventId === null || dailyReportEvidence.deliveryAuditEventIds.length < 1) {
      // Telegram side effect만 성공하고 durable audit이 빠진 상태를 actual closeout 증거로 승격하지 않는다.
      throw new Error("daily report 생성/전달 durable audit evidence가 완전하지 않습니다.");
    }

    const dailyLoss = resolveDailyRealizedLoss(liveArtifacts);
    const previousLosses = await readPreviousProductionDayLosses({
      artifactDir: options.artifactDir,
      firstDay: options.firstDay,
      day: options.day,
      runtimeProvenance: provenance,
      closeoutProvenance,
    });
    const weeklyRealizedLossKrw = previousLosses
      .reduce((total, value) => total.plus(value), new Decimal(dailyLoss.value))
      .toFixed();
    assertCloseoutExposureCeiling({
      dailyRealizedLossKrw: dailyLoss.value,
      weeklyRealizedLossKrw,
      openPositionNotionalKrw: privateRead.openPositionNotionalKrw,
    });
    const summary = createProductionDaySummary({
      day: options.day,
      firstDay: options.firstDay,
      window,
      generatedAt,
      runtimeProvenance: provenance,
      closeoutProvenance,
      configSafety,
      daemon: {
        processId: supervisorPid,
        startedAt: status.startedAt,
        latestTickStartedAt: status.latestTickStartedAt,
        counters: daemonDay.counters,
        boundaries: daemonDay.boundaries,
      },
      database: databaseEvidence,
      liveArtifacts,
      privateRead,
      dailyReport: dailyReportEvidence,
      dailyRealizedLossKrw: dailyLoss.value,
      dailyRealizedLossEvidenceCount: dailyLoss.evidenceCount,
      weeklyRealizedLossKrw,
      weeklyRealizedLossEvidenceCount: previousLosses.length + 1,
    });
    await writeProductionDayArtifact({
      artifactDir: options.artifactDir,
      day: options.day,
      summary,
      allowRepositoryPath: false,
    });
    return summary;
  } catch (error) {
    await writeFailureArtifact({ artifactDir: options.artifactDir, day: options.day, error });
    throw error;
  } finally {
    await database?.destroy().catch(() => undefined);
  }
}

/**
 * daemon의 secret-free latest summary와 closeout provider 결과를 daily report용 M23 상태로 낮춘다.
 *
 * 후보/판단/주문 부재 이유와 현재 private open exposure를 같은 report 본문에 넣는다. 입력을 조합할 뿐 DB, Upbit, Telegram
 * side effect는 추가로 만들지 않는다.
 */
export function createDailyReportLiveOpsStatus({
  applicationModule,
  status,
  config,
  databaseEvidence,
  liveArtifacts,
  privateRead,
  generatedAt,
}) {
  const latest = status.latestSummary ?? {};
  const marketData = latest.marketData ?? {};
  const decision = latest.analysisDecision ?? {};
  const execution = latest.liveExecution ?? {};
  const reconcilePnl = latest.reconcilePnlStatus ?? {};
  const telegram = latest.telegramAlert ?? {};
  const observedAt = generatedAt.toISOString();
  const heartbeatAt = toIsoOrNull(marketData.latestHeartbeatAt ?? status.latestTickStartedAt);
  const decisionAt = toIsoOrNull(decision.latestDecisionAt ?? decision.observedAt);
  const orderIntentCount = Number.isSafeInteger(Number(decision.orderIntentCount)) ? Number(decision.orderIntentCount) : 0;
  const attemptedOrderCount = Number.isSafeInteger(Number(execution.attemptedOrderCount)) ? Number(execution.attemptedOrderCount) : 0;
  const decisionLabel = formatDecisionLabel(decision.decisionCategory);
  const brokerGuardReady = execution.brokerGuard?.ready === true;
  const brokerSubmissionCount = Number(databaseEvidence.brokerSubmissionCount ?? 0);
  const exitRequoteCount = Number(databaseEvidence.exitRequoteCount ?? 0);
  const cleanupFillCount = Number(liveArtifacts.fillCount ?? 0);
  const cleanupRealizedLossKrw = isDecimalString(liveArtifacts.realizedLossKrw)
    ? liveArtifacts.realizedLossKrw
    : "확인 필요";

  return applicationModule.createLiveOpsStatusSummary({
    observedAt,
    runtimeMode: config.mode,
    paperNoKey: false,
    liveTradingEnabled: config.live_trading_enabled === true,
    liveAutonomous: {
      enabled: config.live_trading_enabled === true,
      ready: latest.status === "ready" && latest.dbReadiness?.ready === true && brokerGuardReady,
      allowedMarkets: config.universe.markets,
      maxOrderKrw: config.budget.max_order_krw,
      dailyAutonomousNotionalLimitKrw: config.budget.daily_autonomous_notional_limit_krw,
      maxOpenPositionNotionalKrw: config.budget.max_open_position_notional_krw,
      keyScopeEvidenceConfigured: typeof execution.brokerGuard?.keyScopeEvidenceId === "string",
      telegramInboundReady: telegram.ready === true,
      reconcileFresh: true,
      pnlStatusReady: reconcilePnl.ready === true,
      decisionLedgerReady: decision.ready === true,
      exitEngineReady: execution.ready === true,
      statusLabel: latest.status === "ready" ? "운영 준비 완료" : "운영 상태 확인 필요",
      message: latest.message ?? "daemon 운영 상태를 확인하지 못했습니다.",
      action: latest.status === "ready" ? null : "daemon latest status와 readiness를 확인하세요.",
      trace: {
        reason: latest.status === "ready" ? "daemon_ready" : "daemon_not_ready",
        source: "m23_production_day_closeout",
      },
    },
    marketData: {
      connectionStatus: marketData.ready === true ? "connected" : "unavailable",
      lagMs: heartbeatAt === null ? null : Math.max(generatedAt.getTime() - Date.parse(heartbeatAt), 0),
      updatedAt: heartbeatAt,
    },
    reconcile: {
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: privateRead.openOrderCount,
      lastReconcileAt: privateRead.observedAt,
      actionRequired: null,
    },
    pnl: {
      statusLabel: reconcilePnl.pnlStatusLabel ?? "운영일 손익 집계",
      latestCapturedAt: toIsoOrNull(reconcilePnl.latestPnlAt),
      latestEquityKrw: null,
      latestRealizedPnlKrw: isDecimalString(reconcilePnl.realizedPnlKrw) ? reconcilePnl.realizedPnlKrw : null,
      latestUnrealizedPnlKrw: isDecimalString(reconcilePnl.unrealizedPnlKrw) ? reconcilePnl.unrealizedPnlKrw : null,
    },
    tradingState: {
      killSwitchState: databaseEvidence.killSwitchState,
      newOrdersBlocked: databaseEvidence.killSwitchState !== "NORMAL",
      requiresManualReview: false,
      blockedReason: databaseEvidence.killSwitchState === "NORMAL" ? null : "kill_switch_not_normal",
    },
    alerts: {
      statusLabel: telegram.statusLabel ?? "알림 상태 확인",
      lastSentAt: null,
      lastSkippedAt: null,
      action: telegram.ready === true ? null : "Telegram 알림 상태를 확인하세요.",
    },
    latestHeartbeat: {
      statusLabel: heartbeatAt === null ? "heartbeat 확인 필요" : "heartbeat 정상",
      message: marketData.message ?? "daemon market data heartbeat 상태입니다.",
      observedAt: heartbeatAt,
      action: heartbeatAt === null ? "market data heartbeat를 확인하세요." : null,
      trace: { source: "live_ops_daemon_market_data" },
    },
    latestCandidate: {
      statusLabel: orderIntentCount > 0 ? `주문 후보 ${orderIntentCount}건` : "주문 후보 없음",
      message: decision.message ?? "현재 운영 판단에서 주문 후보가 생성되지 않았습니다.",
      observedAt: decisionAt,
      action: null,
      trace: { source: "live_ops_daemon_decision", orderIntentCount },
    },
    latestDecision: {
      statusLabel: decisionLabel,
      message: decision.message ?? "최근 매매 판단을 확인하지 못했습니다.",
      observedAt: decisionAt,
      action: null,
      trace: { source: "live_ops_daemon_decision", category: decision.decisionCategory ?? null },
    },
    latestOrderAttempt: {
      statusLabel: `운영일 실제 제출 ${brokerSubmissionCount}건 / 재호가 ${exitRequoteCount}건`,
      message: execution.message ?? "현재 tick에서 broker 제출은 발생하지 않았습니다.",
      observedAt: toIsoOrNull(execution.latestExecutionAt),
      action: execution.action ?? null,
      trace: {
        source: "m23_production_day_closeout",
        attemptStatus: execution.attemptStatus ?? null,
        latestTickAttemptedOrderCount: attemptedOrderCount,
        evidenceId: liveArtifacts.evidenceId,
      },
    },
    latestFillOrCancel: {
      statusLabel: `운영일 실제 체결 ${cleanupFillCount}건 / 실현 손실 ${cleanupRealizedLossKrw} KRW`,
      message: privateRead.openOrderCount === 0
        ? "closeout private 조회에서 미체결 주문이 없음을 확인했습니다."
        : "closeout private 조회에서 미체결 주문이 남아 있습니다.",
      observedAt: privateRead.observedAt,
      action: privateRead.openOrderCount === 0 ? null : "미체결 주문을 정리한 뒤 closeout을 다시 실행하세요.",
      trace: {
        source: "m23_production_day_closeout",
        openOrderCount: privateRead.openOrderCount,
        evidenceId: liveArtifacts.evidenceId,
      },
    },
    dailyNotionalUsedKrw: isDecimalString(reconcilePnl.budgetUsedKrw) ? reconcilePnl.budgetUsedKrw : null,
    openExposureKrw: privateRead.openPositionNotionalKrw,
  });
}

/** Issue #267 daily report가 대상 전략/마켓 fact만 읽도록 공통 repository를 감싼다. DB write side effect는 없다. */
export function createIssue267DailyReportDataProvider(dataProvider) {
  return {
    async loadDailyReportSourceData(window) {
      return scopeIssue267DailyReportSourceData(await dataProvider.loadDailyReportSourceData(window));
    },
  };
}

/** 일반 daily report fact에서 M23 대상 전략/마켓 또는 전역 운영 event만 남긴다. 입력 배열은 변경하지 않는다. */
export function scopeIssue267DailyReportSourceData(sourceData) {
  const matchesTarget = (fact) => fact.strategyId === expectedStrategyId && fact.market === expectedMarket;
  const matchesTargetPnl = (fact) => fact.strategyId === expectedStrategyId
    && (fact.market === expectedMarket || fact.market === null || fact.market === undefined);
  return {
    orders: sourceData.orders.filter(matchesTarget),
    fills: sourceData.fills.filter(matchesTarget),
    positions: sourceData.positions.filter(matchesTarget),
    pnlSnapshots: sourceData.pnlSnapshots.filter(matchesTargetPnl),
    auditEvents: sourceData.auditEvents.filter((fact) => matchesOptionalPayloadScope(fact.payloadJson)),
    riskEvents: sourceData.riskEvents.filter((fact) => matchesOptionalFactScope(fact)),
    executionQuality: sourceData.executionQuality.filter(matchesTarget),
  };
}

/** runtime이 실제 생성·전송한 report payload가 있으면 사전 snapshot보다 우선한다. 외부 side effect는 없다. */
export function resolveDailyReportRunPayload(reportRun, fallback) {
  return {
    report: reportRun.claimed?.result?.report ?? fallback.report,
    notification: reportRun.claimed?.result?.notification ?? fallback.notification,
  };
}

function matchesOptionalFactScope(fact) {
  return (fact.market === null || fact.market === undefined || fact.market === expectedMarket)
    && (fact.strategyId === null || fact.strategyId === undefined || fact.strategyId === expectedStrategyId);
}

function matchesOptionalPayloadScope(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return true;
  }
  const market = payload.market;
  const strategyId = payload.strategy_id ?? payload.strategyId;
  return (typeof market !== "string" || market === expectedMarket)
    && (typeof strategyId !== "string" || strategyId === expectedStrategyId);
}

/**
 * 검증된 운영 입력을 Issue #267 validator가 소비하는 secret-free day summary로 낮춘다.
 *
 * caller는 provider/DB 검증을 먼저 끝내야 한다. 이 함수는 외부 side effect 없이 evidence id, metrics, checks만 조립한다.
 */
export function createProductionDaySummary(input) {
  const decisionFingerprint = sha256Json({
    day: input.day,
    count: input.database.decisionCount,
    firstDecisionAt: input.database.firstDecisionAt,
    latestDecisionAt: input.database.latestDecisionAt,
    maxDecisionGapMs: input.database.maxDecisionGapMs,
    distinctDedupeCount: input.database.distinctDedupeCount,
  });
  const submissionFingerprint = sha256Json({
    day: input.day,
    boundaries: input.daemon.boundaries,
    submittedOrderCount: input.database.brokerSubmissionCount,
    exitRequoteCount: input.database.exitRequoteCount ?? 0,
    actionableDecisionCount: input.database.actionableDecisionCount,
    cleanupEvidenceId: input.liveArtifacts.evidenceId,
  });
  const counters = input.daemon.counters;
  return {
    schemaVersion: 1,
    issue: 267,
    status: "passed",
    input: "live_ops_daemon_day",
    rolloutWindowFirstDay: input.firstDay,
    mode: expectedMode,
    dryRun: false,
    liveOrderCapable: true,
    startedAt: input.window.startedAt,
    finishedAt: input.window.finishedAt,
    reportDate: input.day,
    dailyReportGeneratedAt: input.generatedAt.toISOString(),
    decisionEvidenceDay: input.day,
    decisionEvidenceGeneratedAt: input.generatedAt.toISOString(),
    runtimeProvenance: input.runtimeProvenance,
    closeoutProvenance: input.closeoutProvenance,
    evidenceIds: {
      decisionEvidenceId: `live-decisions:${input.day}:sha256:${decisionFingerprint}`,
      liveSubmissionEvidenceId: `live-submissions:${input.day}:sha256:${submissionFingerprint}`,
      liveCleanupEvidenceId: input.liveArtifacts.evidenceId,
      dailyReportEvidenceId: input.dailyReport.generatedAuditEventId,
      alertEvidenceIds: input.dailyReport.deliveryAuditEventIds,
    },
    metrics: {
      heartbeatCount: input.database.decisionCount,
      orderSubmittedCount: input.database.orderSubmittedCount,
      brokerSubmissionCount: input.database.brokerSubmissionCount,
      dailyReportGeneratedCount: 1,
      dryRun: false,
      liveOrderCapable: true,
      dailyRealizedLossKrw: input.dailyRealizedLossKrw,
      dailyRealizedLossEvidenceCount: input.dailyRealizedLossEvidenceCount,
      weeklyRealizedLossKrw: input.weeklyRealizedLossKrw,
      weeklyRealizedLossEvidenceCount: input.weeklyRealizedLossEvidenceCount,
      openPositionNotionalKrw: input.privateRead.openPositionNotionalKrw,
      openPositionNotionalEvidenceCount: 1,
      crashCount: counters.crashCount,
      unhandledRejectionCount: counters.unhandledRejectionCount,
      riskGateBypassCount: input.database.riskGateBypassCount,
      reconcileMismatchCount: counters.reconcileMismatchCount,
      duplicateOrderCount: counters.duplicateOrderCount,
      untrackedFillCount: counters.untrackedFillCount,
      liveOrderCleanupFailureCount: counters.liveOrderCleanupFailureCount,
    },
    checks: {
      productionDaemonWindow: okCheck({
        daemonStartedAt: input.daemon.startedAt,
        segmentStartedAt: input.window.startedAt,
        segmentFinishedAt: input.window.finishedAt,
        latestTickStartedAt: input.daemon.latestTickStartedAt,
        processId: input.daemon.processId,
      }),
      heartbeat: okCheck({
        decisionScope: input.database.decisionScope,
        decisionCount: input.database.decisionCount,
        firstDecisionAt: input.database.firstDecisionAt,
        latestDecisionAt: input.database.latestDecisionAt,
        maxDecisionGapMs: input.database.maxDecisionGapMs,
        daemonTickCount: counters.tickCount,
        daemonCounterBoundaries: input.daemon.boundaries,
      }),
      liveSubmission: okCheck({
        submittedOrderCount: input.database.brokerSubmissionCount,
        exitRequoteCount: input.database.exitRequoteCount ?? 0,
        terminalCleanupSubmissionCount: input.database.brokerSubmissionCount - (input.database.exitRequoteCount ?? 0),
        guardedActionableDecisionCount: input.database.actionableDecisionCount,
        malformedActionableDecisionCount: input.database.malformedActionableDecisionCount,
        cleanupSubmissionCount: input.liveArtifacts.cleanupSubmissionCount,
        fillCount: input.liveArtifacts.fillCount,
      }),
      dbReadiness: okCheck({
        migrationVersion: input.database.migrationVersion,
        killSwitchState: input.database.killSwitchState,
        decisionCount: input.database.decisionCount,
      }),
      configSafety: okCheck(input.configSafety),
      privateExposure: okCheck(input.privateRead),
      dailyReport: okCheck({
        status: input.dailyReport.status,
        generatedAuditEventId: input.dailyReport.generatedAuditEventId,
        deliveryAuditEventIds: input.dailyReport.deliveryAuditEventIds,
      }),
      zeroCounters: okCheck(Object.fromEntries(zeroCounterNames.map((name) => [name, counters[name]]))),
    },
  };
}

export async function readDatabaseEvidence(pool, window) {
  const result = await pool.query(
    `with scoped_decisions as (
       select decision_kind, order_intent_count, dedupe_key, observed_at, source_tick_id
         from live_decision_ticks
        where observed_at >= $1 and observed_at < $2
          and exchange = $3 and market = $4 and strategy_id = $5
     )
     select
       (select max(version)::int from schema_migrations) as migration_version,
       (select state from kill_switch_state where scope = 'global') as kill_switch_state,
       (select count(*)::int from scoped_decisions) as decision_count,
       (select count(*)::int from scoped_decisions
         where decision_kind in ('BUY', 'SELL') and order_intent_count = 1) as actionable_decision_count,
       (select count(*)::int from scoped_decisions
         where (decision_kind in ('BUY', 'SELL') or order_intent_count > 0)
           and not (decision_kind in ('BUY', 'SELL') and order_intent_count = 1)) as malformed_actionable_decision_count,
       (select coalesce(json_agg(json_build_object(
          'sourceTickId', source_tick_id,
          'observedAt', observed_at
        ) order by observed_at), '[]'::json)
          from scoped_decisions
         where decision_kind in ('BUY', 'SELL') and order_intent_count = 1) as actionable_submissions,
       (select count(distinct dedupe_key)::int from scoped_decisions) as distinct_dedupe_count,
       (select min(observed_at) from scoped_decisions) as first_decision_at,
       (select max(observed_at) from scoped_decisions) as latest_decision_at,
       (select coalesce(max(gap_ms), 0) from (
          select extract(epoch from observed_at - lag(observed_at) over (order by observed_at)) * 1000 as gap_ms
            from scoped_decisions
       ) decision_gaps) as max_decision_gap_ms,
       (select count(*)::int from orders where created_at >= $1 and created_at < $2) as database_order_count,
       (select count(*)::int from fills where filled_at >= $1 and filled_at < $2) as fill_count`,
    [window.startedAt, window.finishedAt, expectedExchange, expectedMarket, expectedStrategyId],
  );
  const row = result.rows[0];
  const actionableSubmissions = Array.isArray(row.actionable_submissions) ? row.actionable_submissions : [];
  if (actionableSubmissions.length !== Number(row.actionable_decision_count)) {
    throw new Error("actionable decision 개수와 제출 시각 evidence 개수가 다릅니다.");
  }
  return {
    migrationVersion: Number(row.migration_version),
    killSwitchState: row.kill_switch_state,
    decisionScope: {
      exchange: expectedExchange,
      market: expectedMarket,
      strategyId: expectedStrategyId,
    },
    decisionCount: Number(row.decision_count),
    actionableDecisionCount: Number(row.actionable_decision_count),
    actionableSubmissions,
    malformedActionableDecisionCount: Number(row.malformed_actionable_decision_count),
    distinctDedupeCount: Number(row.distinct_dedupe_count),
    firstDecisionAt: toIsoOrNull(row.first_decision_at),
    latestDecisionAt: toIsoOrNull(row.latest_decision_at),
    maxDecisionGapMs: Number(row.max_decision_gap_ms),
    databaseOrderCount: Number(row.database_order_count),
    fillCount: Number(row.fill_count),
  };
}

/**
 * scheduler append-only event에서 KST day 시작/종료 daemon counter 차이를 계산한다.
 *
 * 두 경계는 같은 daemon/source에서 정확히 한 번 기록돼야 한다. 누적 daemon status를 직접 쓰지 않고 이 차이만 반환하므로
 * 이전 날짜의 실패나 제출이 현재 날짜 evidence에 섞이지 않는다. 외부 side effect는 없다.
 */
export function deriveDaemonDayEvidence({ eventLogRaw, window, daemonStartedAt, sourceCommitSha }) {
  const events = String(eventLogRaw)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`scheduler event log ${index + 1}번째 줄이 JSON이 아닙니다.`);
      }
    });
  const start = findDaemonBoundary(events, window.startedAt);
  const finish = findDaemonBoundary(events, window.finishedAt);
  for (const boundary of [start, finish]) {
    if (boundary.daemonStartedAt !== daemonStartedAt || boundary.sourceCommitSha !== sourceCommitSha) {
      throw new Error("daemon counter boundary의 startup/source provenance가 현재 daemon과 다릅니다.");
    }
    const boundaryMs = Date.parse(boundary.boundaryAt);
    const observedMs = Date.parse(boundary.observedAt);
    const latestTickMs = Date.parse(boundary.latestTickStartedAt);
    if (!Number.isFinite(observedMs) || observedMs < boundaryMs || observedMs - boundaryMs > 60_000) {
      throw new Error("daemon counter boundary가 기준 시각 뒤 60초 안에 관측되지 않았습니다.");
    }
    if (!Number.isFinite(latestTickMs) || latestTickMs > boundaryMs || boundaryMs - latestTickMs > maxHeartbeatLagMs) {
      throw new Error("daemon counter boundary의 heartbeat가 기준 시각 이전 2분 범위를 충족하지 않습니다.");
    }
    if (boundary.counterAttributionCutoffAt !== undefined) {
      const cutoffMs = Date.parse(boundary.counterAttributionCutoffAt);
      if (!Number.isFinite(cutoffMs) || cutoffMs < boundaryMs || cutoffMs - boundaryMs > 60_000) {
        throw new Error("daemon counter boundary의 cleanup 제출 귀속 cutoff가 기준 시각 뒤 60초 범위를 벗어났습니다.");
      }
    }
  }
  const counters = Object.fromEntries(daemonCounterNames.map((name) => {
    const started = readNonNegativeSafeInteger(start.counters?.[name], `start.${name}`);
    const finished = readNonNegativeSafeInteger(finish.counters?.[name], `finish.${name}`);
    if (finished < started) {
      throw new Error(`daemon counter가 KST day 안에서 감소했습니다: ${name}`);
    }
    return [name, finished - started];
  }));
  return {
    counters,
    boundaries: {
      startedAt: start.boundaryAt,
      finishedAt: finish.boundaryAt,
      startObservedAt: start.observedAt,
      finishObservedAt: finish.observedAt,
      startLatestTickStartedAt: start.latestTickStartedAt,
      finishLatestTickStartedAt: finish.latestTickStartedAt,
      submissionStartedAt: resolveBoundarySubmissionCutoff(start),
      submissionFinishedAt: resolveBoundarySubmissionCutoff(finish),
    },
  };
}

function resolveBoundarySubmissionCutoff(boundary) {
  const boundaryMs = Date.parse(boundary.boundaryAt);
  const cutoffMs = Date.parse(boundary.counterAttributionCutoffAt);
  return Number.isFinite(cutoffMs) && cutoffMs >= boundaryMs
    ? new Date(cutoffMs).toISOString()
    : boundary.boundaryAt;
}

function findDaemonBoundary(events, boundaryAt) {
  const matches = events.filter((event) => event?.type === "daemon_counter_boundary" && event.boundaryAt === boundaryAt);
  if (matches.length !== 1) {
    throw new Error(`${boundaryAt} daemon counter boundary는 정확히 1개여야 합니다: ${matches.length}`);
  }
  return matches[0];
}

/**
 * durable decision row가 KST day 전체를 촘촘히 덮는지 검증한다.
 *
 * 최소 개수, 양 끝 경계, 최대 gap, dedupe 유일성을 함께 요구해 단일 heartbeat만으로 하루 evidence가 통과하지 못하게 한다.
 * 외부 side effect는 없다.
 */
export function assertDecisionCoverage(databaseEvidence, window) {
  const firstAt = Date.parse(databaseEvidence.firstDecisionAt);
  const latestAt = Date.parse(databaseEvidence.latestDecisionAt);
  if (databaseEvidence.decisionCount < minimumDayDecisionCount) {
    throw new Error(`durable decision evidence가 하루 최소 개수보다 적습니다: ${databaseEvidence.decisionCount}`);
  }
  if (!Number.isFinite(firstAt) || firstAt - window.startMs > maxDecisionCoverageGapMs) {
    throw new Error("KST day 시작 경계의 durable decision evidence가 3분을 초과해 비어 있습니다.");
  }
  if (!Number.isFinite(latestAt) || window.endMs - latestAt > maxDecisionCoverageGapMs) {
    throw new Error("KST day 종료 경계의 durable decision evidence가 3분을 초과해 비어 있습니다.");
  }
  if (!Number.isFinite(databaseEvidence.maxDecisionGapMs) || databaseEvidence.maxDecisionGapMs > maxDecisionCoverageGapMs) {
    throw new Error(`durable decision evidence의 최대 gap이 3분을 초과합니다: ${databaseEvidence.maxDecisionGapMs}`);
  }
  if (databaseEvidence.distinctDedupeCount !== databaseEvidence.decisionCount) {
    throw new Error("durable decision dedupe key 개수와 row 개수가 다릅니다.");
  }
}

/**
 * daemon 실제 제출 counter와 제출 가능 decision history를 교차 검증한다.
 *
 * live broker 경로는 `orders` row를 만들지 않을 수 있으므로 DB 주문 수를 제출 근거로 쓰지 않는다. core guard를 통과한
 * BUY/SELL 단일 intent, 대상 cleanup artifact, daemon의 실제 broker 제출 delta가 정확히 같아야 하며 불완전한 evidence는 차단한다.
 */
export function assertLiveSubmissionEvidence({ counters, databaseEvidence, liveArtifacts }) {
  if (databaseEvidence.malformedActionableDecisionCount !== 0) {
    throw new Error(`형식이 불완전한 actionable decision이 있습니다: ${databaseEvidence.malformedActionableDecisionCount}`);
  }
  if (counters.submittedOrderCount !== databaseEvidence.actionableDecisionCount) {
    throw new Error(
      `daemon broker 제출과 guarded actionable decision 개수가 다릅니다: ${counters.submittedOrderCount}/${databaseEvidence.actionableDecisionCount}`,
    );
  }
  if (counters.exitRequoteCount > counters.submittedOrderCount) {
    throw new Error(`SELL 재호가 수가 daemon broker 제출 수보다 많습니다: ${counters.exitRequoteCount}/${counters.submittedOrderCount}`);
  }
  const terminalCleanupSubmissionCount = counters.submittedOrderCount - counters.exitRequoteCount;
  if (terminalCleanupSubmissionCount !== liveArtifacts.cleanupSubmissionCount) {
    throw new Error(
      `terminal broker 제출과 대상 strategy cleanup artifact 개수가 다릅니다: ${terminalCleanupSubmissionCount}/${liveArtifacts.cleanupSubmissionCount}`,
    );
  }
  return {
    submittedOrderCount: counters.submittedOrderCount,
    exitRequoteCount: counters.exitRequoteCount,
    riskGateBypassCount: 0,
  };
}

export async function readLiveArtifactEvidence(artifactDir, window, daemonBoundaries = {}, actionableSubmissions = []) {
  const files = await readdir(artifactDir);
  const cleanupFiles = files.filter((file) => /^cleanup-ops-[a-f0-9]{26}\.json$/u.test(file)).toSorted();
  const reservationFiles = files.filter((file) => /^reservation-ops-[a-f0-9]{26}\.json$/u.test(file)).toSorted();
  const cleanupRecords = [];
  const reservationRecords = [];
  for (const file of [...cleanupFiles, ...reservationFiles]) {
    try {
      const target = file.startsWith("cleanup-") ? cleanupRecords : reservationRecords;
      target.push({ file, value: await readJson(path.join(artifactDir, file)) });
    } catch {
      // 손상된 reservation/cleanup을 건너뛰면 제출과 손실을 과소 집계하므로 해당 day closeout을 중단한다.
      throw new Error(`live submission artifact를 읽을 수 없습니다: ${file}`);
    }
  }
  const scopedReservations = reservationRecords
    .filter(({ value }) => value.strategyId === expectedStrategyId && value.market === expectedMarket);
  const reservationAttemptIds = scopedReservations.map(({ value }) => value.attemptId);
  if (
    reservationAttemptIds.some((attemptId) => typeof attemptId !== "string")
    || new Set(reservationAttemptIds).size !== reservationAttemptIds.length
  ) {
    throw new Error("대상 strategy reservation artifact의 attempt ID가 없거나 중복됐습니다.");
  }
  const reservationByAttemptId = new Map(scopedReservations
    .map((record) => [record.value.attemptId, record]));
  const actionableSubmissionByAttemptId = createActionableSubmissionByAttemptId(actionableSubmissions);
  // generic cancel cleanup은 strategy 필드 도입 전 형식만 허용해 같은 디렉터리의 probe 제출을 대상 daemon에서 격리한다.
  const scopedCleanups = cleanupRecords.filter(({ value }) => (
    value.market === expectedMarket
      && (
        value.strategyId === expectedStrategyId
        || (value.kind === "live_ops_cleanup_closeout" && value.strategyId == null)
      )
  ));
  const attemptIds = scopedCleanups.map(({ value }) => value.attemptId);
  if (attemptIds.some((attemptId) => typeof attemptId !== "string") || new Set(attemptIds).size !== attemptIds.length) {
    throw new Error("대상 strategy cleanup artifact의 attempt ID가 없거나 중복됐습니다.");
  }
  const submissionStartMs = resolveSubmissionBoundaryMs(daemonBoundaries.submissionStartedAt, window.startMs);
  const submissionFinishMs = resolveSubmissionBoundaryMs(daemonBoundaries.submissionFinishedAt, window.endMs);
  if (submissionStartMs >= submissionFinishMs) {
    throw new Error("daemon counter와 cleanup 제출 귀속 window가 올바르지 않습니다.");
  }
  const submissionRecords = scopedCleanups.filter(({ value }) => {
    const reservation = reservationByAttemptId.get(value.attemptId);
    const actionableSubmission = actionableSubmissionByAttemptId.get(value.attemptId);
    // 체결 시각은 제출일을 증명하지 못하므로 durable reservation/decision이 없으면 해당 day 제출로 추정하지 않는다.
    const submittedAt = Date.parse(
      value.submittedAt ?? reservation?.value.reservedAt ?? actionableSubmission?.observedAt,
    );
    return Number.isFinite(submittedAt) && submittedAt >= submissionStartMs && submittedAt < submissionFinishMs;
  });
  for (const { file, value } of submissionRecords) {
    const reservation = reservationByAttemptId.get(value.attemptId);
    const entrySubmission = value.side === "BUY" || String(value.kind ?? "").includes("_entry_");
    if (entrySubmission && (reservation === undefined || !Number.isFinite(Date.parse(reservation.value.reservedAt)))) {
      // broker 제출 전 durable budget reservation이 없으면 cleanup만으로 승인된 제출이라고 단정하지 않는다.
      throw new Error(`BUY 제출 cleanup과 일치하는 대상 strategy reservation이 없습니다: ${file}`);
    }
  }
  const fills = scopedCleanups.filter(({ value }) => {
    const filledAt = Date.parse(value.filledAt);
    return value.status === "FILLED" && Number.isFinite(filledAt) && filledAt >= window.startMs && filledAt < window.endMs;
  });
  const exits = fills.filter(({ value }) => value.kind === "live_ops_autonomous_exit_closeout");
  let realizedLoss = new Decimal(0);
  for (const { file, value } of exits) {
    if (!isDecimalString(value.realizedPnlKrw)) {
      throw new Error(`SELL cleanup artifact에 realized PnL이 없습니다: ${file}`);
    }
    realizedLoss = realizedLoss.plus(Decimal.max(new Decimal(value.realizedPnlKrw).negated(), 0));
  }
  const submissionFiles = new Set(submissionRecords.map(({ file }) => file));
  const fillFiles = new Set(fills.map(({ file }) => file));
  const evidenceRecords = scopedCleanups.filter(({ file }) => submissionFiles.has(file) || fillFiles.has(file));
  const evidenceFingerprint = sha256Json(evidenceRecords.map(({ file, value }) => {
    const reservation = reservationByAttemptId.get(value.attemptId);
    const actionableSubmission = actionableSubmissionByAttemptId.get(value.attemptId);
    return {
      file,
      submissionInDay: submissionFiles.has(file),
      fillInDay: fillFiles.has(file),
      reservationFile: reservation?.file ?? null,
      attemptId: value.attemptId,
      kind: value.kind ?? null,
      side: value.side ?? null,
      status: value.status ?? null,
      reservedAt: reservation?.value.reservedAt ?? null,
      submittedAt: value.submittedAt ?? reservation?.value.reservedAt ?? actionableSubmission?.observedAt ?? null,
      decisionSourceTickId: actionableSubmission?.sourceTickId ?? null,
      filledAt: value.filledAt ?? null,
      terminalCheckedAt: value.terminalCheckedAt ?? null,
      filledQuantity: value.filledQuantity ?? null,
      filledPrice: value.filledPrice ?? null,
      filledNotionalKrw: value.filledNotionalKrw ?? null,
      entryFeeKrw: value.entryFeeKrw ?? null,
      exitFeeKrw: value.exitFeeKrw ?? null,
      realizedPnlKrw: value.realizedPnlKrw ?? null,
    };
  }));
  return {
    cleanupSubmissionCount: submissionRecords.length,
    fillCount: fills.length,
    realizedLossKrw: realizedLoss.toFixed(),
    evidenceCount: Math.max(exits.length, 1),
    evidenceId: `live-cleanups:${window.day}:sha256:${evidenceFingerprint}`,
  };
}

function createActionableSubmissionByAttemptId(actionableSubmissions) {
  if (!Array.isArray(actionableSubmissions)) {
    throw new Error("actionable submission evidence가 배열이 아닙니다.");
  }
  const records = new Map();
  for (const submission of actionableSubmissions) {
    const sourceTickId = typeof submission?.sourceTickId === "string" ? submission.sourceTickId : "";
    const attemptId = sourceTickId.match(/:(ops-[a-f0-9]{26})$/u)?.[1];
    const observedAt = toIsoOrNull(submission?.observedAt);
    if (observedAt === null) {
      throw new Error("actionable decision의 제출 시각 evidence가 올바르지 않습니다.");
    }
    if (attemptId === undefined) {
      // 새 decision key는 runtime attempt와 다를 수 있으므로 명시 submittedAt이 있는 cleanup까지 eager 차단하지 않는다.
      continue;
    }
    if (records.has(attemptId)) {
      // legacy fallback은 attempt당 유일한 durable decision일 때만 제출 시각 근거로 사용한다.
      throw new Error("actionable decision의 attempt ID evidence가 중복됐습니다.");
    }
    records.set(attemptId, { sourceTickId, observedAt });
  }
  return records;
}

function resolveSubmissionBoundaryMs(value, fallbackMs) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

async function readPrivateExchangeEvidence({ infrastructureModule, secrets, referencePrice, observedAt }) {
  if (!isDecimalString(referencePrice)) {
    throw new Error("daemon status에 reference price가 없습니다.");
  }
  const privateClient = new infrastructureModule.UpbitPrivateRestClient({
    credentials: {
      accessKey: secrets.upbitAccessKey,
      secretKey: secrets.upbitSecretKey,
    },
  });
  const broker = infrastructureModule.createUpbitLiveBroker({ privateClient });
  const [orders, balances] = await Promise.all([broker.listOpenOrders(), broker.getBalances()]);
  const openOrderExposure = orders.reduce((total, order) => {
    if (!isDecimalString(order.requestedPrice) || !isDecimalString(order.remainingQuantity)) {
      return total;
    }
    return total.plus(new Decimal(order.requestedPrice).mul(order.remainingQuantity));
  }, new Decimal(0));
  const btc = balances.balances.find((balance) => balance.currency === "BTC");
  const btcExposure = new Decimal(btc?.total ?? "0").mul(referencePrice);
  return {
    observedAt: observedAt.toISOString(),
    openOrderCount: orders.length,
    openOrderExposureKrw: openOrderExposure.toFixed(),
    btcPositionExposureKrw: btcExposure.toFixed(),
    openPositionNotionalKrw: openOrderExposure.plus(btcExposure).toFixed(),
  };
}

export async function readDailyReportEvidence(pool, day, windowFinishedAt, reportRun, report, notification) {
  const audit = await pool.query(
    `select id, payload_json->>'actor' as actor, correlation_id, payload_json->>'reason_code' as reason_code,
            payload_json->>'m23_live_ops_notification_fingerprint' as notification_fingerprint, occurred_at
       from audit_events
      where payload_json->>'report_date' = $1
        and occurred_at >= $2
        and payload_json->>'reason_code' in ('daily_report_generated', 'daily_report_notification_delivered', 'daily_report_notification_failed')
      order by occurred_at asc`,
    [day, windowFinishedAt],
  );
  const expectedNotificationFingerprint = notification === undefined
    ? undefined
    : createIssue267NotificationFingerprint(notification);
  const postWindowRows = filterIssue267CloseoutDailyReportAuditRows(
    audit.rows,
    day,
    windowFinishedAt,
    expectedNotificationFingerprint,
  );
  const generated = postWindowRows.filter((row) => row.reason_code === "daily_report_generated");
  const delivered = postWindowRows.filter((row) => row.reason_code === "daily_report_notification_delivered");
  const failed = postWindowRows.filter((row) => row.reason_code === "daily_report_notification_failed");
  const status = resolveDailyReportEvidenceStatus({ generated, delivered, failed, reportRun });
  return {
    status,
    runtimeStatus: reportRun.status,
    generatedAuditEventId: generated.at(-1)?.id ?? null,
    generatedAuditOccurredAt: toIsoOrNull(generated.at(-1)?.occurred_at),
    deliveryAuditEventIds: delivered.map((row) => row.id),
    deliveryAuditOccurredAts: delivered.map((row) => toIsoOrNull(row.occurred_at)),
    notificationFailureAuditEventIds: failed.map((row) => row.id),
    report: {
      orderCount: report.orderCount,
      fillCount: report.fillCount,
      realizedPnl: report.realizedPnl,
    },
  };
}

/** provider 전송 결과와 durable audit을 함께 읽어 재전송 가능 상태와 수동 확인 상태를 분리한다. 외부 side effect는 없다. */
export function resolveDailyReportEvidenceStatus({ generated, delivered, failed, reportRun }) {
  if (delivered.length > 0) {
    return "DELIVERED";
  }
  const runtimeStatus = reportRun.claimed?.result?.status;
  if (runtimeStatus === "DELIVERED") {
    // provider 성공 뒤 audit만 빠졌다면 재전송은 중복 owner notification을 만들 수 있어 수동 확인으로 고정한다.
    return "DELIVERY_AUDIT_MISSING_MANUAL_CONFIRMATION";
  }
  if (runtimeStatus === "NOTIFICATION_FAILED" || failed.length > 0) {
    return "NOTIFICATION_FAILED";
  }
  if (generated.length > 0) {
    if (generated.some((row) => String(row.correlation_id ?? "").startsWith("issue-267-delivery-recovery-"))) {
      // recovery generated audit가 있으면 provider 실패 audit 누락 가능성이 있어 completed job guard 아래 재시도한다.
      return "NOTIFICATION_FAILED";
    }
    // 이전 실행이 provider 성공 후 audit 저장에서 끊긴 상태를 SKIPPED job만 보고 재전송하지 않는다.
    return "DELIVERY_AUDIT_MISSING_MANUAL_CONFIRMATION";
  }
  if (reportRun.status === "SKIPPED_EXISTING_JOB") {
    return "COMPLETED_WITHOUT_DELIVERY";
  }
  return runtimeStatus ?? reportRun.status;
}

/** provider 실패 또는 일반 report 선점처럼 outbound 미실행이 확실한 상태에서만 delivery recovery를 연다. */
export function shouldRunDailyReportDeliveryRecovery(status) {
  return status === "NOTIFICATION_FAILED" || status === "COMPLETED_WITHOUT_DELIVERY";
}

/** 완료된 KST window 이후에 생성된 daily report audit만 반환한다. 외부 side effect는 없다. */
export function filterPostWindowDailyReportAuditRows(rows, windowFinishedAt) {
  const boundaryMs = Date.parse(windowFinishedAt);
  if (!Number.isFinite(boundaryMs)) {
    throw new Error("daily report audit window 종료 시각이 올바르지 않습니다.");
  }
  return rows.filter((row) => {
    const occurredAtMs = Date.parse(row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at);
    return Number.isFinite(occurredAtMs) && occurredAtMs >= boundaryMs;
  });
}

/** Issue #267 closeout actor와 correlation 경계에서 생성된 일별 report audit만 반환한다. 외부 side effect는 없다. */
export function filterIssue267CloseoutDailyReportAuditRows(
  rows,
  day,
  windowFinishedAt,
  expectedNotificationFingerprint,
) {
  const closeoutPrefix = `issue-267-production-day-${day}-`;
  const recoveryPrefix = `issue-267-delivery-recovery-${day}`;
  return filterPostWindowDailyReportAuditRows(rows, windowFinishedAt).filter((row) => (
    row.actor === "codex-issue-267-day-closeout"
    && typeof expectedNotificationFingerprint === "string"
    && row.notification_fingerprint === expectedNotificationFingerprint
    && (
      String(row.correlation_id ?? "").startsWith(closeoutPrefix)
      || String(row.correlation_id ?? "").startsWith(recoveryPrefix)
    )
  ));
}

/** recovery audit과 현재 owner notification payload를 연결하는 secret-free fingerprint를 만든다. */
export function createIssue267NotificationFingerprint(notification) {
  if (notification === null || typeof notification !== "object" || Array.isArray(notification)) {
    throw new Error("daily report notification fingerprint 입력이 올바르지 않습니다.");
  }
  const { generatedAt: _generatedAt, ...stableNotification } = notification;
  return `sha256:${sha256Json(stableNotification)}`;
}

/** direct closeout report audit을 실제 전송할 안정 payload fingerprint와 결합한다. */
export function createIssue267DailyReportAuditLog(auditLog, notificationFingerprint) {
  return {
    async appendEvent(event) {
      return auditLog.appendEvent({
        ...event,
        metadata: {
          ...(event.metadata ?? {}),
          m23_live_ops_notification_fingerprint: notificationFingerprint,
        },
      });
    },
  };
}

/** prebuilt payload와 runtime payload가 다르면 잘못된 fingerprint로 Telegram을 보내기 전에 차단한다. */
export function createIssue267FingerprintBoundNotifier(notifier, expectedNotificationFingerprint) {
  return {
    async sendDailyReport(notification) {
      const actualNotificationFingerprint = createIssue267NotificationFingerprint(notification);
      if (actualNotificationFingerprint !== expectedNotificationFingerprint) {
        throw new Error("daily report notification이 audit fingerprint binding 이후 변경됐습니다.");
      }
      return notifier.sendDailyReport(notification);
    },
  };
}

/**
 * 완료된 daily report와 분리된 idempotency job에서 Telegram delivery만 복구한다.
 *
 * provider 실패는 같은 recovery job을 재예약한다. provider 성공 뒤 audit 저장이 실패하면 job을 완료해 중복 전송을 막고
 * 수동 확인을 요구한다. DB job/audit 및 Telegram outbound 외 side effect는 없다.
 */
export async function runDailyReportDeliveryRecovery({
  database,
  infrastructureModule,
  notifier,
  notification,
  report,
  day,
  generatedAt,
}) {
  const idempotencyKey = `${deliveryRecoveryJobType}:${day}`;
  const workerId = `issue_267_delivery_recovery_${day}`;
  let enqueueResult = await infrastructureModule.enqueueJob(database, {
    jobType: deliveryRecoveryJobType,
    idempotencyKey,
    payloadJson: { report_date: day },
    runAfter: generatedAt,
    maxAttempts: 36,
  });
  if (!enqueueResult.created && enqueueResult.job.status === "COMPLETED") {
    throw new Error("daily report delivery recovery job은 완료됐지만 delivery audit이 없어 수동 확인이 필요합니다.");
  }
  if (!enqueueResult.created && enqueueResult.job.status === "FAILED") {
    // 실패 한도를 소진한 recovery도 다음 closeout에서 같은 key로 재개해 일시 provider 장애가 영구 누락으로 고정되지 않게 한다.
    const requeuedJob = await infrastructureModule.requeueFailedJobByIdempotencyKey(database, {
      idempotencyKey,
      jobType: deliveryRecoveryJobType,
      runAfter: generatedAt,
      requeuedAt: generatedAt,
      maxAttempts: 36,
    });
    if (requeuedJob === undefined) {
      throw new Error("FAILED daily report delivery recovery job을 재큐잉할 수 없습니다.");
    }
    enqueueResult = { ...enqueueResult, job: requeuedJob };
  }
  const claimed = await infrastructureModule.claimJobByIdempotencyKey(database, {
    workerId,
    jobType: deliveryRecoveryJobType,
    idempotencyKey,
    now: generatedAt,
  });
  if (claimed === undefined) {
    throw new Error(`daily report delivery recovery job을 현재 claim할 수 없습니다: ${enqueueResult.job.status}`);
  }

  const auditLog = new infrastructureModule.PostgresAuditLogRepository(database);
  const notificationFingerprint = createIssue267NotificationFingerprint(notification);
  try {
    await auditLog.appendEvent({
      eventType: "DAILY_REPORT",
      severity: "INFO",
      occurredAt: generatedAt,
      actor: "codex-issue-267-day-closeout",
      reasonCode: "daily_report_generated",
      correlationId: `issue-267-delivery-recovery-${day}`,
      metadata: {
        report_date: day,
        trigger: "delivery_recovery",
        job_id: claimed.id,
        order_count: report?.orderCount ?? null,
        fill_count: report?.fillCount ?? null,
        m23_live_ops_notification_fingerprint: notificationFingerprint,
      },
    });
  } catch {
    // provider 호출 전 audit 실패는 job을 재예약해 M23 report delivery evidence 누락 없이 다시 시도한다.
    await infrastructureModule.failJob(database, {
      jobId: claimed.id,
      workerId,
      errorMessage: "daily_report_delivery_recovery_generation_audit_failed",
      failedAt: generatedAt,
      retryAfter: new Date(generatedAt.getTime() + deliveryRecoveryRetryDelayMs),
    });
    throw new Error("daily report delivery recovery 생성 audit 저장이 실패해 같은 job 재시도를 예약했습니다.");
  }

  let notificationResult;
  try {
    notificationResult = await notifier.sendDailyReport(notification);
  } catch {
    notificationResult = { delivered: false };
  }
  if (notificationResult.delivered !== true) {
    try {
      await auditLog.appendEvent({
        eventType: "NOTIFICATION_DELIVERY",
        severity: "WARN",
        occurredAt: generatedAt,
        actor: "codex-issue-267-day-closeout",
        reasonCode: "daily_report_notification_failed",
        correlationId: `issue-267-delivery-recovery-${day}`,
        metadata: {
          report_date: day,
          delivered: false,
          trigger: "delivery_recovery",
          job_id: claimed.id,
          m23_live_ops_notification_fingerprint: notificationFingerprint,
          ...(notificationResult.skippedReason === undefined
            ? {}
            : { skipped_reason: notificationResult.skippedReason }),
        },
      });
    } catch {
      // recovery correlation의 generated-only audit도 다음 closeout에서 재시도 가능 상태로 해석해 provider 실패를 영구 고정하지 않는다.
    }
    await infrastructureModule.failJob(database, {
      jobId: claimed.id,
      workerId,
      errorMessage: "daily_report_delivery_recovery_provider_failed",
      failedAt: generatedAt,
      retryAfter: new Date(generatedAt.getTime() + deliveryRecoveryRetryDelayMs),
    });
    throw new Error("daily report delivery recovery provider 전송이 실패해 같은 job 재시도를 예약했습니다.");
  }

  let receipt;
  try {
    receipt = await auditLog.appendEvent({
      eventType: "NOTIFICATION_DELIVERY",
      severity: "INFO",
      occurredAt: generatedAt,
      actor: "codex-issue-267-day-closeout",
      reasonCode: "daily_report_notification_delivered",
      correlationId: `issue-267-delivery-recovery-${day}`,
      metadata: {
        report_date: day,
        delivered: true,
        trigger: "delivery_recovery",
        job_id: claimed.id,
        m23_live_ops_notification_fingerprint: notificationFingerprint,
        ...(notificationResult.providerMessageId === undefined
          ? {}
          : { provider_message_id: notificationResult.providerMessageId }),
      },
    });
  } catch {
    // provider 성공 뒤에는 audit 장애를 재전송으로 복구하지 않아 owner chat 중복 전달을 차단한다.
    await infrastructureModule.completeJob(database, {
      jobId: claimed.id,
      workerId,
      completedAt: generatedAt,
    });
    throw new Error("daily report delivery는 성공했지만 recovery audit 저장에 실패해 수동 확인이 필요합니다.");
  }
  await infrastructureModule.completeJob(database, {
    jobId: claimed.id,
    workerId,
    completedAt: generatedAt,
  });
  return { status: "DELIVERED", auditEventId: receipt.auditEventId };
}

function assertActualPreconditions({ provenance, window, daemonCounters, databaseEvidence, privateRead }) {
  if (provenance.expectedMigrationVersion !== 14 || provenance.appliedMigrationVersion !== 14 || databaseEvidence.migrationVersion !== 14) {
    throw new Error("migration 14 provenance가 일치하지 않습니다.");
  }
  if (databaseEvidence.killSwitchState !== "NORMAL") {
    throw new Error(`kill switch가 NORMAL이 아닙니다: ${databaseEvidence.killSwitchState}`);
  }
  assertDecisionCoverage(databaseEvidence, window);
  if (daemonCounters.tickCount < minimumDayDecisionCount) {
    throw new Error(`daemon tick day delta가 하루 최소 개수보다 적습니다: ${daemonCounters.tickCount}`);
  }
  if (databaseEvidence.riskGateBypassCount !== 0) {
    throw new Error(`risk gate approval evidence가 없는 주문이 있습니다: ${databaseEvidence.riskGateBypassCount}`);
  }
  if (privateRead.openOrderCount !== 0 || !new Decimal(privateRead.openOrderExposureKrw).isZero()) {
    throw new Error("day closeout 시점에 private open order가 남아 있습니다.");
  }
  for (const counterName of zeroCounterNames) {
    if (daemonCounters[counterName] !== 0) {
      throw new Error(`${counterName} day delta가 0이 아닙니다: ${daemonCounters[counterName]}`);
    }
  }
}

function assertRuntimeProvenance({ expectedSourceCommitSha, status, startup, startupArtifactFilePath }) {
  if (!expectedSourceShaPattern.test(expectedSourceCommitSha)) {
    throw new Error("expected source commit SHA가 40자리 lowercase hex가 아닙니다.");
  }
  if (status.startupArtifactFilePath !== startupArtifactFilePath) {
    throw new Error("daemon status와 지정 startup artifact 경로가 다릅니다.");
  }
  const statusProvenance = status.runtimeProvenance;
  const startupProvenance = startup.runtimeProvenance;
  if (JSON.stringify(statusProvenance) !== JSON.stringify(startupProvenance)) {
    throw new Error("startup/status runtime provenance가 다릅니다.");
  }
  if (statusProvenance?.sourceCommitSha !== expectedSourceCommitSha) {
    throw new Error("daemon source commit SHA가 expected rollout SHA와 다릅니다.");
  }
  return statusProvenance;
}

/** 현재 config/env 원문이 daemon startup에 고정된 fingerprint와 같은지 검증한다. 외부 side effect는 없다. */
export function assertRuntimeInputFingerprints({ provenance, configRawText, envRawText }) {
  const configFingerprint = sha256Text(configRawText);
  const envFingerprint = sha256Text(envRawText);
  if (provenance?.configFingerprint !== configFingerprint) {
    // 다른 config로 provider를 열면 daemon provenance와 closeout evidence가 갈라지므로 side effect 전에 차단한다.
    throw new Error("현재 config fingerprint가 daemon startup provenance와 다릅니다.");
  }
  if (provenance?.envFingerprint !== envFingerprint) {
    // credential 파일 교체 뒤 잘못된 계정으로 조회·전송하는 것을 막기 위해 원문 fingerprint를 고정한다.
    throw new Error("현재 env fingerprint가 daemon startup provenance와 다릅니다.");
  }
  return { configFingerprint, envFingerprint };
}

function assertConfigSafety(config) {
  const evidence = {
    enabled: config.live_trading_enabled === true,
    allowedMarkets: config.universe.markets,
    maxOrderKrw: config.budget.max_order_krw,
    dailyAutonomousNotionalLimitKrw: config.budget.daily_autonomous_notional_limit_krw,
    maxOpenPositionNotionalKrw: config.budget.max_open_position_notional_krw,
  };
  const safe = config.mode === expectedMode
    && evidence.enabled
    && evidence.allowedMarkets.length === 1
    && evidence.allowedMarkets[0] === "KRW-BTC"
    && evidence.maxOrderKrw === "10000"
    && evidence.dailyAutonomousNotionalLimitKrw === "30000"
    && evidence.maxOpenPositionNotionalKrw === "30000"
    && config.market_order_enabled === false
    && config.entry_market_order_enabled === false
    && config.withdrawal_enabled === false
    && config.futures_enabled === false
    && config.leverage_enabled === false;
  if (!safe) {
    throw new Error("production config가 Issue #267 small-budget safety contract와 다릅니다.");
  }
  return evidence;
}

function assertDaemonWindow({ status, window, generatedAt }) {
  const daemonStartedAt = Date.parse(status.startedAt);
  const latestTickStartedAt = Date.parse(status.latestTickStartedAt);
  if (status.status !== "running" || status.latestError !== null || status.latestSummary?.status !== "ready") {
    throw new Error("daemon latest status가 running/ready가 아닙니다.");
  }
  if (!Number.isFinite(daemonStartedAt) || daemonStartedAt > window.startMs) {
    throw new Error("daemon이 KST day 시작 이전부터 연속 실행되지 않았습니다.");
  }
  if (!Number.isFinite(latestTickStartedAt) || latestTickStartedAt < window.endMs) {
    throw new Error("daemon heartbeat가 KST day 종료를 덮지 못했습니다.");
  }
  if (generatedAt.getTime() - latestTickStartedAt > maxHeartbeatLagMs) {
    throw new Error("daemon latest heartbeat가 2분보다 오래됐습니다.");
  }
}

/** filledAt KST window에 속한 SELL cleanup만 사용해 누적 DB PnL을 일일 손실로 중복 반영하지 않는다. */
export function resolveDailyRealizedLoss(liveArtifacts) {
  if (!isDecimalString(liveArtifacts.realizedLossKrw) || liveArtifacts.evidenceCount < 1) {
    throw new Error("일별 SELL cleanup realized PnL evidence가 올바르지 않습니다.");
  }
  const liveLoss = new Decimal(liveArtifacts.realizedLossKrw);
  return { value: liveLoss.toFixed(), evidenceCount: liveArtifacts.evidenceCount };
}

/**
 * 실현 손실과 허용된 open position 명목금액이 50,000 KRW ceiling 미만인지 검증한다.
 *
 * 포지션 자체를 0으로 강제하지 않고 일/주간 중 큰 실현 손실과 합산한다. 입력은 closeout read 결과이며 외부 side effect는 없다.
 */
export function assertCloseoutExposureCeiling({
  dailyRealizedLossKrw,
  weeklyRealizedLossKrw,
  openPositionNotionalKrw,
}) {
  for (const [name, value] of Object.entries({ dailyRealizedLossKrw, weeklyRealizedLossKrw, openPositionNotionalKrw })) {
    if (!isDecimalString(value) || new Decimal(value).isNegative()) {
      throw new Error(`${name}은 0 이상의 decimal이어야 합니다.`);
    }
  }
  const ceilingLoss = Decimal.max(dailyRealizedLossKrw, weeklyRealizedLossKrw);
  const combinedExposure = ceilingLoss.plus(openPositionNotionalKrw);
  if (combinedExposure.gte(lossCeilingKrw)) {
    throw new Error(`실현 손실과 open position 합계가 50,000 KRW ceiling 이상입니다: ${combinedExposure.toFixed()}`);
  }
  return {
    ceilingRealizedLossKrw: ceilingLoss.toFixed(),
    combinedExposureKrw: combinedExposure.toFixed(),
  };
}

export async function readPreviousProductionDayLosses({
  artifactDir,
  firstDay,
  day,
  runtimeProvenance,
  closeoutProvenance,
}) {
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const expectedDays = createRolloutPreviousDays(firstDay, day);
  const losses = [];
  for (const expectedDay of expectedDays) {
    const file = `production-day-${expectedDay}.json`;
    let summary;
    try {
      summary = await readJson(path.join(artifactDir, file));
    } catch {
      throw new Error(`현재 rollout의 이전 day artifact를 읽을 수 없습니다: ${file}`);
    }
    const expectedWindow = createKstDayWindow(expectedDay);
    const boundaries = summary.checks?.heartbeat?.evidence?.daemonCounterBoundaries;
    const reusable = summary.status === "passed"
      && summary.reportDate === expectedDay
      && summary.rolloutWindowFirstDay === firstDay
      && summary.input === "live_ops_daemon_day"
      && summary.mode === expectedMode
      && summary.dryRun === false
      && summary.liveOrderCapable === true
      && summary.startedAt === expectedWindow.startedAt
      && summary.finishedAt === expectedWindow.finishedAt
      && boundaries?.startedAt === expectedWindow.startedAt
      && boundaries?.finishedAt === expectedWindow.finishedAt
      && JSON.stringify(summary.runtimeProvenance) === JSON.stringify(runtimeProvenance)
      && isSameCloseoutBuildProvenance(summary.closeoutProvenance, closeoutProvenance);
    if (!reusable) {
      // 주간 손실에는 같은 rollout의 연속된 선행 일자만 포함해 과거 실행 artifact가 섞이지 않게 한다.
      throw new Error(`이전 day artifact가 현재 rollout window/provenance와 다릅니다: ${file}`);
    }
    const value = summary.metrics?.dailyRealizedLossKrw;
    if (!isDecimalString(value) || new Decimal(value).isNegative()) {
      throw new Error(`이전 day artifact의 daily realized loss가 없습니다: ${file}`);
    }
    losses.push(value);
  }
  return losses;
}

async function writeProductionDayArtifact({ artifactDir, day, summary, allowRepositoryPath }) {
  if (!allowRepositoryPath) {
    await assertArtifactDirOutsideRepository(artifactDir);
  }
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  if (!allowRepositoryPath) {
    await assertArtifactDirOutsideRepository(artifactDir);
  }
  const filePath = path.join(artifactDir, `production-day-${day}.json`);
  await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function readExistingPassedArtifact({
  artifactDir,
  day,
  firstDay,
  window,
  runtimeProvenance,
  closeoutProvenance,
  daemonBoundaries,
}) {
  const filePath = path.join(artifactDir, `production-day-${day}.json`);
  try {
    await access(filePath);
  } catch {
    return undefined;
  }
  const summary = await readJson(filePath);
  const reusable = isReusableProductionDayArtifact({
    summary,
    day,
    firstDay,
    window,
    runtimeProvenance,
    closeoutProvenance,
    daemonBoundaries,
  });
  if (!reusable) {
    // 기존 파일을 덮어쓰지 않고 현재 rollout provenance와 다른 artifact를 운영자가 분리하도록 차단한다.
    throw new Error(`기존 production day artifact가 현재 rollout/KST boundary와 일치하지 않습니다: ${filePath}`);
  }
  return summary;
}

/** 현재 rollout과 KST counter boundary가 같은 passed day artifact인지 판정한다. 외부 side effect는 없다. */
export function isReusableProductionDayArtifact({
  summary,
  day,
  firstDay,
  window,
  runtimeProvenance,
  closeoutProvenance,
  daemonBoundaries,
}) {
  return summary.status === "passed"
    && summary.reportDate === day
    && summary.rolloutWindowFirstDay === firstDay
    && summary.input === "live_ops_daemon_day"
    && summary.mode === expectedMode
    && summary.dryRun === false
    && summary.liveOrderCapable === true
    && summary.startedAt === window.startedAt
    && summary.finishedAt === window.finishedAt
    && JSON.stringify(summary.runtimeProvenance) === JSON.stringify(runtimeProvenance)
    && isSameCloseoutBuildProvenance(summary.closeoutProvenance, closeoutProvenance)
    && JSON.stringify(summary.checks?.heartbeat?.evidence?.daemonCounterBoundaries) === JSON.stringify(daemonBoundaries);
}

/** 동일 source와 동일 dist를 다시 build한 경우 생성 시각만으로 rollout 연속성을 끊지 않는다. */
function isSameCloseoutBuildProvenance(actual, expected) {
  return actual?.schemaVersion === 1
    && expected?.schemaVersion === 1
    && actual.kind === "seemirai_typescript_build"
    && expected.kind === "seemirai_typescript_build"
    && actual.sourceCommitSha === expected.sourceCommitSha
    && actual.sourceTreeFingerprint === expected.sourceTreeFingerprint
    && actual.distTreeFingerprint === expected.distTreeFingerprint;
}

async function writeFailureArtifact({ artifactDir, day, error }) {
  await assertArtifactDirOutsideRepository(artifactDir);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await assertArtifactDirOutsideRepository(artifactDir);
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const safeDay = dayPattern.test(String(day)) ? day : "invalid-day";
  const filePath = path.join(artifactDir, `production-day-${safeDay}-failure-${stamp}-${randomUUID()}.json`);
  const payload = {
    schemaVersion: 1,
    issue: 267,
    status: "failed",
    input: "live_ops_daemon_day",
    reportDate: day,
    failedAt: new Date().toISOString(),
    error: safeErrorName(error),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function assertArtifactDirOutsideRepository(artifactDir) {
  await assertProjectedPathOutsideRepository(
    artifactDir,
    "actual production day artifact는 저장소 밖 디렉터리에만 기록할 수 있습니다.",
    "actual production day artifact는 저장소 밖 실제 경로에만 기록할 수 있습니다.",
  );
}

/** actual closeout의 secret/evidence 입력이 checkout 또는 checkout을 가리키는 symlink에 놓이지 않았는지 검증한다. */
export async function assertActualInputPathsOutsideRepository(options) {
  const inputPaths = [
    options.configPath,
    options.envFilePath,
    options.statusFilePath,
    options.startupArtifactFilePath,
    options.pidFilePath,
    options.schedulerEventLogFilePath,
  ];
  await Promise.all(inputPaths.map((filePath) => assertProjectedPathOutsideRepository(
    filePath,
    "actual production day closeout 입력은 저장소 밖 경로만 사용할 수 있습니다.",
    "actual production day closeout 입력은 저장소 밖 실제 경로만 사용할 수 있습니다.",
  )));
}

async function assertProjectedPathOutsideRepository(filePath, lexicalMessage, realPathMessage) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(lexicalMessage);
  }
  const [realRepositoryRoot, projectedPath] = await Promise.all([
    realpath(repositoryRoot),
    resolveProjectedRealPath(resolved),
  ]);
  const realRelative = path.relative(realRepositoryRoot, projectedPath);
  if (realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative))) {
    // 저장소 밖 symlink가 저장소 안을 가리키는 경우에도 private 운영 입력이나 artifact를 허용하지 않는다.
    throw new Error(realPathMessage);
  }
}

/** 아직 생성되지 않은 파일도 가장 가까운 기존 부모의 realpath를 기준으로 실제 목표 경로를 계산한다. */
export async function resolveProjectedRealPath(filePath) {
  const resolvedPath = path.resolve(filePath);
  let existingAncestor = resolvedPath;
  while (true) {
    try {
      const realExistingAncestor = await realpath(existingAncestor);
      return path.resolve(realExistingAncestor, path.relative(existingAncestor, resolvedPath));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      existingAncestor = parent;
    }
  }
}

function assertActualOptions(options) {
  const required = [
    ["--day", options.day],
    ["--config", options.configPath],
    ["--env-file", options.envFilePath],
    ["--status-file", options.statusFilePath],
    ["--startup-artifact-file", options.startupArtifactFilePath],
    ["--pid-file", options.pidFilePath],
    ["--scheduler-event-log-file", options.schedulerEventLogFilePath],
    ["--first-day", options.firstDay],
    ["--artifact-dir", options.artifactDir],
    ["--expected-source-commit-sha", options.expectedSourceCommitSha],
    ["--closeout-source-commit-sha", options.closeoutSourceCommitSha],
  ];
  const missing = required.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`필수 인자가 없습니다: ${missing.join(", ")}`);
  }
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

function createZeroCounters(tickCount) {
  return {
    tickCount,
    successCount: tickCount,
    holdCount: tickCount,
    blockCount: 0,
    manualReviewCount: 0,
    transientFailureCount: 0,
    submittedOrderCount: 0,
    exitRequoteCount: 0,
    duplicateOrderCount: 0,
    reconcileMismatchCount: 0,
    untrackedFillCount: 0,
    liveOrderCleanupFailureCount: 0,
    crashCount: 0,
    unhandledRejectionCount: 0,
    manualReviewSources: [],
  };
}

function expectedConfigSafetyEvidence() {
  return {
    enabled: true,
    allowedMarkets: ["KRW-BTC"],
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    maxOpenPositionNotionalKrw: "30000",
  };
}

function formatDecisionLabel(value) {
  switch (String(value ?? "").toUpperCase()) {
    case "BUY":
      return "매수 판단";
    case "SELL":
      return "매도 판단";
    case "HOLD":
      return "보유 유지 판단";
    case "BLOCK":
      return "위험 조건으로 주문 차단";
    default:
      return "최근 판단 확인 필요";
  }
}

function okCheck(evidence) {
  return { status: "ok", evidence };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function toIsoOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isDecimalString(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

function readNonNegativeSafeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} daemon counter가 0 이상의 안전한 정수가 아닙니다.`);
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function readArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
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

function formatProductionDayCloseoutHelp() {
  return `Usage: node scripts/run-m23-production-day-closeout.mjs [options]

  --day <YYYY-MM-DD>                 완료된 KST 기준일
  --config <path>                    production live ops config
  --env-file <path>                  production live ops env
  --status-file <path>               daemon latest status
  --startup-artifact-file <path>     현재 daemon create-only startup artifact
  --pid-file <path>                  daemon supervisor PID file
  --scheduler-event-log-file <path>  KST 경계 daemon counter append-only event log
  --first-day <YYYY-MM-DD>           현재 7일 rollout의 첫 completed KST 기준일
  --artifact-dir <path>              저장소 밖 production day artifact 디렉터리
  --expected-source-commit-sha <sha>  rollout daemon source SHA
  --closeout-source-commit-sha <sha>  현재 closeout checkout/build source SHA
  --fixture-smoke                     외부 provider 없이 contract fixture 실행
  --json                              pretty JSON 출력
`;
}
