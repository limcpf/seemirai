import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Decimal } from "decimal.js";
import pg from "pg";

const { Pool: PgPool } = pg;
const migrationFilePattern = /^(\d{6})_[a-z0-9_]+\.sql$/u;
const defaultMigrationsDirectory = path.resolve("migrations");
const dbReadinessConnectionTimeoutMs = 5000;
const liveOpsUpbitWebSocketUrl = "wss://api.upbit.com/websocket/v1";
const liveOpsMarketDataConsumerId = "live-ops-market-data";
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
  analysis: ["candle_interval_seconds", "feature_interval_seconds", "decision_interval_seconds", "record_hold_decision"],
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
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const env = parseEnvFile(await readFile(envFilePath, "utf8"));
  validateLiveOpsConfig(config);
  validateLiveOpsEnv(env, process.env);
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

  const analysisDecision = evaluateLiveOpsCliAnalysisDecision({
    config,
    fixtureSmoke: options.fixtureSmoke,
    marketData,
  });
  const liveExecution = await evaluateLiveOpsCliLiveExecution({
    config,
    fixtureSmoke: options.fixtureSmoke,
    analysisDecision,
    marketData,
    env,
  });
  assertLiveOpsCliLiveExecutionReady(liveExecution, { fixtureSmoke: options.fixtureSmoke });
  const reconcilePnlStatus = await evaluateLiveOpsCliReconcilePnlStatus({
    config,
    fixtureSmoke: options.fixtureSmoke,
    liveExecution,
  });
  const telegramAlert = await evaluateLiveOpsCliTelegramAlert({
    config,
    fixtureSmoke: options.fixtureSmoke,
    liveExecution,
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
}

export function renderLiveOpsSummary(input) {
  const postExecutionReady = input.reconcilePnlStatus.ready === true && input.telegramAlert.ready === true;
  const status = input.dbReadiness.ready && input.marketData.ready && input.analysisDecision.ready && input.liveExecution.ready && postExecutionReady
    ? "ready"
    : "blocked";
  return {
    status,
    message: status === "ready"
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
          : "후속 연결 대기")
      : worker === "reconcile_pnl_status"
        ? (summary.reconcilePnlStatus?.ready ? "상태 요약 확인 - provider 호출 없음" : "후속 연결 대기")
      : worker === "telegram"
        ? (summary.telegramAlert?.ready ? "fixture alert plan 확인" : "후속 연결 대기")
      : worker === "tui"
        ? "실행 중"
        : "후속 연결 대기";
    return `  - ${label}: ${state}`;
  });

  return [
    "Seemirai Live Ops",
    "운영 dashboard",
    "",
    `상태: ${summary.status === "ready" ? "부팅 준비" : "확인 필요"}`,
    `모드: ${summary.mode}`,
    `시장: ${summary.trace.defaultMarket ?? "확인 필요"}`,
    `실주문 가능: ${summary.liveOrderCapable ? "예" : "아니오"}`,
    `실행 형태: ${summary.fixtureSmoke ? "fixture smoke - 외부 DB/provider 호출 없음" : summary.attach === null ? "foreground" : "attach"}`,
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
    `필요 조치: ${summary.liveOrderCapable ? "후보 처리 전 예산과 reconcile freshness를 재확인하세요." : "후속 provider 연결 전까지 신규 실주문은 제출되지 않습니다."}`,
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
    return "후속 연결 대기";
  }

  return [
    liveExecution.statusLabel ?? "대기",
    `주문 후보 ${liveExecution.orderIntentCount}`,
    `broker 제출 ${liveExecution.submittedOrderCount}`,
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
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot,
  lossSnapshot,
}) {
  const market = config.universe?.default_market ?? "KRW-BTC";
  const observedAt = new Date().toISOString();
  const intents = orderIntents ?? analysisDecision.orderIntents ?? [];
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

  const executionStatusViolations = collectLiveOpsCliExecutionStatusViolations(executionStatus, postSubmitReadiness, budgetSnapshot, lossSnapshot);
  if (executionStatusViolations.length > 0) {
    // kill switch, reconcile freshness, post-submit 후속 경계가 불명확하면 후보가 유효해도 broker runtime을 열지 않는다.
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
      statusLabel: "운영 상태 차단",
      message: "live execution 운영 상태 증거가 부족해 주문 후보를 제출하지 않았습니다.",
      action: "kill switch, reconcile freshness, 제출 후 reconcile/alert 경계 증거를 확인하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        blockedLiveExecutionCheck("execution_status", "live execution 운영 상태 snapshot이 production 제출 조건을 통과하지 못했습니다.", "live_ops_execution_status_blocked", {
          violations: executionStatusViolations,
        }),
      ],
    });
  }

  const intent = intents[0];
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
  if (entryRuntime === undefined) {
    // runtime wiring이 없으면 reservation/broker side effect가 없으므로 불확실 제출이 아니라 설정 차단으로 닫는다.
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
      action: "budget reservation과 broker runtime wiring을 연결한 뒤 다시 실행하세요.",
      checks: [
        okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
        okLiveExecutionCheck("order_intent", "단일 LIMIT + post-only 주문 후보를 확인했습니다.", "live_ops_order_intent_ready"),
        blockedLiveExecutionCheck("entry_runtime", "live autonomous entry runtime이 연결되지 않았습니다.", "live_ops_entry_runtime_missing"),
      ],
    });
  }

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

  const submitted = attempt.status === "SUBMITTED";
  return {
    status: submitted ? "submitted" : String(attempt.status ?? "blocked").toLowerCase(),
    ready: submitted,
    liveOrderCapable: submitted,
    market,
    latestExecutionAt: observedAt,
    orderIntentCount: intents.length,
    attemptedOrderCount: 1,
    submittedOrderCount: submitted ? 1 : 0,
    attemptStatus: attempt.status ?? null,
    attemptId: attempt.attemptId ?? null,
    idempotencyKey: attempt.idempotencyKey ?? request.idempotencyKey,
    brokerOrderId: attempt.brokerOrderId ?? attempt.executionResult?.brokerOrder?.brokerOrderId ?? null,
    brokerGuard,
    statusLabel: submitted ? "broker 제출" : "제출 차단",
    message: submitted
      ? "실주문 실행 경계가 주문 후보를 broker 제출까지 전진시켰습니다."
      : (attempt.message ?? "live execution runtime이 주문 후보를 제출하지 않았습니다."),
    action: submitted
      ? "체결, 취소, reconcile/PnL/status worker에서 후속 상태를 확인합니다."
      : (attempt.action ?? "차단 원인을 확인한 뒤 다음 tick에서 다시 평가합니다."),
    checks: [
      okLiveExecutionCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready"),
      okLiveExecutionCheck("order_intent", "단일 LIMIT + post-only 주문 후보를 확인했습니다.", "live_ops_order_intent_ready"),
      okLiveExecutionCheck("execution_request", "live autonomous entry runtime 요청을 만들었습니다.", "live_ops_execution_request_ready"),
      {
        name: "execution_result",
        status: submitted ? "ok" : "blocked",
        code: submitted ? "live_ops_execution_submitted" : "live_ops_execution_blocked",
        message: submitted ? "broker 제출 결과를 확인했습니다." : "entry runtime이 제출을 차단했습니다.",
      },
    ],
  };
}

export function createLiveOpsCliEntryRuntime({ broker, budgetReservation } = {}) {
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
        executionResult: {
          status: "SUBMITTED",
          submission,
          brokerOrder,
        },
      };
    },
  };
}

function isLiveOpsCliEntryRuntimeRequestEvidenceReady(request) {
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
    idempotencyKey: request.candidate?.metadata?.decision_idempotency_key ?? request.idempotencyKey,
    metadata: {
      expected_loss_bps_of_equity: request.candidate?.expectedLossBpsOfEquity,
    },
  };

  return (
    isLiveOpsCliCostSnapshotEvidence(request.candidate?.costSnapshot, intent) &&
    isLiveOpsCliRiskApprovalEvidence(request.candidate?.riskApproval, intent)
  );
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
  }
  if (!isLiveOpsCliCostSnapshotEvidence(intent?.costSnapshot, intent)) {
    violations.push("주문 후보에는 현재 intent와 일치하는 CostModel evidence가 필요합니다");
  }
  if (!isLiveOpsCliRiskApprovalEvidence(intent?.riskApproval, intent)) {
    violations.push("주문 후보에는 현재 intent와 일치하는 RiskGate approval evidence가 필요합니다");
  }
  return violations;
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
        decision_idempotency_key: intent.idempotencyKey,
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
    budgetSnapshot: request.budgetSnapshot,
    observedAt: request.observedAt,
    metadata: {
      source: "live_ops_cli_entry_runtime",
    },
  };
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
      privateReadProvider.listOpenOrders(market),
      privateReadProvider.getBalances(),
      readLiveOpsCliReconcileStatus(reconcileStatusProvider),
      readLiveOpsCliPnlStatus(pnlStatusProvider),
    ]);
  } catch (error) {
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
      budgetUsedKrw: "0",
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
      observedAt,
      code: malformedPrivateRead.code,
      message: malformedPrivateRead.message,
      reason: malformedPrivateRead.reason,
    });
  }

  const orders = openOrders;
  const openExposureKrw = sumLiveOpsCliOpenExposureKrw(orders);
  const resolvedReconcileStatus = normalizeLiveOpsCliReconcileStatus(reconcileStatus, {
    observedAt,
    openOrderCount: orders.length,
  });
  const resolvedPnlStatus = normalizeLiveOpsCliPnlStatus(pnlStatus);
  const manualReviewRequired = resolvedReconcileStatus.manualReviewRequired || resolvedPnlStatus.manualReviewRequired;
  const budgetUsedKrw = resolveLiveOpsCliBudgetUsedKrw({
    budgetSnapshot,
    openOrders: orders,
  });
  const krwBalance = findLiveOpsCliBalance(balanceSnapshot, "KRW");

  return {
    status: manualReviewRequired ? "manual_review_required" : "ready",
    ready: !manualReviewRequired,
    market,
    liveOrderCapable: liveExecution.liveOrderCapable === true && !manualReviewRequired,
    latestReconcileAt: resolvedReconcileStatus.lastReconcileAt ?? observedAt,
    latestPnlAt: resolvedPnlStatus.latestCapturedAt,
    latestStatusAt: observedAt,
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
        status: "ok",
        code: "live_ops_private_read_summary_ready",
        message: "account/order/balance private read 결과를 secret-safe status summary로 낮췄습니다.",
        details: {
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

function createLiveOpsCliPrivateReadFailureSummary({ market, liveExecution, observedAt, code, message, reason }) {
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
    budgetUsedKrw: "0",
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
    liveExecution.status === "cancel_confirmed"
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
    if (!isPositiveDecimalString(order?.requestedPrice)) {
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

async function readLiveOpsCliPnlStatus(provider) {
  if (provider === undefined || provider === null || typeof provider.getStatus !== "function") {
    return undefined;
  }
  return provider.getStatus();
}

function normalizeLiveOpsCliReconcileStatus(summary, { observedAt, openOrderCount }) {
  if (summary === undefined) {
    return {
      result: "private_read_observed",
      statusLabel: "private read 확인",
      lastReconcileAt: observedAt,
      mismatchCount: null,
      manualReviewRequired: false,
    };
  }

  const result = String(summary.result ?? "UNAVAILABLE");
  const mismatchCount = Number.isFinite(Number(summary.mismatchCount)) ? Number(summary.mismatchCount) : null;
  const manualReviewRequired = (
    result === "MISMATCH_DETECTED" ||
    result === "FAILED" ||
    result === "UNAVAILABLE" ||
    (mismatchCount !== null && mismatchCount > 0)
  );

  return {
    result,
    statusLabel: manualReviewRequired ? "수동 확인 필요" : "정상",
    lastReconcileAt: summary.lastReconcileAt ?? observedAt,
    mismatchCount,
    openOrderCount: summary.openOrderCount ?? openOrderCount,
    manualReviewRequired,
  };
}

function normalizeLiveOpsCliPnlStatus(summary) {
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

function sumLiveOpsCliOpenExposureKrw(openOrders) {
  return sumDecimalStrings(openOrders.map((order) => {
    return new Decimal(order.remainingQuantity).mul(order.requestedPrice).toFixed();
  }));
}

function resolveLiveOpsCliBudgetUsedKrw({ budgetSnapshot, openOrders }) {
  if (isNonNegativeDecimalString(budgetSnapshot?.dailyAutonomousNotionalUsedKrw)) {
    return budgetSnapshot.dailyAutonomousNotionalUsedKrw;
  }

  return sumDecimalStrings(openOrders.map((order) => {
    return new Decimal(order.requestedQuantity).mul(order.requestedPrice).toFixed();
  }));
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

  if (!fixtureSmoke && shouldDispatchLiveOpsCliTelegramAlert(liveExecution) && telegramDispatcher !== undefined) {
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

  if (!fixtureSmoke && shouldDispatchLiveOpsCliTelegramAlert(liveExecution)) {
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

function shouldDispatchLiveOpsCliTelegramAlert(liveExecution) {
  return (
    liveExecution.status === "submitted" ||
    liveExecution.status === "rejected" ||
    liveExecution.status === "cost_blocked" ||
    liveExecution.status === "reconcile_required" ||
    liveExecution.status === "manual_review_required" ||
    liveExecution.status === "cancel_requested" ||
    liveExecution.status === "cancel_confirmed"
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
    const tradeEvent = createLiveOpsCliTradeTelegramEvent({
      market,
      liveExecution,
      orderIntent,
      observedAt,
      correlationId,
    });
    if (tradeEvent !== undefined) {
      events.push(tradeEvent);
    }
  }
  return events;
}

function createLiveOpsCliTradeTelegramEvent({ market, liveExecution, orderIntent, observedAt, correlationId }) {
  const eventKind = mapLiveOpsCliTelegramTradeEventKind(liveExecution.status);
  if (eventKind === undefined) {
    return undefined;
  }

  return createLiveOpsCliTelegramBaseEvent({
    eventKind,
    market,
    liveExecution,
    orderIntent,
    observedAt,
    correlationId,
    evidenceId: liveExecution.attemptId ?? undefined,
    safeSummary: liveExecution.message ?? "production live ops trade event가 확정됐습니다.",
  });
}

function mapLiveOpsCliTelegramTradeEventKind(status) {
  switch (status) {
    case "submitted":
      return "ORDER_SUBMITTED";
    case "cancel_requested":
      return "CANCEL_REQUESTED";
    case "cancel_confirmed":
      return "CANCEL_CONFIRMED";
    case "reconcile_required":
      return "RECONCILE_BLOCKED";
    case "manual_review_required":
      return "MANUAL_REVIEW_REQUIRED";
    case "cost_blocked":
      return "COST_BLOCKED";
    case "rejected":
      return "RISK_BLOCKED";
    case "blocked":
      // generic blocked는 wiring/readiness 차단도 포함하므로 RiskGate evidence 없이 risk alert로 추정하지 않는다.
      return undefined;
    default:
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

function evaluateLiveOpsCliAnalysisDecision({ config, fixtureSmoke, marketData }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (marketData.ready !== true) {
    return {
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
      orderIntents: [],
      message: "analysis/decision pipeline은 market data lifecycle 이후 연결됩니다.",
      checks: [
        {
          name: "market_data",
          status: "blocked",
          code: "live_ops_analysis_pending",
          message: "analysis/decision pipeline이 후속 lifecycle에서 시작됩니다.",
        },
      ],
    };
  }

  const latestDecisionAt = new Date().toISOString();
  if (!fixtureSmoke) {
    return {
      status: "pending",
      ready: false,
      market,
      observedAt: latestDecisionAt,
      latestDecisionAt: null,
      decisionCategory: "HOLD",
      featureStatus: "not_run",
      evaluatedStrategyCount: 0,
      holdCount: 0,
      blockCount: 1,
      orderIntentCount: 0,
      recordHoldDecision: false,
      orderIntents: [],
      decisionSourceConnected: false,
      message: "production decision source가 아직 연결되지 않아 주문 후보 없음으로 확정하지 않습니다.",
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
          name: "strategy_decision",
          status: "pending",
          code: "live_ops_strategy_decision_source_missing",
          message: "실제 strategy/decision 결과를 읽기 전까지 HOLD ready로 표시하지 않습니다.",
        },
      ],
      trace: {
        source: "live_ops_cli_analysis_decision",
        marketDataSourceProfile: marketData.sourceProfile,
        decisionSourceConnected: false,
      },
    };
  }

  return {
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
    orderIntents: [],
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
  };
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
    hasTrade: false,
    hasOrderbook: false,
    riskBlockCount: 0,
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
    return;
  }

  if (event.type === "ORDERBOOK") {
    await persistLiveOpsCliOrderbook(pool, event);
    persisted.orderbookCount += 1;
    state.hasOrderbook = true;
    state.latestHeartbeatAt = event.receivedAt;
    state.referencePrice = new Decimal(event.bids[0].price).plus(event.asks[0].price).div(2).toFixed();
    state.referencePriceSource = "orderbook_mid";
    return;
  }

  await persistLiveOpsCliStatus(pool, event, workerId);
  persisted.statusCount += 1;
  state.latestHeartbeatAt = event.observedAt;
  if (liveOpsMarketDataStatusBlocksNewOrders(event.status)) {
    persisted.riskBlockCount += 1;
    state.riskBlockCount += 1;
  }
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
