import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool: PgPool } = pg;
const migrationFilePattern = /^(\d{6})_[a-z0-9_]+\.sql$/u;
const defaultMigrationsDirectory = path.resolve("migrations");
const dbReadinessConnectionTimeoutMs = 5000;
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
  const marketData = evaluateLiveOpsCliMarketData({
    config,
    fixtureSmoke: options.fixtureSmoke,
  });

  if (!dbReadiness.ready) {
    throw new Error(formatCliDbReadinessFailureMessage(dbReadiness));
  }

  return { configPath, envFilePath, config, env, dbReadiness, marketData };
}

export function renderLiveOpsSummary(input) {
  return {
    status: "ready",
    message: "production live ops config/env 계약과 DB readiness를 통과했습니다. 현재 단계는 외부 거래 provider를 호출하지 않습니다.",
    configPath: input.configPath,
    envFilePath: input.envFilePath,
    mode: "소액 실운영",
    liveOrderCapable: false,
    tui: input.tui,
    attach: input.attach ?? null,
    fixtureSmoke: input.fixtureSmoke,
    dbReadiness: input.dbReadiness,
    marketData: input.marketData,
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

export function renderLiveOpsTuiDashboard(summary) {
  const dbReadiness = summary.dbReadiness;
  const migration = dbReadiness?.migration ?? {};
  const workerLines = (summary.trace.workers ?? []).map((worker) => {
    const label = liveOpsWorkerLabels[worker] ?? worker;
    const state = worker === "db_readiness"
      ? (dbReadiness?.ready ? "준비" : "차단")
      : worker === "market_data"
        ? (summary.marketData?.ready ? "DB-backed 저장 확인" : "후속 연결 대기")
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
    "  - Analysis/decision: 후속 연결 대기",
    "  - Live execution: 후속 연결 대기",
    "  - Telegram alert: 후속 연결 대기",
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

function evaluateLiveOpsCliMarketData({ config, fixtureSmoke }) {
  const market = config.universe?.default_market ?? "KRW-BTC";

  if (!fixtureSmoke) {
    return {
      status: "pending",
      ready: false,
      provider: "UPBIT_PUBLIC",
      market,
      sourceProfile: "upbit_public",
      message: "market data collector는 provider lifecycle 연결 전입니다.",
      latestHeartbeatAt: null,
      persisted: emptyMarketDataPersistenceSummary(),
      checks: [
        {
          name: "event_source",
          status: "blocked",
          code: "live_ops_market_data_provider_pending",
          message: "Upbit public market data provider 연결이 후속 lifecycle에서 시작됩니다.",
        },
      ],
    };
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
