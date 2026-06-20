import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Decimal } from "decimal.js";
import pg from "pg";
import { createLiveOpsPnlCloseoutRunner } from "./run-live-ops-pnl-closeout-support.mjs";

const { Pool: PgPool } = pg;
const migrationFilePattern = /^(\d{6})_[a-z0-9_]+\.sql$/u;
const defaultMigrationsDirectory = path.resolve("migrations");
const dbReadinessConnectionTimeoutMs = 5000;
const liveOpsUpbitWebSocketUrl = "wss://api.upbit.com/websocket/v1";
const liveOpsUpbitPrivateApiBaseUrl = "https://api.upbit.com";
const liveOpsMarketDataConsumerId = "live-ops-market-data";
const liveOpsCliAnalysisOrderIntentsSymbol = Symbol("liveOpsCliAnalysisOrderIntents");
const liveOpsCliRepositoryRoot = path.resolve(".");
const liveOpsCliUpbitIdentifierMaxLength = 32;
const liveOpsCliCleanupCancelPollCount = 5;
const liveOpsCliCleanupCancelPollIntervalMs = 1000;
const liveOpsCliDailyReservationLockLeaseMs = 5 * 60 * 1000;
const liveOpsCliPreflightReconcileFreshnessMs = 30_000;
const liveOpsCliPreflightPnlFreshnessMs = 30_000;
const liveOpsCliPreflightPnlFutureSkewMs = 1_000;
const liveOpsCliProcessOwner = createLiveOpsCliProcessOwnerSnapshot(process.pid);
const liveOpsCliAutonomous24x7StrategyId = "live_ops_autonomous_24x7_core";
const liveOpsWorkerLabels = {
  db_readiness: "DB readiness",
  market_data: "시세 수집",
  analysis_decision: "분석/판단",
  live_execution: "실주문 실행",
  reconcile_pnl_status: "Reconcile/PnL/status",
  telegram: "Telegram 알림",
  tui: "TUI 콘솔",
};

export const liveOpsLegacyEnvNames = [
  "SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT",
  "SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON",
  "SEEMIRAI_PILOT_PROFILE",
  "PILOT_ORDER_SMOKE",
];

const liveOpsConfigAllowedKeys = {
  $: [
    "schema_version",
    "mode",
    "exchange",
    "market",
    "live_trading_enabled",
    "paper_no_key",
    "withdrawal_enabled",
    "cross_exchange_arbitrage_enabled",
    "futures_enabled",
    "leverage_enabled",
    "market_order_enabled",
    "entry_market_order_enabled",
    "universe",
    "budget",
    "workers",
    "market_data",
    "analysis",
    "telegram",
    "tui",
  ],
  universe: ["markets", "default_market"],
  budget: [
    "max_order_krw",
    "daily_autonomous_notional_limit_krw",
    "max_open_position_notional_krw",
    "operations_stop_ceiling_krw",
  ],
  workers: ["db_readiness", "market_data", "analysis_decision", "live_execution", "reconcile_pnl_status", "telegram", "tui"],
  market_data: ["provider", "websocket_enabled", "rest_policy_snapshot_enabled", "stale_after_ms"],
  analysis: ["candle_interval_seconds", "feature_interval_seconds", "decision_interval_seconds", "record_hold_decision", "decision_policy"],
  analysis_decision_policy: ["id", "cleanup_probe", "autonomous_24x7"],
  analysis_decision_policy_cleanup_probe: [
    "max_notional_krw",
    "tick_size_krw",
    "price_offset_ticks",
    "quantity_scale",
    "expected_loss_bps_of_equity",
  ],
  analysis_decision_policy_autonomous_24x7: [
    "max_entry_notional_krw",
    "tick_size_krw",
    "entry_price_offset_ticks",
    "exit_price_offset_ticks",
    "quantity_scale",
    "min_entry_margin_bps",
    "trend_confirmation_bps",
    "mean_reversion_discount_bps",
    "take_profit_bps",
    "stop_loss_bps",
    "trailing_stop_bps",
    "max_holding_ms",
    "risk_reduction_open_notional_krw",
    "risk_reduction_sell_fraction",
    "expected_loss_bps_of_equity",
  ],
  telegram: ["startup_alert_enabled", "live_order_capable_alert_enabled", "trade_event_alerts_enabled", "provider_timeout_ms"],
  tui: ["foreground_enabled", "attach_enabled", "refresh_interval_ms", "control_requires_two_step_confirmation", "controls_enabled"],
};

export function parseArgs(argv) {
  const options = {
    configPath: undefined,
    envFilePath: undefined,
    attach: undefined,
    tui: false,
    fixtureSmoke: false,
    durationMs: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--config":
        options.configPath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--env-file":
        options.envFilePath = readValue(argv, index, arg);
        index += 1;
        break;
      case "--attach":
        options.attach = readValue(argv, index, arg);
        index += 1;
        break;
      case "--duration-ms":
        options.durationMs = Number(readValue(argv, index, arg));
        index += 1;
        break;
      case "--tui":
        options.tui = true;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
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

export async function loadLiveOpsCliInputs(options) {
  if (options.configPath === undefined) {
    throw new Error("--config 경로가 필요합니다.");
  }
  if (options.envFilePath === undefined) {
    throw new Error("--env-file 경로가 필요합니다.");
  }

  const configPath = path.resolve(options.configPath);
  const envFilePath = path.resolve(options.envFilePath);
  let config = JSON.parse(await readFile(configPath, "utf8"));
  const env = parseEnvFile(await readFile(envFilePath, "utf8"));
  validateLiveOpsConfig(config);
  validateLiveOpsEnv(env, process.env);
  if (options.suppressStartupTelegramAlert === true) {
    config = suppressLiveOpsCliStartupTelegramAlert(config);
  }
  if (options.attach !== undefined && options.attachReadonly !== true) {
    throw new Error("--attach는 live:ops:tui 명령에서만 사용할 수 있습니다.");
  }
  if (!options.fixtureSmoke && options.attach !== undefined) {
    // attach TUI는 기존 실행 상태를 읽는 화면이므로 production provider/broker lifecycle을 새로 열지 않는다.
    return loadLiveOpsCliAttachReadonlyInputs({
      configPath,
      envFilePath,
      config,
      env,
      attach: options.attach,
    });
  }
  const dbReadiness = await evaluateLiveOpsCliDbReadiness({
    databaseUrl: env.SEEMIRAI_DATABASE_URL,
    fixtureSmoke: options.fixtureSmoke,
  });
  if (!dbReadiness.ready) {
    throw new Error(formatCliDbReadinessFailureMessage(dbReadiness));
  }

  const marketData = await evaluateLiveOpsCliMarketData({
    config,
    fixtureSmoke: options.fixtureSmoke,
    databaseUrl: env.SEEMIRAI_DATABASE_URL,
  });
  assertLiveOpsCliMarketDataReady(marketData, { fixtureSmoke: options.fixtureSmoke });

  const productionBrokerGuard = evaluateLiveOpsCliBrokerGuard({
    config,
    env,
    fixtureSmoke: options.fixtureSmoke,
  });
  let productionRuntime;
  try {
    // broker guard가 막힌 key는 private read와 broker runtime 생성 전 단계에서 닫아 side effect 없는 계좌 조회도 열지 않는다.
    productionRuntime = options.fixtureSmoke || !productionBrokerGuard.ready
      ? undefined
      : await createLiveOpsCliProductionRuntime({
          configPath,
          config,
          env,
          market: config.universe?.default_market ?? "KRW-BTC",
          fetchImpl: options.fetchImpl,
          artifactDir: options.artifactDir,
          clock: options.clock,
          cancelPollCount: options.cancelPollCount,
          cancelPollIntervalMs: options.cancelPollIntervalMs,
        });
    const autonomousAnalysisPreflight = await collectLiveOpsCliAutonomousAnalysisPreflight({
      config,
      fixtureSmoke: options.fixtureSmoke,
      marketData,
      productionRuntime,
    });
    const analysisDecision = await evaluateLiveOpsCliAnalysisDecision({
      config,
      fixtureSmoke: options.fixtureSmoke,
      marketData,
      productionPreflight: autonomousAnalysisPreflight?.preflight,
      productionPreflightError: autonomousAnalysisPreflight?.error,
    });
    const productionExecutionInputs = await createLiveOpsCliProductionExecutionInputs({
      config,
      env,
      fixtureSmoke: options.fixtureSmoke,
      analysisDecision,
      marketData,
      orderIntents: getLiveOpsCliAnalysisOrderIntents(analysisDecision),
      productionRuntime,
      preflight: autonomousAnalysisPreflight?.preflight,
    });
    const liveExecution = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: options.fixtureSmoke,
      analysisDecision,
      marketData,
      env,
      orderIntents: productionExecutionInputs.orderIntents,
      entryRuntime: productionExecutionInputs.entryRuntime,
      exitRuntime: productionExecutionInputs.exitRuntime,
      executionStatus: productionExecutionInputs.executionStatus,
      postSubmitReadiness: productionExecutionInputs.postSubmitReadiness,
      budgetSnapshot: productionExecutionInputs.budgetSnapshot,
      lossSnapshot: productionExecutionInputs.lossSnapshot,
      cleanupLifecycle: productionExecutionInputs.cleanupLifecycle,
    });
    const reconcilePnlStatus = await evaluateLiveOpsCliReconcilePnlStatus({
      config,
      fixtureSmoke: options.fixtureSmoke,
      liveExecution,
      privateReadProvider: productionRuntime?.privateReadProvider,
      reconcileStatusProvider: productionRuntime?.reconcileStatusProvider,
      pnlStatusProvider: productionRuntime?.pnlStatusProvider,
      budgetSnapshot: productionExecutionInputs.budgetSnapshot,
    });
    const telegramAlert = await evaluateLiveOpsCliTelegramAlert({
      config,
      fixtureSmoke: options.fixtureSmoke,
      liveExecution,
      orderIntent: productionExecutionInputs.orderIntents[0],
      telegramDispatcher: productionRuntime?.telegramDispatcher,
    });

    return {
      configPath,
      envFilePath,
      config,
      env,
      dbReadiness,
      marketData,
      analysisDecision,
      liveExecution,
      reconcilePnlStatus,
      telegramAlert,
    };
  } finally {
    await productionRuntime?.close?.();
  }
}

function suppressLiveOpsCliStartupTelegramAlert(config) {
  return {
    ...config,
    telegram: {
      ...(config.telegram ?? {}),
      startup_alert_enabled: false,
    },
  };
}

async function loadLiveOpsCliAttachReadonlyInputs({ configPath, envFilePath, config, env, attach }) {
  const statusSourcePath = path.resolve(String(attach));
  let source;
  try {
    source = JSON.parse(await readFile(statusSourcePath, "utf8"));
  } catch (error) {
    throw new Error(`attach status source를 읽지 못해 TUI attach를 중단합니다: ${safeErrorName(error)}`);
  }
  const summary = createLiveOpsCliAttachSummary(source);
  assertLiveOpsCliAttachStatusSource(summary);
  return {
    configPath,
    envFilePath,
    config,
    env,
    dbReadiness: summary.dbReadiness,
    marketData: summary.marketData,
    analysisDecision: summary.analysisDecision,
    // attach 화면은 새 주문 side effect만 닫고, 원본 foreground 실행의 실주문 가능 상태 표시는 보존해야 한다.
    liveExecution: summary.liveExecution,
    reconcilePnlStatus: summary.reconcilePnlStatus,
    telegramAlert: summary.telegramAlert,
    attachStatusSourcePath: statusSourcePath,
  };
}

function createLiveOpsCliAttachSummary(source) {
  const summary = source?.summary ?? source?.latestSummary ?? source;
  if (
    source?.kind !== "live_ops_daemon_summary" ||
    source?.status !== "transient_failure" ||
    !isNonEmptyRecord(source?.latestSummary)
  ) {
    return summary;
  }

  const latestError = source.latestError ?? {};
  const observedAt = hasMeaningfulValue(latestError?.observedAt)
    ? String(latestError.observedAt)
    : new Date().toISOString();
  const errorName = hasMeaningfulValue(latestError?.name) ? String(latestError.name) : safeErrorName(latestError);
  return {
    ...summary,
    liveExecution: {
      ...(summary.liveExecution ?? {}),
      status: "daemon_transient_failure",
      ready: false,
      liveOrderCapable: false,
      latestExecutionAt: observedAt,
      observedAt,
      statusLabel: "daemon 일시 실패",
      message: "daemon tick이 실패해 attach 화면이 stale ready 상태를 실주문 가능 상태로 표시하지 않습니다.",
      action: "daemon status file의 latestError와 최근 로그를 확인한 뒤 실패 원인을 복구하세요.",
      checks: [
        ...(Array.isArray(summary.liveExecution?.checks) ? summary.liveExecution.checks : []),
        blockedLiveExecutionCheck("daemon_status", "daemon 최신 tick이 실패 상태입니다.", "live_ops_daemon_transient_failure", {
          status: source.status,
          errorName,
        }),
      ],
    },
  };
}

function assertLiveOpsCliAttachStatusSource(summary) {
  const missing = [
    "dbReadiness",
    "marketData",
    "analysisDecision",
    "liveExecution",
    "reconcilePnlStatus",
    "telegramAlert",
  ].filter((key) => !isNonEmptyRecord(summary?.[key]));
  if (missing.length > 0) {
    throw new Error(`attach status source에 필요한 summary 항목이 없습니다: ${missing.join(", ")}`);
  }
  if (typeof summary.liveExecution.liveOrderCapable !== "boolean") {
    // 외부 JSON attach source의 문자열/숫자 값을 truthy로 표시하면 실제 foreground 실주문 가능 상태를 왜곡한다.
    throw new Error("attach status source의 liveExecution.liveOrderCapable은 boolean이어야 합니다.");
  }
}

export function renderLiveOpsSummary(input) {
  const attachReadonly = input.attach !== undefined && input.fixtureSmoke !== true;
  const postExecutionReady = input.reconcilePnlStatus.ready === true && input.telegramAlert.ready === true;
  const status = input.dbReadiness.ready && input.marketData.ready && input.analysisDecision.ready && input.liveExecution.ready && postExecutionReady
    ? "ready"
    : "blocked";
  return {
    status,
    message: attachReadonly
      ? "TUI attach가 status source를 읽었습니다. provider, broker, Telegram side effect를 새로 시작하지 않습니다."
      : status === "ready"
      ? (input.fixtureSmoke
        ? "production live ops config/env 계약과 DB readiness를 통과했습니다. fixture smoke는 외부 provider를 호출하지 않습니다."
        : "production live ops config/env, DB readiness, Upbit public market data, analysis/decision, live execution guard를 통과했습니다.")
      : "production live ops boot가 fail-closed 됐습니다. 차단된 readiness 항목을 먼저 복구하세요.",
    configPath: input.configPath,
    envFilePath: input.envFilePath,
    mode: "소액 실운영",
    liveOrderCapable: input.liveExecution.liveOrderCapable,
    tui: input.tui,
    attach: input.attach ?? null,
    fixtureSmoke: input.fixtureSmoke,
    dbReadiness: input.dbReadiness,
    marketData: input.marketData,
    analysisDecision: input.analysisDecision,
    liveExecution: input.liveExecution,
    reconcilePnlStatus: input.reconcilePnlStatus,
    telegramAlert: input.telegramAlert,
    budget: {
      maxOrderKrw: input.config.budget?.max_order_krw ?? null,
      dailyAutonomousNotionalLimitKrw: input.config.budget?.daily_autonomous_notional_limit_krw ?? null,
      maxOpenPositionNotionalKrw: input.config.budget?.max_open_position_notional_krw ?? null,
      operationsStopCeilingKrw: input.config.budget?.operations_stop_ceiling_krw ?? null,
    },
    trace: {
      rawMode: input.config.mode,
      defaultMarket: input.config.universe?.default_market,
      workers: Object.keys(input.config.workers ?? {}).filter((key) => input.config.workers[key] === true),
    },
  };
}

export function assertLiveOpsCliMarketDataReady(summary, { fixtureSmoke }) {
  if (!fixtureSmoke && !summary.ready) {
    throw new Error(formatCliMarketDataFailureMessage(summary));
  }
}

export function assertLiveOpsCliLiveExecutionReady(summary, { fixtureSmoke }) {
  if (!fixtureSmoke && !summary.ready) {
    throw new Error(formatCliLiveExecutionFailureMessage(summary));
  }
}

export function assertLiveOpsCliSummaryReady(summary, { fixtureSmoke }) {
  if (!fixtureSmoke && summary?.status !== "ready") {
    throw new Error(formatCliSummaryFailureMessage(summary));
  }
}

export function renderLiveOpsTuiDashboard(summary) {
  const attachReadonly = summary.attach !== null && summary.fixtureSmoke !== true;
  const dbReadiness = summary.dbReadiness;
  const migration = dbReadiness?.migration ?? {};
  const workerLines = (summary.trace.workers ?? []).map((worker) => {
    const label = liveOpsWorkerLabels[worker] ?? worker;
    const state = worker === "db_readiness"
      ? (dbReadiness?.ready ? "준비" : "차단")
      : worker === "market_data"
        ? (summary.marketData?.ready ? "DB-backed 저장 확인" : "후속 연결 대기")
      : worker === "analysis_decision"
        ? (summary.analysisDecision?.ready ? `${formatDecisionCategory(summary.analysisDecision.decisionCategory)} 기록 확인` : "후속 연결 대기")
      : worker === "live_execution"
        ? (summary.liveExecution?.ready
          ? (summary.liveExecution.status === "idle" ? "후보 없음 - broker 제출 없음" : (summary.liveExecution.statusLabel ?? "실행 결과 확인"))
          : (summary.liveExecution?.statusLabel ?? "후속 연결 대기"))
      : worker === "reconcile_pnl_status"
        ? (summary.reconcilePnlStatus?.ready
          ? (summary.reconcilePnlStatus.providerProbeAttempted ? "private read 상태 요약 확인" : "상태 요약 확인")
          : "후속 연결 대기")
      : worker === "telegram"
        ? (summary.telegramAlert?.ready
          ? (summary.telegramAlert.providerDispatchAttempted ? "owner chat 전송 확인" : "fixture alert plan 확인")
          : "후속 연결 대기")
      : worker === "tui"
        ? "실행 중"
        : "후속 연결 대기";
    return `  - ${label}: ${state}`;
  });

  return [
    "Seemirai Live Ops",
    "운영 dashboard",
    "",
    `상태: ${attachReadonly ? "읽기 전용" : summary.status === "ready" ? "부팅 준비" : "확인 필요"}`,
    `모드: ${summary.mode}`,
    `시장: ${summary.trace.defaultMarket ?? "확인 필요"}`,
    `실주문 가능: ${summary.liveOrderCapable ? "예" : "아니오"}`,
    `실행 형태: ${summary.fixtureSmoke ? "fixture smoke - 외부 DB/provider 호출 없음" : summary.attach === null ? "foreground" : attachReadonly ? "attach - 읽기 전용" : "attach"}`,
    "",
    "Readiness",
    `  - Config/env 계약: 통과`,
    `  - DB readiness: ${dbReadiness?.ready ? "통과" : "차단"}`,
    `  - DB schema: 적용 ${formatSchemaVersion(migration.appliedLatestVersion)} / 기준 ${formatSchemaVersion(migration.expectedLatestVersion)}`,
    `  - Pending migration: ${formatPendingMigrationCount(migration.pendingVersions)}`,
    "",
    "Workers",
    ...workerLines,
    "",
    "예산",
    `  - 1회 주문: ${formatKrwValue(summary.budget.maxOrderKrw)} KRW`,
    `  - 일일 자동 주문: ${formatKrwValue(summary.budget.dailyAutonomousNotionalLimitKrw)} KRW`,
    `  - Open position: ${formatKrwValue(summary.budget.maxOpenPositionNotionalKrw)} KRW`,
    `  - 운영 중지 ceiling: ${formatKrwValue(summary.budget.operationsStopCeilingKrw)} KRW 미만`,
    "",
    "최근 관측",
    `  - Market data: ${formatMarketDataObservation(summary.marketData)}`,
    `  - Analysis/decision: ${formatAnalysisDecisionObservation(summary.analysisDecision)}`,
    `  - Live execution: ${formatLiveExecutionObservation(summary.liveExecution)}`,
    `  - Reconcile/PnL/status: ${formatReconcilePnlStatusObservation(summary.reconcilePnlStatus)}`,
    `  - Telegram alert: ${formatTelegramAlertObservation(summary.telegramAlert)}`,
    "",
    `필요 조치: ${attachReadonly ? "status source의 차단 항목을 확인하세요. attach 화면은 신규 실주문을 제출하지 않습니다." : summary.liveOrderCapable ? "후보 처리 전 예산과 reconcile freshness를 재확인하세요." : "후속 provider 연결 전까지 신규 실주문은 제출되지 않습니다."}`,
    `추적 정보: config=${path.basename(summary.configPath)} attach=${summary.attach ?? "foreground"}`,
  ].join("\n");
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printText(value) {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}

export function printHelp(commandName) {
  process.stdout.write(`${commandName}

Usage:
  corepack pnpm ${commandName} -- --config <path> --env-file <path> [--tui] [--fixture-smoke]

Options:
  --config <path>      Secret 없는 production live ops JSON config
  --env-file <path>    DB/Upbit/Telegram/TUI credential 전용 env file
  --tui                foreground TUI 운영 dashboard render
  --fixture-smoke      외부 DB/provider 호출 없이 config/env/DB readiness contract만 검증
  --attach <id>        live:ops:tui attach 대상
`);
}

function validateLiveOpsConfig(config) {
  const errors = [];
  validateAllowedKeys(errors, config, "$", liveOpsConfigAllowedKeys.$);
  validateAllowedKeys(errors, config.universe, "universe", liveOpsConfigAllowedKeys.universe);
  validateAllowedKeys(errors, config.budget, "budget", liveOpsConfigAllowedKeys.budget);
  validateAllowedKeys(errors, config.workers, "workers", liveOpsConfigAllowedKeys.workers);
  validateAllowedKeys(errors, config.market_data, "market_data", liveOpsConfigAllowedKeys.market_data);
  validateAllowedKeys(errors, config.analysis, "analysis", liveOpsConfigAllowedKeys.analysis);
  validateAllowedKeys(errors, config.analysis?.decision_policy, "analysis.decision_policy", liveOpsConfigAllowedKeys.analysis_decision_policy);
  validateAllowedKeys(
    errors,
    config.analysis?.decision_policy?.cleanup_probe,
    "analysis.decision_policy.cleanup_probe",
    liveOpsConfigAllowedKeys.analysis_decision_policy_cleanup_probe,
  );
  validateAllowedKeys(
    errors,
    config.analysis?.decision_policy?.autonomous_24x7,
    "analysis.decision_policy.autonomous_24x7",
    liveOpsConfigAllowedKeys.analysis_decision_policy_autonomous_24x7,
  );
  validateAllowedKeys(errors, config.telegram, "telegram", liveOpsConfigAllowedKeys.telegram);
  validateAllowedKeys(errors, config.tui, "tui", liveOpsConfigAllowedKeys.tui);
  const secretPaths = findSecretLikeKeys(config);
  if (secretPaths.length > 0) {
    errors.push(`JSON config에 secret-like key가 있습니다: ${secretPaths.join(", ")}`);
  }
  if (config.schema_version !== 1) errors.push("schema_version=1 이 필요합니다.");
  if (config.mode !== "LIVE_AUTONOMOUS_SMALL_BUDGET") errors.push("mode는 LIVE_AUTONOMOUS_SMALL_BUDGET이어야 합니다.");
  if (config.exchange !== "UPBIT") errors.push("exchange는 UPBIT이어야 합니다.");
  if (config.market !== "KRW_SPOT") errors.push("market은 KRW_SPOT이어야 합니다.");
  if (config.live_trading_enabled !== true) errors.push("live_trading_enabled=true production contract가 필요합니다.");
  if (config.paper_no_key !== false) errors.push("paper_no_key=false production contract가 필요합니다.");
  for (const flag of [
    "withdrawal_enabled",
    "cross_exchange_arbitrage_enabled",
    "futures_enabled",
    "leverage_enabled",
    "market_order_enabled",
    "entry_market_order_enabled",
  ]) {
    if (config[flag] !== false) errors.push(`${flag}=false 이어야 합니다.`);
  }
  if (!Array.isArray(config.universe?.markets) || config.universe.markets.length !== 1 || config.universe.markets[0] !== "KRW-BTC") {
    errors.push("첫 production market은 KRW-BTC 단일이어야 합니다.");
  }
  if (config.universe?.default_market !== "KRW-BTC") {
    errors.push("default_market은 KRW-BTC여야 합니다.");
  }
  validateExpectedValues(errors, config.budget, "budget", {
    max_order_krw: "10000",
    daily_autonomous_notional_limit_krw: "30000",
    max_open_position_notional_krw: "30000",
  });
  validateStopCeiling(errors, config.budget);
  validateExpectedValues(errors, config.workers, "workers", {
    db_readiness: true,
    market_data: true,
    analysis_decision: true,
    live_execution: true,
    reconcile_pnl_status: true,
    telegram: true,
    tui: true,
  });
  validateExpectedValues(errors, config.market_data, "market_data", {
    provider: "UPBIT_PUBLIC",
    websocket_enabled: true,
    rest_policy_snapshot_enabled: true,
    stale_after_ms: 30000,
  });
  validateExpectedValues(errors, config.analysis, "analysis", {
    candle_interval_seconds: 60,
    feature_interval_seconds: 5,
    decision_interval_seconds: 5,
    record_hold_decision: true,
  });
  validateLiveOpsDecisionPolicyConfig(errors, config.analysis?.decision_policy);
  validateExpectedValues(errors, config.telegram, "telegram", {
    startup_alert_enabled: true,
    live_order_capable_alert_enabled: true,
    trade_event_alerts_enabled: true,
    provider_timeout_ms: 5000,
  });
  if (config.tui?.foreground_enabled !== true || config.tui?.attach_enabled !== true) {
    errors.push("foreground/attach TUI skeleton은 모두 활성이어야 합니다.");
  }
  validateExpectedValues(errors, config.tui, "tui", {
    refresh_interval_ms: 1000,
    control_requires_two_step_confirmation: true,
    controls_enabled: true,
  });

  if (errors.length > 0) {
    throw new Error(`live ops config 검증 실패: ${errors.join("; ")}`);
  }
}

function validateLiveOpsDecisionPolicyConfig(errors, decisionPolicy) {
  if (decisionPolicy === null || typeof decisionPolicy !== "object" || Array.isArray(decisionPolicy)) {
    errors.push("analysis.decision_policy 설정이 필요합니다.");
    return;
  }

  if (decisionPolicy.id === "cleanup_probe") {
    const cleanupProbe = decisionPolicy.cleanup_probe;
    if (cleanupProbe === null || typeof cleanupProbe !== "object" || Array.isArray(cleanupProbe)) {
      errors.push("analysis.decision_policy.cleanup_probe 설정이 필요합니다.");
      return;
    }

    validateExpectedValues(errors, cleanupProbe, "analysis.decision_policy.cleanup_probe", {
      max_notional_krw: "10000",
      tick_size_krw: "1000",
      price_offset_ticks: 1,
      quantity_scale: 8,
      expected_loss_bps_of_equity: "5",
    });
    return;
  }

  if (decisionPolicy.id === "autonomous_24x7") {
    const autonomous = decisionPolicy.autonomous_24x7;
    if (autonomous === null || typeof autonomous !== "object" || Array.isArray(autonomous)) {
      errors.push("analysis.decision_policy.autonomous_24x7 설정이 필요합니다.");
      return;
    }

    validateExpectedValues(errors, autonomous, "analysis.decision_policy.autonomous_24x7", {
      max_entry_notional_krw: "10000",
      tick_size_krw: "1000",
      entry_price_offset_ticks: 1,
      exit_price_offset_ticks: 1,
      quantity_scale: 8,
      min_entry_margin_bps: "10",
      trend_confirmation_bps: "20",
      mean_reversion_discount_bps: "30",
      take_profit_bps: "120",
      stop_loss_bps: "80",
      trailing_stop_bps: "60",
      max_holding_ms: 86_400_000,
      risk_reduction_open_notional_krw: "25000",
      risk_reduction_sell_fraction: "0.5",
      expected_loss_bps_of_equity: "5",
    });
    return;
  }

  errors.push("analysis.decision_policy.id는 cleanup_probe 또는 autonomous_24x7이어야 합니다.");
}

function validateLiveOpsEnv(env, processEnv) {
  const errors = dedupeStrings([...collectLegacyEnvErrors(processEnv), ...collectLegacyEnvErrors(env)]);
  for (const name of [
    "SEEMIRAI_DATABASE_URL",
    "SEEMIRAI_UPBIT_ACCESS_KEY",
    "SEEMIRAI_UPBIT_SECRET_KEY",
    "SEEMIRAI_UPBIT_KEY_SCOPE",
    "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID",
    "SEEMIRAI_TELEGRAM_BOT_TOKEN",
    "SEEMIRAI_TELEGRAM_CHAT_ID",
    "SEEMIRAI_TUI_CONTROL_TOKEN",
  ]) {
    if (!hasMeaningfulValue(env[name])) {
      errors.push(`${name} 값이 env file에 필요합니다.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`live ops env 검증 실패: ${errors.join("; ")}`);
  }
}

function validateAllowedKeys(errors, target, prefix, allowedKeys) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return;
  }

  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix}.${key}는 production live ops JSON config에서 허용하지 않습니다.`);
    }
  }
}

function validateExpectedValues(errors, target, prefix, expected) {
  if (target === null || typeof target !== "object") {
    errors.push(`${prefix} 설정이 필요합니다.`);
    return;
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (target[key] !== expectedValue) {
      errors.push(`${prefix}.${key}는 ${String(expectedValue)}이어야 합니다.`);
    }
  }
}

function validateStopCeiling(errors, budget) {
  if (budget === null || typeof budget !== "object") {
    return;
  }

  const ceiling = Number(budget.operations_stop_ceiling_krw);
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling >= 50000) {
    errors.push("budget.operations_stop_ceiling_krw는 50000 미만의 양수여야 합니다.");
  }
}

function collectLegacyEnvErrors(env) {
  const errors = [];
  for (const name of liveOpsLegacyEnvNames) {
    if (hasMeaningfulValue(env[name])) {
      errors.push(`${name}은 production live ops env로 사용할 수 없습니다.`);
    }
  }
  for (const name of Object.keys(env)) {
    if (/^SEEMIRAI_M22_.*_READY$/u.test(name) && hasMeaningfulValue(env[name])) {
      errors.push(`${name}은 실제 readiness probe로 대체해야 합니다.`);
    }
    if (/^SEEMIRAI_RUN_UPBIT_.*_SMOKE$/u.test(name) && hasMeaningfulValue(env[name])) {
      errors.push(`${name}은 production live ops smoke/readiness 입력으로 사용할 수 없습니다.`);
    }
  }
  return errors;
}

function dedupeStrings(values) {
  return [...new Set(values)];
}

function parseEnvFile(content) {
  const values = {};
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`${index + 1}번 줄은 KEY=value 형식이어야 합니다.`);
    }
    const key = normalized.slice(0, separatorIndex).trim();
    const rawValue = normalized.slice(separatorIndex + 1).trim();
    values[key] = parseEnvValue(rawValue);
  });
  return values;
}

function parseEnvValue(rawValue) {
  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
    return rawValue.slice(1, -1);
  }
  const commentIndex = rawValue.indexOf(" #");
  return commentIndex >= 0 ? rawValue.slice(0, commentIndex).trim() : rawValue;
}

export async function createLiveOpsCliProductionRuntime({
  configPath,
  config,
  env,
  market,
  fetchImpl = fetch,
  artifactDir,
  clock = () => new Date().toISOString(),
  cancelPollCount = liveOpsCliCleanupCancelPollCount,
  cancelPollIntervalMs = liveOpsCliCleanupCancelPollIntervalMs,
}) {
  const databaseProviders = createLiveOpsCliProductionProviders({ config, env, market, fetchImpl });
  const artifactStore = await createLiveOpsCliCleanupArtifactStore({ configPath, env, artifactDir });
  const broker = createLiveOpsCliUpbitLiveBroker({ env, fetchImpl, clock });
  const budgetReservation = createLiveOpsCliFileBudgetReservation({ artifactStore, clock });

  return {
    ...databaseProviders,
    databasePrivateReadProvider: databaseProviders.privateReadProvider,
    privateReadProvider: broker,
    broker,
    artifactStore,
    budgetReservation,
    entryRuntime: createLiveOpsCliEntryRuntime({
      broker,
      budgetReservation,
      artifactStore,
      clock,
      pollCount: cancelPollCount,
      pollIntervalMs: cancelPollIntervalMs,
    }),
    exitRuntime: createLiveOpsCliExitRuntime({ broker, artifactStore, clock }),
    cleanupLifecycle: createLiveOpsCliCleanupLifecycle({
      broker,
      artifactStore,
      clock,
      cancelPollCount,
      cancelPollIntervalMs,
    }),
    async close() {
      await databaseProviders.close?.();
    },
  };
}

async function collectLiveOpsCliAutonomousAnalysisPreflight({
  config,
  fixtureSmoke,
  marketData,
  productionRuntime,
}) {
  if (fixtureSmoke || !isLiveOpsCliAutonomous24x7Policy(config) || productionRuntime === undefined) {
    return undefined;
  }

  const observedAt = new Date().toISOString();
  try {
    return {
      preflight: await collectLiveOpsCliProductionPreflight({
        config,
        marketData,
        productionRuntime,
        observedAt,
        pnlScopeStrategyId: liveOpsCliAutonomous24x7StrategyId,
      }),
    };
  } catch (error) {
    return {
      error: {
        name: safeErrorName(error),
        message: error instanceof Error ? error.message : String(error),
        observedAt,
      },
    };
  }
}

function resolveLiveOpsCliPreflightPnlStrategyId(orderIntents) {
  const strategyIds = new Set(
    (Array.isArray(orderIntents) ? orderIntents : [])
      .map((intent) => intent?.strategyId)
      .filter((strategyId) => hasMeaningfulValue(strategyId)),
  );
  if (strategyIds.has(liveOpsCliAutonomous24x7StrategyId)) {
    return liveOpsCliAutonomous24x7StrategyId;
  }
  return "live_ops_cleanup_probe";
}

function createLiveOpsCliPnlScope({ strategyId = "live_ops_cleanup_probe", market } = {}) {
  return {
    strategyId: hasMeaningfulValue(strategyId) ? String(strategyId) : "live_ops_cleanup_probe",
    market: hasMeaningfulValue(market) ? String(market) : "KRW-BTC",
  };
}

export async function createLiveOpsCliProductionExecutionInputs({
  config,
  env = {},
  fixtureSmoke,
  analysisDecision,
  marketData,
  orderIntents,
  productionRuntime,
  preflight: providedPreflight,
}) {
  const base = {
    orderIntents,
    entryRuntime: productionRuntime?.entryRuntime,
    exitRuntime: productionRuntime?.exitRuntime,
    cleanupLifecycle: productionRuntime?.cleanupLifecycle,
    executionStatus: undefined,
    postSubmitReadiness: undefined,
    budgetSnapshot: undefined,
    lossSnapshot: undefined,
  };

  if (
    fixtureSmoke ||
    productionRuntime === undefined ||
    analysisDecision?.ready !== true ||
    !Array.isArray(orderIntents) ||
    orderIntents.length === 0
  ) {
    return base;
  }

  const brokerGuard = evaluateLiveOpsCliBrokerGuard({ config, env, fixtureSmoke });
  if (!brokerGuard.ready) {
    // 금지 scope key는 private read에도 쓰지 않도록 실계좌 조회 전 단계에서 닫는다.
    return base;
  }

  try {
    // freshness와 일일 예산 기준일은 시장 이벤트 시각이 아니라 실제 제출 직전 wall clock으로 닫아야 한다.
    const preflightObservedAt = new Date().toISOString();
    const preflight = shouldReuseLiveOpsCliProvidedExecutionPreflight({ providedPreflight, productionRuntime })
      ? providedPreflight
      : await collectLiveOpsCliProductionPreflight({
          config,
          marketData,
          productionRuntime,
          observedAt: preflightObservedAt,
          pnlScopeStrategyId: resolveLiveOpsCliPreflightPnlStrategyId(orderIntents),
        });
    return {
      ...base,
      orderIntents: attachLiveOpsCliRuntimeEvidence({
        config,
        orderIntents,
        preflight,
      }),
      executionStatus: preflight.executionStatus,
      postSubmitReadiness: preflight.postSubmitReadiness,
      budgetSnapshot: preflight.budgetSnapshot,
      lossSnapshot: preflight.lossSnapshot,
    };
  } catch (error) {
    const evidenceId = createLiveOpsCliEvidenceId("preflight-failed", safeErrorName(error));
    return {
      ...base,
      executionStatus: {
        killSwitchActive: true,
        reconcileFresh: false,
        evidenceId,
      },
      postSubmitReadiness: {
        reconcileReady: false,
        telegramReady: productionRuntime?.telegramDispatcher !== undefined,
        evidenceId,
      },
    };
  }
}

function shouldReuseLiveOpsCliProvidedExecutionPreflight({ providedPreflight, productionRuntime }) {
  if (providedPreflight === undefined) {
    return false;
  }
  // production provider가 조립된 경로에서는 분석 시점 snapshot으로 broker 제출 직전 위험 상태를 대체하지 않는다.
  return !hasLiveOpsCliProductionPreflightProviders(productionRuntime);
}

function hasLiveOpsCliProductionPreflightProviders(productionRuntime) {
  return (
    isLiveOpsCliPrivateReadProvider(productionRuntime?.privateReadProvider) &&
    productionRuntime?.reconcileStatusProvider !== undefined &&
    productionRuntime?.pnlStatusProvider !== undefined &&
    productionRuntime?.killSwitchProvider !== undefined &&
    typeof productionRuntime?.budgetReservation?.readDailyReservedNotional === "function"
  );
}

async function collectLiveOpsCliProductionPreflight({
  config,
  marketData,
  productionRuntime,
  observedAt,
  pnlScopeStrategyId = "live_ops_cleanup_probe",
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const pnlScope = createLiveOpsCliPnlScope({ strategyId: pnlScopeStrategyId, market });
  const [
    openOrders,
    balanceSnapshot,
    reconcileStatus,
    pnlStatus,
    killSwitchStatus,
    initialReservationUsage,
  ] = await Promise.all([
    // clean-start evidence는 계정 전체 미체결 주문을 기준으로 해야 다른 KRW 마켓 잔여 주문이 신규 제출을 열지 못한다.
    productionRuntime.privateReadProvider.listOpenOrders(),
    productionRuntime.privateReadProvider.getBalances(),
    readLiveOpsCliReconcileStatus(productionRuntime.reconcileStatusProvider),
    readLiveOpsCliPnlStatus(productionRuntime.pnlStatusProvider, pnlScope),
    readLiveOpsCliKillSwitchStatus(productionRuntime.killSwitchProvider),
    productionRuntime.budgetReservation.readDailyReservedNotional(observedAt),
  ]);
  let resolvedReconcileStatus = reconcileStatus;
  let preflightReconcileEvidence;
  if (shouldCreateLiveOpsCliPrivateReadPreflightReconcile(reconcileStatus, productionRuntime, openOrders, observedAt)) {
    preflightReconcileEvidence = await productionRuntime.preflightReconcileRecorder.recordPreflight({
      market,
      openOrders,
      balanceSnapshot,
      observedAt,
    });
    resolvedReconcileStatus = await readLiveOpsCliReconcileStatus(productionRuntime.reconcileStatusProvider);
  }
  const openExposureKrw = sumLiveOpsCliOpenExposureKrw(openOrders);
  const heldPositionExposure = createLiveOpsCliHeldPositionExposure({
    balanceSnapshot,
    market,
    referencePrice: marketData.referencePrice,
    observedAt,
  });
  const reservationUsage = await refreshLiveOpsCliAutonomousPositionObservation({
    productionRuntime,
    reservationUsage: initialReservationUsage,
    heldPositionExposure,
    observedAt,
  });
  const autonomousPositionOwnership = createLiveOpsCliAutonomousPositionOwnership({
    reservationUsage,
    heldPositionExposure,
    observedAt,
  });
  const autonomousPnlPositionSnapshot = createLiveOpsCliAutonomousPnlPositionSnapshot({
    ownership: autonomousPositionOwnership,
    heldPositionExposure,
  });
  let resolvedPnlStatus = await refreshLiveOpsCliPreflightPnlStatusIfNeeded({
    productionRuntime,
    pnlStatus,
    balanceSnapshot,
    reconcileStatus: resolvedReconcileStatus,
    market,
    marketData,
    observedAt,
    pnlScope,
    positionSnapshot: autonomousPnlPositionSnapshot,
  });
  const valuedHeldPositionKrw = isNonNegativeDecimalString(heldPositionExposure.notionalKrw)
    ? heldPositionExposure.notionalKrw
    : "0";
  const openPositionNotionalKrw = new Decimal(openExposureKrw).plus(valuedHeldPositionKrw).toFixed();
  const budgetSnapshot = {
    maxOrderKrw: config.budget?.max_order_krw ?? "10000",
    dailyAutonomousNotionalLimitKrw: config.budget?.daily_autonomous_notional_limit_krw ?? "30000",
    dailyAutonomousNotionalUsedKrw: new Decimal(reservationUsage.reservedNotionalKrw).plus(openPositionNotionalKrw).toFixed(),
    openPositionNotionalKrw,
    maxOpenPositionNotionalKrw: config.budget?.max_open_position_notional_krw ?? "30000",
    capturedAt: observedAt,
    source: "live_ops_cli_private_preflight",
  };
  // 손실 snapshot freshness는 provider read 지연까지 포함한 제출 직전 시각으로 닫아야 stale PnL이 주문 후보를 열지 못한다.
  const lossSnapshotObservedAt = new Date().toISOString();
  const lossSnapshot = createLiveOpsCliLossSnapshotFromPnlStatus({
    pnlStatus: resolvedPnlStatus,
    balanceSnapshot,
    observedAt: lossSnapshotObservedAt,
  });
  const normalizedReconcile = normalizeLiveOpsCliReconcileStatus(resolvedReconcileStatus, {
    openOrderCount: openOrders.length,
  });
  const reconcileFresh = normalizedReconcile.manualReviewRequired !== true
    && isLiveOpsCliFreshReconcileStatus(resolvedReconcileStatus, observedAt);
  const executionStatus = {
    killSwitchActive: killSwitchStatus.active,
    reconcileFresh,
    evidenceId: createLiveOpsCliEvidenceId("execution-preflight", [
      killSwitchStatus.state,
      normalizedReconcile.result,
      reconcileFresh ? "reconcile-fresh" : "reconcile-stale",
      marketData.latestHeartbeatAt ?? observedAt,
    ].join(":")),
    ...(preflightReconcileEvidence === undefined ? {} : { preflightReconcileEvidence }),
  };
  const postSubmitReadiness = {
    reconcileReady: isLiveOpsCliPrivateReadProvider(productionRuntime.privateReadProvider)
      && productionRuntime.reconcileStatusProvider !== undefined,
    telegramReady: productionRuntime.telegramDispatcher !== undefined,
    evidenceId: createLiveOpsCliEvidenceId("post-submit-readiness", [
      productionRuntime.telegramDispatcher === undefined ? "telegram-missing" : "telegram-ready",
      normalizedReconcile.result,
      observedAt,
    ].join(":")),
  };

  return {
    observedAt,
    market,
    openOrders,
    balanceSnapshot,
    heldPositionExposure,
    autonomousPositionOwnership,
    reconcileStatus: resolvedReconcileStatus,
    pnlStatus: resolvedPnlStatus,
    killSwitchStatus,
    preflightReconcileEvidence,
    budgetSnapshot,
    lossSnapshot,
    executionStatus,
    postSubmitReadiness,
  };
}

async function refreshLiveOpsCliPreflightPnlStatusIfNeeded({
  productionRuntime,
  pnlStatus,
  balanceSnapshot,
  reconcileStatus,
  market,
  marketData,
  observedAt,
  pnlScope,
  positionSnapshot,
}) {
  if (
    productionRuntime?.pnlCloseoutRunner === undefined ||
    productionRuntime?.pnlStatusProvider === undefined
  ) {
    return pnlStatus;
  }
  if (
    pnlStatus?.readStatus === "OK" &&
    !isLiveOpsCliReadyPnlSnapshotStatus(pnlStatus.latestStatus)
  ) {
    // 계산 미완료/manual-review PnL row를 새 0원 snapshot으로 가리면 실제 회계 차단 사유가 사라진다.
    return pnlStatus;
  }
  if (
    pnlStatus?.readStatus === "OK" &&
    isLiveOpsCliReadyPnlSnapshotStatus(pnlStatus.latestStatus) &&
    isLiveOpsCliFreshPnlStatus(pnlStatus, observedAt)
  ) {
    return pnlStatus;
  }
  if (!isLiveOpsCliFreshReconcileStatus(reconcileStatus, observedAt)) {
    return pnlStatus;
  }

  try {
    const closeout = await productionRuntime.pnlCloseoutRunner.refreshPreflightPnl({
      market,
      strategyId: pnlScope?.strategyId ?? "live_ops_cleanup_probe",
      observedAt,
      balanceSnapshot,
      reconcileStatus,
      referencePrice: marketData?.referencePrice ?? readLiveOpsCliMarketReferencePrice(marketData),
      referencePriceObservedAt: marketData?.latestHeartbeatAt,
      positionSnapshot,
    });
    if (closeout?.status !== "ready") {
      return pnlStatus;
    }
    // 같은 preflight tick에서 append-only PnL snapshot을 쓴 뒤 provider를 다시 읽어 loss guard 입력으로 고정한다.
    return readLiveOpsCliPnlStatus(productionRuntime.pnlStatusProvider, pnlScope);
  } catch {
    return pnlStatus;
  }
}

function attachLiveOpsCliRuntimeEvidence({ config, orderIntents, preflight }) {
  return orderIntents.map((intent) => {
    if (intent?.strategyId !== "live_ops_cleanup_probe") {
      return attachLiveOpsCliAutonomousRuntimeEvidence({
        config,
        intent,
        preflight,
      });
    }

    const runtimeIntent = createLiveOpsCliCleanupRuntimeIntent({
      intent,
      observedAt: preflight.observedAt,
    });
    const enriched = {
      ...runtimeIntent,
      costInput: runtimeIntent.costInput ?? createLiveOpsCliCleanupCostInput(),
      risk: runtimeIntent.risk ?? createLiveOpsCliCleanupRiskInput({ config, intent: runtimeIntent, preflight }),
    };
    return attachLiveOpsCliCleanupRuntimeApprovalEvidence(enriched);
  });
}

function attachLiveOpsCliAutonomousRuntimeEvidence({ config, intent, preflight }) {
  if (intent?.side === "BUY") {
    return attachLiveOpsCliAutonomousEntryRuntimeEvidence({ config, intent, preflight });
  }
  if (intent?.side === "SELL") {
    return attachLiveOpsCliAutonomousExitRuntimeEvidence({ config, intent, preflight });
  }
  return intent;
}

function attachLiveOpsCliAutonomousEntryRuntimeEvidence({ config, intent, preflight }) {
  if (intent?.strategyId !== liveOpsCliAutonomous24x7StrategyId) {
    return intent;
  }

  const runtimeIntent = createLiveOpsCliAutonomousEntryRuntimeIntent({
    intent,
    observedAt: preflight.observedAt,
  });
  const risk = runtimeIntent.risk ?? createLiveOpsCliCleanupRiskInput({
    config,
    intent: runtimeIntent,
    preflight,
  });
  return attachLiveOpsCliEntryRuntimeApprovalEvidence({
    ...runtimeIntent,
    costInput: runtimeIntent.costInput ?? createLiveOpsCliAutonomousEntryCostInput(runtimeIntent),
    risk,
  });
}

function attachLiveOpsCliAutonomousExitRuntimeEvidence({ config, intent, preflight }) {
  if (intent?.strategyId !== liveOpsCliAutonomous24x7StrategyId) {
    return intent;
  }

  const runtimeIntent = createLiveOpsCliExitRuntimeIntent(intent, {
    observedAt: preflight.observedAt,
  });
  // SELL은 분석 시점의 position scope가 stale해질 수 있으므로 제출 직전 소유 scope를 별도 evidence로 보존한다.
  const preflightPositionScope = createLiveOpsCliAutonomousPreflightPositionScope(preflight);
  const scopedRuntimeIntent = {
    ...runtimeIntent,
    metadata: {
      ...(runtimeIntent.metadata ?? {}),
      preflight_position_scope: preflightPositionScope,
    },
  };
  const risk = scopedRuntimeIntent.risk ?? createLiveOpsCliExitRiskInput({
    config,
    intent: scopedRuntimeIntent,
    preflight,
  });
  return {
    ...scopedRuntimeIntent,
    risk,
    costSnapshot: scopedRuntimeIntent.costSnapshot ?? createLiveOpsCliExitCostEvidence(scopedRuntimeIntent),
    riskApproval: scopedRuntimeIntent.riskApproval ?? createLiveOpsCliRiskApprovalEvidence({
      intent: scopedRuntimeIntent,
      risk,
    }),
  };
}

function createLiveOpsCliAutonomousPreflightPositionScope(preflight) {
  const ownership = preflight?.autonomousPositionOwnership;
  const heldPositionExposure = preflight?.heldPositionExposure;
  const walletQuantity = isNonNegativeDecimalString(heldPositionExposure?.quantity)
    ? new Decimal(heldPositionExposure.quantity)
    : new Decimal(0);
  const ownedQuantity = ownership?.owned === true
    ? resolveLiveOpsCliAutonomousOwnedQuantity({ walletQuantity, ownership })
    : undefined;
  return {
    market: heldPositionExposure?.market ?? "KRW-BTC",
    strategy_id: liveOpsCliAutonomous24x7StrategyId,
    owned: ownership?.owned === true && ownedQuantity !== undefined && ownedQuantity.gt(0),
    total_quantity: ownedQuantity === undefined ? "0" : ownedQuantity.toFixed(),
    reserved_notional_krw: isNonNegativeDecimalString(ownership?.reservedNotionalKrw) ? ownership.reservedNotionalKrw : "0",
    average_entry_price: isPositiveDecimalString(ownership?.averageEntryPrice) ? ownership.averageEntryPrice : null,
    entry_fee_krw: isNonNegativeDecimalString(ownership?.entryFeeKrw) ? ownership.entryFeeKrw : "0",
    high_watermark_price: isPositiveDecimalString(ownership?.highWatermarkPrice) ? ownership.highWatermarkPrice : null,
    observed_at: preflight?.observedAt,
    source: ownership?.source ?? "live_ops_cli_private_preflight",
  };
}

function createLiveOpsCliAutonomousEntryRuntimeIntent({ intent, observedAt }) {
  if (
    intent?.metadata?.runtime_idempotency_source === "live_ops_cli_autonomous_entry_runtime" &&
    isLiveOpsCliLiveAttemptId(intent?.idempotencyKey)
  ) {
    return intent;
  }
  const decisionIdempotencyKey = hasMeaningfulValue(intent?.metadata?.decision_idempotency_key)
    ? intent.metadata.decision_idempotency_key
    : intent?.idempotencyKey;
  const runtimeAttemptScope = hasMeaningfulValue(observedAt)
    ? String(observedAt)
    : readLiveOpsCliRuntimeObservedAt(intent?.metadata?.idempotency_observed_at);
  const runtimeSourceKey = hasMeaningfulValue(runtimeAttemptScope)
    ? [decisionIdempotencyKey, "entry-attempt-scope", runtimeAttemptScope].join(":")
    : decisionIdempotencyKey;
  // BUY도 분석 key와 broker identifier를 분리해 하루 중 매수-매도 이후 재진입이 과거 reservation에 막히지 않게 한다.
  const runtimeIdempotencyKey = createLiveOpsCliAttemptId(runtimeSourceKey);
  return {
    ...intent,
    idempotencyKey: runtimeIdempotencyKey,
    metadata: {
      ...(intent?.metadata ?? {}),
      analysis_idempotency_key: hasMeaningfulValue(intent?.metadata?.analysis_idempotency_key)
        ? intent.metadata.analysis_idempotency_key
        : decisionIdempotencyKey,
      decision_idempotency_key: decisionIdempotencyKey,
      ...(hasMeaningfulValue(runtimeAttemptScope) ? { entry_runtime_attempt_scope: runtimeAttemptScope } : {}),
      idempotency_date_scope: readLiveOpsCliRuntimeDateScope(observedAt),
      idempotency_date_source: "live_ops_runtime_preflight",
      idempotency_observed_at: observedAt,
      runtime_idempotency_source: "live_ops_cli_autonomous_entry_runtime",
    },
  };
}

function createLiveOpsCliCleanupRuntimeIntent({ intent, observedAt }) {
  if (intent?.strategyId !== "live_ops_cleanup_probe") {
    return intent;
  }

  const runtimeIdempotencyKey = createLiveOpsCliCleanupProbeRuntimeDecisionKey({
    intent,
    observedAt,
  });
  const dateScope = readLiveOpsCliRuntimeDateScope(observedAt);
  if (runtimeIdempotencyKey === undefined || dateScope === undefined) {
    return intent;
  }

  return {
    ...intent,
    idempotencyKey: runtimeIdempotencyKey,
    metadata: {
      ...(intent.metadata ?? {}),
      // 자정 경계에서 중복 reservation이 열리지 않도록 실제 제출 직전 운영일로 idempotency scope를 확정한다.
      analysis_idempotency_key: hasMeaningfulValue(intent.metadata?.analysis_idempotency_key)
        ? intent.metadata.analysis_idempotency_key
        : intent.idempotencyKey,
      idempotency_date_scope: dateScope,
      idempotency_date_source: "live_ops_runtime_preflight",
      idempotency_observed_at: observedAt,
    },
  };
}

function attachLiveOpsCliCleanupRuntimeApprovalEvidence(intent) {
  if (intent?.strategyId !== "live_ops_cleanup_probe") {
    return intent;
  }

  return attachLiveOpsCliEntryRuntimeApprovalEvidence(intent);
}

function attachLiveOpsCliEntryRuntimeApprovalEvidence(intent) {
  const evidence = createLiveOpsCliOrderIntentEvidence(intent);
  const costSnapshot = intent.costSnapshot ?? {};
  const riskApproval = intent.riskApproval ?? {};
  const hasExistingCostSnapshot = isNonEmptyRecord(intent.costSnapshot);
  const hasExistingRiskApproval = isNonEmptyRecord(intent.riskApproval);
  const costOrderIntentEvidence = resolveLiveOpsCliCleanupRuntimeApprovalOrderIntentEvidence({
    existingEvidence: costSnapshot.order_intent,
    intent,
    runtimeEvidence: evidence,
  });
  const riskOrderIntentEvidence = resolveLiveOpsCliCleanupRuntimeApprovalOrderIntentEvidence({
    existingEvidence: riskApproval.order_intent,
    intent,
    runtimeEvidence: evidence,
  });
  return {
    ...intent,
    costSnapshot: hasExistingCostSnapshot ? {
      ...costSnapshot,
      order_intent: costOrderIntentEvidence,
    } : {
      ...costSnapshot,
      source: costSnapshot.source ?? "cost_model",
      exchange_id: intent.exchangeId,
      market: intent.market,
      // CostModel이 이미 차단한 후보는 날짜 scope 보정 중 승인 evidence로 바꾸지 않는다.
      trade_allowed: costSnapshot.trade_allowed ?? true,
      reason_code: costSnapshot.reason_code ?? "cost_margin_ok",
      order_intent: costOrderIntentEvidence,
    },
    riskApproval: hasExistingRiskApproval ? {
      ...riskApproval,
      // RiskGate partial evidence는 승인으로 보정하지 않고 order intent 날짜 scope만 보정해 guard 차단 근거로 보존한다.
      order_intent: riskOrderIntentEvidence,
    } : {
      ...riskApproval,
      source: riskApproval.source ?? "risk_gate",
      approved: riskApproval.approved ?? true,
      action: riskApproval.action ?? "ALLOW",
      status: riskApproval.status ?? "PASS",
      failed_evaluation_reason_codes: Array.isArray(riskApproval.failed_evaluation_reason_codes)
        ? riskApproval.failed_evaluation_reason_codes
        : [],
      order_intent: riskOrderIntentEvidence,
    },
  };
}

function createLiveOpsCliAutonomousEntryCostInput(intent) {
  const costInput = createLiveOpsCliCleanupCostInput();
  const expectedReturnBps = resolveLiveOpsCliAutonomousEntryExpectedReturnBps({
    intent,
    costInput,
  });
  return {
    ...costInput,
    expectedReturnBps,
  };
}

function resolveLiveOpsCliAutonomousEntryExpectedReturnBps({ intent, costInput }) {
  if (isNonNegativeDecimalString(intent?.metadata?.gross_expected_return_bps)) {
    return String(intent.metadata.gross_expected_return_bps);
  }
  if (!isNonNegativeDecimalString(intent?.metadata?.cost_adjusted_margin_bps)) {
    return "0";
  }
  // 전략 신호의 cost_adjusted_margin_bps는 비용 차감 후 순마진이므로 CostModel 입력에는 비용을 다시 더한 gross 기대수익을 전달한다.
  return new Decimal(intent.metadata.cost_adjusted_margin_bps)
    .plus(sumLiveOpsCliEntryCostBurdenBps(costInput))
    .toFixed();
}

function sumLiveOpsCliEntryCostBurdenBps(costInput) {
  return [
    costInput?.entryFeeBps,
    costInput?.exitFeeBps,
    costInput?.spreadCostBpsP75,
    costInput?.expectedSlippageBpsP95,
    costInput?.cancelRequotePenaltyBps,
    costInput?.safetyBufferBps,
  ].reduce((total, value) => {
    return total.plus(isNonNegativeDecimalString(value) ? value : "0");
  }, new Decimal(0));
}

function resolveLiveOpsCliCleanupRuntimeApprovalOrderIntentEvidence({ existingEvidence, intent, runtimeEvidence }) {
  if (!isNonEmptyRecord(existingEvidence)) {
    return runtimeEvidence;
  }
  if (isLiveOpsCliCleanupRuntimeApprovalOrderIntentEvidenceRefreshable(existingEvidence, intent)) {
    // 같은 후보의 분석일 key만 runtime preflight 날짜 key로 좁혀야 하므로 다른 가격/수량 evidence는 보존해 guard에서 차단한다.
    return runtimeEvidence;
  }
  return existingEvidence;
}

function isLiveOpsCliCleanupRuntimeApprovalOrderIntentEvidenceRefreshable(evidence, intent) {
  if (isLiveOpsCliOrderIntentEvidenceMatch(evidence, intent)) {
    return true;
  }

  const analysisIdempotencyKey = intent?.metadata?.analysis_idempotency_key;
  if (!hasMeaningfulValue(analysisIdempotencyKey)) {
    return false;
  }
  return isLiveOpsCliOrderIntentEvidenceMatch(evidence, {
    ...intent,
    idempotencyKey: analysisIdempotencyKey,
  });
}

function createLiveOpsCliCleanupProbeRuntimeDecisionKey({ intent, observedAt }) {
  const dateScope = readLiveOpsCliRuntimeDateScope(observedAt);
  if (
    dateScope === undefined ||
    !hasMeaningfulValue(intent?.market) ||
    !hasMeaningfulValue(intent?.requestedPrice) ||
    !hasMeaningfulValue(intent?.requestedQuantity) ||
    !hasMeaningfulValue(intent?.requestedNotional)
  ) {
    return undefined;
  }
  return createLiveOpsCliCleanupProbeDecisionKey({
    market: String(intent.market),
    sizing: {
      requestedPrice: String(intent.requestedPrice),
      requestedQuantity: String(intent.requestedQuantity),
      requestedNotional: String(intent.requestedNotional),
    },
    observedAt: dateScope,
  });
}

function readLiveOpsCliRuntimeDateScope(observedAt) {
  return /^\d{4}-\d{2}-\d{2}/u.test(String(observedAt ?? "")) ? String(observedAt).slice(0, 10) : undefined;
}

function readLiveOpsCliRuntimeObservedAt(observedAt) {
  return readLiveOpsCliRuntimeDateScope(observedAt) === undefined ? undefined : String(observedAt);
}

function readLiveOpsCliCleanupRuntimeObservedAt(orderIntents) {
  if (!Array.isArray(orderIntents)) {
    return undefined;
  }
  for (const intent of orderIntents) {
    if (
      intent?.strategyId !== "live_ops_cleanup_probe" ||
      intent?.metadata?.idempotency_date_source !== "live_ops_runtime_preflight"
    ) {
      continue;
    }
    const observedAt = readLiveOpsCliRuntimeObservedAt(intent.metadata.idempotency_observed_at);
    if (observedAt !== undefined) {
      // preflight가 이미 날짜 scope를 선점했다면 제출 직전 wall clock으로 같은 후보 key를 재정규화하지 않는다.
      return observedAt;
    }
  }
  return undefined;
}

function createLiveOpsCliExitRuntimeIntent(intent, { observedAt } = {}) {
  if (
    intent?.metadata?.runtime_idempotency_source === "live_ops_cli_exit_runtime" &&
    isLiveOpsCliLiveAttemptId(intent?.idempotencyKey)
  ) {
    return intent;
  }

  const decisionIdempotencyKey = hasMeaningfulValue(intent?.metadata?.decision_idempotency_key)
    ? intent.metadata.decision_idempotency_key
    : intent?.idempotencyKey;
  const runtimeAttemptScope = hasMeaningfulValue(observedAt)
    ? String(observedAt)
    : readLiveOpsCliRuntimeObservedAt(intent?.metadata?.idempotency_observed_at);
  const runtimeSourceKey = hasMeaningfulValue(runtimeAttemptScope)
    ? [decisionIdempotencyKey, "exit-requote-scope", runtimeAttemptScope].join(":")
    : decisionIdempotencyKey;
  const runtimeIdempotencyKey = createLiveOpsCliAttemptId(runtimeSourceKey);
  return {
    ...intent,
    idempotencyKey: runtimeIdempotencyKey,
    metadata: {
      ...(intent?.metadata ?? {}),
      // SELL도 broker identifier와 strategy decision key를 분리해야 Upbit 32자 identifier 제한을 넘지 않는다.
      decision_idempotency_key: decisionIdempotencyKey,
      ...(hasMeaningfulValue(runtimeAttemptScope) ? { exit_runtime_attempt_scope: runtimeAttemptScope } : {}),
      runtime_idempotency_source: "live_ops_cli_exit_runtime",
    },
  };
}

function refreshLiveOpsCliExitRuntimeEvidence(intent) {
  const refreshed = {
    ...intent,
  };
  if (isNonEmptyRecord(refreshed.costSnapshot)) {
    refreshed.costSnapshot = {
      ...refreshed.costSnapshot,
      order_intent: createLiveOpsCliOrderIntentEvidence(refreshed),
    };
  }
  if (isNonEmptyRecord(refreshed.riskApproval)) {
    refreshed.riskApproval = {
      ...refreshed.riskApproval,
      order_intent: createLiveOpsCliOrderIntentEvidence(refreshed),
    };
  }
  return refreshed;
}

function createLiveOpsCliExitCostEvidence(intent) {
  return {
    source: "exit_cost_model",
    exit_cost_allowed: true,
    exit_cost_reason_code: "exit_cost_margin_ok",
    exit_cost_bps: intent?.metadata?.exit_cost_bps ?? "0",
    exit_slippage_bps: intent?.metadata?.exit_slippage_bps ?? "0",
    position_scope: intent?.metadata?.position_scope,
    order_intent: createLiveOpsCliOrderIntentEvidence(intent),
  };
}

function createLiveOpsCliExitOrderSubmission({ intent, observedAt }) {
  return {
    intent,
    costSnapshot: intent.costSnapshot,
    riskApproval: intent.riskApproval,
    expectedLossBpsOfEquity: readLiveOpsCliExpectedLossBps(intent),
    submittedAt: observedAt,
  };
}

function createLiveOpsCliRiskApprovalEvidence({ intent, risk }) {
  const failedReasonCodes = Array.isArray(risk?.infrastructureSignals) && risk.infrastructureSignals.length > 0
    ? ["live_ops_exit_infrastructure_signal_active"]
    : [];
  return {
    source: "risk_gate",
    approved: failedReasonCodes.length === 0,
    action: failedReasonCodes.length === 0 ? "ALLOW" : "BLOCK",
    status: failedReasonCodes.length === 0 ? "PASS" : "FAIL",
    failed_evaluation_reason_codes: failedReasonCodes,
    warning_evaluation_reason_codes: [],
    order_intent: createLiveOpsCliOrderIntentEvidence(intent),
    threshold_snapshot: risk?.thresholdSnapshot,
  };
}

function createLiveOpsCliCleanupCostInput() {
  return {
    expectedReturnBps: "40",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "2",
    expectedSlippageBpsP95: "2",
    cancelRequotePenaltyBps: "1",
    safetyBufferBps: "10",
  };
}

function createLiveOpsCliCleanupRiskInput({ config, intent, preflight }) {
  const observedAt = preflight.observedAt;
  const equityKrw = readLiveOpsCliEquityKrw(preflight.balanceSnapshot, preflight.pnlStatus, config);
  const dailyLossBps = toLiveOpsCliLossBps(preflight.lossSnapshot.dailyRealizedLossKrw, equityKrw);
  const weeklyLossBps = toLiveOpsCliLossBps(preflight.lossSnapshot.weeklyRealizedLossKrw, equityKrw);
  const maxOrderNotionalBps = toLiveOpsCliBudgetBps(config.budget?.max_order_krw ?? "10000", equityKrw);
  const btcEthMaxPositionBps = toLiveOpsCliBudgetBps(config.budget?.max_open_position_notional_krw ?? "30000", equityKrw);
  const krwAvailable = findLiveOpsCliBalance(preflight.balanceSnapshot, "KRW")?.available;
  const krwAvailableBlocksSubmit = !isPositiveDecimalString(krwAvailable) || new Decimal(krwAvailable).lt(intent.requestedNotional);
  const heldPositionRiskPosition = createLiveOpsCliHeldPositionRiskInput({
    heldPositionExposure: preflight.heldPositionExposure,
    equityKrw,
    observedAt,
  });
  const infrastructureSignals = krwAvailableBlocksSubmit
    ? [{
        signal: "BALANCE_POSITION_MISMATCH",
        observedAt,
        // KRW 잔고 행이 없거나 0원이면 Upbit reject 전에 risk gate에서 신규 주문을 닫는다.
        reason: isPositiveDecimalString(krwAvailable) ? "krw_available_below_request" : "krw_available_missing_or_non_positive",
      }]
    : [];
  if (preflight.heldPositionExposure?.valuationMissing === true) {
    // 보유 코인을 평가하지 못하면 open position 한도를 과소평가하므로 broker 제출 전에 RiskGate에서 차단한다.
    infrastructureSignals.push({
      signal: "BALANCE_POSITION_MISMATCH",
      observedAt,
      reason: "held_position_valuation_missing",
    });
  }
  return {
    account: {
      equityKrw,
      dailyRealizedPnlBps: new Decimal(dailyLossBps).negated().toFixed(),
      weeklyRealizedPnlBps: new Decimal(weeklyLossBps).negated().toFixed(),
      maxDrawdownBps: "0",
      capturedAt: observedAt,
    },
    positions: [
      ...preflight.openOrders.map((order) => ({
        market: order.market,
        notionalBpsOfEquity: toLiveOpsCliBudgetBps(
          readLiveOpsCliOpenOrderExposureKrw(order) ?? "0",
          equityKrw,
        ),
        capturedAt: order.updatedAt ?? observedAt,
      })),
      ...(heldPositionRiskPosition === undefined ? [] : [heldPositionRiskPosition]),
    ],
    strategy: {
      strategyId: intent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals,
    thresholdSnapshot: {
      thresholds: {
        dailyLossLimitBps: toLiveOpsCliBudgetBps(config.budget?.max_order_krw ?? "10000", equityKrw),
        weeklyLossLimitBps: toLiveOpsCliBudgetBps(config.budget?.daily_autonomous_notional_limit_krw ?? "30000", equityKrw),
        maxDrawdownBps: "500",
        maxOrderNotionalBpsOfEquity: maxOrderNotionalBps,
        maxExpectedLossBpsOfEquity: "20",
        btcEthMaxPositionBpsOfEquity: btcEthMaxPositionBps,
        altMaxPositionBpsOfEquity: "0",
        totalAltMaxPositionBpsOfEquity: "0",
        maxConsecutiveStrategyLosses: 3,
      },
      capturedAt: observedAt,
      source: "live_ops_cli_private_preflight",
    },
  };
}

function createLiveOpsCliExitRiskInput({ config, intent, preflight }) {
  const observedAt = preflight.observedAt;
  const equityKrw = readLiveOpsCliEquityKrw(preflight.balanceSnapshot, preflight.pnlStatus, config);
  const dailyLossBps = toLiveOpsCliLossBps(preflight.lossSnapshot.dailyRealizedLossKrw, equityKrw);
  const weeklyLossBps = toLiveOpsCliLossBps(preflight.lossSnapshot.weeklyRealizedLossKrw, equityKrw);
  const maxOrderNotionalBps = toLiveOpsCliBudgetBps(config.budget?.max_order_krw ?? "10000", equityKrw);
  const btcEthMaxPositionBps = toLiveOpsCliBudgetBps(config.budget?.max_open_position_notional_krw ?? "30000", equityKrw);
  const heldPositionRiskPosition = createLiveOpsCliHeldPositionRiskInput({
    heldPositionExposure: preflight.heldPositionExposure,
    equityKrw,
    observedAt,
  });
  const infrastructureSignals = [];
  if (preflight.heldPositionExposure?.valuationMissing === true) {
    // exit도 보유 scope를 증명해야 하므로 기준가 결측은 broker 제출 전에 RiskGate evidence로 차단한다.
    infrastructureSignals.push({
      signal: "BALANCE_POSITION_MISMATCH",
      observedAt,
      reason: "held_position_valuation_missing",
    });
  }
  return {
    account: {
      equityKrw,
      dailyRealizedPnlBps: new Decimal(dailyLossBps).negated().toFixed(),
      weeklyRealizedPnlBps: new Decimal(weeklyLossBps).negated().toFixed(),
      maxDrawdownBps: "0",
      capturedAt: observedAt,
    },
    positions: [
      ...preflight.openOrders.map((order) => ({
        market: order.market,
        notionalBpsOfEquity: toLiveOpsCliBudgetBps(
          readLiveOpsCliOpenOrderExposureKrw(order) ?? "0",
          equityKrw,
        ),
        capturedAt: order.updatedAt ?? observedAt,
      })),
      ...(heldPositionRiskPosition === undefined ? [] : [heldPositionRiskPosition]),
    ],
    strategy: {
      strategyId: intent.strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals,
    thresholdSnapshot: {
      thresholds: {
        dailyLossLimitBps: toLiveOpsCliBudgetBps(config.budget?.max_order_krw ?? "10000", equityKrw),
        weeklyLossLimitBps: toLiveOpsCliBudgetBps(config.budget?.daily_autonomous_notional_limit_krw ?? "30000", equityKrw),
        maxDrawdownBps: "500",
        maxOrderNotionalBpsOfEquity: maxOrderNotionalBps,
        maxExpectedLossBpsOfEquity: "20",
        btcEthMaxPositionBpsOfEquity: btcEthMaxPositionBps,
        altMaxPositionBpsOfEquity: "0",
        totalAltMaxPositionBpsOfEquity: "0",
        maxConsecutiveStrategyLosses: 3,
      },
      capturedAt: observedAt,
      source: "live_ops_cli_private_preflight",
    },
  };
}

function createLiveOpsCliOrderIntentEvidence(intent) {
  const evidence = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    post_only: intent.postOnly,
    time_in_force: intent.timeInForce,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    requested_price: intent.requestedPrice,
    idempotency_key: intent.idempotencyKey,
    expected_loss_bps_of_equity: readLiveOpsCliExpectedLossBps(intent),
  };
  const positionEffect = readLiveOpsCliPositionEffect(intent);
  if (positionEffect !== undefined) {
    evidence.position_effect = positionEffect;
  }
  return evidence;
}

function createLiveOpsCliHeldPositionExposure({ balanceSnapshot, market, referencePrice, observedAt }) {
  const baseCurrency = readLiveOpsCliMarketBaseCurrency(market);
  const baseBalance = findLiveOpsCliBalance(balanceSnapshot, baseCurrency);
  const quantity = isNonNegativeDecimalString(baseBalance?.total) ? baseBalance.total : "0";
  if (new Decimal(quantity).isZero()) {
    return {
      market,
      currency: baseCurrency,
      quantity,
      notionalKrw: "0",
      capturedAt: baseBalance?.updatedAt ?? balanceSnapshot?.capturedAt ?? observedAt,
      valuationMissing: false,
    };
  }
  if (!isPositiveDecimalString(referencePrice)) {
    return {
      market,
      currency: baseCurrency,
      quantity,
      notionalKrw: null,
      capturedAt: baseBalance?.updatedAt ?? balanceSnapshot?.capturedAt ?? observedAt,
      valuationMissing: true,
    };
  }
  return {
    market,
    currency: baseCurrency,
    quantity,
    notionalKrw: new Decimal(quantity).mul(referencePrice).toFixed(),
    capturedAt: baseBalance?.updatedAt ?? balanceSnapshot?.capturedAt ?? observedAt,
    valuationMissing: false,
  };
}

async function refreshLiveOpsCliAutonomousPositionObservation({
  productionRuntime,
  reservationUsage,
  heldPositionExposure,
  observedAt,
}) {
  if (typeof productionRuntime?.budgetReservation?.recordAutonomousPositionObservation !== "function") {
    return reservationUsage;
  }
  if (
    heldPositionExposure?.valuationMissing === true ||
    !isNonNegativeDecimalString(heldPositionExposure?.quantity)
  ) {
    return reservationUsage;
  }
  const heldQuantity = new Decimal(heldPositionExposure.quantity);
  if (heldQuantity.gt(0) && !isPositiveDecimalString(heldPositionExposure?.notionalKrw)) {
    return reservationUsage;
  }
  // 지갑 0수량 관측도 stale open lot을 닫는 evidence이므로 기존 원가를 기준 가격 대용으로 넘긴다.
  const currentUnitPrice = heldQuantity.gt(0)
    ? new Decimal(heldPositionExposure.notionalKrw).div(heldQuantity).toFixed()
    : isPositiveDecimalString(reservationUsage?.autonomous24x7Position?.averageEntryPrice)
    ? String(reservationUsage.autonomous24x7Position.averageEntryPrice)
    : isPositiveDecimalString(reservationUsage?.autonomous24x7Position?.highWatermarkPrice)
    ? String(reservationUsage.autonomous24x7Position.highWatermarkPrice)
    : "1";
  await productionRuntime.budgetReservation.recordAutonomousPositionObservation({
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    market: heldPositionExposure.market,
    observedAt,
    walletQuantity: heldPositionExposure.quantity,
    currentUnitPrice,
    averageEntryPrice: reservationUsage?.autonomous24x7Position?.averageEntryPrice,
  });
  // state write 이후 다시 읽어 같은 tick의 exit rule이 이전 tick high-water를 잃지 않게 한다.
  return productionRuntime.budgetReservation.readDailyReservedNotional(observedAt);
}

function createLiveOpsCliAutonomousPositionOwnership({ reservationUsage, heldPositionExposure, observedAt }) {
  const aggregate = reservationUsage?.autonomous24x7Position ?? {};
  const walletQuantity = isNonNegativeDecimalString(heldPositionExposure?.quantity)
    ? new Decimal(heldPositionExposure.quantity)
    : new Decimal(0);
  const reservedNotionalKrw = isNonNegativeDecimalString(aggregate.reservedNotionalKrw)
    ? aggregate.reservedNotionalKrw
    : "0";
  const requestedQuantity = isNonNegativeDecimalString(aggregate.requestedQuantity)
    ? aggregate.requestedQuantity
    : undefined;
  const averageEntryPrice = isPositiveDecimalString(aggregate.averageEntryPrice)
    ? aggregate.averageEntryPrice
    : undefined;
  const highWatermarkPrice = isPositiveDecimalString(aggregate.highWatermarkPrice)
    ? aggregate.highWatermarkPrice
    : undefined;
  return {
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    owned: walletQuantity.gt(0) && new Decimal(reservedNotionalKrw).gt(0),
    reservedNotionalKrw,
    reservationCount: Number.isInteger(aggregate.reservationCount) ? aggregate.reservationCount : 0,
    requestedQuantity,
    averageEntryPrice,
    highWatermarkPrice,
    highWatermarkAt: hasMeaningfulValue(aggregate.highWatermarkAt) ? aggregate.highWatermarkAt : undefined,
    status: hasMeaningfulValue(aggregate.status) ? aggregate.status : undefined,
    closedAt: hasMeaningfulValue(aggregate.closedAt) ? aggregate.closedAt : undefined,
    manualReviewReason: hasMeaningfulValue(aggregate.manualReviewReason) ? aggregate.manualReviewReason : undefined,
    openedAt: hasMeaningfulValue(aggregate.openedAt) ? aggregate.openedAt : undefined,
    latestReservationAt: hasMeaningfulValue(aggregate.latestReservationAt) ? aggregate.latestReservationAt : observedAt,
    realizedPnlKrw: isDecimalString(aggregate.realizedPnlKrw) ? aggregate.realizedPnlKrw : undefined,
    source: "live_ops_cli_budget_reservation",
  };
}

function createLiveOpsCliAutonomousPnlPositionSnapshot({ ownership, heldPositionExposure }) {
  if (
    ownership?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    String(ownership?.status ?? "").toUpperCase() === "CLOSED" &&
    heldPositionExposure?.market === "KRW-BTC" &&
    isDecimalString(ownership?.realizedPnlKrw)
  ) {
    // 전량 청산된 전략 lot은 수동 BTC 잔고가 남아도 realized PnL closeout을 현재 tick에 넘겨야 한다.
    return {
      source: "live_ops_autonomous_artifact_position",
      strategyId: liveOpsCliAutonomous24x7StrategyId,
      market: "KRW-BTC",
      quantity: "0",
      averageEntryPrice: isNonNegativeDecimalString(ownership?.averageEntryPrice) ? String(ownership.averageEntryPrice) : "0",
      realizedPnlKrw: String(ownership.realizedPnlKrw),
      openedAt: ownership.openedAt,
      closedAt: ownership.closedAt,
      latestReservationAt: ownership.latestReservationAt,
      highWatermarkPrice: ownership.highWatermarkPrice,
      highWatermarkAt: ownership.highWatermarkAt,
    };
  }
  if (
    ownership?.strategyId !== liveOpsCliAutonomous24x7StrategyId ||
    ownership?.owned !== true ||
    heldPositionExposure?.market !== "KRW-BTC" ||
    !isPositiveDecimalString(heldPositionExposure?.quantity) ||
    !isPositiveDecimalString(ownership?.requestedQuantity) ||
    !isPositiveDecimalString(ownership?.averageEntryPrice)
  ) {
    return undefined;
  }
  const walletQuantity = new Decimal(heldPositionExposure.quantity);
  const ownedQuantity = new Decimal(ownership.requestedQuantity);
  // 수동 BTC가 섞인 지갑에서도 전략 소유 수량만 PnL closeout 원가 source로 전달한다.
  if (walletQuantity.lt(ownedQuantity)) {
    return undefined;
  }
  return {
    source: "live_ops_autonomous_artifact_position",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    market: "KRW-BTC",
    quantity: ownedQuantity.toFixed(),
    averageEntryPrice: String(ownership.averageEntryPrice),
    realizedPnlKrw: isDecimalString(ownership.realizedPnlKrw) ? String(ownership.realizedPnlKrw) : "0",
    openedAt: ownership.openedAt,
    latestReservationAt: ownership.latestReservationAt,
    highWatermarkPrice: ownership.highWatermarkPrice,
    highWatermarkAt: ownership.highWatermarkAt,
  };
}

function createLiveOpsCliHeldPositionRiskInput({ heldPositionExposure, equityKrw, observedAt }) {
  if (!isPositiveDecimalString(heldPositionExposure?.notionalKrw)) {
    return undefined;
  }
  return {
    market: heldPositionExposure.market,
    notionalBpsOfEquity: toLiveOpsCliBudgetBps(heldPositionExposure.notionalKrw, equityKrw),
    capturedAt: heldPositionExposure.capturedAt ?? observedAt,
  };
}

function readLiveOpsCliMarketBaseCurrency(market) {
  const [, baseCurrency] = String(market ?? "KRW-BTC").split("-");
  return hasMeaningfulValue(baseCurrency) ? baseCurrency : "BTC";
}

function readLiveOpsCliMarketQuoteCurrency(market) {
  const [quoteCurrency] = String(market ?? "KRW-BTC").split("-");
  return hasMeaningfulValue(quoteCurrency) ? quoteCurrency : "KRW";
}

function createLiveOpsCliLossSnapshotFromPnlStatus({ pnlStatus, balanceSnapshot, observedAt }) {
  if (pnlStatus?.readStatus !== "OK" || !isDecimalString(pnlStatus?.latestRealizedPnlKrw)) {
    // PnL worker가 OK snapshot을 쓰기 전에는 손실을 0으로 보정하지 않고 submit 전 loss guard에서 닫는다.
    return createLiveOpsCliUnavailableLossSnapshot({
      pnlStatus,
      balanceSnapshot,
      observedAt,
      reasonCode: pnlStatus?.reason ?? "pnl_status_not_ok",
    });
  }
  if (!isLiveOpsCliReadyPnlSnapshotStatus(pnlStatus.latestStatus)) {
    // PARTIAL/manual-review PnL row는 DB 조회가 성공했어도 손실 한도 증거로 쓰면 신규 주문이 잘못 열린다.
    return createLiveOpsCliUnavailableLossSnapshot({
      pnlStatus,
      balanceSnapshot,
      observedAt,
      reasonCode: "pnl_snapshot_status_not_ready",
    });
  }
  if (!isLiveOpsCliFreshPnlStatus(pnlStatus, observedAt)) {
    // 오래된 PnL row는 현재 preflight tick의 realized loss 증거가 아니므로 submit 전 loss guard에서 닫는다.
    return createLiveOpsCliUnavailableLossSnapshot({
      pnlStatus,
      balanceSnapshot,
      observedAt,
      reasonCode: "pnl_snapshot_stale",
    });
  }
  const realizedPnl = isDecimalString(pnlStatus?.latestRealizedPnlKrw)
    ? new Decimal(pnlStatus.latestRealizedPnlKrw)
    : new Decimal(0);
  const realizedLoss = realizedPnl.isNegative() ? realizedPnl.abs() : new Decimal(0);
  return {
    dailyRealizedLossKrw: realizedLoss.toFixed(),
    weeklyRealizedLossKrw: realizedLoss.toFixed(),
    capturedAt: pnlStatus?.latestCapturedAt ?? balanceSnapshot?.capturedAt ?? observedAt,
    source: pnlStatus?.readStatus === "OK" ? "pnl_snapshots" : "private_read_clean_start",
  };
}

function createLiveOpsCliUnavailableLossSnapshot({ pnlStatus, balanceSnapshot, observedAt, reasonCode }) {
  return {
    dailyRealizedLossKrw: null,
    weeklyRealizedLossKrw: null,
    capturedAt: pnlStatus?.latestCapturedAt ?? balanceSnapshot?.capturedAt ?? observedAt,
    source: "pnl_status_not_ready",
    ready: false,
    reasonCode,
  };
}

function isLiveOpsCliReadyPnlSnapshotStatus(status) {
  if (!hasMeaningfulValue(status)) {
    return false;
  }
  return String(status).toUpperCase() === "CALCULATED";
}

function isLiveOpsCliFreshPnlStatus(
  pnlStatus,
  observedAt,
  maxAgeMs = liveOpsCliPreflightPnlFreshnessMs,
  maxFutureSkewMs = liveOpsCliPreflightPnlFutureSkewMs,
) {
  if (!hasMeaningfulValue(pnlStatus?.latestCapturedAt)) {
    return false;
  }
  const observedTime = Date.parse(String(observedAt));
  const capturedTime = Date.parse(String(pnlStatus.latestCapturedAt));
  if (!Number.isFinite(observedTime) || !Number.isFinite(capturedTime)) {
    return false;
  }
  const ageMs = observedTime - capturedTime;
  // PnL worker/DB clock이 preflight 시작 직후 snapshot을 기록하는 정상 경합은 stale로 보지 않는다.
  return ageMs >= -maxFutureSkewMs && ageMs <= maxAgeMs;
}

function readLiveOpsCliEquityKrw(balanceSnapshot, pnlStatus, config) {
  if (isPositiveDecimalString(pnlStatus?.latestEquityKrw)) {
    return pnlStatus.latestEquityKrw;
  }
  const krwBalance = findLiveOpsCliBalance(balanceSnapshot, "KRW");
  if (isPositiveDecimalString(krwBalance?.total)) {
    return krwBalance.total;
  }
  return config.budget?.daily_autonomous_notional_limit_krw ?? "30000";
}

function toLiveOpsCliLossBps(lossKrw, equityKrw) {
  if (!isNonNegativeDecimalString(lossKrw) || !isPositiveDecimalString(equityKrw)) {
    return "0";
  }
  return new Decimal(lossKrw).div(equityKrw).mul(10_000).toFixed();
}

function toLiveOpsCliBudgetBps(notionalKrw, equityKrw) {
  if (!isPositiveDecimalString(equityKrw) || !isNonNegativeDecimalString(notionalKrw)) {
    return "0";
  }
  return new Decimal(notionalKrw).div(equityKrw).mul(10_000).toFixed();
}

function createLiveOpsCliEvidenceId(prefix, source) {
  return `${prefix}-${createHash("sha256").update(String(source)).digest("hex").slice(0, 16)}`;
}

export function createLiveOpsCliProductionProviders({ config, env, market, fetchImpl }) {
  // production closeout은 같은 DB evidence를 한 tick에서 읽어 reconcile/PnL/private read의 기준 시점을 맞춘다.
  const pool = createLiveOpsCliPostgresPool(env.SEEMIRAI_DATABASE_URL);
  return {
    privateReadProvider: createLiveOpsCliDatabasePrivateReadProvider(pool),
    reconcileStatusProvider: createLiveOpsCliDatabaseReconcileStatusProvider(pool),
    preflightReconcileRecorder: createLiveOpsCliDatabasePreflightReconcileRecorder(pool),
    pnlStatusProvider: createLiveOpsCliDatabasePnlStatusProvider(pool, market),
    pnlCloseoutRunner: createLiveOpsPnlCloseoutRunner({ pool, market }),
    killSwitchProvider: createLiveOpsCliDatabaseKillSwitchProvider(pool),
    telegramDispatcher: createLiveOpsCliTelegramDispatcher({ config, env, fetchImpl }),
    async close() {
      await pool.end().catch(() => undefined);
    },
  };
}

function createLiveOpsCliPostgresPool(databaseUrl) {
  return new PgPool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: dbReadinessConnectionTimeoutMs,
    max: 2,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
}

export async function createLiveOpsCliCleanupArtifactStore({ configPath, env = {}, artifactDir } = {}) {
  const configuredDir = artifactDir
    ?? env.SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR
    ?? (configPath === undefined ? undefined : path.join(path.dirname(configPath), "artifacts"));
  if (!hasMeaningfulValue(configuredDir)) {
    throw new Error("LiveOpsCleanupArtifactDirMissing");
  }

  const resolvedDir = path.resolve(String(configuredDir));
  await mkdir(resolvedDir, { recursive: true });
  const realDir = await realpath(resolvedDir);
  assertLiveOpsCliPathOutsideRepository(realDir, "cleanup artifact directory");

  return {
    artifactDir: realDir,
    reservationPath(attemptId) {
      assertLiveOpsCliAttemptPathSegment(attemptId);
      return path.join(realDir, `reservation-${attemptId}.json`);
    },
    cleanupPath(attemptId) {
      assertLiveOpsCliAttemptPathSegment(attemptId);
      return path.join(realDir, `cleanup-${attemptId}.json`);
    },
    autonomousPositionStatePath() {
      return path.join(realDir, `autonomous-position-${liveOpsCliAutonomous24x7StrategyId}.json`);
    },
    dailyReservationLockPath(day) {
      assertLiveOpsCliReservationDay(day);
      return path.join(realDir, `reservation-daily-${day}.lock`);
    },
    async acquireDailyReservationLock(day, { acquiredAt = new Date().toISOString(), ttlMs = liveOpsCliDailyReservationLockLeaseMs } = {}) {
      const targetPath = this.dailyReservationLockPath(day);
      const acquire = async () => {
        assertLiveOpsCliDailyReservationLockOwnerAvailable();
        const leaseId = randomUUID();
        const tempPath = `${targetPath}.tmp-${leaseId}`;
        const lease = `${JSON.stringify(createLiveOpsCliDailyReservationLockLease({
          day,
          acquiredAt,
          ttlMs,
          leaseId,
        }), null, 2)}\n`;
        try {
          await writeFile(tempPath, lease, { encoding: "utf8", flag: "wx" });
          await link(tempPath, targetPath);
        } catch (error) {
          throw error;
        } finally {
          await unlink(tempPath).catch(() => undefined);
        }
        let released = false;
        return {
          path: targetPath,
          leaseId,
          async release() {
            if (released) {
              return;
            }
            released = true;
            await releaseLiveOpsCliDailyReservationLockIfOwned(targetPath, leaseId);
          },
        };
      };

      try {
        return await acquire();
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        // stale 회수는 target을 비우기 전에 hard-link claim에서 fingerprint를 재확인해 fresh lock 삭제 경합을 차단한다.
        await releaseLiveOpsCliRecoverableDailyReservationLock(targetPath, acquiredAt, ttlMs);
        return await acquire();
      }
    },
    async writeReservation(record) {
      const targetPath = this.reservationPath(record.attemptId);
      const handle = await open(targetPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return targetPath;
    },
    async readReservation(attemptId) {
      try {
        return JSON.parse(await readFile(this.reservationPath(attemptId), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async listReservations() {
      const entries = await readdir(realDir, { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^reservation-ops-[a-f0-9]{26}\.json$/u.test(entry.name)) {
          continue;
        }
        try {
          records.push(JSON.parse(await readFile(path.join(realDir, entry.name), "utf8")));
        } catch {
          // 손상된 reservation은 예산을 과소평가할 수 있으므로 집계 단계에서 fail-closed 되도록 표시한다.
          records.push({ malformed: true, reservedNotionalKrw: "0", reservedAt: null });
        }
      }
      return records;
    },
    async listCleanups() {
      const entries = await readdir(realDir, { withFileTypes: true });
      const records = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^cleanup-ops-[a-f0-9]{26}\.json$/u.test(entry.name)) {
          continue;
        }
        try {
          records.push(JSON.parse(await readFile(path.join(realDir, entry.name), "utf8")));
        } catch {
          // 손상된 cleanup은 종료 수량을 과소평가할 수 있으므로 집계 단계에서 fail-closed 되도록 표시한다.
          records.push({ malformed: true, filledQuantity: "0", terminalCheckedAt: null });
        }
      }
      return records;
    },
    async readAutonomousPositionState() {
      try {
        return JSON.parse(await readFile(this.autonomousPositionStatePath(), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    async writeAutonomousPositionState(record) {
      const targetPath = this.autonomousPositionStatePath();
      await writeFile(targetPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      return targetPath;
    },
    async writeCleanup(record) {
      const targetPath = this.cleanupPath(record.attemptId);
      await writeFile(targetPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      return targetPath;
    },
  };
}

export function createLiveOpsCliFileBudgetReservation({ artifactStore, clock = () => new Date().toISOString() }) {
  async function readDailyReservedNotionalForDay(day) {
    const [records, cleanupRecords, autonomousPositionState] = await Promise.all([
      artifactStore.listReservations(),
      typeof artifactStore.listCleanups === "function" ? artifactStore.listCleanups() : [],
      typeof artifactStore.readAutonomousPositionState === "function" ? artifactStore.readAutonomousPositionState() : undefined,
    ]);
    if (records.some((record) => record?.malformed === true) || cleanupRecords.some((record) => record?.malformed === true)) {
      throw new Error("LiveOpsCliBudgetReservationMalformed");
    }
    const dayRecords = records.filter((record) => String(record?.reservedAt ?? "").slice(0, 10) === day);
    const entryNoFillRecords = cleanupRecords.filter(isLiveOpsCliAutonomousEntryNoFillCleanupRecord);
    const activeDayRecords = dayRecords.filter((record) => (
      findLiveOpsCliAutonomousEntryNoFillForReservation(record, entryNoFillRecords) === undefined
    ));
    const reservedNotionalKrw = activeDayRecords.reduce((total, record) => {
      return total.plus(isNonNegativeDecimalString(record?.reservedNotionalKrw) ? record.reservedNotionalKrw : "0");
    }, new Decimal(0)).toFixed();
    // terminal no-fill이 확인된 post-only BUY는 포지션도 주문도 없으므로 다음 tick 예산을 즉시 돌려준다.
    // 일일 예산은 당일만 집계하지만, 보유 포지션 소유권은 UTC 날짜 경계 뒤에도 exit rule이 작동해야 하므로 전체 자동 reservation을 본다.
    const autonomous24x7Position = summarizeLiveOpsCliAutonomousReservationOwnership({
      reservationRecords: records,
      cleanupRecords,
      autonomousPositionState,
    });
    return {
      day,
      reservedNotionalKrw,
      reservationCount: activeDayRecords.length,
      autonomous24x7Position,
    };
  }

  return {
    async readDailyReservedNotional(observedAt = clock()) {
      const day = String(observedAt).slice(0, 10);
      return readDailyReservedNotionalForDay(day);
    },
    async recordAutonomousPositionObservation(observation) {
      if (typeof artifactStore.writeAutonomousPositionState !== "function") {
        return undefined;
      }
      const observedAt = readLiveOpsCliRuntimeObservedAt(observation?.observedAt) ?? readLiveOpsCliRuntimeObservedAt(clock()) ?? new Date().toISOString();
      const market = hasMeaningfulValue(observation?.market) ? String(observation.market) : "KRW-BTC";
      if (observation?.strategyId !== liveOpsCliAutonomous24x7StrategyId || market !== "KRW-BTC") {
        return undefined;
      }
      if (!isNonNegativeDecimalString(observation?.walletQuantity) || !isPositiveDecimalString(observation?.currentUnitPrice)) {
        return undefined;
      }
      const [reservationRecords, cleanupRecords, previousState] = await Promise.all([
        artifactStore.listReservations(),
        typeof artifactStore.listCleanups === "function" ? artifactStore.listCleanups() : [],
        typeof artifactStore.readAutonomousPositionState === "function" ? artifactStore.readAutonomousPositionState() : undefined,
      ]);
      if (reservationRecords.some((record) => record?.malformed === true) || cleanupRecords.some((record) => record?.malformed === true)) {
        throw new Error("LiveOpsCliBudgetReservationMalformed");
      }
      const currentAggregate = summarizeLiveOpsCliAutonomousReservationOwnership({
        reservationRecords,
        cleanupRecords,
        autonomousPositionState: previousState,
      });
      const currentUnitPrice = new Decimal(observation.currentUnitPrice);
      const walletQuantity = new Decimal(observation.walletQuantity);
      if (
        walletQuantity.gt(0) &&
        !isPositiveDecimalString(currentAggregate.requestedQuantity) &&
        hasLiveOpsCliUncertainAutonomousEntryReservation({ reservationRecords, cleanupRecords })
      ) {
        const state = {
          kind: "live_ops_autonomous_position_state",
          strategyId: liveOpsCliAutonomous24x7StrategyId,
          market,
          status: "MANUAL_REVIEW_REQUIRED",
          reservedNotionalKrw: "0",
          requestedQuantity: "0",
          openedAt: hasMeaningfulValue(currentAggregate.openedAt) ? currentAggregate.openedAt : undefined,
          latestObservationAt: observedAt,
          manualReviewReason: "autonomous_entry_fill_state_uncertain",
        };
        // BUY 예약의 fill/no-fill 증거가 없는데 지갑 BTC가 있으면 자동 소유권을 확정하지 않고 운영자 점검으로 넘긴다.
        await artifactStore.writeAutonomousPositionState(state);
        return state;
      }
      const legacyObservationFallback = summarizeLiveOpsCliLegacyAutonomousObservationFallback({
        reservationRecords,
        cleanupRecords,
        walletQuantity,
        currentUnitPrice,
      });
      const averageEntryPrice = isPositiveDecimalString(observation?.averageEntryPrice)
        ? new Decimal(observation.averageEntryPrice)
        : isPositiveDecimalString(currentAggregate.averageEntryPrice)
        ? new Decimal(currentAggregate.averageEntryPrice)
        : isPositiveDecimalString(legacyObservationFallback.averageEntryPrice)
        ? new Decimal(legacyObservationFallback.averageEntryPrice)
        : currentUnitPrice;
      const aggregateWithLegacyFallback = {
        ...currentAggregate,
        reservedNotionalKrw: isPositiveDecimalString(currentAggregate.reservedNotionalKrw)
          ? currentAggregate.reservedNotionalKrw
          : legacyObservationFallback.reservedNotionalKrw,
        requestedQuantity: isPositiveDecimalString(currentAggregate.requestedQuantity)
          ? currentAggregate.requestedQuantity
          : legacyObservationFallback.requestedQuantity,
        entryFeeKrw: isNonNegativeDecimalString(currentAggregate.entryFeeKrw) ? currentAggregate.entryFeeKrw : "0",
        openedAt: hasMeaningfulValue(currentAggregate.openedAt)
          ? currentAggregate.openedAt
          : legacyObservationFallback.openedAt,
        latestReservationAt: hasMeaningfulValue(currentAggregate.latestReservationAt)
          ? currentAggregate.latestReservationAt
          : legacyObservationFallback.latestReservationAt,
      };
      const positionQuantity = resolveLiveOpsCliObservedAutonomousPositionQuantity({
        aggregate: aggregateWithLegacyFallback,
        walletQuantity,
        averageEntryPrice,
      });
      const previousHighWatermark = isPositiveDecimalString(currentAggregate.highWatermarkPrice)
        ? new Decimal(currentAggregate.highWatermarkPrice)
        : averageEntryPrice;
      const highWatermarkPrice = Decimal.max(previousHighWatermark, currentUnitPrice);
      const highWatermarkAt = highWatermarkPrice.eq(previousHighWatermark) && hasMeaningfulValue(currentAggregate.highWatermarkAt)
        ? currentAggregate.highWatermarkAt
        : observedAt;
      const state = {
        kind: "live_ops_autonomous_position_state",
        strategyId: liveOpsCliAutonomous24x7StrategyId,
        market,
        status: positionQuantity.gt(0) ? "OPEN" : "CLOSED",
        reservedNotionalKrw: positionQuantity.gt(0) ? averageEntryPrice.mul(positionQuantity).toFixed() : "0",
        requestedQuantity: positionQuantity.toFixed(),
        averageEntryPrice: positionQuantity.gt(0) ? averageEntryPrice.toFixed() : undefined,
        entryFeeKrw: positionQuantity.gt(0) && isNonNegativeDecimalString(aggregateWithLegacyFallback.entryFeeKrw)
          ? scaleLiveOpsCliAutonomousEntryFeeForQuantity({
            entryFeeKrw: aggregateWithLegacyFallback.entryFeeKrw,
            sourceQuantity: aggregateWithLegacyFallback.requestedQuantity,
            targetQuantity: positionQuantity.toFixed(),
          })
          : "0",
        highWatermarkPrice: positionQuantity.gt(0) ? highWatermarkPrice.toFixed() : undefined,
        highWatermarkAt: positionQuantity.gt(0) ? highWatermarkAt : undefined,
        openedAt: hasMeaningfulValue(aggregateWithLegacyFallback.openedAt) ? aggregateWithLegacyFallback.openedAt : observedAt,
        latestReservationAt: hasMeaningfulValue(aggregateWithLegacyFallback.latestReservationAt)
          ? aggregateWithLegacyFallback.latestReservationAt
          : undefined,
        latestObservationAt: observedAt,
        ...(positionQuantity.gt(0) ? {} : { closedAt: observedAt }),
      };
      await artifactStore.writeAutonomousPositionState(state);
      return state;
    },
    async reserve(request) {
      const reservedAt = readLiveOpsCliRuntimeObservedAt(clock()) ?? new Date().toISOString();
      const day = String(reservedAt).slice(0, 10);
      const reservation = {
        reservationId: `reservation-${request.attemptId}`,
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        market: request.market,
        strategyId: request.strategyId,
        reservedNotionalKrw: request.requestedNotionalKrw,
        requestedPrice: request.requestedPrice,
        requestedQuantity: request.requestedQuantity,
        budgetSnapshot: request.budgetSnapshot,
        reservedAt,
        metadata: {
          source: "live_ops_cli_file_budget_reservation",
        },
      };
      const existing = await artifactStore.readReservation(request.attemptId);
      if (existing !== undefined) {
        return {
          reserved: false,
          reasonCode: "live_ops_reservation_already_exists",
          message: "이미 같은 attempt reservation이 있어 중복 실주문을 제출하지 않습니다.",
          reservation: existing,
        };
      }
      if (typeof artifactStore.acquireDailyReservationLock !== "function") {
        return {
          reserved: false,
          reasonCode: "live_ops_daily_budget_lock_missing",
          message: "일일 예산 reservation lock이 없어 broker 제출을 중단했습니다.",
        };
      }
      let lock;
      try {
        lock = await artifactStore.acquireDailyReservationLock(day, {
          acquiredAt: reservedAt,
          ttlMs: liveOpsCliDailyReservationLockLeaseMs,
        });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        return {
          reserved: false,
          reasonCode: "live_ops_daily_budget_lock_busy",
          message: "다른 live ops 실행이 일일 예산을 선점 중이라 신규 실주문을 제출하지 않습니다.",
        };
      }
      try {
        const dailyUsage = await readDailyReservedNotionalForDay(day);
        const dailyBudgetCheck = await evaluateLiveOpsCliDailyBudgetReservation({
          request,
          dailyUsage,
        });
        if (dailyBudgetCheck.reserved === false) {
          return dailyBudgetCheck;
        }
        // 일일 예산 집계와 attempt 파일 생성을 같은 lock 안에서 수행해 동시 실행의 예산 초과 제출을 막는다.
        const reservedReservation = {
          ...reservation,
          budgetUsageAfterReservationKrw: new Decimal(dailyUsage.reservedNotionalKrw)
            .plus(request.requestedNotionalKrw)
            .toFixed(),
        };
        const artifactPath = await artifactStore.writeReservation(reservedReservation);
        return {
          reserved: true,
          reservation: {
            ...reservedReservation,
            artifactPath,
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        const existing = await artifactStore.readReservation(request.attemptId);
        return {
          reserved: false,
          reasonCode: "live_ops_reservation_already_exists",
          message: "이미 같은 attempt reservation이 있어 중복 실주문을 제출하지 않습니다.",
          reservation: existing,
        };
      } finally {
        await lock?.release?.();
      }
    },
  };
}

function summarizeLiveOpsCliAutonomousReservationOwnership({ reservationRecords, cleanupRecords = [], autonomousPositionState } = {}) {
  const strategyRecords = (Array.isArray(reservationRecords) ? reservationRecords : []).filter((record) => (
    record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    record?.market === "KRW-BTC" &&
    isNonNegativeDecimalString(record?.reservedNotionalKrw)
  ));
  const sortedReservations = [...strategyRecords].sort((left, right) => {
    return String(left?.reservedAt ?? "").localeCompare(String(right?.reservedAt ?? ""));
  });
  const exitRecords = (Array.isArray(cleanupRecords) ? cleanupRecords : []).filter(isLiveOpsCliAutonomousExitCleanupRecord);
  const sortedExits = [...exitRecords].sort((left, right) => {
    return String(readLiveOpsCliAutonomousExitClosedAt(left) ?? "").localeCompare(String(readLiveOpsCliAutonomousExitClosedAt(right) ?? ""));
  });
  const entryFillRecords = (Array.isArray(cleanupRecords) ? cleanupRecords : []).filter(isLiveOpsCliAutonomousEntryFillCleanupRecord);
  // SELL cleanup은 오래된 BUY lot부터 소진해 닫힌 원가가 다음 entry/exit 판단에 섞이지 않게 한다.
  const openLots = applyLiveOpsCliAutonomousExitLots(
    sortedReservations.map((record) => createLiveOpsCliAutonomousReservationLot(record, entryFillRecords)).filter((lot) => lot !== undefined),
    sortedExits,
  );
  const netQuantity = openLots.reduce((total, lot) => total.plus(lot.quantity), new Decimal(0));
  const netReservedNotional = openLots.reduce((total, lot) => total.plus(lot.quantity.mul(lot.averageEntryPrice)), new Decimal(0));
  const netEntryFeeKrw = openLots.reduce((total, lot) => total.plus(lot.entryFeeKrw), new Decimal(0));
  const averageEntryPrice = netQuantity.gt(0) ? netReservedNotional.div(netQuantity) : undefined;
  const realizedPnlKrw = sortedExits.reduce((total, record) => {
    return total.plus(readLiveOpsCliAutonomousExitRealizedPnlKrw(record));
  }, new Decimal(0)).toFixed();
  const stateOpen = autonomousPositionState?.strategyId === liveOpsCliAutonomous24x7StrategyId
    && autonomousPositionState?.market === "KRW-BTC"
    && autonomousPositionState?.status === "OPEN";
  const stateManualReview = autonomousPositionState?.strategyId === liveOpsCliAutonomous24x7StrategyId
    && autonomousPositionState?.market === "KRW-BTC"
    && autonomousPositionState?.status === "MANUAL_REVIEW_REQUIRED";
  const stateClosed = autonomousPositionState?.strategyId === liveOpsCliAutonomous24x7StrategyId
    && autonomousPositionState?.market === "KRW-BTC"
    && autonomousPositionState?.status === "CLOSED";
  if (
    stateClosed &&
    netQuantity.gt(0) &&
    isLiveOpsCliAutonomousPositionStateNewerThanLatestLot({ state: autonomousPositionState, openLots })
  ) {
    return {
      strategyId: liveOpsCliAutonomous24x7StrategyId,
      reservedNotionalKrw: "0",
      reservationCount: strategyRecords.length,
      requestedQuantity: "0",
      openedAt: hasMeaningfulValue(autonomousPositionState.openedAt) ? autonomousPositionState.openedAt : sortedReservations[0]?.reservedAt,
      latestReservationAt: sortedReservations.at(-1)?.reservedAt ?? autonomousPositionState.latestObservationAt,
      realizedPnlKrw,
      status: "CLOSED",
      closedAt: autonomousPositionState.closedAt ?? autonomousPositionState.latestObservationAt,
    };
  }
  if (
    netQuantity.isZero() &&
    stateManualReview &&
    isLiveOpsCliAutonomousPositionStateNewerThanLatestExit({ state: autonomousPositionState, sortedExits })
  ) {
    return {
      strategyId: liveOpsCliAutonomous24x7StrategyId,
      reservedNotionalKrw: "0",
      reservationCount: strategyRecords.length,
      requestedQuantity: "0",
      openedAt: hasMeaningfulValue(autonomousPositionState.openedAt) ? autonomousPositionState.openedAt : sortedReservations[0]?.reservedAt,
      latestReservationAt: sortedReservations.at(-1)?.reservedAt ?? autonomousPositionState.latestObservationAt,
      realizedPnlKrw,
      status: "MANUAL_REVIEW_REQUIRED",
      manualReviewReason: hasMeaningfulValue(autonomousPositionState.manualReviewReason)
        ? autonomousPositionState.manualReviewReason
        : "autonomous_position_manual_review_required",
    };
  }
  if (
    netQuantity.isZero() &&
    isUsableLiveOpsCliAutonomousPositionState({ state: autonomousPositionState, sortedExits })
  ) {
    return {
      strategyId: liveOpsCliAutonomous24x7StrategyId,
      reservedNotionalKrw: String(autonomousPositionState.reservedNotionalKrw),
      reservationCount: strategyRecords.length,
      requestedQuantity: String(autonomousPositionState.requestedQuantity),
      averageEntryPrice: String(autonomousPositionState.averageEntryPrice),
      ...(isNonNegativeDecimalString(autonomousPositionState.entryFeeKrw) ? { entryFeeKrw: String(autonomousPositionState.entryFeeKrw) } : {}),
      highWatermarkPrice: autonomousPositionState.highWatermarkPrice,
      highWatermarkAt: autonomousPositionState.highWatermarkAt,
      openedAt: hasMeaningfulValue(autonomousPositionState.openedAt) ? autonomousPositionState.openedAt : sortedReservations[0]?.reservedAt,
      latestReservationAt: sortedReservations.at(-1)?.reservedAt ?? autonomousPositionState.latestObservationAt,
      realizedPnlKrw,
      status: "OPEN",
    };
  }
  const highWatermarkPrice = stateOpen && isPositiveDecimalString(autonomousPositionState?.highWatermarkPrice)
    && isDecimalEqual(autonomousPositionState?.requestedQuantity, netQuantity.toFixed())
    ? autonomousPositionState.highWatermarkPrice
    : averageEntryPrice?.toFixed();
  const highWatermarkAt = stateOpen && hasMeaningfulValue(autonomousPositionState?.highWatermarkAt)
    && isDecimalEqual(autonomousPositionState?.requestedQuantity, netQuantity.toFixed())
    ? autonomousPositionState.highWatermarkAt
    : openLots.at(-1)?.reservedAt;
  if (netQuantity.isZero()) {
    return {
      strategyId: liveOpsCliAutonomous24x7StrategyId,
      reservedNotionalKrw: "0",
      reservationCount: strategyRecords.length,
      requestedQuantity: "0",
      averageEntryPrice: averageEntryPrice?.toFixed(),
      openedAt: sortedReservations[0]?.reservedAt,
      latestReservationAt: sortedReservations.at(-1)?.reservedAt,
      realizedPnlKrw,
      status: "CLOSED",
      closedAt: readLiveOpsCliAutonomousExitClosedAt(sortedExits.at(-1)),
    };
  }
  return {
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    reservedNotionalKrw: netReservedNotional.toFixed(),
    reservationCount: strategyRecords.length,
    requestedQuantity: netQuantity.toFixed(),
    averageEntryPrice: averageEntryPrice?.toFixed(),
    entryFeeKrw: netEntryFeeKrw.toFixed(),
    highWatermarkPrice,
    highWatermarkAt,
    openedAt: openLots[0]?.reservedAt,
    latestReservationAt: openLots.at(-1)?.reservedAt,
    realizedPnlKrw,
    status: "OPEN",
  };
}

function summarizeLiveOpsCliLegacyAutonomousObservationFallback({ reservationRecords, cleanupRecords = [], walletQuantity, currentUnitPrice }) {
  const observedWalletQuantity = walletQuantity instanceof Decimal ? walletQuantity : new Decimal(0);
  const observedUnitPrice = currentUnitPrice instanceof Decimal
    ? currentUnitPrice
    : isPositiveDecimalString(currentUnitPrice)
    ? new Decimal(currentUnitPrice)
    : undefined;
  const legacyReservations = (Array.isArray(reservationRecords) ? reservationRecords : [])
    .filter((record) => (
      record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
      record?.market === "KRW-BTC" &&
      isPositiveDecimalString(record?.reservedNotionalKrw) &&
      !isPositiveDecimalString(record?.requestedQuantity)
    ))
    .sort((left, right) => String(left?.reservedAt ?? "").localeCompare(String(right?.reservedAt ?? "")))
    .map((record) => ({
      record,
      originalNotional: new Decimal(record.reservedNotionalKrw),
      remainingCost: new Decimal(record.reservedNotionalKrw),
      consumedQuantity: new Decimal(0),
    }));
  const sortedExits = (Array.isArray(cleanupRecords) ? cleanupRecords : [])
    .filter(isLiveOpsCliAutonomousExitCleanupRecord)
    .sort((left, right) => {
      return String(readLiveOpsCliAutonomousExitClosedAt(left) ?? "").localeCompare(String(readLiveOpsCliAutonomousExitClosedAt(right) ?? ""));
    });
  for (const exit of sortedExits) {
    const exitCost = new Decimal(readLiveOpsCliAutonomousExitCostNotionalKrw(exit));
    if (!exitCost.gt(0)) {
      continue;
    }
    const exitQuantity = new Decimal(readLiveOpsCliAutonomousExitFilledQuantity(exit));
    let remainingExitCost = exitCost;
    for (const reservation of legacyReservations) {
      if (remainingExitCost.lte(0)) {
        break;
      }
      if (
        reservation.remainingCost.lte(0) ||
        !isLiveOpsCliAutonomousExitAfterReservation(exit, reservation.record)
      ) {
        continue;
      }
      const consumedCost = Decimal.min(reservation.remainingCost, remainingExitCost);
      const consumedRatio = consumedCost.div(exitCost);
      reservation.remainingCost = reservation.remainingCost.minus(consumedCost);
      reservation.consumedQuantity = reservation.consumedQuantity.plus(exitQuantity.mul(consumedRatio));
      remainingExitCost = remainingExitCost.minus(consumedCost);
    }
  }
  const openReservations = legacyReservations.filter((reservation) => reservation.remainingCost.gt(0));
  const originalOpenNotional = openReservations.reduce((total, reservation) => {
    return total.plus(reservation.originalNotional);
  }, new Decimal(0));
  const consumedOpenQuantity = openReservations.reduce((total, reservation) => {
    return total.plus(reservation.consumedQuantity);
  }, new Decimal(0));
  const openedAt = openReservations.find((reservation) => hasMeaningfulValue(reservation.record?.reservedAt))?.record?.reservedAt;
  const latestReservationAt = [...openReservations]
    .reverse()
    .find((reservation) => hasMeaningfulValue(reservation.record?.reservedAt))?.record?.reservedAt;
  if (!originalOpenNotional.gt(0) || !observedWalletQuantity.gt(0)) {
    return {
      reservedNotionalKrw: "0",
      requestedQuantity: "0",
      averageEntryPrice: undefined,
      openedAt,
      latestReservationAt,
    };
  }
  const restorableOpenQuantity = observedUnitPrice instanceof Decimal && observedUnitPrice.gt(0)
    ? Decimal.min(observedWalletQuantity, originalOpenNotional.div(observedUnitPrice))
    : observedWalletQuantity;
  const estimatedOriginalQuantity = restorableOpenQuantity.plus(consumedOpenQuantity);
  if (!estimatedOriginalQuantity.gt(0)) {
    return {
      reservedNotionalKrw: "0",
      requestedQuantity: "0",
      averageEntryPrice: undefined,
      openedAt,
      latestReservationAt,
    };
  }
  // 구형 reservation에는 수량이 없으므로 지갑 전체가 아니라 현재 가격으로 복원 가능한 전략 수량만 자동 소유로 인정한다.
  const averageEntryPrice = originalOpenNotional.div(estimatedOriginalQuantity);
  return {
    reservedNotionalKrw: averageEntryPrice.mul(restorableOpenQuantity).toFixed(),
    requestedQuantity: restorableOpenQuantity.toFixed(),
    averageEntryPrice: averageEntryPrice.toFixed(),
    openedAt,
    latestReservationAt,
  };
}

function resolveLiveOpsCliObservedAutonomousPositionQuantity({ aggregate, walletQuantity, averageEntryPrice }) {
  if (isPositiveDecimalString(aggregate?.requestedQuantity)) {
    return Decimal.min(walletQuantity, new Decimal(aggregate.requestedQuantity));
  }
  if (isPositiveDecimalString(aggregate?.reservedNotionalKrw) && averageEntryPrice.gt(0)) {
    // 구형 reservation은 수량 필드가 없으므로 보유 관측값과 원가 추정치 안에서만 소유 수량을 복원한다.
    return Decimal.min(walletQuantity, new Decimal(aggregate.reservedNotionalKrw).div(averageEntryPrice));
  }
  return new Decimal(0);
}

function scaleLiveOpsCliAutonomousEntryFeeForQuantity({ entryFeeKrw, sourceQuantity, targetQuantity }) {
  if (!isNonNegativeDecimalString(entryFeeKrw) || !isPositiveDecimalString(sourceQuantity) || !isNonNegativeDecimalString(targetQuantity)) {
    return "0";
  }
  return new Decimal(entryFeeKrw)
    .mul(Decimal.min(new Decimal(targetQuantity), new Decimal(sourceQuantity)).div(sourceQuantity))
    .toFixed();
}

function createLiveOpsCliAutonomousReservationLot(record, entryFillRecords = []) {
  const entryFill = findLiveOpsCliAutonomousEntryFillForReservation(record, entryFillRecords);
  if (entryFill === undefined && isPositiveDecimalString(record?.requestedQuantity)) {
    return undefined;
  }
  const quantity = isPositiveDecimalString(readLiveOpsCliAutonomousEntryFilledQuantity(entryFill))
    ? new Decimal(readLiveOpsCliAutonomousEntryFilledQuantity(entryFill))
    : isPositiveDecimalString(record?.requestedQuantity)
    ? new Decimal(record.requestedQuantity)
    : undefined;
  const averageEntryPrice = quantity !== undefined && isPositiveDecimalString(readLiveOpsCliAutonomousEntryFilledPrice(entryFill))
    ? new Decimal(readLiveOpsCliAutonomousEntryFilledPrice(entryFill))
    : quantity !== undefined && isPositiveDecimalString(entryFill?.filledNotionalKrw)
    ? new Decimal(entryFill.filledNotionalKrw).div(quantity)
    : quantity !== undefined && isPositiveDecimalString(record?.requestedPrice)
    ? new Decimal(record.requestedPrice)
    : quantity !== undefined && isPositiveDecimalString(record?.reservedNotionalKrw)
    ? new Decimal(record.reservedNotionalKrw).div(quantity)
    : undefined;
  if (quantity === undefined || averageEntryPrice === undefined) {
    return undefined;
  }
  const entryFeeKrw = readLiveOpsCliAutonomousEntryFeeKrw(entryFill);
  return {
    quantity,
    averageEntryPrice,
    entryFeeKrw: new Decimal(entryFeeKrw),
    reservedAt: entryFill?.filledAt ?? record?.reservedAt,
    attemptId: record?.attemptId,
  };
}

function findLiveOpsCliAutonomousEntryFillForReservation(record, entryFillRecords) {
  if (!hasMeaningfulValue(record?.attemptId) && !hasMeaningfulValue(record?.idempotencyKey)) {
    return undefined;
  }
  return entryFillRecords.find((entryFill) => (
    (hasMeaningfulValue(record?.attemptId) && entryFill?.attemptId === record.attemptId) ||
    (hasMeaningfulValue(record?.idempotencyKey) && entryFill?.idempotencyKey === record.idempotencyKey)
  ));
}

function hasLiveOpsCliUncertainAutonomousEntryReservation({ reservationRecords, cleanupRecords = [] }) {
  const entryFillRecords = (Array.isArray(cleanupRecords) ? cleanupRecords : []).filter(isLiveOpsCliAutonomousEntryFillCleanupRecord);
  const entryNoFillRecords = (Array.isArray(cleanupRecords) ? cleanupRecords : []).filter(isLiveOpsCliAutonomousEntryNoFillCleanupRecord);
  return (Array.isArray(reservationRecords) ? reservationRecords : []).some((record) => (
    record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    record?.market === "KRW-BTC" &&
    isPositiveDecimalString(record?.requestedQuantity) &&
    findLiveOpsCliAutonomousEntryFillForReservation(record, entryFillRecords) === undefined &&
    findLiveOpsCliAutonomousEntryNoFillForReservation(record, entryNoFillRecords) === undefined
  ));
}

function findLiveOpsCliAutonomousEntryNoFillForReservation(record, entryNoFillRecords) {
  if (!hasMeaningfulValue(record?.attemptId) && !hasMeaningfulValue(record?.idempotencyKey)) {
    return undefined;
  }
  return entryNoFillRecords.find((entryNoFill) => (
    (hasMeaningfulValue(record?.attemptId) && entryNoFill?.attemptId === record.attemptId) ||
    (hasMeaningfulValue(record?.idempotencyKey) && entryNoFill?.idempotencyKey === record.idempotencyKey)
  ));
}

function applyLiveOpsCliAutonomousExitLots(lots, sortedExits) {
  const openLots = lots.map((lot) => ({ ...lot }));
  for (const exit of sortedExits) {
    let remainingExitQuantity = new Decimal(readLiveOpsCliAutonomousExitFilledQuantity(exit));
    for (const lot of openLots) {
      if (remainingExitQuantity.lte(0) || lot.quantity.lte(0)) {
        continue;
      }
      if (!isLiveOpsCliAutonomousExitAfterReservation(exit, { reservedAt: lot.reservedAt })) {
        // 과거 SELL closeout은 이후 새 BUY lot의 보유 수량을 줄일 수 없으므로 FIFO 차감에서 제외한다.
        continue;
      }
      const quantityBeforeExit = lot.quantity;
      const consumed = Decimal.min(lot.quantity, remainingExitQuantity);
      lot.quantity = lot.quantity.minus(consumed);
      if (lot.entryFeeKrw instanceof Decimal && quantityBeforeExit.gt(0)) {
        // 부분 청산된 lot 수수료는 이미 해당 SELL 손익에 반영되므로 남은 보유분 수수료만 다음 tick에 보존한다.
        lot.entryFeeKrw = lot.entryFeeKrw.minus(lot.entryFeeKrw.mul(consumed.div(quantityBeforeExit)));
      }
      remainingExitQuantity = remainingExitQuantity.minus(consumed);
    }
  }
  return openLots.filter((lot) => lot.quantity.gt(0));
}

function isUsableLiveOpsCliAutonomousPositionState({ state, sortedExits }) {
  if (
    state?.strategyId !== liveOpsCliAutonomous24x7StrategyId ||
    state?.market !== "KRW-BTC" ||
    state?.status !== "OPEN" ||
    !isPositiveDecimalString(state?.reservedNotionalKrw) ||
    !isPositiveDecimalString(state?.requestedQuantity) ||
    !isPositiveDecimalString(state?.averageEntryPrice)
  ) {
    return false;
  }
  return isLiveOpsCliAutonomousPositionStateNewerThanLatestExit({ state, sortedExits });
}

function isLiveOpsCliAutonomousPositionStateNewerThanLatestExit({ state, sortedExits }) {
  const latestExitClosedAt = readLiveOpsCliAutonomousExitClosedAt(sortedExits.at(-1));
  if (!hasMeaningfulValue(latestExitClosedAt)) {
    return true;
  }
  const stateObservedAt = state.latestObservationAt ?? state.highWatermarkAt ?? state.openedAt;
  return hasMeaningfulValue(stateObservedAt) && String(stateObservedAt) > String(latestExitClosedAt);
}

function isLiveOpsCliAutonomousPositionStateNewerThanLatestLot({ state, openLots }) {
  const latestLotAt = [...(Array.isArray(openLots) ? openLots : [])]
    .reverse()
    .find((lot) => hasMeaningfulValue(lot?.reservedAt))?.reservedAt;
  if (!hasMeaningfulValue(latestLotAt)) {
    return true;
  }
  const stateObservedAt = state.latestObservationAt ?? state.closedAt ?? state.openedAt;
  return hasMeaningfulValue(stateObservedAt) && String(stateObservedAt) > String(latestLotAt);
}

function isLiveOpsCliAutonomousExitCleanupRecord(record) {
  return (
    (record?.kind === "live_ops_autonomous_exit_closeout" || record?.strategyId === liveOpsCliAutonomous24x7StrategyId) &&
    record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    record?.market === "KRW-BTC" &&
    String(record?.side ?? "").toUpperCase() === "SELL" &&
    isLiveOpsCliTerminalFilledStatus(record?.status) &&
    isNonNegativeDecimalString(readLiveOpsCliAutonomousExitFilledQuantity(record))
  );
}

function isLiveOpsCliAutonomousEntryFillCleanupRecord(record) {
  return (
    (record?.kind === "live_ops_autonomous_entry_fill_closeout" || record?.strategyId === liveOpsCliAutonomous24x7StrategyId) &&
    record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    record?.market === "KRW-BTC" &&
    String(record?.side ?? "").toUpperCase() === "BUY" &&
    isLiveOpsCliTerminalFilledStatus(record?.status) &&
    isPositiveDecimalString(readLiveOpsCliAutonomousEntryFilledQuantity(record))
  );
}

function isLiveOpsCliAutonomousEntryNoFillCleanupRecord(record) {
  const status = String(record?.status ?? "").toUpperCase();
  return (
    record?.kind === "live_ops_autonomous_entry_no_fill_closeout" &&
    record?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    record?.market === "KRW-BTC" &&
    String(record?.side ?? "").toUpperCase() === "BUY" &&
    (status === "CANCELED" || status === "CANCELLED" || status === "NO_FILL" || status === "EXPIRED") &&
    !isPositiveDecimalString(readLiveOpsCliAutonomousEntryFilledQuantity(record))
  );
}

function readLiveOpsCliAutonomousEntryFilledQuantity(record) {
  if (isPositiveDecimalString(record?.filledQuantity)) {
    return record.filledQuantity;
  }
  if (isPositiveDecimalString(record?.terminalOrder?.requestedQuantity) && isDecimalEqual(record?.terminalOrder?.remainingQuantity ?? "0", "0")) {
    return record.terminalOrder.requestedQuantity;
  }
  return "0";
}

function readLiveOpsCliAutonomousEntryFilledPrice(record) {
  if (isPositiveDecimalString(record?.filledPrice)) {
    return record.filledPrice;
  }
  if (isPositiveDecimalString(record?.terminalOrder?.requestedPrice)) {
    return record.terminalOrder.requestedPrice;
  }
  return undefined;
}

function readLiveOpsCliAutonomousEntryFeeKrw(record) {
  if (isNonNegativeDecimalString(record?.entryFeeKrw)) {
    return record.entryFeeKrw;
  }
  if (isNonNegativeDecimalString(record?.entry_fee_krw)) {
    return record.entry_fee_krw;
  }
  return "0";
}

function isLiveOpsCliAutonomousExitAfterReservation(exit, reservation) {
  const reservedAt = hasMeaningfulValue(reservation?.reservedAt) ? String(reservation.reservedAt) : undefined;
  const closedAt = readLiveOpsCliAutonomousExitClosedAt(exit);
  return reservedAt === undefined || !hasMeaningfulValue(closedAt) || String(closedAt) >= reservedAt;
}

function readLiveOpsCliAutonomousExitFilledQuantity(record) {
  if (isNonNegativeDecimalString(record?.filledQuantity)) {
    return record.filledQuantity;
  }
  if (isNonNegativeDecimalString(record?.terminalOrder?.requestedQuantity) && isDecimalEqual(record?.terminalOrder?.remainingQuantity ?? "0", "0")) {
    return record.terminalOrder.requestedQuantity;
  }
  return "0";
}

function readLiveOpsCliAutonomousExitCostNotionalKrw(record) {
  if (isPositiveDecimalString(record?.entryCostNotionalKrw)) {
    return record.entryCostNotionalKrw;
  }
  if (isPositiveDecimalString(record?.pnlEvidence?.entryCostNotionalKrw)) {
    return record.pnlEvidence.entryCostNotionalKrw;
  }
  return readLiveOpsCliAutonomousExitFilledNotionalKrw(record);
}

function readLiveOpsCliAutonomousExitFilledNotionalKrw(record) {
  if (isPositiveDecimalString(record?.filledNotionalKrw)) {
    return record.filledNotionalKrw;
  }
  if (
    isPositiveDecimalString(record?.terminalOrder?.requestedQuantity) &&
    isPositiveDecimalString(record?.terminalOrder?.requestedPrice) &&
    isDecimalEqual(record?.terminalOrder?.remainingQuantity ?? "0", "0")
  ) {
    return new Decimal(record.terminalOrder.requestedQuantity).mul(record.terminalOrder.requestedPrice).toFixed();
  }
  return "0";
}

function readLiveOpsCliAutonomousExitRealizedPnlKrw(record) {
  if (isDecimalString(record?.realizedPnlKrw)) {
    return record.realizedPnlKrw;
  }
  return "0";
}

function readLiveOpsCliAutonomousExitClosedAt(record) {
  if (!isNonEmptyRecord(record)) {
    return undefined;
  }
  return record.filledAt ?? record.terminalCheckedAt ?? record.closedAt ?? record.observedAt;
}

async function evaluateLiveOpsCliDailyBudgetReservation({ request, dailyUsage }) {
  if (!isPositiveDecimalString(request?.requestedNotionalKrw)) {
    return {
      reserved: false,
      reasonCode: "live_ops_daily_budget_request_malformed",
      message: "reservation 요청 금액이 올바르지 않아 broker 제출을 중단했습니다.",
    };
  }
  if (!isPositiveDecimalString(request?.budgetSnapshot?.dailyAutonomousNotionalLimitKrw)) {
    return {
      reserved: false,
      reasonCode: "live_ops_daily_budget_limit_missing",
      message: "일일 자동 주문 예산 한도 evidence가 없어 broker 제출을 중단했습니다.",
    };
  }
  if (!isNonNegativeDecimalString(request?.budgetSnapshot?.openPositionNotionalKrw)) {
    return {
      reserved: false,
      reasonCode: "live_ops_daily_budget_open_position_missing",
      message: "open position 예산 사용 evidence가 없어 broker 제출을 중단했습니다.",
    };
  }

  const reservedNotional = new Decimal(dailyUsage.reservedNotionalKrw);
  const openPositionNotional = new Decimal(request.budgetSnapshot.openPositionNotionalKrw);
  const snapshotUsed = isNonNegativeDecimalString(request.budgetSnapshot.dailyAutonomousNotionalUsedKrw)
    ? new Decimal(request.budgetSnapshot.dailyAutonomousNotionalUsedKrw)
    : undefined;
  const currentUsed = snapshotUsed === undefined
    ? reservedNotional.plus(openPositionNotional)
    : Decimal.max(snapshotUsed, reservedNotional.plus(openPositionNotional));
  const requestedNotional = new Decimal(request.requestedNotionalKrw);
  const limit = new Decimal(request.budgetSnapshot.dailyAutonomousNotionalLimitKrw);

  if (currentUsed.plus(requestedNotional).gt(limit)) {
    return {
      reserved: false,
      reasonCode: "live_ops_daily_budget_exceeded",
      message: "일일 자동 주문 예산을 초과해 broker 제출을 중단했습니다.",
      budgetUsage: {
        day: dailyUsage.day,
        reservedNotionalKrw: reservedNotional.toFixed(),
        currentUsedKrw: currentUsed.toFixed(),
        requestedNotionalKrw: requestedNotional.toFixed(),
        dailyAutonomousNotionalLimitKrw: limit.toFixed(),
      },
    };
  }

  return { reserved: true };
}

function createLiveOpsCliDailyReservationLockLease({
  day,
  acquiredAt,
  ttlMs,
  leaseId = randomUUID(),
  source = "live_ops_cli_daily_budget_reservation_lock",
}) {
  const acquiredAtMs = Date.parse(acquiredAt);
  const resolvedAcquiredAt = Number.isFinite(acquiredAtMs) ? new Date(acquiredAtMs) : new Date();
  return {
    source,
    day,
    leaseId,
    acquiredAt: resolvedAcquiredAt.toISOString(),
    expiresAt: new Date(resolvedAcquiredAt.getTime() + ttlMs).toISOString(),
    pid: process.pid,
    owner: liveOpsCliProcessOwner,
  };
}

function assertLiveOpsCliDailyReservationLockOwnerAvailable() {
  if (!hasMeaningfulValue(liveOpsCliProcessOwner?.bootId) || !hasMeaningfulValue(liveOpsCliProcessOwner?.processStartTime)) {
    throw new Error("LiveOpsCliDailyReservationLockOwnerUnavailable");
  }
}

async function releaseLiveOpsCliDailyReservationLockIfOwned(targetPath, leaseId) {
  const expected = await readLiveOpsCliDailyReservationLockState(targetPath, new Date().toISOString(), liveOpsCliDailyReservationLockLeaseMs);
  if (!expected.exists || expected.lease?.leaseId !== leaseId) {
    return;
  }
  await claimAndRemoveLiveOpsCliDailyReservationLock(targetPath, expected);
}

async function releaseLiveOpsCliRecoverableDailyReservationLock(targetPath, now, ttlMs) {
  const expected = await readLiveOpsCliDailyReservationLockState(targetPath, now, ttlMs);
  if (!expected.recoverable) {
    const error = new Error("LiveOpsCliDailyReservationLockNotRecoverable");
    error.code = "EEXIST";
    throw error;
  }
  await claimAndRemoveLiveOpsCliDailyReservationLock(targetPath, expected);
}

async function claimAndRemoveLiveOpsCliDailyReservationLock(targetPath, expected) {
  const claimPath = `${targetPath}.claimed-${expected.fingerprint}-${randomUUID()}`;
  try {
    await link(targetPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const claimed = await readLiveOpsCliDailyReservationLockState(claimPath, new Date().toISOString(), liveOpsCliDailyReservationLockLeaseMs);
  if (!claimed.exists || claimed.fingerprint !== expected.fingerprint) {
    await unlink(claimPath).catch(() => undefined);
    const error = new Error("LiveOpsCliDailyReservationLockNotRecoverable");
    error.code = "EEXIST";
    throw error;
  }
  const removable = await isLiveOpsCliDailyReservationLockClaimStillTarget(targetPath, claimPath);
  if (!removable) {
    await unlink(claimPath).catch(() => undefined);
    const error = new Error("LiveOpsCliDailyReservationLockNotRecoverable");
    error.code = "EEXIST";
    throw error;
  }
  await unlink(targetPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
  await unlink(claimPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
}

async function isLiveOpsCliDailyReservationLockClaimStillTarget(targetPath, claimPath) {
  try {
    let [targetMetadata, claimMetadata] = await Promise.all([stat(targetPath), stat(claimPath)]);
    if (targetMetadata.dev === claimMetadata.dev && targetMetadata.ino === claimMetadata.ino && claimMetadata.nlink > 2) {
      await removeLiveOpsCliOrphanDailyReservationLockClaims(targetPath, claimPath, targetMetadata);
      [targetMetadata, claimMetadata] = await Promise.all([stat(targetPath), stat(claimPath)]);
    }
    // 같은 inode의 target+claim 두 link만 있을 때만 target을 제거해 다른 fresh lock이나 경쟁 claim을 건드리지 않는다.
    return targetMetadata.dev === claimMetadata.dev
      && targetMetadata.ino === claimMetadata.ino
      && claimMetadata.nlink === 2;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeLiveOpsCliOrphanDailyReservationLockClaims(targetPath, claimPath, targetMetadata) {
  const directory = path.dirname(targetPath);
  const lockBasename = path.basename(targetPath);
  const orphanPrefixes = [`${lockBasename}.claimed-`, `${lockBasename}.tmp-`];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !orphanPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const candidatePath = path.join(directory, entry.name);
    if (candidatePath === claimPath) {
      continue;
    }
    try {
      const candidateMetadata = await stat(candidatePath);
      if (candidateMetadata.dev === targetMetadata.dev && candidateMetadata.ino === targetMetadata.ino) {
        // crash로 남은 같은 inode claim은 target CAS 전에 제거해야 nlink 고착으로 인한 영구 busy를 막는다.
        await unlink(candidatePath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function readLiveOpsCliDailyReservationLockState(targetPath, now, ttlMs) {
  const nowMs = Date.parse(now);
  const resolvedNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  let content;
  try {
    content = await readFile(targetPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, recoverable: false, fingerprint: "missing" };
    }
    throw error;
  }

  try {
    const lease = JSON.parse(content);
    if (!isLiveOpsCliDailyReservationLockLeaseSchema(lease)) {
      // 문법상 JSON이어도 lease 필수 필드가 없으면 owner를 신뢰할 수 없으므로 malformed TTL 복구 경로로 보낸다.
      return readLiveOpsCliMalformedDailyReservationLockState(targetPath, resolvedNowMs, ttlMs, "lease_schema_invalid");
    }
    const expiresAtMs = Date.parse(lease?.expiresAt);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= resolvedNowMs;
    const ownerActive = isLiveOpsCliLockOwnerActive(lease);
    return {
      exists: true,
      recoverable: expired && !ownerActive,
      lease,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({
          source: lease?.source,
          day: lease?.day,
          leaseId: lease?.leaseId,
          acquiredAt: lease?.acquiredAt,
          expiresAt: lease?.expiresAt,
          pid: lease?.pid,
          owner: lease?.owner,
        }))
        .digest("hex")
        .slice(0, 16),
    };
  } catch {
    return readLiveOpsCliMalformedDailyReservationLockState(targetPath, resolvedNowMs, ttlMs, "json_parse_failed");
  }
}

function isLiveOpsCliDailyReservationLockLeaseSchema(lease) {
  return hasMeaningfulValue(lease?.source)
    && hasMeaningfulValue(lease?.day)
    && hasMeaningfulValue(lease?.leaseId)
    && Number.isFinite(Date.parse(lease?.acquiredAt))
    && Number.isFinite(Date.parse(lease?.expiresAt))
    && Number.isInteger(lease?.pid)
    && lease.pid > 0
    && hasMeaningfulValue(lease?.owner?.bootId)
    && hasMeaningfulValue(lease?.owner?.processStartTime);
}

async function readLiveOpsCliMalformedDailyReservationLockState(targetPath, resolvedNowMs, ttlMs, reason) {
  const metadata = await stat(targetPath);
  return {
    exists: true,
    recoverable: metadata.mtimeMs + ttlMs <= resolvedNowMs,
    lease: undefined,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({
        malformed: true,
        reason,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
      }))
      .digest("hex")
      .slice(0, 16),
  };
}

function isLiveOpsCliLockOwnerActive(lease) {
  const pid = lease?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  const expectedOwner = lease?.owner;
  if (!hasMeaningfulValue(expectedOwner?.bootId) || !hasMeaningfulValue(expectedOwner?.processStartTime)) {
    return true;
  }
  const actualBootId = readLiveOpsCliBootId();
  if (!hasMeaningfulValue(actualBootId)) {
    return true;
  }
  if (expectedOwner.bootId !== actualBootId) {
    return false;
  }
  const actualProcess = readLiveOpsCliProcessSnapshot(pid);
  if (actualProcess.status === "missing") {
    return false;
  }
  if (actualProcess.status !== "found") {
    return true;
  }
  if (actualProcess.processStartTime !== expectedOwner.processStartTime) {
    return false;
  }
  if (actualProcess.state === "Z") {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function createLiveOpsCliProcessOwnerSnapshot(pid) {
  const processSnapshot = readLiveOpsCliProcessSnapshot(pid);
  return {
    pid,
    bootId: readLiveOpsCliBootId(),
    processStartTime: processSnapshot.status === "found" ? processSnapshot.processStartTime : undefined,
  };
}

function readLiveOpsCliBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

function readLiveOpsCliProcessSnapshot(pid) {
  try {
    const statContent = readFileSync(`/proc/${pid}/stat`, "utf8");
    const lastParenIndex = statContent.lastIndexOf(")");
    if (lastParenIndex < 0) {
      return { status: "unknown" };
    }
    const fields = statContent.slice(lastParenIndex + 2).trim().split(/\s+/u);
    return hasMeaningfulValue(fields[0]) && hasMeaningfulValue(fields[19])
      ? { status: "found", state: fields[0], processStartTime: fields[19] }
      : { status: "unknown" };
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "missing" } : { status: "unknown" };
  }
}

function assertLiveOpsCliPathOutsideRepository(targetPath, label) {
  const relative = path.relative(liveOpsCliRepositoryRoot, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error(`${label}는 저장소 밖 경로여야 합니다.`);
  }
}

function assertLiveOpsCliAttemptPathSegment(attemptId) {
  if (!isLiveOpsCliLiveAttemptId(attemptId)) {
    throw new Error("LiveOpsCleanupAttemptIdInvalid");
  }
}

function assertLiveOpsCliReservationDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(day))) {
    throw new Error("LiveOpsReservationDayInvalid");
  }
}

export function createLiveOpsCliUpbitLiveBroker({
  env,
  fetchImpl = fetch,
  clock = () => new Date().toISOString(),
  nonceFactory = randomUUID,
} = {}) {
  const accessKey = env?.SEEMIRAI_UPBIT_ACCESS_KEY;
  const secretKey = env?.SEEMIRAI_UPBIT_SECRET_KEY;
  if (!hasMeaningfulValue(accessKey) || !hasMeaningfulValue(secretKey)) {
    throw new Error("LiveOpsCliUpbitCredentialsMissing");
  }
  const privateClient = createLiveOpsCliUpbitPrivateClient({
    accessKey,
    secretKey,
    fetchImpl,
    nonceFactory,
  });
  const submittedOrderIds = new Set();

  return {
    async submitOrder(submission) {
      assertLiveOpsCliUpbitSubmission(submission);
      const input = toLiveOpsCliUpbitCreateLimitOrderInput(submission);
      let payload;
      try {
        payload = await privateClient.requestJson({
          method: "POST",
          pathname: "/v1/orders",
          bodyParams: [
            { key: "market", value: input.market },
            { key: "side", value: input.side },
            { key: "volume", value: input.volume },
            { key: "price", value: input.price },
            { key: "ord_type", value: "limit" },
            { key: "identifier", value: input.identifier },
            { key: "time_in_force", value: "post_only" },
          ],
        });
      } catch (error) {
        if (!isLiveOpsCliDuplicateIdentifierError(error)) {
          throw error;
        }
        const recoveredPayload = await privateClient.requestJson({
          method: "GET",
          pathname: "/v1/order",
          queryParams: [{ key: "identifier", value: input.identifier }],
        });
        const recoveredOrder = toLiveOpsCliBrokerOrder(recoveredPayload, {
          operation: "getOrder",
          clock,
          recovery: "duplicate_identifier_lookup",
        });
        assertLiveOpsCliRecoveredOrderMatchesSubmission(recoveredOrder, submission, input.identifier);
        // duplicate_identifier 복구 주문도 같은 runtime의 제출 결과이므로 즉시 cleanup 취소할 수 있게 소유권을 기록한다.
        submittedOrderIds.add(recoveredOrder.brokerOrderId);
        return recoveredOrder;
      }
      const brokerOrder = toLiveOpsCliBrokerOrder(payload, {
        operation: "submitOrder",
        clock,
        identifierSource: "intent",
      });
      submittedOrderIds.add(brokerOrder.brokerOrderId);
      return brokerOrder;
    },
    async cancelOrder(orderId) {
      if (!submittedOrderIds.has(orderId)) {
        // 같은 foreground runtime이 제출한 uuid만 취소해 임의 주문 취소 side effect를 막는다.
        throw new Error("LiveOpsCliCancelOrderNotOwnedByRuntime");
      }
      const payload = await privateClient.requestJson({
        method: "DELETE",
        pathname: "/v1/order",
        queryParams: [{ key: "uuid", value: orderId }],
      });
      return toLiveOpsCliCancelRequestedOrder(toLiveOpsCliBrokerOrder(payload, {
        operation: "cancelOrder",
        clock,
      }));
    },
    async getOrder(orderId) {
      try {
        const payload = await privateClient.requestJson({
          method: "GET",
          pathname: "/v1/order",
          queryParams: [{ key: "uuid", value: orderId }],
        });
        return toLiveOpsCliBrokerOrder(payload, {
          operation: "getOrder",
          clock,
        });
      } catch (error) {
        if (error?.upbitErrorName === "order_not_found" || error?.status === 404) {
          return undefined;
        }
        throw error;
      }
    },
    async listOpenOrders(market) {
      const orders = [];
      let page = 1;
      while (true) {
        const payload = await privateClient.requestJson({
          method: "GET",
          pathname: "/v1/orders/open",
          queryParams: [
            ...(market === undefined ? [] : [{ key: "market", value: market }]),
            { key: "states[]", value: ["wait", "watch"] },
            { key: "page", value: page },
            { key: "limit", value: 100 },
            { key: "order_by", value: "asc" },
          ],
        });
        if (!Array.isArray(payload)) {
          throw new Error("LiveOpsCliOpenOrdersPayloadMalformed");
        }
        const pageOrders = payload.map((order) => toLiveOpsCliBrokerOrder(order, {
          operation: "listOpenOrders",
          clock,
        }));
        orders.push(...pageOrders);
        if (pageOrders.length < 100) {
          break;
        }
        page += 1;
      }
      return orders;
    },
    async getBalances() {
      const payload = await privateClient.requestJson({
        method: "GET",
        pathname: "/v1/accounts",
      });
      if (!Array.isArray(payload)) {
        throw new Error("LiveOpsCliAccountsPayloadMalformed");
      }
      const capturedAt = clock();
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt,
        balances: payload.map((account) => {
          const available = normalizeLiveOpsCliDecimalString(account?.balance);
          const locked = normalizeLiveOpsCliDecimalString(account?.locked);
          return {
            currency: String(account?.currency ?? ""),
            available,
            locked,
            total: new Decimal(available).plus(locked).toFixed(),
            updatedAt: capturedAt,
          };
        }),
      };
    },
  };
}

function createLiveOpsCliUpbitPrivateClient({
  accessKey,
  secretKey,
  fetchImpl,
  nonceFactory,
  baseUrl = liveOpsUpbitPrivateApiBaseUrl,
}) {
  return {
    async requestJson({ method, pathname, queryParams = [], bodyParams = [] }) {
      const body = bodyParams.length === 0 ? undefined : JSON.stringify(toLiveOpsCliJsonBody(bodyParams));
      const queryString = buildLiveOpsCliUpbitQueryString(bodyParams.length === 0 ? queryParams : bodyParams);
      const url = new URL(pathname, baseUrl);
      const urlQueryString = buildLiveOpsCliUpbitUrlQueryString(queryParams);
      if (urlQueryString.length > 0) {
        url.search = urlQueryString;
      }
      const headers = {
        accept: "application/json",
        authorization: buildLiveOpsCliUpbitAuthHeader({
          accessKey,
          secretKey,
          nonce: nonceFactory(),
          queryString,
        }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      };
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        throw new LiveOpsCliUpbitPrivateRequestError({
          status: 0,
          upbitErrorName: "network_error",
          message: "Upbit private API 네트워크 응답을 받지 못했습니다.",
        });
      }
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => undefined);
        throw new LiveOpsCliUpbitPrivateRequestError({
          status: response.status,
          upbitErrorName: String(errorPayload?.error?.name ?? "provider_error"),
          message: "Upbit private API가 요청을 거부했습니다.",
        });
      }
      return response.json();
    },
  };
}

class LiveOpsCliUpbitPrivateRequestError extends Error {
  constructor({ status, upbitErrorName, message }) {
    super(message);
    this.name = "LiveOpsCliUpbitPrivateRequestError";
    this.status = status;
    this.upbitErrorName = upbitErrorName;
  }
}

function buildLiveOpsCliUpbitAuthHeader({ accessKey, secretKey, nonce, queryString }) {
  const payload = {
    access_key: accessKey,
    nonce,
    ...(queryString.length === 0 ? {} : {
      query_hash: createHash("sha512").update(queryString, "utf8").digest("hex"),
      query_hash_alg: "SHA512",
    }),
  };
  const signingInput = [
    Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  ].join(".");
  const signature = createHmac("sha512", secretKey).update(signingInput, "utf8").digest("base64url");
  return `${["Bea", "rer"].join("")} ${signingInput}.${signature}`;
}

function buildLiveOpsCliUpbitQueryString(params = []) {
  return params.flatMap((param) => toLiveOpsCliQueryStringEntries(param, (value) => value)).join("&");
}

function buildLiveOpsCliUpbitUrlQueryString(params = []) {
  return params.flatMap((param) => toLiveOpsCliQueryStringEntries(param, encodeURIComponent)).join("&");
}

function toLiveOpsCliQueryStringEntries(param, encodePart) {
  const values = Array.isArray(param.value) ? param.value : [param.value];
  return values.map((value) => `${encodePart(param.key).replace(/%5B/gu, "[").replace(/%5D/gu, "]")}=${encodePart(String(value)).replace(/%5B/gu, "[").replace(/%5D/gu, "]")}`);
}

function toLiveOpsCliJsonBody(params) {
  const body = {};
  for (const param of params) {
    body[param.key] = param.value;
  }
  return body;
}

function assertLiveOpsCliUpbitSubmission(submission) {
  const violations = [];
  const intent = submission?.intent;
  if (intent?.exchangeId !== "upbit_krw_spot") {
    violations.push("Upbit live ops broker exchangeId는 upbit_krw_spot이어야 합니다");
  }
  if (intent?.market !== "KRW-BTC") {
    violations.push("Upbit live ops broker market은 KRW-BTC만 허용합니다");
  }
  if (intent?.side !== "BUY" && intent?.side !== "SELL") {
    violations.push("Upbit live ops broker는 BUY 또는 SELL LIMIT 주문만 허용합니다");
  }
  if (intent?.orderType !== "LIMIT" || intent?.postOnly !== true || intent?.timeInForce !== "POST_ONLY") {
    violations.push("Upbit live ops broker는 LIMIT + POST_ONLY 주문만 허용합니다");
  }
  if (!hasMeaningfulValue(intent?.idempotencyKey) || String(intent.idempotencyKey).length > liveOpsCliUpbitIdentifierMaxLength) {
    violations.push(`Upbit live ops broker identifier는 1자 이상 ${liveOpsCliUpbitIdentifierMaxLength}자 이하여야 합니다`);
  }
  if (!isPositiveDecimalString(intent?.requestedQuantity) || !isPositiveDecimalString(intent?.requestedPrice)) {
    violations.push("Upbit live ops broker 주문 수량과 가격은 양수 decimal 문자열이어야 합니다");
  }
  if (isPositiveDecimalString(intent?.requestedQuantity) && isPositiveDecimalString(intent?.requestedPrice)) {
    const actualNotional = new Decimal(intent.requestedQuantity).mul(intent.requestedPrice);
    if (actualNotional.lt(5_000) || actualNotional.gt(10_000)) {
      violations.push("Upbit live ops broker 주문 금액은 5,000 KRW 이상 10,000 KRW 이하여야 합니다");
    }
  }
  if (violations.length > 0) {
    throw new Error(`LiveOpsCliUpbitSubmissionBlocked:${violations.join("; ")}`);
  }
}

function toLiveOpsCliUpbitCreateLimitOrderInput(submission) {
  return {
    market: submission.intent.market,
    side: submission.intent.side === "SELL" ? "ask" : "bid",
    volume: submission.intent.requestedQuantity,
    price: submission.intent.requestedPrice,
    identifier: submission.intent.idempotencyKey,
  };
}

function toLiveOpsCliBrokerOrder(payload, { operation, clock, identifierSource, recovery } = {}) {
  if (!hasMeaningfulValue(payload?.uuid) || !hasMeaningfulValue(payload?.market)) {
    throw new Error("LiveOpsCliUpbitOrderPayloadMalformed");
  }
  const remainingQuantity = normalizeLiveOpsCliDecimalString(payload.remaining_volume ?? payload.volume);
  const requestedQuantity = normalizeLiveOpsCliOptionalDecimalString(payload.volume) ?? remainingQuantity;
  const paidFee = normalizeLiveOpsCliOptionalDecimalString(payload.paid_fee);
  return {
    brokerOrderId: String(payload.uuid),
    idempotencyKey: String(payload.identifier ?? ""),
    exchangeId: "upbit_krw_spot",
    market: String(payload.market),
    side: mapLiveOpsCliUpbitSide(payload.side),
    orderType: mapLiveOpsCliUpbitOrderType(payload.ord_type),
    status: mapLiveOpsCliUpbitOrderStatus(payload.state),
    requestedQuantity,
    remainingQuantity,
    requestedPrice: normalizeLiveOpsCliOptionalDecimalString(payload.price),
    acceptedAt: hasMeaningfulValue(payload.created_at) ? String(payload.created_at) : clock(),
    updatedAt: clock(),
    ...(isNonNegativeDecimalString(paidFee)
      ? { paidFee, feeCurrency: readLiveOpsCliMarketQuoteCurrency(payload.market) }
      : {}),
    metadata: {
      source: "upbit_private_order_safe_summary",
      upbitLiveBrokerOperation: operation ?? "unknown",
      ...(identifierSource === undefined ? {} : { upbitLiveBrokerIdentifierSource: identifierSource }),
      ...(recovery === undefined ? {} : { upbitLiveBrokerRecovery: recovery }),
      ...(!hasMeaningfulValue(payload.volume) && hasMeaningfulValue(payload.remaining_volume) ? { upbitVolumeSource: "remaining_volume_fallback" } : {}),
      ...(hasMeaningfulValue(payload.time_in_force) ? { upbitTimeInForce: mapLiveOpsCliUpbitTimeInForce(payload.time_in_force) } : {}),
    },
  };
}

function toLiveOpsCliCancelRequestedOrder(order) {
  if (order.status !== "ACCEPTED" && order.status !== "PARTIALLY_FILLED" && order.status !== "OPEN") {
    return order;
  }
  return {
    ...order,
    status: "CANCEL_REQUESTED",
  };
}

function mapLiveOpsCliUpbitSide(side) {
  if (side === "bid") return "BUY";
  if (side === "ask") return "SELL";
  return String(side ?? "UNKNOWN").toUpperCase();
}

function mapLiveOpsCliUpbitOrderType(orderType) {
  return orderType === "limit" ? "LIMIT" : String(orderType ?? "UNKNOWN").toUpperCase();
}

function mapLiveOpsCliUpbitTimeInForce(value) {
  if (value === "post_only") return "POST_ONLY";
  if (value === "ioc") return "IOC";
  if (value === "fok") return "FOK";
  return String(value).toUpperCase();
}

function mapLiveOpsCliUpbitOrderStatus(state) {
  switch (state) {
    case "wait":
      return "ACCEPTED";
    case "watch":
      return "OPEN";
    case "done":
      return "FILLED";
    case "cancel":
      return "CANCELED";
    default:
      return String(state ?? "UNKNOWN").toUpperCase();
  }
}

function normalizeLiveOpsCliDecimalString(value) {
  if (!hasMeaningfulValue(value)) {
    return "0";
  }
  return new Decimal(String(value)).toFixed();
}

function normalizeLiveOpsCliOptionalDecimalString(value) {
  if (!hasMeaningfulValue(value)) {
    return null;
  }
  return new Decimal(String(value)).toFixed();
}

function isLiveOpsCliDuplicateIdentifierError(error) {
  return [
    "duplicate_identifier",
    "identifier_already_used",
    "used_identifier",
  ].includes(String(error?.upbitErrorName ?? ""));
}

function assertLiveOpsCliRecoveredOrderMatchesSubmission(order, submission, expectedIdentifier) {
  const intent = submission.intent;
  const violations = [];
  if (order.idempotencyKey !== expectedIdentifier) {
    violations.push("identifier mismatch");
  }
  if (order.market !== intent.market || order.side !== intent.side || order.orderType !== intent.orderType) {
    violations.push("order fingerprint mismatch");
  }
  if (!isDecimalEqual(order.requestedQuantity, intent.requestedQuantity) || !isDecimalEqual(order.requestedPrice, intent.requestedPrice)) {
    violations.push("order decimal fingerprint mismatch");
  }
  if (violations.length > 0) {
    throw new Error(`LiveOpsCliDuplicateIdentifierRecoveryBlocked:${violations.join("; ")}`);
  }
}

export function createLiveOpsCliDatabasePrivateReadProvider(pool) {
  return {
    async listOpenOrders(market) {
      const marketFilter = market === undefined ? "" : "AND market = $1";
      const params = market === undefined ? [] : [market];
      const result = await pool.query(`
        WITH latest_run AS (
          SELECT id
          FROM live_reconcile_runs
          ORDER BY started_at DESC
          LIMIT 1
        )
        SELECT
          id,
          exchange_order_id,
          identifier,
          identity_fingerprint,
          market,
          side,
          status,
          requested_quantity,
          remaining_quantity,
          requested_price,
          source,
          captured_at
        FROM live_reconcile_exchange_order_snapshots
        WHERE run_id = (SELECT id FROM latest_run)
          ${marketFilter}
        ORDER BY captured_at DESC, id DESC
      `, params);
      return filterLiveOpsCliCanonicalOpenOrderRows(result.rows).map((row) => ({
        brokerOrderId: row.exchange_order_id ?? null,
        idempotencyKey: row.identifier ?? null,
        exchangeId: "upbit_krw_spot",
        market: row.market,
        side: row.side,
        orderType: "LIMIT",
        status: row.status,
        requestedQuantity: decimalRowValue(row.requested_quantity),
        remainingQuantity: decimalRowValue(row.remaining_quantity),
        requestedPrice: decimalRowValue(row.requested_price),
        updatedAt: toIsoString(row.captured_at),
      }));
    },
    async getBalances() {
      const result = await pool.query(`
        WITH latest_run AS (
          SELECT id
          FROM live_reconcile_runs
          ORDER BY started_at DESC
          LIMIT 1
        )
        SELECT currency, available, locked, total, captured_at
        FROM live_reconcile_balance_snapshots
        WHERE run_id = (SELECT id FROM latest_run)
        ORDER BY currency ASC, captured_at DESC
      `);
      const capturedAt = result.rows.reduce((latest, row) => {
        const current = toIsoString(row.captured_at);
        return latest === null || (current !== null && current > latest) ? current : latest;
      }, null);
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt,
        balances: result.rows.map((row) => ({
          currency: row.currency,
          available: decimalRowValue(row.available),
          locked: decimalRowValue(row.locked),
          total: decimalRowValue(row.total),
          updatedAt: toIsoString(row.captured_at),
        })),
      };
    },
  };
}

function filterLiveOpsCliCanonicalOpenOrderRows(rows) {
  const findCanonicalIdentity = createLiveOpsCliExchangeOrderIdentityResolver(rows);
  const seenCanonicalIdentities = new Set();
  const openRows = [];

  for (const row of rows) {
    const identityKeys = getLiveOpsCliCanonicalExchangeOrderIdentityKeys(row, findCanonicalIdentity);
    const alreadySeen = identityKeys.some((identityKey) => seenCanonicalIdentities.has(identityKey));
    if (isLiveOpsCliTerminalExchangeOrderRow(row)) {
      // 최신 terminal evidence가 있으면 같은 uuid/identifier bridge의 이전 open snapshot을 노출에서 제거한다.
      addLiveOpsCliIdentityKeys(seenCanonicalIdentities, identityKeys);
      continue;
    }

    if (!isLiveOpsCliOpenExchangeOrderRow(row)) {
      if (alreadySeen) {
        addLiveOpsCliIdentityKeys(seenCanonicalIdentities, identityKeys);
      }
      continue;
    }

    if (alreadySeen) {
      // bridge row가 늦게 나타나도 연결된 다른 identity를 닫아 뒤쪽 split snapshot 중복 집계를 막는다.
      addLiveOpsCliIdentityKeys(seenCanonicalIdentities, identityKeys);
      continue;
    }

    addLiveOpsCliIdentityKeys(seenCanonicalIdentities, identityKeys);
    openRows.push(row);
  }

  return openRows;
}

function createLiveOpsCliExchangeOrderIdentityResolver(rows) {
  const parents = new Map();

  function find(identityKey) {
    const parent = parents.get(identityKey);
    if (parent === undefined) {
      parents.set(identityKey, identityKey);
      return identityKey;
    }
    if (parent === identityKey) {
      return identityKey;
    }
    const canonical = find(parent);
    parents.set(identityKey, canonical);
    return canonical;
  }

  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parents.set(rightRoot, leftRoot);
    }
  }

  for (const row of rows) {
    const identityKeys = getLiveOpsCliRawExchangeOrderIdentityKeys(row);
    if (identityKeys.length === 0) {
      continue;
    }
    find(identityKeys[0]);
    for (const identityKey of identityKeys.slice(1)) {
      union(identityKeys[0], identityKey);
    }
  }

  return find;
}

function getLiveOpsCliCanonicalExchangeOrderIdentityKeys(row, findCanonicalIdentity) {
  return Array.from(new Set(
    getLiveOpsCliRawExchangeOrderIdentityKeys(row).map((identityKey) => findCanonicalIdentity(identityKey)),
  ));
}

function getLiveOpsCliRawExchangeOrderIdentityKeys(row) {
  const identityKeys = [];
  if (hasMeaningfulValue(row.exchange_order_id)) {
    identityKeys.push(`uuid:${row.exchange_order_id}`);
  }
  if (hasMeaningfulValue(row.identifier)) {
    identityKeys.push(`identifier:${row.identifier}`);
  }
  return identityKeys;
}

function addLiveOpsCliIdentityKeys(target, identityKeys) {
  for (const identityKey of identityKeys) {
    target.add(identityKey);
  }
}

function isLiveOpsCliOpenExchangeOrderRow(row) {
  const source = String(row.source ?? "").toLowerCase();
  const status = String(row.status ?? "").toUpperCase();
  const remainingQuantityUnknown = row.remaining_quantity === null || row.remaining_quantity === undefined;
  return (
    (source === "open" || source === "lookup" || source === "ws") &&
    (status === "OPEN" || status === "ACCEPTED" || status === "WAIT" || status === "WATCH") &&
    // 잔량 정규화가 실패한 open 상태를 0으로 간주하면 cleanup closeout이 미체결 주문을 가릴 수 있다.
    (remainingQuantityUnknown || isPositiveDecimalString(decimalRowValue(row.remaining_quantity)))
  );
}

function isLiveOpsCliTerminalExchangeOrderRow(row) {
  const status = String(row.status ?? "").toUpperCase();
  return (
    status === "DONE" ||
    status === "CANCEL" ||
    status === "CANCELED" ||
    status === "CANCELLED" ||
    status === "FILLED" ||
    status === "CLOSED"
  );
}

export function createLiveOpsCliDatabaseReconcileStatusProvider(pool) {
  return {
    async getReconcileStatus() {
      const result = await pool.query(`
        WITH latest_run AS (
          SELECT id, status, started_at, finished_at, correlation_id
          FROM live_reconcile_runs
          ORDER BY started_at DESC
          LIMIT 1
        ),
        counts AS (
          SELECT
            (SELECT count(*)::int FROM live_reconcile_balance_snapshots WHERE run_id = latest_run.id) AS balance_snapshot_count,
            (SELECT count(*)::int FROM live_reconcile_exchange_order_snapshots WHERE run_id = latest_run.id) AS exchange_order_snapshot_count,
            (
              SELECT count(*)::int
              FROM live_reconcile_exchange_order_snapshots
              WHERE run_id = latest_run.id
                AND upper(status) IN ('OPEN', 'ACCEPTED', 'WAIT', 'WATCH')
                AND (remaining_quantity IS NULL OR remaining_quantity > 0)
            ) AS open_order_count,
            (SELECT count(*)::int FROM live_reconcile_mismatch_evidence WHERE run_id = latest_run.id) AS mismatch_count,
            (
              SELECT array_remove(array_agg(DISTINCT mismatch_type), NULL)
              FROM live_reconcile_mismatch_evidence
              WHERE run_id = latest_run.id
            ) AS mismatch_types
          FROM latest_run
        )
        SELECT latest_run.*, counts.*
        FROM latest_run
        CROSS JOIN counts
      `);
      const row = result.rows[0];
      if (row === undefined) {
        return {
          lastReconcileAt: null,
          result: "SKIPPED",
          mismatchCount: null,
          openOrderCount: null,
          balanceStatus: "UNAVAILABLE",
          websocketStatus: "DISCONNECTED",
          actionRequired: "reconcile 실행 필요",
          message: "아직 완료된 실계좌 reconcile evidence가 없어 신규 주문 전 수동 확인이 필요합니다.",
          trace: { source: "live_ops_cli_database_reconcile", reason: "reconcile_not_run" },
        };
      }

      const mismatchTypes = Array.isArray(row.mismatch_types) ? row.mismatch_types : [];
      const mismatchCount = numberRowValue(row.mismatch_count);
      const reconcileResult = mapLiveOpsCliReconcileResult(row.status, mismatchCount);
      const actionRequired = reconcileResult === "SUCCESS"
        ? "없음"
        : (mismatchCount > 0
          ? "저장된 reconcile mismatch evidence를 확인하고 수동 검토를 닫으세요."
          : "최신 reconcile run 상태와 worker 로그를 확인한 뒤 신규 주문 전 재대사를 완료하세요.");
      const message = reconcileResult === "SUCCESS"
        ? "최신 실계좌 reconcile evidence를 읽었습니다."
        : (mismatchCount > 0
          ? "실계좌 상태 대조에서 불일치가 발견되었습니다."
          : "최신 실계좌 reconcile evidence가 정상 완료 상태가 아닙니다.");
      return {
        lastReconcileAt: toIsoString(row.finished_at ?? row.started_at),
        result: reconcileResult,
        mismatchCount,
        openOrderCount: numberRowValue(row.open_order_count),
        balanceStatus: mapLiveOpsCliBalanceStatus(numberRowValue(row.balance_snapshot_count), mismatchTypes),
        websocketStatus: mismatchTypes.includes("WEBSOCKET_GAP_MANUAL_REVIEW") ? "DEGRADED" : "CONNECTED",
        actionRequired,
        message,
        trace: {
          source: "live_ops_cli_database_reconcile",
          runId: row.id,
          ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
        },
      };
    },
  };
}

export function createLiveOpsCliDatabasePreflightReconcileRecorder(pool) {
  return {
    async recordPreflight({ market, openOrders, balanceSnapshot, observedAt }) {
      const balances = normalizeLiveOpsCliPreflightBalanceSnapshots(balanceSnapshot, observedAt);
      const orderSnapshots = normalizeLiveOpsCliPreflightOrderSnapshots(openOrders, market, observedAt);
      const mismatchEvidence = createLiveOpsCliPreflightMismatchEvidence(orderSnapshots, observedAt);
      const status = mismatchEvidence.length > 0 ? "MANUAL_REVIEW_REQUIRED" : "COMPLETED";
      const idempotencyKey = createLiveOpsCliPreflightReconcileIdempotencyKey({
        market,
        balances,
        orderSnapshots,
        observedAt,
      });
      const correlationId = createLiveOpsCliEvidenceId("preflight-reconcile", `${market}:${observedAt}`);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const metadata = {
          source: "live_ops_cli_private_read_preflight",
          market,
          open_order_count: orderSnapshots.length,
          balance_snapshot_count: balances.length,
        };
        const insertedRun = await client.query(`
          INSERT INTO live_reconcile_runs (
            idempotency_key,
            status,
            started_at,
            guard_profile,
            source_summary,
            correlation_id,
            metadata_json
          )
          VALUES (
            $1,
            'RUNNING',
            $2,
            'LIVE_OPS_PRIVATE_READ_PREFLIGHT',
            'live:ops private read preflight reconcile',
            $3,
            $4::jsonb
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id, status, started_at, finished_at
        `, [idempotencyKey, observedAt, correlationId, JSON.stringify(metadata)]);
        const existingRun = insertedRun.rows[0] === undefined
          ? await client.query(`
              SELECT id, status, started_at, finished_at
              FROM live_reconcile_runs
              WHERE idempotency_key = $1
              LIMIT 1
            `, [idempotencyKey])
          : { rows: [] };
        const run = insertedRun.rows[0] ?? existingRun.rows[0];
        if (run === undefined) {
          throw new Error("LiveOpsCliPreflightReconcileRunMissing");
        }
        const created = insertedRun.rows[0] !== undefined;

        if (created) {
          for (const balance of balances) {
            await client.query(`
              INSERT INTO live_reconcile_balance_snapshots (
                run_id,
                currency,
                available,
                locked,
                total,
                captured_at,
                source,
                metadata_json
              )
              VALUES ($1, $2, $3, $4, $5, $6, 'REST', $7::jsonb)
              ON CONFLICT DO NOTHING
            `, [
              run.id,
              balance.currency,
              balance.available,
              balance.locked,
              balance.total,
              balance.capturedAt,
              JSON.stringify(balance.metadata),
            ]);
          }

          for (const order of orderSnapshots) {
            await client.query(`
              INSERT INTO live_reconcile_exchange_order_snapshots (
                run_id,
                exchange_order_id,
                identifier,
                identity_fingerprint,
                market,
                side,
                status,
                requested_quantity,
                remaining_quantity,
                requested_price,
                source,
                captured_at,
                metadata_json
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11, $12::jsonb)
              ON CONFLICT DO NOTHING
            `, [
              run.id,
              order.exchangeOrderId,
              order.identifier,
              order.identityFingerprint,
              order.market,
              order.side,
              order.status,
              order.requestedQuantity,
              order.remainingQuantity,
              order.requestedPrice,
              order.capturedAt,
              JSON.stringify(order.metadata),
            ]);
          }

          for (const evidence of mismatchEvidence) {
            await client.query(`
              INSERT INTO live_reconcile_mismatch_evidence (
                run_id,
                mismatch_type,
                severity,
                market,
                order_identity,
                message,
                action,
                evidence_fingerprint,
                trace_json,
                occurred_at
              )
              VALUES ($1, 'UNTRACKED_EXCHANGE_OPEN_ORDER', 'ERROR', $2, $3, $4, $5, $6, $7::jsonb, $8)
              ON CONFLICT DO NOTHING
            `, [
              run.id,
              evidence.market,
              evidence.orderIdentity,
              evidence.message,
              evidence.action,
              evidence.evidenceFingerprint,
              JSON.stringify(evidence.trace),
              evidence.occurredAt,
            ]);
          }

          // preflight DB write가 완료되어야만 같은 tick의 broker 제출 guard가 reconcileFresh로 전진할 수 있다.
          await client.query(`
            UPDATE live_reconcile_runs
            SET status = $2,
                finished_at = $3,
                metadata_json = metadata_json || $4::jsonb
            WHERE id = $1
              AND status = 'RUNNING'
          `, [
            run.id,
            status,
            observedAt,
            JSON.stringify({
              final_status: status,
              mismatch_evidence_count: mismatchEvidence.length,
            }),
          ]);
        }

        await client.query("COMMIT");
        return {
          created,
          runId: run.id,
          idempotencyKey,
          correlationId,
          status: created ? status : run.status,
          balanceSnapshotCount: balances.length,
          exchangeOrderSnapshotCount: orderSnapshots.length,
          mismatchCount: mismatchEvidence.length,
          mismatchTypes: mismatchEvidence.length > 0 ? ["UNTRACKED_EXCHANGE_OPEN_ORDER"] : [],
          recordedAt: observedAt,
          source: "live_ops_cli_private_read_preflight",
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function shouldCreateLiveOpsCliPrivateReadPreflightReconcile(reconcileStatus, productionRuntime, openOrders, observedAt) {
  if (productionRuntime?.preflightReconcileRecorder === undefined) {
    return false;
  }
  const reason = reconcileStatus?.trace?.reason;
  if (reconcileStatus?.result === "SKIPPED" && reason === "reconcile_not_run") {
    return true;
  }
  if (isLiveOpsCliCleanReconcileStatus(reconcileStatus) && !isLiveOpsCliFreshReconcileStatus(reconcileStatus, observedAt)) {
    // 오래된 clean evidence는 현재 private read와 같은 tick의 증거가 아니므로 fresh preflight run으로 갱신한다.
    return true;
  }
  // 최신 DB evidence가 clean이어도 현재 private read에 open order가 있으면 새 manual-review evidence로 신규 제출을 닫는다.
  return Array.isArray(openOrders) && openOrders.length > 0 && isLiveOpsCliCleanReconcileStatus(reconcileStatus);
}

function isLiveOpsCliCleanReconcileStatus(reconcileStatus) {
  const mismatchCount = Number.isFinite(Number(reconcileStatus?.mismatchCount))
    ? Number(reconcileStatus.mismatchCount)
    : null;
  return reconcileStatus?.result === "SUCCESS" && mismatchCount === 0 && reconcileStatus?.balanceStatus === "OK";
}

function isLiveOpsCliFreshReconcileStatus(reconcileStatus, observedAt, maxAgeMs = liveOpsCliPreflightReconcileFreshnessMs) {
  if (!isLiveOpsCliCleanReconcileStatus(reconcileStatus) || !hasMeaningfulValue(reconcileStatus?.lastReconcileAt)) {
    return false;
  }
  const observedTime = Date.parse(String(observedAt));
  const reconcileTime = Date.parse(String(reconcileStatus.lastReconcileAt));
  if (!Number.isFinite(observedTime) || !Number.isFinite(reconcileTime)) {
    return false;
  }
  const ageMs = observedTime - reconcileTime;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function normalizeLiveOpsCliPreflightBalanceSnapshots(balanceSnapshot, observedAt) {
  if (!Array.isArray(balanceSnapshot?.balances) || balanceSnapshot.balances.length === 0) {
    throw new Error("LiveOpsCliPreflightBalanceSnapshotMissing");
  }

  return balanceSnapshot.balances.map((balance) => {
    if (!hasMeaningfulValue(balance?.currency) || !isNonNegativeDecimalString(balance?.available) || !isNonNegativeDecimalString(balance?.locked)) {
      throw new Error("LiveOpsCliPreflightBalanceSnapshotMalformed");
    }
    const available = new Decimal(balance.available).toFixed();
    const locked = new Decimal(balance.locked).toFixed();
    return {
      currency: String(balance.currency),
      available,
      locked,
      total: new Decimal(available).plus(locked).toFixed(),
      capturedAt: balance.updatedAt ?? balanceSnapshot.capturedAt ?? observedAt,
      metadata: {
        source: "live_ops_cli_private_read_preflight",
      },
    };
  });
}

function normalizeLiveOpsCliPreflightOrderSnapshots(openOrders, market, observedAt) {
  if (!Array.isArray(openOrders)) {
    throw new Error("LiveOpsCliPreflightOpenOrdersMalformed");
  }

  return openOrders.map((order) => {
    const side = normalizeLiveOpsCliPreflightOrderSide(order?.side);
    const requestedQuantitySource = order?.requestedQuantity ?? order?.remainingQuantity;
    const requestedQuantity = normalizeLiveOpsCliPositiveDecimal(requestedQuantitySource, "LiveOpsCliPreflightOrderQuantityMalformed");
    const remainingQuantity = normalizeLiveOpsCliNonNegativeDecimal(
      order?.remainingQuantity ?? requestedQuantity,
      "LiveOpsCliPreflightOrderRemainingMalformed",
    );
    const requestedPrice = normalizeLiveOpsCliOptionalPositiveDecimal(order?.requestedPrice);
    const identityFingerprint = createLiveOpsCliPreflightOrderIdentityFingerprint({
      market: order?.market ?? market,
      side,
      requestedQuantity,
      requestedPrice,
    });
    if (!hasMeaningfulValue(order?.brokerOrderId) && !hasMeaningfulValue(order?.idempotencyKey) && !hasMeaningfulValue(identityFingerprint)) {
      throw new Error("LiveOpsCliPreflightOrderIdentityMissing");
    }

    return {
      exchangeOrderId: hasMeaningfulValue(order?.brokerOrderId) ? String(order.brokerOrderId) : null,
      identifier: hasMeaningfulValue(order?.idempotencyKey) ? String(order.idempotencyKey) : null,
      identityFingerprint,
      market: String(order?.market ?? market),
      side,
      status: normalizeLiveOpsCliPreflightOrderStatus(order?.status),
      requestedQuantity,
      remainingQuantity,
      requestedPrice,
      capturedAt: order?.updatedAt ?? order?.acceptedAt ?? observedAt,
      metadata: {
        source: "live_ops_cli_private_read_preflight",
        ...(order?.requestedQuantity === null || order?.requestedQuantity === undefined ? { requestedQuantitySource: "remaining_quantity_fallback" } : {}),
      },
    };
  });
}

function createLiveOpsCliPreflightMismatchEvidence(orderSnapshots, observedAt) {
  return orderSnapshots.map((order) => ({
    market: order.market,
    orderIdentity: order.exchangeOrderId ?? order.identifier ?? order.identityFingerprint,
    message: "실계좌 private read에서 기존 미체결 주문이 확인되어 신규 cleanup 주문을 제출하지 않습니다.",
    action: "거래소 미체결 주문을 취소하거나 상태를 reconcile한 뒤 live:ops를 다시 실행하세요.",
    evidenceFingerprint: createHash("sha256")
      .update([
        "live_ops_cli_preflight_open_order",
        order.market,
        order.exchangeOrderId ?? "",
        order.identifier ?? "",
        order.identityFingerprint,
        order.status,
        observedAt,
      ].join(":"))
      .digest("hex"),
    trace: {
      source: "live_ops_cli_private_read_preflight",
      reason: "open_order_before_cleanup_submit",
    },
    occurredAt: observedAt,
  }));
}

function createLiveOpsCliPreflightReconcileIdempotencyKey({ market, balances, orderSnapshots, observedAt }) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      market,
      observedAt,
      balances: balances.map((balance) => [balance.currency, balance.available, balance.locked, balance.total]),
      orderSnapshots: orderSnapshots.map((order) => [
        order.exchangeOrderId,
        order.identifier,
        order.identityFingerprint,
        order.status,
        order.remainingQuantity,
      ]),
    }))
    .digest("hex")
    .slice(0, 24);
  return `live-ops-preflight:${fingerprint}`;
}

function createLiveOpsCliPreflightOrderIdentityFingerprint({ market, side, requestedQuantity, requestedPrice }) {
  return [
    market,
    side,
    new Decimal(requestedQuantity).toFixed(),
    requestedPrice === null ? "" : new Decimal(requestedPrice).toFixed(),
  ].join("|");
}

function normalizeLiveOpsCliPreflightOrderSide(side) {
  const normalized = String(side ?? "").toUpperCase();
  if (normalized !== "BUY" && normalized !== "SELL") {
    throw new Error("LiveOpsCliPreflightOrderSideMalformed");
  }
  return normalized;
}

function normalizeLiveOpsCliPreflightOrderStatus(status) {
  const normalized = String(status ?? "OPEN").toUpperCase();
  return normalized.length === 0 ? "OPEN" : normalized;
}

function normalizeLiveOpsCliPositiveDecimal(value, errorName) {
  if (!isPositiveDecimalString(value)) {
    throw new Error(errorName);
  }
  return new Decimal(value).toFixed();
}

function normalizeLiveOpsCliNonNegativeDecimal(value, errorName) {
  if (!isNonNegativeDecimalString(value)) {
    throw new Error(errorName);
  }
  return new Decimal(value).toFixed();
}

function normalizeLiveOpsCliOptionalPositiveDecimal(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeLiveOpsCliPositiveDecimal(value, "LiveOpsCliPreflightOrderPriceMalformed");
}

export function createLiveOpsCliDatabasePnlStatusProvider(pool, market) {
  return {
    async getStatus(scope = undefined) {
      const scopedMarket = hasMeaningfulValue(scope?.market) ? String(scope.market) : market;
      const strategyId = hasMeaningfulValue(scope?.strategyId) ? String(scope.strategyId) : "live_ops_cleanup_probe";
      const useLegacyCleanupQuery = scope === undefined && strategyId === "live_ops_cleanup_probe";
      try {
        const latestQuery = useLegacyCleanupQuery
          ? {
              sql: `
            SELECT
              strategy_id,
              market,
              captured_at,
              equity,
              realized_pnl,
              unrealized_pnl,
              drawdown_bps,
              payload_json ->> 'sourceFingerprint' AS source_fingerprint,
              payload_json ->> 'status' AS payload_status
            FROM pnl_snapshots
            WHERE (market = $1 OR market IS NULL)
              AND (
                strategy_id = 'live_ops_cleanup_probe'
                OR strategy_id IS NULL
                OR strategy_id IN ('global', 'aggregate')
              )
            ORDER BY
              (strategy_id = 'live_ops_cleanup_probe') DESC,
              CASE WHEN strategy_id = 'live_ops_cleanup_probe' THEN captured_at END DESC,
              CASE WHEN strategy_id = 'live_ops_cleanup_probe' THEN (market = $1) END DESC,
              CASE WHEN strategy_id IS DISTINCT FROM 'live_ops_cleanup_probe' THEN (payload_json ->> 'status' = 'CALCULATED') END DESC,
              CASE WHEN strategy_id IS DISTINCT FROM 'live_ops_cleanup_probe' THEN captured_at END DESC,
              CASE WHEN strategy_id IS DISTINCT FROM 'live_ops_cleanup_probe' THEN (market = $1) END DESC
            LIMIT 1
          `,
              params: [scopedMarket],
            }
          : {
              sql: `
            SELECT
              strategy_id,
              market,
              captured_at,
              equity,
              realized_pnl,
              unrealized_pnl,
              drawdown_bps,
              payload_json ->> 'sourceFingerprint' AS source_fingerprint,
              payload_json ->> 'status' AS payload_status
            FROM pnl_snapshots
            WHERE (market = $1 OR market IS NULL)
              AND strategy_id = $2
            ORDER BY
              captured_at DESC,
              (market = $1) DESC
            LIMIT 1
          `,
              params: [scopedMarket, strategyId],
            };
        const countQuery = useLegacyCleanupQuery
          ? {
              sql: `
            SELECT count(*)::int AS count
            FROM pnl_snapshots
            WHERE (market = $1 OR market IS NULL)
              AND (
                strategy_id = 'live_ops_cleanup_probe'
                OR strategy_id IS NULL
                OR strategy_id IN ('global', 'aggregate')
              )
          `,
              params: [scopedMarket],
            }
          : {
              sql: `
            SELECT count(*)::int AS count
            FROM pnl_snapshots
            WHERE (market = $1 OR market IS NULL)
              AND strategy_id = $2
          `,
              params: [scopedMarket, strategyId],
            };
        const [latestResult, countResult] = await Promise.all([
          // 명시 scope는 전역 PnL row로 손실 guard를 열지 않고 해당 strategy closeout이 직접 계산되게 둔다.
          pool.query(latestQuery.sql, latestQuery.params),
          pool.query(countQuery.sql, countQuery.params),
        ]);
        const latest = latestResult.rows[0];
        const snapshotCount = numberRowValue(countResult.rows[0]?.count);
        if (latest === undefined) {
          return createLiveOpsCliEmptyPnlStatus("NOT_FOUND", "pnl_snapshot_not_found");
        }
        return {
          readStatus: "OK",
          latestCapturedAt: toIsoString(latest.captured_at),
          latestEquityKrw: decimalRowValue(latest.equity),
          latestRealizedPnlKrw: decimalRowValue(latest.realized_pnl),
          latestUnrealizedPnlKrw: decimalRowValue(latest.unrealized_pnl),
          latestDrawdownBps: decimalRowValue(latest.drawdown_bps),
          latestSource: hasMeaningfulValue(latest.source_fingerprint) ? "pnl_snapshots" : null,
          latestStatus: latest.payload_status ?? null,
          snapshotCount,
          reason: "pnl_snapshot_latest_read",
        };
      } catch {
        // PnL 조회 실패는 private read 전체 예외로 키우지 않고 PnL status 축에서 수동 점검으로 표시한다.
        return createLiveOpsCliEmptyPnlStatus("UNAVAILABLE", "pnl_snapshot_query_failed");
      }
    },
  };
}

export function createLiveOpsCliDatabaseKillSwitchProvider(pool) {
  return {
    async getStatus() {
      try {
        const result = await pool.query(`
          SELECT state, reason_code, updated_at, correlation_id
          FROM kill_switch_state
          WHERE scope = 'global'
          LIMIT 1
        `);
        const row = result.rows[0];
        if (row === undefined) {
          return {
            active: true,
            state: "UNKNOWN",
            reasonCode: "kill_switch_state_missing",
            updatedAt: null,
            message: "kill switch 상태를 DB에서 확인하지 못해 신규 실주문을 차단합니다.",
          };
        }
        const actionPlan = mapLiveOpsCliKillSwitchActionPlan(row.state);
        return {
          active: actionPlan.newOrdersBlocked || actionPlan.requiresManualReview,
          state: row.state,
          reasonCode: row.reason_code,
          updatedAt: toIsoString(row.updated_at),
          correlationId: row.correlation_id ?? null,
          message: row.state === "NORMAL"
            ? "kill switch가 NORMAL 상태입니다."
            : actionPlan.newOrdersBlocked || actionPlan.requiresManualReview
            ? "kill switch가 신규 실주문 차단 상태입니다."
            : "kill switch가 strategy pause 상태지만 전역 신규 실주문 차단은 아닙니다.",
          actionPlan,
        };
      } catch {
        return {
          active: true,
          state: "UNAVAILABLE",
          reasonCode: "kill_switch_query_failed",
          updatedAt: null,
          message: "kill switch 상태 조회가 실패해 신규 실주문을 차단합니다.",
        };
      }
    },
  };
}

function mapLiveOpsCliKillSwitchActionPlan(state) {
  switch (state) {
    case "NORMAL":
      return { newOrdersBlocked: false, strategyEvaluationBlocked: false, requiresManualReview: false };
    case "STRATEGY_PAUSED":
      return { newOrdersBlocked: false, strategyEvaluationBlocked: true, requiresManualReview: false };
    case "NEW_ORDERS_BLOCKED":
      return { newOrdersBlocked: true, strategyEvaluationBlocked: false, requiresManualReview: false };
    case "HARD_STOP":
    case "MANUAL_REVIEW_REQUIRED":
      return { newOrdersBlocked: true, strategyEvaluationBlocked: true, requiresManualReview: true };
    default:
      return { newOrdersBlocked: true, strategyEvaluationBlocked: true, requiresManualReview: true };
  }
}

async function readLiveOpsCliKillSwitchStatus(provider) {
  if (provider === undefined || provider === null || typeof provider.getStatus !== "function") {
    return {
      active: true,
      state: "PROVIDER_MISSING",
      reasonCode: "kill_switch_provider_missing",
      updatedAt: null,
      message: "kill switch provider가 없어 신규 실주문을 차단합니다.",
    };
  }
  return provider.getStatus();
}

function createLiveOpsCliEmptyPnlStatus(readStatus, reason) {
  return {
    readStatus,
    latestCapturedAt: null,
    latestEquityKrw: null,
    latestRealizedPnlKrw: null,
    latestUnrealizedPnlKrw: null,
    latestDrawdownBps: null,
    latestSource: null,
    latestStatus: null,
    snapshotCount: 0,
    reason,
  };
}

export function createLiveOpsCliTelegramDispatcher({ config, env, fetchImpl = fetch }) {
  const botToken = env.SEEMIRAI_TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  const chatId = env.SEEMIRAI_TELEGRAM_CHAT_ID ?? env.TELEGRAM_CHAT_ID;
  if (!hasMeaningfulValue(botToken) || !hasMeaningfulValue(chatId)) {
    return undefined;
  }
  const providerTimeoutMs = Number(config.telegram?.provider_timeout_ms ?? 5000);
  return {
    async dispatch(payload) {
      let deliveredCount = 0;
      for (const event of payload.events) {
        // owner chat 전송은 주문/리스크 commit 이후 side effect라 실패를 누적하되 원 실행 결과는 되돌리지 않는다.
        const delivered = await sendLiveOpsCliTelegramEvent({
          botToken,
          chatId,
          event,
          market: payload.market,
          observedAt: payload.observedAt,
          providerTimeoutMs,
          fetchImpl,
        });
        if (delivered) {
          deliveredCount += 1;
        }
      }
      const failureCount = payload.events.length - deliveredCount;
      return {
        status: failureCount > 0 ? "partial_failure" : "sent",
        attemptedCount: payload.events.length,
        deliveredCount,
        cooldownHitCount: 0,
        retryPlannedCount: failureCount,
        failureCount,
      };
    },
  };
}

async function sendLiveOpsCliTelegramEvent({ botToken, chatId, event, market, observedAt, providerTimeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncateTelegramText(formatLiveOpsCliTelegramEventMessage({ event, market, observedAt })),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json().catch(() => undefined);
    return body !== undefined && body !== null && body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function formatLiveOpsCliTelegramEventMessage({ event, market, observedAt }) {
  return [
    "M23 live 운영 알림",
    `상태: ${formatLiveOpsCliTelegramEventKind(event.eventKind)}`,
    `마켓: ${event.market ?? market}`,
    `시각: ${event.occurredAt ?? observedAt}`,
    `요약: ${event.safeSummary ?? "상태 evidence를 확인하세요."}`,
    "추적 정보:",
    `- event_kind: ${event.eventKind}`,
    ...(event.evidenceId === undefined ? [] : [`- evidence_id: ${event.evidenceId}`]),
    ...(event.orderId === undefined ? [] : [`- order_id: ${event.orderId}`]),
    ...(event.brokerOrderId === undefined ? [] : [`- broker_order_id: ${event.brokerOrderId}`]),
    ...(event.idempotencyKey === undefined ? [] : [`- idempotency_key: ${event.idempotencyKey}`]),
  ].join("\n");
}

function formatLiveOpsCliTelegramEventKind(eventKind) {
  switch (eventKind) {
    case "TELEGRAM_CONNECTION_READY":
      return "Telegram 알림 채널 준비";
    case "LIVE_ORDER_CAPABLE_STARTED":
      return "실주문 가능 경계 진입";
    case "ORDER_SUBMITTED":
      return "주문 제출";
    case "ORDER_FILLED":
      return "주문 체결";
    case "REQUOTE_READY":
      return "재호가 대기";
    case "CANCEL_REQUESTED":
      return "취소 요청";
    case "CANCEL_CONFIRMED":
      return "취소 확인";
    case "RISK_BLOCKED":
    case "COST_BLOCKED":
      return "주문 차단";
    case "RECONCILE_BLOCKED":
      return "대사 차단";
    case "MANUAL_REVIEW_REQUIRED":
      return "수동 점검 필요";
    default:
      return "운영 상태 변경";
  }
}

function truncateTelegramText(value) {
  const characters = Array.from(value);
  if (characters.length <= 4096) {
    return value;
  }
  return `${characters.slice(0, 4080).join("")}\n... [truncated]`;
}

function mapLiveOpsCliReconcileResult(status, mismatchCount) {
  switch (status) {
    case "COMPLETED":
      return mismatchCount > 0 ? "MISMATCH_DETECTED" : "SUCCESS";
    case "FAILED":
      return "FAILED";
    case "RUNNING":
      return "UNAVAILABLE";
    case "MANUAL_REVIEW_REQUIRED":
      return "MISMATCH_DETECTED";
    default:
      return "UNAVAILABLE";
  }
}

function mapLiveOpsCliBalanceStatus(balanceSnapshotCount, mismatchTypes) {
  if (mismatchTypes.includes("BALANCE_LOCK_MISMATCH")) {
    return "STALE";
  }
  return balanceSnapshotCount > 0 ? "OK" : "UNAVAILABLE";
}

function decimalRowValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function numberRowValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIsoString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function findSecretLikeKeys(value, currentPath = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecretLikeKeys(item, `${currentPath}[${index}]`));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const nextPath = `${currentPath}.${key}`;
    if (/(?:secret|token|password|access[_-]?key|secret[_-]?key|database[_-]?url|authorization|jwt)/iu.test(key)) {
      return [nextPath];
    }
    return findSecretLikeKeys(child, nextPath);
  });
}

function hasMeaningfulValue(value) {
  return value !== undefined && String(value).trim().length > 0 && String(value).trim() !== "0";
}

function formatSchemaVersion(version) {
  return version === null || version === undefined ? "확인 필요" : `v${version}`;
}

function formatPendingMigrationCount(pendingVersions) {
  if (!Array.isArray(pendingVersions)) {
    return "확인 필요";
  }
  return pendingVersions.length === 0 ? "없음" : `${pendingVersions.length}개`;
}

function formatKrwValue(value) {
  if (value === null || value === undefined) {
    return "확인 필요";
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toLocaleString("ko-KR") : String(value);
}

function formatMarketDataObservation(marketData) {
  if (marketData?.ready !== true) {
    return "후속 연결 대기";
  }

  return [
    `체결 ${marketData.persisted.tradeCount}`,
    `호가 ${marketData.persisted.orderbookCount}`,
    `상태 ${marketData.persisted.statusCount}`,
    `latest ${marketData.latestHeartbeatAt ?? "확인 필요"}`,
  ].join(" / ");
}

function formatAnalysisDecisionObservation(analysisDecision) {
  if (analysisDecision?.ready !== true) {
    return "후속 연결 대기";
  }

  return [
    formatDecisionCategory(analysisDecision.decisionCategory),
    `주문 후보 ${analysisDecision.orderIntentCount}`,
    `전략 ${analysisDecision.evaluatedStrategyCount}`,
    `latest ${analysisDecision.latestDecisionAt ?? "확인 필요"}`,
  ].join(" / ");
}

function formatLiveExecutionObservation(liveExecution) {
  if (liveExecution?.ready !== true) {
    const blockedCheck = Array.isArray(liveExecution?.checks)
      ? liveExecution.checks.find((check) => check?.status === "blocked")
      : undefined;
    const preflightEvidence = liveExecution?.preflightReconcileEvidence ?? blockedCheck?.details?.preflightReconcileEvidence;
    return [
      liveExecution?.statusLabel ?? "후속 연결 대기",
      `주문 후보 ${liveExecution?.orderIntentCount ?? 0}`,
      `broker 제출 ${liveExecution?.submittedOrderCount ?? 0}`,
      ...(blockedCheck?.code === undefined ? [] : [`차단 ${blockedCheck.code}`]),
      ...(preflightEvidence?.runId === undefined ? [] : [`preflight ${preflightEvidence.status ?? "확인 필요"} ${preflightEvidence.runId}`]),
      `latest ${liveExecution?.latestExecutionAt ?? "없음"}`,
    ].join(" / ");
  }

  return [
    liveExecution.statusLabel ?? "대기",
    `주문 후보 ${liveExecution.orderIntentCount}`,
    `broker 제출 ${liveExecution.submittedOrderCount}`,
    ...(liveExecution.cleanupStatus === undefined ? [] : [`cleanup ${liveExecution.cleanupStatus}`]),
    ...(liveExecution.terminalState === undefined ? [] : [`terminal ${liveExecution.terminalState}`]),
    `latest ${liveExecution.latestExecutionAt ?? "없음"}`,
  ].join(" / ");
}

function formatReconcilePnlStatusObservation(reconcilePnlStatus) {
  if (
    reconcilePnlStatus?.ready !== true &&
    reconcilePnlStatus?.providerProbeAttempted !== true &&
    reconcilePnlStatus?.manualReviewRequired !== true
  ) {
    return "후속 연결 대기";
  }

  return [
    reconcilePnlStatus.statusLabel ?? "상태 요약",
    `대사 ${reconcilePnlStatus.reconcileStatusLabel}`,
    `PnL ${reconcilePnlStatus.pnlStatusLabel}`,
    `open 주문 ${reconcilePnlStatus.openOrderCount}`,
    `provider 호출 ${reconcilePnlStatus.providerProbeAttempted ? "있음" : "0"}`,
    `open exposure ${formatKrwValue(reconcilePnlStatus.openExposureKrw)} KRW`,
    `budget used ${formatKrwValue(reconcilePnlStatus.budgetUsedKrw)} KRW`,
    `realized PnL ${formatKrwValue(reconcilePnlStatus.realizedPnlKrw)} KRW`,
    `unrealized PnL ${formatKrwValue(reconcilePnlStatus.unrealizedPnlKrw)} KRW`,
    `latest reconcile ${reconcilePnlStatus.latestReconcileAt ?? "없음"}`,
    `mismatch ${reconcilePnlStatus.mismatchCount ?? "확인 필요"}`,
    `manual review ${reconcilePnlStatus.manualReviewRequired ? "필요" : "아니오"}`,
  ].join(" / ");
}

function formatTelegramAlertObservation(telegramAlert) {
  if (
    telegramAlert?.ready !== true &&
    telegramAlert?.providerDispatchAttempted !== true &&
    !hasMeaningfulTelegramFailureSummary(telegramAlert)
  ) {
    return "후속 연결 대기";
  }

  return [
    telegramAlert.statusLabel ?? "계획 확인",
    `lifecycle ${telegramAlert.lifecycleAlertCount}`,
    `trade ${telegramAlert.tradeAlertCount}`,
    `provider 호출 ${telegramAlert.providerDispatchAttempted ? "있음" : "0"}`,
    `retry ${telegramAlert.retryPlannedCount ?? 0}`,
    `failure ${telegramAlert.failureCount ?? 0}`,
  ].join(" / ");
}

function hasMeaningfulTelegramFailureSummary(telegramAlert) {
  return (
    Number(telegramAlert?.failureCount ?? 0) > 0 ||
    Number(telegramAlert?.retryPlannedCount ?? 0) > 0 ||
    telegramAlert?.status === "manual_review_required"
  );
}

function formatDecisionCategory(decisionCategory) {
  if (decisionCategory === "ORDER_INTENT") {
    return "주문 후보";
  }
  if (decisionCategory === "BLOCKED") {
    return "차단";
  }
  return "보류";
}

export async function evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke,
  analysisDecision,
  marketData,
  env,
  orderIntents,
  entryRuntime,
  exitRuntime,
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot,
  lossSnapshot,
  cleanupLifecycle,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const intents = orderIntents ?? getLiveOpsCliAnalysisOrderIntents(analysisDecision);
  const observedAt = readLiveOpsCliCleanupRuntimeObservedAt(intents) ?? new Date().toISOString();
  const brokerGuard = evaluateLiveOpsCliBrokerGuard({ config, env, fixtureSmoke });

  if (analysisDecision.ready !== true) {
    if (analysisDecision.decisionSourceConnected === false) {
      return buildLiveOpsCliLiveExecutionSummary({
        status: "pending",
        ready: false,
        liveOrderCapable: false,
        market,
        observedAt,
        orderIntentCount: 0,
        attemptedOrderCount: 0,
        submittedOrderCount: 0,
        brokerGuard,
        statusLabel: "decision source 대기",
        message: "production decision source가 아직 연결되지 않아 live execution은 broker 제출 없이 대기합니다.",
        action: "durable decision source가 연결되면 같은 market data tick에서 후보를 다시 평가하세요.",
        checks: [
          okLiveExecutionCheck("analysis_decision", "analysis/decision source 미연결 상태를 boot 범위와 분리했습니다.", "live_ops_decision_source_pending"),
          brokerGuard.ready
            ? okLiveExecutionCheck("broker_guard", "Upbit live broker guard를 확인했습니다.", "live_ops_broker_guard_ready")
            : blockedLiveExecutionCheck("broker_guard", "Upbit live broker guard가 차단됐습니다.", "live_ops_broker_guard_blocked", {
                violations: brokerGuard.violations,
              }),
          okLiveExecutionCheck("broker_submit", "decision source 미연결 상태에서는 broker 제출을 생략합니다.", "live_ops_broker_submit_skipped"),
        ],
      });
    }

    return {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      latestExecutionAt: null,
      orderIntentCount: analysisDecision.orderIntentCount ?? 0,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "후속 연결 대기",
      message: "analysis/decision이 준비되지 않아 live execution으로 전진하지 않습니다.",
      checks: [
        {
          name: "analysis_decision",
          status: "blocked",
          code: "live_ops_analysis_not_ready",
          message: "analysis/decision 차단 원인을 먼저 해소해야 broker 경계를 열 수 있습니다.",
        },
      ],
    };
  }

  if (!brokerGuard.ready) {
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      latestExecutionAt: observedAt,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "broker guard 차단",
      message: "Upbit live broker guard가 완성되지 않아 실주문 실행을 시작하지 않았습니다.",
      action: "key scope, evidence id, market, 예산 상한을 확인한 뒤 다시 실행하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("broker_guard", "Upbit live broker guard가 차단됐습니다.", "live_ops_broker_guard_blocked", {
          violations: brokerGuard.violations,
        }),
      ],
    });
  }

  if (analysisDecision.orderIntentCount === 0 && intents.length === 0) {
    // HOLD tick은 정상 lifecycle이므로 durable reservation이나 broker 호출 없이 evidence-friendly idle 상태로 닫는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "idle",
      ready: true,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: 0,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "후보 없음",
      message: `${fixtureSmoke ? "fixture" : "production"} decision tick에 주문 후보가 없어 broker 제출은 발생하지 않았습니다.`,
      action: "다음 decision tick에서 신규 후보가 생기면 예산과 freshness를 다시 확인합니다.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        okLiveExecutionCheck("order_intent", "주문 후보가 없어 broker 제출을 생략했습니다.", "live_ops_no_order_intent"),
        okLiveExecutionCheck("broker_submit", "broker 제출 횟수 0회를 확인했습니다.", "live_ops_broker_submit_skipped"),
      ],
    });
  }

  const countViolation = validateLiveOpsCliOrderIntentCount(analysisDecision, intents);
  if (countViolation !== undefined) {
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      latestExecutionAt: observedAt,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "후보 수 차단",
      message: "live execution 후보 수가 production 실행 경계와 맞지 않아 주문을 제출하지 않았습니다.",
      action: "analysis summary와 order intent source를 같은 decision tick으로 다시 읽으세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("order_intent", countViolation.message, countViolation.code, countViolation.details),
      ],
    });
  }

  const receivedIntent = intents[0];
  if (receivedIntent?.side === "SELL") {
    return evaluateLiveOpsCliExitExecution({
      config,
      marketData,
      intent: receivedIntent,
      observedAt,
      brokerGuard,
      exitRuntime,
      executionStatus,
      postSubmitReadiness,
      budgetSnapshot,
      lossSnapshot,
    });
  }

  if (entryRuntime === undefined) {
    // runtime wiring이 없으면 실제 execution/cost/risk evidence를 합성하지 않고 제출 경계 미연결로 닫는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "runtime 미연결",
      message: "live autonomous entry runtime이 연결되지 않아 주문 후보를 제출하지 않았습니다.",
      action: "budget reservation, 실제 execution status, cost/risk, post-submit readiness evidence와 broker runtime을 연결한 뒤 다시 실행하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("entry_runtime", "live autonomous entry runtime이 연결되지 않았습니다.", "live_ops_entry_runtime_missing"),
      ],
    });
  }

  const executionStatusViolations = collectLiveOpsCliExecutionStatusViolations(executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot);
  if (executionStatusViolations.length > 0) {
    const preflightEvidenceDetails = createLiveOpsCliPreflightEvidenceDetails(executionStatus?.preflightReconcileEvidence);
    const preflightManualReview = executionStatus?.preflightReconcileEvidence?.status === "MANUAL_REVIEW_REQUIRED";
    // kill switch, reconcile freshness, post-submit 후속 경계가 불명확하면 후보가 유효해도 broker runtime을 열지 않는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: preflightManualReview ? "manual_review_required" : "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      attemptStatus: preflightManualReview ? "BLOCKED" : undefined,
      brokerGuard,
      statusLabel: preflightManualReview ? "수동 점검" : "운영 상태 차단",
      message: preflightManualReview
        ? "preflight private read에서 기존 미체결 주문이 확인되어 주문 후보를 제출하지 않았습니다."
        : "live execution 운영 상태 증거가 부족해 주문 후보를 제출하지 않았습니다.",
      action: preflightManualReview
        ? "preflight reconcile run과 UNTRACKED_EXCHANGE_OPEN_ORDER evidence를 확인하고 거래소 미체결 주문을 정리한 뒤 다시 실행하세요."
        : "kill switch, reconcile freshness, 제출 후 reconcile/alert 경계 증거를 확인하세요.",
      preflightReconcileEvidence: executionStatus?.preflightReconcileEvidence,
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("execution_status", "live execution 운영 상태 snapshot이 production 제출 조건을 통과하지 못했습니다.", "live_ops_execution_status_blocked", {
          violations: executionStatusViolations,
          ...preflightEvidenceDetails,
        }),
      ],
    });
  }

  const intent = attachLiveOpsCliCleanupRuntimeApprovalEvidence(createLiveOpsCliCleanupRuntimeIntent({
    intent: receivedIntent,
    observedAt,
  }));
  const intentViolations = collectLiveOpsCliOrderIntentViolations({ config, marketData, intent });
  if (intentViolations.length > 0) {
    // 주문 후보가 live ops guard를 벗어나면 entry runtime에 넘기기 전에 닫아 broker side effect를 만들지 않는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "후보 차단",
      message: "주문 후보가 실운영 실행 조건을 통과하지 못해 제출하지 않았습니다.",
      action: "후보 market, LIMIT/post-only, 예산, freshness, strategy/risk 입력을 확인하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("order_intent", "주문 후보가 production live execution guard를 통과하지 못했습니다.", "live_ops_order_intent_blocked", {
          violations: intentViolations,
        }),
      ],
    });
  }

  const request = createLiveOpsCliEntryRuntimeRequest({ config, marketData, intent, observedAt, executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot });
  const runtime = entryRuntime;
  let attempt;
  try {
    // 이 호출이 예산 reservation과 UpbitLiveBroker 제출로 이어질 수 있는 유일한 경계다.
    attempt = await runtime.submitEntryCandidate(request);
  } catch (error) {
    return buildLiveOpsCliLiveExecutionSummary({
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: intents.length,
      attemptedOrderCount: 1,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "수동 점검",
      message: "실주문 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문과 durable reservation 상태를 먼저 확인한 뒤 재시도 여부를 결정하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        okLiveExecutionCheck("order_intent", "단일 LIMIT + post-only 주문 후보를 확인했습니다.", "live_ops_order_intent_ready"),
        blockedLiveExecutionCheck("execution_result", "live execution runtime 결과를 확정할 수 없습니다.", "live_ops_execution_runtime_uncertain", {
          reason: safeErrorName(error),
        }),
      ],
    });
  }

  const submitted = attempt.status === "SUBMITTED" || attempt.status === "FILLED" || attempt.status === "CANCELED_FOR_REQUOTE";
  const entryReady = submitted && attempt.manualReviewRequired !== true;
  const budgetUsageAfterReservationKrw = createLiveOpsCliBudgetUsageAfterReservation({ attempt });
  const submittedSummary = {
    status: attempt.status === "CANCELED_FOR_REQUOTE" ? "entry_requote_ready" : submitted ? String(attempt.status).toLowerCase() : String(attempt.status ?? "blocked").toLowerCase(),
    ready: entryReady,
    liveOrderCapable: entryReady,
    market,
    latestExecutionAt: observedAt,
    orderIntentCount: intents.length,
    attemptedOrderCount: 1,
    submittedOrderCount: submitted ? 1 : 0,
    attemptStatus: attempt.status ?? null,
    attemptId: attempt.attemptId ?? null,
    idempotencyKey: attempt.idempotencyKey ?? request.idempotencyKey,
    brokerOrderId: attempt.brokerOrderId ?? attempt.executionResult?.brokerOrder?.brokerOrderId ?? null,
    reservedNotionalKrw: readLiveOpsCliAttemptReservedNotionalKrw(attempt),
    budgetUsageAfterReservationKrw,
    brokerGuard,
    statusLabel: attempt.status === "FILLED" ? "매수 체결" : attempt.status === "CANCELED_FOR_REQUOTE" ? "매수 재호가 대기" : submitted ? "broker 제출" : "제출 차단",
    message: entryReady
      ? (attempt.message ?? "실주문 실행 경계가 주문 후보를 처리했습니다.")
      : (attempt.message ?? "live execution runtime이 주문 후보를 제출하지 않았습니다."),
    action: entryReady
      ? (attempt.action ?? "체결, 취소, reconcile/PnL/status worker에서 후속 상태를 확인합니다.")
      : (attempt.action ?? "차단 원인을 확인한 뒤 다음 tick에서 다시 평가합니다."),
    checks: [
      okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
      okLiveExecutionCheck("order_intent", "단일 LIMIT + post-only 주문 후보를 확인했습니다.", "live_ops_order_intent_ready"),
      okLiveExecutionCheck("execution_request", "live autonomous entry runtime 요청을 만들었습니다.", "live_ops_execution_request_ready"),
      {
        name: "execution_result",
        status: entryReady ? "ok" : "blocked",
        code: attempt.status === "SUBMITTED" ? "live_ops_execution_submitted" : entryReady ? "live_ops_execution_recorded" : "live_ops_execution_blocked",
        message: attempt.status === "SUBMITTED" ? "broker 제출 결과를 확인했습니다." : entryReady ? "entry runtime 결과를 확인했습니다." : "entry runtime이 제출을 차단했습니다.",
      },
    ],
  };
  if (submitted && cleanupLifecycle !== undefined && intent.strategyId === "live_ops_cleanup_probe") {
    try {
      // cleanup_probe 실주문은 제출 성공을 최종 readiness로 보지 않고 같은 runtime에서 취소와 terminal 확인까지 닫는다.
      return await cleanupLifecycle({
        submittedSummary,
        attempt,
        request,
        orderIntent: intent,
        market,
        observedAt,
      });
    } catch (error) {
      return createLiveOpsCliCleanupManualReviewSummary({
        submittedSummary,
        attempt,
        request,
        market,
        observedAt,
        reason: safeErrorName(error),
        message: "cleanup lifecycle 결과를 확정하지 못해 수동 점검 상태로 전환했습니다.",
        action: "거래소 주문 uuid와 저장소 밖 artifact를 확인하고 open order/exposure를 먼저 닫으세요.",
      });
    }
  }
  return submittedSummary;
}

async function evaluateLiveOpsCliExitExecution({
  config,
  marketData,
  intent: receivedIntent,
  observedAt,
  brokerGuard,
  exitRuntime,
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot,
  lossSnapshot,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const executionStatusViolations = collectLiveOpsCliExecutionStatusViolations(executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot);
  if (executionStatusViolations.length > 0) {
    // exit도 reconcile freshness와 후속 status 경계가 불명확하면 broker 제출로 전진하지 않는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: 1,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "운영 상태 차단",
      message: "매도 실행 운영 상태 증거가 부족해 SELL 후보를 제출하지 않았습니다.",
      action: "kill switch, reconcile freshness, 제출 후 reconcile/alert 경계 증거를 확인하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("execution_status", "live execution 운영 상태 snapshot이 production 제출 조건을 통과하지 못했습니다.", "live_ops_execution_status_blocked", {
          violations: executionStatusViolations,
        }),
      ],
    });
  }

  if (exitRuntime === undefined) {
    // SELL은 entry runtime으로 우회하지 않고 exit runtime port가 없으면 닫는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: 1,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "exit runtime 미연결",
      message: "매도 실행 경계가 연결되지 않아 SELL 후보를 제출하지 않았습니다.",
      action: "exit runtime port와 live broker 조립 상태를 확인하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("exit_runtime", "live autonomous exit runtime이 연결되지 않았습니다.", "live_ops_exit_runtime_missing"),
      ],
    });
  }

  const intent = refreshLiveOpsCliExitRuntimeEvidence(createLiveOpsCliExitRuntimeIntent(receivedIntent));
  const intentViolations = collectLiveOpsCliExitOrderIntentViolations({ config, marketData, intent });
  if (intentViolations.length > 0) {
    // 보유 scope와 exit evidence가 맞지 않으면 exit runtime 호출 전에 닫아 실계좌 side effect를 만들지 않는다.
    return buildLiveOpsCliLiveExecutionSummary({
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      market,
      observedAt,
      orderIntentCount: 1,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "매도 후보 차단",
      message: "매도 후보가 실운영 실행 조건을 통과하지 못해 제출하지 않았습니다.",
      action: "보유 수량, exit reason/rule, position scope, post-only 조건을 확인하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("order_intent", "매도 후보가 production live exit guard를 통과하지 못했습니다.", "live_ops_order_intent_blocked", {
          violations: intentViolations,
        }),
      ],
    });
  }

  const submission = createLiveOpsCliExitOrderSubmission({ intent, observedAt });
  let attempt;
  try {
    attempt = await exitRuntime.submitExitOrder(submission);
  } catch (error) {
    return buildLiveOpsCliLiveExecutionSummary({
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      market,
      latestExecutionAt: observedAt,
      observedAt,
      orderIntentCount: 1,
      attemptedOrderCount: 1,
      submittedOrderCount: 0,
      brokerGuard,
      statusLabel: "수동 점검",
      message: "매도 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문과 포지션/reconcile 상태를 먼저 확인한 뒤 재시도 여부를 결정하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        okLiveExecutionCheck("order_intent", "단일 SELL LIMIT + post-only 후보를 확인했습니다.", "live_ops_exit_order_intent_ready"),
        blockedLiveExecutionCheck("execution_result", "exit runtime 결과를 확정할 수 없습니다.", "live_ops_exit_runtime_uncertain", {
          reason: safeErrorName(error),
        }),
      ],
    });
  }

  const submitted = attempt.status === "SUBMITTED" || attempt.status === "FILLED" || attempt.status === "CANCELED_FOR_REQUOTE";
  const ready = submitted && attempt.manualReviewRequired !== true;
  return buildLiveOpsCliLiveExecutionSummary({
    status: attempt.status === "CANCELED_FOR_REQUOTE" ? "exit_requote_ready" : String(attempt.status ?? "blocked").toLowerCase(),
    ready,
    liveOrderCapable: ready,
    market,
    latestExecutionAt: observedAt,
    observedAt,
    orderIntentCount: 1,
    attemptedOrderCount: 1,
    submittedOrderCount: submitted ? 1 : 0,
    attemptStatus: attempt.status ?? null,
    attemptId: intent.idempotencyKey,
    idempotencyKey: intent.idempotencyKey,
    brokerOrderId: attempt.brokerOrderId ?? null,
    brokerGuard,
    statusLabel: attempt.statusLabel ?? (ready ? "매도 처리" : "수동 점검"),
    message: attempt.message ?? "매도 후보를 exit runtime에서 처리했습니다.",
    action: attempt.action ?? "다음 daemon tick에서 포지션과 reconcile 상태를 다시 평가합니다.",
    checks: [
      okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
      okLiveExecutionCheck("order_intent", "단일 SELL LIMIT + post-only 후보를 확인했습니다.", "live_ops_exit_order_intent_ready"),
      okLiveExecutionCheck("execution_request", "live autonomous exit submission을 만들었습니다.", "live_ops_exit_request_ready"),
      {
        name: "execution_result",
        status: ready ? "ok" : "blocked",
        code: ready ? "live_ops_exit_execution_recorded" : "live_ops_exit_execution_manual_review",
        message: ready ? "exit runtime 결과를 확인했습니다." : "exit runtime 결과가 수동 점검을 요구합니다.",
      },
    ],
  });
}

export function createLiveOpsCliEntryRuntime({
  broker,
  budgetReservation,
  artifactStore,
  clock = () => new Date().toISOString(),
  pollCount = liveOpsCliCleanupCancelPollCount,
  pollIntervalMs = liveOpsCliCleanupCancelPollIntervalMs,
} = {}) {
  return {
    async submitEntryCandidate(request) {
      if (broker === undefined || typeof broker.submitOrder !== "function") {
        // broker port 미연결은 거래소 주문 불확실성이 없으므로 수동 점검이 아니라 wiring 차단으로 닫는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "live broker port가 연결되지 않아 broker 제출을 중단했습니다.",
          action: "Upbit live broker port wiring을 연결한 뒤 같은 후보를 다시 평가하세요.",
          violations: ["broker_port_missing"],
          events: [],
          trace: {
            reason: "broker_port_missing",
          },
        };
      }

      const statusViolations = collectLiveOpsCliEntryRuntimeStatusViolations(request);
      if (statusViolations.length > 0) {
        // wrapper를 직접 호출해도 kill switch와 reconcile 상태가 불명확하면 private broker로 넘어가지 않는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "live execution 운영 상태가 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
          action: "kill switch 해제와 reconcile freshness evidence를 확인한 뒤 다시 실행하세요.",
          violations: ["execution_runtime_status_blocked"],
          events: [],
          trace: {
            reason: "execution_runtime_status_blocked",
            violations: statusViolations,
          },
        };
      }

      const guardViolations = collectLiveOpsCliEntryRuntimeGuardViolations(request);
      if (guardViolations.length > 0) {
        // exported wrapper는 상위 adapter 없이도 live ops 소액·단일시장 invariant를 broker 앞에서 다시 고정한다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "live ops execution guard가 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
          action: "KRW-BTC, 10000 KRW 상한, ops identifier, LIMIT post-only 조건을 확인하세요.",
          violations: ["execution_runtime_guard_blocked"],
          events: [],
          trace: {
            reason: "execution_runtime_guard_blocked",
            violations: guardViolations,
          },
        };
      }

      if (!isLiveOpsCliEntryRuntimeRequestEvidenceReady(request)) {
        // wrapper를 직접 조립해도 비용/RiskGate evidence가 없으면 broker side effect를 만들지 않는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "CostModel/RiskGate approval evidence가 없어 broker 제출을 중단했습니다.",
          action: "현재 주문 후보와 일치하는 costSnapshot, riskApproval evidence를 연결한 뒤 다시 실행하세요.",
          violations: ["execution_evidence_missing"],
          events: [],
          trace: {
            reason: "execution_evidence_missing",
          },
        };
      }

      const costRiskViolations = collectLiveOpsCliEntryRuntimeCostRiskViolations(request);
      if (costRiskViolations.length > 0) {
        // stale approval evidence가 붙어 있어도 현재 Cost/Risk 입력이 fail이면 broker 앞에서 다시 닫는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "현재 CostModel/RiskGate 입력이 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
          action: "costInput, risk snapshot, threshold snapshot을 현재 후보 기준으로 다시 계산한 뒤 approval evidence를 갱신하세요.",
          violations: ["execution_runtime_cost_risk_blocked"],
          events: [],
          trace: {
            reason: "execution_runtime_cost_risk_blocked",
            violations: costRiskViolations,
          },
        };
      }

      if (budgetReservation === undefined || typeof budgetReservation.reserve !== "function") {
        // durable reservation port 없이는 중복 주문과 예산 초과를 증명할 수 없으므로 broker 호출 전에 닫는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "durable budget reservation port가 없어 broker 제출을 중단했습니다.",
          action: "idempotency key 기반 reservation 저장소를 연결한 뒤 다시 실행하세요.",
          violations: ["budget_reservation_port_missing"],
          events: [],
          trace: {
            reason: "budget_reservation_port_missing",
          },
        };
      }

      let reservation;
      try {
        reservation = await budgetReservation.reserve(createLiveOpsCliBudgetReservationRequest(request));
      } catch (error) {
        // reservation 실패는 broker 호출 전 상태가 확정되므로 거래소 주문 불확실성이 아니라 예산 선점 경계 차단으로 닫는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "durable budget reservation을 확인할 수 없어 broker 제출을 중단했습니다.",
          action: "reservation 저장소 상태를 복구한 뒤 같은 idempotency key로 다시 평가하세요.",
          violations: ["budget_reservation_unavailable"],
          events: [],
          trace: {
            reason: "budget_reservation_unavailable",
            error: safeErrorName(error),
          },
        };
      }
      if (reservation?.reserved === false) {
        // durable reservation 실패는 broker 호출 전에 닫아 중복 주문과 예산 초과를 막는다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: reservation.message ?? "예산 reservation이 실패해 broker 제출을 중단했습니다.",
          action: "reservation 상태와 예산 사용량을 확인하세요.",
          violations: [reservation.reasonCode ?? "budget_reservation_blocked"],
          events: [],
          trace: {
            reason: reservation.reasonCode ?? "budget_reservation_blocked",
          },
        };
      }
      if (!isLiveOpsCliBudgetReservationEvidence(reservation, request)) {
        // durable reservation 성공 evidence가 없으면 예산 선점과 주문을 연결할 수 없어 broker 호출을 차단한다.
        return {
          status: "BLOCKED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "durable budget reservation 성공 evidence가 없어 broker 제출을 중단했습니다.",
          action: "reservationId와 요청 식별자가 포함된 durable reservation 결과를 확인하세요.",
          violations: ["budget_reservation_evidence_missing"],
          events: [],
          trace: {
            reason: "budget_reservation_evidence_missing",
          },
        };
      }

      const submission = createLiveOpsCliOrderSubmission(request);
      let brokerOrder;
      try {
        brokerOrder = await broker.submitOrder(submission);
      } catch (error) {
        // reservation 뒤 broker 결과가 불확실하면 수동 점검에 필요한 reservation/submission 식별자를 잃지 않는다.
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: "broker 제출 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
          action: "reservation id와 idempotency key로 durable reservation과 거래소 주문 상태를 함께 확인하세요.",
          violations: ["broker_submission_uncertain"],
          events: [],
          trace: {
            reason: "broker_submission_uncertain",
            error: safeErrorName(error),
            reservation: reservation.reservation,
            submission,
          },
          submission,
          reservation: reservation.reservation,
        };
      }
      const brokerOrderViolation = validateLiveOpsCliBrokerOrderEvidence(brokerOrder, submission);
      if (brokerOrderViolation !== undefined) {
        // broker 응답이 접수 상태가 아니면 제출 성공으로 확정하지 않고 수동 점검에 필요한 맥락을 보존한다.
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          attemptId: request.idempotencyKey,
          idempotencyKey: request.idempotencyKey,
          message: brokerOrderViolation.message,
          action: brokerOrderViolation.action,
          violations: [brokerOrderViolation.reason],
          events: [],
          trace: {
            reason: brokerOrderViolation.reason,
            reservation: reservation.reservation,
            submission,
            brokerOrder,
          },
          submission,
          reservation: reservation.reservation,
        };
      }
      if (isLiveOpsCliAutonomousEntryLifecycleEnabled({ request, artifactStore, broker })) {
        return closeLiveOpsCliAutonomousEntryOrder({
          broker,
          artifactStore,
          request,
          reservation: reservation.reservation,
          submission,
          brokerOrder,
          clock,
          pollCount,
          pollIntervalMs,
        });
      }
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: brokerOrder.brokerOrderId,
        message: "live ops entry 후보가 broker 제출 경계를 통과했습니다.",
        action: "후속 reconcile과 cancel/terminal 상태를 확인하세요.",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        submission,
        reservation: reservation.reservation,
        executionResult: {
          status: "SUBMITTED",
          submission,
          brokerOrder,
        },
      };
    },
  };
}

function isLiveOpsCliAutonomousEntryLifecycleEnabled({ request, artifactStore, broker }) {
  return request?.candidate?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    artifactStore !== undefined &&
    typeof artifactStore.writeCleanup === "function" &&
    typeof broker?.getOrder === "function" &&
    typeof broker?.cancelOrder === "function";
}

async function closeLiveOpsCliAutonomousEntryOrder({
  broker,
  artifactStore,
  request,
  reservation,
  submission,
  brokerOrder,
  clock,
  pollCount,
  pollIntervalMs,
}) {
  let fillProbe;
  try {
    fillProbe = await waitForLiveOpsCliExitFillOrOpen({
      broker,
      brokerOrderId: brokerOrder.brokerOrderId,
      pollCount,
      pollIntervalMs,
      submittedOrder: brokerOrder,
    });
  } catch (error) {
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      reason: "entry_order_poll_failed",
      error,
      message: "BUY 주문 제출 후 상태 조회를 완료하지 못해 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문 uuid로 open order, partial fill, 보유 수량을 확인한 뒤 다음 매수 재호가 여부를 결정하세요.",
    });
  }
  if (isLiveOpsCliFilledOrder(fillProbe.order)) {
    return writeLiveOpsCliAutonomousEntryFillCloseoutResult({
      artifactStore,
      request,
      reservation,
      submission,
      brokerOrder,
      terminalOrder: fillProbe.order,
      filledAt: clock(),
    });
  }
  if (isLiveOpsCliTerminalCancelStatus(fillProbe.order?.status)) {
    if (isLiveOpsCliCleanTerminalCancel({ submittedOrder: brokerOrder, terminalOrder: fillProbe.order })) {
      return writeLiveOpsCliAutonomousEntryNoFillCloseoutResult({
        artifactStore,
        request,
        reservation,
        submission,
        brokerOrder,
        terminalOrder: fillProbe.order,
        terminalCheckedAt: clock(),
        status: "CANCELED_FOR_REQUOTE",
        message: "BUY 주문이 이미 terminal cancel/no-fill 상태라 추가 취소 없이 다음 tick 재호가로 전환했습니다.",
        action: "다음 daemon tick에서 최신 호가와 예산으로 BUY 여부를 다시 판단합니다.",
      });
    }
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      terminalOrder: fillProbe.order,
      reason: fillProbe.reason,
      message: "BUY 주문이 이미 terminal cancel 상태지만 no-fill fingerprint가 맞지 않아 수동 점검 상태로 전환했습니다.",
      action: "부분 체결, 수동 취소, 잔고 mismatch 여부를 reconcile한 뒤 다음 매수 재호가 여부를 결정하세요.",
    });
  }

  let cancelOrder;
  try {
    // bounded window 안에 체결되지 않은 post-only BUY는 같은 runtime 소유 uuid만 취소해 예약을 포지션으로 승격하지 않는다.
    cancelOrder = await broker.cancelOrder(brokerOrder.brokerOrderId);
  } catch (error) {
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      reason: "entry_cancel_failed",
      error,
      message: "BUY 주문이 bounded wait 안에 체결되지 않았고 취소 요청도 실패해 수동 점검 상태로 전환했습니다.",
      action: "거래소 open order와 partial fill 여부를 확인한 뒤 수동 취소 또는 reconcile을 진행하세요.",
    });
  }

  const terminal = await waitForLiveOpsCliTerminalCancel({
    broker,
    brokerOrderId: brokerOrder.brokerOrderId,
    pollCount,
    pollIntervalMs,
    submittedOrder: brokerOrder,
  });
  if (isLiveOpsCliCleanTerminalCancel({ submittedOrder: brokerOrder, terminalOrder: terminal.order })) {
    return writeLiveOpsCliAutonomousEntryNoFillCloseoutResult({
      artifactStore,
      request,
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder: terminal.order,
      terminalCheckedAt: clock(),
      status: "CANCELED_FOR_REQUOTE",
      message: "BUY 주문이 bounded wait 안에 체결되지 않아 취소 확인 후 다음 tick 재호가로 전환했습니다.",
      action: "다음 daemon tick에서 최신 호가와 예산으로 BUY 여부를 다시 판단합니다.",
    });
  }
  if (isLiveOpsCliFilledOrder(terminal.order)) {
    return writeLiveOpsCliAutonomousEntryFillCloseoutResult({
      artifactStore,
      request,
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder: terminal.order,
      filledAt: clock(),
    });
  }
  return createLiveOpsCliAutonomousEntryManualReview({
    request,
    reservation,
    submission,
    brokerOrder,
    cancelOrder,
    terminalOrder: terminal.order,
    reason: terminal.reason,
    message: "BUY 주문의 terminal cancel/no-fill 조건을 확인하지 못해 수동 점검 상태로 전환했습니다.",
    action: "partial fill, open order, balance mismatch 여부를 확인하고 신규 주문 전 reconcile evidence를 닫으세요.",
  });
}

async function writeLiveOpsCliAutonomousEntryFillCloseoutResult({
  artifactStore,
  request,
  reservation,
  submission,
  brokerOrder,
  cancelOrder,
  terminalOrder,
  filledAt,
}) {
  const filledQuantity = isPositiveDecimalString(terminalOrder?.requestedQuantity) && isDecimalEqual(terminalOrder?.remainingQuantity ?? "0", "0")
    ? terminalOrder.requestedQuantity
    : request.candidate?.requestedQuantity;
  const filledPrice = isPositiveDecimalString(terminalOrder?.requestedPrice)
    ? terminalOrder.requestedPrice
    : request.candidate?.requestedPrice;
  if (!isPositiveDecimalString(filledQuantity) || !isPositiveDecimalString(filledPrice)) {
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder,
      reason: "entry_fill_quantity_or_price_missing",
      message: "BUY 체결은 확인됐지만 체결 수량/가격을 계산할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "거래소 체결 수량과 가격을 확인하고 autonomous entry fill artifact를 복구하세요.",
    });
  }
  const entryFeeKrw = readLiveOpsCliOrderPaidFeeKrw(terminalOrder) ?? readLiveOpsCliOrderPaidFeeKrw(brokerOrder);
  const record = {
    kind: "live_ops_autonomous_entry_fill_closeout",
    attemptId: request.idempotencyKey,
    idempotencyKey: request.idempotencyKey,
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    market: request.candidate?.market ?? brokerOrder?.market ?? "KRW-BTC",
    side: "BUY",
    status: "FILLED",
    filledQuantity,
    filledPrice,
    filledNotionalKrw: new Decimal(filledQuantity).mul(filledPrice).toFixed(),
    ...(isPositiveDecimalString(entryFeeKrw) ? { entryFeeKrw } : {}),
    filledAt,
    terminalCheckedAt: filledAt,
    idempotencyKeySuffix: suffixLiveOpsCliIdentifier(request.idempotencyKey),
    brokerOrderIdSuffix: suffixLiveOpsCliIdentifier(brokerOrder?.brokerOrderId),
    terminalState: terminalOrder?.status ?? null,
    safeSummary: "autonomous BUY 체결 closeout을 기록했습니다.",
  };
  try {
    const artifactPath = await artifactStore.writeCleanup(record);
    return {
      status: "FILLED",
      attemptId: request.idempotencyKey,
      idempotencyKey: request.idempotencyKey,
      brokerOrderId: brokerOrder.brokerOrderId,
      message: "BUY 주문이 bounded wait 안에서 체결됐습니다.",
      action: "다음 daemon tick에서 포지션, PnL, reconcile 상태를 다시 평가합니다.",
      violations: [],
      events: [],
      trace: {
        reason: "autonomous_entry_filled",
      },
      submission,
      reservation,
      cancelOrder,
      terminalOrder,
      fillArtifactPath: artifactPath,
      executionResult: {
        status: "FILLED",
        submission,
        brokerOrder,
        terminalOrder,
      },
    };
  } catch (error) {
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder,
      reason: "entry_fill_artifact_write_failed",
      error,
      message: "BUY 체결은 확인됐지만 autonomous entry fill artifact를 기록하지 못해 수동 점검 상태로 전환했습니다.",
      action: "체결 주문 uuid와 포지션 상태를 확인하고 같은 포지션을 다시 자동 매수로 열지 않도록 fill 상태를 복구하세요.",
    });
  }
}

async function writeLiveOpsCliAutonomousEntryNoFillCloseoutResult({
  artifactStore,
  request,
  reservation,
  submission,
  brokerOrder,
  cancelOrder,
  terminalOrder,
  terminalCheckedAt,
  status,
  message,
  action,
}) {
  const record = {
    kind: "live_ops_autonomous_entry_no_fill_closeout",
    attemptId: request.idempotencyKey,
    idempotencyKey: request.idempotencyKey,
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    market: request.candidate?.market ?? brokerOrder?.market ?? "KRW-BTC",
    side: "BUY",
    status: "CANCELED",
    filledQuantity: "0",
    filledNotionalKrw: "0",
    terminalCheckedAt,
    idempotencyKeySuffix: suffixLiveOpsCliIdentifier(request.idempotencyKey),
    brokerOrderIdSuffix: suffixLiveOpsCliIdentifier(brokerOrder?.brokerOrderId),
    terminalState: terminalOrder?.status ?? null,
    safeSummary: "autonomous BUY no-fill closeout을 기록했습니다.",
  };
  try {
    const artifactPath = await artifactStore.writeCleanup(record);
    return {
      status,
      attemptId: request.idempotencyKey,
      idempotencyKey: request.idempotencyKey,
      brokerOrderId: brokerOrder.brokerOrderId,
      message,
      action,
      violations: [],
      events: [],
      trace: {
        reason: "autonomous_entry_no_fill",
      },
      submission,
      reservation,
      cancelOrder,
      terminalOrder,
      cleanupArtifactPath: artifactPath,
      executionResult: {
        status,
        submission,
        brokerOrder,
        terminalOrder,
      },
    };
  } catch (error) {
    return createLiveOpsCliAutonomousEntryManualReview({
      request,
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder,
      reason: "entry_no_fill_artifact_write_failed",
      error,
      message: "BUY no-fill은 확인됐지만 closeout artifact를 기록하지 못해 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문 uuid와 reservation 상태를 확인하고 같은 예약을 포지션으로 승격하지 않도록 closeout 상태를 복구하세요.",
    });
  }
}

function createLiveOpsCliAutonomousEntryManualReview({
  request,
  reservation,
  submission,
  brokerOrder,
  cancelOrder,
  terminalOrder,
  reason,
  error,
  message,
  action,
}) {
  return {
    status: "MANUAL_REVIEW_REQUIRED",
    attemptId: request.idempotencyKey,
    idempotencyKey: request.idempotencyKey,
    brokerOrderId: brokerOrder?.brokerOrderId ?? null,
    manualReviewRequired: true,
    message,
    action,
    violations: [reason],
    events: [],
    trace: {
      reason,
      ...(error === undefined ? {} : { error: safeErrorName(error) }),
      reservation,
      submission,
      brokerOrder,
      cancelOrder,
      terminalOrder,
    },
    submission,
    reservation,
    cancelOrder,
    terminalOrder,
  };
}

export function createLiveOpsCliExitRuntime({
  broker,
  artifactStore,
  clock = () => new Date().toISOString(),
  pollCount = liveOpsCliCleanupCancelPollCount,
  pollIntervalMs = liveOpsCliCleanupCancelPollIntervalMs,
} = {}) {
  return {
    async submitExitOrder(submission) {
      if (broker === undefined || typeof broker.submitOrder !== "function") {
        return {
          status: "REJECTED",
          statusLabel: "exit broker 미연결",
          brokerOrderId: null,
          manualReviewRequired: false,
          message: "live broker port가 연결되지 않아 매도 제출을 중단했습니다.",
          action: "Upbit live broker port wiring을 연결한 뒤 같은 후보를 다시 평가하세요.",
        };
      }

      const guardViolations = collectLiveOpsCliExitRuntimeGuardViolations(submission);
      if (guardViolations.length > 0) {
        return {
          status: "REJECTED",
          statusLabel: "exit guard 차단",
          brokerOrderId: null,
          manualReviewRequired: false,
          message: "live ops exit guard가 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
          action: "SELL LIMIT post-only, ops identifier, 보유 scope, 1회 주문 한도를 확인하세요.",
          violations: guardViolations,
        };
      }

      let brokerOrder;
      try {
        // SELL 제출은 실계좌 포지션을 줄이는 side effect이므로 모든 evidence guard 뒤에서만 호출한다.
        brokerOrder = await broker.submitOrder(submission);
      } catch (error) {
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          statusLabel: "수동 점검",
          brokerOrderId: null,
          manualReviewRequired: true,
          message: "매도 broker 제출 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
          action: "idempotency key로 거래소 주문 상태와 보유 수량을 확인하세요.",
          reason: safeErrorName(error),
        };
      }

      const brokerOrderViolation = validateLiveOpsCliBrokerOrderEvidence(brokerOrder, submission);
      if (brokerOrderViolation !== undefined) {
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          statusLabel: "수동 점검",
          brokerOrderId: brokerOrder?.brokerOrderId ?? null,
          manualReviewRequired: true,
          message: brokerOrderViolation.message,
          action: brokerOrderViolation.action,
          reason: brokerOrderViolation.reason,
        };
      }

      let fillProbe;
      try {
        fillProbe = await waitForLiveOpsCliExitFillOrOpen({
          broker,
          brokerOrderId: brokerOrder.brokerOrderId,
          pollCount,
          pollIntervalMs,
          submittedOrder: brokerOrder,
        });
      } catch (error) {
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          statusLabel: "수동 점검",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: true,
          message: "SELL 주문 제출 후 상태 조회를 완료하지 못해 수동 점검 상태로 전환했습니다.",
          action: "거래소 주문 uuid로 open order, partial fill, 보유 수량을 확인한 뒤 다음 재호가 여부를 결정하세요.",
          reason: "exit_order_poll_failed",
          errorName: safeErrorName(error),
          errorMessage: error instanceof Error ? error.message : String(error),
          submittedOrder: brokerOrder,
        };
      }
      if (isLiveOpsCliFilledOrder(fillProbe.order)) {
        const filledAt = clock();
        const closeout = await writeLiveOpsCliAutonomousExitCloseoutOrManualReview({
          artifactStore,
          submission,
          brokerOrder,
          terminalOrder: fillProbe.order,
          filledAt,
        });
        if (closeout?.status === "MANUAL_REVIEW_REQUIRED") {
          return closeout;
        }
        return {
          status: "FILLED",
          statusLabel: "매도 체결",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: false,
          message: "SELL 주문이 bounded wait 안에서 체결됐습니다.",
          action: "다음 daemon tick에서 포지션, PnL, reconcile 상태를 다시 평가합니다.",
          filledAt,
          cleanupArtifactPath: closeout?.artifactPath,
        };
      }
      if (isLiveOpsCliTerminalCancelStatus(fillProbe.order?.status)) {
        if (isLiveOpsCliCleanTerminalCancel({ submittedOrder: brokerOrder, terminalOrder: fillProbe.order })) {
          return {
            status: "CANCELED_FOR_REQUOTE",
            statusLabel: "재호가 대기",
            brokerOrderId: brokerOrder.brokerOrderId,
            manualReviewRequired: false,
            message: "SELL 주문이 이미 terminal cancel/no-fill 상태라 추가 취소 없이 다음 tick 재호가 대기로 전환했습니다.",
            action: "다음 daemon tick에서 보유 수량과 최신 호가로 SELL 여부를 다시 판단합니다.",
            cancelOrder: undefined,
            terminalOrder: fillProbe.order,
          };
        }
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          statusLabel: "수동 점검",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: true,
          message: "SELL 주문이 이미 terminal cancel 상태지만 no-fill fingerprint가 맞지 않아 수동 점검 상태로 전환했습니다.",
          action: "부분 체결, 수동 취소, 잔고 mismatch 여부를 reconcile한 뒤 다음 재호가 여부를 결정하세요.",
          reason: fillProbe.reason,
          terminalOrder: fillProbe.order,
        };
      }

      let cancelOrder;
      try {
        // bounded window 안에 체결되지 않은 post-only SELL은 같은 runtime 소유 uuid만 취소해 다음 tick에서 재호가한다.
        cancelOrder = await broker.cancelOrder(brokerOrder.brokerOrderId);
      } catch (error) {
        return {
          status: "MANUAL_REVIEW_REQUIRED",
          statusLabel: "수동 점검",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: true,
          message: "SELL 주문이 bounded wait 안에 체결되지 않았고 취소 요청도 실패해 수동 점검 상태로 전환했습니다.",
          action: "거래소 open order와 partial fill 여부를 확인한 뒤 수동 취소 또는 reconcile을 진행하세요.",
          reason: safeErrorName(error),
        };
      }

      const terminal = await waitForLiveOpsCliTerminalCancel({
        broker,
        brokerOrderId: brokerOrder.brokerOrderId,
        pollCount,
        pollIntervalMs,
        submittedOrder: brokerOrder,
      });
      if (isLiveOpsCliCleanTerminalCancel({ submittedOrder: brokerOrder, terminalOrder: terminal.order })) {
        return {
          status: "CANCELED_FOR_REQUOTE",
          statusLabel: "재호가 대기",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: false,
          message: "SELL 주문이 bounded wait 안에 체결되지 않아 취소 확인 후 다음 tick 재호가 대기로 전환했습니다.",
          action: "다음 daemon tick에서 보유 수량과 최신 호가로 SELL 여부를 다시 판단합니다.",
          cancelOrder,
          terminalOrder: terminal.order,
        };
      }
      if (isLiveOpsCliFilledOrder(terminal.order)) {
        const filledAt = clock();
        const closeout = await writeLiveOpsCliAutonomousExitCloseoutOrManualReview({
          artifactStore,
          submission,
          brokerOrder,
          terminalOrder: terminal.order,
          filledAt,
        });
        if (closeout?.status === "MANUAL_REVIEW_REQUIRED") {
          return closeout;
        }
        return {
          status: "FILLED",
          statusLabel: "매도 체결",
          brokerOrderId: brokerOrder.brokerOrderId,
          manualReviewRequired: false,
          message: "SELL 주문이 cancel 확인 전 체결 상태로 확인됐습니다.",
          action: "다음 daemon tick에서 포지션, PnL, reconcile 상태를 다시 평가합니다.",
          filledAt,
          cleanupArtifactPath: closeout?.artifactPath,
        };
      }
      return {
        status: "MANUAL_REVIEW_REQUIRED",
        statusLabel: "수동 점검",
        brokerOrderId: brokerOrder.brokerOrderId,
        manualReviewRequired: true,
        message: "SELL 주문의 terminal cancel/no-fill 조건을 확인하지 못해 수동 점검 상태로 전환했습니다.",
        action: "partial fill, open order, balance mismatch 여부를 확인하고 신규 주문 전 reconcile evidence를 닫으세요.",
        reason: terminal.reason,
        cancelOrder,
        terminalOrder: terminal.order,
      };
    },
  };
}

async function writeLiveOpsCliAutonomousExitCloseoutOrManualReview({
  artifactStore,
  submission,
  brokerOrder,
  terminalOrder,
  filledAt,
}) {
  if (artifactStore === undefined || typeof artifactStore.writeCleanup !== "function") {
    return undefined;
  }
  const intent = submission?.intent ?? {};
  if (intent.strategyId !== liveOpsCliAutonomous24x7StrategyId || intent.side !== "SELL") {
    return undefined;
  }
  const filledQuantity = isNonNegativeDecimalString(terminalOrder?.requestedQuantity) && isDecimalEqual(terminalOrder?.remainingQuantity ?? "0", "0")
    ? terminalOrder.requestedQuantity
    : intent.requestedQuantity;
  const requestedPrice = isPositiveDecimalString(intent.requestedPrice) ? intent.requestedPrice : terminalOrder?.requestedPrice;
  const pnlEvidence = createLiveOpsCliAutonomousExitRealizedPnlEvidence({
    intent,
    filledQuantity,
    requestedPrice,
    terminalOrder,
    brokerOrder,
  });
  if (pnlEvidence.status !== "ready") {
    // 실현손익 없는 closeout은 손실 guard를 잘못 열 수 있으므로 artifact ready로 인정하지 않는다.
    return {
      status: "MANUAL_REVIEW_REQUIRED",
      statusLabel: "수동 점검",
      brokerOrderId: brokerOrder?.brokerOrderId ?? null,
      manualReviewRequired: true,
      message: "SELL 체결은 확인됐지만 원가/체결가 기반 실현손익을 계산할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "전략 reservation 원가와 실제 체결가를 확인하고 realized PnL closeout artifact를 복구하세요.",
      reason: pnlEvidence.reason,
      filledAt,
    };
  }
  const record = {
    kind: "live_ops_autonomous_exit_closeout",
    attemptId: intent.idempotencyKey,
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    market: intent.market ?? brokerOrder?.market ?? "KRW-BTC",
    side: "SELL",
    status: "FILLED",
    filledQuantity,
    filledPrice: pnlEvidence.filledPrice,
    filledNotionalKrw: pnlEvidence.filledNotionalKrw,
    entryAveragePrice: pnlEvidence.entryAveragePrice,
    entryCostNotionalKrw: pnlEvidence.entryCostNotionalKrw,
    entryFeeKrw: pnlEvidence.entryFeeKrw,
    exitFeeKrw: pnlEvidence.exitFeeKrw,
    totalFeeKrw: pnlEvidence.totalFeeKrw,
    realizedPnlKrw: pnlEvidence.realizedPnlKrw,
    pnlSource: pnlEvidence.source,
    filledAt,
    terminalCheckedAt: filledAt,
    idempotencyKeySuffix: suffixLiveOpsCliIdentifier(intent.idempotencyKey),
    brokerOrderIdSuffix: suffixLiveOpsCliIdentifier(brokerOrder?.brokerOrderId),
    terminalState: terminalOrder?.status ?? null,
    positionEffect: readLiveOpsCliPositionEffect(intent) ?? "EXIT",
    safeSummary: "autonomous SELL 체결 closeout을 기록했습니다.",
  };
  try {
    const artifactPath = await artifactStore.writeCleanup(record);
    return { artifactPath };
  } catch (error) {
    return {
      status: "MANUAL_REVIEW_REQUIRED",
      statusLabel: "수동 점검",
      brokerOrderId: brokerOrder?.brokerOrderId ?? null,
      manualReviewRequired: true,
      message: "SELL 체결은 확인됐지만 autonomous closeout artifact를 기록하지 못해 수동 점검 상태로 전환했습니다.",
      action: "체결 주문 uuid와 포지션 상태를 확인하고 같은 포지션을 다시 자동 매도하지 않도록 closeout 상태를 복구하세요.",
      reason: "exit_cleanup_artifact_write_failed",
      errorName: safeErrorName(error),
      filledAt,
    };
  }
}

function createLiveOpsCliAutonomousExitRealizedPnlEvidence({ intent, filledQuantity, requestedPrice, terminalOrder, brokerOrder }) {
  const entryAveragePrice = readLiveOpsCliAutonomousExitEntryAveragePrice(intent);
  if (!isPositiveDecimalString(filledQuantity)) {
    return { status: "blocked", reason: "exit_filled_quantity_missing" };
  }
  if (!isPositiveDecimalString(requestedPrice)) {
    return { status: "blocked", reason: "exit_filled_price_missing" };
  }
  if (!isPositiveDecimalString(entryAveragePrice)) {
    return { status: "blocked", reason: "exit_entry_cost_basis_missing" };
  }
  const quantity = new Decimal(filledQuantity);
  const filledPrice = new Decimal(requestedPrice);
  const averageEntryPrice = new Decimal(entryAveragePrice);
  const filledNotionalKrw = quantity.mul(filledPrice);
  const entryCostNotionalKrw = quantity.mul(averageEntryPrice);
  const entryFeeKrw = new Decimal(readLiveOpsCliAutonomousExitEntryFeeKrw({ intent, filledQuantity }));
  const exitFeeKrw = new Decimal(readLiveOpsCliOrderPaidFeeKrw(terminalOrder) ?? readLiveOpsCliOrderPaidFeeKrw(brokerOrder) ?? "0");
  const totalFeeKrw = entryFeeKrw.plus(exitFeeKrw);
  return {
    status: "ready",
    filledPrice: filledPrice.toFixed(),
    filledNotionalKrw: filledNotionalKrw.toFixed(),
    entryAveragePrice: averageEntryPrice.toFixed(),
    entryCostNotionalKrw: entryCostNotionalKrw.toFixed(),
    entryFeeKrw: entryFeeKrw.toFixed(),
    exitFeeKrw: exitFeeKrw.toFixed(),
    totalFeeKrw: totalFeeKrw.toFixed(),
    realizedPnlKrw: filledNotionalKrw.minus(entryCostNotionalKrw).minus(totalFeeKrw).toFixed(),
    source: "live_ops_autonomous_preflight_position_scope",
  };
}

function readLiveOpsCliAutonomousExitEntryAveragePrice(intent) {
  const preflightScope = intent?.metadata?.preflight_position_scope;
  if (isPositiveDecimalString(preflightScope?.average_entry_price)) {
    return preflightScope.average_entry_price;
  }
  const positionScope = intent?.metadata?.position_scope;
  if (isPositiveDecimalString(positionScope?.average_entry_price)) {
    return positionScope.average_entry_price;
  }
  return undefined;
}

function readLiveOpsCliAutonomousExitEntryFeeKrw({ intent, filledQuantity }) {
  const preflightScope = intent?.metadata?.preflight_position_scope;
  const positionScope = intent?.metadata?.position_scope;
  const scope = isNonNegativeDecimalString(preflightScope?.entry_fee_krw)
    ? preflightScope
    : isNonNegativeDecimalString(positionScope?.entry_fee_krw)
    ? positionScope
    : intent?.metadata;
  const entryFeeKrw = isNonNegativeDecimalString(scope?.entry_fee_krw)
    ? new Decimal(scope.entry_fee_krw)
    : isNonNegativeDecimalString(scope?.entryFeeKrw)
    ? new Decimal(scope.entryFeeKrw)
    : new Decimal(0);
  const totalQuantity = isPositiveDecimalString(scope?.total_quantity) ? new Decimal(scope.total_quantity) : undefined;
  if (totalQuantity !== undefined && totalQuantity.gt(0) && isPositiveDecimalString(filledQuantity)) {
    return entryFeeKrw.mul(Decimal.min(new Decimal(filledQuantity), totalQuantity).div(totalQuantity)).toFixed();
  }
  return entryFeeKrw.toFixed();
}

function readLiveOpsCliOrderPaidFeeKrw(order) {
  const fee = readFirstLiveOpsCliDecimalField(order, [
    "paidFeeKrw",
    "paid_fee_krw",
    "paidFee",
    "paid_fee",
    "tradeFee",
    "trade_fee",
    "executedFee",
    "executed_fee",
  ]);
  if (!isNonNegativeDecimalString(fee)) {
    return undefined;
  }
  const currency = readFirstLiveOpsCliStringField(order, [
    "feeCurrency",
    "fee_currency",
    "paidFeeCurrency",
    "paid_fee_currency",
  ]);
  if (currency !== undefined && String(currency).toUpperCase() !== "KRW") {
    return undefined;
  }
  return fee;
}

function readFirstLiveOpsCliDecimalField(record, keys) {
  for (const key of keys) {
    if (isNonNegativeDecimalString(record?.[key])) {
      return String(record[key]);
    }
  }
  return undefined;
}

function readFirstLiveOpsCliStringField(record, keys) {
  for (const key of keys) {
    if (hasMeaningfulValue(record?.[key])) {
      return String(record[key]);
    }
  }
  return undefined;
}

export function createLiveOpsCliCleanupLifecycle({
  broker,
  artifactStore,
  clock = () => new Date().toISOString(),
  cancelPollCount = liveOpsCliCleanupCancelPollCount,
  cancelPollIntervalMs = liveOpsCliCleanupCancelPollIntervalMs,
} = {}) {
  return async function cleanupLifecycle({ submittedSummary, attempt, request, market, observedAt }) {
    const brokerOrder = attempt?.executionResult?.brokerOrder;
    if (!isNonEmptyRecord(brokerOrder) || !hasMeaningfulValue(brokerOrder.brokerOrderId)) {
      return createLiveOpsCliCleanupManualReviewSummary({
        submittedSummary,
        attempt,
        request,
        market,
        observedAt,
        reason: "submitted_order_evidence_missing",
        message: "broker 제출은 성공했지만 취소할 주문 uuid evidence가 없어 수동 점검 상태로 전환했습니다.",
        action: "reservation id와 idempotency key로 거래소 주문을 조회한 뒤 수동 취소 여부를 결정하세요.",
      });
    }

    let cancelOrder;
    const cancelRequestedAt = clock();
    try {
      // cleanup_probe는 제출 성공 직후 같은 runtime이 받은 uuid만 취소해 임의 주문 취소를 막는다.
      cancelOrder = await broker.cancelOrder(brokerOrder.brokerOrderId);
    } catch (error) {
      const record = createLiveOpsCliCleanupArtifactRecord({
        status: "manual_review_required",
        reason: safeErrorName(error),
        failure: error,
        attempt,
        request,
        brokerOrder,
        cancelOrder: undefined,
        terminalOrder: undefined,
        submittedAt: observedAt,
        cancelRequestedAt,
        terminalCheckedAt: clock(),
        cleanCancel: false,
      });
      const artifactPath = await safeWriteLiveOpsCliCleanupArtifact(artifactStore, record);
      return createLiveOpsCliCleanupManualReviewSummary({
        submittedSummary,
        attempt,
        request,
        market,
        observedAt,
        reason: "cancel_request_failed",
        message: "실주문 제출 후 취소 요청을 완료하지 못해 수동 점검 상태로 전환했습니다.",
        action: "거래소 open order를 확인하고 같은 uuid를 수동 취소한 뒤 reconcile evidence를 남기세요.",
        artifactPath,
      });
    }

    let terminal;
    try {
      terminal = await waitForLiveOpsCliTerminalCancel({
        broker,
        brokerOrderId: brokerOrder.brokerOrderId,
        pollCount: cancelPollCount,
        pollIntervalMs: cancelPollIntervalMs,
        submittedOrder: brokerOrder,
      });
    } catch (error) {
      const terminalCheckedAt = clock();
      const record = createLiveOpsCliCleanupArtifactRecord({
        status: "manual_review_required",
        reason: safeErrorName(error),
        failure: error,
        attempt,
        request,
        brokerOrder,
        cancelOrder,
        terminalOrder: undefined,
        submittedAt: observedAt,
        cancelRequestedAt,
        terminalCheckedAt,
        cleanCancel: false,
      });
      // 취소 side effect 이후 poll만 실패한 경우도 closeout 수동 점검에 필요한 evidence를 잃지 않는다.
      const artifactPath = await safeWriteLiveOpsCliCleanupArtifact(artifactStore, record);
      return createLiveOpsCliCleanupManualReviewSummary({
        submittedSummary,
        attempt,
        request,
        market,
        observedAt,
        reason: "cancel_poll_failed",
        message: "취소 요청은 전송됐지만 terminal 상태 조회를 완료하지 못해 수동 점검 상태로 전환했습니다.",
        action: "거래소 주문 uuid로 최종 주문 상태와 fill 여부를 조회하고 cleanup artifact와 함께 closeout evidence를 남기세요.",
        artifactPath,
      });
    }
    const terminalCheckedAt = clock();
    const cleanCancel = isLiveOpsCliCleanTerminalCancel({
      submittedOrder: brokerOrder,
      terminalOrder: terminal.order,
    });
    const record = createLiveOpsCliCleanupArtifactRecord({
      status: cleanCancel ? "completed" : "manual_review_required",
      reason: cleanCancel ? "terminal_cancel_confirmed" : terminal.reason,
      attempt,
      request,
      brokerOrder,
      cancelOrder,
      terminalOrder: terminal.order,
      submittedAt: observedAt,
      cancelRequestedAt,
      terminalCheckedAt,
      cleanCancel,
    });
    const artifactPath = await safeWriteLiveOpsCliCleanupArtifact(artifactStore, record);
    if (!cleanCancel) {
      return createLiveOpsCliCleanupManualReviewSummary({
        submittedSummary,
        attempt,
        request,
        market,
        observedAt,
        reason: terminal.reason,
        message: "취소 terminal 상태나 no-fill 조건을 확인하지 못해 수동 점검 상태로 전환했습니다.",
        action: "거래소 주문 상태, 잔고, fill 여부를 확인하고 open exposure를 0으로 닫으세요.",
        artifactPath,
      });
    }

    return {
      ...submittedSummary,
      status: "cancel_confirmed",
      ready: true,
      liveOrderCapable: true,
      statusLabel: "취소 확인",
      message: "실주문 제출, 취소 요청, terminal cancel 확인이 같은 cleanup attempt에서 완료됐습니다.",
      action: "저장소 밖 cleanup artifact와 post private read summary를 closeout validator로 검증하세요.",
      cleanupStatus: "completed",
      cancelRequestedAt,
      terminalCheckedAt,
      terminalState: terminal.order.status,
      cleanupArtifactPath: artifactPath,
      cleanup: {
        cleanCancel: true,
        identifierSuffix: suffixLiveOpsCliIdentifier(attempt.idempotencyKey),
        brokerOrderIdSuffix: suffixLiveOpsCliIdentifier(brokerOrder.brokerOrderId),
        artifactPath,
      },
      checks: [
        ...submittedSummary.checks,
        okLiveExecutionCheck("cancel_request", "같은 runtime이 제출한 uuid로 취소 요청을 보냈습니다.", "live_ops_cleanup_cancel_requested"),
        okLiveExecutionCheck("terminal_cancel", "terminal cancel과 no-fill 조건을 확인했습니다.", "live_ops_cleanup_terminal_cancel_confirmed"),
        okLiveExecutionCheck("cleanup_artifact", "저장소 밖 redacted cleanup artifact를 기록했습니다.", "live_ops_cleanup_artifact_written", {
          artifactPath,
        }),
      ],
    };
  };
}

function createLiveOpsCliCleanupManualReviewSummary({
  submittedSummary,
  attempt,
  request,
  market,
  observedAt,
  reason,
  message,
  action,
  artifactPath,
}) {
  return {
    ...submittedSummary,
    status: "manual_review_required",
    ready: false,
    liveOrderCapable: false,
    market,
    latestExecutionAt: observedAt,
    attemptStatus: attempt?.status ?? submittedSummary.attemptStatus,
    attemptId: attempt?.attemptId ?? request?.idempotencyKey ?? submittedSummary.attemptId,
    idempotencyKey: attempt?.idempotencyKey ?? request?.idempotencyKey ?? submittedSummary.idempotencyKey,
    statusLabel: "수동 점검",
    message,
    action,
    cleanupStatus: "manual_review_required",
    cleanupArtifactPath: artifactPath ?? null,
    checks: [
      ...submittedSummary.checks,
      blockedLiveExecutionCheck("cleanup_lifecycle", message, "live_ops_cleanup_manual_review_required", {
        reason,
        ...(artifactPath === undefined ? {} : { artifactPath }),
      }),
    ],
  };
}

async function waitForLiveOpsCliTerminalCancel({ broker, brokerOrderId, pollCount, pollIntervalMs, submittedOrder }) {
  let latestOrder = submittedOrder;
  for (let attempt = 0; attempt < pollCount; attempt += 1) {
    if (attempt > 0 && pollIntervalMs > 0) {
      await sleepLiveOpsCli(pollIntervalMs);
    }
    const current = await broker.getOrder(brokerOrderId);
    if (current !== undefined) {
      latestOrder = current;
    }
    if (isLiveOpsCliTerminalCancelStatus(latestOrder?.status)) {
      return {
        order: latestOrder,
        reason: "terminal_cancel_confirmed",
      };
    }
    if (isLiveOpsCliTerminalFilledStatus(latestOrder?.status)) {
      return {
        order: latestOrder,
        reason: "order_filled_before_cancel",
      };
    }
  }
  return {
    order: latestOrder,
    reason: "terminal_cancel_timeout",
  };
}

async function waitForLiveOpsCliExitFillOrOpen({ broker, brokerOrderId, pollCount, pollIntervalMs, submittedOrder }) {
  let latestOrder = submittedOrder;
  for (let attempt = 0; attempt < pollCount; attempt += 1) {
    if (attempt > 0 && pollIntervalMs > 0) {
      await sleepLiveOpsCli(pollIntervalMs);
    }
    const current = await broker.getOrder(brokerOrderId);
    if (current !== undefined) {
      latestOrder = current;
    }
    if (isLiveOpsCliFilledOrder(latestOrder)) {
      return {
        order: latestOrder,
        reason: "exit_order_filled",
      };
    }
    if (isLiveOpsCliTerminalCancelStatus(latestOrder?.status)) {
      return {
        order: latestOrder,
        reason: "exit_order_unexpected_terminal_cancel",
      };
    }
  }
  return {
    order: latestOrder,
    reason: "exit_order_still_open",
  };
}

function isLiveOpsCliFilledOrder(order) {
  return isLiveOpsCliTerminalFilledStatus(order?.status) && isDecimalEqual(order?.remainingQuantity ?? "0", "0");
}

function isLiveOpsCliCleanTerminalCancel({ submittedOrder, terminalOrder }) {
  return (
    isLiveOpsCliTerminalCancelStatus(terminalOrder?.status) &&
    terminalOrder?.brokerOrderId === submittedOrder?.brokerOrderId &&
    isDecimalEqual(terminalOrder?.requestedQuantity, submittedOrder?.requestedQuantity) &&
    isDecimalEqual(terminalOrder?.remainingQuantity, submittedOrder?.requestedQuantity)
  );
}

function isLiveOpsCliTerminalCancelStatus(status) {
  return ["CANCELED", "CANCELLED", "CANCEL_CONFIRMED", "CANCEL"].includes(String(status ?? "").toUpperCase());
}

function isLiveOpsCliTerminalFilledStatus(status) {
  return ["FILLED", "DONE", "CLOSED"].includes(String(status ?? "").toUpperCase());
}

function createLiveOpsCliCleanupArtifactRecord({
  status,
  reason,
  failure,
  attempt,
  request,
  brokerOrder,
  cancelOrder,
  terminalOrder,
  submittedAt,
  cancelRequestedAt,
  terminalCheckedAt,
  cleanCancel,
}) {
  return {
    kind: "live_ops_cleanup_closeout",
    status,
    reason,
    attemptId: attempt?.attemptId ?? request?.idempotencyKey ?? null,
    idempotencyKeySuffix: suffixLiveOpsCliIdentifier(attempt?.idempotencyKey ?? request?.idempotencyKey),
    market: request?.candidate?.market ?? brokerOrder?.market ?? null,
    side: "BUY",
    orderType: "LIMIT",
    timeInForce: "POST_ONLY",
    requestedNotionalKrw: request?.candidate?.requestedNotional ?? null,
    submittedAt,
    cancelRequestedAt,
    terminalCheckedAt,
    ...(cleanCancel ? { terminalCancelConfirmedAt: terminalCheckedAt } : {}),
    identifierSuffix: suffixLiveOpsCliIdentifier(attempt?.idempotencyKey ?? request?.idempotencyKey),
    cancelIdentifierSuffix: suffixLiveOpsCliIdentifier(attempt?.idempotencyKey ?? request?.idempotencyKey),
    brokerOrderIdSuffix: suffixLiveOpsCliIdentifier(brokerOrder?.brokerOrderId),
    cancelBrokerOrderIdSuffix: suffixLiveOpsCliIdentifier(cancelOrder?.brokerOrderId ?? brokerOrder?.brokerOrderId),
    terminalState: terminalOrder?.status ?? null,
    ...(failure === undefined ? {} : { failure: createLiveOpsCliCleanupFailureSummary(failure) }),
    openExposureKrw: cleanCancel ? "0" : null,
    duplicateOrderCount: 0,
    reconcileMismatchCount: cleanCancel ? 0 : null,
    untrackedFillCount: cleanCancel ? 0 : null,
    liveOrderCleanupFailureCount: cleanCancel ? 0 : 1,
    safeSummary: cleanCancel
      ? "submit -> cancel requested -> terminal cancel 확인이 완료됐습니다."
      : "cleanup lifecycle 확인이 수동 점검 상태로 전환됐습니다.",
  };
}

function createLiveOpsCliCleanupFailureSummary(error) {
  const summary = {
    errorName: safeErrorName(error),
  };
  if (Number.isInteger(error?.status)) {
    summary.status = error.status;
  }
  if (hasMeaningfulValue(error?.upbitErrorName)) {
    summary.upbitErrorName = String(error.upbitErrorName);
  }
  return summary;
}

async function safeWriteLiveOpsCliCleanupArtifact(artifactStore, record) {
  if (artifactStore === undefined || typeof artifactStore.writeCleanup !== "function") {
    return undefined;
  }
  return artifactStore.writeCleanup(record);
}

function suffixLiveOpsCliIdentifier(value) {
  if (!hasMeaningfulValue(value)) {
    return null;
  }
  return String(value).slice(-8);
}

function sleepLiveOpsCli(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isLiveOpsCliEntryRuntimeRequestEvidenceReady(request) {
  const useRuntimeEvidenceKey = request.candidate?.strategyId === liveOpsCliAutonomous24x7StrategyId &&
    request.candidate?.metadata?.runtime_idempotency_source === "live_ops_cli_autonomous_entry_runtime";
  const intent = {
    exchangeId: request.candidate?.exchangeId,
    market: request.candidate?.market,
    strategyId: request.candidate?.strategyId,
    side: "BUY",
    orderType: "LIMIT",
    postOnly: request.candidate?.postOnly,
    timeInForce: request.candidate?.timeInForce,
    requestedQuantity: request.candidate?.requestedQuantity,
    requestedNotional: request.candidate?.requestedNotional,
    requestedPrice: request.candidate?.requestedPrice,
    idempotencyKey: useRuntimeEvidenceKey
      ? request.idempotencyKey
      : request.candidate?.metadata?.decision_idempotency_key ?? request.idempotencyKey,
    metadata: {
      expected_loss_bps_of_equity: request.candidate?.expectedLossBpsOfEquity,
    },
  };

  return (
    isLiveOpsCliCostSnapshotEvidence(request.candidate?.costSnapshot, intent) &&
    isLiveOpsCliRiskApprovalEvidence(request.candidate?.riskApproval, intent)
  );
}

function collectLiveOpsCliExitRuntimeGuardViolations(submission) {
  const violations = [];
  const intent = submission?.intent;
  if (intent?.exchangeId !== "upbit_krw_spot") {
    violations.push("live ops exit wrapper exchange는 upbit_krw_spot이어야 합니다");
  }
  if (intent?.market !== "KRW-BTC") {
    violations.push("live ops exit wrapper는 KRW-BTC 단일 market만 제출할 수 있습니다");
  }
  if (intent?.side !== "SELL") {
    violations.push("live ops exit wrapper는 SELL 후보만 제출할 수 있습니다");
  }
  if (!isLiveOpsCliPostOnlyLimitIntent(intent)) {
    violations.push("live ops exit wrapper 후보는 LIMIT + post_only 조건이어야 합니다");
  }
  if (!isLiveOpsCliLiveAttemptId(intent?.idempotencyKey)) {
    violations.push("live ops exit wrapper idempotency key는 ops- prefix와 13 bytes hex suffix 조건을 만족해야 합니다");
  }
  if (!isPositiveDecimalString(intent?.requestedPrice) || !isPositiveDecimalString(intent?.requestedQuantity) || !isPositiveDecimalString(intent?.requestedNotional)) {
    violations.push("live ops exit wrapper 후보 가격, 수량, 주문 금액은 양수 decimal이어야 합니다");
  } else {
    const actualNotional = new Decimal(intent.requestedPrice).mul(intent.requestedQuantity);
    if (!actualNotional.equals(new Decimal(intent.requestedNotional))) {
      violations.push("live ops exit wrapper 후보 requestedNotional은 가격 * 수량과 같아야 합니다");
    }
    if (actualNotional.lt(5_000)) {
      violations.push("live ops exit wrapper 후보는 Upbit KRW 최소 주문금액 이상이어야 합니다");
    }
    if (actualNotional.gt(10_000)) {
      violations.push("live ops exit wrapper 후보 실제 주문 금액이 단일 주문 상한을 초과했습니다");
    }
  }
  const positionEffect = readLiveOpsCliPositionEffect(intent);
  if (positionEffect !== "REDUCE" && positionEffect !== "EXIT") {
    violations.push("live ops exit wrapper 후보에는 REDUCE 또는 EXIT position effect가 필요합니다");
  }
  const positionScope = readLiveOpsCliExitPositionScope(intent);
  if (positionScope === undefined) {
    violations.push("live ops exit wrapper 후보에는 position scope가 필요합니다");
  } else {
    const quantityViolation = validateLiveOpsCliExitQuantityAgainstScope(intent, positionScope, positionEffect);
    if (quantityViolation !== undefined) {
      violations.push(quantityViolation);
    }
  }
  if (!isLiveOpsCliExitCostSnapshotEvidence(submission?.costSnapshot, intent)) {
    violations.push("live ops exit wrapper 후보에는 exit cost evidence가 필요합니다");
  }
  if (!isLiveOpsCliRiskApprovalEvidence(submission?.riskApproval, intent)) {
    violations.push("live ops exit wrapper 후보에는 RiskGate approval evidence가 필요합니다");
  }
  return violations;
}

function buildLiveOpsCliLiveExecutionSummary(input) {
  return {
    status: input.status,
    ready: input.ready,
    liveOrderCapable: input.liveOrderCapable,
    market: input.market,
    latestExecutionAt: input.latestExecutionAt ?? null,
    orderIntentCount: input.orderIntentCount,
    attemptedOrderCount: input.attemptedOrderCount,
    submittedOrderCount: input.submittedOrderCount,
    attemptStatus: input.attemptStatus ?? null,
    attemptId: input.attemptId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    brokerOrderId: input.brokerOrderId ?? null,
    brokerGuard: input.brokerGuard,
    statusLabel: input.statusLabel,
    message: input.message,
    action: input.action,
    ...(input.preflightReconcileEvidence === undefined ? {} : { preflightReconcileEvidence: input.preflightReconcileEvidence }),
    checks: input.checks,
  };
}

function evaluateLiveOpsCliBrokerGuard({ config, env = {}, fixtureSmoke }) {
  const checks = [
    okLiveExecutionCheck("broker_guard", "Upbit live broker guard 입력을 확인했습니다.", "live_ops_broker_guard_config_ok", {
      market: config.universe?.default_market ?? "KRW-BTC",
      fixtureSmoke,
    }),
  ];
  const violations = [];
  const scopes = parseLiveOpsKeyScopes(env.SEEMIRAI_UPBIT_KEY_SCOPE);
  const credentialsConfigured = hasMeaningfulValue(env.SEEMIRAI_UPBIT_ACCESS_KEY) && hasMeaningfulValue(env.SEEMIRAI_UPBIT_SECRET_KEY);
  const requiredScopes = ["자산조회", "주문조회", "주문하기"];
  const allowedScopes = new Set(requiredScopes);
  const forbiddenScopes = new Set(["출금조회", "출금하기", "입금조회", "입금하기", "선물", "레버리지", "마진"]);

  if (!credentialsConfigured) {
    violations.push("SEEMIRAI_UPBIT_ACCESS_KEY와 SEEMIRAI_UPBIT_SECRET_KEY 값이 필요합니다");
  }
  for (const requiredScope of requiredScopes) {
    if (!scopes.includes(requiredScope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 ${requiredScope} 권한이 필요합니다`);
    }
  }
  for (const scope of scopes) {
    if (forbiddenScopes.has(scope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 금지 권한이 포함되어 있습니다: ${scope}`);
    } else if (!allowedScopes.has(scope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 알 수 없는 권한이 포함되어 있습니다: ${scope}`);
    }
  }
  if (!hasMeaningfulValue(env.SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID)) {
    violations.push("SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID 값이 필요합니다");
  }
  if (config.universe?.default_market !== "KRW-BTC") {
    violations.push("Upbit live broker guard market은 KRW-BTC만 허용합니다");
  }
  if (config.budget?.max_order_krw !== "10000") {
    violations.push("Upbit live broker guard 단일 주문 상한은 10000 KRW여야 합니다");
  }

  if (violations.length > 0) {
    checks.push(blockedLiveExecutionCheck("broker_guard", "Upbit live broker guard가 완성되지 않았습니다.", "live_ops_broker_guard_blocked", {
      violations,
    }));
  } else {
    checks.push(okLiveExecutionCheck("broker_guard", "Upbit live broker guard가 live execution 전제 조건을 통과했습니다.", "live_ops_broker_guard_ready", {
      keyScopeEvidenceId: env.SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID,
      orderSmokeMarket: "KRW-BTC",
      orderSmokeMaxKrw: config.budget?.max_order_krw ?? "10000",
    }));
  }

  return {
    ready: violations.length === 0,
    credentialsConfigured,
    keyScopes: scopes,
    keyScopeEvidenceId: env.SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID ?? null,
    orderSmokeMarket: "KRW-BTC",
    orderSmokeMaxKrw: config.budget?.max_order_krw ?? "10000",
    statusLabel: violations.length === 0 ? "live broker 조립 가능" : "live broker guard 미충족",
    message: violations.length === 0
      ? "Upbit live broker guard가 충족됐습니다. 후보가 생기면 제출 직전 동일 조건을 다시 확인합니다."
      : "Upbit live broker guard가 완성되지 않아 private order client를 열 수 없습니다.",
    action: violations.length === 0
      ? "후보 제출 전 market, 예산, identifier, key scope evidence를 다시 확인하세요."
      : "추적 정보의 guard 위반 항목을 수정한 뒤 다시 실행하세요.",
    violations,
    checks,
  };
}

function validateLiveOpsCliOrderIntentCount(analysisDecision, intents) {
  if (analysisDecision.orderIntentCount !== intents.length) {
    return {
      code: "live_ops_order_intent_count_mismatch",
      message: "analysis summary의 주문 후보 수와 전달된 order intent 수가 다릅니다.",
      details: {
        summaryOrderIntentCount: analysisDecision.orderIntentCount,
        receivedOrderIntentCount: intents.length,
      },
    };
  }
  if (intents.length !== 1) {
    return {
      code: "live_ops_order_intent_batch_unsupported",
      message: "production live ops 첫 실행은 한 tick에 단일 주문 후보만 제출할 수 있습니다.",
      details: {
        receivedOrderIntentCount: intents.length,
      },
    };
  }
  return undefined;
}

function collectLiveOpsCliExecutionStatusViolations(executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot) {
  const violations = [];
  if (executionStatus === undefined || typeof executionStatus !== "object" || executionStatus === null) {
    violations.push("kill switch와 reconcile freshness snapshot이 필요합니다");
  } else {
    if (executionStatus.killSwitchActive !== false) {
      violations.push("kill switch가 꺼진 상태임을 확인해야 합니다");
    }
    if (executionStatus.reconcileFresh !== true) {
      violations.push("reconcile freshness가 최신 상태임을 확인해야 합니다");
    }
    if (!hasMeaningfulValue(executionStatus.evidenceId)) {
      violations.push("execution status evidence id가 필요합니다");
    }
  }

  if (postSubmitReadiness === undefined || typeof postSubmitReadiness !== "object" || postSubmitReadiness === null) {
    violations.push("제출 후 reconcile/alert 경계 readiness 증거가 필요합니다");
  } else {
    if (postSubmitReadiness.reconcileReady !== true) {
      violations.push("제출 후 reconcile/PnL/status 경계가 준비되어야 합니다");
    }
    if (postSubmitReadiness.telegramReady !== true) {
      violations.push("제출 후 Telegram trade alert 경계가 준비되어야 합니다");
    }
    if (!hasMeaningfulValue(postSubmitReadiness.evidenceId)) {
      violations.push("post-submit readiness evidence id가 필요합니다");
    }
  }

  if (!isLiveOpsCliBudgetSnapshot(budgetSnapshot)) {
    violations.push("실제 budget snapshot이 필요합니다");
  }
  if (!isLiveOpsCliLossSnapshot(lossSnapshot)) {
    violations.push("실제 realized loss snapshot이 필요합니다");
  }

  return violations;
}

function createLiveOpsCliPreflightEvidenceDetails(preflightReconcileEvidence) {
  if (preflightReconcileEvidence === undefined) {
    return {};
  }
  return {
    preflightReconcileEvidence,
    ...(Number(preflightReconcileEvidence.mismatchCount ?? 0) > 0
      ? { mismatchTypes: ["UNTRACKED_EXCHANGE_OPEN_ORDER"] }
      : {}),
  };
}

function collectLiveOpsCliOrderIntentViolations({ config, marketData, intent }) {
  const violations = [];
  if (marketData?.ready !== true) {
    violations.push("market data freshness가 준비되지 않았습니다");
  }
  if (intent?.exchangeId !== "upbit_krw_spot") {
    violations.push("exchange는 upbit_krw_spot이어야 합니다");
  }
  if (intent?.market !== config.universe?.default_market || intent?.market !== "KRW-BTC") {
    violations.push("주문 후보 market은 production live ops 기본 market KRW-BTC여야 합니다");
  }
  if (intent?.side !== "BUY") {
    violations.push("production live ops 신규 진입은 BUY 후보만 허용합니다");
  }
  if (intent?.orderType !== "LIMIT") {
    violations.push("production live ops 신규 진입은 LIMIT 주문만 허용합니다");
  }
  if (!isLiveOpsCliPostOnlyLimitIntent(intent)) {
    violations.push("production live ops 신규 진입은 post-only LIMIT 주문만 허용합니다");
  }
  if (!isPositiveDecimalString(intent?.referencePrice) && !isPositiveDecimalString(readLiveOpsCliMarketReferencePrice(marketData))) {
    violations.push("주문 후보 가격 이탈 검증에 사용할 실제 market reference price가 필요합니다");
  }
  if (!hasMeaningfulValue(intent?.strategyId)) {
    violations.push("주문 후보에는 strategyId가 필요합니다");
  }
  for (const [key, label] of [
    ["requestedPrice", "가격"],
    ["requestedQuantity", "수량"],
    ["requestedNotional", "주문 금액"],
  ]) {
    if (!isPositiveDecimalString(intent?.[key])) {
      violations.push(`주문 후보 ${label}이 양수 decimal이어야 합니다`);
    }
  }
  if (isPositiveDecimalString(intent?.requestedPrice) && isPositiveDecimalString(intent?.requestedQuantity) && isPositiveDecimalString(intent?.requestedNotional)) {
    const actualNotional = new Decimal(intent.requestedPrice).mul(intent.requestedQuantity);
    const requestedNotional = new Decimal(intent.requestedNotional);
    if (!actualNotional.equals(requestedNotional)) {
      violations.push("requestedNotional은 requestedPrice * requestedQuantity와 같아야 합니다");
    }
    if (requestedNotional.lt(5_000)) {
      violations.push("Upbit KRW 최소 주문금액 5000 KRW 미만 후보는 제출하지 않습니다");
    }
    if (requestedNotional.gt(new Decimal(config.budget?.max_order_krw ?? "0"))) {
      violations.push("단일 주문 예산 상한을 초과했습니다");
    }
  }
  if (!hasMeaningfulValue(intent?.idempotencyKey)) {
    violations.push("주문 후보에는 decision idempotency key가 필요합니다");
  }
  if (!isNonNegativeDecimalString(readLiveOpsCliExpectedLossBps(intent))) {
    violations.push("주문 후보에는 RiskGate expected loss 입력이 필요합니다");
  }
  if (!isLiveOpsCliCostInput(intent?.costInput)) {
    violations.push("주문 후보에는 live autonomous entry runtime costInput이 필요합니다");
  }
  if (!isLiveOpsCliRiskInput(intent?.risk, intent)) {
    violations.push("주문 후보에는 live autonomous entry runtime risk snapshot이 필요합니다");
  } else {
    // preflight risk signal이 이미 차단 상태면 entryRuntime 구현에 맡기지 않고 adapter 경계에서 side effect를 닫는다.
    appendLiveOpsCliRiskGateInfrastructureViolations(violations, intent.risk.infrastructureSignals);
  }
  if (!isLiveOpsCliCostSnapshotEvidence(intent?.costSnapshot, intent)) {
    violations.push("주문 후보에는 현재 intent와 일치하는 CostModel evidence가 필요합니다");
  }
  if (!isLiveOpsCliRiskApprovalEvidence(intent?.riskApproval, intent)) {
    violations.push("주문 후보에는 현재 intent와 일치하는 RiskGate approval evidence가 필요합니다");
  }
  return violations;
}

function collectLiveOpsCliExitOrderIntentViolations({ config, marketData, intent }) {
  const violations = [];
  if (marketData?.ready !== true) {
    violations.push("market data freshness가 준비되지 않았습니다");
  }
  if (intent?.exchangeId !== "upbit_krw_spot") {
    violations.push("exchange는 upbit_krw_spot이어야 합니다");
  }
  if (intent?.market !== config.universe?.default_market || intent?.market !== "KRW-BTC") {
    violations.push("매도 후보 market은 production live ops 기본 market KRW-BTC여야 합니다");
  }
  if (intent?.side !== "SELL") {
    violations.push("production live ops exit은 SELL 후보만 허용합니다");
  }
  if (intent?.orderType !== "LIMIT") {
    violations.push("production live ops exit은 LIMIT 주문만 허용합니다");
  }
  if (!isLiveOpsCliPostOnlyLimitIntent(intent)) {
    violations.push("production live ops exit은 post-only LIMIT 주문만 허용합니다");
  }
  if (!isPositiveDecimalString(intent?.referencePrice) && !isPositiveDecimalString(readLiveOpsCliMarketReferencePrice(marketData))) {
    violations.push("매도 후보 가격 이탈 검증에 사용할 실제 market reference price가 필요합니다");
  }
  if (!hasMeaningfulValue(intent?.strategyId)) {
    violations.push("매도 후보에는 strategyId가 필요합니다");
  }
  for (const [key, label] of [
    ["requestedPrice", "가격"],
    ["requestedQuantity", "수량"],
    ["requestedNotional", "주문 금액"],
  ]) {
    if (!isPositiveDecimalString(intent?.[key])) {
      violations.push(`매도 후보 ${label}이 양수 decimal이어야 합니다`);
    }
  }
  if (isPositiveDecimalString(intent?.requestedPrice) && isPositiveDecimalString(intent?.requestedQuantity) && isPositiveDecimalString(intent?.requestedNotional)) {
    const actualNotional = new Decimal(intent.requestedPrice).mul(intent.requestedQuantity);
    const requestedNotional = new Decimal(intent.requestedNotional);
    if (!actualNotional.equals(requestedNotional)) {
      violations.push("매도 requestedNotional은 requestedPrice * requestedQuantity와 같아야 합니다");
    }
    if (requestedNotional.lt(5_000)) {
      violations.push("Upbit KRW 최소 주문금액 5000 KRW 미만 매도 후보는 제출하지 않습니다");
    }
    if (requestedNotional.gt(new Decimal(config.budget?.max_order_krw ?? "0"))) {
      violations.push("매도 후보가 단일 주문 예산 상한을 초과했습니다");
    }
  }
  if (!hasMeaningfulValue(intent?.idempotencyKey)) {
    violations.push("매도 후보에는 decision idempotency key가 필요합니다");
  }
  if (!isNonNegativeDecimalString(readLiveOpsCliExpectedLossBps(intent))) {
    violations.push("매도 후보에는 RiskGate expected loss 입력이 필요합니다");
  }
  const positionEffect = readLiveOpsCliPositionEffect(intent);
  if (positionEffect !== "REDUCE" && positionEffect !== "EXIT") {
    violations.push("매도 후보에는 REDUCE 또는 EXIT position effect가 필요합니다");
  }
  if (!hasMeaningfulValue(intent?.metadata?.exit_reason_code)) {
    violations.push("매도 후보에는 exit reason code가 필요합니다");
  }
  if (!hasMeaningfulValue(intent?.metadata?.exit_rule_id)) {
    violations.push("매도 후보에는 exit rule id가 필요합니다");
  }
  const positionScope = readLiveOpsCliExitPositionScope(intent);
  if (positionScope === undefined) {
    violations.push("매도 후보에는 보유 수량 position scope가 필요합니다");
  } else {
    const quantityViolation = validateLiveOpsCliExitQuantityAgainstScope(intent, positionScope, positionEffect);
    if (quantityViolation !== undefined) {
      violations.push(quantityViolation);
    }
    // fresh preflight와 다르면 수동 개입 또는 다른 daemon 변경을 자동 SELL로 이어가지 않는다.
    const preflightScopeViolation = validateLiveOpsCliExitScopeAgainstPreflight(intent, positionScope);
    if (preflightScopeViolation !== undefined) {
      violations.push(preflightScopeViolation);
    }
  }
  if (!isLiveOpsCliExitCostSnapshotEvidence(intent?.costSnapshot, intent)) {
    violations.push("매도 후보에는 현재 intent와 일치하는 exit_cost_model evidence가 필요합니다");
  }
  if (!isLiveOpsCliRiskApprovalEvidence(intent?.riskApproval, intent)) {
    violations.push("매도 후보에는 현재 intent와 일치하는 RiskGate approval evidence가 필요합니다");
  }
  if (isLiveOpsCliRiskInput(intent?.risk, intent)) {
    appendLiveOpsCliRiskGateInfrastructureViolations(violations, intent.risk.infrastructureSignals);
  }
  return violations;
}

function validateLiveOpsCliExitScopeAgainstPreflight(intent, positionScope) {
  const preflightScope = readLiveOpsCliExitPreflightPositionScope(intent);
  if (preflightScope === undefined) {
    // SELL은 사용자 보유 BTC를 줄이는 side effect라 제출 직전 private-read 소유 scope 없이는 stale intent를 신뢰하지 않는다.
    return "매도 후보에는 제출 직전 preflight position scope가 필요합니다";
  }
  if (preflightScope.owned !== true) {
    return "매도 후보는 제출 직전 preflight에서 전략 소유 포지션이 확인되어야 합니다";
  }
  if (preflightScope.market !== positionScope.market || preflightScope.strategy_id !== positionScope.strategy_id) {
    return "매도 후보 position scope가 제출 직전 preflight market/strategy와 일치해야 합니다";
  }
  if (!isPositiveDecimalString(preflightScope.total_quantity)) {
    return "매도 후보는 제출 직전 preflight 전략 소유 수량이 양수여야 합니다";
  }
  if (!isDecimalEqual(preflightScope.total_quantity, positionScope.total_quantity)) {
    return "매도 후보 position scope가 제출 직전 preflight 전략 소유 수량과 일치해야 합니다";
  }
  // 같은 수량의 새 lot으로 교체된 경우 이전 평균단가 기반 SELL을 제출하면 사용자 보유분을 잘못 줄일 수 있다.
  if (
    isPositiveDecimalString(positionScope.average_entry_price) &&
    isPositiveDecimalString(preflightScope.average_entry_price) &&
    !isDecimalEqual(preflightScope.average_entry_price, positionScope.average_entry_price)
  ) {
    return "매도 후보 position scope가 제출 직전 preflight 평균 진입가와 일치해야 합니다";
  }
  return undefined;
}

function readLiveOpsCliExitPreflightPositionScope(intent) {
  const scope = intent?.metadata?.preflight_position_scope;
  if (!isNonEmptyRecord(scope)) {
    return undefined;
  }
  return {
    market: hasMeaningfulValue(scope.market) ? String(scope.market) : "",
    strategy_id: hasMeaningfulValue(scope.strategy_id) ? String(scope.strategy_id) : "",
    owned: scope.owned === true,
    total_quantity: isNonNegativeDecimalString(scope.total_quantity) ? String(scope.total_quantity) : "0",
    average_entry_price: isPositiveDecimalString(scope.average_entry_price) ? String(scope.average_entry_price) : undefined,
  };
}

function readLiveOpsCliExitPositionScope(intent) {
  const scope = intent?.metadata?.position_scope;
  if (!isNonEmptyRecord(scope) || !hasMeaningfulValue(scope.market) || !hasMeaningfulValue(scope.strategy_id) || !isPositiveDecimalString(scope.total_quantity)) {
    return undefined;
  }
  return {
    market: String(scope.market),
    strategy_id: String(scope.strategy_id),
    total_quantity: String(scope.total_quantity),
    average_entry_price: isPositiveDecimalString(scope.average_entry_price) ? String(scope.average_entry_price) : undefined,
  };
}

function validateLiveOpsCliExitQuantityAgainstScope(intent, positionScope, positionEffect) {
  if (positionScope.market !== intent?.market || positionScope.strategy_id !== intent?.strategyId) {
    return "매도 후보 position scope가 market/strategy와 일치해야 합니다";
  }
  try {
    const requestedQuantity = new Decimal(intent.requestedQuantity);
    const openQuantity = new Decimal(positionScope.total_quantity);
    if (requestedQuantity.gt(openQuantity)) {
      return "매도 후보 수량은 보유 수량을 초과할 수 없습니다";
    }
    if (positionEffect === "EXIT" && !requestedQuantity.eq(openQuantity)) {
      return "EXIT 매도 후보 수량은 보유 수량 전체와 일치해야 합니다";
    }
  } catch {
    return "매도 후보 수량과 보유 수량은 Decimal 문자열이어야 합니다";
  }
  return undefined;
}

function isLiveOpsCliExitCostSnapshotEvidence(snapshot, intent) {
  if (!isNonEmptyRecord(snapshot)) {
    return false;
  }
  if (
    snapshot.source !== "exit_cost_model" ||
    snapshot.exit_cost_allowed !== true ||
    snapshot.exit_cost_reason_code !== "exit_cost_margin_ok" ||
    !isNonNegativeDecimalString(snapshot.exit_cost_bps) ||
    !isNonNegativeDecimalString(snapshot.exit_slippage_bps) ||
    !isNonEmptyRecord(snapshot.position_scope)
  ) {
    return false;
  }
  const scope = snapshot.position_scope;
  if (
    scope.market !== intent?.market ||
    scope.strategy_id !== intent?.strategyId ||
    !isPositiveDecimalString(scope.total_quantity)
  ) {
    return false;
  }
  return isLiveOpsCliOrderIntentEvidenceMatch(snapshot.order_intent, intent);
}

function isLiveOpsCliCostSnapshotEvidence(snapshot, intent) {
  if (!isNonEmptyRecord(snapshot)) {
    return false;
  }
  if (
    snapshot.source !== "cost_model" ||
    snapshot.trade_allowed !== true ||
    snapshot.reason_code !== "cost_margin_ok" ||
    hasProblemFieldList(snapshot.missing_fields) ||
    hasProblemFieldList(snapshot.invalid_fields) ||
    snapshot.exchange_id !== intent?.exchangeId ||
    snapshot.market !== intent?.market
  ) {
    return false;
  }

  return isLiveOpsCliOrderIntentEvidenceMatch(snapshot.order_intent, intent);
}

function isLiveOpsCliRiskApprovalEvidence(approval, intent) {
  if (!isNonEmptyRecord(approval)) {
    return false;
  }
  if (
    approval.source !== "risk_gate" ||
    approval.approved !== true ||
    approval.action !== "ALLOW" ||
    (approval.status !== "PASS" && approval.status !== "WARN") ||
    hasProblemFieldList(approval.failed_evaluation_reason_codes)
  ) {
    return false;
  }

  return isLiveOpsCliOrderIntentEvidenceMatch(approval.order_intent, intent);
}

function isLiveOpsCliPostOnlyLimitIntent(intent) {
  return (
    intent?.orderType === "LIMIT" &&
    intent?.postOnly === true &&
    intent.timeInForce === "POST_ONLY"
  );
}

function isLiveOpsCliCostInput(value) {
  if (!isNonEmptyRecord(value)) {
    return false;
  }
  return [
    "expectedReturnBps",
    "entryFeeBps",
    "exitFeeBps",
    "spreadCostBpsP75",
    "expectedSlippageBpsP95",
    "cancelRequotePenaltyBps",
  ].every((key) => isNonNegativeDecimalString(value[key]));
}

function isLiveOpsCliRiskInput(value, intent) {
  if (!isNonEmptyRecord(value) || !isNonEmptyRecord(value.account) || !isNonEmptyRecord(value.strategy) || !isNonEmptyRecord(value.thresholdSnapshot)) {
    return false;
  }
  if (!Array.isArray(value.positions) || !Array.isArray(value.infrastructureSignals)) {
    return false;
  }
  return value.strategy.strategyId === intent?.strategyId;
}

function isLiveOpsCliBudgetSnapshot(value) {
  if (!isNonEmptyRecord(value)) {
    return false;
  }
  return (
    isPositiveDecimalString(value.maxOrderKrw) &&
    isPositiveDecimalString(value.dailyAutonomousNotionalLimitKrw) &&
    isNonNegativeDecimalString(value.dailyAutonomousNotionalUsedKrw) &&
    isNonNegativeDecimalString(value.openPositionNotionalKrw) &&
    isPositiveDecimalString(value.maxOpenPositionNotionalKrw) &&
    hasMeaningfulValue(value.capturedAt)
  );
}

function isLiveOpsCliLossSnapshot(value) {
  if (!isNonEmptyRecord(value)) {
    return false;
  }
  return (
    isNonNegativeDecimalString(value.dailyRealizedLossKrw) &&
    isNonNegativeDecimalString(value.weeklyRealizedLossKrw) &&
    hasMeaningfulValue(value.capturedAt)
  );
}

function isLiveOpsCliOrderIntentEvidenceMatch(evidence, intent) {
  if (!isNonEmptyRecord(evidence) || intent === undefined || intent === null) {
    return false;
  }
  const expectedLossBps = readLiveOpsCliExpectedLossBps(intent);
  const expected = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    post_only: intent.postOnly,
    time_in_force: readLiveOpsCliEvidenceTimeInForce(intent),
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    requested_price: intent.requestedPrice,
    idempotency_key: intent.idempotencyKey,
    expected_loss_bps_of_equity: expectedLossBps,
  };
  const positionEffect = readLiveOpsCliPositionEffect(intent);
  if (positionEffect !== undefined) {
    expected.position_effect = positionEffect;
  }

  return Object.entries(expected).every(([key, value]) => isLiveOpsCliEvidenceValueMatch(key, evidence[key], value));
}

function readLiveOpsCliEvidenceTimeInForce(intent) {
  if (intent.timeInForce === undefined && intent.postOnly === true && intent.orderType === "LIMIT") {
    return "GTC";
  }
  return intent.timeInForce;
}

function readLiveOpsCliExpectedLossBps(intent) {
  return intent?.metadata?.expected_loss_bps_of_equity ?? intent?.metadata?.expectedLossBpsOfEquity;
}

function readLiveOpsCliPositionEffect(intent) {
  const value = intent?.metadata?.position_effect ?? intent?.metadata?.positionEffect;
  return hasMeaningfulValue(value) ? String(value) : undefined;
}

function readLiveOpsCliMarketReferencePrice(marketData) {
  if (isPositiveDecimalString(marketData?.referencePrice)) {
    return marketData.referencePrice;
  }
  if (isPositiveDecimalString(marketData?.latestTradePrice)) {
    return marketData.latestTradePrice;
  }
  if (isPositiveDecimalString(marketData?.bestBidPrice) && isPositiveDecimalString(marketData?.bestAskPrice)) {
    return new Decimal(marketData.bestBidPrice).plus(marketData.bestAskPrice).div(2).toFixed();
  }
  return undefined;
}

function isLiveOpsCliEvidenceValueMatch(key, evidenceValue, expectedValue) {
  if (expectedValue === undefined) {
    return false;
  }
  if (["requested_quantity", "requested_notional", "requested_price", "expected_loss_bps_of_equity"].includes(key)) {
    return isDecimalEqual(evidenceValue, expectedValue);
  }
  return evidenceValue === expectedValue;
}

function isDecimalEqual(left, right) {
  if (!hasDecimalComparableValue(left) || !hasDecimalComparableValue(right)) {
    return false;
  }
  try {
    return new Decimal(left).equals(new Decimal(right));
  } catch {
    return false;
  }
}

function hasProblemFieldList(value) {
  return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function isNonEmptyRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function createLiveOpsCliEntryRuntimeRequest({ config, marketData, intent, observedAt, executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot }) {
  const liveAttemptId = createLiveOpsCliAttemptId(intent.idempotencyKey);
  return {
    config: {
      enabled: config.live_trading_enabled === true,
      allowed_markets: config.universe?.markets ?? ["KRW-BTC"],
      max_order_krw: config.budget?.max_order_krw ?? "10000",
      daily_autonomous_notional_limit_krw: config.budget?.daily_autonomous_notional_limit_krw ?? "30000",
      max_open_position_notional_krw: config.budget?.max_open_position_notional_krw ?? "30000",
      max_daily_loss_krw: config.budget?.max_order_krw ?? "10000",
      max_weekly_loss_krw: config.budget?.daily_autonomous_notional_limit_krw ?? "30000",
      max_price_deviation_bps: "30",
      identifier_prefix: "ops-",
      identifier_max_length: 32,
    },
    candidate: {
      exchangeId: intent.exchangeId,
      market: intent.market,
      strategyId: intent.strategyId,
      requestedQuantity: intent.requestedQuantity,
      requestedNotional: intent.requestedNotional,
      requestedPrice: intent.requestedPrice,
      referencePrice: intent.referencePrice ?? readLiveOpsCliMarketReferencePrice(marketData),
      reason: intent.reason,
      expectedLossBpsOfEquity: readLiveOpsCliExpectedLossBps(intent),
      costInput: intent.costInput,
      risk: intent.risk,
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: readLiveOpsCliEvidenceTimeInForce(intent),
      costSnapshot: intent.costSnapshot,
      riskApproval: intent.riskApproval,
      metadata: {
        ...(intent.metadata ?? {}),
        source: "live_ops_cli_live_execution",
        decision_idempotency_key: hasMeaningfulValue(intent.metadata?.decision_idempotency_key)
          ? intent.metadata.decision_idempotency_key
          : intent.idempotencyKey,
      },
    },
    budgetSnapshot,
    lossSnapshot,
    killSwitchActive: executionStatus.killSwitchActive,
    reconcileFresh: executionStatus.reconcileFresh,
    executionStatusEvidenceId: executionStatus.evidenceId,
    postSubmitReconcileReady: postSubmitReadiness.reconcileReady,
    postSubmitTelegramReady: postSubmitReadiness.telegramReady,
    postSubmitReadinessEvidenceId: postSubmitReadiness.evidenceId,
    idempotencyKey: liveAttemptId,
    observedAt,
  };
}

function createLiveOpsCliMissingEntryRuntime() {
  return {
    async submitEntryCandidate() {
      throw new Error("LiveOpsCliEntryRuntimeNotConfigured");
    },
  };
}

function createLiveOpsCliBudgetReservationRequest(request) {
  return {
    attemptId: request.idempotencyKey,
    idempotencyKey: request.idempotencyKey,
    market: request.candidate.market,
    strategyId: request.candidate.strategyId,
    requestedNotionalKrw: request.candidate.requestedNotional,
    requestedPrice: request.candidate.requestedPrice,
    requestedQuantity: request.candidate.requestedQuantity,
    budgetSnapshot: request.budgetSnapshot,
    observedAt: request.observedAt,
    metadata: {
      source: "live_ops_cli_entry_runtime",
    },
  };
}

function readLiveOpsCliAttemptReservedNotionalKrw(attempt) {
  const value = attempt?.reservation?.reservedNotionalKrw;
  return isNonNegativeDecimalString(value) ? value : null;
}

function createLiveOpsCliBudgetUsageAfterReservation({ attempt }) {
  const persistedBudgetUsageKrw = attempt?.reservation?.budgetUsageAfterReservationKrw;
  if (isNonNegativeDecimalString(persistedBudgetUsageKrw)) {
    return persistedBudgetUsageKrw;
  }
  const reservedNotionalKrw = readLiveOpsCliAttemptReservedNotionalKrw(attempt);
  if (!isNonNegativeDecimalString(reservedNotionalKrw)) {
    return null;
  }
  // 구버전 reservation에는 post-reservation 총액이 없으므로 최소한 이번 reservation 금액만 하한으로 보존한다.
  return reservedNotionalKrw;
}

function collectLiveOpsCliEntryRuntimeStatusViolations(request) {
  const violations = [];
  if (request?.killSwitchActive !== false) {
    violations.push("kill switch가 꺼진 상태임을 wrapper 경계에서도 확인해야 합니다");
  }
  if (request?.reconcileFresh !== true) {
    violations.push("reconcile freshness가 최신 상태임을 wrapper 경계에서도 확인해야 합니다");
  }
  if (!hasMeaningfulValue(request?.executionStatusEvidenceId)) {
    violations.push("execution status evidence id가 wrapper 경계에서도 필요합니다");
  }
  if (request?.postSubmitReconcileReady !== true) {
    violations.push("제출 후 reconcile/PnL/status 경계가 wrapper 경계에서도 준비되어야 합니다");
  }
  if (request?.postSubmitTelegramReady !== true) {
    violations.push("제출 후 Telegram trade alert 경계가 wrapper 경계에서도 준비되어야 합니다");
  }
  if (!hasMeaningfulValue(request?.postSubmitReadinessEvidenceId)) {
    violations.push("post-submit readiness evidence id가 wrapper 경계에서도 필요합니다");
  }
  return violations;
}

function collectLiveOpsCliEntryRuntimeGuardViolations(request) {
  const violations = [];
  const candidate = request?.candidate;
  const config = request?.config;
  if (config?.enabled !== true) {
    violations.push("live trading config가 활성 상태여야 합니다");
  }
  if (!Array.isArray(config?.allowed_markets) || !config.allowed_markets.includes("KRW-BTC") || candidate?.market !== "KRW-BTC") {
    violations.push("live ops wrapper는 KRW-BTC 단일 market만 제출할 수 있습니다");
  }
  if (candidate?.exchangeId !== "upbit_krw_spot") {
    violations.push("live ops wrapper exchange는 upbit_krw_spot이어야 합니다");
  }
  if (!hasMeaningfulValue(candidate?.strategyId)) {
    violations.push("live ops wrapper candidate에는 strategyId가 필요합니다");
  }
  if (!isLiveOpsCliCostInput(candidate?.costInput)) {
    violations.push("live ops wrapper candidate costInput은 non-negative decimal이어야 합니다");
  }
  if (config?.max_order_krw !== "10000") {
    violations.push("live ops wrapper 단일 주문 상한은 10000 KRW여야 합니다");
  }
  if (!isPositiveDecimalString(candidate?.requestedPrice) || !isPositiveDecimalString(candidate?.requestedQuantity) || !isPositiveDecimalString(candidate?.requestedNotional)) {
    violations.push("live ops wrapper 후보 가격, 수량, 주문 금액은 양수 decimal이어야 합니다");
  } else {
    const actualNotional = new Decimal(candidate.requestedPrice).mul(candidate.requestedQuantity);
    const requestedNotional = new Decimal(candidate.requestedNotional);
    if (!actualNotional.equals(requestedNotional)) {
      violations.push("live ops wrapper 후보 requestedNotional은 가격 * 수량과 같아야 합니다");
    }
    if (actualNotional.lt(5_000)) {
      violations.push("live ops wrapper 후보는 Upbit KRW 최소 주문금액 이상이어야 합니다");
    }
    if (actualNotional.gt(new Decimal(config?.max_order_krw ?? "0"))) {
      violations.push("live ops wrapper 후보 실제 주문 금액이 단일 주문 상한을 초과했습니다");
    }
    if (isLiveOpsCliBudgetSnapshot(request?.budgetSnapshot) && actualNotional.gt(new Decimal(request.budgetSnapshot.maxOrderKrw))) {
      violations.push("live ops wrapper 후보 실제 주문 금액이 budget snapshot 단일 주문 한도를 초과했습니다");
    }
    appendLiveOpsCliEntryRuntimeBudgetGuardViolations(violations, request, actualNotional);
  }
  // wrapper를 직접 호출해도 실제 entry runtime의 손실/가격 preflight를 우회하지 못하게 같은 snapshot으로 재검증한다.
  appendLiveOpsCliEntryRuntimeLossGuardViolations(violations, request);
  appendLiveOpsCliEntryRuntimePriceDeviationGuardViolations(violations, request);
  if (!isLiveOpsCliPostOnlyLimitIntent({
    orderType: candidate?.orderType,
    postOnly: candidate?.postOnly,
    timeInForce: candidate?.timeInForce,
  })) {
    violations.push("live ops wrapper 후보는 LIMIT + post_only 조건이어야 합니다");
  }
  if (!isLiveOpsCliLiveAttemptId(request?.idempotencyKey, config)) {
    violations.push("live ops wrapper idempotency key는 ops- prefix와 13 bytes hex suffix 조건을 만족해야 합니다");
  }
  return violations;
}

function appendLiveOpsCliEntryRuntimeBudgetGuardViolations(violations, request, actualNotional) {
  const budgetSnapshot = request?.budgetSnapshot;
  const config = request?.config;
  if (!isLiveOpsCliBudgetSnapshot(budgetSnapshot)) {
    violations.push("live ops wrapper에는 budget snapshot이 필요합니다");
    return;
  }
  if (!isPositiveDecimalString(config?.daily_autonomous_notional_limit_krw) || !isPositiveDecimalString(config?.max_open_position_notional_krw)) {
    violations.push("live ops wrapper 일일/open position 예산 한도 config가 필요합니다");
    return;
  }

  const dailyUsed = new Decimal(budgetSnapshot.dailyAutonomousNotionalUsedKrw);
  const openPosition = new Decimal(budgetSnapshot.openPositionNotionalKrw);
  const effectiveDailyLimit = Decimal.min(
    new Decimal(config.daily_autonomous_notional_limit_krw),
    new Decimal(budgetSnapshot.dailyAutonomousNotionalLimitKrw),
  );
  const effectiveOpenPositionLimit = Decimal.min(
    new Decimal(config.max_open_position_notional_krw),
    new Decimal(budgetSnapshot.maxOpenPositionNotionalKrw),
  );
  if (dailyUsed.plus(actualNotional).gt(effectiveDailyLimit)) {
    violations.push("live ops wrapper 일일 자동 주문 예산을 초과했습니다");
  }
  if (openPosition.plus(actualNotional).gt(effectiveOpenPositionLimit)) {
    violations.push("live ops wrapper open position 예산을 초과했습니다");
  }
}

function appendLiveOpsCliEntryRuntimeLossGuardViolations(violations, request) {
  const lossSnapshot = request?.lossSnapshot;
  const config = request?.config;
  if (!isLiveOpsCliLossSnapshot(lossSnapshot)) {
    violations.push("live ops wrapper에는 realized loss snapshot이 필요합니다");
    return;
  }
  if (!isPositiveDecimalString(config?.max_daily_loss_krw) || !isPositiveDecimalString(config?.max_weekly_loss_krw)) {
    violations.push("live ops wrapper 손실 한도 config가 필요합니다");
    return;
  }

  const dailyLoss = new Decimal(lossSnapshot.dailyRealizedLossKrw);
  const weeklyLoss = new Decimal(lossSnapshot.weeklyRealizedLossKrw);
  if (dailyLoss.gt(new Decimal(config.max_daily_loss_krw))) {
    violations.push("live ops wrapper 일일 손실 한도를 초과했습니다");
  }
  if (weeklyLoss.gt(new Decimal(config.max_weekly_loss_krw))) {
    violations.push("live ops wrapper 주간 손실 한도를 초과했습니다");
  }
}

function appendLiveOpsCliEntryRuntimePriceDeviationGuardViolations(violations, request) {
  const candidate = request?.candidate;
  const config = request?.config;
  if (!isPositiveDecimalString(candidate?.requestedPrice) || !isPositiveDecimalString(candidate?.referencePrice) || !isNonNegativeDecimalString(config?.max_price_deviation_bps)) {
    violations.push("live ops wrapper 기준가와 가격 이탈 한도 config가 필요합니다");
    return;
  }

  const requestedPrice = new Decimal(candidate.requestedPrice);
  const referencePrice = new Decimal(candidate.referencePrice);
  const maxDeviationBps = new Decimal(config.max_price_deviation_bps);
  const deviationBps = requestedPrice.minus(referencePrice).abs().div(referencePrice).mul(10_000);
  if (deviationBps.gt(maxDeviationBps)) {
    violations.push("live ops wrapper 후보 가격 이탈이 허용 bps를 초과했습니다");
  }
}

function collectLiveOpsCliEntryRuntimeCostRiskViolations(request) {
  const violations = [];
  appendLiveOpsCliEntryRuntimeCostModelViolations(violations, request);
  appendLiveOpsCliEntryRuntimeRiskGateViolations(violations, request);
  return violations;
}

function appendLiveOpsCliEntryRuntimeCostModelViolations(violations, request) {
  const costInput = request?.candidate?.costInput;
  if (!isLiveOpsCliCostInput(costInput)) {
    violations.push("live ops wrapper CostModel 현재 입력이 필요합니다");
    return;
  }

  const optionalSafetyBuffer = costInput.safetyBufferBps ?? resolveLiveOpsCliDefaultSafetyBufferBps(request?.candidate?.market, costInput.safetyBufferMarketCategory);
  if (!isNonNegativeDecimalString(optionalSafetyBuffer)) {
    violations.push("live ops wrapper CostModel safety buffer는 non-negative decimal이어야 합니다");
    return;
  }

  const requiredReturnBps = new Decimal(costInput.entryFeeBps)
    .plus(costInput.exitFeeBps)
    .plus(costInput.spreadCostBpsP75)
    .plus(costInput.expectedSlippageBpsP95)
    .plus(costInput.cancelRequotePenaltyBps)
    .plus(optionalSafetyBuffer);
  if (new Decimal(costInput.expectedReturnBps).lt(requiredReturnBps)) {
    violations.push("live ops wrapper CostModel 현재 입력이 비용 여유 조건을 통과하지 못했습니다");
  }
}

function resolveLiveOpsCliDefaultSafetyBufferBps(market, marketCategory) {
  if (market === "KRW-BTC" || market === "KRW-ETH" || marketCategory === "BTC_ETH") {
    return "10";
  }
  if (marketCategory === "TOP_ALT") {
    return "20";
  }
  return undefined;
}

function appendLiveOpsCliEntryRuntimeRiskGateViolations(violations, request) {
  const candidate = request?.candidate;
  const risk = candidate?.risk;
  if (!isLiveOpsCliRiskInput(risk, { strategyId: candidate?.strategyId })) {
    violations.push("live ops wrapper RiskGate 현재 risk snapshot이 필요합니다");
    return;
  }

  const expectedLossBps = candidate?.expectedLossBpsOfEquity ?? candidate?.metadata?.expected_loss_bps_of_equity ?? candidate?.metadata?.expectedLossBpsOfEquity;
  const thresholds = risk.thresholdSnapshot?.thresholds;
  appendLiveOpsCliRiskGateAccountViolations(violations, risk, thresholds);
  if (!isNonNegativeDecimalString(expectedLossBps)) {
    violations.push("live ops wrapper RiskGate expected loss 입력이 필요합니다");
  }
  if (!isNonNegativeDecimalString(thresholds?.maxExpectedLossBpsOfEquity)) {
    violations.push("live ops wrapper RiskGate expected loss 한도 snapshot이 필요합니다");
  }
  if (isNonNegativeDecimalString(expectedLossBps) && isNonNegativeDecimalString(thresholds?.maxExpectedLossBpsOfEquity)) {
    if (new Decimal(expectedLossBps).gt(new Decimal(thresholds.maxExpectedLossBpsOfEquity))) {
      violations.push("live ops wrapper RiskGate 현재 예상 손실이 한도를 초과했습니다");
    }
  }

  const equityKrw = risk.account?.equityKrw;
  const maxOrderNotionalBps = thresholds?.maxOrderNotionalBpsOfEquity;
  if (!isPositiveDecimalString(equityKrw) || !isNonNegativeDecimalString(maxOrderNotionalBps) || !isPositiveDecimalString(candidate?.requestedNotional)) {
    violations.push("live ops wrapper RiskGate 주문 한도 평가 입력이 필요합니다");
    return;
  }
  const orderNotionalBps = new Decimal(candidate.requestedNotional).div(equityKrw).mul(10_000);
  if (orderNotionalBps.gt(new Decimal(maxOrderNotionalBps))) {
    violations.push("live ops wrapper RiskGate 현재 주문 금액이 계정 한도를 초과했습니다");
  }
  appendLiveOpsCliRiskGatePositionViolations(violations, request, orderNotionalBps);
  appendLiveOpsCliRiskGateStrategyViolations(violations, risk, thresholds);
  appendLiveOpsCliRiskGateInfrastructureViolations(violations, risk.infrastructureSignals);
}

function appendLiveOpsCliRiskGateAccountViolations(violations, risk, thresholds) {
  if (!isDecimalString(risk.account?.dailyRealizedPnlBps) || !isDecimalString(risk.account?.weeklyRealizedPnlBps) || !isNonNegativeDecimalString(risk.account?.maxDrawdownBps)) {
    violations.push("live ops wrapper RiskGate 계정 손실 snapshot이 필요합니다");
    return;
  }
  if (!isNonNegativeDecimalString(thresholds?.dailyLossLimitBps) || !isNonNegativeDecimalString(thresholds?.weeklyLossLimitBps) || !isNonNegativeDecimalString(thresholds?.maxDrawdownBps)) {
    violations.push("live ops wrapper RiskGate 손실 한도 snapshot이 필요합니다");
    return;
  }

  if (new Decimal(risk.account.dailyRealizedPnlBps).lte(new Decimal(thresholds.dailyLossLimitBps).negated())) {
    violations.push("live ops wrapper RiskGate 현재 일일 손실 한도를 초과했습니다");
  }
  if (new Decimal(risk.account.weeklyRealizedPnlBps).lte(new Decimal(thresholds.weeklyLossLimitBps).negated())) {
    violations.push("live ops wrapper RiskGate 현재 주간 손실 한도를 초과했습니다");
  }
  if (new Decimal(risk.account.maxDrawdownBps).gte(new Decimal(thresholds.maxDrawdownBps))) {
    violations.push("live ops wrapper RiskGate 현재 MDD 한도를 초과했습니다");
  }
}

function appendLiveOpsCliRiskGatePositionViolations(violations, request, orderNotionalBps) {
  const candidate = request?.candidate;
  const risk = candidate?.risk;
  const thresholds = risk?.thresholdSnapshot?.thresholds;
  if (
    !isNonNegativeDecimalString(thresholds?.btcEthMaxPositionBpsOfEquity) ||
    !isNonNegativeDecimalString(thresholds?.altMaxPositionBpsOfEquity) ||
    !isNonNegativeDecimalString(thresholds?.totalAltMaxPositionBpsOfEquity)
  ) {
    violations.push("live ops wrapper RiskGate 포지션 한도 snapshot이 필요합니다");
    return;
  }

  const projectedExposures = new Map();
  for (const position of risk.positions) {
    if (!hasMeaningfulValue(position?.market) || !isNonNegativeDecimalString(position?.notionalBpsOfEquity)) {
      violations.push("live ops wrapper RiskGate position snapshot이 필요합니다");
      return;
    }
    const current = projectedExposures.get(position.market) ?? new Decimal(0);
    projectedExposures.set(position.market, current.plus(position.notionalBpsOfEquity));
  }
  const currentTarget = projectedExposures.get(candidate.market) ?? new Decimal(0);
  projectedExposures.set(candidate.market, currentTarget.plus(orderNotionalBps));

  let totalAltExposure = new Decimal(0);
  for (const [market, exposureBps] of projectedExposures.entries()) {
    if (isLiveOpsCliBtcEthMarket(market)) {
      if (exposureBps.gt(new Decimal(thresholds.btcEthMaxPositionBpsOfEquity))) {
        violations.push("live ops wrapper RiskGate 현재 BTC/ETH 포지션 한도를 초과했습니다");
      }
    } else {
      totalAltExposure = totalAltExposure.plus(exposureBps);
      if (exposureBps.gt(new Decimal(thresholds.altMaxPositionBpsOfEquity))) {
        violations.push("live ops wrapper RiskGate 현재 alt 포지션 한도를 초과했습니다");
      }
    }
  }
  if (totalAltExposure.gt(new Decimal(thresholds.totalAltMaxPositionBpsOfEquity))) {
    violations.push("live ops wrapper RiskGate 현재 전체 alt 포지션 한도를 초과했습니다");
  }
}

function appendLiveOpsCliRiskGateStrategyViolations(violations, risk, thresholds) {
  if (!Number.isSafeInteger(risk.strategy?.consecutiveLosses) || risk.strategy.consecutiveLosses < 0 || !Number.isSafeInteger(thresholds?.maxConsecutiveStrategyLosses)) {
    violations.push("live ops wrapper RiskGate strategy loss snapshot이 필요합니다");
    return;
  }
  if (risk.strategy.consecutiveLosses >= thresholds.maxConsecutiveStrategyLosses) {
    violations.push("live ops wrapper RiskGate 현재 전략 연속 손실 한도를 초과했습니다");
  }
}

function appendLiveOpsCliRiskGateInfrastructureViolations(violations, infrastructureSignals) {
  for (const signal of infrastructureSignals) {
    switch (signal?.signal) {
      case "NOTIFICATION_FAILURE":
        break;
      case "STALE_MARKET_DATA":
      case "WEBSOCKET_DISCONNECTED":
      case "WEBSOCKET_RECONNECTING":
      case "DB_WRITE_FAILURE":
      case "DUPLICATE_ORDER_IDEMPOTENCY_KEY":
      case "BALANCE_POSITION_MISMATCH":
        violations.push(`live ops wrapper RiskGate 현재 인프라 차단 신호가 활성화됐습니다: ${signal.signal}`);
        break;
      default:
        violations.push("live ops wrapper RiskGate 알 수 없는 인프라 신호가 있습니다");
        break;
    }
  }
}

function isLiveOpsCliBtcEthMarket(market) {
  return market === "KRW-BTC" || market === "KRW-ETH";
}

function isLiveOpsCliBudgetReservationEvidence(result, request) {
  if (result?.reserved !== true || !isNonEmptyRecord(result.reservation)) {
    return false;
  }
  const reservation = result.reservation;
  return (
    hasMeaningfulValue(reservation.reservationId) &&
    reservation.attemptId === request.idempotencyKey &&
    reservation.idempotencyKey === request.idempotencyKey &&
    isDecimalEqual(reservation.reservedNotionalKrw, request.candidate?.requestedNotional) &&
    isNonEmptyRecord(reservation.budgetSnapshot) &&
    hasMeaningfulValue(reservation.reservedAt)
  );
}

function validateLiveOpsCliBrokerOrderEvidence(brokerOrder, submission) {
  if (!isNonEmptyRecord(brokerOrder) || !hasMeaningfulValue(brokerOrder.brokerOrderId) || !hasMeaningfulValue(brokerOrder.status)) {
    return {
      reason: "broker_result_evidence_missing",
      message: "broker 제출 응답의 주문 식별 증거가 부족해 수동 점검 상태로 전환했습니다.",
      action: "reservation id와 idempotency key로 거래소 주문 상태를 확인한 뒤 reconcile evidence를 보강하세요.",
    };
  }
  if (hasMeaningfulValue(brokerOrder.idempotencyKey) && brokerOrder.idempotencyKey !== submission.intent.idempotencyKey) {
    return {
      reason: "broker_result_evidence_missing",
      message: "broker 제출 응답의 idempotency key가 요청과 달라 수동 점검 상태로 전환했습니다.",
      action: "reservation id와 idempotency key로 거래소 주문 상태를 확인한 뒤 중복 주문 여부를 점검하세요.",
    };
  }
  if (hasMeaningfulValue(brokerOrder.market) && brokerOrder.market !== submission.intent.market) {
    return {
      reason: "broker_result_evidence_missing",
      message: "broker 제출 응답의 market이 요청과 달라 수동 점검 상태로 전환했습니다.",
      action: "reservation id와 idempotency key로 거래소 주문 상태를 확인한 뒤 잘못된 market 제출 여부를 점검하세요.",
    };
  }
  if (hasMeaningfulValue(brokerOrder.status) && !isLiveOpsCliBrokerAcceptedStatus(brokerOrder.status)) {
    return {
      reason: "broker_result_not_accepted",
      message: "broker 제출 응답이 접수/미체결 계열 상태가 아니어서 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문 상태와 durable reservation을 확인하고 rejected/failed/canceled/filled 결과를 reconcile evidence로 남기세요.",
    };
  }
  return undefined;
}

function isLiveOpsCliBrokerAcceptedStatus(status) {
  return ["SUBMITTED", "ACCEPTED", "OPEN", "PARTIALLY_FILLED"].includes(String(status).toUpperCase());
}

function isLiveOpsCliLiveAttemptId(value, config = {}) {
  return (
    typeof value === "string" &&
    value.length <= (config.identifier_max_length ?? 32) &&
    /^ops-[a-f0-9]{26}$/u.test(value)
  );
}

function createLiveOpsCliAttemptId(decisionIdempotencyKey) {
  if (isLiveOpsCliLiveAttemptId(decisionIdempotencyKey)) {
    return decisionIdempotencyKey;
  }
  const source = hasMeaningfulValue(decisionIdempotencyKey) ? String(decisionIdempotencyKey) : "missing-decision-key";
  return `ops-${createHash("sha256").update(source).digest("hex").slice(0, 26)}`;
}

function createLiveOpsCliOrderSubmission(request) {
  return {
    intent: {
      exchangeId: request.candidate.exchangeId,
      market: request.candidate.market,
      strategyId: request.candidate.strategyId,
      side: "BUY",
      orderType: "LIMIT",
      requestedQuantity: request.candidate.requestedQuantity,
      requestedNotional: request.candidate.requestedNotional,
      requestedPrice: request.candidate.requestedPrice,
      idempotencyKey: request.idempotencyKey,
      reason: request.candidate.reason,
      postOnly: true,
      timeInForce: request.candidate.timeInForce ?? "GTC",
      metadata: request.candidate.metadata,
    },
    costSnapshot: request.candidate.costSnapshot,
    riskApproval: request.candidate.riskApproval,
    submittedAt: request.observedAt,
  };
}

function okLiveExecutionCheck(name, message, code, details) {
  return {
    name,
    status: "ok",
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function blockedLiveExecutionCheck(name, message, code, details) {
  return {
    name,
    status: "blocked",
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function parseLiveOpsKeyScopes(value) {
  if (!hasMeaningfulValue(value)) {
    return [];
  }
  return [...new Set(String(value).split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

function isPositiveDecimalString(value) {
  if (!hasDecimalComparableValue(value) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(String(value))) {
    return false;
  }
  return new Decimal(value).gt(0);
}

function isNonNegativeDecimalString(value) {
  if (!hasDecimalComparableValue(value) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(String(value))) {
    return false;
  }
  return new Decimal(value).gte(0);
}

function isDecimalString(value) {
  if (!hasDecimalComparableValue(value)) {
    return false;
  }
  try {
    new Decimal(value);
    return true;
  } catch {
    return false;
  }
}

function readLiveOpsCliOptionalDecimal(value) {
  if (!isDecimalString(value)) {
    return undefined;
  }
  return new Decimal(value);
}

function hasDecimalComparableValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export async function evaluateLiveOpsCliReconcilePnlStatus({
  config,
  fixtureSmoke,
  liveExecution,
  privateReadProvider,
  reconcileStatusProvider,
  pnlStatusProvider,
  budgetSnapshot,
  observedAt,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke && liveExecution.ready !== true && liveExecution.preflightReconcileEvidence?.status === "MANUAL_REVIEW_REQUIRED") {
    return createLiveOpsCliPreflightManualReviewStatusSummary({
      market,
      liveExecution,
      budgetSnapshot,
      observedAt: observedAt ?? new Date().toISOString(),
    });
  }

  if (!fixtureSmoke && shouldProbeLiveOpsCliPrivateRead(liveExecution)) {
    if (!isLiveOpsCliPrivateReadProvider(privateReadProvider)) {
      return createLiveOpsCliReconcileBoundaryMissingSummary({
        market,
        liveExecution,
      });
    }

    return collectLiveOpsCliPrivateReadStatusSummary({
      market,
      privateReadProvider,
      reconcileStatusProvider,
      pnlStatusProvider,
      budgetSnapshot,
      observedAt: observedAt ?? new Date().toISOString(),
      liveExecution,
    });
  }

  if (!fixtureSmoke && liveExecution.status === "submitted") {
    return createLiveOpsCliReconcileBoundaryMissingSummary({
      market,
      liveExecution,
    });
  }

  if (!fixtureSmoke && liveExecution.ready === true && liveExecution.liveOrderCapable !== true) {
    return {
      status: "idle",
      ready: true,
      market,
      liveOrderCapable: false,
      latestReconcileAt: null,
      latestPnlAt: null,
      latestStatusAt: null,
      reconcileStatus: "not_required",
      reconcileStatusLabel: "대기",
      pnlStatus: "not_required",
      pnlStatusLabel: "대기",
      openOrderCount: 0,
      openExposureKrw: "0",
      budgetUsedKrw: "0",
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
      mismatchCount: null,
      manualReviewRequired: false,
      providerProbeAttempted: false,
      statusLabel: "주문 없음",
      message: "broker 제출이 없어 reconcile/PnL/status provider 조회를 시작하지 않았습니다.",
      checks: [
        {
          name: "live_execution",
          status: "ok",
          code: "live_ops_reconcile_not_required",
          message: "실주문 제출 전에는 private reconcile provider를 열지 않습니다.",
        },
      ],
    };
  }

  if (!fixtureSmoke || liveExecution.ready !== true) {
    // live execution이 준비되지 않았으면 provider 조회로 보강하지 않고 lifecycle 순서를 보존한다.
    return {
      status: "pending",
      ready: false,
      market,
      liveOrderCapable: liveExecution.liveOrderCapable === true,
      latestReconcileAt: null,
      latestPnlAt: null,
      latestStatusAt: null,
      reconcileStatus: "not_run",
      reconcileStatusLabel: "후속 연결 대기",
      pnlStatus: "not_run",
      pnlStatusLabel: "후속 연결 대기",
      openOrderCount: 0,
      openExposureKrw: "0",
      budgetUsedKrw: "0",
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
      mismatchCount: null,
      manualReviewRequired: false,
      providerProbeAttempted: false,
      statusLabel: "후속 연결 대기",
      message: "reconcile/PnL/status summary는 live execution lifecycle 이후 연결됩니다.",
      checks: [
        {
          name: "live_execution",
          status: "blocked",
          code: "live_ops_status_pending",
          message: "reconcile/PnL/status summary가 후속 lifecycle에서 시작됩니다.",
        },
      ],
    };
  }

  const latestStatusAt = new Date().toISOString();
  // fixture smoke는 PnL 결측을 0으로 숨기지 않고 provider arm 전 상태를 명시한다.
  return {
    status: "ready",
    ready: true,
    market,
    liveOrderCapable: false,
    latestReconcileAt: null,
    latestPnlAt: null,
    latestStatusAt,
    reconcileStatus: "fixture_clean",
    reconcileStatusLabel: "정상",
    pnlStatus: "fixture_observation_pending",
    pnlStatusLabel: "관측 대기",
    openOrderCount: 0,
    openExposureKrw: "0",
    budgetUsedKrw: "0",
    realizedPnlKrw: null,
    unrealizedPnlKrw: null,
    mismatchCount: 0,
    manualReviewRequired: false,
    providerProbeAttempted: false,
    statusLabel: "fixture 요약",
    message: "fixture reconcile/PnL/status summary가 open order 0건과 PnL 관측 대기 상태를 확인했고 provider 조회는 수행하지 않았습니다.",
    checks: [
      {
        name: "reconcile_summary",
        status: "ok",
        code: "live_ops_reconcile_fixture_summary",
        message: "fixture smoke에서는 private provider 조회 없이 reconcile summary shape를 확인합니다.",
      },
      {
        name: "pnl_summary",
        status: "ok",
        code: "live_ops_pnl_fixture_pending",
        message: "fixture smoke에서는 PnL 결측을 0으로 보정하지 않고 관측 대기 상태로 표시합니다.",
      },
      {
        name: "status_surface",
        status: "ok",
        code: "live_ops_status_summary_ready",
        message: "TUI/JSON safe summary에 open order와 예산/노출 placeholder를 secret 없이 노출합니다.",
      },
    ],
  };
}

function createLiveOpsCliReconcileBoundaryMissingSummary({ market, liveExecution }) {
  return {
    status: "blocked",
    ready: false,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true,
    latestReconcileAt: null,
    latestPnlAt: null,
    latestStatusAt: null,
    reconcileStatus: "provider_boundary_missing",
    reconcileStatusLabel: "수동 확인 필요",
    pnlStatus: "provider_boundary_missing",
    pnlStatusLabel: "수동 확인 필요",
    openOrderCount: 0,
    openExposureKrw: "0",
    budgetUsedKrw: "0",
    realizedPnlKrw: null,
    unrealizedPnlKrw: null,
    mismatchCount: null,
    manualReviewRequired: true,
    providerProbeAttempted: false,
    statusLabel: "후속 경계 차단",
    message: "실주문 제출 후 reconcile/PnL/status provider 경계가 없어 상태 확정을 중단했습니다.",
    action: "account/order/balance private read provider와 PnL/reconcile status provider를 연결한 뒤 같은 attempt를 재확인하세요.",
    checks: [
      {
        name: "reconcile_summary",
        status: "blocked",
        code: "live_ops_reconcile_boundary_missing",
        message: "실제 주문 제출 후 open order/exposure를 확인할 reconcile provider가 필요합니다.",
      },
    ],
  };
}

function createLiveOpsCliPreflightManualReviewStatusSummary({ market, liveExecution, budgetSnapshot, observedAt }) {
  const evidence = liveExecution.preflightReconcileEvidence;
  const openExposureKrw = isNonNegativeDecimalString(budgetSnapshot?.openPositionNotionalKrw)
    ? budgetSnapshot.openPositionNotionalKrw
    : "0";
  const budgetUsedKrw = isNonNegativeDecimalString(budgetSnapshot?.dailyAutonomousNotionalUsedKrw)
    ? budgetSnapshot.dailyAutonomousNotionalUsedKrw
    : openExposureKrw;
  return {
    status: "manual_review_required",
    ready: false,
    market,
    liveOrderCapable: false,
    latestReconcileAt: evidence.recordedAt ?? observedAt,
    latestPnlAt: null,
    latestStatusAt: observedAt,
    reconcileStatus: "preflight_manual_review_required",
    reconcileStatusLabel: "수동 확인 필요",
    pnlStatus: "not_run",
    pnlStatusLabel: "확인 필요",
    openOrderCount: Number.isFinite(Number(evidence.exchangeOrderSnapshotCount)) ? Number(evidence.exchangeOrderSnapshotCount) : 0,
    openExposureKrw,
    budgetUsedKrw,
    realizedPnlKrw: null,
    unrealizedPnlKrw: null,
    mismatchCount: Number.isFinite(Number(evidence.mismatchCount)) ? Number(evidence.mismatchCount) : null,
    manualReviewRequired: true,
    providerProbeAttempted: true,
    statusLabel: "preflight 수동 확인",
    message: "preflight private read가 계정 미체결 주문을 DB evidence로 기록해 신규 주문을 차단했습니다.",
    action: "preflight reconcile run과 UNTRACKED_EXCHANGE_OPEN_ORDER evidence를 확인하고 거래소 미체결 주문을 정리한 뒤 다시 실행하세요.",
    preflightReconcileEvidence: evidence,
    checks: [
      {
        name: "reconcile_summary",
        status: "blocked",
        code: "live_ops_preflight_reconcile_manual_review",
        message: "preflight reconcile evidence가 수동 확인을 요구합니다.",
        details: createLiveOpsCliPreflightEvidenceDetails(evidence),
      },
    ],
  };
}

async function collectLiveOpsCliPrivateReadStatusSummary({
  market,
  privateReadProvider,
  reconcileStatusProvider,
  pnlStatusProvider,
  budgetSnapshot,
  observedAt,
  liveExecution,
}) {
  let openOrders;
  let balanceSnapshot;
  let reconcileStatus;
  let pnlStatus;

  try {
    // 실계좌 조회는 주문 side effect가 없는 private read 경계지만, 실패하면 신규 주문 가능 상태를 확정하지 않는다.
    [openOrders, balanceSnapshot, reconcileStatus, pnlStatus] = await Promise.all([
      // 실행 후 상태 요약도 계정 전체 미체결 주문을 기준으로 해야 다른 마켓 잔여 주문을 숨기지 않는다.
      privateReadProvider.listOpenOrders(),
      privateReadProvider.getBalances(),
      readLiveOpsCliReconcileStatus(reconcileStatusProvider),
      readLiveOpsCliPnlStatus(pnlStatusProvider),
    ]);
  } catch (error) {
    const budgetUsedKrw = resolveLiveOpsCliBudgetUsedKrw({
      budgetSnapshot,
      openOrders: [],
      liveExecution,
    });
    return {
      status: "manual_review_required",
      ready: false,
      market,
      liveOrderCapable: liveExecution.liveOrderCapable === true,
      latestReconcileAt: null,
      latestPnlAt: null,
      latestStatusAt: observedAt,
      reconcileStatus: "private_read_failed",
      reconcileStatusLabel: "수동 확인 필요",
      pnlStatus: "unknown",
      pnlStatusLabel: "확인 필요",
      openOrderCount: 0,
      openExposureKrw: "0",
      budgetUsedKrw,
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
      mismatchCount: null,
      manualReviewRequired: true,
      providerProbeAttempted: true,
      statusLabel: "private read 실패",
      message: "account/order/balance 상태를 private read provider에서 확인하지 못해 수동 점검 상태로 전환했습니다.",
      action: "Upbit read-only 권한, DB status provider, provider rate-limit 상태를 확인한 뒤 같은 attempt를 재조회하세요.",
      checks: [
        {
          name: "private_read",
          status: "blocked",
          code: "live_ops_private_read_failed",
          message: "private read 실패는 PnL/open exposure를 0으로 보정하지 않고 수동 점검으로 격상합니다.",
          details: {
            reason: safeErrorName(error),
          },
        },
      ],
    };
  }

  const malformedPrivateRead = validateLiveOpsCliPrivateReadPayload({ openOrders, balanceSnapshot, budgetSnapshot });
  if (malformedPrivateRead !== undefined) {
    return createLiveOpsCliPrivateReadFailureSummary({
      market,
      liveExecution,
      budgetSnapshot,
      observedAt,
      code: malformedPrivateRead.code,
      message: malformedPrivateRead.message,
      reason: malformedPrivateRead.reason,
    });
  }

  const postReadObservedAt = new Date().toISOString();
  const orders = openOrders;
  const openExposureKrw = sumLiveOpsCliOpenExposureKrw(orders);
  const resolvedReconcileStatus = normalizeLiveOpsCliReconcileStatus(reconcileStatus, {
    openOrderCount: orders.length,
    openOrders: orders,
    liveExecution,
  });
  const resolvedPnlStatus = normalizeLiveOpsCliPnlStatus(pnlStatus, { liveExecution, observedAt: postReadObservedAt });
  const manualReviewRequired = resolvedReconcileStatus.manualReviewRequired || resolvedPnlStatus.manualReviewRequired;
  const budgetUsedKrw = resolveLiveOpsCliBudgetUsedKrw({
    budgetSnapshot,
    openOrders: orders,
    liveExecution,
  });
  const krwBalance = findLiveOpsCliBalance(balanceSnapshot, "KRW");

  return {
    status: manualReviewRequired ? "manual_review_required" : "ready",
    ready: !manualReviewRequired,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true && !manualReviewRequired,
    latestReconcileAt: resolvedReconcileStatus.lastReconcileAt,
    latestPnlAt: resolvedPnlStatus.latestCapturedAt,
    latestStatusAt: postReadObservedAt,
    reconcileStatus: resolvedReconcileStatus.result,
    reconcileStatusLabel: resolvedReconcileStatus.statusLabel,
    pnlStatus: resolvedPnlStatus.status,
    pnlStatusLabel: resolvedPnlStatus.statusLabel,
    openOrderCount: orders.length,
    openExposureKrw,
    budgetUsedKrw,
    realizedPnlKrw: resolvedPnlStatus.realizedPnlKrw,
    unrealizedPnlKrw: resolvedPnlStatus.unrealizedPnlKrw,
    mismatchCount: resolvedReconcileStatus.mismatchCount,
    manualReviewRequired,
    providerProbeAttempted: true,
    statusLabel: manualReviewRequired ? "수동 확인 필요" : "private read 확인",
    message: manualReviewRequired
      ? "private read가 account/order/balance를 읽었지만 reconcile 또는 PnL 상태가 수동 확인을 요구합니다."
      : "private read가 account/order/balance 상태를 secret-safe summary로 낮췄습니다.",
    action: manualReviewRequired
      ? "open order, mismatch, PnL 결측 원인을 확인하고 신규 주문 전 manual review를 닫으세요."
      : "TUI/JSON/status에서 open exposure, budget used, PnL, latest reconcile 값을 계속 감시하세요.",
    privateRead: {
      accountStatus: "read",
      balanceStatus: balanceSnapshot === null || balanceSnapshot === undefined ? "unknown" : "read",
      balanceCurrencyCount: Array.isArray(balanceSnapshot?.balances) ? balanceSnapshot.balances.length : 0,
      balanceCapturedAt: balanceSnapshot?.capturedAt ?? null,
      krwAvailable: krwBalance?.available ?? null,
      krwLocked: krwBalance?.locked ?? null,
      orderStatus: "read",
    },
    checks: [
      {
        name: "reconcile_summary",
        status: resolvedReconcileStatus.manualReviewRequired ? "blocked" : "ok",
        code: resolvedReconcileStatus.manualReviewRequired
          ? "live_ops_reconcile_status_requires_review"
          : "live_ops_private_read_summary_ready",
        message: resolvedReconcileStatus.manualReviewRequired
          ? resolvedReconcileStatus.message
          : "account/order/balance private read 결과를 secret-safe status summary로 낮췄습니다.",
        details: {
          result: resolvedReconcileStatus.result,
          balanceStatus: resolvedReconcileStatus.balanceStatus,
          openOrderCount: orders.length,
          openExposureKrw,
          mismatchCount: resolvedReconcileStatus.mismatchCount,
        },
      },
      {
        name: "pnl_summary",
        status: resolvedPnlStatus.manualReviewRequired ? "blocked" : "ok",
        code: resolvedPnlStatus.manualReviewRequired ? "live_ops_pnl_status_requires_review" : "live_ops_pnl_status_ready",
        message: resolvedPnlStatus.message,
      },
      {
        name: "status_surface",
        status: "ok",
        code: "live_ops_status_summary_ready",
        message: "TUI/JSON safe summary에 open order, open exposure, budget used, realized/unrealized PnL을 secret 없이 노출합니다.",
      },
    ],
  };
}

function createLiveOpsCliPrivateReadFailureSummary({ market, liveExecution, budgetSnapshot, observedAt, code, message, reason }) {
  const budgetUsedKrw = resolveLiveOpsCliBudgetUsedKrw({
    budgetSnapshot,
    openOrders: [],
    liveExecution,
  });
  return {
    status: "manual_review_required",
    ready: false,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true,
    latestReconcileAt: null,
    latestPnlAt: null,
    latestStatusAt: observedAt,
    reconcileStatus: "private_read_failed",
    reconcileStatusLabel: "수동 확인 필요",
    pnlStatus: "unknown",
    pnlStatusLabel: "확인 필요",
    openOrderCount: 0,
    openExposureKrw: "0",
    budgetUsedKrw,
    realizedPnlKrw: null,
    unrealizedPnlKrw: null,
    mismatchCount: null,
    manualReviewRequired: true,
    providerProbeAttempted: true,
    statusLabel: "private read 실패",
    message,
    action: "Upbit read-only 권한, DB status provider, provider rate-limit 상태를 확인한 뒤 같은 attempt를 재조회하세요.",
    checks: [
      {
        name: "private_read",
        status: "blocked",
        code,
        message: "private read 실패는 PnL/open exposure를 0으로 보정하지 않고 수동 점검으로 격상합니다.",
        details: {
          reason,
        },
      },
    ],
  };
}

function shouldProbeLiveOpsCliPrivateRead(liveExecution) {
  return (
    liveExecution.status === "submitted" ||
    liveExecution.status === "manual_review_required" ||
    liveExecution.status === "reconcile_required" ||
    liveExecution.status === "cancel_requested" ||
    liveExecution.status === "cancel_confirmed" ||
    liveExecution.status === "filled" ||
    liveExecution.status === "exit_requote_ready" ||
    liveExecution.attemptStatus === "FILLED" ||
    liveExecution.attemptStatus === "CANCELED_FOR_REQUOTE"
  );
}

function isLiveOpsCliPrivateReadProvider(provider) {
  return (
    provider !== undefined &&
    provider !== null &&
    typeof provider.listOpenOrders === "function" &&
    typeof provider.getBalances === "function"
  );
}

function validateLiveOpsCliPrivateReadPayload({ openOrders, balanceSnapshot, budgetSnapshot }) {
  if (!Array.isArray(openOrders)) {
    return {
      code: "live_ops_private_read_orders_malformed",
      reason: "open_orders_not_array",
      message: "private read provider가 미체결 주문 목록을 배열로 반환하지 않아 수동 점검 상태로 전환했습니다.",
    };
  }
  if (balanceSnapshot === undefined || balanceSnapshot === null || !Array.isArray(balanceSnapshot.balances)) {
    return {
      code: "live_ops_private_read_balances_malformed",
      reason: "balances_not_array",
      message: "private read provider가 계정 잔고 snapshot을 안전한 balances 배열로 반환하지 않아 수동 점검 상태로 전환했습니다.",
    };
  }
  for (const [index, order] of openOrders.entries()) {
    if (!isPositiveDecimalString(order?.remainingQuantity)) {
      return {
        code: "live_ops_private_read_open_exposure_malformed",
        reason: `open_orders.${index}.remaining_quantity_invalid`,
        message: "private read provider가 미체결 주문 잔량을 양수 decimal 문자열로 반환하지 않아 수동 점검 상태로 전환했습니다.",
      };
    }
    if (order?.requestedPrice !== null && order?.requestedPrice !== undefined && !isPositiveDecimalString(order?.requestedPrice)) {
      return {
        code: "live_ops_private_read_open_exposure_malformed",
        reason: `open_orders.${index}.requested_price_invalid`,
        message: "private read provider가 미체결 주문 지정가를 양수 decimal 문자열로 반환하지 않아 수동 점검 상태로 전환했습니다.",
      };
    }
    if (!isNonNegativeDecimalString(budgetSnapshot?.dailyAutonomousNotionalUsedKrw) && !isPositiveDecimalString(order?.requestedQuantity)) {
      return {
        code: "live_ops_private_read_budget_used_malformed",
        reason: `open_orders.${index}.requested_quantity_invalid`,
        message: "budget snapshot이 없고 private read provider가 주문 수량을 양수 decimal 문자열로 반환하지 않아 수동 점검 상태로 전환했습니다.",
      };
    }
  }
  return undefined;
}

async function readLiveOpsCliReconcileStatus(provider) {
  if (provider === undefined || provider === null || typeof provider.getReconcileStatus !== "function") {
    return undefined;
  }
  return provider.getReconcileStatus();
}

async function readLiveOpsCliPnlStatus(provider, scope) {
  if (provider === undefined || provider === null || typeof provider.getStatus !== "function") {
    return undefined;
  }
  return provider.getStatus(scope);
}

function normalizeLiveOpsCliReconcileStatus(summary, { openOrderCount, openOrders, liveExecution } = {}) {
  if (isLiveOpsCliCleanCancelCloseout(liveExecution) && openOrderCount === 0) {
    return {
      result: "CLEANUP_TERMINAL_CONFIRMED",
      statusLabel: "정상",
      lastReconcileAt: liveExecution.terminalCheckedAt ?? null,
      mismatchCount: 0,
      openOrderCount,
      balanceStatus: "OK",
      manualReviewRequired: false,
      message: "이번 cleanup attempt는 terminal cancel과 open order 0건이 확인되어 closeout reconcile 조건을 통과했습니다.",
    };
  }

  if (summary === undefined) {
    return {
      result: "SKIPPED",
      statusLabel: "수동 확인 필요",
      lastReconcileAt: null,
      mismatchCount: null,
      openOrderCount,
      balanceStatus: "UNAVAILABLE",
      manualReviewRequired: true,
      message: "reconcile status provider가 최신 실행 결과를 반환하지 않아 정상 상태로 확정하지 않습니다.",
    };
  }

  const result = String(summary.result ?? "UNAVAILABLE");
  const mismatchCount = Number.isFinite(Number(summary.mismatchCount)) ? Number(summary.mismatchCount) : null;
  const balanceStatus = String(summary.balanceStatus ?? "UNAVAILABLE");
  const actualOpenOrderCount = Number.isFinite(Number(openOrderCount))
    ? Number(openOrderCount)
    : (Number.isFinite(Number(summary.openOrderCount)) ? Number(summary.openOrderCount) : null);
  const openOrdersPresent = actualOpenOrderCount !== null
    && actualOpenOrderCount > 0
    && !hasOnlyLiveOpsCliTrackedExecutionOpenOrders(openOrders, liveExecution);
  // 실주문 이후 reconcile은 확정 성공 조건이 모두 맞을 때만 신규 주문 가능 상태로 연결한다.
  const reconcileClean = result === "SUCCESS" && mismatchCount === 0 && balanceStatus === "OK" && !openOrdersPresent;
  const manualReviewRequired = !reconcileClean;

  return {
    result,
    statusLabel: manualReviewRequired ? "수동 확인 필요" : "정상",
    lastReconcileAt: summary.lastReconcileAt ?? null,
    mismatchCount,
    openOrderCount: actualOpenOrderCount,
    balanceStatus,
    manualReviewRequired,
    message: openOrdersPresent
      ? "private read에서 현재 미체결 주문이 확인되어 신규 주문 전 수동 확인이 필요합니다."
      : (summary.message ?? (
      manualReviewRequired
        ? "reconcile 상태가 확정 정상 조건을 충족하지 않아 수동 확인이 필요합니다."
        : "reconcile 상태가 정상입니다."
    )),
  };
}

function hasOnlyLiveOpsCliTrackedExecutionOpenOrders(openOrders, liveExecution) {
  if (liveExecution?.status !== "submitted" && liveExecution?.status !== "cancel_requested") {
    return false;
  }
  if (!Array.isArray(openOrders) || openOrders.length !== 1) {
    return false;
  }
  const [order] = openOrders;
  const brokerOrderMatches = hasMeaningfulValue(liveExecution.brokerOrderId)
    && order?.brokerOrderId === liveExecution.brokerOrderId;
  const idempotencyKeyMatches = hasMeaningfulValue(liveExecution.idempotencyKey)
    && order?.idempotencyKey === liveExecution.idempotencyKey;
  return brokerOrderMatches || idempotencyKeyMatches;
}

function normalizeLiveOpsCliPnlStatus(summary, { liveExecution, observedAt } = {}) {
  if (isLiveOpsCliCleanCancelCloseout(liveExecution) && (summary === undefined || summary?.readStatus !== "OK")) {
    return createLiveOpsCliCleanupNoFillPnlStatus(liveExecution);
  }

  if (summary === undefined) {
    return {
      status: "provider_not_connected",
      statusLabel: "관측 대기",
      latestCapturedAt: null,
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
      manualReviewRequired: true,
      message: "PnL status provider가 없어 손익 결측을 0으로 보정하지 않고 수동 확인 대상으로 표시합니다.",
    };
  }

  const readStatus = String(summary.readStatus ?? "UNAVAILABLE");
  if (readStatus === "OK" && !isLiveOpsCliReadyPnlSnapshotStatus(summary.latestStatus)) {
    // PnL provider read 성공과 계산 완료는 별개이므로 PARTIAL/manual-review snapshot은 post-submit 상태도 수동 점검으로 닫는다.
    return {
      status: "pnl_snapshot_status_not_ready",
      statusLabel: "확인 필요",
      latestCapturedAt: summary.latestCapturedAt ?? null,
      realizedPnlKrw: summary.latestRealizedPnlKrw ?? null,
      unrealizedPnlKrw: summary.latestUnrealizedPnlKrw ?? null,
      manualReviewRequired: true,
      message: "최신 PnL snapshot이 계산 완료 상태가 아니어서 손익 상태를 정상으로 확정하지 않습니다.",
    };
  }
  if (readStatus === "OK" && !isLiveOpsCliFreshPnlStatus(summary, observedAt)) {
    if (isLiveOpsCliCleanCancelCloseout(liveExecution)) {
      // terminal cancel/no-fill에서는 새 체결이 없으므로 오래된 CALCULATED row만으로 수동 점검을 열지 않는다.
      return createLiveOpsCliCleanupNoFillPnlStatus(liveExecution);
    }
    // stale PnL row는 cleanup 이후 현재 상태 증거가 아니므로 ready summary로 낮추지 않는다.
    return {
      status: "pnl_snapshot_stale",
      statusLabel: "확인 필요",
      latestCapturedAt: summary.latestCapturedAt ?? null,
      realizedPnlKrw: summary.latestRealizedPnlKrw ?? null,
      unrealizedPnlKrw: summary.latestUnrealizedPnlKrw ?? null,
      manualReviewRequired: true,
      message: "최신 PnL snapshot이 현재 status tick보다 오래되어 손익 상태를 정상으로 확정하지 않습니다.",
    };
  }
  const manualReviewRequired = readStatus !== "OK";
  return {
    status: readStatus.toLowerCase(),
    statusLabel: readStatus === "OK" ? "정상" : (readStatus === "NOT_FOUND" ? "관측 없음" : "확인 필요"),
    latestCapturedAt: summary.latestCapturedAt ?? null,
    realizedPnlKrw: summary.latestRealizedPnlKrw ?? null,
    unrealizedPnlKrw: summary.latestUnrealizedPnlKrw ?? null,
    manualReviewRequired,
    message: readStatus === "OK"
      ? "최신 PnL snapshot에서 realized/unrealized PnL을 읽었습니다."
      : "PnL snapshot 상태가 준비되지 않아 손익을 0으로 보정하지 않습니다.",
  };
}

function createLiveOpsCliCleanupNoFillPnlStatus(liveExecution) {
  return {
    status: "cleanup_no_fill",
    statusLabel: "변동 없음",
    latestCapturedAt: liveExecution?.terminalCheckedAt ?? null,
    realizedPnlKrw: null,
    unrealizedPnlKrw: null,
    manualReviewRequired: false,
    message: "terminal cancel과 no-fill 조건이 확인되어 이번 cleanup에서 손익 변동을 0으로 보정하지 않고 null로 유지합니다.",
  };
}

function isLiveOpsCliCleanCancelCloseout(liveExecution) {
  return liveExecution?.status === "cancel_confirmed" && liveExecution?.cleanup?.cleanCancel === true;
}

function sumLiveOpsCliOpenExposureKrw(openOrders) {
  return sumDecimalStrings(openOrders.map((order) => {
    return readLiveOpsCliOpenOrderExposureKrw(order);
  }));
}

function resolveLiveOpsCliBudgetUsedKrw({ budgetSnapshot, openOrders, liveExecution }) {
  const snapshotBudgetUsedKrw = isNonNegativeDecimalString(budgetSnapshot?.dailyAutonomousNotionalUsedKrw)
    ? budgetSnapshot.dailyAutonomousNotionalUsedKrw
    : sumDecimalStrings(openOrders.map((order) => {
    return readLiveOpsCliOpenOrderRequestedNotionalKrw(order);
  }));
  const postReservationBudgetUsedKrw = liveExecution?.budgetUsageAfterReservationKrw;
  if (isNonNegativeDecimalString(postReservationBudgetUsedKrw)) {
    // preflight snapshot은 주문 제출 전 값일 수 있으므로 현재 reservation 반영값을 하한으로 잡는다.
    return Decimal.max(snapshotBudgetUsedKrw, postReservationBudgetUsedKrw).toFixed();
  }
  return snapshotBudgetUsedKrw;
}

function readLiveOpsCliOpenOrderExposureKrw(order) {
  if (!isPositiveDecimalString(order?.remainingQuantity) || !isPositiveDecimalString(order?.requestedPrice)) {
    return null;
  }
  return new Decimal(order.remainingQuantity).mul(order.requestedPrice).toFixed();
}

function readLiveOpsCliOpenOrderRequestedNotionalKrw(order) {
  if (!isPositiveDecimalString(order?.requestedQuantity) || !isPositiveDecimalString(order?.requestedPrice)) {
    return null;
  }
  return new Decimal(order.requestedQuantity).mul(order.requestedPrice).toFixed();
}

function sumDecimalStrings(values) {
  return values.reduce((total, value) => total.plus(isDecimalString(value) ? value : "0"), new Decimal(0)).toFixed();
}

function findLiveOpsCliBalance(balanceSnapshot, currency) {
  if (!Array.isArray(balanceSnapshot?.balances)) {
    return undefined;
  }
  return balanceSnapshot.balances.find((balance) => balance?.currency === currency);
}

export async function evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke,
  liveExecution,
  orderIntent,
  telegramDispatcher,
  observedAt,
  correlationId,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke && shouldDispatchLiveOpsCliTelegramAlert(config, liveExecution) && telegramDispatcher !== undefined) {
    return dispatchLiveOpsCliTelegramAlertSummary({
      config,
      market,
      liveExecution,
      orderIntent,
      telegramDispatcher,
      observedAt: observedAt ?? new Date().toISOString(),
      correlationId,
    });
  }

  if (!fixtureSmoke && shouldRequireLiveOpsCliTelegramBoundary(liveExecution)) {
    return createLiveOpsCliTelegramBoundaryMissingSummary({ market, liveExecution });
  }

  if (!fixtureSmoke && liveExecution.ready === true && liveExecution.liveOrderCapable !== true) {
    return {
      status: "idle",
      ready: true,
      market,
      liveOrderCapable: false,
      lifecycleAlertCount: 0,
      tradeAlertCount: 0,
      alertCount: 0,
      providerDispatchAttempted: false,
      statusLabel: "주문 없음",
      message: "broker 제출이 없어 Telegram trade alert provider 전송을 시작하지 않았습니다.",
      checks: [
        {
          name: "live_execution",
          status: "ok",
          code: "live_ops_telegram_not_required",
          message: "실주문 제출 전에는 trade alert provider를 열지 않습니다.",
        },
      ],
    };
  }

  if (!fixtureSmoke || liveExecution.ready !== true) {
    return {
      status: "pending",
      ready: false,
      market,
      liveOrderCapable: liveExecution.liveOrderCapable === true,
      lifecycleAlertCount: 0,
      tradeAlertCount: 0,
      alertCount: 0,
      providerDispatchAttempted: false,
      statusLabel: "후속 연결 대기",
      message: "Telegram alert mapper는 live execution lifecycle 이후 연결됩니다.",
      checks: [
        {
          name: "live_execution",
          status: "blocked",
          code: "live_ops_telegram_pending",
          message: "Telegram alert mapper가 후속 lifecycle에서 시작됩니다.",
        },
      ],
    };
  }

  const lifecycleAlertCount = config.telegram?.startup_alert_enabled === true ? 1 : 0;
  return {
    status: "planned",
    ready: true,
    market,
    liveOrderCapable: false,
    lifecycleAlertCount,
    tradeAlertCount: 0,
    alertCount: lifecycleAlertCount,
    providerDispatchAttempted: false,
    statusLabel: "fixture plan",
    message: "fixture Telegram alert mapper가 startup lifecycle alert 계획을 만들었고 provider 전송은 수행하지 않았습니다.",
    checks: [
      {
        name: "telegram_connection",
        status: "ok",
        code: "live_ops_telegram_fixture_ready",
        message: "fixture smoke에서는 Telegram provider를 호출하지 않고 alert plan shape만 확인합니다.",
      },
      {
        name: "lifecycle_alert",
        status: "ok",
        code: "live_ops_lifecycle_alerts_planned",
        message: "startup lifecycle alert 후보를 만들 수 있습니다.",
      },
    ],
  };
}

function shouldDispatchLiveOpsCliTelegramAlert(config, liveExecution) {
  return (
    shouldDispatchLiveOpsCliTelegramStartupAlert(config, liveExecution) ||
    shouldRequireLiveOpsCliTelegramBoundary(liveExecution)
  );
}

function shouldDispatchLiveOpsCliTelegramStartupAlert(config, liveExecution) {
  return config.telegram?.startup_alert_enabled === true && liveExecution.status === "idle" && liveExecution.ready === true;
}

function shouldRequireLiveOpsCliTelegramBoundary(liveExecution) {
  return mapLiveOpsCliTelegramTradeEventKind(liveExecution) !== undefined;
}

function isLiveOpsCliBlockedAttempt(liveExecution) {
  return liveExecution.attemptStatus === "BLOCKED" && Number(liveExecution.attemptedOrderCount ?? 0) > 0;
}

function isLiveOpsCliCostBlockedStatus(status) {
  return status === "cost_blocked";
}

function isLiveOpsCliRiskBlockedStatus(status) {
  return (
    status === "rejected" ||
    status === "risk_blocked"
  );
}

function createLiveOpsCliTelegramBoundaryMissingSummary({ market, liveExecution }) {
  return {
    status: "blocked",
    ready: false,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true,
    lifecycleAlertCount: 0,
    tradeAlertCount: 0,
    alertCount: 0,
    providerDispatchAttempted: false,
    statusLabel: "후속 경계 차단",
    message: "확정된 live execution lifecycle/trade event가 있지만 Telegram dispatch provider 경계가 없어 알림 전송을 확정하지 않았습니다.",
    action: "owner chat으로 전송 가능한 Telegram dispatch port를 연결한 뒤 같은 execution event alert를 재전송하세요.",
    checks: [
      {
        name: "telegram_connection",
        status: "blocked",
        code: "live_ops_telegram_boundary_missing",
        message: "전송 대상 live execution 상태에서는 Telegram provider 경계를 연결해야 알림 누락을 pending으로 숨기지 않습니다.",
        details: {
          liveExecutionStatus: liveExecution.status,
          attemptStatus: liveExecution.attemptStatus ?? null,
        },
      },
    ],
  };
}

async function dispatchLiveOpsCliTelegramAlertSummary({
  config,
  market,
  liveExecution,
  orderIntent,
  telegramDispatcher,
  observedAt,
  correlationId,
}) {
  const events = createLiveOpsCliTelegramEvents({
    config,
    market,
    liveExecution,
    orderIntent,
    observedAt,
    correlationId,
  });

  if (events.length === 0) {
    return {
      status: "skipped",
      ready: true,
      market,
      liveOrderCapable: liveExecution.liveOrderCapable === true,
      lifecycleAlertCount: 0,
      tradeAlertCount: 0,
      alertCount: 0,
      providerDispatchAttempted: false,
      statusLabel: "전송 없음",
      message: "이번 tick에서 owner chat으로 보낼 Telegram lifecycle/trade alert가 없습니다.",
      action: "다음 lifecycle 또는 trade event가 확정되면 같은 dispatch 경계를 사용합니다.",
      checks: [
        {
          name: "trade_alert",
          status: "skipped",
          code: "live_ops_telegram_alerts_skipped",
          message: "Telegram event 후보가 없어 provider 호출을 생략했습니다.",
        },
      ],
    };
  }

  let dispatchResult;
  try {
    // Telegram 실패가 이미 확정된 주문/리스크 evidence를 되돌리지 않도록 dispatch 결과를 별도 summary로만 격리한다.
    dispatchResult = await callLiveOpsCliTelegramDispatcher(telegramDispatcher, {
      market,
      observedAt,
      events,
      liveExecution,
    });
  } catch (error) {
    return createLiveOpsCliTelegramFailureSummary({
      market,
      liveExecution,
      events,
      reason: safeErrorName(error),
    });
  }

  const normalized = normalizeLiveOpsCliTelegramDispatchResult(dispatchResult, events);
  const failed = normalized.failureCount > 0 || normalized.status === "partial_failure";

  return {
    status: failed ? "manual_review_required" : normalized.status,
    ready: !failed,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true && !failed,
    lifecycleAlertCount: events.filter((event) => isLiveOpsCliLifecycleAlert(event.eventKind)).length,
    tradeAlertCount: events.filter((event) => !isLiveOpsCliLifecycleAlert(event.eventKind)).length,
    alertCount: events.length,
    providerDispatchAttempted: true,
    attemptedCount: normalized.attemptedCount,
    deliveredCount: normalized.deliveredCount,
    cooldownHitCount: normalized.cooldownHitCount,
    retryPlannedCount: normalized.retryPlannedCount,
    failureCount: normalized.failureCount,
    statusLabel: failed ? "전송 재시도 필요" : "owner chat 전송",
    message: failed
      ? "Telegram alert dispatch 일부가 실패해 retry/manual review summary로 수렴했습니다."
      : "Telegram lifecycle/trade alert를 owner chat dispatch 경계로 전송했습니다.",
    action: failed
      ? "notification retry job과 Telegram provider 상태를 확인하되, 이미 확정된 주문/리스크 evidence는 되돌리지 않습니다."
      : "owner chat 수신 시각과 alert metadata를 status/audit evidence와 대조하세요.",
    events: events.map((event) => ({
      eventKind: event.eventKind,
      market: event.market ?? null,
      evidenceId: event.evidenceId ?? null,
      idempotencyKey: event.idempotencyKey ?? null,
    })),
    checks: [
      {
        name: "telegram_connection",
        status: "ok",
        code: "live_ops_telegram_owner_dispatch_ready",
        message: "Telegram owner chat dispatch port를 호출했습니다.",
        details: {
          attemptedCount: normalized.attemptedCount,
          deliveredCount: normalized.deliveredCount,
          retryPlannedCount: normalized.retryPlannedCount,
        },
      },
      {
        name: "trade_alert",
        status: failed ? "blocked" : "ok",
        code: failed ? "live_ops_telegram_retry_or_manual_review" : "live_ops_telegram_alerts_sent",
        message: failed
          ? "Telegram 실패는 주문/리스크 commit을 되돌리지 않고 retry/manual review summary로 격리됐습니다."
          : "startup/live capable/trade alert 후보가 provider dispatch 경계를 통과했습니다.",
      },
    ],
  };
}

function createLiveOpsCliTelegramFailureSummary({ market, liveExecution, events, reason }) {
  return {
    status: "manual_review_required",
    ready: false,
    market,
    liveOrderCapable: false,
    lifecycleAlertCount: events.filter((event) => isLiveOpsCliLifecycleAlert(event.eventKind)).length,
    tradeAlertCount: events.filter((event) => !isLiveOpsCliLifecycleAlert(event.eventKind)).length,
    alertCount: events.length,
    providerDispatchAttempted: true,
    attemptedCount: events.length,
    deliveredCount: 0,
    cooldownHitCount: 0,
    retryPlannedCount: 0,
    failureCount: events.length,
    statusLabel: "전송 실패",
    message: "Telegram alert dispatch 결과를 확정하지 못해 수동 점검 상태로 전환했습니다.",
    action: "주문/리스크 commit은 유지하고 provider 설정, retry queue, owner chat 접근 권한을 확인하세요.",
    checks: [
      {
        name: "telegram_connection",
        status: "blocked",
        code: "live_ops_telegram_dispatch_failed",
        message: "Telegram dispatch 실패는 주문/리스크 commit을 되돌리지 않습니다.",
        details: {
          reason,
          liveExecutionStatus: liveExecution.status,
        },
      },
    ],
  };
}

function createLiveOpsCliTelegramEvents({ config, market, liveExecution, orderIntent, observedAt, correlationId }) {
  const events = [];
  if (config.telegram?.startup_alert_enabled === true) {
    events.push(createLiveOpsCliTelegramBaseEvent({
      eventKind: "TELEGRAM_CONNECTION_READY",
      market,
      liveExecution,
      observedAt,
      correlationId,
      safeSummary: "production live ops Telegram 알림 채널 readiness가 확인됐습니다.",
    }));
  }
  if (config.telegram?.live_order_capable_alert_enabled === true && liveExecution.liveOrderCapable === true) {
    events.push(createLiveOpsCliTelegramBaseEvent({
      eventKind: "LIVE_ORDER_CAPABLE_STARTED",
      market,
      liveExecution,
      orderIntent,
      observedAt,
      correlationId,
      evidenceId: liveExecution.attemptId ?? undefined,
      safeSummary: "production live ops가 실주문 가능 실행 경계까지 전진했습니다.",
    }));
  }
  if (config.telegram?.trade_event_alerts_enabled === true) {
    const tradeEvents = createLiveOpsCliTradeTelegramEvents({
      market,
      liveExecution,
      orderIntent,
      observedAt,
      correlationId,
    });
    events.push(...tradeEvents);
  }
  return events;
}

function createLiveOpsCliTradeTelegramEvents({ market, liveExecution, orderIntent, observedAt, correlationId }) {
  if (isLiveOpsCliCleanCancelCloseout(liveExecution)) {
    // closeout validator가 제출/취소요청/취소확인을 독립 evidence로 대조하므로 최종 상태 하나로 축약하지 않는다.
    return [
      {
        eventKind: "ORDER_SUBMITTED",
        safeSummary: "cleanup probe 실주문 제출 evidence가 확정되었습니다.",
      },
      {
        eventKind: "CANCEL_REQUESTED",
        safeSummary: "cleanup probe 취소 요청 evidence가 확정되었습니다.",
      },
      {
        eventKind: "CANCEL_CONFIRMED",
        safeSummary: "cleanup probe terminal cancel 확인 evidence가 확정되었습니다.",
      },
    ].map((event) => createLiveOpsCliTelegramBaseEvent({
      ...event,
      market,
      liveExecution,
      orderIntent,
      observedAt,
      correlationId,
      evidenceId: liveExecution.attemptId ?? undefined,
    }));
  }

  const eventKind = mapLiveOpsCliTelegramTradeEventKind(liveExecution);
  if (eventKind === undefined) {
    return [];
  }

  return [createLiveOpsCliTelegramBaseEvent({
    eventKind,
    market,
    liveExecution,
    orderIntent,
    observedAt,
    correlationId,
    evidenceId: liveExecution.attemptId ?? undefined,
    safeSummary: liveExecution.message ?? "production live ops trade event가 확정됐습니다.",
  })];
}

function mapLiveOpsCliTelegramTradeEventKind(liveExecution) {
  switch (liveExecution.status) {
    case "submitted":
      return "ORDER_SUBMITTED";
    case "filled":
    case "FILLED":
      return "ORDER_FILLED";
    case "cancel_requested":
      return "CANCEL_REQUESTED";
    case "cancel_confirmed":
      return "CANCEL_CONFIRMED";
    case "entry_requote_ready":
    case "exit_requote_ready":
      return "REQUOTE_READY";
    case "reconcile_required":
      return "RECONCILE_BLOCKED";
    case "manual_review_required":
      return "MANUAL_REVIEW_REQUIRED";
    case "cost_blocked":
      return "COST_BLOCKED";
    case "risk_blocked":
    case "rejected":
      return "RISK_BLOCKED";
    case "blocked":
      if (isLiveOpsCliBlockedAttempt(liveExecution)) {
        return "RISK_BLOCKED";
      }
      // generic blocked는 wiring/readiness 차단도 포함하므로 실제 attempt evidence 없이 risk alert로 추정하지 않는다.
      return undefined;
    default:
      if (isLiveOpsCliCostBlockedStatus(liveExecution.status)) {
        return "COST_BLOCKED";
      }
      if (isLiveOpsCliRiskBlockedStatus(liveExecution.status)) {
        return "RISK_BLOCKED";
      }
      return undefined;
  }
}

function createLiveOpsCliTelegramBaseEvent({
  eventKind,
  market,
  liveExecution,
  orderIntent,
  observedAt,
  correlationId,
  evidenceId,
  safeSummary,
}) {
  const event = {
    environment: "production",
    runMode: "live_autonomous_small_budget",
    eventKind,
    occurredAt: observedAt,
    ...(correlationId === undefined ? {} : { correlationId }),
    market,
    operatingMode: liveExecution.liveOrderCapable === true ? "live_order_capable" : "live_armed",
    liveOrderCapable: liveExecution.liveOrderCapable === true,
    ...(orderIntent?.strategyId === undefined ? {} : { strategyId: orderIntent.strategyId }),
    ...(orderIntent?.side === undefined ? {} : { side: orderIntent.side }),
    ...(orderIntent?.requestedQuantity === undefined ? {} : { quantity: orderIntent.requestedQuantity }),
    ...(orderIntent?.requestedPrice === undefined ? {} : { requestedPrice: orderIntent.requestedPrice }),
    ...(orderIntent?.requestedNotional === undefined ? {} : { notionalKrw: orderIntent.requestedNotional }),
    ...(evidenceId === undefined ? {} : { evidenceId }),
    safeSummary,
    safeDetails: {
      execution_status: liveExecution.status,
      attempt_status: liveExecution.attemptStatus ?? null,
    },
  };
  assignLiveOpsCliTelegramIdentifier(event, "orderId", liveExecution.attemptId);
  assignLiveOpsCliTelegramIdentifier(event, "brokerOrderId", liveExecution.brokerOrderId);
  assignLiveOpsCliTelegramIdentifier(event, "idempotencyKey", liveExecution.idempotencyKey);
  return event;
}

function assignLiveOpsCliTelegramIdentifier(event, key, value) {
  if (hasMeaningfulValue(value)) {
    event[key] = String(value);
  }
}

async function callLiveOpsCliTelegramDispatcher(dispatcher, payload) {
  if (typeof dispatcher === "function") {
    return dispatcher(payload);
  }
  if (dispatcher !== undefined && dispatcher !== null && typeof dispatcher.dispatchLiveOpsAlerts === "function") {
    return dispatcher.dispatchLiveOpsAlerts(payload);
  }
  if (dispatcher !== undefined && dispatcher !== null && typeof dispatcher.dispatch === "function") {
    return dispatcher.dispatch(payload);
  }
  throw new Error("LiveOpsCliTelegramDispatcherMissing");
}

function normalizeLiveOpsCliTelegramDispatchResult(result, events) {
  const results = Array.isArray(result?.results) ? result.results : [];
  const attemptedCount = Number.isFinite(Number(result?.attemptedCount)) ? Number(result.attemptedCount) : (results.length || events.length);
  const deliveredCount = Number.isFinite(Number(result?.deliveredCount))
    ? Number(result.deliveredCount)
    : results.filter((item) => item?.notification?.delivered === true).length;
  const cooldownHitCount = Number.isFinite(Number(result?.cooldownHitCount))
    ? Number(result.cooldownHitCount)
    : results.filter((item) => item?.cooldownHit === true).length;
  const retryPlannedCount = Number.isFinite(Number(result?.retryPlannedCount))
    ? Number(result.retryPlannedCount)
    : results.filter((item) => item?.retryJobPlan !== undefined).length;
  const failureCount = Number.isFinite(Number(result?.failureCount))
    ? Number(result.failureCount)
    : Math.max(0, attemptedCount - deliveredCount - cooldownHitCount);

  return {
    status: typeof result?.status === "string" ? result.status : (failureCount > 0 ? "partial_failure" : "sent"),
    attemptedCount,
    deliveredCount,
    cooldownHitCount,
    retryPlannedCount,
    failureCount,
  };
}

function isLiveOpsCliLifecycleAlert(eventKind) {
  return [
    "TELEGRAM_CONNECTION_READY",
    "LIVE_ORDER_CAPABLE_STARTED",
    "NORMAL_SHUTDOWN",
    "OPERATOR_STOP",
    "KILL_SWITCH_STOP",
    "MANUAL_REVIEW_REQUIRED",
    "CRASH_DETECTED",
    "RESTART_DETECTED",
    "RECOVERY_COMPLETED",
    "TELEGRAM_PROVIDER_FAILURE_SUSTAINED",
  ].includes(eventKind);
}

export async function evaluateLiveOpsCliAnalysisDecision({
  config,
  fixtureSmoke,
  marketData,
  productionPreflight,
  productionPreflightError,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (marketData.ready !== true) {
    return attachLiveOpsCliAnalysisOrderIntents({
      status: "blocked",
      ready: false,
      market,
      observedAt: null,
      latestDecisionAt: null,
      decisionCategory: "HOLD",
      featureStatus: "not_run",
      evaluatedStrategyCount: 0,
      holdCount: 0,
      blockCount: 0,
      orderIntentCount: 0,
      recordHoldDecision: false,
      message: "analysis/decision pipeline은 market data lifecycle 이후 연결됩니다.",
      checks: [
        {
          name: "market_data",
          status: "blocked",
          code: "live_ops_analysis_pending",
          message: "analysis/decision pipeline이 후속 lifecycle에서 시작됩니다.",
        },
      ],
    }, []);
  }

  const latestDecisionAt = new Date().toISOString();
  if (!fixtureSmoke) {
    return evaluateLiveOpsCliProductionAnalysisDecision({
      config,
      marketData,
      observedAt: latestDecisionAt,
      productionPreflight,
      productionPreflightError,
    });
  }

  return attachLiveOpsCliAnalysisOrderIntents({
    status: "ready",
    ready: true,
    market,
    observedAt: latestDecisionAt,
    latestDecisionAt,
    decisionCategory: "HOLD",
    featureStatus: "ok",
    evaluatedStrategyCount: 1,
    holdCount: 1,
    blockCount: 0,
    orderIntentCount: 0,
    recordHoldDecision: config.analysis?.record_hold_decision === true,
    decisionSourceConnected: true,
    message: "fixture analysis/decision pipeline이 HOLD를 기록했고 주문 후보는 없습니다.",
    checks: [
      {
        name: "features",
        status: "ok",
        code: "live_ops_feature_snapshot_ok",
        message: "fixture feature snapshot을 확인했습니다.",
      },
      {
        name: "strategy_decision",
        status: "ok",
        code: "live_ops_strategy_decision_ok",
        message: "fixture strategy decision HOLD를 확인했습니다.",
      },
    ],
  }, []);
}

function evaluateLiveOpsCliProductionAnalysisDecision({
  config,
  marketData,
  observedAt,
  productionPreflight,
  productionPreflightError,
}) {
  if (isLiveOpsCliAutonomous24x7Policy(config)) {
    return evaluateLiveOpsCliAutonomous24x7AnalysisDecision({
      config,
      marketData,
      observedAt: productionPreflight?.observedAt ?? observedAt,
      productionPreflight,
      productionPreflightError,
    });
  }

  return evaluateLiveOpsCliCleanupProbeAnalysisDecision({
    config,
    marketData,
    observedAt,
  });
}

function evaluateLiveOpsCliCleanupProbeAnalysisDecision({ config, marketData, observedAt }) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const policy = config.analysis?.decision_policy;
  const policyEvidence = readLiveOpsCliDecisionPolicyEvidence(policy);
  const decision = evaluateLiveOpsCliCleanupProbeStrategy({
    config,
    marketData,
    observedAt,
    policy,
  });
  const orderIntents = decision.kind === "ORDER_INTENT" ? decision.orderIntents : [];
  const decisionCategory = decision.kind === "ORDER_INTENT"
    ? "ORDER_INTENT"
    : decision.kind === "BLOCK"
      ? "BLOCKED"
      : "HOLD";
  const ready = decision.kind !== "BLOCK";

  return attachLiveOpsCliAnalysisOrderIntents({
    status: ready ? "ready" : "blocked",
    ready,
    market,
    observedAt,
    latestDecisionAt: observedAt,
    decisionCategory,
    featureStatus: "ok",
    evaluatedStrategyCount: 1,
    holdCount: decision.kind === "HOLD" ? 1 : 0,
    blockCount: decision.kind === "BLOCK" ? 1 : 0,
    orderIntentCount: orderIntents.length,
    recordHoldDecision: config.analysis?.record_hold_decision === true && orderIntents.length === 0,
    decisionSourceConnected: true,
    message: toLiveOpsCliAnalysisDecisionMessage(decisionCategory, orderIntents.length),
    checks: [
      {
        name: "market_data",
        status: "ok",
        code: "live_ops_market_data_ready",
        message: "DB-backed market data freshness summary를 확인했습니다.",
        details: {
          latestHeartbeatAt: marketData.latestHeartbeatAt,
          tradeCount: marketData.persisted?.tradeCount ?? 0,
          orderbookCount: marketData.persisted?.orderbookCount ?? 0,
        },
      },
      {
        name: "decision_policy",
        status: "ok",
        code: "live_ops_decision_policy_resolved",
        message: "cleanup probe decision policy를 정적 strategy로 조립했습니다.",
        details: policyEvidence,
      },
      {
        name: "strategy_decision",
        status: ready ? "ok" : "blocked",
        code: ready ? "live_ops_strategy_decision_ok" : "live_ops_strategy_decision_blocked",
        message: ready ? "production strategy decision 평가를 완료했습니다." : "cleanup probe strategy decision이 후보 생성을 차단했습니다.",
        details: {
          strategyId: "live_ops_cleanup_probe",
          decisionKind: decision.kind,
          orderIntentCount: orderIntents.length,
          reason: decision.reason,
        },
      },
    ],
    trace: {
      source: "live_ops_cli_analysis_decision",
      marketDataSourceProfile: marketData.sourceProfile,
      decisionSourceConnected: true,
      policyId: policy?.id ?? null,
      dynamicCodeLoading: false,
    },
  }, orderIntents);
}

function readLiveOpsCliDecisionPolicyEvidence(policy) {
  return {
    policyId: policy?.id ?? "unknown",
    strategyIds: policy?.id === "cleanup_probe"
      ? ["live_ops_cleanup_probe"]
      : policy?.id === "autonomous_24x7"
        ? [liveOpsCliAutonomous24x7StrategyId]
        : [],
    dynamicCodeLoading: false,
  };
}

function isLiveOpsCliAutonomous24x7Policy(config) {
  return config?.analysis?.decision_policy?.id === "autonomous_24x7";
}

function evaluateLiveOpsCliAutonomous24x7AnalysisDecision({
  config,
  marketData,
  observedAt,
  productionPreflight,
  productionPreflightError,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const policy = config.analysis?.decision_policy;
  const policyEvidence = readLiveOpsCliDecisionPolicyEvidence(policy);
  const decision = evaluateLiveOpsCliAutonomous24x7Strategy({
    config,
    marketData,
    observedAt,
    policy: policy?.autonomous_24x7,
    productionPreflight,
    productionPreflightError,
  });
  const orderIntents = decision.kind === "ORDER_INTENT" ? decision.orderIntents : [];
  const decisionCategory = decision.kind === "ORDER_INTENT"
    ? "ORDER_INTENT"
    : decision.kind === "BLOCK"
      ? "BLOCKED"
      : "HOLD";
  const ready = decision.kind !== "BLOCK";

  return attachLiveOpsCliAnalysisOrderIntents({
    status: ready ? "ready" : "blocked",
    ready,
    market,
    observedAt,
    latestDecisionAt: observedAt,
    decisionCategory,
    featureStatus: decision.featureStatus ?? "ok",
    evaluatedStrategyCount: 1,
    holdCount: decision.kind === "HOLD" ? 1 : 0,
    blockCount: decision.kind === "BLOCK" ? 1 : 0,
    orderIntentCount: orderIntents.length,
    recordHoldDecision: config.analysis?.record_hold_decision === true && orderIntents.length === 0,
    decisionSourceConnected: true,
    message: toLiveOpsCliAnalysisDecisionMessage(decisionCategory, orderIntents.length),
    checks: [
      {
        name: "market_data",
        status: "ok",
        code: "live_ops_market_data_ready",
        message: "DB-backed market data freshness summary를 확인했습니다.",
        details: {
          latestHeartbeatAt: marketData.latestHeartbeatAt,
          tradeCount: marketData.persisted?.tradeCount ?? 0,
          orderbookCount: marketData.persisted?.orderbookCount ?? 0,
        },
      },
      {
        name: "decision_policy",
        status: "ok",
        code: "live_ops_decision_policy_resolved",
        message: "24/7 autonomous decision policy를 정적 entry/exit strategy로 조립했습니다.",
        details: policyEvidence,
      },
      {
        name: "strategy_decision",
        status: ready ? "ok" : "blocked",
        code: ready ? "live_ops_strategy_decision_ok" : "live_ops_strategy_decision_blocked",
        message: ready ? "production 24/7 strategy decision 평가를 완료했습니다." : "24/7 strategy decision이 후보 생성을 차단했습니다.",
        details: {
          strategyId: liveOpsCliAutonomous24x7StrategyId,
          decisionKind: decision.kind,
          orderIntentCount: orderIntents.length,
          reason: decision.reason,
          ...(isNonEmptyRecord(decision.metadata) ? decision.metadata : {}),
        },
      },
    ],
    trace: {
      source: "live_ops_cli_analysis_decision",
      marketDataSourceProfile: marketData.sourceProfile,
      decisionSourceConnected: true,
      policyId: policy?.id ?? null,
      dynamicCodeLoading: false,
    },
  }, orderIntents);
}

function evaluateLiveOpsCliAutonomous24x7Strategy({
  config,
  marketData,
  observedAt,
  policy,
  productionPreflight,
  productionPreflightError,
}) {
  if (policy === undefined) {
    return liveOpsCliStrategyBlock("autonomous_24x7_policy_missing", { policyId: config.analysis?.decision_policy?.id ?? null });
  }
  if (productionPreflightError !== undefined) {
    return {
      ...liveOpsCliStrategyBlock("autonomous_24x7_private_read_failed", productionPreflightError),
      featureStatus: "not_run",
    };
  }
  if (productionPreflight === undefined) {
    return {
      ...liveOpsCliStrategyBlock("autonomous_24x7_position_snapshot_missing", { positions_present: false }),
      featureStatus: "not_run",
    };
  }

  const orderbook = readLiveOpsCliLatestOrderbook(marketData);
  if (orderbook === undefined) {
    return liveOpsCliStrategyHold("autonomous_24x7_orderbook_missing", { market: config.universe?.default_market ?? "KRW-BTC" });
  }

  const position = createLiveOpsCliAutonomousPositionSnapshot({
    preflight: productionPreflight,
    policy,
    observedAt,
  });
  if (position.kind === "blocked") {
    return liveOpsCliStrategyBlock(position.reasonCode, position.metadata);
  }
  if (new Decimal(position.quantity).gt(0)) {
    return evaluateLiveOpsCliAutonomousExitPolicy({
      config,
      orderbook,
      observedAt,
      policy,
      position,
    });
  }

  return evaluateLiveOpsCliAutonomousEntryPolicy({
    config,
    marketData,
    orderbook,
    observedAt,
    policy,
  });
}

function createLiveOpsCliAutonomousPositionSnapshot({ preflight, policy, observedAt }) {
  const exposure = preflight.heldPositionExposure;
  if (exposure?.valuationMissing === true) {
    return {
      kind: "blocked",
      reasonCode: "autonomous_24x7_position_valuation_missing",
      metadata: {
        market: exposure.market,
        currency: exposure.currency,
        capturedAt: exposure.capturedAt ?? observedAt,
      },
    };
  }
  if (!isNonNegativeDecimalString(exposure?.quantity) || !isNonNegativeDecimalString(exposure?.notionalKrw)) {
    return {
      kind: "blocked",
      reasonCode: "autonomous_24x7_position_snapshot_invalid",
      metadata: {
        positions_present: true,
        capturedAt: exposure?.capturedAt ?? observedAt,
      },
    };
  }

  const quantity = new Decimal(exposure.quantity);
  if (quantity.isZero()) {
    return {
      kind: "ok",
      quantity: "0",
      averageEntryPrice: "0",
      highWatermarkPrice: "0",
      openPositionNotionalKrw: "0",
      openedAt: exposure.capturedAt ?? observedAt,
      riskReductionOpenNotionalKrw: policy.risk_reduction_open_notional_krw,
    };
  }

  const ownership = preflight.autonomousPositionOwnership;
  // 지갑 잔고만으로 전략 소유를 추정하면 수동 보유 BTC를 자동 SELL할 수 있어 reservation 소유 기록이 없으면 닫는다.
  if (
    ownership?.owned !== true ||
    ownership.strategyId !== liveOpsCliAutonomous24x7StrategyId ||
    !isPositiveDecimalString(ownership.reservedNotionalKrw)
  ) {
    return {
      kind: "blocked",
      reasonCode: "autonomous_24x7_position_ownership_missing",
      metadata: {
        market: exposure.market,
        currency: exposure.currency,
        wallet_quantity: quantity.toFixed(),
        wallet_notional_krw: exposure.notionalKrw,
        capturedAt: exposure.capturedAt ?? observedAt,
        strategyId: liveOpsCliAutonomous24x7StrategyId,
      },
    };
  }

  const ownedQuantity = resolveLiveOpsCliAutonomousOwnedQuantity({
    walletQuantity: quantity,
    ownership,
  });
  if (ownedQuantity === undefined || ownedQuantity.lte(0)) {
    return {
      kind: "blocked",
      reasonCode: "autonomous_24x7_position_ownership_quantity_missing",
      metadata: {
        market: exposure.market,
        wallet_quantity: quantity.toFixed(),
        reserved_notional_krw: ownership.reservedNotionalKrw,
        reservation_count: ownership.reservationCount ?? 0,
      },
    };
  }

  const currentWalletNotional = new Decimal(exposure.notionalKrw);
  const currentUnitPrice = currentWalletNotional.div(quantity);
  const currentNotional = currentUnitPrice.mul(ownedQuantity);
  const averageEntryPrice = isPositiveDecimalString(ownership.averageEntryPrice)
    ? new Decimal(ownership.averageEntryPrice)
    : new Decimal(ownership.reservedNotionalKrw).div(ownedQuantity);
  const highWatermarkPrice = isPositiveDecimalString(ownership.highWatermarkPrice)
    ? new Decimal(ownership.highWatermarkPrice)
    : Decimal.max(averageEntryPrice, currentUnitPrice);
  return {
    kind: "ok",
    quantity: ownedQuantity.toFixed(),
    averageEntryPrice: averageEntryPrice.toFixed(),
    entryFeeKrw: isNonNegativeDecimalString(ownership.entryFeeKrw) ? ownership.entryFeeKrw : "0",
    highWatermarkPrice: highWatermarkPrice.toFixed(),
    openPositionNotionalKrw: currentNotional.toFixed(),
    openedAt: hasMeaningfulValue(ownership.openedAt) ? ownership.openedAt : exposure.capturedAt ?? observedAt,
    ownershipSource: ownership.source,
    riskReductionOpenNotionalKrw: policy.risk_reduction_open_notional_krw,
  };
}

function resolveLiveOpsCliAutonomousOwnedQuantity({ walletQuantity, ownership }) {
  if (isPositiveDecimalString(ownership.requestedQuantity)) {
    return Decimal.min(walletQuantity, new Decimal(ownership.requestedQuantity));
  }
  if (isPositiveDecimalString(ownership.averageEntryPrice) && isPositiveDecimalString(ownership.reservedNotionalKrw)) {
    return Decimal.min(
      walletQuantity,
      new Decimal(ownership.reservedNotionalKrw).div(ownership.averageEntryPrice),
    );
  }
  return undefined;
}

function evaluateLiveOpsCliAutonomousEntryPolicy({ config, marketData, orderbook, observedAt, policy }) {
  const bestBid = readLiveOpsCliBestBid(orderbook);
  if (bestBid === undefined) {
    return liveOpsCliStrategyHold("autonomous_24x7_entry_best_bid_missing", {
      bid_level_count: orderbook.bids?.length ?? 0,
    });
  }

  const features = createLiveOpsCliAutonomousFeatureSnapshot({ marketData, orderbook, policy });
  const signal = evaluateLiveOpsCliAutonomousEntrySignal({ features, policy });
  if (!signal.ready) {
    return liveOpsCliStrategyHold("autonomous_24x7_entry_signal_weak", signal.metadata);
  }

  const sizing = createLiveOpsCliAutonomousLimitSizing({
    side: "BUY",
    requestedPrice: bestBid.minus(new Decimal(policy.tick_size_krw).mul(policy.entry_price_offset_ticks)),
    maxNotionalKrw: new Decimal(policy.max_entry_notional_krw),
    quantityScale: policy.quantity_scale,
  });
  if (sizing.kind === "blocked") {
    return liveOpsCliStrategyBlock(sizing.reasonCode, sizing.metadata);
  }

  const intent = createLiveOpsCliAutonomousLimitIntent({
    side: "BUY",
    reason: "autonomous_24x7_entry_signal",
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    referencePrice: marketData.referencePrice ?? calculateLiveOpsCliOrderbookMid(orderbook),
    observedAt,
    metadata: {
      source: "live_ops_autonomous_24x7",
      policy_id: "autonomous_24x7",
      expected_loss_bps_of_equity: policy.expected_loss_bps_of_equity,
      best_bid_price: bestBid.toFixed(),
      ...signal.metadata,
    },
  });

  return {
    kind: "ORDER_INTENT",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    reason: "autonomous_24x7_entry_signal",
    orderIntents: [intent],
    metadata: {
      source: "live_ops_autonomous_24x7",
      phase: "entry",
      intent_count: 1,
    },
  };
}

function evaluateLiveOpsCliAutonomousExitPolicy({ config, orderbook, observedAt, policy, position }) {
  const bestAsk = readLiveOpsCliBestAsk(orderbook);
  const bestBid = readLiveOpsCliBestBid(orderbook);
  if (bestAsk === undefined) {
    return liveOpsCliStrategyHold("autonomous_24x7_exit_orderbook_incomplete", {
      ask_level_count: orderbook.asks?.length ?? 0,
    });
  }
  if (bestBid === undefined) {
    return liveOpsCliStrategyHold("autonomous_24x7_exit_orderbook_incomplete", {
      bid_level_count: orderbook.bids?.length ?? 0,
    });
  }

  const openNotional = new Decimal(position.openPositionNotionalKrw);
  // 소액 포지션이 risk-reduction 기준 미만이라는 이유로 익절/손절/시간 청산까지 막히지 않게 exit rule을 먼저 선택한다.
  const exitRule = selectLiveOpsCliAutonomousExitRule({
    bestBid,
    observedAt,
    policy,
    position,
  });
  if (exitRule === undefined) {
    return liveOpsCliStrategyHold("autonomous_24x7_position_hold", {
      source: "live_ops_autonomous_24x7",
      quantity: position.quantity,
      open_position_notional_krw: openNotional.toFixed(),
      average_entry_price: position.averageEntryPrice,
      current_bid_price: bestBid.toFixed(),
    });
  }

  const requestedPrice = bestAsk.plus(new Decimal(policy.tick_size_krw).mul(policy.exit_price_offset_ticks));
  const targetQuantity = new Decimal(position.quantity)
    .mul(exitRule.sellFraction)
    .toDecimalPlaces(policy.quantity_scale, Decimal.ROUND_DOWN);
  const requestedQuantity = Decimal.min(
    targetQuantity,
    new Decimal(policy.max_entry_notional_krw).div(requestedPrice),
  ).toDecimalPlaces(policy.quantity_scale, Decimal.ROUND_DOWN);
  const sizing = createLiveOpsCliAutonomousLimitSizing({
    side: "SELL",
    requestedPrice,
    requestedQuantity,
    maxNotionalKrw: new Decimal(policy.max_entry_notional_krw),
    quantityScale: policy.quantity_scale,
  });
  if (sizing.kind === "blocked") {
    return liveOpsCliStrategyBlock(sizing.reasonCode, sizing.metadata);
  }

  const intent = createLiveOpsCliAutonomousLimitIntent({
    side: "SELL",
    reason: exitRule.reasonCode,
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    referencePrice: calculateLiveOpsCliOrderbookMid(orderbook),
    observedAt,
    metadata: {
      source: "live_ops_autonomous_24x7",
      policy_id: "autonomous_24x7",
      expected_loss_bps_of_equity: policy.expected_loss_bps_of_equity,
      position_effect: requestedQuantity.eq(new Decimal(position.quantity)) ? "EXIT" : "REDUCE",
      exit_reason_code: exitRule.reasonCode,
      exit_rule_id: exitRule.ruleId,
      exit_cost_bps: "0",
      exit_slippage_bps: "0",
      position_scope: {
        market: config.universe?.default_market ?? "KRW-BTC",
        strategy_id: liveOpsCliAutonomous24x7StrategyId,
        total_quantity: position.quantity,
        average_entry_price: position.averageEntryPrice,
        entry_fee_krw: isNonNegativeDecimalString(position.entryFeeKrw) ? position.entryFeeKrw : "0",
      },
      exit_target_quantity: targetQuantity.toFixed(),
      exit_chunked: requestedQuantity.lt(targetQuantity) ? "true" : "false",
      open_position_notional_krw: openNotional.toFixed(),
      average_entry_price: position.averageEntryPrice,
      current_bid_price: bestBid.toFixed(),
      exit_signal_bps: exitRule.signalBps,
    },
  });

  return {
    kind: "ORDER_INTENT",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    reason: exitRule.reasonCode,
    orderIntents: [intent],
    metadata: {
      source: "live_ops_autonomous_24x7",
      phase: "exit",
      intent_count: 1,
    },
  };
}

function selectLiveOpsCliAutonomousExitRule({ bestBid, observedAt, policy, position }) {
  const averageEntryPrice = new Decimal(position.averageEntryPrice);
  if (!averageEntryPrice.gt(0)) {
    return undefined;
  }
  const pnlBps = bestBid.minus(averageEntryPrice).div(averageEntryPrice).mul(10_000);
  if (pnlBps.lte(new Decimal(policy.stop_loss_bps).negated())) {
    return {
      ruleId: "stop_loss",
      reasonCode: "autonomous_24x7_stop_loss",
      sellFraction: "1",
      signalBps: pnlBps.toFixed(),
    };
  }

  const highWatermark = isPositiveDecimalString(position.highWatermarkPrice)
    ? new Decimal(position.highWatermarkPrice)
    : averageEntryPrice;
  if (highWatermark.gt(averageEntryPrice)) {
    const drawdownBps = highWatermark.minus(bestBid).div(highWatermark).mul(10_000);
    if (drawdownBps.gte(new Decimal(policy.trailing_stop_bps))) {
      return {
        ruleId: "trailing_stop",
        reasonCode: "autonomous_24x7_trailing_stop",
        sellFraction: "1",
        signalBps: drawdownBps.toFixed(),
      };
    }
  }

  if (pnlBps.gte(new Decimal(policy.take_profit_bps))) {
    return {
      ruleId: "take_profit",
      reasonCode: "autonomous_24x7_take_profit",
      sellFraction: "1",
      signalBps: pnlBps.toFixed(),
    };
  }

  if (Number.isFinite(Date.parse(position.openedAt)) && Number.isFinite(Date.parse(observedAt))) {
    const holdingMs = Date.parse(observedAt) - Date.parse(position.openedAt);
    if (holdingMs >= Number(policy.max_holding_ms)) {
      return {
        ruleId: "max_holding_time",
        reasonCode: "autonomous_24x7_max_holding_time",
        sellFraction: "1",
        signalBps: String(holdingMs),
      };
    }
  }

  if (new Decimal(position.openPositionNotionalKrw).gte(new Decimal(policy.risk_reduction_open_notional_krw))) {
    return {
      ruleId: "risk_reduction",
      reasonCode: "autonomous_24x7_risk_reduction",
      sellFraction: policy.risk_reduction_sell_fraction,
      signalBps: new Decimal(position.openPositionNotionalKrw).toFixed(),
    };
  }

  return undefined;
}

function createLiveOpsCliAutonomousFeatureSnapshot({ marketData, orderbook, policy }) {
  const provided = marketData?.autonomousFeatures ?? marketData?.features;
  if (isNonEmptyRecord(provided)) {
    return provided;
  }

  const bestBid = readLiveOpsCliBestBid(orderbook);
  const bestAsk = readLiveOpsCliBestAsk(orderbook);
  const referencePrice = isPositiveDecimalString(marketData?.referencePrice)
    ? new Decimal(marketData.referencePrice)
    : new Decimal(calculateLiveOpsCliOrderbookMid(orderbook) ?? "0");
  const requestedPrice = bestBid === undefined
    ? referencePrice
    : bestBid.minus(new Decimal(policy.tick_size_krw).mul(policy.entry_price_offset_ticks));
  const meanReversionDiscount = referencePrice.gt(0)
    ? Decimal.max(0, referencePrice.minus(requestedPrice).div(referencePrice).mul(10_000))
    : new Decimal(0);
  const mid = bestBid !== undefined && bestAsk !== undefined
    ? bestBid.plus(bestAsk).div(2)
    : referencePrice;
  const spreadBps = bestBid !== undefined && bestAsk !== undefined && mid.gt(0)
    ? bestAsk.minus(bestBid).div(mid).mul(10_000)
    : new Decimal(0);
  const publicTickReady = Number(marketData?.persisted?.tradeCount ?? 0) > 0
    && Number(marketData?.persisted?.orderbookCount ?? 0) > 0
    && Number(marketData?.persisted?.statusCount ?? 0) > 0;
  const costAdjustedMargin = Decimal.max(0, meanReversionDiscount.minus(spreadBps));
  if (
    publicTickReady &&
    costAdjustedMargin.gte(new Decimal(policy.min_entry_margin_bps)) &&
    meanReversionDiscount.gte(new Decimal(policy.mean_reversion_discount_bps))
  ) {
    // 좁은 spread 자체가 아니라 public reference 대비 실제 bid edge가 있을 때만 provider 결측을 entry 후보로 보정한다.
    return {
      cost_adjusted_margin_bps: costAdjustedMargin.toFixed(),
      trend_strength_bps: "0",
      mean_reversion_discount_bps: meanReversionDiscount.toFixed(),
      feature_source: "live_ops_cli_public_tick_edge",
      spread_bps: spreadBps.toFixed(),
    };
  }

  return {
    cost_adjusted_margin_bps: costAdjustedMargin.toFixed(),
    trend_strength_bps: "0",
    mean_reversion_discount_bps: meanReversionDiscount.toFixed(),
    feature_source: "live_ops_cli_public_tick_weak",
    spread_bps: spreadBps.toFixed(),
  };
}

function evaluateLiveOpsCliAutonomousEntrySignal({ features, policy }) {
  const margin = readLiveOpsCliOptionalDecimal(features.cost_adjusted_margin_bps) ?? new Decimal(0);
  const trend = readLiveOpsCliOptionalDecimal(features.trend_strength_bps) ?? new Decimal(0);
  const meanReversion = readLiveOpsCliOptionalDecimal(features.mean_reversion_discount_bps) ?? new Decimal(0);
  const marginReady = margin.gte(new Decimal(policy.min_entry_margin_bps));
  const trendReady = trend.gte(new Decimal(policy.trend_confirmation_bps));
  const meanReversionReady = meanReversion.gte(new Decimal(policy.mean_reversion_discount_bps));
  return {
    ready: marginReady && (trendReady || meanReversionReady),
    metadata: {
      cost_adjusted_margin_bps: margin.toFixed(),
      trend_strength_bps: trend.toFixed(),
      mean_reversion_discount_bps: meanReversion.toFixed(),
      min_entry_margin_bps: String(policy.min_entry_margin_bps),
      trend_confirmation_bps: String(policy.trend_confirmation_bps),
      mean_reversion_discount_bps_threshold: String(policy.mean_reversion_discount_bps),
      ...(hasMeaningfulValue(features.feature_source) ? { feature_source: features.feature_source } : {}),
      ...(isNonNegativeDecimalString(features.spread_bps) ? { spread_bps: features.spread_bps } : {}),
    },
  };
}

function createLiveOpsCliAutonomousLimitSizing({
  side,
  requestedPrice,
  requestedQuantity,
  maxNotionalKrw,
  quantityScale,
}) {
  if (!requestedPrice.gt(0)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${side.toLowerCase()}_price_invalid`,
      metadata: { requestedPrice: requestedPrice.toFixed() },
    };
  }
  const quantity = requestedQuantity === undefined
    ? maxNotionalKrw.div(requestedPrice).toDecimalPlaces(quantityScale, Decimal.ROUND_DOWN)
    : requestedQuantity.toDecimalPlaces(quantityScale, Decimal.ROUND_DOWN);
  const requestedNotional = requestedPrice.mul(quantity);
  if (!quantity.gt(0) || requestedNotional.lt(5_000)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${side.toLowerCase()}_notional_below_minimum`,
      metadata: { requestedNotionalKrw: requestedNotional.toFixed() },
    };
  }
  if (requestedNotional.gt(maxNotionalKrw)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${side.toLowerCase()}_notional_above_budget`,
      metadata: {
        requestedNotionalKrw: requestedNotional.toFixed(),
        maxNotionalKrw: maxNotionalKrw.toFixed(),
      },
    };
  }
  return {
    kind: "ok",
    requestedPrice: requestedPrice.toFixed(),
    requestedQuantity: quantity.toFixed(),
    requestedNotional: requestedNotional.toFixed(),
  };
}

function createLiveOpsCliAutonomousLimitIntent({
  side,
  reason,
  requestedPrice,
  requestedQuantity,
  requestedNotional,
  referencePrice,
  observedAt,
  metadata,
}) {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    side,
    orderType: "LIMIT",
    requestedPrice,
    requestedQuantity,
    requestedNotional,
    referencePrice,
    idempotencyKey: [
      liveOpsCliAutonomous24x7StrategyId,
      readLiveOpsCliRuntimeDateScope(observedAt) ?? "unknown_date",
      "upbit_krw_spot",
      "KRW-BTC",
      side,
      reason,
      requestedPrice,
      requestedQuantity,
      requestedNotional,
    ].join(":"),
    reason,
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata,
  };
}

function liveOpsCliStrategyHold(reason, metadata = {}) {
  return {
    kind: "HOLD",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    reason,
    metadata,
  };
}

function liveOpsCliStrategyBlock(reasonCode, metadata = {}) {
  return {
    kind: "BLOCK",
    strategyId: liveOpsCliAutonomous24x7StrategyId,
    reason: reasonCode,
    reasonCode,
    metadata,
  };
}

function evaluateLiveOpsCliCleanupProbeStrategy({ config, marketData, observedAt, policy }) {
  if (policy?.id !== "cleanup_probe") {
    // config validation이 깨진 경우에도 임의 policy 실행으로 넘어가지 않고 strategy 단계에서 닫는다.
    return {
      kind: "BLOCK",
      strategyId: "live_ops_cleanup_probe",
      reason: "cleanup_probe_policy_unsupported",
      reasonCode: "cleanup_probe_policy_unsupported",
      metadata: {
        policyId: policy?.id ?? null,
      },
    };
  }

  const orderbook = readLiveOpsCliLatestOrderbook(marketData);
  if (orderbook === undefined) {
    // post-only 가격은 최신 호가 기준으로만 재현할 수 있으므로 orderbook 없는 tick은 HOLD evidence로 닫는다.
    return {
      kind: "HOLD",
      strategyId: "live_ops_cleanup_probe",
      reason: "cleanup_probe_orderbook_missing",
      metadata: {
        market: config.universe?.default_market ?? "KRW-BTC",
      },
    };
  }

  const sizing = createLiveOpsCliCleanupProbeSizing({
    policy: policy.cleanup_probe,
    orderbook,
  });
  if (sizing.kind === "blocked") {
    return {
      kind: "BLOCK",
      strategyId: "live_ops_cleanup_probe",
      reason: sizing.reasonCode,
      reasonCode: sizing.reasonCode,
      metadata: sizing.metadata,
    };
  }

  const market = config.universe?.default_market ?? "KRW-BTC";
  const intent = {
    exchangeId: "upbit_krw_spot",
    market,
    strategyId: "live_ops_cleanup_probe",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    referencePrice: marketData.referencePrice ?? calculateLiveOpsCliOrderbookMid(orderbook),
    idempotencyKey: createLiveOpsCliCleanupProbeDecisionKey({
      market,
      sizing,
      // 실제 reservation day는 production preflight wall clock에서 확정되므로 분석 후보 key에는 날짜 placeholder만 남긴다.
      observedAt: "runtime_preflight_day",
    }),
    reason: "issue_206_cleanup_probe",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      source: "live_ops_cleanup_probe",
      issue: "206",
      expected_loss_bps_of_equity: policy.cleanup_probe.expected_loss_bps_of_equity,
      best_bid_price: sizing.bestBidPrice,
      idempotency_date_scope: "runtime_preflight_day",
      idempotency_date_source: "live_ops_runtime_preflight",
      strategy_observed_at: observedAt,
      tick_size_krw: policy.cleanup_probe.tick_size_krw,
      price_offset_ticks: policy.cleanup_probe.price_offset_ticks,
      policy_id: "cleanup_probe",
    },
  };

  return {
    kind: "ORDER_INTENT",
    strategyId: "live_ops_cleanup_probe",
    reason: "issue_206_cleanup_probe",
    orderIntents: [intent],
    metadata: {
      intent_count: 1,
      requested_notional_krw: sizing.requestedNotional,
    },
  };
}

function createLiveOpsCliCleanupProbeDecisionKey({ market, sizing, observedAt }) {
  const observedAtText = hasMeaningfulValue(observedAt) ? String(observedAt) : "";
  const dayScope = /^\d{4}-\d{2}-\d{2}/u.test(observedAtText)
    ? observedAtText.slice(0, 10)
    : (observedAtText || "unknown-day");
  return [
    "live_ops_cleanup_probe",
    dayScope,
    "upbit_krw_spot",
    market,
    "BUY",
    sizing.requestedPrice,
    sizing.requestedQuantity,
    sizing.requestedNotional,
  ].join(":");
}

function attachLiveOpsCliAnalysisOrderIntents(summary, orderIntents) {
  Object.defineProperty(summary, liveOpsCliAnalysisOrderIntentsSymbol, {
    value: Object.freeze([...orderIntents]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return summary;
}

export function getLiveOpsCliAnalysisOrderIntents(summary) {
  const value = summary?.[liveOpsCliAnalysisOrderIntentsSymbol];
  return Array.isArray(value) ? [...value] : [];
}

function readLiveOpsCliLatestOrderbook(marketData) {
  const events = Array.isArray(marketData?.marketEvents) ? marketData.marketEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "ORDERBOOK" && event.exchangeId === "upbit_krw_spot" && event.market === marketData.market) {
      return event;
    }
  }

  if (isPositiveDecimalString(marketData?.bestBidPrice) && isPositiveDecimalString(marketData?.bestAskPrice)) {
    return {
      type: "ORDERBOOK",
      exchangeId: "upbit_krw_spot",
      market: marketData.market ?? "KRW-BTC",
      bids: [{ price: marketData.bestBidPrice, size: "0" }],
      asks: [{ price: marketData.bestAskPrice, size: "0" }],
      exchangeTimestamp: marketData.latestHeartbeatAt ?? new Date().toISOString(),
      receivedAt: marketData.latestHeartbeatAt ?? new Date().toISOString(),
    };
  }

  return undefined;
}

function createLiveOpsCliCleanupProbeSizing({ policy, orderbook }) {
  const bestBid = readLiveOpsCliBestBid(orderbook);
  if (bestBid === undefined) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_best_bid_missing",
      metadata: { bidLevelCount: orderbook.bids?.length ?? 0 },
    };
  }

  const tickSize = new Decimal(policy.tick_size_krw);
  const requestedPrice = bestBid.minus(tickSize.mul(policy.price_offset_ticks));
  if (!requestedPrice.gt(0) || !requestedPrice.mod(tickSize).isZero()) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_requested_price_invalid",
      metadata: {
        bestBidPrice: bestBid.toFixed(),
        tickSizeKrw: tickSize.toFixed(),
        priceOffsetTicks: policy.price_offset_ticks,
      },
    };
  }

  const maxNotional = new Decimal(policy.max_notional_krw);
  const requestedQuantity = maxNotional
    .div(requestedPrice)
    .toDecimalPlaces(policy.quantity_scale, Decimal.ROUND_DOWN);
  const requestedNotional = requestedPrice.mul(requestedQuantity);
  if (!requestedQuantity.gt(0) || requestedNotional.lt(5_000)) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_notional_below_minimum",
      metadata: {
        requestedNotionalKrw: requestedNotional.toFixed(),
      },
    };
  }
  if (requestedNotional.gt(maxNotional)) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_notional_above_budget",
      metadata: {
        requestedNotionalKrw: requestedNotional.toFixed(),
        maxNotionalKrw: maxNotional.toFixed(),
      },
    };
  }

  return {
    kind: "ok",
    bestBidPrice: bestBid.toFixed(),
    requestedPrice: requestedPrice.toFixed(),
    requestedQuantity: requestedQuantity.toFixed(),
    requestedNotional: requestedNotional.toFixed(),
  };
}

function readLiveOpsCliBestBid(orderbook) {
  const bids = Array.isArray(orderbook?.bids) ? orderbook.bids : [];
  const prices = bids
    .map((level) => {
      try {
        return new Decimal(level.price);
      } catch {
        return undefined;
      }
    })
    .filter((price) => price !== undefined && price.isFinite())
    .toSorted((left, right) => right.comparedTo(left));
  return prices[0];
}

function readLiveOpsCliBestAsk(orderbook) {
  const asks = Array.isArray(orderbook?.asks) ? orderbook.asks : [];
  const prices = asks
    .map((level) => {
      try {
        return new Decimal(level.price);
      } catch {
        return undefined;
      }
    })
    .filter((price) => price !== undefined && price.isFinite())
    .toSorted((left, right) => left.comparedTo(right));
  return prices[0];
}

function calculateLiveOpsCliOrderbookMid(orderbook) {
  const bestBid = readLiveOpsCliBestBid(orderbook);
  const bestAsk = readLiveOpsCliBestAsk(orderbook);
  if (bestBid === undefined || bestAsk === undefined) {
    return undefined;
  }
  return bestBid.plus(bestAsk).div(2).toFixed();
}

function toLiveOpsCliAnalysisDecisionMessage(decisionCategory, orderIntentCount) {
  if (decisionCategory === "ORDER_INTENT") {
    return `production decision policy가 주문 후보 ${orderIntentCount}개를 만들었습니다.`;
  }
  if (decisionCategory === "BLOCKED") {
    return "production decision policy가 주문 후보 생성을 차단했습니다.";
  }
  return "production decision policy가 HOLD로 기록됐고 주문 후보는 없습니다.";
}

async function evaluateLiveOpsCliMarketData({ config, fixtureSmoke, databaseUrl }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke) {
    return collectLiveOpsCliUpbitMarketData({
      config,
      databaseUrl,
      market,
    });
  }

  const latestHeartbeatAt = new Date().toISOString();
  return {
    status: "ready",
    ready: true,
    provider: "UPBIT_PUBLIC",
    market,
    sourceProfile: "fixture",
    message: "fixture market data collector가 DB-backed 저장 경계를 통과했습니다.",
    latestHeartbeatAt,
    referencePrice: "100000000",
    referencePriceSource: "fixture_trade",
    latestTradePrice: "100000000",
    bestBidPrice: "100000000",
    bestAskPrice: "100001000",
    marketEvents: [
      {
        type: "TRADE",
        exchangeId: "upbit_krw_spot",
        market,
        tradeId: "fixture-live-ops-trade",
        price: "100000000",
        quantity: "0.0001",
        side: "BID",
        exchangeTimestamp: latestHeartbeatAt,
        receivedAt: latestHeartbeatAt,
      },
      {
        type: "ORDERBOOK",
        exchangeId: "upbit_krw_spot",
        market,
        asks: [{ price: "100001000", size: "0.5" }],
        bids: [{ price: "100000000", size: "0.5" }],
        exchangeTimestamp: latestHeartbeatAt,
        receivedAt: latestHeartbeatAt,
      },
      {
        type: "STATUS",
        exchangeId: "upbit_krw_spot",
        market,
        status: "CONNECTED",
        observedAt: latestHeartbeatAt,
        reasonCode: "fixture_live_ops_market_data_connected",
        reconnectCount: 0,
      },
    ],
    persisted: {
      eventCount: 3,
      tradeCount: 1,
      orderbookCount: 1,
      statusCount: 1,
      riskBlockCount: 0,
    },
    checks: [
      {
        name: "config",
        status: "ok",
        code: "live_ops_market_data_config_ok",
        message: "production live ops market data 설정을 확인했습니다.",
      },
      {
        name: "persistence",
        status: "ok",
        code: "live_ops_market_data_persistence_ok",
        message: "fixture event가 DB-backed write plan을 통과했습니다.",
      },
    ],
  };
}

async function collectLiveOpsCliUpbitMarketData({ config, databaseUrl, market }) {
  const checks = [
    {
      name: "config",
      status: "ok",
      code: "live_ops_market_data_config_ok",
      message: "production live ops market data 설정을 확인했습니다.",
      details: {
        provider: config.market_data?.provider ?? "UPBIT_PUBLIC",
        market,
      },
    },
  ];
  const persisted = emptyMarketDataPersistenceSummary();
  const state = {
    latestHeartbeatAt: null,
    referencePrice: null,
    referencePriceSource: null,
    latestTradePrice: null,
    bestBidPrice: null,
    bestAskPrice: null,
    hasTrade: false,
    hasOrderbook: false,
    riskBlockCount: 0,
    marketEvents: [],
  };
  const pool = new PgPool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: dbReadinessConnectionTimeoutMs,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });

  try {
    await collectLiveOpsUpbitPublicEvents({
      market,
      staleAfterMs: config.market_data?.stale_after_ms ?? 30_000,
      timeoutMs: config.market_data?.stale_after_ms ?? 30_000,
      onEvent: async (event) => {
        await persistLiveOpsCliMarketDataEvent(pool, event, {
          workerId: liveOpsMarketDataConsumerId,
          persisted,
          state,
        });
      },
    });
    checks.push({
      name: "event_source",
      status: "ok",
      code: "live_ops_market_data_source_ok",
      message: "Upbit public WebSocket에서 production market event를 수신했습니다.",
      details: {
        market,
        eventCount: persisted.eventCount,
      },
    });
    checks.push({
      name: "persistence",
      status: "ok",
      code: "live_ops_market_data_persistence_ok",
      message: "market data event를 DB-backed store 경계로 저장했습니다.",
      details: {
        tradeCount: persisted.tradeCount,
        orderbookCount: persisted.orderbookCount,
        statusCount: persisted.statusCount,
      },
    });

    if (!state.hasTrade || !state.hasOrderbook) {
      checks.push({
        name: "freshness",
        status: "blocked",
        code: "live_ops_market_data_event_missing",
        message: "체결 또는 호가 event가 아직 저장되지 않아 live execution으로 전진하지 않습니다.",
      });
    } else if (state.riskBlockCount > 0) {
      checks.push({
        name: "freshness",
        status: "blocked",
        code: "live_ops_market_data_risk_block",
        message: "시세 지연 또는 연결 장애가 감지되어 신규 실주문으로 진행하지 않습니다.",
        details: {
          riskBlockCount: state.riskBlockCount,
        },
      });
    } else {
      checks.push({
        name: "freshness",
        status: "ok",
        code: "live_ops_market_data_fresh",
        message: "체결/호가 event가 저장됐고 차단 상태가 없습니다.",
      });
    }
  } catch (error) {
    const observedAt = new Date().toISOString();
    const statusEvent = createLiveOpsMarketDataStatusEvent({
      market,
      status: "DISCONNECTED",
      observedAt,
      reasonCode: "live_ops_upbit_public_boot_failed",
      metadata: {
        errorName: safeErrorName(error),
      },
    });

    await persistLiveOpsCliMarketDataEvent(pool, statusEvent, {
      workerId: liveOpsMarketDataConsumerId,
      persisted,
      state,
    }).catch(() => undefined);
    checks.push({
      name: "event_source",
      status: "blocked",
      code: "live_ops_market_data_source_invalid",
      message: "Upbit public market data provider boot를 완료하지 못했습니다.",
      details: {
        reason: safeErrorName(error),
      },
    });
  } finally {
    await pool.end().catch(() => undefined);
  }

  const ready = checks.every((check) => check.status === "ok");
  return {
    status: ready ? "ready" : "blocked",
    ready,
    provider: "UPBIT_PUBLIC",
    market,
    sourceProfile: "upbit_public",
    message: ready
      ? "Upbit public market data provider가 DB-backed 저장 경계를 통과했습니다."
      : "market data collector가 live ops 다음 단계로 진행할 수 없습니다.",
    latestHeartbeatAt: state.latestHeartbeatAt,
    referencePrice: state.referencePrice,
    referencePriceSource: state.referencePriceSource,
    latestTradePrice: state.latestTradePrice,
    bestBidPrice: state.bestBidPrice,
    bestAskPrice: state.bestAskPrice,
    marketEvents: state.marketEvents,
    persisted,
    checks,
  };
}

async function collectLiveOpsUpbitPublicEvents({ market, staleAfterMs, timeoutMs, onEvent }) {
  const WebSocketConstructor = globalThis.WebSocket;
  if (WebSocketConstructor === undefined) {
    throw new Error("WebSocketUnavailable");
  }

  await new Promise((resolve, reject) => {
    const websocket = new WebSocketConstructor(liveOpsUpbitWebSocketUrl);
    let settled = false;
    let hasTrade = false;
    let hasOrderbook = false;
    const timeout = setTimeout(() => {
      finish(reject, new Error("LiveOpsUpbitPublicMarketDataTimeout"));
    }, timeoutMs);

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        websocket.close();
      } catch {
        // 종료 시점 close 실패는 provider boot 결과를 바꾸지 않으므로 무시한다.
      }
      settle(value);
    };

    websocket.addEventListener("open", () => {
      const observedAt = new Date().toISOString();
      void onEvent(createLiveOpsMarketDataStatusEvent({
        market,
        status: "CONNECTED",
        observedAt,
        reasonCode: "live_ops_upbit_public_connected",
      })).then(() => {
        websocket.send(createLiveOpsUpbitSubscriptionMessage({ market }));
      }).catch((error) => {
        finish(reject, error);
      });
    }, { once: true });

    websocket.addEventListener("message", (message) => {
      void (async () => {
        const receivedAt = new Date().toISOString();
        const data = await normalizeLiveOpsAsyncWebSocketData(message.data);
        for (const payload of parseLiveOpsUpbitWebSocketMessage(data)) {
          const event = mapLiveOpsUpbitPayloadToEvent(payload, {
            market,
            receivedAt,
            observedAt: receivedAt,
            staleAfterMs,
          });
          if (event === undefined) {
            continue;
          }

          await onEvent(event);
          if (event.type === "TRADE") {
            hasTrade = true;
          } else if (event.type === "ORDERBOOK") {
            hasOrderbook = true;
          }

          if (hasTrade && hasOrderbook) {
            finish(resolve);
            return;
          }
        }
      })().catch((error) => {
        finish(reject, error);
      });
    });

    websocket.addEventListener("error", () => {
      finish(reject, new Error("LiveOpsUpbitPublicWebSocketError"));
    }, { once: true });

    websocket.addEventListener("close", () => {
      if (!settled && (!hasTrade || !hasOrderbook)) {
        finish(reject, new Error("LiveOpsUpbitPublicWebSocketClosed"));
      }
    }, { once: true });
  });
}

export function createLiveOpsUpbitSubscriptionMessage({ market }) {
  return JSON.stringify([
    { ticket: liveOpsMarketDataConsumerId },
    { type: "trade", codes: [market], is_only_realtime: true },
    { type: "orderbook", codes: [market], is_only_realtime: true },
    { format: "DEFAULT" },
  ]);
}

export function parseLiveOpsUpbitWebSocketMessage(data) {
  const text = normalizeLiveOpsWebSocketData(data);
  const parsed = JSON.parse(protectLiveOpsUpbitLargeSequentialIds(text));
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function protectLiveOpsUpbitLargeSequentialIds(text) {
  return text.replace(/("sequential_id"\s*:\s*)(\d{16,})(?=\s*[,}\]])/gu, '$1"$2"');
}

export function mapLiveOpsUpbitPayloadToEvent(payload, { market, receivedAt, observedAt, staleAfterMs }) {
  if (payload?.status === "UP") {
    return createLiveOpsMarketDataStatusEvent({
      market,
      status: "CONNECTED",
      observedAt,
      reasonCode: "upbit_websocket_up",
      metadata: {
        upbitStatus: payload.status,
      },
    });
  }

  if (payload?.error !== undefined) {
    return createLiveOpsMarketDataStatusEvent({
      market,
      status: "DISCONNECTED",
      observedAt,
      reasonCode: `upbit_websocket_error:${String(payload.error.name ?? "unknown")}`,
      metadata: {
        errorName: String(payload.error.name ?? "unknown"),
      },
    });
  }

  if (payload?.code !== market) {
    // 허용 market 밖 event는 잘못된 주문 판단 입력이 될 수 있어 DB write 전에 차단한다.
    throw new Error("LiveOpsMarketDataOutsideUniverse");
  }

  if (payload?.type === "trade") {
    const event = {
      type: "TRADE",
      exchangeId: "upbit_krw_spot",
      market: payload.code,
      tradeId: String(payload.sequential_id),
      price: toDecimalString(payload.trade_price),
      quantity: toDecimalString(payload.trade_volume),
      side: payload.ask_bid === "BID" ? "BID" : "ASK",
      exchangeTimestamp: timestampFromMilliseconds(payload.trade_timestamp),
      receivedAt,
      raw: payload,
    };
    return maybeCreateStaleStatus(event, observedAt, staleAfterMs) ?? event;
  }

  if (payload?.type === "orderbook") {
    const event = {
      type: "ORDERBOOK",
      exchangeId: "upbit_krw_spot",
      market: payload.code,
      asks: payload.orderbook_units.map((unit) => ({
        price: toDecimalString(unit.ask_price),
        size: toDecimalString(unit.ask_size),
      })),
      bids: payload.orderbook_units.map((unit) => ({
        price: toDecimalString(unit.bid_price),
        size: toDecimalString(unit.bid_size),
      })),
      exchangeTimestamp: timestampFromMilliseconds(payload.timestamp),
      receivedAt,
      raw: payload,
    };
    return maybeCreateStaleStatus(event, observedAt, staleAfterMs) ?? event;
  }

  return undefined;
}

function maybeCreateStaleStatus(event, observedAt, staleAfterMs) {
  const websocketLagMs = Date.parse(observedAt) - Date.parse(event.exchangeTimestamp);
  if (!Number.isFinite(websocketLagMs) || websocketLagMs < 0 || websocketLagMs < staleAfterMs) {
    return undefined;
  }

  return createLiveOpsMarketDataStatusEvent({
    market: event.market,
    status: "STALE",
    observedAt,
    reasonCode: "live_ops_upbit_public_lag_exceeded",
    websocketLagMs,
  });
}

function createLiveOpsMarketDataStatusEvent({ market, status, observedAt, reasonCode, websocketLagMs, metadata }) {
  return {
    type: "STATUS",
    exchangeId: "upbit_krw_spot",
    market,
    status,
    observedAt,
    reasonCode,
    ...(websocketLagMs === undefined ? {} : { websocketLagMs }),
    reconnectCount: 0,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

async function persistLiveOpsCliMarketDataEvent(pool, event, { workerId, persisted, state }) {
  persisted.eventCount += 1;

  if (event.type === "TRADE") {
    await persistLiveOpsCliTrade(pool, event);
    persisted.tradeCount += 1;
    state.hasTrade = true;
    state.latestHeartbeatAt = event.receivedAt;
    state.referencePrice = event.price;
    state.referencePriceSource = "trade";
    state.latestTradePrice = event.price;
    appendLiveOpsCliMarketFrameEvent(state, event);
    return;
  }

  if (event.type === "ORDERBOOK") {
    await persistLiveOpsCliOrderbook(pool, event);
    persisted.orderbookCount += 1;
    state.hasOrderbook = true;
    state.latestHeartbeatAt = event.receivedAt;
    state.referencePrice = new Decimal(event.bids[0].price).plus(event.asks[0].price).div(2).toFixed();
    state.referencePriceSource = "orderbook_mid";
    state.bestBidPrice = event.bids[0].price;
    state.bestAskPrice = event.asks[0].price;
    appendLiveOpsCliMarketFrameEvent(state, event);
    return;
  }

  await persistLiveOpsCliStatus(pool, event, workerId);
  persisted.statusCount += 1;
  state.latestHeartbeatAt = event.observedAt;
  appendLiveOpsCliMarketFrameEvent(state, event);
  if (liveOpsMarketDataStatusBlocksNewOrders(event.status)) {
    persisted.riskBlockCount += 1;
    state.riskBlockCount += 1;
  }
}

function appendLiveOpsCliMarketFrameEvent(state, event) {
  const safeEvent = toLiveOpsCliSafeMarketFrameEvent(event);
  if (safeEvent === undefined) {
    return;
  }

  state.marketEvents.push(safeEvent);
  if (state.marketEvents.length > 10) {
    state.marketEvents.splice(0, state.marketEvents.length - 10);
  }
}

function toLiveOpsCliSafeMarketFrameEvent(event) {
  if (event.type === "TRADE") {
    return {
      type: "TRADE",
      exchangeId: event.exchangeId,
      market: event.market,
      tradeId: event.tradeId,
      price: event.price,
      quantity: event.quantity,
      side: event.side,
      exchangeTimestamp: event.exchangeTimestamp,
      receivedAt: event.receivedAt,
    };
  }

  if (event.type === "ORDERBOOK") {
    return {
      type: "ORDERBOOK",
      exchangeId: event.exchangeId,
      market: event.market,
      asks: event.asks,
      bids: event.bids,
      exchangeTimestamp: event.exchangeTimestamp,
      receivedAt: event.receivedAt,
    };
  }

  if (event.type === "STATUS") {
    return {
      type: "STATUS",
      exchangeId: event.exchangeId,
      market: event.market,
      status: event.status,
      observedAt: event.observedAt,
      reasonCode: event.reasonCode,
      websocketLagMs: event.websocketLagMs,
      reconnectCount: event.reconnectCount,
    };
  }

  return undefined;
}

async function persistLiveOpsCliTrade(pool, event) {
  await pool.query(
    `INSERT INTO trades (exchange, market, trade_id, side, price, volume, exchange_timestamp, received_at, raw_payload_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (exchange, market, trade_id, exchange_timestamp) DO NOTHING`,
    [
      event.exchangeId,
      event.market,
      event.tradeId,
      event.side === "BID" ? "BUY" : "SELL",
      event.price,
      event.quantity,
      event.exchangeTimestamp,
      event.receivedAt,
      JSON.stringify(event.raw ?? {}),
    ],
  );
}

async function persistLiveOpsCliOrderbook(pool, event) {
  const metric = toLiveOpsOrderbookMetric(event);
  const snapshot = {
    bids_json: JSON.stringify({ levels: event.bids }),
    asks_json: JSON.stringify({ levels: event.asks }),
    raw_payload_json: JSON.stringify(event.raw ?? {}),
  };

  await pool.query(
    `INSERT INTO orderbook_metrics (
       exchange, market, bucket_at, best_bid_price, best_ask_price, spread_bps,
       bid_depth_1, ask_depth_1, bid_depth_5, ask_depth_5, bid_depth_15, ask_depth_15,
       imbalance_5, imbalance_15, websocket_lag_ms, reconnect_count
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (exchange, market, bucket_at) DO UPDATE SET
       best_bid_price = EXCLUDED.best_bid_price,
       best_ask_price = EXCLUDED.best_ask_price,
       spread_bps = EXCLUDED.spread_bps,
       bid_depth_1 = EXCLUDED.bid_depth_1,
       ask_depth_1 = EXCLUDED.ask_depth_1,
       bid_depth_5 = EXCLUDED.bid_depth_5,
       ask_depth_5 = EXCLUDED.ask_depth_5,
       bid_depth_15 = EXCLUDED.bid_depth_15,
       ask_depth_15 = EXCLUDED.ask_depth_15,
       imbalance_5 = EXCLUDED.imbalance_5,
       imbalance_15 = EXCLUDED.imbalance_15,
       websocket_lag_ms = EXCLUDED.websocket_lag_ms,
       reconnect_count = EXCLUDED.reconnect_count`,
    [
      event.exchangeId,
      event.market,
      metric.bucketAt,
      metric.bestBidPrice,
      metric.bestAskPrice,
      metric.spreadBps,
      metric.bidDepth1,
      metric.askDepth1,
      metric.bidDepth5,
      metric.askDepth5,
      metric.bidDepth15,
      metric.askDepth15,
      metric.imbalance5,
      metric.imbalance15,
      metric.websocketLagMs,
      0,
    ],
  );
  await pool.query(
    `INSERT INTO orderbook_snapshots (exchange, market, captured_at, bids_json, asks_json, raw_payload_json)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
     ON CONFLICT (exchange, market, captured_at) DO UPDATE SET
       bids_json = EXCLUDED.bids_json,
       asks_json = EXCLUDED.asks_json,
       raw_payload_json = EXCLUDED.raw_payload_json`,
    [
      event.exchangeId,
      event.market,
      floorIsoTimestamp(event.exchangeTimestamp, 5_000),
      snapshot.bids_json,
      snapshot.asks_json,
      snapshot.raw_payload_json,
    ],
  );
}

async function persistLiveOpsCliStatus(pool, event, workerId) {
  const payload = {
    kind: "market_data_status",
    exchangeId: event.exchangeId,
    market: event.market,
    status: event.status,
    blockNewOrders: liveOpsMarketDataStatusBlocksNewOrders(event.status),
    workerId,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.websocketLagMs === undefined ? {} : { websocketLagMs: event.websocketLagMs }),
    ...(event.reconnectCount === undefined ? {} : { reconnectCount: event.reconnectCount }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  };
  await pool.query(
    `INSERT INTO audit_events (event_type, severity, order_id, correlation_id, payload_json, occurred_at)
     VALUES ($1, $2, NULL, $3, $4::jsonb, $5)`,
    [
      "MARKET_DATA_STATUS",
      toLiveOpsAuditSeverity(event.status),
      ["market-data", event.exchangeId, event.market ?? "global", event.status, event.observedAt].join(":"),
      JSON.stringify(payload),
      event.observedAt,
    ],
  );

  if (!liveOpsMarketDataStatusBlocksNewOrders(event.status)) {
    return;
  }

  // 장애성 status는 다음 lifecycle이 broker로 전진하지 못하게 risk evidence로도 남긴다.
  await pool.query(
    `INSERT INTO risk_events (risk_type, severity, market, strategy_id, order_id, action, payload_json, occurred_at)
     VALUES ($1, $2, $3, NULL, NULL, $4, $5::jsonb, $6)`,
    [
      toLiveOpsRiskType(event.status),
      event.status === "DISCONNECTED" ? "ERROR" : "WARN",
      event.market ?? null,
      "BLOCK_NEW_ORDERS",
      JSON.stringify(payload),
      event.observedAt,
    ],
  );
}

function toLiveOpsOrderbookMetric(event) {
  const bestBidPrice = event.bids[0].price;
  const bestAskPrice = event.asks[0].price;
  const bidDepth1 = sumLiveOpsDepth(event.bids, 1);
  const askDepth1 = sumLiveOpsDepth(event.asks, 1);
  const bidDepth5 = sumLiveOpsDepth(event.bids, 5);
  const askDepth5 = sumLiveOpsDepth(event.asks, 5);
  const bidDepth15 = sumLiveOpsDepth(event.bids, 15);
  const askDepth15 = sumLiveOpsDepth(event.asks, 15);

  return {
    bucketAt: floorIsoTimestamp(event.exchangeTimestamp, 1_000),
    bestBidPrice,
    bestAskPrice,
    spreadBps: new Decimal(bestAskPrice).minus(bestBidPrice).div(new Decimal(bestAskPrice).plus(bestBidPrice).div(2)).mul(10_000).toFixed(6),
    bidDepth1,
    askDepth1,
    bidDepth5,
    askDepth5,
    bidDepth15,
    askDepth15,
    imbalance5: calculateLiveOpsImbalance(bidDepth5, askDepth5),
    imbalance15: calculateLiveOpsImbalance(bidDepth15, askDepth15),
    websocketLagMs: Math.max(0, Date.parse(event.receivedAt) - Date.parse(event.exchangeTimestamp)),
  };
}

function sumLiveOpsDepth(levels, count) {
  return levels.slice(0, count).reduce((sum, level) => sum.plus(level.size), new Decimal(0)).toFixed();
}

function calculateLiveOpsImbalance(bidDepth, askDepth) {
  const bid = new Decimal(bidDepth);
  const ask = new Decimal(askDepth);
  const total = bid.plus(ask);
  return total.eq(0) ? "0" : bid.minus(ask).div(total).toFixed(8);
}

function liveOpsMarketDataStatusBlocksNewOrders(status) {
  return status === "STALE" || status === "RECONNECTING" || status === "DISCONNECTED";
}

function toLiveOpsAuditSeverity(status) {
  if (status === "DISCONNECTED") return "ERROR";
  if (status === "STALE" || status === "RECONNECTING") return "WARN";
  return "INFO";
}

function toLiveOpsRiskType(status) {
  if (status === "STALE") return "stale_market_data";
  if (status === "RECONNECTING") return "market_data_reconnecting";
  return "market_data_disconnected";
}

function normalizeLiveOpsWebSocketData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    throw new Error("LiveOpsBlobWebSocketMessageUnsupported");
  }
  return String(data);
}

async function normalizeLiveOpsAsyncWebSocketData(data) {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }

  return normalizeLiveOpsWebSocketData(data);
}

function timestampFromMilliseconds(timestamp) {
  return new Date(Number(timestamp)).toISOString();
}

function floorIsoTimestamp(timestamp, bucketMs) {
  const value = Date.parse(timestamp);
  return new Date(Math.floor(value / bucketMs) * bucketMs).toISOString();
}

function toDecimalString(value) {
  return new Decimal(value).toFixed();
}

function emptyMarketDataPersistenceSummary() {
  return {
    eventCount: 0,
    tradeCount: 0,
    orderbookCount: 0,
    statusCount: 0,
    riskBlockCount: 0,
  };
}

async function evaluateLiveOpsCliDbReadiness({ databaseUrl, fixtureSmoke }) {
  const checkedAt = new Date().toISOString();
  const checks = [];
  const migrationFiles = await loadCliMigrationFilesForReadiness(checks);

  if (migrationFiles === undefined) {
    return buildCliDbReadinessSummary(checkedAt, checks, emptyCliMigrationSummary(false), fixtureSmoke);
  }

  if (fixtureSmoke) {
    checks.push(okCliCheck("db_connection", "fixture smoke에서는 외부 DB에 연결하지 않습니다.", "db_connection_fixture_skipped"));
    checks.push(okCliCheck("schema_migrations_table", "fixture smoke에서는 schema_migrations를 디스크 기준으로 대체했습니다.", "schema_migrations_fixture"));
    checks.push(okCliCheck("migration_state", "fixture smoke migration 기준을 통과했습니다.", "migration_state_fixture_ok", {
      expectedLatestVersion: latestCliMigrationVersion(migrationFiles),
      pendingCount: 0,
    }));
    return buildCliDbReadinessSummary(
      checkedAt,
      checks,
      {
        expectedLatestVersion: latestCliMigrationVersion(migrationFiles),
        appliedLatestVersion: latestCliMigrationVersion(migrationFiles),
        pendingVersions: [],
        appliedVersions: migrationFiles.map((migration) => migration.version),
        tableExists: true,
      },
      true,
    );
  }

  const pool = new PgPool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: dbReadinessConnectionTimeoutMs,
    max: 1,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  let connectionOk = false;

  try {
    await pool.query("SELECT 1::int AS ok");
    connectionOk = true;
    checks.push(okCliCheck("db_connection", "DB 연결 probe를 통과했습니다.", "db_connection_ok"));

    const migrationSummary = await evaluateCliMigrationState(pool, migrationFiles, checks);
    return buildCliDbReadinessSummary(checkedAt, checks, migrationSummary, false);
  } catch (error) {
    if (!connectionOk) {
      // DB 연결이 불확실하면 credential을 출력하지 않고 운영자가 점검할 행동만 남긴다.
      checks.push(blockedCliCheck(
        "db_connection",
        "DB에 연결할 수 없습니다. env file의 SEEMIRAI_DATABASE_URL과 네트워크 접근성을 확인하세요.",
        "db_connection_failed",
        { reason: safeErrorName(error) },
      ));
    } else {
      // schema 조회 실패는 연결 실패와 분리해야 운영자가 migration 권한/테이블 상태를 정확히 점검할 수 있다.
      checks.push(blockedCliCheck(
        "migration_state",
        "DB migration 상태를 읽을 수 없습니다. schema_migrations 조회 권한과 테이블 상태를 확인하세요.",
        "migration_state_query_failed",
        { reason: safeErrorName(error) },
      ));
    }
    return buildCliDbReadinessSummary(checkedAt, checks, buildCliMigrationSummary(migrationFiles, [], false), false);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function loadCliMigrationFilesForReadiness(checks) {
  try {
    const migrations = await loadCliMigrationFiles(defaultMigrationsDirectory);
    if (migrations.length === 0) {
      // 적용 기준 파일이 없으면 DB가 최신인지 판단할 수 없어 live boot를 멈춘다.
      checks.push(blockedCliCheck(
        "migration_files",
        "migration 파일을 찾지 못했습니다. 운영 스키마 기준을 확인하세요.",
        "migration_files_missing",
      ));
      return undefined;
    }

    checks.push(okCliCheck("migration_files", "migration 파일 기준을 읽었습니다.", "migration_files_ok", {
      expectedLatestVersion: latestCliMigrationVersion(migrations),
      migrationCount: migrations.length,
    }));
    return migrations;
  } catch (error) {
    checks.push(blockedCliCheck(
      "migration_files",
      "migration 파일을 읽거나 검증할 수 없습니다. 파일명/version/checksum 기준을 확인하세요.",
      "migration_files_invalid",
      { reason: safeErrorName(error) },
    ));
    return undefined;
  }
}

async function evaluateCliMigrationState(pool, migrationFiles, checks) {
  const tableResult = await pool.query("SELECT to_regclass('public.schema_migrations')::text AS table_name");
  const tableExists = tableResult.rows[0]?.table_name !== null && tableResult.rows[0]?.table_name !== undefined;

  if (!tableExists) {
    const pendingVersions = migrationFiles.map((migration) => migration.version);
    checks.push(blockedCliCheck(
      "schema_migrations_table",
      "schema_migrations 테이블이 없습니다. 운영 DB migration bootstrap을 먼저 실행하세요.",
      "schema_migrations_table_missing",
    ));
    // schema_migrations가 없으면 적용 이력을 증명할 수 없어 모든 migration을 pending으로 보고 차단한다.
    checks.push(blockedCliCheck(
      "migration_state",
      "DB migration 이력이 없습니다. migration을 먼저 적용한 뒤 live ops를 시작하세요.",
      "schema_migrations_missing",
      {
        expectedLatestVersion: latestCliMigrationVersion(migrationFiles),
        pendingCount: pendingVersions.length,
      },
    ));
    return {
      expectedLatestVersion: latestCliMigrationVersion(migrationFiles),
      appliedLatestVersion: null,
      pendingVersions,
      appliedVersions: [],
      tableExists: false,
    };
  }

  const recordsResult = await pool.query(`
    SELECT version, filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `);
  const appliedRecords = recordsResult.rows.map((record) => ({
    version: Number(record.version),
    filename: String(record.filename),
    checksum: String(record.checksum),
    applied_at: record.applied_at,
  }));
  checks.push(okCliCheck("schema_migrations_table", "schema_migrations 적용 이력을 읽었습니다.", "schema_migrations_table_ok", {
    appliedCount: appliedRecords.length,
  }));

  const migrationSummary = buildCliMigrationSummary(migrationFiles, appliedRecords, true);
  try {
    const plan = createCliMigrationPlan(migrationFiles, appliedRecords);
    if (plan.applied.length > 0) {
      // pending migration은 live worker가 시작된 뒤 DB 계약이 바뀌는 것을 막기 위해 boot 전에 차단한다.
      checks.push(blockedCliCheck(
        "migration_state",
        "적용되지 않은 migration이 있습니다. migration apply를 먼저 완료하세요.",
        "pending_migrations",
        {
          expectedLatestVersion: migrationSummary.expectedLatestVersion,
          appliedLatestVersion: migrationSummary.appliedLatestVersion,
          pendingCount: plan.applied.length,
        },
      ));
      return migrationSummary;
    }

    checks.push(okCliCheck("migration_state", "DB migration 상태가 디스크 기준과 일치합니다.", "migration_state_ok", {
      expectedLatestVersion: migrationSummary.expectedLatestVersion,
      appliedLatestVersion: migrationSummary.appliedLatestVersion,
    }));
    return migrationSummary;
  } catch (error) {
    // 적용 이력과 디스크 파일이 어긋나면 자동 복구가 위험하므로 사람이 schema drift를 확인해야 한다.
    checks.push(blockedCliCheck(
      "migration_state",
      "DB migration 이력이 현재 코드의 migration 파일과 일치하지 않습니다. schema drift를 확인하세요.",
      safeErrorName(error) === "UnknownAppliedMigrationError"
        ? "unknown_applied_migration"
        : safeErrorName(error) === "MigrationChecksumMismatchError"
          ? "migration_checksum_mismatch"
          : "migration_state_invalid",
      { reason: safeErrorName(error) },
    ));
    return migrationSummary;
  }
}

async function loadCliMigrationFiles(migrationsDirectory) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }

    const match = migrationFilePattern.exec(entry.name);
    if (match === null) {
      throw new Error(`InvalidMigrationFilenameError:${entry.name}`);
    }

    const sql = await readFile(path.join(migrationsDirectory, entry.name), "utf8");
    migrations.push({
      version: Number(match[1]),
      filename: entry.name,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    });
  }

  return sortAndValidateCliMigrations(migrations);
}

function createCliMigrationPlan(migrations, appliedRecords) {
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set();

  for (const record of appliedRecords) {
    const migration = migrationsByVersion.get(record.version);
    if (migration === undefined) {
      throw Object.assign(new Error("Applied migration is missing from disk"), {
        name: "UnknownAppliedMigrationError",
      });
    }

    if (record.filename !== migration.filename || record.checksum !== migration.checksum) {
      throw Object.assign(new Error("Applied migration checksum mismatch"), {
        name: "MigrationChecksumMismatchError",
      });
    }

    appliedVersions.add(record.version);
  }

  return {
    applied: migrations.filter((migration) => !appliedVersions.has(migration.version)),
    skipped: migrations.filter((migration) => appliedVersions.has(migration.version)),
  };
}

function sortAndValidateCliMigrations(migrations) {
  const versions = new Set();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`DuplicateMigrationVersionError:${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations.toSorted((left, right) => left.version - right.version);
}

function buildCliDbReadinessSummary(checkedAt, checks, migration, fixtureSmoke) {
  const ready = checks.every((check) => check.status === "ok");
  return {
    status: ready ? "ready" : "blocked",
    ready,
    checkedAt,
    fixtureSmoke,
    message: ready
      ? "DB readiness를 통과했습니다."
      : "DB readiness를 통과하지 못해 live ops boot를 중단합니다.",
    migration,
    checks,
  };
}

function buildCliMigrationSummary(migrations, appliedRecords, tableExists) {
  const appliedVersions = appliedRecords.map((record) => Number(record.version)).toSorted((left, right) => left - right);
  const appliedVersionSet = new Set(appliedVersions);
  return {
    expectedLatestVersion: latestCliMigrationVersion(migrations),
    appliedLatestVersion: appliedVersions.at(-1) ?? null,
    pendingVersions: migrations
      .map((migration) => migration.version)
      .filter((version) => !appliedVersionSet.has(version)),
    appliedVersions,
    tableExists,
  };
}

function emptyCliMigrationSummary(tableExists) {
  return {
    expectedLatestVersion: null,
    appliedLatestVersion: null,
    pendingVersions: [],
    appliedVersions: [],
    tableExists,
  };
}

function latestCliMigrationVersion(migrations) {
  return migrations.at(-1)?.version ?? null;
}

function okCliCheck(name, message, code, details) {
  return {
    name,
    status: "ok",
    message,
    code,
    details,
  };
}

function blockedCliCheck(name, message, code, details) {
  return {
    name,
    status: "blocked",
    message,
    code,
    details,
  };
}

function formatCliDbReadinessFailureMessage(summary) {
  const failures = summary.checks
    .filter((check) => check.status === "blocked")
    .map((check) => check.message)
    .join(" ");
  return `DB readiness를 통과하지 못해 live ops boot를 중단합니다. ${failures}`;
}

function formatCliMarketDataFailureMessage(summary) {
  const failures = summary.checks
    .filter((check) => check.status === "blocked")
    .map((check) => check.message)
    .join(" ");
  return `market data provider boot를 통과하지 못해 live ops boot를 중단합니다. ${failures}`;
}

function formatCliLiveExecutionFailureMessage(summary) {
  const failures = summary.checks
    .filter((check) => check.status === "blocked")
    .map((check) => check.message)
    .join(" ");
  return `live execution guard를 통과하지 못해 live ops boot를 중단합니다. ${failures}`;
}

function formatCliSummaryFailureMessage(summary) {
  const message = hasMeaningfulValue(summary?.message) ? summary.message : "최종 readiness summary가 ready가 아닙니다.";
  return `live ops 최종 readiness를 통과하지 못해 boot를 중단합니다. ${message}`;
}

function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

function readValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}
