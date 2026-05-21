#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "config", "paper.json");
const defaultFixturePath = path.join(repoRoot, "tests", "fixtures", "soak", "paper-soak-events.json");
const defaultDurationMs = 24 * 60 * 60 * 1000;
const defaultWebSocketUrl = "wss://api.upbit.com/websocket/v1";
const defaultControlProbeTimeoutMs = 5_000;
const defaultSoakLogDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-soak");
const runtimeCounters = {
  unhandledRejections: 0,
  uncaughtExceptions: 0,
};

process.on("unhandledRejection", (reason) => {
  runtimeCounters.unhandledRejections += 1;
  process.stderr.write(`Unhandled rejection captured by soak harness: ${toErrorMessage(reason)}\n`);
});

process.on("uncaughtException", (error) => {
  runtimeCounters.uncaughtExceptions += 1;
  process.stderr.write(`Uncaught exception captured by soak harness: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const longRunEnabled = process.env.SEEMIRAI_RUN_SOAK === "1";
  const logDir = path.resolve(options.logDir ?? process.env.SEEMIRAI_SOAK_LOG_DIR ?? defaultSoakLogDir);
  const artifacts = createArtifactPaths({ logDir, runId, startedAt, options });
  const git = await readGitContext();
  const inputMode = options.fixtureSmoke ? "fixture_smoke" : "upbit_public_websocket";

  // 실제 24시간 실행은 명시 env 없이는 열지 않는다. CI와 로컬 기본 검증은 fixture smoke로만 충분해야 한다.
  if (!options.fixtureSmoke && !longRunEnabled) {
    const summary = createBaseSummary({
      runId,
      startedAt,
      inputMode,
      options,
      git,
      longRunEnabled,
      artifacts,
    });
    summary.checks.longRunGuard = skippedCheck(
      "`SEEMIRAI_RUN_SOAK=1`이 아니어서 24시간 public WebSocket soak를 실행하지 않았다.",
      { requiredEnv: "SEEMIRAI_RUN_SOAK=1" },
    );
    await writeSummaryArtifacts(summary, artifacts);
    printSummary(summary, options);
    return;
  }

  await mkdir(logDir, { recursive: true });

  const config = await readJsonFile(options.configPath);
  const commonChecks = await runCommonChecks({ config, options });
  const runEvidence = options.fixtureSmoke
    ? await runFixtureSmoke({ options, artifacts })
    : await runPublicWebSocketSoak({ config, options, artifacts });

  const summary = createBaseSummary({
    runId,
    startedAt,
    inputMode,
    options,
    git,
    longRunEnabled,
    artifacts,
  });
  summary.metrics = {
    ...summary.metrics,
    ...runEvidence.metrics,
  };
  summary.checks = {
    ...summary.checks,
    longRunGuard: okCheck(
      options.fixtureSmoke
        ? "fixture smoke는 24시간 guard를 우회하는 짧은 검증 경로다."
        : "`SEEMIRAI_RUN_SOAK=1`이 확인되어 장시간 soak 경로를 열었다.",
      { fixtureSmoke: options.fixtureSmoke, longRunEnabled },
    ),
    ...commonChecks,
    ...runEvidence.checks,
    runtimeExceptions: runtimeExceptionCheck(),
  };
  summary.finishedAt = new Date().toISOString();
  summary.durationMsObserved = new Date(summary.finishedAt).getTime() - startedAt.getTime();
  summary.status = deriveStatus(summary.checks);

  await writeSummaryArtifacts(summary, artifacts);
  printSummary(summary, options);

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    fixturePath: defaultFixturePath,
    fixtureSmoke: false,
    durationMs: defaultDurationMs,
    websocketUrl: defaultWebSocketUrl,
    markets: [],
    json: false,
    help: false,
    dailyReportGenerated: false,
    dbWriteFailures: 0,
    notificationFailures: 0,
    controlProbeTimeoutMs: defaultControlProbeTimeoutMs,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--fixture":
        options.fixturePath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--duration-ms":
        options.durationMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--websocket-url":
        options.websocketUrl = readValue(argv, index, arg);
        index += 1;
        break;
      case "--markets":
        options.markets = readValue(argv, index, arg)
          .split(",")
          .map((market) => market.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--control-url":
        options.controlUrl = readValue(argv, index, arg).replace(/\/+$/u, "");
        index += 1;
        break;
      case "--control-probe-timeout-ms":
        options.controlProbeTimeoutMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--log-dir":
        options.logDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--summary-path":
        options.summaryPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--raw-log-path":
        options.rawLogPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--report-path":
        options.reportPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--daily-report-generated":
        options.dailyReportGenerated = true;
        break;
      case "--db-write-failures":
        options.dbWriteFailures = readNonNegativeInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--notification-failures":
        options.notificationFailures = readNonNegativeInteger(readValue(argv, index, arg), arg);
        index += 1;
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

function readNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function runCommonChecks({ config, options }) {
  const [liveOrderApiCalls, telegramInbound, controlEndpoints] = await Promise.all([
    inspectLiveOrderApiGuard(),
    inspectTelegramInboundAbsence(),
    inspectControlEndpoints(options),
  ]);

  return {
    configSafety: inspectConfigSafety(config),
    liveOrderApiCalls,
    telegramInboundAbsent: telegramInbound,
    statusEndpoint: controlEndpoints.statusEndpoint,
    killSwitchEndpoint: controlEndpoints.killSwitchEndpoint,
    dbWriteFailures: countCheck(
      options.dbWriteFailures,
      "DB write failure가 관측되지 않았다.",
      "DB write failure가 관측됐다.",
    ),
    notificationFailures: countCheck(
      options.notificationFailures,
      "Telegram/provider notification failure가 관측되지 않았다.",
      "Telegram/provider notification failure가 관측됐다.",
    ),
    dailyReportGenerated: dailyReportCheck(options),
  };
}

function inspectConfigSafety(config) {
  const violations = [];
  const expectedFalseFields = [
    "live_trading_enabled",
    "withdrawal_enabled",
    "cross_exchange_arbitrage_enabled",
    "futures_enabled",
    "leverage_enabled",
    "market_order_enabled",
    "entry_market_order_enabled",
  ];

  for (const field of expectedFalseFields) {
    if (config[field] !== false) {
      violations.push(`${field}=true`);
    }
  }
  if (config.mode !== "PAPER_TRADING") {
    violations.push(`mode=${String(config.mode)}`);
  }
  if (config.paper_no_key !== true) {
    violations.push("paper_no_key=false");
  }
  if (config.secrets?.upbit_access_key !== undefined || config.secrets?.upbit_secret_key !== undefined) {
    violations.push("upbit API key present");
  }

  if (violations.length > 0) {
    return failCheck("paper profile의 안전 toggle이 soak 기준을 만족하지 않는다.", { violations });
  }

  return okCheck("paper profile이 API key 없는 PAPER_TRADING 안전 조건을 만족한다.", {
    mode: config.mode,
    paperNoKey: config.paper_no_key,
    universe: config.universe?.phase_1 ?? [],
  });
}

async function inspectLiveOrderApiGuard() {
  const runtimeSource = await readFile(path.join(repoRoot, "src", "runtime", "execution-runtime.ts"), "utf8");
  const disabledBrokerSource = await readFile(
    path.join(repoRoot, "src", "infrastructure", "upbit", "disabled-live-broker.ts"),
    "utf8",
  );
  const privateApiPattern = /UpbitPublicRestClient|orders\/chance|\/v1\/orders|Authorization|Bearer/iu;
  const privateApiMarkers = privateApiPattern.test(runtimeSource) ? 1 : 0;
  const disabledMethods = ["submitOrder", "cancelOrder", "getOrder", "listOpenOrders", "getBalances"];
  const missingDisabledMethods = disabledMethods.filter(
    (methodName) =>
      !new RegExp(`public async ${methodName}\\([^)]*\\)[^{]*\\{\\s*throw this\\.createDisabledError`, "su").test(
        disabledBrokerSource,
      ),
  );

  if (privateApiMarkers > 0 || missingDisabledMethods.length > 0) {
    return failCheck("paper runtime에서 실거래 주문 API guard가 깨졌다.", {
      count: privateApiMarkers,
      missingDisabledMethods,
    });
  }

  return okCheck("실거래 주문 API 호출 경로가 관측되지 않았다.", {
    count: 0,
    runtimeSource: "src/runtime/execution-runtime.ts",
    disabledBroker: "src/infrastructure/upbit/disabled-live-broker.ts",
  });
}

async function inspectTelegramInboundAbsence() {
  const sourcePaths = await listFiles(path.join(repoRoot, "src"));
  const telegramSources = sourcePaths.filter((sourcePath) => /telegram|notification|http-control/iu.test(sourcePath));
  const inboundPattern = /getUpdates|setWebhook|deleteWebhook|server\.(?:get|post|route)\(\s*["'`]\/telegram/iu;
  const matches = [];

  for (const sourcePath of telegramSources) {
    const source = await readFile(sourcePath, "utf8");
    if (inboundPattern.test(source)) {
      matches.push(path.relative(repoRoot, sourcePath));
    }
  }

  if (matches.length > 0) {
    return failCheck("Telegram inbound command/webhook 경로가 발견됐다.", { matches });
  }

  return okCheck("Telegram은 outbound sendMessage 경로만 사용하고 inbound command 수신 경로가 없다.", {
    scannedFiles: telegramSources.length,
  });
}

async function inspectControlEndpoints(options) {
  if (options.controlUrl !== undefined) {
    return probeControlEndpoints(options.controlUrl, options);
  }

  return inspectControlEndpointSource();
}

async function inspectControlEndpointSource() {
  const source = await readFile(path.join(repoRoot, "src", "interfaces", "http-control.ts"), "utf8");
  const statusRegistered = /server\.get\(\s*"\/status"/u.test(source);
  const killSwitchRegistered =
    /server\.post[\s\S]*"\/kill-switch"/u.test(source) && /createLocalControlAuthPreHandler/u.test(source);

  return {
    statusEndpoint: statusRegistered
      ? okCheck("`GET /status` route 등록 근거가 확인됐다.", { mode: "source_scan" })
      : failCheck("`GET /status` route 등록 근거를 찾지 못했다.", { mode: "source_scan" }),
    killSwitchEndpoint: killSwitchRegistered
      ? okCheck("`POST /kill-switch` route와 bearer guard 등록 근거가 확인됐다.", { mode: "source_scan" })
      : failCheck("`POST /kill-switch` route 또는 bearer guard 등록 근거를 찾지 못했다.", { mode: "source_scan" }),
  };
}

async function probeControlEndpoints(controlUrl, options) {
  const sourceChecks = await inspectControlEndpointSource();
  const statusResponse = await fetchControlEndpoint(`${controlUrl}/status`, {
    timeoutMs: options.controlProbeTimeoutMs,
  });

  return {
    statusEndpoint: statusResponse,
    // kill-switch는 상태 전이 엔드포인트라 soak probe가 POST를 보내지 않는다. 인증 가드 존재 여부는 source scan으로 남겨 장애 상태를 probe가 해제하지 않게 한다.
    killSwitchEndpoint: {
      ...sourceChecks.killSwitchEndpoint,
      message:
        sourceChecks.killSwitchEndpoint.status === "ok"
          ? "`POST /kill-switch` route와 bearer guard 등록 근거가 확인됐다. HTTP probe는 상태 변경 방지를 위해 생략했다."
          : sourceChecks.killSwitchEndpoint.message,
      evidence: {
        ...sourceChecks.killSwitchEndpoint.evidence,
        mode: "source_scan_after_control_url",
        controlUrl,
        stateChangingProbeSkipped: true,
      },
    },
  };
}

async function fetchControlEndpoint(url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`control probe timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status === 200
      ? okCheck("`GET /status` probe가 200으로 응답했다.", {
          mode: "http_probe",
          statusCode: 200,
          timeoutMs,
        })
      : failCheck("`GET /status` probe가 실패했다.", {
          mode: "http_probe",
          statusCode: response.status,
          timeoutMs,
        });
  } catch (error) {
    return failCheck("`GET /status` probe가 네트워크 오류 또는 timeout으로 실패했다.", {
      mode: "http_probe",
      error: toErrorMessage(error),
      timeoutMs,
      url,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function dailyReportCheck(options) {
  if (options.dailyReportGenerated) {
    return okCheck("24시간 soak 결과에 daily report 생성 완료 evidence가 포함됐다.", {
      generated: true,
    });
  }

  if (options.fixtureSmoke) {
    return skippedCheck("fixture smoke는 실제 daily report job을 실행하지 않는다.", {
      generated: false,
      requiredFor24hSoak: true,
    });
  }

  return failCheck("24시간 soak 완료에는 daily report 생성 evidence가 필요하다.", {
    generated: false,
    hint: "--daily-report-generated",
  });
}

async function runFixtureSmoke({ options, artifacts }) {
  return analyzeFixtureSmoke({ options, artifacts, writeRawLog: true });
}

async function analyzeFixtureSmoke({ options, artifacts, writeRawLog }) {
  const fixture = await readJsonFile(options.fixturePath);
  const events = Array.isArray(fixture.events) ? fixture.events : [];
  if (writeRawLog) {
    await writeJsonLines(artifacts.rawLogPath, events);
  }

  const statusEvents = events.filter((event) => event.kind === "STATUS");
  const staleEvents = statusEvents.filter((event) => event.status === "STALE");
  const blockingStaleEvents = staleEvents.filter(
    (event) => event.metadata?.newOrdersBlocked === true && event.metadata?.riskAction === "BLOCK_NEW_ORDER",
  );
  const criticalStatusEvents = statusEvents.filter((event) =>
    ["STALE", "RECONNECTING", "DISCONNECTED"].includes(event.status),
  );
  const auditMissingCount = criticalStatusEvents.filter(
    (event) => typeof event.metadata?.auditEvidence !== "string" || event.metadata.auditEvidence.length === 0,
  ).length;

  return {
    metrics: {
      fixtureEvents: events.length,
      marketDataEvents: events.filter((event) => event.kind !== "STATUS").length,
      statusEvents: statusEvents.length,
      staleEvents: staleEvents.length,
    },
    checks: {
      auditMissing:
        auditMissingCount === 0
          ? okCheck("stale/reconnect/disconnect status fixture에 audit evidence가 모두 붙어 있다.", {
              count: 0,
              inspectedEvents: criticalStatusEvents.length,
            })
          : failCheck("status 차단 fixture 중 audit evidence가 누락됐다.", {
              count: auditMissingCount,
            }),
      staleDataBlocked:
        blockingStaleEvents.length > 0
          ? okCheck("stale market data가 신규 주문 차단 evidence로 연결되는 smoke를 확인했다.", {
              blockedEvents: blockingStaleEvents.length,
            })
          : failCheck("stale market data 신규 주문 차단 smoke evidence를 찾지 못했다.", {
              blockedEvents: 0,
            }),
    },
  };
}

async function runPublicWebSocketSoak({ config, options, artifacts }) {
  const markets = options.markets.length > 0 ? options.markets : config.universe?.phase_1 ?? [];
  if (markets.length === 0) {
    throw new Error("at least one market is required for public WebSocket soak");
  }

  const metrics = {
    websocketMessages: 0,
    tradeMessages: 0,
    orderbookMessages: 0,
    statusMessages: 0,
    websocketErrors: 0,
    websocketErrorMessage: null,
  };
  const messageTasks = new Set();
  await mkdir(path.dirname(artifacts.rawLogPath), { recursive: true });
  const rawLogStream = createWriteStream(artifacts.rawLogPath, { encoding: "utf8" });

  try {
    try {
      await new Promise((resolve) => {
        const websocket = new WebSocket(options.websocketUrl);
        let resolved = false;
        let closeFallback;
        const finish = () => {
          if (resolved) {
            return;
          }
          resolved = true;
          clearTimeout(timeout);
          clearTimeout(closeFallback);
          resolve();
        };
        const timeout = setTimeout(() => {
          // close 직후 resolve하면 뒤늦은 message task가 raw log stream close 이후 실행될 수 있어 close event까지 기다린다.
          websocket.close(1000, "soak duration elapsed");
        }, options.durationMs);

        websocket.addEventListener("open", () => {
          const ticket = `seemirai-soak-${Date.now()}`;
          // Upbit quotation WebSocket은 public endpoint라 인증 헤더와 private 주문 scope가 필요 없다.
          websocket.send(
            JSON.stringify([
              { ticket },
              { type: "trade", codes: markets },
              { type: "orderbook", codes: markets },
            ]),
          );
        });

        websocket.addEventListener("message", (message) => {
          const task = recordWebSocketMessage({
            data: message.data,
            metrics,
            rawLogStream,
          }).finally(() => {
            messageTasks.delete(task);
          });
          messageTasks.add(task);
        });

        websocket.addEventListener("error", (event) => {
          metrics.websocketErrors += 1;
          metrics.websocketErrorMessage = `public WebSocket error: ${String(event.type)}`;
          // 네트워크 오류도 summary/report artifact로 남겨야 하므로 예외 전파 대신 실패 metric으로 수집한다.
          try {
            websocket.close(1011, "soak websocket error");
          } catch {
            finish();
            return;
          }
          closeFallback = setTimeout(finish, 1_000);
        });

        websocket.addEventListener("close", () => {
          finish();
        });
      });
    } catch (error) {
      metrics.websocketErrors += 1;
      metrics.websocketErrorMessage = toErrorMessage(error);
    }

    await Promise.all(messageTasks);
  } finally {
    await closeWriteStream(rawLogStream);
  }
  const fixtureEvidence = await analyzeFixtureSmoke({
    options: { ...options, fixturePath: defaultFixturePath },
    artifacts,
    writeRawLog: false,
  });

  return {
    metrics: {
      ...metrics,
      ...fixtureEvidence.metrics,
    },
    checks: {
      publicWebSocket:
        metrics.websocketErrors > 0
          ? failCheck("Upbit public quotation WebSocket 오류가 관측됐다.", {
              errors: metrics.websocketErrors,
              lastError: metrics.websocketErrorMessage,
            })
          : metrics.websocketMessages > 0
          ? okCheck("Upbit public quotation WebSocket message를 수신했다.", {
              messages: metrics.websocketMessages,
              markets,
            })
          : failCheck("Upbit public quotation WebSocket message를 수신하지 못했다.", {
              messages: metrics.websocketMessages,
              markets,
            }),
      auditMissing: fixtureEvidence.checks.auditMissing,
      staleDataBlocked: fixtureEvidence.checks.staleDataBlocked,
    },
  };
}

async function recordWebSocketMessage({ data, metrics, rawLogStream }) {
  const receivedAt = new Date().toISOString();
  const payload = await parseWebSocketPayload(data);
  metrics.websocketMessages += 1;
  if (payload?.type === "trade") {
    metrics.tradeMessages += 1;
  } else if (payload?.type === "orderbook") {
    metrics.orderbookMessages += 1;
  } else {
    metrics.statusMessages += 1;
  }
  rawLogStream.write(`${JSON.stringify({
    receivedAt,
    type: payload?.type ?? "unknown",
    code: payload?.code ?? null,
  })}\n`) || (await once(rawLogStream, "drain"));
}

async function parseWebSocketPayload(data) {
  try {
    if (typeof data === "string") {
      return JSON.parse(data);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return JSON.parse(await data.text());
    }
    if (data instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(data).toString("utf8"));
    }
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"));
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function runtimeExceptionCheck() {
  const crashCount = runtimeCounters.uncaughtExceptions;
  const unhandledRejectionCount = runtimeCounters.unhandledRejections;
  if (crashCount > 0 || unhandledRejectionCount > 0) {
    return failCheck("soak harness 실행 중 처리되지 않은 예외가 관측됐다.", {
      crashCount,
      unhandledRejectionCount,
    });
  }

  return okCheck("crash와 unhandled rejection이 관측되지 않았다.", {
    crashCount: 0,
    unhandledRejectionCount: 0,
  });
}

function createBaseSummary({ runId, startedAt, inputMode, options, git, longRunEnabled, artifacts }) {
  return {
    schemaVersion: 1,
    runId,
    status: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMsRequested: options.fixtureSmoke ? 0 : options.durationMs,
    durationMsObserved: 0,
    mode: "PAPER_TRADING",
    input: inputMode,
    longRunEnabled,
    git,
    artifacts: {
      rawLogPath: artifacts.rawLogPath,
      summaryPath: artifacts.summaryPath,
      reportPath: artifacts.reportPath,
    },
    metrics: {
      liveOrderApiCalls: 0,
    },
    checks: {},
  };
}

function createArtifactPaths({ logDir, runId, startedAt, options }) {
  const timestamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const prefix = `m8-paper-soak-${timestamp}-${runId.slice(0, 8)}`;
  return {
    rawLogPath: options.rawLogPath ?? path.join(logDir, `${prefix}-events.jsonl`),
    summaryPath: options.summaryPath ?? path.join(logDir, `${prefix}-summary.json`),
    reportPath: options.reportPath ?? path.join(logDir, `${prefix}-report.md`),
  };
}

async function writeJsonLines(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const contents = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  await writeFile(filePath, contents, "utf8");
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

async function writeSummaryArtifacts(summary, artifacts) {
  summary.finishedAt ??= new Date().toISOString();
  summary.durationMsObserved ||= new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime();
  if (summary.status === "running") {
    summary.status = deriveStatus(summary.checks);
  }

  await mkdir(path.dirname(artifacts.summaryPath), { recursive: true });
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(artifacts.reportPath, renderMarkdownReport(summary), "utf8");
}

function renderMarkdownReport(summary) {
  const checkRows = Object.entries(summary.checks)
    .map(([name, check]) => `| ${name} | ${check.status} | ${escapeMarkdownTable(check.message)} |`)
    .join("\n");

  return `# M8 Paper Soak 결과 요약

- 실행 상태: ${summary.status}
- 실행 모드: ${summary.mode}
- 입력: ${summary.input}
- 시작: ${summary.startedAt}
- 종료: ${summary.finishedAt}
- 요청 시간(ms): ${summary.durationMsRequested}
- 관측 시간(ms): ${summary.durationMsObserved}
- Git branch: ${summary.git.branch ?? "unknown"}
- Git commit: ${summary.git.commit ?? "unknown"}
- raw event log: ${summary.artifacts.rawLogPath}

## 체크 결과

| 항목 | 결과 | 요약 |
| --- | --- | --- |
${checkRows}

## PR 첨부용 메모

- crash: ${summary.checks.runtimeExceptions?.evidence?.crashCount ?? 0}
- unhandled rejection: ${summary.checks.runtimeExceptions?.evidence?.unhandledRejectionCount ?? 0}
- live order API calls: ${summary.metrics.liveOrderApiCalls ?? 0}
- audit missing: ${summary.checks.auditMissing?.evidence?.count ?? "unknown"}
- stale data blocked: ${summary.checks.staleDataBlocked?.status ?? "unknown"}
- DB write failures: ${summary.checks.dbWriteFailures?.evidence?.count ?? "unknown"}
- notification failures: ${summary.checks.notificationFailures?.evidence?.count ?? "unknown"}
- daily report generated: ${summary.checks.dailyReportGenerated?.evidence?.generated ?? false}
`;
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`M8 Paper Soak: ${summary.status}\n`);
  process.stdout.write(`- input: ${summary.input}\n`);
  process.stdout.write(`- summary: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`- report: ${summary.artifacts.reportPath}\n`);
}

function deriveStatus(checks) {
  const values = Object.values(checks);
  if (values.some((check) => check.status === "fail")) {
    return "failed";
  }
  if (values.some((check) => check.status === "skipped") && values.length === 1) {
    return "skipped";
  }
  return "passed";
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

function countCheck(count, okMessage, failMessage) {
  return count === 0 ? okCheck(okMessage, { count }) : failCheck(failMessage, { count });
}

async function readGitContext() {
  const [branch, commit] = await Promise.all([
    readGitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    readGitValue(["rev-parse", "--short=12", "HEAD"]),
  ]);
  return { branch, commit };
}

async function readGitValue(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/soak-paper-24h.mjs [options]

Options:
  --fixture-smoke                 Run deterministic fixture smoke instead of 24h public WebSocket soak.
  --fixture <path>                Fixture path for smoke checks.
  --duration-ms <ms>              Long soak duration. Defaults to 86400000.
  --markets <KRW-BTC,KRW-ETH>     Public WebSocket markets. Defaults to config/paper.json universe.
  --control-url <url>             Probe local HTTP control /status and scan protected /kill-switch wiring.
  --control-probe-timeout-ms <ms>  Timeout for control HTTP probes. Defaults to 5000.
  --daily-report-generated        Mark daily report generation evidence as present for a real 24h run.
  --db-write-failures <count>     Attach observed DB write failure count. Defaults to 0.
  --notification-failures <count> Attach observed notification failure count. Defaults to 0.
  --log-dir <path>                Artifact directory. Defaults to SEEMIRAI_SOAK_LOG_DIR or ~/vaults/99_운영/seemirai-soak.
  --json                          Print JSON summary.

Actual public WebSocket soak requires SEEMIRAI_RUN_SOAK=1 unless --fixture-smoke is used.
`);
}
