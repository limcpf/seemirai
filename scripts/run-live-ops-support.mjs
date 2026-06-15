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
  const liveExecution = evaluateLiveOpsCliLiveExecution({
    config,
    fixtureSmoke: options.fixtureSmoke,
    analysisDecision,
  });
  const reconcilePnlStatus = evaluateLiveOpsCliReconcilePnlStatus({
    config,
    fixtureSmoke: options.fixtureSmoke,
    liveExecution,
  });
  const telegramAlert = evaluateLiveOpsCliTelegramAlert({
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
  const status = input.dbReadiness.ready && input.marketData.ready ? "ready" : "blocked";
  return {
    status,
    message: status === "ready"
      ? (input.fixtureSmoke
        ? "production live ops config/env 계약과 DB readiness를 통과했습니다. fixture smoke는 외부 provider를 호출하지 않습니다."
        : "production live ops config/env, DB readiness, Upbit public market data provider boot를 통과했습니다.")
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
        ? (summary.liveExecution?.ready ? "후보 없음 - broker 제출 없음" : "후속 연결 대기")
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
  if (reconcilePnlStatus?.ready !== true) {
    return "후속 연결 대기";
  }

  return [
    reconcilePnlStatus.statusLabel ?? "상태 요약",
    `대사 ${reconcilePnlStatus.reconcileStatusLabel}`,
    `PnL ${reconcilePnlStatus.pnlStatusLabel}`,
    `open 주문 ${reconcilePnlStatus.openOrderCount}`,
    `provider 호출 ${reconcilePnlStatus.providerProbeAttempted ? "있음" : "0"}`,
  ].join(" / ");
}

function formatTelegramAlertObservation(telegramAlert) {
  if (telegramAlert?.ready !== true) {
    return "후속 연결 대기";
  }

  return [
    telegramAlert.statusLabel ?? "계획 확인",
    `lifecycle ${telegramAlert.lifecycleAlertCount}`,
    `trade ${telegramAlert.tradeAlertCount}`,
    `provider 호출 ${telegramAlert.providerDispatchAttempted ? "있음" : "0"}`,
  ].join(" / ");
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

function evaluateLiveOpsCliLiveExecution({ config, fixtureSmoke, analysisDecision }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke || analysisDecision.ready !== true) {
    return {
      status: "pending",
      ready: false,
      liveOrderCapable: false,
      market,
      latestExecutionAt: null,
      orderIntentCount: analysisDecision.orderIntentCount ?? 0,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      statusLabel: "후속 연결 대기",
      message: "live execution worker는 analysis/decision lifecycle 이후 연결됩니다.",
      checks: [
        {
          name: "analysis_decision",
          status: "blocked",
          code: "live_ops_execution_pending",
          message: "live execution worker가 후속 lifecycle에서 시작됩니다.",
        },
      ],
    };
  }

  return {
    status: "idle",
    ready: true,
    liveOrderCapable: false,
    market,
    latestExecutionAt: null,
    orderIntentCount: analysisDecision.orderIntentCount,
    attemptedOrderCount: 0,
    submittedOrderCount: 0,
    statusLabel: "후보 없음",
    message: "fixture live execution worker가 주문 후보 없음 상태를 확인했고 broker 제출은 발생하지 않았습니다.",
    checks: [
      {
        name: "order_intent",
        status: "ok",
        code: "live_ops_no_order_intent",
        message: "fixture decision tick에는 live execution으로 넘길 주문 후보가 없습니다.",
      },
      {
        name: "broker_submit",
        status: "ok",
        code: "live_ops_broker_submit_skipped",
        message: "fixture smoke에서는 broker 제출 경계를 호출하지 않습니다.",
      },
    ],
  };
}

function evaluateLiveOpsCliReconcilePnlStatus({ config, fixtureSmoke, liveExecution }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

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

function evaluateLiveOpsCliTelegramAlert({ config, fixtureSmoke, liveExecution }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

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

function evaluateLiveOpsCliAnalysisDecision({ config, fixtureSmoke, marketData }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke || marketData.ready !== true) {
    return {
      status: "pending",
      ready: false,
      market,
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
    };
  }

  const latestDecisionAt = new Date().toISOString();
  return {
    status: "ready",
    ready: true,
    market,
    latestDecisionAt,
    decisionCategory: "HOLD",
    featureStatus: "ok",
    evaluatedStrategyCount: 1,
    holdCount: 1,
    blockCount: 0,
    orderIntentCount: 0,
    recordHoldDecision: config.analysis?.record_hold_decision === true,
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
    return;
  }

  if (event.type === "ORDERBOOK") {
    await persistLiveOpsCliOrderbook(pool, event);
    persisted.orderbookCount += 1;
    state.hasOrderbook = true;
    state.latestHeartbeatAt = event.receivedAt;
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
