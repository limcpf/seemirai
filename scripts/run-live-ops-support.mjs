import { readFile } from "node:fs/promises";
import path from "node:path";

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

  return { configPath, envFilePath, config, env };
}

export function renderLiveOpsSummary(input) {
  return {
    status: "ready",
    message: "production live ops config/env 계약을 통과했습니다. Sub PR 01 skeleton은 외부 provider를 호출하지 않습니다.",
    configPath: input.configPath,
    envFilePath: input.envFilePath,
    mode: "소액 실운영",
    liveOrderCapable: false,
    tui: input.tui,
    attach: input.attach ?? null,
    fixtureSmoke: input.fixtureSmoke,
    trace: {
      rawMode: input.config.mode,
      defaultMarket: input.config.universe?.default_market,
      workers: Object.keys(input.config.workers ?? {}).filter((key) => input.config.workers[key] === true),
    },
  };
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printHelp(commandName) {
  process.stdout.write(`${commandName}

Usage:
  corepack pnpm ${commandName} -- --config <path> --env-file <path> [--tui] [--fixture-smoke]

Options:
  --config <path>      Secret 없는 production live ops JSON config
  --env-file <path>    DB/Upbit/Telegram/TUI credential 전용 env file
  --tui                foreground TUI skeleton render
  --fixture-smoke      외부 provider 호출 없이 config/env contract만 검증
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

function readValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}
