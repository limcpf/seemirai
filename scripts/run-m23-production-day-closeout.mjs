#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import pg from "pg";

const { Pool: PgPool } = pg;
const runGuardEnv = "SEEMIRAI_RUN_M23_PRODUCTION_DAY_CLOSEOUT";
const expectedMode = "LIVE_AUTONOMOUS_SMALL_BUDGET";
const expectedSourceShaPattern = /^[a-f0-9]{40}$/u;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const oneDayMs = 86_400_000;
const kstOffsetMs = 9 * 60 * 60 * 1_000;
const maxHeartbeatLagMs = 2 * 60 * 1_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    artifactDir: undefined,
    expectedSourceCommitSha: undefined,
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
      case "--artifact-dir":
        options.artifactDir = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--expected-source-commit-sha":
        options.expectedSourceCommitSha = readArgValue(argv, index, arg).toLowerCase();
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
  return createProductionDaySummary({
    day,
    window,
    generatedAt: generated,
    runtimeProvenance: provenance,
    configSafety: expectedConfigSafetyEvidence(),
    daemon: {
      processId: 12345,
      startedAt: "2026-07-13T20:12:29.954Z",
      latestTickStartedAt: new Date(window.endMs + 500).toISOString(),
      counters: createZeroCounters(1_440),
    },
    database: {
      migrationVersion: 14,
      killSwitchState: "NORMAL",
      decisionCount: 1_440,
      actionableDecisionCount: 0,
      distinctDedupeCount: 1_440,
      firstDecisionAt: new Date(window.startMs + 1_000).toISOString(),
      latestDecisionAt: new Date(window.endMs - 1_000).toISOString(),
      orderSubmittedCount: 0,
      brokerSubmissionCount: 0,
      fillCount: 0,
      riskGateBypassCount: 0,
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
  const generatedAt = options.clock();
  const window = createKstDayWindow(options.day);
  if (generatedAt.getTime() < window.endMs) {
    throw new Error(`${options.day} KST day가 아직 종료되지 않았습니다.`);
  }
  await assertArtifactDirOutsideRepository(options.artifactDir);
  const existing = await readExistingPassedArtifact(options.artifactDir, options.day);
  if (existing !== undefined) {
    return existing;
  }

  const [configRaw, envRaw, status, startup, pidText] = await Promise.all([
    readJson(options.configPath),
    readFile(options.envFilePath, "utf8"),
    readJson(options.statusFilePath),
    readJson(options.startupArtifactFilePath),
    readFile(options.pidFilePath, "utf8"),
  ]);
  const runtimeModule = await import("../dist/runtime/index.js");
  const infrastructureModule = await import("../dist/infrastructure/index.js");
  const applicationModule = await import("../dist/application/index.js");
  const envParsed = runtimeModule.parseLiveOpsEnvFileContent(envRaw);
  if (envParsed.errors.length > 0) {
    throw new Error(`env file 형식 오류가 있습니다: ${envParsed.errors.join("; ")}`);
  }
  const config = runtimeModule.loadLiveOpsConfig(configRaw);
  const secrets = runtimeModule.loadLiveOpsSecretsFromEnv(envParsed.values);
  const supervisorPid = Number(pidText.trim());
  assertProcessRunning(supervisorPid);
  const provenance = assertRuntimeProvenance({
    expectedSourceCommitSha: options.expectedSourceCommitSha,
    status,
    startup,
    startupArtifactFilePath: options.startupArtifactFilePath,
  });
  const configSafety = assertConfigSafety(config);
  assertDaemonWindow({ status, window, generatedAt });

  const pool = new PgPool({
    connectionString: secrets.databaseUrl,
    application_name: "seemirai-m23-production-day-closeout",
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  const database = infrastructureModule.createDatabase(pool);
  try {
    const [databaseEvidence, privateRead, reportBuilt] = await Promise.all([
      readDatabaseEvidence(pool, window),
      readPrivateExchangeEvidence({
        infrastructureModule,
        secrets,
        referencePrice: status.latestSummary?.marketData?.referencePrice,
        observedAt: generatedAt,
      }),
      applicationModule.buildDailyReportNotification({
        reportDate: options.day,
        dataProvider: new infrastructureModule.PostgresDailyReportRepository(database),
        generatedAt,
      }),
    ]);
    assertActualPreconditions({
      status,
      provenance,
      databaseEvidence,
      privateRead,
      report: reportBuilt.report,
    });

    const dailyReportRuntime = runtimeModule.createPaperNoKeyDailyReportRuntime({
      database,
      notifier: infrastructureModule.createTelegramNotifier({
        botToken: secrets.telegramBotToken,
        chatId: secrets.telegramChatId,
      }),
      workerId: `issue_267_day_closeout_${options.day}`,
      actor: "codex-issue-267-day-closeout",
    });
    const reportRun = await dailyReportRuntime.runManualDailyReport({
      reportDate: options.day,
      correlationId: `issue-267-production-day-${options.day}-${randomUUID()}`,
    });
    const dailyReportEvidence = await readDailyReportEvidence(pool, options.day, reportRun, reportBuilt.report);
    if (dailyReportEvidence.status !== "DELIVERED") {
      throw new Error(`daily report가 owner chat 전달로 닫히지 않았습니다: ${dailyReportEvidence.status}`);
    }
    if (dailyReportEvidence.generatedAuditEventId === null || dailyReportEvidence.deliveryAuditEventIds.length < 1) {
      // Telegram side effect만 성공하고 durable audit이 빠진 상태를 actual closeout 증거로 승격하지 않는다.
      throw new Error("daily report 생성/전달 durable audit evidence가 완전하지 않습니다.");
    }

    const dailyLoss = resolveDailyRealizedLoss(reportBuilt.report);
    const previousLosses = await readPreviousProductionDayLosses(options.artifactDir, options.day);
    const weeklyRealizedLossKrw = previousLosses
      .reduce((total, value) => total.plus(value), new Decimal(dailyLoss.value))
      .toFixed();
    const summary = createProductionDaySummary({
      day: options.day,
      window,
      generatedAt,
      runtimeProvenance: provenance,
      configSafety,
      daemon: {
        processId: supervisorPid,
        startedAt: status.startedAt,
        latestTickStartedAt: status.latestTickStartedAt,
        counters: status.counters,
      },
      database: databaseEvidence,
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
    await database.destroy().catch(() => undefined);
  }
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
    distinctDedupeCount: input.database.distinctDedupeCount,
  });
  const counters = input.daemon.counters;
  return {
    schemaVersion: 1,
    issue: 267,
    status: "passed",
    input: "live_ops_daemon_day",
    mode: expectedMode,
    dryRun: false,
    liveOrderCapable: true,
    startedAt: input.window.startedAt,
    finishedAt: input.generatedAt.toISOString(),
    reportDate: input.day,
    dailyReportGeneratedAt: input.generatedAt.toISOString(),
    decisionEvidenceDay: input.day,
    decisionEvidenceGeneratedAt: input.generatedAt.toISOString(),
    runtimeProvenance: input.runtimeProvenance,
    evidenceIds: {
      decisionEvidenceId: `live-decisions:${input.day}:sha256:${decisionFingerprint}`,
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
        decisionCount: input.database.decisionCount,
        firstDecisionAt: input.database.firstDecisionAt,
        latestDecisionAt: input.database.latestDecisionAt,
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

async function readDatabaseEvidence(pool, window) {
  const result = await pool.query(
    `select
       (select max(version)::int from schema_migrations) as migration_version,
       (select state from kill_switch_state where scope = 'global') as kill_switch_state,
       (select count(*)::int from live_decision_ticks where observed_at >= $1 and observed_at < $2) as decision_count,
       (select count(*)::int from live_decision_ticks where observed_at >= $1 and observed_at < $2 and order_intent_count > 0) as actionable_decision_count,
       (select count(distinct dedupe_key)::int from live_decision_ticks where observed_at >= $1 and observed_at < $2) as distinct_dedupe_count,
       (select min(observed_at) from live_decision_ticks where observed_at >= $1 and observed_at < $2) as first_decision_at,
       (select max(observed_at) from live_decision_ticks where observed_at >= $1 and observed_at < $2) as latest_decision_at,
       (select count(*)::int from orders where created_at >= $1 and created_at < $2) as order_submitted_count,
       (select count(*)::int from orders where created_at >= $1 and created_at < $2) as broker_submission_count,
       (select count(*)::int from fills where filled_at >= $1 and filled_at < $2) as fill_count,
       (select count(*)::int from orders
          where created_at >= $1 and created_at < $2
            and (
              reason_json->'risk_approval'->>'source' = 'risk_gate'
              and reason_json->'risk_approval'->>'approved' = 'true'
              and reason_json->'risk_approval'->>'action' = 'ALLOW'
            ) is not true) as risk_gate_bypass_count`,
    [window.startedAt, window.finishedAt],
  );
  const row = result.rows[0];
  return {
    migrationVersion: Number(row.migration_version),
    killSwitchState: row.kill_switch_state,
    decisionCount: Number(row.decision_count),
    actionableDecisionCount: Number(row.actionable_decision_count),
    distinctDedupeCount: Number(row.distinct_dedupe_count),
    firstDecisionAt: toIsoOrNull(row.first_decision_at),
    latestDecisionAt: toIsoOrNull(row.latest_decision_at),
    orderSubmittedCount: Number(row.order_submitted_count),
    brokerSubmissionCount: Number(row.broker_submission_count),
    fillCount: Number(row.fill_count),
    riskGateBypassCount: Number(row.risk_gate_bypass_count),
  };
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

async function readDailyReportEvidence(pool, day, reportRun, report) {
  const audit = await pool.query(
    `select id, payload_json->>'reason_code' as reason_code, occurred_at
       from audit_events
      where payload_json->>'report_date' = $1
        and payload_json->>'reason_code' in ('daily_report_generated', 'daily_report_notification_delivered', 'daily_report_notification_failed')
      order by occurred_at asc`,
    [day],
  );
  const generated = audit.rows.filter((row) => row.reason_code === "daily_report_generated");
  const delivered = audit.rows.filter((row) => row.reason_code === "daily_report_notification_delivered");
  const status = delivered.length > 0
    ? "DELIVERED"
    : reportRun.claimed?.result?.status ?? (reportRun.status === "SKIPPED_EXISTING_JOB" ? "COMPLETED_WITHOUT_DELIVERY" : reportRun.status);
  return {
    status,
    runtimeStatus: reportRun.status,
    generatedAuditEventId: generated.at(-1)?.id ?? null,
    deliveryAuditEventIds: delivered.map((row) => row.id),
    report: {
      orderCount: report.orderCount,
      fillCount: report.fillCount,
      realizedPnl: report.realizedPnl,
    },
  };
}

function assertActualPreconditions({ status, provenance, databaseEvidence, privateRead, report }) {
  if (provenance.expectedMigrationVersion !== 14 || provenance.appliedMigrationVersion !== 14 || databaseEvidence.migrationVersion !== 14) {
    throw new Error("migration 14 provenance가 일치하지 않습니다.");
  }
  if (databaseEvidence.killSwitchState !== "NORMAL") {
    throw new Error(`kill switch가 NORMAL이 아닙니다: ${databaseEvidence.killSwitchState}`);
  }
  if (databaseEvidence.decisionCount < 1 || databaseEvidence.firstDecisionAt === null || databaseEvidence.latestDecisionAt === null) {
    throw new Error("해당 KST day의 durable decision evidence가 없습니다.");
  }
  if (databaseEvidence.riskGateBypassCount !== 0) {
    throw new Error(`risk gate approval evidence가 없는 주문이 있습니다: ${databaseEvidence.riskGateBypassCount}`);
  }
  if (privateRead.openOrderCount !== 0 || !new Decimal(privateRead.openPositionNotionalKrw).isZero()) {
    throw new Error("day closeout 시점에 private open order 또는 position exposure가 남아 있습니다.");
  }
  for (const counterName of zeroCounterNames) {
    if (status.counters?.[counterName] !== 0) {
      throw new Error(`${counterName}가 0이 아닙니다: ${status.counters?.[counterName]}`);
    }
  }
  if (report.fillCount !== databaseEvidence.fillCount) {
    throw new Error("daily report fill count와 day DB aggregate가 일치하지 않습니다.");
  }
  if (report.orderCount !== databaseEvidence.orderSubmittedCount) {
    throw new Error("daily report order count와 day DB aggregate가 일치하지 않습니다.");
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

function resolveDailyRealizedLoss(report) {
  const metric = report.realizedPnl;
  if (metric.available && isDecimalString(metric.value) && metric.sampleCount > 0) {
    return {
      value: Decimal.max(new Decimal(metric.value).negated(), 0).toFixed(),
      evidenceCount: metric.sampleCount,
    };
  }
  if (report.fillCount === 0 && report.orderCount === 0) {
    // 주문과 체결이 모두 0이면 손실 0은 임의 보정이 아니라 해당 day DB aggregate의 부재 증거에서 나온다.
    return { value: "0", evidenceCount: 1 };
  }
  throw new Error("주문/체결이 있는데 realized PnL evidence를 읽지 못했습니다.");
}

async function readPreviousProductionDayLosses(artifactDir, day) {
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const files = await readdir(artifactDir);
  const previous = files
    .filter((file) => /^production-day-\d{4}-\d{2}-\d{2}\.json$/u.test(file))
    .filter((file) => file.slice("production-day-".length, -".json".length) < day)
    .toSorted();
  const losses = [];
  for (const file of previous) {
    const summary = await readJson(path.join(artifactDir, file));
    const value = summary.metrics?.dailyRealizedLossKrw;
    if (!isDecimalString(value)) {
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
  const filePath = path.join(artifactDir, `production-day-${day}.json`);
  await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function readExistingPassedArtifact(artifactDir, day) {
  const filePath = path.join(artifactDir, `production-day-${day}.json`);
  try {
    await access(filePath);
  } catch {
    return undefined;
  }
  const summary = await readJson(filePath);
  if (summary.status !== "passed" || summary.reportDate !== day) {
    throw new Error(`기존 production day artifact가 passed 상태가 아닙니다: ${filePath}`);
  }
  return summary;
}

async function writeFailureArtifact({ artifactDir, day, error }) {
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const filePath = path.join(artifactDir, `production-day-${day}-failure-${stamp}.json`);
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

async function assertArtifactDirOutsideRepository(artifactDir) {
  const resolved = path.resolve(artifactDir);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("actual production day artifact는 저장소 밖 디렉터리에만 기록할 수 있습니다.");
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
    ["--artifact-dir", options.artifactDir],
    ["--expected-source-commit-sha", options.expectedSourceCommitSha],
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

function okCheck(evidence) {
  return { status: "ok", evidence };
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  --artifact-dir <path>              저장소 밖 production day artifact 디렉터리
  --expected-source-commit-sha <sha>  rollout daemon source SHA
  --fixture-smoke                     외부 provider 없이 contract fixture 실행
  --json                              pretty JSON 출력
`;
}
