#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-live-ops-real-arm-closeout");
const runGuardEnv = "SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT";
const expectedIssue = 206;
const expectedMode = "LIVE_AUTONOMOUS_SMALL_BUDGET";
const expectedMarket = "KRW-BTC";
const expectedSide = "BUY";
const expectedOrderType = "LIMIT";
const expectedTimeInForce = "POST_ONLY";
const minRequestedNotionalKrw = 5_000;
const maxRequestedNotionalKrw = 10_000;
const maxArtifactEvidenceDepth = 32;
const invocationCwd = process.cwd();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredKeyScopes = ["자산조회", "주문조회", "주문하기"];
const requiredSourceScanPaths = ["src", "scripts", "config", "docs"];
const requiredLiveOpsEnvNames = [
  "SEEMIRAI_DATABASE_URL",
  "SEEMIRAI_UPBIT_ACCESS_KEY",
  "SEEMIRAI_UPBIT_SECRET_KEY",
  "SEEMIRAI_UPBIT_KEY_SCOPE",
  "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID",
  "SEEMIRAI_TELEGRAM_BOT_TOKEN",
  "SEEMIRAI_TELEGRAM_CHAT_ID",
  "SEEMIRAI_TUI_CONTROL_TOKEN",
];
const liveOpsLegacyEnvNames = [
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
const requiredUnsafeSourceScanPatterns = [
  { label: "ord_type", pattern: /ord_type/u },
  { label: "market order", pattern: /market/u },
  { label: "korean market order", pattern: /시장가/u },
  { label: "best order", pattern: /best/u },
  { label: "withdrawal", pattern: /withdraw/u },
  { label: "korean withdrawal", pattern: /출금/u },
  { label: "deposit", pattern: /deposit/u },
  { label: "korean deposit", pattern: /입금/u },
  { label: "leverage", pattern: /leverage/u },
  { label: "futures", pattern: /futures/u },
  { label: "margin", pattern: /margin/u },
];
const requiredSecretSourceScanPatterns = [
  { label: "access key", pattern: /access_key/u },
  { label: "camelCase access key", pattern: /accessKey/u },
  { label: "uppercase access key env", pattern: /ACCESS_KEY/u },
  { label: "secret key", pattern: /secret_key/u },
  { label: "camelCase secret key", pattern: /secretKey/u },
  { label: "uppercase secret key env", pattern: /SECRET_KEY/u },
  { label: "authorization header", pattern: /Authorization/u },
  { label: "lowercase authorization header", pattern: /authorization/u },
  { label: "bearer token", pattern: /Bearer/u },
  { label: "lowercase bearer token", pattern: /bearer/u },
  { label: "uppercase jwt", pattern: /JWT/u },
  { label: "lowercase jwt", pattern: /jwt/u },
  { label: "telegram token", pattern: /telegram_bot_token/u },
  { label: "telegram botToken", pattern: /botToken/u },
  { label: "uppercase telegram token env", pattern: /TELEGRAM_BOT_TOKEN/u },
  { label: "tui control token env", pattern: /SEEMIRAI_TUI_CONTROL_TOKEN/u },
  { label: "tui control token camelCase", pattern: /tuiControlToken/u },
  { label: "tui control token snake_case", pattern: /tui_control_token/u },
  { label: "database url env", pattern: /DATABASE_URL/u },
  { label: "database password camelCase", pattern: /databasePassword/u },
  { label: "database password snake_case", pattern: /database_password/u },
  { label: "db password", pattern: /db_password/u },
  { label: "pg password", pattern: /pg_password/u },
  { label: "raw provider payload", pattern: /raw_provider/u },
  { label: "raw provider payload camelCase", pattern: /rawProvider/u },
  { label: "raw order payload", pattern: /raw_order/u },
  { label: "raw order payload camelCase", pattern: /rawOrder/u },
  { label: "raw update payload", pattern: /raw_update/u },
  { label: "raw update payload camelCase", pattern: /rawUpdate/u },
];
const disallowedRipgrepLongOptions = new Set([
  "--line-regexp",
  "--file",
  "--files",
  "--files-with-matches",
  "--files-without-match",
  "--fixed-strings",
  "--count",
  "--count-matches",
  "--engine",
  "--ignore",
  "--ignore-file",
  "--iglob",
  "--invert-match",
  "--max-depth",
  "--max-filesize",
  "--max-columns",
  "--max-count",
  "--no-hidden",
  "--no-filename",
  "--no-line-number",
  "--pcre2",
  "--pcre2-version",
  "--pre",
  "--pre-glob",
  "--quiet",
  "--replace",
  "--stop-on-nonmatch",
  "--type",
  "--type-list",
  "--type-not",
  "--word-regexp",
]);
const disallowedRipgrepShortOptions = new Set(["F", "I", "L", "M", "N", "P", "T", "c", "d", "f", "l", "m", "q", "r", "t", "v", "w", "x"]);
const ripgrepOptionsWithNextValue = new Set([
  "--after-context",
  "--before-context",
  "--color",
  "--colors",
  "--context",
  "--engine",
  "--context-separator",
  "--file",
  "--field-context-separator",
  "--field-match-separator",
  "--glob",
  "--ignore-file",
  "--iglob",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--replace",
  "--sort",
  "--sortr",
  "--type",
  "--type-not",
]);
const ripgrepShortOptionsWithNextValue = new Set(["A", "B", "C", "M", "d", "f", "g", "m", "r", "t"]);
const withdrawalScopeMarkers = ["출금", "withdraw"];
const forbiddenKeyScopeMarkers = ["출금", "입금", "withdraw", "deposit", "futures", "leverage", "margin"];
const requiredCounterNames = [
  "crashCount",
  "unhandledRejectionCount",
  "duplicateOrderCount",
  "reconcileMismatchCount",
  "untrackedFillCount",
  "liveOrderCleanupFailureCount",
];
const sensitivePatterns = [
  { label: "access_key json field", pattern: /"(?:seemirai_)?(?:upbit_)?access_key"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "accessKey json field", pattern: /"(?:upbit)?accessKey"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "secret_key json field", pattern: /"(?:seemirai_)?(?:upbit_)?secret_key"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "secretKey json field", pattern: /"(?:upbit)?secretKey"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "hyphenated credential json field", pattern: /"(?:seemirai-)?(?:upbit-)?(?:access-key|secret-key|telegram-bot-token|tui-control-token)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "seemirai camelCase credential json field", pattern: /"seemirai(?:Upbit)?(?:AccessKey|SecretKey|TelegramBotToken|TuiControlToken)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "telegram token json field", pattern: /"(?:seemirai_)?telegram_bot_token"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "telegram botToken json field", pattern: /"(?:telegram)?botToken"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "tui control token json field", pattern: /"(?:tuiControlToken|tui_control_token|seemirai_tui_control_token)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "generic token json field", pattern: /"token"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "telegram bot token url", pattern: /https:\/\/api\.telegram\.org\/bot(?!<redacted>|redacted|\[redacted\])[^/\s"']{8,}(?:\/[A-Za-z]+)?/i },
  { label: "telegram bot token url placeholder tail", pattern: /https:\/\/api\.telegram\.org\/bot(?:<redacted>|redacted|\[redacted\])(?=[^/\s"'])[^/\s"']*/i },
  { label: "database url json field", pattern: /"(?:databaseUrl|database_url|seemirai_database_url)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "database password json field", pattern: /"(?:databasePassword|database_password|dbPassword|db_password|pgPassword|pg_password|password)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "query hash json field", pattern: /"(?:queryHash|query_hash)"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "credential decoded field", pattern: /\b(?:access_key|accessKey|access-key|secret_key|secretKey|secret-key|telegram_bot_token|telegram-bot-token|botToken|tuiControlToken|tui_control_token|tui-control-token|seemirai(?:Upbit)?(?:AccessKey|SecretKey|TelegramBotToken|TuiControlToken)|databaseUrl|database_url|database-url|databasePassword|database_password|database-password|dbPassword|db_password|db-password|pgPassword|pg_password|pg-password|password|token|authorization|jwt|queryHash|query_hash)\s*:\s*(?!["']?(?:<redacted>|redacted|\[redacted\])["']?(?:\s|$|[,}\]]))[^\r\n]{8,}/i },
  { label: "credential decoded placeholder tail", pattern: /\b(?:access_key|accessKey|access-key|secret_key|secretKey|secret-key|telegram_bot_token|telegram-bot-token|botToken|tuiControlToken|tui_control_token|tui-control-token|seemirai(?:Upbit)?(?:AccessKey|SecretKey|TelegramBotToken|TuiControlToken)|databaseUrl|database_url|database-url|databasePassword|database_password|database-password|dbPassword|db_password|db-password|pgPassword|pg_password|pg-password|password|token|authorization|jwt|queryHash|query_hash)\s*:\s*["']?(?:<redacted>|redacted|\[redacted\])["']?(?:\s+|[,;:\[{])\s*[^\s"',;}\]]{4,}/i },
  { label: "raw payload decoded field", pattern: /\b(?:rawProvider(?:Payload|Body)?|rawOrder(?:Detail|Payload)?|rawUpdate(?:Payload|Body)?|raw(?:_|-)?provider(?:(?:_|-)?(?:payload|body))?|raw(?:_|-)?order(?:(?:_|-)?(?:detail|payload))?|raw(?:_|-)?update(?:(?:_|-)?(?:payload|body))?)\s*:/i },
  { label: "access key env assignment", pattern: /\b(?:SEEMIRAI_)?(?:UPBIT_)?ACCESS_KEY\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "secret key env assignment", pattern: /\b(?:SEEMIRAI_)?(?:UPBIT_)?SECRET_KEY\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "telegram token env assignment", pattern: /\b(?:SEEMIRAI_)?TELEGRAM_BOT_TOKEN\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "tui control token env assignment", pattern: /\b(?:SEEMIRAI_)?TUI_CONTROL_TOKEN\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "database url env assignment", pattern: /\b(?:SEEMIRAI_)?DATABASE_URL\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "database password env assignment", pattern: /\b(?:SEEMIRAI_)?(?:DATABASE_PASSWORD|POSTGRES_PASSWORD|DB_PASSWORD|PGPASSWORD)\s*[:=]\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:$|[\r\n,}]))[^\r\n,}]{8,}/i },
  { label: "credential env placeholder tail", pattern: /\b(?:SEEMIRAI_)?(?:(?:UPBIT_)?(?:ACCESS_KEY|SECRET_KEY)|TELEGRAM_BOT_TOKEN|TUI_CONTROL_TOKEN|DATABASE_URL|DATABASE_PASSWORD|POSTGRES_PASSWORD|DB_PASSWORD|PGPASSWORD)\s*[:=]\s*["']?(?:<redacted>|redacted|\[redacted\])["']?[,;:\[{]\s*[^"'\s,;}\]]{4,}/i },
  { label: "credential env placeholder json tail", pattern: /\b(?:SEEMIRAI_)?(?:(?:UPBIT_)?(?:ACCESS_KEY|SECRET_KEY)|TELEGRAM_BOT_TOKEN|TUI_CONTROL_TOKEN|DATABASE_URL|DATABASE_PASSWORD|POSTGRES_PASSWORD|DB_PASSWORD|PGPASSWORD)\s*[:=]\s*["']?(?:<redacted>|redacted|\[redacted\])["']?\s*[,;]\s*(?:\{|\[)/i },
  { label: "raw authorization bearer", pattern: /authorization:\s*bearer\s+(?!<redacted>|redacted|\[redacted\])[^\s"']+/i },
  { label: "standalone bearer token", pattern: /\bBearer\s+(?!(?:<redacted>|redacted|\[redacted\])(?:\s|$))[^\s"']{16,}/i },
  { label: "bearer placeholder tail", pattern: /\bBearer\s+(?:<redacted>|redacted|\[redacted\])(?:\s+|[,;:\[{])\s*[^\s"']+/i },
  { label: "jwt env assignment", pattern: /\bJWT\s*=\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:\s|$|["',]))[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { label: "raw jwt compact token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i },
  { label: "authorization json field", pattern: /"authorization"\s*:\s*"(?!bearer\s+(?:<redacted>|redacted|\[redacted\])"|(?:<redacted>|redacted|\[redacted\])")[^"]{8,}"/i },
  { label: "jwt json field", pattern: /"jwt"\s*:\s*"(?!\s*(?:<redacted>|redacted|\[redacted\])\s*")[^"]{8,}"/i },
  { label: "postgres url", pattern: /postgres(?:ql)?:\/\/(?!(?:<redacted>|redacted|\[redacted\])(?:$|[\/\s"']))[^\s"']+/i },
  { label: "postgres credential url", pattern: /postgres(?:ql)?:\/\/[^:\s"']+:(?!(?:<redacted>|redacted|\[redacted\])@)[^@\s"']+@/i },
  { label: "raw provider camelCase field", pattern: /"rawProvider(?:Payload|Body)?"\s*:/ },
  { label: "raw order camelCase field", pattern: /"rawOrder(?:Detail|Payload)?"\s*:/ },
  { label: "raw provider field", pattern: /"raw(?:_|-)?provider(?:(?:_|-)?(?:payload|body))?"\s*:/i },
  { label: "raw order field", pattern: /"raw(?:_|-)?order(?:(?:_|-)?(?:detail|payload))?"\s*:/i },
  { label: "raw provider string payload", pattern: /\b(?:rawProvider(?:Payload|Body)?|raw(?:_|-)?provider(?:(?:_|-)?(?:payload|body))?)\s*[:=]\s*(?!(?:<redacted>|redacted|\[redacted\])(?:\s|$))(?:\{|\[|[A-Za-z0-9_-]{4,})/i },
  { label: "raw order string payload", pattern: /\b(?:rawOrder(?:Detail|Payload)?|raw(?:_|-)?order(?:(?:_|-)?(?:detail|payload))?)\s*[:=]\s*(?!(?:<redacted>|redacted|\[redacted\])(?:\s|$))(?:\{|\[|[A-Za-z0-9_-]{4,})/i },
  { label: "raw update string payload", pattern: /\b(?:rawUpdate(?:Payload|Body)?|raw(?:_|-)?update(?:(?:_|-)?(?:payload|body))?)\s*[:=]\s*(?!(?:<redacted>|redacted|\[redacted\])(?:\s|$))(?:\{|\[|[A-Za-z0-9_-]{4,})/i },
  { label: "raw provider placeholder tail", pattern: /\b(?:rawProvider(?:Payload|Body)?|raw(?:_|-)?provider(?:(?:_|-)?(?:payload|body))?)\s*[:=]\s*["']?(?:<redacted>|redacted|\[redacted\])["']?(?:\s+|[,;:\[{])\s*(?:\{|\[|[^\s"']+)/i },
  { label: "raw order placeholder tail", pattern: /\b(?:rawOrder(?:Detail|Payload)?|raw(?:_|-)?order(?:(?:_|-)?(?:detail|payload))?)\s*[:=]\s*["']?(?:<redacted>|redacted|\[redacted\])["']?(?:\s+|[,;:\[{])\s*(?:\{|\[|[^\s"']+)/i },
  { label: "raw update placeholder tail", pattern: /\b(?:rawUpdate(?:Payload|Body)?|raw(?:_|-)?update(?:(?:_|-)?(?:payload|body))?)\s*[:=]\s*["']?(?:<redacted>|redacted|\[redacted\])["']?(?:\s+|[,;:\[{])\s*(?:\{|\[|[^\s"']+)/i },
  { label: "raw update field", pattern: /"raw(?:_|-)?update"\s*:/i },
];

try {
  await main();
} catch (error) {
  const options = parseArgsForFailure(process.argv.slice(2));
  const summary = await writeFailureSummary(error, options);
  printSummary(summary, options);
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
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });

  if (options.fixtureSmoke) {
    const fixture = await writeFixtureManifest(artifactDir);
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
        runGuard: skippedCheck("Issue #206 live:ops 실거래 closeout guard가 꺼져 있어 주문 artifact 검증을 실행하지 않았다.", {
          requiredEnv: `${runGuardEnv}=1`,
        }),
        operatorInputs: skippedCheck("저장소 밖 운영 config/env/evidence 경로가 확인되지 않아 실제 submit/cancel cleanup을 시작하지 않았다.", {
          requiredInputs: ["--manifest", "operator arm evidence", "config path", "env file path", "redacted artifact path"],
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
    inputMode: "real_arm_closeout_manifest",
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
      ? okCheck("명시 env guard가 확인되어 Issue #206 live:ops 실거래 closeout manifest 검증을 시작한다.", {
          requiredEnv: `${runGuardEnv}=1`,
        })
      : okCheck("fixture smoke는 live/API guard를 열지 않고 결정적 manifest만 검증한다.", { fixtureSmoke: true }),
  };

  if (!hasText(input.manifestPath)) {
    checks.manifestInput = failCheck("Issue #206 closeout manifest 경로가 필요하다.", { requiredArg: "--manifest" });
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

  const manifestFile = await readJsonFile(input.manifestPath, invocationCwd);
  checks.manifestInput = createManifestInputCheck(manifestFile, input.guarded);

  let metrics = createEmptyMetrics();
  if (manifestFile.error === undefined && isRecord(manifestFile.value)) {
    const validation = await validateManifest(manifestFile.value, manifestFile.filePath, manifestFile.rawText, {
      guarded: input.guarded,
    });
    Object.assign(checks, validation.checks);
    metrics = validation.metrics;
  } else if (manifestFile.error === undefined) {
    checks.manifestShape = failCheck("Issue #206 closeout manifest는 JSON object여야 한다.", {
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

async function validateManifest(manifest, manifestPath, manifestRawText, options) {
  const run = readRecord(manifest.run);
  const counters = readRecord(manifest.counters);
  const sourceScan = readRecord(manifest.sourceScan);
  const artifactPaths = readStringArray(manifest.artifactPaths);
  const artifactFiles = await readArtifactFiles(artifactPaths, path.dirname(manifestPath));
  const metrics = createMetrics(run, counters);
  return {
    metrics,
    checks: {
      manifestShape: createManifestShapeCheck(manifest),
      guardedArtifactInput: createGuardedArtifactInputCheck(manifest, manifestRawText, manifestPath, artifactFiles, options.guarded),
      operatorInputs: await createOperatorInputsCheck(manifest, path.dirname(manifestPath), options.guarded),
      artifactFiles: createArtifactFilesCheck(artifactFiles, manifest, run, counters),
      orderPolicy: createOrderPolicyCheck(run),
      orderLifecycle: createOrderLifecycleCheck(run),
      reconcileCloseout: createReconcileCloseoutCheck(manifest, run),
      closeoutZeroCounters: createZeroCounterCheck(counters),
      telegramTuiEvidence: createTelegramTuiEvidenceCheck(manifest),
      sourceSecurityScan: createSourceSecurityScanCheck(sourceScan, { guarded: options.guarded }),
      redactionScan: createRedactionScanCheck([
        { label: "manifest", rawText: manifestRawText, decodedText: collectJsonStringText(manifest) },
        ...artifactFiles.map((file, index) => ({ label: `artifact-${index + 1}`, rawText: file.rawText, decodedText: collectJsonStringText(file.value) })),
      ]),
      readinessAudit: createReadinessAuditCheck(manifest),
    },
  };
}

function createManifestInputCheck(manifestFile, guarded) {
  if (manifestFile.error !== undefined) {
    return failCheck("Issue #206 closeout manifest를 파싱하지 못했다.", {
      manifestPath: manifestFile.filePath,
      realPath: manifestFile.realPath ?? null,
      error: manifestFile.error,
    });
  }
  if (guarded && !manifestFile.outsideRepository) {
    return failCheck("guarded Issue #206 closeout manifest는 realpath 기준 저장소 밖에 있어야 한다.", {
      manifestPath: manifestFile.filePath,
      realPath: manifestFile.realPath,
    });
  }
  return okCheck("Issue #206 closeout manifest를 파싱했다.", {
    manifestPath: manifestFile.filePath,
    realPath: manifestFile.realPath,
    outsideRepository: manifestFile.outsideRepository,
  });
}

function createManifestShapeCheck(manifest) {
  const command = readString(manifest.command);
  const configPath = readString(manifest.configPath);
  const envFilePath = readString(manifest.envFilePath);
  const actual = {
    issue: manifest.issue,
    mode: manifest.mode,
    command,
    configPathAbsolute: hasText(configPath) ? path.isAbsolute(configPath) : false,
    envFilePathAbsolute: hasText(envFilePath) ? path.isAbsolute(envFilePath) : false,
    commandValid: isLiveOpsCommand(command, configPath, envFilePath),
  };
  if (manifest.issue === expectedIssue && manifest.mode === expectedMode && actual.commandValid) {
    return okCheck("Issue #206 closeout manifest가 issue/mode/command contract를 만족한다.", actual);
  }

  return failCheck("Issue #206 closeout manifest issue/mode/command contract가 맞지 않는다.", {
    expected: { issue: expectedIssue, mode: expectedMode, command: "corepack pnpm live:ops ..." },
    actual,
  });
}

function createGuardedArtifactInputCheck(manifest, manifestRawText, manifestPath, artifactFiles, guarded) {
  if (!guarded) {
    return okCheck("fixture smoke는 guarded 운영 artifact 입력 검사를 열지 않는다.", { fixtureSmoke: true });
  }

  const fixtureMarkers = [
    manifest.fixture === true ? "manifest.fixture" : undefined,
    manifestPath.includes(".fixture") ? "manifest path" : undefined,
    hasRawFixtureMarkerText(manifestRawText) || hasDecodedFixtureMarkerValue(manifest) ? "manifest marker" : undefined,
    ...artifactFiles
      .filter((file) => file.filePath.includes(".fixture")
        || hasRawFixtureMarkerText(file.rawText)
        || hasDecodedFixtureMarkerValue(file.value))
      .map((file) => file.filePath),
  ].filter(hasText);

  if (fixtureMarkers.length === 0) {
    return okCheck("guarded closeout 입력이 fixture manifest/artifact를 사용하지 않는다.", { guarded: true });
  }

  return failCheck("guarded Issue #206 closeout에서는 fixture manifest/artifact를 사용할 수 없다.", { fixtureMarkers });
}

function hasRawFixtureMarkerText(value) {
  return /"(?:fixture|fixtureSmoke|fixture_smoke)"\s*:\s*true/i.test(value)
    || /"kind"\s*:\s*"[^"]*FIXTURE[^"]*"/i.test(value)
    || /\bfixture_smoke\b/i.test(value)
    || /\bfixture smoke\b/i.test(value);
}

function hasDecodedFixtureMarkerValue(value) {
  if (typeof value === "string") {
    return /\bfixture_smoke\b/i.test(value) || /\bfixture smoke\b/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasDecodedFixtureMarkerValue(item));
  }
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, child]) => {
    if (/^(?:fixture|fixtureSmoke|fixture_smoke)$/u.test(key)) {
      return child === true;
    }
    if (key === "kind" && typeof child === "string") {
      return /(?:^|[^A-Za-z0-9])FIXTURE(?:$|[^A-Za-z0-9])/i.test(child);
    }
    // fixture라는 단어가 경로에 포함될 수 있어, 운영 차단은 명시적 smoke marker나 kind 필드로 한정한다.
    return hasDecodedFixtureMarkerValue(child);
  });
}

async function createOperatorInputsCheck(manifest, baseDir, guarded) {
  if (!guarded) {
    return okCheck("fixture smoke는 실제 운영 config/env/key scope 입력 검사를 열지 않는다.", { fixtureSmoke: true });
  }

  const configPath = readString(manifest.configPath);
  const envFilePath = readString(manifest.envFilePath);
  const artifactPaths = readStringArray(manifest.artifactPaths);
  const keyScopeEvidence = createKeyScopeEvidence(manifest);
  const fileStatuses = await Promise.all([
    createFileStatus("configPath", configPath, baseDir),
    createFileStatus("envFilePath", envFilePath, baseDir),
  ]);
  const configStatus = fileStatuses.find((file) => file.name === "configPath");
  const envFileStatus = fileStatuses.find((file) => file.name === "envFilePath");
  const productionContract = await createProductionInputContract(configStatus, envFileStatus, readString(manifest.keyScopeEvidenceId));
  const missing = [
    ["configPath", configPath],
    ["envFilePath", envFilePath],
    ["operatorArmEvidenceId", readString(manifest.operatorArmEvidenceId)],
    ["keyScopeEvidenceId", readString(manifest.keyScopeEvidenceId)],
  ].filter(([, value]) => !hasText(value)).map(([name]) => name);
  const pathShapeViolations = [
    ["configPath", configPath],
    ["envFilePath", envFilePath],
  ]
    .filter(([, value]) => hasText(value) && !path.isAbsolute(value))
    .map(([name, value]) => ({ name, value, expected: "absolute path recorded in live:ops command" }));
  const pathViolations = fileStatuses
    .filter((file) => file.exists && !file.outsideRepository)
    .map((file) => ({ name: file.name, value: file.value, realPath: file.realPath }));
  const missingFiles = fileStatuses.filter((file) => !file.exists || !file.isFile);

  if (missing.length === 0
    && artifactPaths.length > 0
    && pathShapeViolations.length === 0
    && pathViolations.length === 0
    && missingFiles.length === 0
    && keyScopeEvidence.ok
    && productionContract.ok) {
    return okCheck("운영자가 지정한 저장소 밖 config/env/evidence 경로가 closeout manifest에 연결됐다.", {
      configPath,
      envFilePath,
      artifactCount: artifactPaths.length,
      files: fileStatuses,
      keyScope: keyScopeEvidence.evidence,
      productionContract: productionContract.evidence,
    });
  }

  return failCheck("운영 config/env/evidence 입력이 부족하거나 저장소 내부 경로를 가리킨다.", {
    missing: artifactPaths.length === 0 ? [...missing, "artifactPaths"] : missing,
    pathShapeViolations,
    pathViolations,
    missingFiles,
    keyScope: keyScopeEvidence.evidence,
    productionContract: productionContract.evidence,
  });
}

function createArtifactFilesCheck(artifactFiles, manifest, run, counters) {
  const unreadable = artifactFiles
    .filter((file) => file.error !== undefined)
    .map((file) => ({ filePath: file.filePath, error: file.error }));
  const pathViolations = artifactFiles
    .filter((file) => file.error === undefined && !file.outsideRepository)
    .map((file) => ({ filePath: file.filePath, realPath: file.realPath }));
  const artifactConflicts = createArtifactManifestConflicts(artifactFiles, manifest, run, counters);

  if (artifactFiles.length > 0 && unreadable.length === 0 && pathViolations.length === 0 && artifactConflicts.length === 0) {
    return okCheck("closeout manifest가 가리키는 redacted artifact 파일을 모두 읽었다.", {
      artifactCount: artifactFiles.length,
      realPathChecked: true,
    });
  }

  return failCheck("closeout manifest의 redacted artifact 파일을 읽지 못했다.", {
    artifactCount: artifactFiles.length,
    unreadable,
    pathViolations,
    artifactConflicts,
  });
}

function createOrderPolicyCheck(run) {
  const requestedNotionalKrw = Number(readStringOrNumber(run.requestedNotionalKrw));
  // 운영 manifest의 alias 충돌은 실제 주문 정책을 모호하게 만들므로 모든 표기를 같은 정책 값으로 검증한다.
  const orderTypeValues = readStringAliasValues(run, ["orderType", "order_type", "ord_type"])
    .map((actual) => ({ alias: actual.alias, value: actual.value.toUpperCase() }));
  const invalidOrderTypeValues = orderTypeValues.filter((actual) => actual.value !== expectedOrderType);
  const timeInForceValues = readStringAliasValues(run, ["timeInForce", "time_in_force"])
    .map((actual) => ({ alias: actual.alias, value: normalizeTimeInForce(actual.value) }));
  const invalidTimeInForceValues = timeInForceValues.filter((actual) => actual.value !== expectedTimeInForce);
  const actual = {
    market: readString(run.market),
    side: readString(run.side),
    orderType: readString(run.orderType),
    orderTypeValues,
    timeInForce: normalizeTimeInForce(readString(run.timeInForce)),
    timeInForceValues,
    requestedNotionalKrw,
  };
  const ok = actual.market === expectedMarket
    && actual.side === expectedSide
    && actual.orderType === expectedOrderType
    && orderTypeValues.length > 0
    && invalidOrderTypeValues.length === 0
    && timeInForceValues.length > 0
    && invalidTimeInForceValues.length === 0
    && actual.timeInForce === expectedTimeInForce
    && Number.isFinite(requestedNotionalKrw)
    && requestedNotionalKrw >= minRequestedNotionalKrw
    && requestedNotionalKrw <= maxRequestedNotionalKrw;

  if (ok) {
    return okCheck("실거래 cleanup 주문이 KRW-BTC 단일 BUY LIMIT post_only 소액 상한을 만족한다.", actual);
  }

  return failCheck("실거래 cleanup 주문 정책이 Issue #206 허용 범위를 벗어난다.", {
    expected: {
      market: expectedMarket,
      side: expectedSide,
      orderType: expectedOrderType,
      timeInForce: expectedTimeInForce,
      minRequestedNotionalKrw,
      maxRequestedNotionalKrw,
    },
    actual: { ...actual, invalidOrderTypeValues, invalidTimeInForceValues },
  });
}

function createOrderLifecycleCheck(run) {
  const submittedAtMs = readTimestampMs(run.submittedAt);
  const cancelRequestedAtMs = readTimestampMs(run.cancelRequestedAt);
  const terminalCancelConfirmedAtMs = readTimestampMs(run.terminalCancelConfirmedAt);
  const terminalState = normalizeTerminalState(readString(run.terminalState));
  const sameChain = hasSameOrderChain(run);
  const nowMs = Date.now();
  const timestampsNotFuture = [submittedAtMs, cancelRequestedAtMs, terminalCancelConfirmedAtMs]
    .every((timestampMs) => timestampMs !== undefined && timestampMs <= nowMs);
  const ok = submittedAtMs !== undefined
    && cancelRequestedAtMs !== undefined
    && terminalCancelConfirmedAtMs !== undefined
    && submittedAtMs <= cancelRequestedAtMs
    && cancelRequestedAtMs <= terminalCancelConfirmedAtMs
    && timestampsNotFuture
    && terminalState === "CANCEL"
    && sameChain;

  if (ok) {
    return okCheck("submit -> cancel requested -> terminal cancel evidence가 같은 주문 chain으로 이어진다.", {
      submittedAt: run.submittedAt,
      cancelRequestedAt: run.cancelRequestedAt,
      terminalCancelConfirmedAt: run.terminalCancelConfirmedAt,
      terminalState,
      sameChain,
      timestampsNotFuture,
    });
  }

  return failCheck("submit/cancel/terminal cancel lifecycle evidence가 부족하거나 순서가 맞지 않는다.", {
    submittedAt: run.submittedAt ?? null,
    cancelRequestedAt: run.cancelRequestedAt ?? null,
    terminalCancelConfirmedAt: run.terminalCancelConfirmedAt ?? null,
    terminalState,
    sameChain,
    timestampsNotFuture,
  });
}

function createReconcileCloseoutCheck(manifest, run) {
  const reconcile = readRecord(manifest.reconcile);
  const values = {
    "run.openExposureKrw": readNumber(run.openExposureKrw),
    "run.openOrderCount": readNumber(run.openOrderCount),
    "run.reconcileMismatchCount": readNumber(run.reconcileMismatchCount),
    "run.untrackedFillCount": readNumber(run.untrackedFillCount),
    "run.manualReviewCount": readNumber(run.manualReviewCount),
    "reconcile.openExposureKrw": readNumber(reconcile.openExposureKrw),
    "reconcile.openOrderCount": readNumber(reconcile.openOrderCount),
    "reconcile.mismatchCount": readNumber(reconcile.mismatchCount),
    "reconcile.untrackedFillCount": readNumber(reconcile.untrackedFillCount),
    "reconcile.manualReviewCount": readNumber(reconcile.manualReviewCount),
  };
  const ok = Object.values(values).every((value) => value === 0);

  if (ok) {
    return okCheck("terminal cancel 이후 open exposure/reconcile/manual review가 모두 0으로 닫혔다.", values);
  }

  return failCheck("terminal cancel 이후 open exposure/reconcile/manual review가 남아 있다.", values);
}

function createZeroCounterCheck(counters) {
  const values = Object.fromEntries(requiredCounterNames.map((name) => [name, readNumber(counters[name])]));
  const missing = Object.entries(values).filter(([, value]) => value === undefined).map(([name]) => name);
  const nonZero = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== 0)
    .map(([name, value]) => ({ name, value }));

  if (missing.length === 0 && nonZero.length === 0) {
    return okCheck("closeout failure counter가 모두 0이다.", values);
  }

  return failCheck("closeout failure counter가 누락되었거나 0이 아니다.", { values, missing, nonZero });
}

function createTelegramTuiEvidenceCheck(manifest) {
  const telegram = readRecord(manifest.telegram);
  const evidence = readRecord(telegram.evidenceIds);
  const requiredTelegram = ["startup", "liveOrderCapable", "orderSubmitted", "cancelRequested", "cancelConfirmed"];
  const missingTelegram = requiredTelegram.filter((name) => !hasText(readString(evidence[name])));
  const tuiEvidenceId = readString(readRecord(manifest.tui).evidenceId);

  if (missingTelegram.length === 0 && hasText(tuiEvidenceId)) {
    return okCheck("Telegram lifecycle와 TUI 상태 evidence가 closeout manifest에 연결됐다.", {
      telegramEvidenceCount: requiredTelegram.length,
      tuiEvidenceId,
    });
  }

  return failCheck("Telegram lifecycle 또는 TUI 상태 evidence가 부족하다.", {
    missingTelegram,
    tuiEvidenceId: tuiEvidenceId ?? null,
  });
}

function createSourceSecurityScanCheck(sourceScan, options) {
  const unsafeMatches = readArray(sourceScan.unsafeMatches);
  const secretMatches = readArray(sourceScan.secretMatches);
  const commands = readStringArray(sourceScan.commands);
  const status = readString(sourceScan.status);
  const locationEvidence = createSourceScanLocationEvidence(sourceScan, options);
  const evidenceShapeOk = commands.length > 0
    && Array.isArray(sourceScan.unsafeMatches)
    && Array.isArray(sourceScan.secretMatches);
  const commandEvidence = options.guarded
    ? createSourceScanCommandEvidence(commands)
    : { ok: true, fixtureSmoke: true };
  const ok = status === "passed"
    && evidenceShapeOk
    && commandEvidence.ok
    && locationEvidence.ok
    && unsafeMatches.length === 0
    && secretMatches.length === 0;

  if (ok) {
    return okCheck("source/security scan이 금지 주문 경계와 secret/raw payload 후보를 새로 열지 않았다고 기록했다.", {
      status,
      commandCount: commands.length,
      commandEvidence,
      locationEvidence,
    });
  }

  return failCheck("source/security scan 결과가 없거나 금지 후보가 남아 있다.", {
    status: status ?? null,
    commandCount: commands.length,
    evidenceShapeOk,
    commandEvidence,
    locationEvidence,
    unsafeMatches: summarizeSourceScanMatches(unsafeMatches),
    secretMatches: summarizeSourceScanMatches(secretMatches),
  });
}

function summarizeSourceScanMatches(matches) {
  return {
    count: matches.length,
    entries: matches.map((match) => {
      if (!isRecord(match)) {
        return { type: typeof match };
      }
      return {
        path: readString(match.path) ?? readString(match.filePath) ?? readString(match.file) ?? null,
        line: readNumber(match.line) ?? readNumber(match.lineNumber) ?? null,
        label: sanitizeSourceScanMatchLabel(readString(match.label) ?? readString(match.kind) ?? readString(match.patternLabel)),
      };
    }),
  };
}

function sanitizeSourceScanMatchLabel(label) {
  if (!hasText(label)) {
    return null;
  }
  const allowedLabels = new Set([
    ...requiredUnsafeSourceScanPatterns.map((requirement) => requirement.label),
    ...requiredSecretSourceScanPatterns.map((requirement) => requirement.label),
  ]);
  return allowedLabels.has(label) ? label : "[redacted-label]";
}

function createSourceScanLocationEvidence(sourceScan, options) {
  if (!options.guarded) {
    return { ok: true, fixtureSmoke: true };
  }
  const cwd = readString(sourceScan.cwd) ?? readString(sourceScan.workingDirectory);
  const declaredRepositoryRoot = readString(sourceScan.repositoryRoot);
  const cwdMatches = hasText(cwd) && path.resolve(cwd) === repositoryRoot;
  const repositoryRootMatches = !hasText(declaredRepositoryRoot) || path.resolve(declaredRepositoryRoot) === repositoryRoot;
  return {
    ok: cwdMatches && repositoryRootMatches,
    cwd: cwd ?? null,
    repositoryRoot: declaredRepositoryRoot ?? null,
    expectedRepositoryRoot: repositoryRoot,
  };
}

function createRedactionScanCheck(inputs) {
  const findings = [];
  let scannedBytes = 0;
  for (const input of inputs) {
    // JSON escape로 raw secret을 숨기는 artifact도 closeout 증거로 쓰지 못하게 raw/decoded 문자열을 함께 검사한다.
    const rawText = [input.rawText, input.decodedText].filter(hasText).join("\n");
    scannedBytes += Buffer.byteLength(rawText, "utf8");
    for (const { label, pattern } of sensitivePatterns) {
      if (pattern.test(rawText)) {
        findings.push({ input: input.label, label });
      }
    }
  }

  if (findings.length === 0) {
    return okCheck("manifest와 redacted artifact에 raw secret/provider/order 후보 문자열이 없다.", { scannedBytes });
  }

  return failCheck("manifest 또는 artifact에 secret/raw provider 후보 문자열이 있다.", { findings, scannedBytes });
}

function collectJsonStringText(value, depth = 0) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectJsonStringText(item, depth + 1)).filter(hasText).join("\n");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, item]) => {
        const nested = collectJsonStringText(item, depth + 1);
        return hasText(nested) ? `${key}: ${nested}` : `${key}:`;
      })
      .filter(hasText)
      .join("\n");
  }
  return "";
}

function createReadinessAuditCheck(manifest) {
  const audit = readRecord(manifest.readinessAudit);
  const status = readString(audit.status);
  const evidenceId = readString(audit.evidenceId);
  if (status === "PASS" && hasText(evidenceId)) {
    return okCheck("finish-readiness-audit PASS evidence가 closeout manifest에 연결됐다.", { status, evidenceId });
  }

  return failCheck("실거래 closeout manifest에는 finish-readiness-audit PASS evidence가 필요하다.", {
    status: status ?? null,
    evidenceId: evidenceId ?? null,
  });
}

function createMetrics(run, counters) {
  return {
    requestedNotionalKrw: readNumber(run.requestedNotionalKrw) ?? null,
    terminalCancelConfirmed: normalizeTerminalState(readString(run.terminalState)) === "CANCEL",
    openExposureKrw: readNumber(run.openExposureKrw) ?? null,
    crashCount: readNumber(counters.crashCount) ?? null,
    unhandledRejectionCount: readNumber(counters.unhandledRejectionCount) ?? null,
    duplicateOrderCount: readNumber(counters.duplicateOrderCount) ?? null,
    reconcileMismatchCount: readNumber(counters.reconcileMismatchCount) ?? null,
    untrackedFillCount: readNumber(counters.untrackedFillCount) ?? null,
    liveOrderCleanupFailureCount: readNumber(counters.liveOrderCleanupFailureCount) ?? null,
  };
}

function createEmptyMetrics() {
  return {
    requestedNotionalKrw: null,
    terminalCancelConfirmed: false,
    openExposureKrw: null,
    crashCount: null,
    unhandledRejectionCount: null,
    duplicateOrderCount: null,
    reconcileMismatchCount: null,
    untrackedFillCount: null,
    liveOrderCleanupFailureCount: null,
  };
}

async function readArtifactFiles(artifactPaths, baseDir) {
  const files = [];
  for (const artifactPath of artifactPaths) {
    const resolved = resolveInputPath(artifactPath, baseDir);
    try {
      const realPath = await realpath(resolved);
      const rawText = await readFile(realPath, "utf8");
      const json = parseJsonValue(rawText);
      files.push({
        filePath: resolved,
        realPath,
        rawText,
        value: json.value,
        outsideRepository: isOutsideRepositoryResolvedPath(realPath),
        error: json.error,
      });
    } catch (error) {
      files.push({
        filePath: resolved,
        realPath: undefined,
        rawText: JSON.stringify({ artifact_read_error: toErrorMessage(error) }),
        value: undefined,
        outsideRepository: false,
        error: toErrorMessage(error),
      });
    }
  }
  return files;
}

async function readJsonFile(filePath, baseDir) {
  const resolved = resolveInputPath(filePath, baseDir);
  let rawText = "";
  try {
    const realPathValue = await realpath(resolved);
    rawText = await readFile(realPathValue, "utf8");
    return {
      filePath: resolved,
      realPath: realPathValue,
      rawText,
      value: JSON.parse(rawText),
      outsideRepository: isOutsideRepositoryResolvedPath(realPathValue),
      error: undefined,
    };
  } catch (error) {
    return {
      filePath: resolved,
      realPath: undefined,
      rawText,
      value: undefined,
      outsideRepository: false,
      error: toErrorMessage(error),
    };
  }
}

async function writeFixtureManifest(artifactDir) {
  const artifactPath = path.join(artifactDir, "issue-206-live-ops-closeout-artifact.fixture.json");
  const manifestPath = path.join(artifactDir, "issue-206-live-ops-closeout-manifest.fixture.json");
  const startedAt = "2026-06-15T00:00:00.000Z";
  const cancelRequestedAt = "2026-06-15T00:00:05.000Z";
  const terminalCancelConfirmedAt = "2026-06-15T00:00:10.000Z";
  const artifact = {
    kind: "ISSUE_206_LIVE_OPS_REAL_ARM_FIXTURE",
    status: "PASSED",
    market: expectedMarket,
    side: expectedSide,
    orderType: expectedOrderType,
    timeInForce: "post_only",
    requestedNotionalKrw: 5_000,
    submittedAt: startedAt,
    cancelRequestedAt,
    terminalCancelConfirmedAt,
    terminalState: "cancel",
    identifierSuffix: "closeout-identifier",
    cancelIdentifierSuffix: "closeout-identifier",
    brokerOrderIdSuffix: "closeout-order",
    cancelBrokerOrderIdSuffix: "closeout-order",
    openExposureKrw: 0,
    note: "fixture smoke artifact - no live API side effect",
  };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const manifest = {
    fixture: true,
    issue: expectedIssue,
    mode: expectedMode,
    command: "corepack pnpm live:ops -- --config /tmp/issue-206-live-ops.fixture.json --env-file /tmp/issue-206-live-ops.fixture.env --tui",
    configPath: "/tmp/issue-206-live-ops.fixture.json",
    envFilePath: "/tmp/issue-206-live-ops.fixture.env",
    operatorArmEvidenceId: "issue-206-operator-arm-fixture",
    keyScopeEvidenceId: "issue-206-key-scope-fixture",
    keyScope: {
      grantedScopes: requiredKeyScopes,
      forbiddenScopesAbsent: ["출금하기"],
      withdrawalEnabled: false,
    },
    artifactPaths: [artifactPath],
    run: {
      market: expectedMarket,
      side: expectedSide,
      orderType: expectedOrderType,
      timeInForce: "post_only",
      requestedNotionalKrw: "5000",
      submittedAt: startedAt,
      cancelRequestedAt,
      terminalCancelConfirmedAt,
      terminalState: "cancel",
      identifierSuffix: "closeout-identifier",
      cancelIdentifierSuffix: "closeout-identifier",
      brokerOrderIdSuffix: "closeout-order",
      cancelBrokerOrderIdSuffix: "closeout-order",
      openExposureKrw: 0,
      openOrderCount: 0,
      reconcileMismatchCount: 0,
      untrackedFillCount: 0,
      manualReviewCount: 0,
    },
    reconcile: {
      openExposureKrw: 0,
      openOrderCount: 0,
      mismatchCount: 0,
      untrackedFillCount: 0,
      manualReviewCount: 0,
    },
    counters: {
      crashCount: 0,
      unhandledRejectionCount: 0,
      duplicateOrderCount: 0,
      reconcileMismatchCount: 0,
      untrackedFillCount: 0,
      liveOrderCleanupFailureCount: 0,
    },
    telegram: {
      evidenceIds: {
        startup: "fixture-telegram-startup",
        liveOrderCapable: "fixture-telegram-live-order-capable",
        orderSubmitted: "fixture-telegram-order-submitted",
        cancelRequested: "fixture-telegram-cancel-requested",
        cancelConfirmed: "fixture-telegram-cancel-confirmed",
      },
    },
    tui: {
      evidenceId: "fixture-tui-status",
    },
    sourceScan: {
      status: "passed",
      cwd: repositoryRoot,
      repositoryRoot,
      commands: ["fixture source scan"],
      unsafeMatches: [],
      secretMatches: [],
    },
    readinessAudit: {
      status: "PASS",
      evidenceId: "fixture-readiness-audit",
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { artifactPath, manifestPath };
}

function createSummary(input) {
  const status = determineStatus(input.checks);
  return {
    issue: expectedIssue,
    runId: input.runId,
    status,
    input: input.inputMode,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    artifacts: input.artifacts,
    metrics: input.metrics,
    checks: input.checks,
  };
}

function determineStatus(checks) {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.includes("fail")) {
    return "failed";
  }
  if (statuses.includes("skipped")) {
    return "skipped";
  }
  return "passed";
}

async function writeArtifacts(summary, artifacts) {
  await mkdir(path.dirname(artifacts.summaryPath), { recursive: true });
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(artifacts.reportPath, renderReport(summary), "utf8");
}

async function writeFailureSummary(error, options) {
  const startedAt = new Date();
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR ?? defaultArtifactDir));
  const runId = randomUUID();
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  const summary = createSummary({
    runId,
    startedAt,
    inputMode: "script_failure",
    artifacts,
    metrics: createEmptyMetrics(),
    checks: {
      scriptFailure: failCheck("Issue #206 live:ops closeout validator 실행 중 예외가 발생했다.", {
        error: toErrorMessage(error),
      }),
    },
  });
  await writeArtifacts(summary, artifacts).catch(() => undefined);
  return summary;
}

function renderReport(summary) {
  const lines = [
    "# Issue #206 live:ops 실거래 closeout 검증",
    "",
    `- status: ${summary.status}`,
    `- input: ${summary.input}`,
    `- runId: ${summary.runId}`,
    `- startedAt: ${summary.startedAt}`,
    `- finishedAt: ${summary.finishedAt}`,
    "",
    "## Checks",
    "",
  ];
  for (const [name, check] of Object.entries(summary.checks)) {
    lines.push(`- ${name}: ${check.status} - ${check.message}`);
  }
  lines.push("", "## Metrics", "", "```json", JSON.stringify(summary.metrics, null, 2), "```", "");
  return `${lines.join("\n")}\n`;
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`status: ${summary.status}\n`);
  process.stdout.write(`summary: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`report: ${summary.artifacts.reportPath}\n`);
}

function createArtifactPaths(input) {
  const timestamp = input.startedAt.toISOString().replace(/[:.]/g, "-");
  const prefix = `issue-206-live-ops-real-arm-${timestamp}-${input.runId.slice(0, 8)}`;
  return {
    summaryPath: path.join(input.artifactDir, `${prefix}-summary.json`),
    reportPath: path.join(input.artifactDir, `${prefix}-report.md`),
  };
}

function parseArgs(argv) {
  const options = {
    artifactDir: undefined,
    fixtureSmoke: false,
    help: false,
    json: false,
    manifestPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--manifest":
        options.manifestPath = readValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`지원하지 않는 인자입니다: ${arg}`);
    }
  }
  return options;
}

function parseArgsForFailure(argv) {
  const options = { artifactDir: undefined, json: argv.includes("--json") };
  const artifactDirIndex = argv.indexOf("--artifact-dir");
  if (artifactDirIndex >= 0 && argv[artifactDirIndex + 1] !== undefined && !argv[artifactDirIndex + 1].startsWith("--")) {
    options.artifactDir = argv[artifactDirIndex + 1];
  }
  return options;
}

function readValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Issue #206 live:ops real-arm closeout validator.

Usage:
  node scripts/run-live-ops-real-arm-closeout.mjs --fixture-smoke [--json] [--artifact-dir <path>]
  SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT=1 node scripts/run-live-ops-real-arm-closeout.mjs --manifest <path> [--json] [--artifact-dir <path>]

Options:
  --manifest <path>       저장소 밖 redacted closeout manifest JSON.
  --artifact-dir <path>   summary/report 출력 디렉터리. 기본값은 ~/vaults/99_운영/seemirai-live-ops-real-arm-closeout.
  --fixture-smoke         live/API side effect 없이 결정적 manifest 검증만 실행.
  --json                  summary JSON을 stdout으로 출력.
`);
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

function hasSameOrderChain(run) {
  const identifier = readString(run.identifierSuffix);
  const cancelIdentifier = readString(run.cancelIdentifierSuffix);
  const brokerOrderId = readString(run.brokerOrderIdSuffix);
  const cancelBrokerOrderId = readString(run.cancelBrokerOrderIdSuffix);
  const pairs = [
    [identifier, cancelIdentifier],
    [brokerOrderId, cancelBrokerOrderId],
  ];
  // 제출/취소 suffix 중 하나라도 충돌하면 다른 pair가 맞아도 같은 주문 closeout 증거로 보지 않는다.
  const consistentPairs = pairs.every(([submitted, cancelled]) => {
    if (submitted === undefined && cancelled === undefined) {
      return true;
    }
    return isUsableOrderEvidenceSuffix(submitted)
      && isUsableOrderEvidenceSuffix(cancelled)
      && submitted === cancelled;
  });
  if (!consistentPairs) {
    return false;
  }
  if (isUsableOrderEvidenceSuffix(identifier) && identifier === cancelIdentifier) {
    return true;
  }
  return isUsableOrderEvidenceSuffix(brokerOrderId) && brokerOrderId === cancelBrokerOrderId;
}

function isLiveOpsCommand(command, configPath, envFilePath) {
  if (!hasText(command) || !hasText(configPath) || !hasText(envFilePath)) {
    return false;
  }
  if (!path.isAbsolute(configPath) || !path.isAbsolute(envFilePath)) {
    return false;
  }
  if (collectUnquotedShellOperators(command).length > 0) {
    return false;
  }
  const tokens = splitCommandTokens(command);
  const separatorIndex = tokens.indexOf("--");
  if (tokens[0] !== "corepack" || tokens[1] !== "pnpm" || tokens[2] !== "live:ops" || separatorIndex !== 3) {
    return false;
  }
  const args = tokens.slice(separatorIndex + 1);
  const exactArgs = ["--config", configPath, "--env-file", envFilePath, "--tui"];
  if (args.length !== exactArgs.length) {
    return false;
  }
  return args.every((arg, index) => arg === exactArgs[index]);
}

async function createProductionInputContract(configStatus, envFileStatus, expectedKeyScopeEvidenceId) {
  const config = await createConfigContractEvidence(configStatus);
  const env = await createEnvContractEvidence(envFileStatus, expectedKeyScopeEvidenceId);
  return {
    ok: config.ok && env.ok,
    evidence: { config, env },
  };
}

async function createConfigContractEvidence(fileStatus) {
  if (fileStatus === undefined || !fileStatus.exists || !fileStatus.isFile || !fileStatus.outsideRepository || fileStatus.realPath === null) {
    return { ok: false, errors: ["config file is not readable outside repository"] };
  }

  try {
    const rawText = await readFile(fileStatus.realPath, "utf8");
    const config = JSON.parse(rawText);
    if (!isRecord(config)) {
      return { ok: false, errors: ["config JSON must be an object"] };
    }
    const errors = createLiveOpsConfigContractErrors(config);
    return {
      ok: errors.length === 0,
      errors,
      checked: {
        mode: config.mode ?? null,
        defaultMarket: readRecord(config.universe).default_market ?? null,
        liveTradingEnabled: config.live_trading_enabled === true,
        paperNoKey: config.paper_no_key === false,
      },
    };
  } catch (error) {
    return { ok: false, errors: [`config parse/read failure: ${toErrorMessage(error)}`] };
  }
}

function createLiveOpsConfigContractErrors(config) {
  const errors = [];
  validateAllowedConfigKeys(errors, config, "$", liveOpsConfigAllowedKeys.$);
  validateAllowedConfigKeys(errors, config.universe, "universe", liveOpsConfigAllowedKeys.universe);
  validateAllowedConfigKeys(errors, config.budget, "budget", liveOpsConfigAllowedKeys.budget);
  validateAllowedConfigKeys(errors, config.workers, "workers", liveOpsConfigAllowedKeys.workers);
  validateAllowedConfigKeys(errors, config.market_data, "market_data", liveOpsConfigAllowedKeys.market_data);
  validateAllowedConfigKeys(errors, config.analysis, "analysis", liveOpsConfigAllowedKeys.analysis);
  validateAllowedConfigKeys(errors, config.telegram, "telegram", liveOpsConfigAllowedKeys.telegram);
  validateAllowedConfigKeys(errors, config.tui, "tui", liveOpsConfigAllowedKeys.tui);
  const secretPaths = findSecretLikeKeys(config);
  if (secretPaths.length > 0) {
    errors.push(`JSON config contains secret-like keys: ${secretPaths.join(", ")}`);
  }
  if (config.schema_version !== 1) errors.push("schema_version=1 is required");
  if (config.mode !== expectedMode) errors.push(`mode=${expectedMode} is required`);
  if (config.exchange !== "UPBIT") errors.push("exchange=UPBIT is required");
  if (config.market !== "KRW_SPOT") errors.push("market=KRW_SPOT is required");
  if (config.live_trading_enabled !== true) errors.push("live_trading_enabled=true is required");
  if (config.paper_no_key !== false) errors.push("paper_no_key=false is required");
  for (const flag of [
    "withdrawal_enabled",
    "cross_exchange_arbitrage_enabled",
    "futures_enabled",
    "leverage_enabled",
    "market_order_enabled",
    "entry_market_order_enabled",
  ]) {
    if (config[flag] !== false) errors.push(`${flag}=false is required`);
  }
  const universe = readRecord(config.universe);
  if (!Array.isArray(universe.markets) || universe.markets.length !== 1 || universe.markets[0] !== expectedMarket) {
    errors.push(`universe.markets must contain only ${expectedMarket}`);
  }
  if (universe.default_market !== expectedMarket) {
    errors.push(`universe.default_market=${expectedMarket} is required`);
  }
  validateExpectedConfigValues(errors, readRecord(config.budget), "budget", {
    max_order_krw: "10000",
    daily_autonomous_notional_limit_krw: "30000",
    max_open_position_notional_krw: "30000",
  });
  const stopCeilingKrw = Number(readRecord(config.budget).operations_stop_ceiling_krw);
  if (!Number.isFinite(stopCeilingKrw) || stopCeilingKrw <= 0 || stopCeilingKrw >= 50_000) {
    errors.push("budget.operations_stop_ceiling_krw must be positive and below 50000");
  }
  validateExpectedConfigValues(errors, readRecord(config.workers), "workers", {
    db_readiness: true,
    market_data: true,
    analysis_decision: true,
    live_execution: true,
    reconcile_pnl_status: true,
    telegram: true,
    tui: true,
  });
  validateExpectedConfigValues(errors, readRecord(config.market_data), "market_data", {
    provider: "UPBIT_PUBLIC",
    websocket_enabled: true,
    rest_policy_snapshot_enabled: true,
    stale_after_ms: 30000,
  });
  validateExpectedConfigValues(errors, readRecord(config.analysis), "analysis", {
    candle_interval_seconds: 60,
    feature_interval_seconds: 5,
    decision_interval_seconds: 5,
    record_hold_decision: true,
  });
  validateExpectedConfigValues(errors, readRecord(config.telegram), "telegram", {
    startup_alert_enabled: true,
    live_order_capable_alert_enabled: true,
    trade_event_alerts_enabled: true,
    provider_timeout_ms: 5000,
  });
  validateExpectedConfigValues(errors, readRecord(config.tui), "tui", {
    foreground_enabled: true,
    attach_enabled: true,
    refresh_interval_ms: 1000,
    control_requires_two_step_confirmation: true,
    controls_enabled: true,
  });
  return errors;
}

function validateAllowedConfigKeys(errors, target, prefix, allowedKeys) {
  if (!isRecord(target)) {
    return;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix}.${key} is not allowed in production live ops config`);
    }
  }
}

function validateExpectedConfigValues(errors, target, prefix, expected) {
  if (!isRecord(target)) {
    errors.push(`${prefix} config section is required`);
    return;
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (target[key] !== expectedValue) {
      errors.push(`${prefix}.${key} must be ${String(expectedValue)}`);
    }
  }
}

async function createEnvContractEvidence(fileStatus, expectedKeyScopeEvidenceId) {
  if (fileStatus === undefined || !fileStatus.exists || !fileStatus.isFile || !fileStatus.outsideRepository || fileStatus.realPath === null) {
    return { ok: false, errors: ["env file is not readable outside repository"] };
  }

  try {
    const rawText = await readFile(fileStatus.realPath, "utf8");
    const env = parseEnvContent(rawText);
    const errors = createLiveOpsEnvContractErrors(env, process.env, expectedKeyScopeEvidenceId);
    const keyScopeEvidenceId = readString(env.SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID);
    return {
      ok: errors.length === 0,
      errors,
      requiredKeysPresent: requiredLiveOpsEnvNames.filter((name) => hasMeaningfulEnvValue(env[name])),
      ambientLegacyEnvNamesPresent: collectLegacyEnvNames(process.env),
      keyScope: createEnvKeyScopeEvidence(env.SEEMIRAI_UPBIT_KEY_SCOPE),
      keyScopeEvidenceIdMatches: hasText(expectedKeyScopeEvidenceId) && keyScopeEvidenceId === expectedKeyScopeEvidenceId,
    };
  } catch (error) {
    return { ok: false, errors: [`env parse/read failure: ${toErrorMessage(error)}`] };
  }
}

function createLiveOpsEnvContractErrors(env, ambientEnv = {}, expectedKeyScopeEvidenceId) {
  const errors = [];
  for (const name of requiredLiveOpsEnvNames) {
    if (!hasMeaningfulEnvValue(env[name])) {
      errors.push(`${name} value is required`);
    }
  }
  errors.push(...collectLegacyEnvNames(env).map((name) => `${name} must not be used for production live ops env file`));
  errors.push(...collectLegacyEnvNames(ambientEnv).map((name) => `${name} must not be set in ambient production live ops environment`));
  const keyScopeEvidence = createEnvKeyScopeEvidence(env.SEEMIRAI_UPBIT_KEY_SCOPE);
  errors.push(...keyScopeEvidence.errors);
  const keyScopeEvidenceId = readString(env.SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID);
  if (hasText(expectedKeyScopeEvidenceId) && keyScopeEvidenceId !== expectedKeyScopeEvidenceId) {
    errors.push("SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID must match manifest keyScopeEvidenceId");
  }
  return errors;
}

function collectLegacyEnvNames(env) {
  const names = [];
  for (const name of liveOpsLegacyEnvNames) {
    if (hasMeaningfulEnvValue(env[name])) {
      names.push(name);
    }
  }
  for (const name of Object.keys(env)) {
    if (/^SEEMIRAI_M22_.*_READY$/u.test(name) && hasMeaningfulEnvValue(env[name])) {
      names.push(name);
    }
    if (/^SEEMIRAI_RUN_UPBIT_.*_SMOKE$/u.test(name) && hasMeaningfulEnvValue(env[name])) {
      names.push(name);
    }
  }
  return collectUnique(names);
}

function createEnvKeyScopeEvidence(value) {
  const scopes = readCsvString(value);
  const missingRequiredScopes = requiredKeyScopes.filter((scope) => !scopes.includes(scope));
  const extraScopes = scopes.filter((scope) => !requiredKeyScopes.includes(scope));
  const forbiddenScopes = scopes.filter(isForbiddenKeyScope);
  const errors = [];
  if (missingRequiredScopes.length > 0) {
    errors.push(`SEEMIRAI_UPBIT_KEY_SCOPE missing required scopes: ${missingRequiredScopes.join(", ")}`);
  }
  if (extraScopes.length > 0) {
    errors.push(`SEEMIRAI_UPBIT_KEY_SCOPE includes extra scopes: ${extraScopes.join(", ")}`);
  }
  if (forbiddenScopes.length > 0) {
    errors.push(`SEEMIRAI_UPBIT_KEY_SCOPE includes forbidden scopes: ${forbiddenScopes.join(", ")}`);
  }
  return { scopes, missingRequiredScopes, extraScopes, forbiddenScopes, errors };
}

function parseEnvContent(content) {
  const values = {};
  const lines = content.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }
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
  if (!isRecord(value)) {
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

async function createFileStatus(name, value, baseDir) {
  if (!hasText(value)) {
    return { name, value: value ?? null, realPath: null, exists: false, isFile: false, outsideRepository: false, error: "missing" };
  }

  const filePath = resolveInputPath(value, baseDir);
  try {
    const realPathValue = await realpath(filePath);
    const stats = await stat(realPathValue);
    return {
      name,
      value: filePath,
      realPath: realPathValue,
      exists: true,
      isFile: stats.isFile(),
      outsideRepository: isOutsideRepositoryResolvedPath(realPathValue),
    };
  } catch (error) {
    return { name, value: filePath, realPath: null, exists: false, isFile: false, outsideRepository: false, error: toErrorMessage(error) };
  }
}

function createKeyScopeEvidence(manifest) {
  const keyScope = readRecord(manifest.keyScope);
  const grantedScopes = readStringArray(keyScope.grantedScopes ?? keyScope.allowedScopes);
  const forbiddenScopesAbsent = readStringArray(keyScope.forbiddenScopesAbsent);
  const withdrawalEnabled = keyScope.withdrawalEnabled;
  const missingRequiredScopes = requiredKeyScopes.filter((scope) => !grantedScopes.includes(scope));
  const extraGrantedScopes = grantedScopes.filter((scope) => !requiredKeyScopes.includes(scope));
  const forbiddenGrantedScopes = grantedScopes.filter(isForbiddenKeyScope);
  const withdrawalAbsenceRecorded = withdrawalEnabled === false && forbiddenScopesAbsent.some(isWithdrawalScope);
  const ok = grantedScopes.length > 0
    && missingRequiredScopes.length === 0
    && extraGrantedScopes.length === 0
    && forbiddenGrantedScopes.length === 0
    && withdrawalAbsenceRecorded;

  return {
    ok,
    evidence: {
      grantedScopes,
      forbiddenScopesAbsent,
      withdrawalEnabled: typeof withdrawalEnabled === "boolean" ? withdrawalEnabled : null,
      missingRequiredScopes,
      extraGrantedScopes,
      forbiddenGrantedScopes,
      withdrawalAbsenceRecorded,
    },
  };
}

function createSourceScanCommandEvidence(commands) {
  const commandChecks = commands.map((command) => {
    const tokens = splitCommandTokens(command);
    const optionTokens = collectTokensBeforeOptionTerminator(tokens);
    const operands = collectRipgrepPathOperands(tokens);
    const searchPatterns = collectRipgrepSearchPatterns(tokens);
    const usesRipgrep = tokens[0] === "rg";
    const hasLineNumber = hasRipgrepLineNumber(optionTokens);
    // 운영자 shell의 ripgrep config가 검색 범위를 몰래 줄이지 못하게 source scan 증거는 config 비활성화를 요구한다.
    const hasNoConfig = optionTokens.includes("--no-config");
    // hidden/ignore 기본 필터가 운영 source scan 범위를 줄이지 못하게 unrestricted traversal을 요구한다.
    const hasFullTraversal = hasRipgrepFullTraversal(optionTokens);
    // redirect/pipe가 있으면 실제 검색 결과가 reviewer에게 보이지 않을 수 있어 closeout source scan 증거에서 제외한다.
    const shellOperators = collectUnquotedShellOperators(command);
    const scansExpectedPaths = requiredSourceScanPaths.every((scanPath) => operands.includes(scanPath));
    const excludedSourceGlobs = collectExcludedSourceGlobs(optionTokens);
    const disallowedOptions = collectDisallowedRipgrepOptions(optionTokens);
    // escaped alternation은 다중 secret/order 후보 검색을 하지 않는 패턴이라 coverage 증거로 인정하지 않는다.
    const escapedAlternationPatterns = searchPatterns.filter((pattern) => pattern.includes("\\|"));
    const unsupportedRegexPatterns = searchPatterns.filter(hasUnsupportedRipgrepRegex);
    const coveredUnsafePatterns = requiredUnsafeSourceScanPatterns
      .filter((requirement) => searchPatterns.some((pattern) => searchPatternCoversRequiredPattern(pattern, requirement)))
      .map((requirement) => requirement.label);
    const coveredSecretPatterns = requiredSecretSourceScanPatterns
      .filter((requirement) => searchPatterns.some((pattern) => searchPatternCoversRequiredPattern(pattern, requirement)))
      .map((requirement) => requirement.label);
    return {
      tokenCount: tokens.length,
      usesRipgrep,
      hasLineNumber,
      hasNoConfig,
      hasFullTraversal,
      shellOperators,
      scansExpectedPaths,
      searchPatterns,
      operands,
      excludedSourceGlobs,
      disallowedOptions,
      escapedAlternationPatterns,
      unsupportedRegexPatterns,
      coveredUnsafePatterns,
      coveredSecretPatterns,
    };
  });
  const validCommandChecks = commandChecks.filter((check) => check.usesRipgrep
    && check.hasLineNumber
    && check.hasNoConfig
    && check.hasFullTraversal
    && check.scansExpectedPaths
    && check.shellOperators.length === 0
    && check.excludedSourceGlobs.length === 0
    && check.disallowedOptions.length === 0
    && check.escapedAlternationPatterns.length === 0
    && check.unsupportedRegexPatterns.length === 0);
  const unsafePatternsCovered = collectUnique(validCommandChecks.flatMap((check) => check.coveredUnsafePatterns));
  const secretPatternsCovered = collectUnique(validCommandChecks.flatMap((check) => check.coveredSecretPatterns));
  const missingUnsafePatterns = requiredUnsafeSourceScanPatterns
    .map((requirement) => requirement.label)
    .filter((label) => !unsafePatternsCovered.includes(label));
  const missingSecretPatterns = requiredSecretSourceScanPatterns
    .map((requirement) => requirement.label)
    .filter((label) => !secretPatternsCovered.includes(label));
  const hasUnsafeBoundaryScan = missingUnsafePatterns.length === 0;
  const hasSecretBoundaryScan = missingSecretPatterns.length === 0;

  return {
    ok: hasUnsafeBoundaryScan && hasSecretBoundaryScan,
    hasUnsafeBoundaryScan,
    hasSecretBoundaryScan,
    missingUnsafePatterns,
    missingSecretPatterns,
    commandChecks: commandChecks.map(summarizeSourceScanCommandCheck),
  };
}

function searchPatternCoversRequiredPattern(searchPattern, requirement) {
  const requiredTerm = requirement.pattern.source;
  const coveragePattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(requiredTerm)}($|[^\\p{L}\\p{N}_])`, "gu");
  return [...searchPattern.matchAll(coveragePattern)]
    .some((match) => !isRegexCoveragePrefixMutation(match[1] ?? "") && !isRegexCoverageSuffixMutation(match[2] ?? ""));
}

function isRegexCoveragePrefixMutation(prefix) {
  return prefix === "^";
}

function isRegexCoverageSuffixMutation(suffix) {
  return ["{", "[", "(", "?", "+", "*", "."].includes(suffix);
}

function summarizeSourceScanCommandCheck(check) {
  return {
    command: "[redacted-command]",
    tokenCount: check.tokenCount,
    usesRipgrep: check.usesRipgrep,
    hasLineNumber: check.hasLineNumber,
    hasNoConfig: check.hasNoConfig,
    hasFullTraversal: check.hasFullTraversal,
    shellOperators: check.shellOperators,
    scansExpectedPaths: check.scansExpectedPaths,
    missingSourcePaths: requiredSourceScanPaths.filter((scanPath) => !check.operands.includes(scanPath)),
    searchPatternCount: check.searchPatterns.length,
    operandCount: check.operands.length,
    excludedSourceGlobCount: check.excludedSourceGlobs.length,
    disallowedOptionNames: collectUnique(check.disallowedOptions.map(summarizeRipgrepOptionName)),
    escapedAlternationPatternCount: check.escapedAlternationPatterns.length,
    unsupportedRegexPatternCount: check.unsupportedRegexPatterns.length,
    coveredUnsafePatterns: check.coveredUnsafePatterns,
    coveredSecretPatterns: check.coveredSecretPatterns,
  };
}

function summarizeRipgrepOptionName(option) {
  if (option.startsWith("--")) {
    return option.split("=")[0];
  }
  const disallowedFlag = [...option.slice(1)].find((flag) => disallowedRipgrepShortOptions.has(flag));
  return disallowedFlag === undefined ? "[redacted-option]" : `-${disallowedFlag}`;
}

function collectExcludedSourceGlobs(tokens) {
  const globs = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === "-g" || token === "--glob") && tokens[index + 1] !== undefined) {
      globs.push(tokens[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith("-g") && token.length > 2) {
      globs.push(stripShellQuotes(token.slice(2)));
      continue;
    }
    const clusteredShortGlob = readClusteredShortOptionValue(token, "g");
    if (clusteredShortGlob !== undefined) {
      globs.push(stripShellQuotes(clusteredShortGlob));
      continue;
    }
    if (token.startsWith("--glob=")) {
      globs.push(token.slice("--glob=".length));
    }
  }
  return globs
    .map(stripShellQuotes);
}

function collectDisallowedRipgrepOptions(tokens) {
  const options = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (disallowedRipgrepLongOptions.has(token)) {
      options.push(token);
      continue;
    }
    if ([...disallowedRipgrepLongOptions].some((option) => token.startsWith(`${option}=`))) {
      options.push(token);
      continue;
    }
    if (/^-m=?\d+/u.test(token)) {
      options.push(token);
      continue;
    }
    if (/^-f(?:=|\S)/u.test(token)) {
      options.push(token);
      continue;
    }
    if (/^-t(?:=|\S)/u.test(token)) {
      options.push(token);
      continue;
    }
    if (/^-[^-]\S+/u.test(token)) {
      const shortText = token.slice(1);
      const attachedDisallowedOption = [...shortText].some((flag, flagIndex) => disallowedRipgrepShortOptions.has(flag)
        && shortText[flagIndex + 1] !== undefined
        && /[^A-Za-z]/u.test(shortText[flagIndex + 1]));
      if (attachedDisallowedOption) {
        options.push(token);
        continue;
      }
    }
    if (/^-[A-Za-z]+$/u.test(token) && [...token.slice(1)].some((flag) => disallowedRipgrepShortOptions.has(flag))) {
      options.push(token);
    }
  }
  return options;
}

function collectUnquotedShellOperators(command) {
  const operators = [];
  let quote = undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const nextChar = command[index + 1];
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (quote === "\"") {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (char === "`") {
        operators.push("`");
        continue;
      }
      if (char === "$" && nextChar === "(") {
        operators.push("$(");
        index += 1;
        continue;
      }
      if (isShellParameterExpansionStart(char, nextChar)) {
        operators.push(nextChar === "{" ? "${" : "$VAR");
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`") {
      operators.push("`");
      continue;
    }
    if (char === "$" && nextChar === "(") {
      operators.push("$(");
      index += 1;
      continue;
    }
    if (isShellParameterExpansionStart(char, nextChar)) {
      operators.push(nextChar === "{" ? "${" : "$VAR");
      if (nextChar === "{") {
        index += 1;
      }
      continue;
    }
    // shell comment와 newline은 뒤쪽 path 토큰을 실제 검색에서 제외할 수 있으므로 command separator로 취급한다.
    if (char === "#" || char === "\n" || char === "\r") {
      operators.push(char === "#" ? "#" : "newline");
      continue;
    }
    if ("|><;&".includes(char)) {
      operators.push(char);
    }
  }
  if (quote !== undefined) {
    operators.push(quote === "'" ? "unclosed-single-quote" : "unclosed-double-quote");
  }
  return collectUnique(operators);
}

function isShellParameterExpansionStart(char, nextChar) {
  return char === "$" && (nextChar === "{" || /[A-Za-z_]/u.test(nextChar ?? ""));
}

function collectTokensBeforeOptionTerminator(tokens) {
  const terminatorIndex = tokens.indexOf("--");
  return terminatorIndex >= 0 ? tokens.slice(0, terminatorIndex) : tokens;
}

function hasRipgrepFullTraversal(tokens) {
  const tokenSet = new Set(tokens);
  return tokens.some((token) => /^-u{2,3}$/u.test(token))
    || (tokenSet.has("--hidden") && tokenSet.has("--no-ignore"));
}

function hasRipgrepLineNumber(tokens) {
  return tokens.some((token) => token === "--line-number"
    || token === "-n"
    || (/^-[A-Za-z]+$/u.test(token) && token.includes("n") && !token.includes("N")));
}

function hasUnsupportedRipgrepRegex(pattern) {
  // ripgrep가 parse하지 못하는 lookaround류 패턴은 실제 source coverage 증거로 인정하지 않는다.
  if (/\(\?(?:[!=<]|P|#|[a-zA-Z-]+:)/u.test(pattern) || /\$\^/u.test(pattern)) {
    return true;
  }
  if (/\\(?:[1-9]|k<[^>]+>)/u.test(pattern)) {
    return true;
  }
  try {
    new RegExp(pattern, "u");
    return false;
  } catch {
    return true;
  }
}

function collectRipgrepPathOperands(tokens) {
  const operands = [];
  let patternSeen = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      if (!patternSeen && tokens[index + 1] !== undefined) {
        patternSeen = true;
        index += 1;
      }
      continue;
    }
    if (token === "-g" || token === "--glob") {
      index += 1;
      continue;
    }
    if (token === "-e" || token === "--regexp") {
      patternSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--regexp=") || token.startsWith("-e")) {
      patternSeen = true;
      continue;
    }
    if (isRipgrepOptionWithNextValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--glob=") || token.startsWith("-g") || token === "-n" || token === "--line-number") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    operands.push(token);
  }
  return operands;
}

function collectRipgrepSearchPatterns(tokens) {
  const patterns = [];
  let positionalPatternSeen = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      if (!positionalPatternSeen && tokens[index + 1] !== undefined) {
        patterns.push(tokens[index + 1]);
        positionalPatternSeen = true;
        index += 1;
      }
      continue;
    }
    if ((token === "-g" || token === "--glob") && tokens[index + 1] !== undefined) {
      index += 1;
      continue;
    }
    if ((token === "-e" || token === "--regexp") && tokens[index + 1] !== undefined) {
      patterns.push(tokens[index + 1]);
      positionalPatternSeen = true;
      index += 1;
      continue;
    }
    if (token.startsWith("--regexp=")) {
      patterns.push(token.slice("--regexp=".length));
      positionalPatternSeen = true;
      continue;
    }
    if (token.startsWith("-e") && token.length > 2) {
      patterns.push(token.slice(2));
      positionalPatternSeen = true;
      continue;
    }
    if (isRipgrepOptionWithNextValue(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("--glob=") || token.startsWith("-g") || token === "-n" || token === "--line-number") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (!positionalPatternSeen) {
      patterns.push(token);
      positionalPatternSeen = true;
    }
  }
  return patterns;
}

function isRipgrepOptionWithNextValue(token) {
  if (ripgrepOptionsWithNextValue.has(token)) {
    return true;
  }
  return /^-[A-Za-z]$/u.test(token) && ripgrepShortOptionsWithNextValue.has(token[1]);
}

function readClusteredShortOptionValue(token, flag) {
  if (!/^-[A-Za-z][\s\S]+/u.test(token) || token.startsWith("--")) {
    return undefined;
  }
  const body = token.slice(1);
  const flagIndex = body.indexOf(flag);
  if (flagIndex < 0 || flagIndex >= body.length - 1) {
    return undefined;
  }
  return body.slice(flagIndex + 1);
}

function excludesSourcePath(glob, scanPath) {
  const normalized = glob.slice(1).replace(/^\.?\//u, "");
  if (normalized.startsWith("{")) {
    const closeIndex = normalized.indexOf("}");
    if (closeIndex > 1) {
      const suffix = normalized.slice(closeIndex + 1);
      return normalized.slice(1, closeIndex).split(",").some((entry) => excludesSourcePath(`!${entry}${suffix}`, scanPath));
    }
  }
  return normalized === "*"
    || normalized === "**"
    || normalized === scanPath
    || normalized.startsWith(`${scanPath}/`)
    || normalized.startsWith(`${scanPath}/**`);
}

function createArtifactManifestConflicts(artifactFiles, manifest, run, counters) {
  const reconcile = readRecord(manifest.reconcile);
  const expectedZeroFields = {
    openExposureKrw: readNumber(run.openExposureKrw),
    openOrderCount: readNumber(run.openOrderCount),
    reconcileMismatchCount: readNumber(run.reconcileMismatchCount),
    untrackedFillCount: readNumber(run.untrackedFillCount),
    manualReviewCount: readNumber(run.manualReviewCount),
    mismatchCount: readNumber(reconcile.mismatchCount),
    ...Object.fromEntries(requiredCounterNames.map((name) => [name, readNumber(counters[name])])),
  };
  const expectedPolicyFields = {
    market: expectedMarket,
    side: expectedSide,
    orderType: expectedOrderType,
    timeInForce: expectedTimeInForce,
  };
  const expectedRequestedNotionalKrw = readNumber(run.requestedNotionalKrw);
  const expectedLifecycleTimestamps = {
    submittedAt: readTimestampMs(run.submittedAt),
    cancelRequestedAt: readTimestampMs(run.cancelRequestedAt),
    terminalCancelConfirmedAt: readTimestampMs(run.terminalCancelConfirmedAt),
  };
  const conflicts = [];

  for (const file of artifactFiles) {
    if (file.error !== undefined) {
      continue;
    }
    // artifact가 JSON safe summary가 아니면 manifest 값과 기계적으로 대조할 수 없어 closeout 증거로 쓰지 않는다.
    if (file.value === undefined) {
      conflicts.push({ filePath: file.filePath, field: "$", expected: "parseable JSON safe summary", actual: "unparseable" });
      continue;
    }
    const records = collectArtifactEvidenceRecords(file.value);
    if (!records.some((item) => isCompleteArtifactCloseoutEvidence(item.record, run))) {
      conflicts.push({
        filePath: file.filePath,
        field: "$",
        expected: "artifact evidence with success status, terminal cancel, order policy, lifecycle timestamps, and zero exposure",
        actual: "missing required closeout evidence fields",
      });
    }
    for (const item of records) {
      const closeoutRecord = isCloseoutEvidenceRecord(item.record);
      const status = readString(item.record.status);
      const closeoutRelevantStatus = item.path === "$" || closeoutRecord || isOrderLifecycleEvidenceRecord(item.record);
      if (closeoutRelevantStatus && status !== undefined && isFailureArtifactStatus(status)) {
        conflicts.push({ filePath: file.filePath, field: `${item.path}.status`, expected: "no artifact-level failure status", actual: status });
      } else if (closeoutRecord && status !== undefined && !/^(?:passed|pass|success|succeeded|ok|completed)$/iu.test(status)) {
        conflicts.push({ filePath: file.filePath, field: `${item.path}.status`, expected: "explicit success status", actual: status });
      }
      for (const actual of readTerminalStateAliasValues(item.record)) {
        if (closeoutRecord && actual.value !== "CANCEL") {
          conflicts.push({ filePath: file.filePath, field: `${item.path}.${actual.alias}`, expected: "CANCEL", actual: actual.value });
        }
      }
      if (closeoutRecord) {
        // provider summary와 같은 부가 artifact는 주문 closeout 증거가 아니므로 주문 정책 대조에서 제외한다.
        for (const [field, expected] of Object.entries(expectedPolicyFields)) {
          for (const actual of readArtifactPolicyFieldValues(item.record, field)) {
            if (actual.value !== expected) {
              conflicts.push({ filePath: file.filePath, field: `${item.path}.${actual.alias}`, expected, actual: actual.value });
            }
          }
        }
        for (const actual of readNumberAliasValues(item.record, ["requestedNotionalKrw", "requested_notional_krw"])) {
          if (expectedRequestedNotionalKrw !== undefined && actual.value !== expectedRequestedNotionalKrw) {
            conflicts.push({
              filePath: file.filePath,
              field: `${item.path}.${actual.alias}`,
              expected: expectedRequestedNotionalKrw,
              actual: actual.value,
            });
          }
        }
        for (const [field, expected] of Object.entries(expectedLifecycleTimestamps)) {
          for (const actual of readTimestampMsAliasValues(item.record, artifactFieldAliases(field))) {
            if (expected !== undefined && actual.value !== expected) {
              conflicts.push({ filePath: file.filePath, field: `${item.path}.${actual.alias}`, expected, actual: actual.value });
            }
          }
        }
      }
      for (const [field, expected] of Object.entries(expectedZeroFields)) {
        for (const actual of readNumberAliasValues(item.record, artifactFieldAliases(field))) {
          if (expected !== undefined && actual.value !== expected) {
            conflicts.push({ filePath: file.filePath, field: `${item.path}.${actual.alias}`, expected, actual: actual.value });
          }
        }
      }
      if (closeoutRecord) {
        for (const expected of createExpectedArtifactOrderSuffixes(run)) {
          for (const actual of readStringAliasValues(item.record, expected.aliases)) {
            if (actual.value !== expected.value) {
              conflicts.push({ filePath: file.filePath, field: `${item.path}.${actual.alias}`, expected: expected.value, actual: actual.value });
            }
          }
        }
      }
    }
  }

  return conflicts;
}

function isFailureArtifactStatus(value) {
  return /(?:^|[_:-])(?:blocked|error|fail|failed|failure|partial|reject|rejected|skipped)(?:$|[_:-])/iu.test(value)
    || /manual(?:[_:\-\s]+)?review/iu.test(value)
    || /timeout/iu.test(value)
    || /(?:^|[_:-])(?:unknown|uncertain)(?:$|[_:-])/iu.test(value);
}

function isCompleteArtifactCloseoutEvidence(record, run) {
  const expectedRequestedNotionalKrw = readNumber(run.requestedNotionalKrw);
  return /^(?:passed|pass|success|succeeded|ok|completed)$/iu.test(readString(record.status) ?? "")
    && readTerminalStateFromAliases(record) === "CANCEL"
    && readArtifactPolicyField(record, "market") === expectedMarket
    && readArtifactPolicyField(record, "side") === expectedSide
    && readArtifactPolicyField(record, "orderType") === expectedOrderType
    && readArtifactPolicyField(record, "timeInForce") === expectedTimeInForce
    && readNumberFromAliases(record, ["requestedNotionalKrw", "requested_notional_krw"]) === expectedRequestedNotionalKrw
    && readTimestampMsFromAliases(record, ["submittedAt", "submitted_at"]) === readTimestampMs(run.submittedAt)
    && readTimestampMsFromAliases(record, ["cancelRequestedAt", "cancel_requested_at"]) === readTimestampMs(run.cancelRequestedAt)
    && readTimestampMsFromAliases(record, ["terminalCancelConfirmedAt", "terminal_cancel_confirmed_at"]) === readTimestampMs(run.terminalCancelConfirmedAt)
    && readNumberFromAliases(record, ["openExposureKrw", "open_exposure_krw"]) === readNumber(run.openExposureKrw)
    && hasMatchingArtifactOrderSuffix(record, run);
}

function isCloseoutEvidenceRecord(record) {
  return [
    "terminalState",
    "terminal_state",
    "orderType",
    "order_type",
    "ord_type",
    "timeInForce",
    "time_in_force",
    "requestedNotionalKrw",
    "requested_notional_krw",
    "openExposureKrw",
    "open_exposure_krw",
  ].some((field) => record[field] !== undefined);
}

function isOrderLifecycleEvidenceRecord(record) {
  const hasLifecycleTimestamp = ["submittedAt", "submitted_at", "cancelRequestedAt", "cancel_requested_at", "terminalCancelConfirmedAt", "terminal_cancel_confirmed_at"]
    .some((field) => record[field] !== undefined);
  const hasOrderChainIdentifier = [
    "identifierSuffix",
    "identifier_suffix",
    "cancelIdentifierSuffix",
    "cancel_identifier_suffix",
    "brokerOrderIdSuffix",
    "broker_order_id_suffix",
    "cancelBrokerOrderIdSuffix",
    "cancel_broker_order_id_suffix",
    "brokerOrderId",
    "broker_order_id",
    "cancelBrokerOrderId",
    "cancel_broker_order_id",
  ].some((field) => record[field] !== undefined);
  return hasLifecycleTimestamp && hasOrderChainIdentifier;
}

function readArtifactPolicyField(record, field) {
  const value = readStringFromAliases(record, artifactFieldAliases(field));
  if (field === "timeInForce") {
    return normalizeTimeInForce(value);
  }
  return value?.toUpperCase();
}

function readArtifactPolicyFieldValues(record, field) {
  return readStringAliasValues(record, artifactFieldAliases(field)).map((actual) => ({
    alias: actual.alias,
    value: field === "timeInForce" ? normalizeTimeInForce(actual.value) : actual.value.toUpperCase(),
  })).filter((actual) => actual.value !== undefined);
}

function readTerminalStateFromAliases(record) {
  return normalizeTerminalState(readStringFromAliases(record, artifactFieldAliases("terminalState")));
}

function readTerminalStateAliasValues(record) {
  return readStringAliasValues(record, artifactFieldAliases("terminalState"))
    .map((actual) => ({ alias: actual.alias, value: normalizeTerminalState(actual.value) }))
    .filter((actual) => actual.value !== undefined);
}

function createExpectedArtifactOrderSuffixes(run) {
  return [
    { value: readString(run.identifierSuffix), aliases: ["identifierSuffix", "identifier_suffix", "identifier"] },
    { value: readString(run.cancelIdentifierSuffix), aliases: ["cancelIdentifierSuffix", "cancel_identifier_suffix", "cancelIdentifier", "cancel_identifier"] },
    { value: readString(run.brokerOrderIdSuffix), aliases: ["brokerOrderIdSuffix", "broker_order_id_suffix", "brokerOrderId", "broker_order_id"] },
    {
      value: readString(run.cancelBrokerOrderIdSuffix),
      aliases: ["cancelBrokerOrderIdSuffix", "cancel_broker_order_id_suffix", "cancelBrokerOrderId", "cancel_broker_order_id"],
    },
  ].filter((item) => isUsableOrderEvidenceSuffix(item.value));
}

function hasMatchingArtifactOrderSuffix(record, run) {
  const expected = createExpectedArtifactOrderSuffixes(run);
  if (expected.length === 0) {
    return false;
  }
  // manifest가 제공한 submit/cancel suffix는 artifact safe summary에도 누락 없이 남아야 같은 주문 chain으로 대조할 수 있다.
  return expected.every((item) => readStringFromAliases(record, item.aliases) === item.value);
}

function artifactFieldAliases(field) {
  const aliases = {
    market: ["market"],
    side: ["side"],
    terminalState: ["terminalState", "terminal_state"],
    orderType: ["orderType", "order_type", "ord_type"],
    timeInForce: ["timeInForce", "time_in_force"],
    submittedAt: ["submittedAt", "submitted_at"],
    cancelRequestedAt: ["cancelRequestedAt", "cancel_requested_at"],
    terminalCancelConfirmedAt: ["terminalCancelConfirmedAt", "terminal_cancel_confirmed_at"],
    openExposureKrw: ["openExposureKrw", "open_exposure_krw"],
    openOrderCount: ["openOrderCount", "open_order_count"],
    reconcileMismatchCount: ["reconcileMismatchCount", "reconcile_mismatch_count"],
    untrackedFillCount: ["untrackedFillCount", "untracked_fill_count"],
    manualReviewCount: ["manualReviewCount", "manual_review_count"],
    mismatchCount: ["mismatchCount", "mismatch_count"],
    crashCount: ["crashCount", "crash_count"],
    unhandledRejectionCount: ["unhandledRejectionCount", "unhandled_rejection_count"],
    duplicateOrderCount: ["duplicateOrderCount", "duplicate_order_count"],
    liveOrderCleanupFailureCount: ["liveOrderCleanupFailureCount", "live_order_cleanup_failure_count"],
  };
  return aliases[field] ?? [field];
}

function collectArtifactEvidenceRecords(value, prefix = "$", depth = 0) {
  // 실제 운영 artifact safe summary는 wrapper별 nesting이 달라져도 실패 closeout evidence를 놓치면 안 된다.
  if (depth > maxArtifactEvidenceDepth) {
    return [{ path: prefix, record: { status: "ERROR_DEPTH_LIMIT_EXCEEDED" } }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectArtifactEvidenceRecords(item, `${prefix}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const records = [{ path: prefix, record: value }];
  for (const [key, nested] of Object.entries(value)) {
    if (isRecord(nested) || Array.isArray(nested)) {
      records.push(...collectArtifactEvidenceRecords(nested, `${prefix}.${key}`, depth + 1));
    }
  }
  return records;
}

function parseJsonValue(rawText) {
  try {
    return { value: JSON.parse(rawText), error: undefined };
  } catch (error) {
    return { value: undefined, error: `JSON parse error: ${toErrorMessage(error)}` };
  }
}

function isUsableOrderEvidenceSuffix(value) {
  if (!hasText(value)) {
    return false;
  }
  const text = value.trim();
  const normalized = text.toLowerCase().replace(/[\s"'`]/gu, "");
  const bracketless = normalized.replace(/[<>\[\](){}]/gu, "");
  const compact = bracketless.replace(/[-_]/gu, "");
  const placeholderWords = new Set([
    "broker-order-id",
    "broker-order-id-suffix",
    "broker_order_id",
    "broker_order_id_suffix",
    "brokerorderid",
    "brokerorderidsuffix",
    "identifier",
    "identifier-suffix",
    "identifier_suffix",
    "identifiersuffix",
    "order-id",
    "order_id",
    "orderid",
    "order-suffix",
    "order_suffix",
    "orderid-suffix",
    "order_id_suffix",
    "orderidsuffix",
    "ordersuffix",
    "redacted",
    "masked",
    "hidden",
    "fixture",
    "fixture-identifier",
    "fixture_identifier",
    "fixtureidentifier",
    "fixture-order",
    "fixture_order",
    "fixtureorder",
    "removed",
    "secret",
    "token",
    "uuid",
    "uuid-suffix",
    "uuid_suffix",
    "uuidsuffix",
  ]);
  const alnumCount = (text.match(/[a-z0-9]/giu) ?? []).length;
  return text.length >= 6
    && alnumCount >= 4
    && !placeholderWords.has(bracketless)
    && !placeholderWords.has(compact)
    && !/^(?:x+|\*+|-+|_+|\.+)$/u.test(normalized);
}

function isForbiddenKeyScope(scope) {
  const normalized = scope.trim().toLowerCase();
  return forbiddenKeyScopeMarkers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function isWithdrawalScope(scope) {
  const normalized = scope.trim().toLowerCase();
  return withdrawalScopeMarkers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function normalizeTerminalState(value) {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "CANCEL" || normalized === "CANCELED" || normalized === "CANCELLED") {
    return "CANCEL";
  }
  return normalized;
}

function normalizeTimeInForce(value) {
  return value?.trim().toUpperCase().replace(/-/g, "_");
}

function readTimestampMs(value) {
  const text = readString(value);
  if (text === undefined) {
    return undefined;
  }
  // 날짜만 있는 값은 submit/cancel 순서의 실제 시각을 증명하지 못하므로 시간 성분을 요구한다.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u.test(text)) {
    return undefined;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const normalizedText = normalizeIsoTimestampText(text);
  if (normalizedText === undefined || new Date(timestamp).toISOString() !== normalizedText) {
    return undefined;
  }
  return timestamp;
}

function normalizeIsoTimestampText(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  return `${match[1]}.${match[2] ?? "000"}Z`;
}

function readTimestampMsFromAliases(record, aliases) {
  const value = readStringFromAliases(record, aliases);
  return value === undefined ? undefined : readTimestampMs(value);
}

function readTimestampMsAliasValues(record, aliases) {
  return readStringAliasValues(record, aliases)
    .map((actual) => ({ alias: actual.alias, value: readTimestampMs(actual.value) }))
    .filter((actual) => actual.value !== undefined);
}

function readNumber(value) {
  const number = Number(readStringOrNumber(value));
  return Number.isFinite(number) ? number : undefined;
}

function readNumberFromAliases(record, aliases) {
  for (const alias of aliases) {
    const value = readNumber(record[alias]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readNumberAliasValues(record, aliases) {
  return aliases
    .map((alias) => ({ alias, value: readNumber(record[alias]) }))
    .filter((actual) => actual.value !== undefined);
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringFromAliases(record, aliases) {
  for (const alias of aliases) {
    const value = readString(record[alias]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readStringAliasValues(record, aliases) {
  return aliases
    .map((alias) => ({ alias, value: readString(record[alias]) }))
    .filter((actual) => actual.value !== undefined);
}

function readStringOrNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function readRecord(value) {
  return isRecord(value) ? value : {};
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function readCsvString(value) {
  return hasText(value) ? value.split(",").map((item) => item.trim()).filter(hasText) : [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasMeaningfulEnvValue(value) {
  if (!hasText(value)) {
    return false;
  }
  const normalized = value.trim();
  // fake/example 계열 값은 파일이 존재해도 production credential evidence가 아니므로 operator input으로 인정하지 않는다.
  return normalized !== "0"
    && !/(?:<[^>]+>|redacted|\[redacted\])/iu.test(normalized)
    && !/(?:^|[-_\s:])(fake|dummy|example|changeme|placeholder|test|fixture)(?:$|[-_\s:])/iu.test(normalized);
}

function collectUnique(values) {
  return [...new Set(values)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function splitCommandTokens(command) {
  const tokens = [];
  let current = "";
  let quote = undefined;
  for (const char of command.trim()) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function stripShellQuotes(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function isOutsideRepositoryResolvedPath(resolvedPath) {
  const resolved = path.resolve(resolvedPath);
  const relative = path.relative(repositoryRoot, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function resolveInputPath(filePath, baseDir) {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function expandHome(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
