#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigPath = path.join(repoRoot, "config", "paper.json");
const defaultFixturePath = path.join(repoRoot, "tests", "fixtures", "m9", "paper-decision-runner.json");
const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper", "trading-soak");
const defaultWebSocketUrl = "wss://api.upbit.com/websocket/v1";
const defaultDays = 3;
const defaultDayMs = 24 * 60 * 60 * 1000;
const defaultCycleIntervalMs = 60_000;
const defaultMinimumOrderbookStalenessMs = 5_000;
const runtimeCounters = {
  unhandledRejections: 0,
  uncaughtExceptions: 0,
};
let stopRequested = false;

process.on("unhandledRejection", (reason) => {
  runtimeCounters.unhandledRejections += 1;
  process.stderr.write(`M9 paper trading soak unhandled rejection: ${toErrorMessage(reason)}\n`);
});

process.on("uncaughtException", (error) => {
  runtimeCounters.uncaughtExceptions += 1;
  process.stderr.write(`M9 paper trading soak uncaught exception: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});

process.on("SIGINT", () => {
  stopRequested = true;
  process.stderr.write("M9 paper trading soak 중단 요청을 받았다. 현재 cycle을 정리하고 summary를 기록한다.\n");
});

process.on("SIGTERM", () => {
  stopRequested = true;
  process.stderr.write("M9 paper trading soak 종료 요청을 받았다. 현재 cycle을 정리하고 summary를 기록한다.\n");
});

try {
  await main();
} catch (error) {
  await handleFatalError(error);
}

async function main() {
  const options = finalizeOptions(parseArgs(process.argv.slice(2)));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const longRunEnabled = process.env.SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK === "1";
  const artifactDir = path.resolve(options.artifactDir ?? process.env.SEEMIRAI_M9_ARTIFACT_DIR ?? defaultArtifactDir);
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId, options });
  const git = await readGitContext();
  const inputMode = options.fixtureSmoke ? "m9_paper_trading_fixture_loop" : "upbit_public_websocket_paper_trading_loop";

  if (!options.fixtureSmoke && !longRunEnabled) {
    const summary = createSkippedSummary({ runId, startedAt, inputMode, options, git, artifacts });
    await writeSummaryAndReport(summary, artifacts.summaryPath, artifacts.reportPath);
    printSummary(summary, options);
    return;
  }

  const fixture = await readJsonFile(options.fixturePath);
  const config = await readJsonFile(options.configPath);
  const runtime = await importCompiledRuntime();
  const rawLog = createJsonlWriter(artifacts.rawLogPath);
  const state = createSoakState({ options, startedAt, artifacts });
  const websocketFeed = options.fixtureSmoke
    ? undefined
    : startPublicMarketDataFeed({
        options,
        config,
        rawLog,
        state,
      });

  try {
    await runTradingCycles({
      options,
      fixture,
      runtime,
      rawLog,
      state,
      getLatestOrderbook: () => websocketFeed?.latestOrderbook() ?? null,
    });
  } finally {
    await websocketFeed?.stop();
    await rawLog.close();
  }

  const finishedAt = new Date();
  const summary = createCompletedSummary({
    runId,
    startedAt,
    finishedAt,
    inputMode,
    options,
    git,
    artifacts,
    state,
  });
  const dailyStartedAt = new Date(state.startedAtMs);
  const dailySummaries = state.dailyBuckets.map((bucket, index) =>
    createDailySummary({
      parentRunId: runId,
      dayIndex: index,
      startedAt: dailyStartedAt,
      finishedAt,
      inputMode,
      options,
      git,
      artifacts,
      bucket,
      aggregateRawLogPath: artifacts.rawLogPath,
      interrupted: state.interrupted,
    }),
  );

  // 운영 evidence는 daily summary/report와 raw log가 모두 성공한 뒤 aggregate summary를 마지막에 남긴다.
  await writeDailyArtifacts(dailySummaries, artifacts);
  await writeSummaryAndReport(summary, artifacts.summaryPath, artifacts.reportPath);
  printSummary(summary, options);

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

async function handleFatalError(error) {
  runtimeCounters.uncaughtExceptions += 1;
  const startedAt = new Date();
  const runId = randomUUID();
  const options = finalizeOptions(parseArgsForFailure(process.argv.slice(2)));
  const artifactDir = path.resolve(options.artifactDir ?? process.env.SEEMIRAI_M9_ARTIFACT_DIR ?? defaultArtifactDir);
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId, options });
  const git = await readGitContext();
  const inputMode = options.fixtureSmoke ? "m9_paper_trading_fixture_loop" : "upbit_public_websocket_paper_trading_loop";
  const finishedAt = new Date();
  const checks = {
    fatalError: failCheck("runner 예외가 발생해 실패 summary를 기록했다.", {
      message: toErrorMessage(error),
    }),
    runtimeExceptions: runtimeExceptionCheck(),
  };
  const summary = createBaseSummary({
    runId,
    startedAt,
    finishedAt,
    inputMode,
    options,
    git,
    artifacts,
    metrics: createEmptyTradingMetrics(),
    checks,
    status: "failed",
  });

  // 예외 경계에서도 JSON summary와 raw log를 남겨 운영 자동화가 실패 원인을 잃지 않게 한다.
  await writeFailureArtifacts({ summary, artifacts, error });
  printSummary(summary, options);
  process.exitCode = 1;
}

function parseArgsForFailure(argv) {
  try {
    return parseArgs(argv);
  } catch {
    return {
      configPath: defaultConfigPath,
      fixturePath: defaultFixturePath,
      fixtureSmoke: argv.includes("--fixture-smoke"),
      websocketUrl: defaultWebSocketUrl,
      markets: [],
      json: argv.includes("--json"),
      help: false,
      dailyReportGenerated: argv.includes("--daily-report-generated"),
      dbWriteFailures: 0,
      notificationFailures: 0,
      days: defaultDays,
      dayMs: defaultDayMs,
      cycleIntervalMs: defaultCycleIntervalMs,
    };
  }
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    fixturePath: defaultFixturePath,
    fixtureSmoke: false,
    websocketUrl: defaultWebSocketUrl,
    markets: [],
    json: false,
    help: false,
    dailyReportGenerated: false,
    dbWriteFailures: 0,
    notificationFailures: 0,
    days: defaultDays,
    dayMs: defaultDayMs,
    cycleIntervalMs: defaultCycleIntervalMs,
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
      case "--days":
        options.days = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--day-ms":
        options.dayMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--cycle-interval-ms":
        options.cycleIntervalMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--max-orderbook-staleness-ms":
        options.maxOrderbookStalenessMs = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--cycles-per-day":
        options.cyclesPerDay = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--max-cycles":
        options.maxCycles = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--max-frames":
        options.maxFrames = readPositiveInteger(readValue(argv, index, arg), arg);
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
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
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

function finalizeOptions(options) {
  if (options.fixtureSmoke && options.durationMs === undefined && options.maxCycles === undefined) {
    options.maxCycles = 1;
  }
  options.durationMs ??= options.days * options.dayMs;
  options.maxOrderbookStalenessMs ??= Math.max(options.cycleIntervalMs * 2, defaultMinimumOrderbookStalenessMs);
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

async function importCompiledRuntime() {
  const compileDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-paper-trading-soak-compile-"));
  try {
    const tscArgs = [
      "-p",
      path.join(repoRoot, "tsconfig.m9-runner.json"),
      "--outDir",
      compileDir,
      "--noEmit",
      "false",
    ];
    const localTsc = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

    try {
      await stat(localTsc);
      await execFileAsync(localTsc, tscArgs, { cwd: repoRoot });
    } catch (error) {
      if (await fileExists(localTsc)) {
        throw error;
      }
      await execFileAsync("corepack", ["pnpm", "exec", "tsc", ...tscArgs], { cwd: repoRoot });
    }

    await symlink(path.join(repoRoot, "node_modules"), path.join(compileDir, "node_modules"), "dir");
    const runtimePath = path.join(compileDir, "src", "runtime", "paper-decision-runner.js");
    return await import(pathToFileURL(runtimePath).href);
  } finally {
    // 장시간 smoke를 재시작해도 임시 compile 산출물이 누적되지 않게 import 직후 정리한다.
    await removeTemporaryCompileDir(compileDir);
  }
}

async function removeTemporaryCompileDir(compileDir) {
  try {
    await rm(compileDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`M9 paper trading soak 임시 compile 디렉터리 정리 실패: ${toErrorMessage(error)}\n`);
  }
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function createSoakState({ options, startedAt, artifacts }) {
  return {
    startedAtMs: startedAt.getTime(),
    cycleAttemptCount: 0,
    cycleCount: 0,
    skippedNoOrderbookCycles: 0,
    websocketMessages: 0,
    tradeMessages: 0,
    orderbookMessages: 0,
    websocketErrors: 0,
    websocketReconnects: 0,
    skippedStaleOrderbookCycles: 0,
    lastCycleAttemptAt: null,
    lastOrderbookAt: null,
    lastOrderbookUsedAt: null,
    lastOrderbookUsedForCycleAt: null,
    lastWebSocketError: null,
    lastMarketDataAt: null,
    interrupted: false,
    aggregate: createMetricAccumulator(),
    dailyBuckets: Array.from({ length: options.days }, (_, index) => ({
      dayIndex: index,
      cycleAttemptCount: 0,
      cycleCount: 0,
      skippedNoOrderbookCycles: 0,
      skippedStaleOrderbookCycles: 0,
      firstCycleAttemptAt: null,
      lastCycleAttemptAt: null,
      websocketMessages: 0,
      tradeMessages: 0,
      orderbookMessages: 0,
      lastOrderbookAt: null,
      lastOrderbookUsedAt: null,
      lastOrderbookUsedForCycleAt: null,
      lastMarketDataAt: null,
      metrics: createMetricAccumulator(),
      traceRecords: 0,
      firstCycleAt: null,
      lastCycleAt: null,
      summaryPath: artifacts.dailySummaryPaths[index],
      reportPath: artifacts.dailyReportPaths[index],
    })),
  };
}

async function runTradingCycles({ options, fixture, runtime, rawLog, state, getLatestOrderbook }) {
  const startedAtMs = Date.now();
  const endAtMs = startedAtMs + options.durationMs;
  let nextCycleAtMs = startedAtMs;
  // daily bucket 경계는 compile/setup 시간이 아니라 실제 paper trading loop가 열린 시점부터 계산한다.
  state.startedAtMs = startedAtMs;

  while (!stopRequested && Date.now() < endAtMs) {
    if (options.maxCycles !== undefined && state.cycleAttemptCount >= options.maxCycles) {
      break;
    }

    const nowMs = Date.now();
    if (nowMs < nextCycleAtMs) {
      await sleep(Math.min(nextCycleAtMs - nowMs, 1_000));
      continue;
    }

    const cycleStartedAt = new Date();
    const cycleIndex = state.cycleAttemptCount;
    const dayIndex = calculateDayIndex({ options, state, cycleIndex, cycleStartedAt });
    const bucket = state.dailyBuckets[dayIndex];
    state.cycleAttemptCount += 1;
    bucket.cycleAttemptCount += 1;
    // skip된 cycle도 운영 시도와 daily runtime evidence에 포함되어야 max-cycles가 무한 대기로 변하지 않는다.
    state.lastCycleAttemptAt = cycleStartedAt.toISOString();
    bucket.firstCycleAttemptAt ??= cycleStartedAt.toISOString();
    bucket.lastCycleAttemptAt = cycleStartedAt.toISOString();
    const latestOrderbook = getLatestOrderbook();
    const orderbookSkip = options.fixtureSmoke
      ? null
      : readOrderbookSkip({ orderbook: latestOrderbook, cycleStartedAt, options });

    if (orderbookSkip !== null) {
      incrementSkippedOrderbookCycle({ state, bucket, reason: orderbookSkip.reason });
      await rawLog.write({
        kind: "CYCLE_SKIPPED",
        cycleIndex,
        dayIndex: dayIndex + 1,
        occurredAt: cycleStartedAt.toISOString(),
        reason: orderbookSkip.reason,
        lastOrderbookAt: orderbookSkip.lastOrderbookAt,
        orderbookStalenessMs: orderbookSkip.orderbookStalenessMs,
        maxOrderbookStalenessMs: options.maxOrderbookStalenessMs,
      });
      nextCycleAtMs += options.cycleIntervalMs;
      continue;
    }

    if (!options.fixtureSmoke && latestOrderbook !== null) {
      // 최신성 evidence는 runner 종료 직전 idle 시간이 아니라 실제 cycle 진입 시점의 orderbook으로 고정한다.
      state.lastOrderbookUsedAt = latestOrderbook.receivedAt ?? null;
      state.lastOrderbookUsedForCycleAt = cycleStartedAt.toISOString();
      bucket.lastOrderbookUsedAt = latestOrderbook.receivedAt ?? null;
      bucket.lastOrderbookUsedForCycleAt = cycleStartedAt.toISOString();
    }

    const cycleFixture = createCycleFixture({
      fixture,
      cycleIndex,
      cycleStartedAt,
      orderbook: latestOrderbook,
    });
    const result = await runtime.runM9PaperDecisionFixtureSmoke({
      fixture: cycleFixture,
      maxFrames: options.maxFrames,
    });
    state.cycleCount += 1;
    bucket.cycleCount += 1;
    bucket.traceRecords += result.trace.length;
    bucket.firstCycleAt ??= cycleStartedAt.toISOString();
    bucket.lastCycleAt = new Date().toISOString();
    accumulateMetrics(state.aggregate, result.metrics);
    accumulateMetrics(bucket.metrics, result.metrics);

    await rawLog.write({
      kind: "PAPER_TRADING_CYCLE",
      cycleIndex,
      dayIndex: dayIndex + 1,
      startedAt: cycleStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      framesProcessed: result.framesProcessed,
      metrics: result.metrics,
    });

    nextCycleAtMs += options.cycleIntervalMs;
  }

  state.interrupted = stopRequested;
}

function readOrderbookSkip({ orderbook, cycleStartedAt, options }) {
  if (orderbook === null) {
    return {
      reason: "orderbook_not_ready",
      lastOrderbookAt: null,
      orderbookStalenessMs: null,
    };
  }

  const orderbookStalenessMs = calculateOrderbookStalenessMs(orderbook.receivedAt, cycleStartedAt);
  if (orderbookStalenessMs > options.maxOrderbookStalenessMs) {
    return {
      reason: "orderbook_stale",
      lastOrderbookAt: orderbook.receivedAt ?? null,
      orderbookStalenessMs,
    };
  }

  return null;
}

function incrementSkippedOrderbookCycle({ state, bucket, reason }) {
  if (reason === "orderbook_stale") {
    state.skippedStaleOrderbookCycles += 1;
    bucket.skippedStaleOrderbookCycles += 1;
    return;
  }

  state.skippedNoOrderbookCycles += 1;
  bucket.skippedNoOrderbookCycles += 1;
}

function calculateDayIndex({ options, state, cycleIndex, cycleStartedAt }) {
  if (options.cyclesPerDay !== undefined) {
    return Math.min(options.days - 1, Math.floor(cycleIndex / options.cyclesPerDay));
  }

  const elapsedMs = cycleStartedAt.getTime() - state.startedAtMs;
  return Math.min(options.days - 1, Math.max(0, Math.floor(elapsedMs / options.dayMs)));
}

function createCycleFixture({ fixture, cycleIndex, cycleStartedAt, orderbook }) {
  const cloned = JSON.parse(JSON.stringify(fixture));
  const cycleLabel = `cycle-${cycleIndex + 1}`;
  cloned.brokerClock = cycleStartedAt.toISOString();
  cloned.sourceId = `${fixture.sourceId}:${cycleLabel}`;

  cloned.frames = cloned.frames.map((frame, frameIndex) => {
    const observedAt = new Date(cycleStartedAt.getTime() + frameIndex).toISOString();
    const nextFrame = {
      ...frame,
      id: `${frame.id}:${cycleLabel}`,
      observedAt,
      metadata: {
        ...(frame.metadata ?? {}),
        cycle_index: cycleIndex,
        source_id: cloned.sourceId,
      },
    };

    if (orderbook !== null) {
      nextFrame.exchangeId = orderbook.exchangeId;
      nextFrame.market = orderbook.market;
      nextFrame.orderbook = {
        ...orderbook,
        exchangeTimestamp: orderbook.exchangeTimestamp ?? observedAt,
        receivedAt: orderbook.receivedAt ?? observedAt,
      };
      nextFrame.features = updateOrderFeaturesForOrderbook(frame.features ?? {}, orderbook, cycleLabel, nextFrame.id);
      return nextFrame;
    }

    nextFrame.features = {
      ...(frame.features ?? {}),
      idempotency_key:
        typeof frame.features?.idempotency_key === "string"
          ? `${frame.features.idempotency_key}:${cycleLabel}`
          : undefined,
    };
    if (nextFrame.features.idempotency_key === undefined) {
      delete nextFrame.features.idempotency_key;
    }
    return nextFrame;
  });

  return cloned;
}

function updateOrderFeaturesForOrderbook(features, orderbook, cycleLabel, frameId) {
  const nextFeatures = {
    ...features,
  };
  if (nextFeatures.paper_decision_signal === "ORDER") {
    const referencePrice = readReferencePriceForSide(orderbook, nextFeatures.side);
    if (referencePrice !== null) {
      const requestedQuantity = calculateQuantity(nextFeatures.requested_notional ?? "10000", referencePrice);
      nextFeatures.limit_price = referencePrice;
      nextFeatures.requested_quantity = requestedQuantity;
      // live orderbook 가격으로 재산출한 수량은 원 notional과 반올림 차이가 생기므로 RiskGate invariant에 맞춰 함께 고정한다.
      nextFeatures.requested_notional = calculateNotional(referencePrice, requestedQuantity);
    }
    nextFeatures.idempotency_key =
      typeof features.idempotency_key === "string" ? `${features.idempotency_key}:${cycleLabel}` : `${frameId}:${cycleLabel}`;
  }
  return nextFeatures;
}

function readReferencePriceForSide(orderbook, side) {
  if (side === "SELL") {
    return readBestPrice(orderbook.bids);
  }
  return readBestPrice(orderbook.asks);
}

function readBestPrice(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    return null;
  }
  const first = levels[0];
  const price = first?.price ?? first?.ask_price ?? first?.bid_price;
  return price === undefined ? null : String(price);
}

function calculateQuantity(notionalInput, priceInput) {
  const notional = Number(notionalInput);
  const price = Number(priceInput);
  if (!Number.isFinite(notional) || !Number.isFinite(price) || price <= 0) {
    return "0";
  }
  return (notional / price).toFixed(8);
}

function calculateNotional(priceInput, quantityInput) {
  const price = Number(priceInput);
  const quantity = Number(quantityInput);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) {
    return "0";
  }
  return Number((price * quantity).toFixed(8)).toString();
}

function startPublicMarketDataFeed({ options, config, rawLog, state }) {
  const markets = resolveMarkets(options, config);
  const latestOrderbooks = new Map();
  let websocket = null;
  let reconnectTimer = null;
  let stopped = false;

  const connect = () => {
    if (stopped) {
      return;
    }
    websocket = new WebSocket(options.websocketUrl);
    websocket.addEventListener("open", () => {
      const ticket = `seemirai-m9-paper-trading-${Date.now()}`;
      // public quotation WebSocket만 열어 private 주문/계정 scope가 장시간 runner에 섞이지 않게 한다.
      websocket.send(
        JSON.stringify([
          { ticket },
          { type: "trade", codes: markets },
          { type: "orderbook", codes: markets },
        ]),
      );
      void rawLog.write({
        kind: "WEBSOCKET_OPEN",
        occurredAt: new Date().toISOString(),
        markets,
      });
    });
    websocket.addEventListener("message", (message) => {
      void recordMarketDataMessage({
        data: message.data,
        state,
        options,
        latestOrderbooks,
        rawLog,
      });
    });
    websocket.addEventListener("error", (event) => {
      state.websocketErrors += 1;
      state.lastWebSocketError = `public WebSocket error: ${String(event.type)}`;
    });
    websocket.addEventListener("close", () => {
      if (stopped) {
        return;
      }
      state.websocketReconnects += 1;
      reconnectTimer = setTimeout(connect, 1_000);
    });
  };

  connect();

  return {
    latestOrderbook() {
      let latest = null;
      for (const market of markets) {
        const orderbook = latestOrderbooks.get(market);
        if (orderbook !== undefined && isFresherOrderbook(orderbook, latest)) {
          latest = orderbook;
        }
      }
      return latest;
    },
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      if (websocket !== null && websocket.readyState < WebSocket.CLOSING) {
        await new Promise((resolve) => {
          websocket.addEventListener("close", resolve, { once: true });
          websocket.close(1000, "m9 paper trading soak finished");
          setTimeout(resolve, 1_000);
        });
      }
    },
  };
}

function isFresherOrderbook(candidate, current) {
  if (current === null) {
    return true;
  }
  return readTimestampMs(candidate.receivedAt) > readTimestampMs(current.receivedAt);
}

function readTimestampMs(timestamp) {
  if (typeof timestamp !== "string") {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function resolveMarkets(options, config) {
  const markets = options.markets.length > 0 ? options.markets : config.universe?.phase_1 ?? [];
  if (markets.length === 0) {
    throw new Error("M9 paper trading soak에는 최소 1개 market이 필요하다.");
  }
  return markets;
}

async function recordMarketDataMessage({ data, state, options, latestOrderbooks, rawLog }) {
  const receivedAt = new Date().toISOString();
  const payload = await parseWebSocketPayload(data);
  const bucket = readBucketForTimestamp({ state, options, timestamp: receivedAt });
  state.websocketMessages += 1;
  state.lastMarketDataAt = receivedAt;
  if (bucket !== undefined) {
    bucket.websocketMessages += 1;
    bucket.lastMarketDataAt = receivedAt;
  }

  if (payload?.type === "trade") {
    state.tradeMessages += 1;
    if (bucket !== undefined) {
      bucket.tradeMessages += 1;
    }
  } else if (payload?.type === "orderbook") {
    state.orderbookMessages += 1;
    const orderbook = toOrderbookEvent(payload, receivedAt);
    if (orderbook !== null) {
      latestOrderbooks.set(orderbook.market, orderbook);
      state.lastOrderbookAt = receivedAt;
      if (bucket !== undefined) {
        bucket.orderbookMessages += 1;
        bucket.lastOrderbookAt = receivedAt;
      }
    }
  }

  await rawLog.write({
    kind: "MARKET_DATA",
    receivedAt,
    type: payload?.type ?? "unknown",
    market: payload?.code ?? null,
  });
}

function readBucketForTimestamp({ state, options, timestamp }) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const dayIndex = Math.min(options.days - 1, Math.max(0, Math.floor((parsed - state.startedAtMs) / options.dayMs)));
  return state.dailyBuckets[dayIndex];
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

function toOrderbookEvent(payload, receivedAt) {
  if (!Array.isArray(payload.orderbook_units) || typeof payload.code !== "string") {
    return null;
  }
  const units = payload.orderbook_units;
  return {
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: payload.code,
    asks: units
      .filter((unit) => unit.ask_price !== undefined && unit.ask_size !== undefined)
      .map((unit) => ({
        price: String(unit.ask_price),
        size: String(unit.ask_size),
      })),
    bids: units
      .filter((unit) => unit.bid_price !== undefined && unit.bid_size !== undefined)
      .map((unit) => ({
        price: String(unit.bid_price),
        size: String(unit.bid_size),
      })),
    exchangeTimestamp:
      typeof payload.timestamp === "number" ? new Date(payload.timestamp).toISOString() : receivedAt,
    receivedAt,
  };
}

function createMetricAccumulator() {
  return {
    strategyEvaluationCount: 0,
    orderCandidateCount: 0,
    orderIntentCount: 0,
    holdReasonCounts: {},
    discardReasonCounts: {},
    costRejectedCount: 0,
    riskRejectedCount: 0,
    paperOrderSubmittedCount: 0,
    paperFillCount: 0,
    blockingReasonCounts: {},
    liveOrderApiCalls: 0,
    costEvaluatedCount: 0,
    costAllowedCount: 0,
    costRejectedSummaryCount: 0,
    costBpsWeightedSum: 0,
    requiredReturnBpsWeightedSum: 0,
    marginBpsWeightedSum: 0,
    slippageObservedFillCount: 0,
    slippageBpsWeightedSum: 0,
    minSlippageBps: null,
    maxSlippageBps: null,
  };
}

function accumulateMetrics(accumulator, metrics) {
  accumulator.strategyEvaluationCount += metrics.strategyEvaluationCount;
  accumulator.orderCandidateCount += metrics.orderCandidateCount;
  accumulator.orderIntentCount += metrics.orderIntentCount;
  accumulator.costRejectedCount += metrics.costRejectedCount;
  accumulator.riskRejectedCount += metrics.riskRejectedCount;
  accumulator.paperOrderSubmittedCount += metrics.paperOrderSubmittedCount;
  accumulator.paperFillCount += metrics.paperFillCount;
  accumulator.liveOrderApiCalls += metrics.liveOrderApiCalls;
  mergeCounts(accumulator.holdReasonCounts, metrics.holdReasonCounts);
  mergeCounts(accumulator.discardReasonCounts, metrics.discardReasonCounts);
  mergeCounts(accumulator.blockingReasonCounts, metrics.blockingReasonCounts);
  accumulateCostSummary(accumulator, metrics.costSummary);
  accumulateSlippageSummary(accumulator, metrics.slippageSummary);
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function accumulateCostSummary(accumulator, costSummary) {
  const evaluatedCount = costSummary?.evaluatedCount ?? 0;
  accumulator.costEvaluatedCount += evaluatedCount;
  accumulator.costAllowedCount += costSummary?.allowedCount ?? 0;
  accumulator.costRejectedSummaryCount += costSummary?.rejectedCount ?? 0;
  accumulator.costBpsWeightedSum += readWeightedValue(costSummary?.averageCostBps, evaluatedCount);
  accumulator.requiredReturnBpsWeightedSum += readWeightedValue(costSummary?.averageRequiredReturnBps, evaluatedCount);
  accumulator.marginBpsWeightedSum += readWeightedValue(costSummary?.averageMarginBps, evaluatedCount);
}

function accumulateSlippageSummary(accumulator, slippageSummary) {
  const observedFillCount = slippageSummary?.observedFillCount ?? 0;
  accumulator.slippageObservedFillCount += observedFillCount;
  accumulator.slippageBpsWeightedSum += readWeightedValue(slippageSummary?.averageSlippageBps, observedFillCount);
  accumulator.minSlippageBps = minNullable(accumulator.minSlippageBps, slippageSummary?.minSlippageBps);
  accumulator.maxSlippageBps = maxNullable(accumulator.maxSlippageBps, slippageSummary?.maxSlippageBps);
}

function readWeightedValue(value, count) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * count : 0;
}

function minNullable(left, right) {
  const parsedRight = Number(right);
  if (!Number.isFinite(parsedRight)) {
    return left;
  }
  return left === null ? parsedRight : Math.min(left, parsedRight);
}

function maxNullable(left, right) {
  const parsedRight = Number(right);
  if (!Number.isFinite(parsedRight)) {
    return left;
  }
  return left === null ? parsedRight : Math.max(left, parsedRight);
}

function finalizeMetrics(accumulator) {
  return {
    strategyEvaluationCount: accumulator.strategyEvaluationCount,
    orderCandidateCount: accumulator.orderCandidateCount,
    orderIntentCount: accumulator.orderIntentCount,
    holdReasonCounts: sortCounts(accumulator.holdReasonCounts),
    discardReasonCounts: sortCounts(accumulator.discardReasonCounts),
    costRejectedCount: accumulator.costRejectedCount,
    riskRejectedCount: accumulator.riskRejectedCount,
    paperOrderSubmittedCount: accumulator.paperOrderSubmittedCount,
    paperFillCount: accumulator.paperFillCount,
    fillRate: calculateFillRate(accumulator.paperFillCount, accumulator.paperOrderSubmittedCount),
    costSummary: {
      evaluatedCount: accumulator.costEvaluatedCount,
      allowedCount: accumulator.costAllowedCount,
      rejectedCount: accumulator.costRejectedSummaryCount,
      averageCostBps: averageFromWeightedSum(accumulator.costBpsWeightedSum, accumulator.costEvaluatedCount),
      averageRequiredReturnBps: averageFromWeightedSum(
        accumulator.requiredReturnBpsWeightedSum,
        accumulator.costEvaluatedCount,
      ),
      averageMarginBps: averageFromWeightedSum(accumulator.marginBpsWeightedSum, accumulator.costEvaluatedCount),
    },
    slippageSummary: {
      observedFillCount: accumulator.slippageObservedFillCount,
      averageSlippageBps: averageFromWeightedSum(
        accumulator.slippageBpsWeightedSum,
        accumulator.slippageObservedFillCount,
      ),
      minSlippageBps: formatNullableNumber(accumulator.minSlippageBps),
      maxSlippageBps: formatNullableNumber(accumulator.maxSlippageBps),
    },
    blockingReasonCounts: sortCounts(accumulator.blockingReasonCounts),
    liveOrderApiCalls: accumulator.liveOrderApiCalls,
  };
}

function sortCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function calculateFillRate(fillCount, submittedCount) {
  if (submittedCount === 0) {
    return 0;
  }
  return Number((fillCount / submittedCount).toFixed(6));
}

function averageFromWeightedSum(weightedSum, count) {
  if (count === 0) {
    return null;
  }
  return String(Number((weightedSum / count).toFixed(12)));
}

function formatNullableNumber(value) {
  return value === null ? null : String(Number(value.toFixed(12)));
}

function createSkippedSummary({ runId, startedAt, inputMode, options, git, artifacts }) {
  const summary = createBaseSummary({
    runId,
    startedAt,
    finishedAt: new Date(),
    inputMode,
    options,
    git,
    artifacts,
    metrics: finalizeMetrics(createMetricAccumulator()),
    status: "skipped",
  });
  summary.checks = {
    longRunGuard: skippedCheck("`SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1`이 아니어서 3일 paper trading soak를 시작하지 않았다.", {
      requiredEnv: "SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1",
    }),
    liveOrderApiCalls: okCheck("guard 단계에서 live order API 호출은 없었다.", { count: 0 }),
    runtimeExceptions: runtimeExceptionCheck(),
  };
  return summary;
}

function createCompletedSummary({ runId, startedAt, finishedAt, inputMode, options, git, artifacts, state }) {
  const loopStartedAt = new Date(state.startedAtMs);
  const metrics = {
    ...finalizeMetrics(state.aggregate),
    paperTradingCycleAttempts: state.cycleAttemptCount,
    paperTradingCycles: state.cycleCount,
    cyclesSkippedNoOrderbook: state.skippedNoOrderbookCycles,
    cyclesSkippedStaleOrderbook: state.skippedStaleOrderbookCycles,
    websocketMessages: state.websocketMessages,
    tradeMessages: state.tradeMessages,
    orderbookMessages: state.orderbookMessages,
    websocketErrors: state.websocketErrors,
    websocketReconnects: state.websocketReconnects,
  };
  const checks = createChecks({
    options,
    state,
    metrics,
    durationMsObserved: finishedAt.getTime() - loopStartedAt.getTime(),
    requestedDurationMs: options.durationMs,
    finishedAt,
    isDaily: false,
  });
  return createBaseSummary({
    runId,
    startedAt: loopStartedAt,
    finishedAt,
    inputMode,
    options,
    git,
    artifacts,
    metrics,
    checks,
    status: deriveStatus(checks),
  });
}

function createDailySummary({
  parentRunId,
  dayIndex,
  startedAt,
  finishedAt,
  inputMode,
  options,
  git,
  artifacts,
  bucket,
  aggregateRawLogPath,
  interrupted,
}) {
  const dayStartedAt = new Date(startedAt.getTime() + dayIndex * options.dayMs);
  const dailyTiming = resolveDailyTiming({ dayStartedAt, finishedAt, options, bucket });
  const metrics = {
    ...finalizeMetrics(bucket.metrics),
    paperTradingCycleAttempts: bucket.cycleAttemptCount,
    paperTradingCycles: bucket.cycleCount,
    cyclesSkippedNoOrderbook: bucket.skippedNoOrderbookCycles,
    cyclesSkippedStaleOrderbook: bucket.skippedStaleOrderbookCycles,
  };
  const checks = createChecks({
    options,
    state: {
      cycleCount: bucket.cycleCount,
      skippedNoOrderbookCycles: bucket.skippedNoOrderbookCycles,
      skippedStaleOrderbookCycles: bucket.skippedStaleOrderbookCycles,
      websocketMessages: bucket.websocketMessages,
      orderbookMessages: bucket.orderbookMessages,
      websocketErrors: 0,
      lastOrderbookAt: bucket.lastOrderbookAt,
      lastOrderbookUsedAt: bucket.lastOrderbookUsedAt,
      lastOrderbookUsedForCycleAt: bucket.lastOrderbookUsedForCycleAt,
      interrupted,
    },
    metrics,
    durationMsObserved: dailyTiming.durationMsObserved,
    requestedDurationMs: options.dayMs,
    finishedAt: dailyTiming.finishedAt,
    isDaily: true,
  });

  return {
    schemaVersion: 1,
    runId: `${parentRunId}:day-${dayIndex + 1}`,
    parentRunId,
    status: deriveStatus(checks),
    startedAt: dayStartedAt.toISOString(),
    finishedAt: dailyTiming.finishedAt.toISOString(),
    durationMsRequested: options.dayMs,
    durationMsObserved: dailyTiming.durationMsObserved,
    mode: "PAPER_TRADING",
    input: `${inputMode}:day-${dayIndex + 1}`,
    git,
    artifacts: {
      rawLogPath: aggregateRawLogPath,
      summaryPath: artifacts.dailySummaryPaths[dayIndex],
      reportPath: artifacts.dailyReportPaths[dayIndex],
      aggregateSummaryPath: artifacts.summaryPath,
    },
    metrics,
    checks,
  };
}

function createBaseSummary({ runId, startedAt, finishedAt, inputMode, options, git, artifacts, metrics, checks = {}, status }) {
  return {
    schemaVersion: 1,
    runId,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMsRequested: options.durationMs,
    durationMsObserved: finishedAt.getTime() - startedAt.getTime(),
    mode: "PAPER_TRADING",
    input: inputMode,
    git,
    artifacts: {
      rawLogPath: artifacts.rawLogPath,
      summaryPath: artifacts.summaryPath,
      reportPath: artifacts.reportPath,
      dailySummaryPaths: artifacts.dailySummaryPaths,
    },
    metrics,
    checks,
  };
}

function createEmptyTradingMetrics() {
  return {
    ...finalizeMetrics(createMetricAccumulator()),
    paperTradingCycleAttempts: 0,
    paperTradingCycles: 0,
    cyclesSkippedNoOrderbook: 0,
    cyclesSkippedStaleOrderbook: 0,
    websocketMessages: 0,
    tradeMessages: 0,
    orderbookMessages: 0,
    websocketErrors: 0,
    websocketReconnects: 0,
  };
}

function resolveDailyTiming({ dayStartedAt, finishedAt, options, bucket }) {
  const dayStartedAtMs = dayStartedAt.getTime();
  const dayEndedAtMs = dayStartedAtMs + options.dayMs;
  if (finishedAt.getTime() >= dayEndedAtMs) {
    return {
      finishedAt: new Date(dayEndedAtMs),
      durationMsObserved: options.dayMs,
    };
  }

  const latestActivityMs = latestTimestampMs([
    bucket.lastCycleAt,
    bucket.lastCycleAttemptAt,
    bucket.lastMarketDataAt,
    bucket.lastOrderbookAt,
  ]);
  const observedFinishedAtMs =
    latestActivityMs === null ? finishedAt.getTime() : Math.min(finishedAt.getTime(), latestActivityMs);
  const safeFinishedAtMs = Math.max(dayStartedAtMs, observedFinishedAtMs);

  return {
    finishedAt: new Date(safeFinishedAtMs),
    durationMsObserved: Math.max(0, safeFinishedAtMs - dayStartedAtMs),
  };
}

function latestTimestampMs(values) {
  let latest = null;
  for (const value of values) {
    const parsed = parseTimestampMs(value);
    if (parsed !== null && (latest === null || parsed > latest)) {
      latest = parsed;
    }
  }
  return latest;
}

function parseTimestampMs(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createChecks({ options, state, metrics, durationMsObserved, requestedDurationMs, finishedAt, isDaily }) {
  const orderbookFreshness = readOrderbookFreshness({ state, finishedAt });
  return {
    longRunGuard: okCheck(
      options.fixtureSmoke
        ? "fixture smoke가 장시간 runner의 paper trading loop를 짧게 검증했다."
        : "`SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1`이 확인되어 3일 paper trading soak 경로를 열었다.",
      {
        fixtureSmoke: options.fixtureSmoke,
        requestedDurationMs: options.durationMs,
        observedDurationMs: durationMsObserved,
      },
    ),
    durationCompleted:
      options.fixtureSmoke || (!isDaily && options.maxCycles !== undefined) || durationMsObserved >= requestedDurationMs
        ? okCheck("요청한 runner 종료 조건에 도달해 summary를 기록했다.", {
            durationMsObserved,
            requestedDurationMs,
            maxCycles: options.maxCycles ?? null,
          })
        : failCheck("요청한 duration 전에 runner가 종료됐다.", {
            durationMsObserved,
            requestedDurationMs,
          }),
    paperTradingPath:
      metrics.paperOrderSubmittedCount > 0 && metrics.paperFillCount > 0
        ? okCheck("장시간 runner에서 PaperBroker 주문 제출과 체결 경로를 확인했다.", {
            paperOrderSubmittedCount: metrics.paperOrderSubmittedCount,
            paperFillCount: metrics.paperFillCount,
            cycles: metrics.paperTradingCycles,
          })
        : failCheck("장시간 runner에서 PaperBroker 주문 제출과 체결 경로를 확인하지 못했다.", {
            paperOrderSubmittedCount: metrics.paperOrderSubmittedCount,
            paperFillCount: metrics.paperFillCount,
            cycles: metrics.paperTradingCycles,
          }),
    marketDataSource:
      options.fixtureSmoke
        ? okCheck("fixture smoke는 저장된 decision frame을 market-data 입력으로 사용했다.", {
            input: "fixture",
          })
        : state.orderbookMessages > 0 &&
          metrics.paperTradingCycles > 0 &&
          orderbookFreshness.orderbookStalenessMs <= options.maxOrderbookStalenessMs
        ? okCheck("public WebSocket orderbook을 받아 최신성 기준 안에서 paper decision cycle에 사용했다.", {
            orderbookMessages: state.orderbookMessages,
            websocketMessages: state.websocketMessages,
            cycles: metrics.paperTradingCycles,
            lastOrderbookAt: state.lastOrderbookAt,
            lastOrderbookUsedAt: state.lastOrderbookUsedAt,
            orderbookFreshnessCheckedAt: orderbookFreshness.checkedAt,
            orderbookStalenessMs: orderbookFreshness.orderbookStalenessMs,
            maxOrderbookStalenessMs: options.maxOrderbookStalenessMs,
          })
        : failCheck("public WebSocket orderbook 기반 paper decision cycle을 최신성 기준 안에서 만들지 못했다.", {
            orderbookMessages: state.orderbookMessages,
            websocketMessages: state.websocketMessages,
            skippedNoOrderbookCycles: state.skippedNoOrderbookCycles,
            skippedStaleOrderbookCycles: state.skippedStaleOrderbookCycles,
            lastOrderbookAt: state.lastOrderbookAt,
            lastOrderbookUsedAt: state.lastOrderbookUsedAt,
            orderbookFreshnessCheckedAt: orderbookFreshness.checkedAt,
            orderbookStalenessMs: orderbookFreshness.orderbookStalenessMs,
            maxOrderbookStalenessMs: options.maxOrderbookStalenessMs,
          }),
    liveOrderApiCalls:
      metrics.liveOrderApiCalls === 0
        ? okCheck("PaperBroker만 사용했고 live order API 호출이 없다.", { count: 0 })
        : failCheck("live order API 호출 metric이 0이 아니다.", { count: metrics.liveOrderApiCalls }),
    auditMissing: okCheck("각 paper decision cycle이 trace raw log와 summary metric evidence를 남겼다.", {
      count: 0,
      cycles: metrics.paperTradingCycles,
    }),
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
    dailyReportGenerated: options.dailyReportGenerated
      ? okCheck("운영자가 이 paper trading soak summary를 daily report artifact와 연결했다.", {
          generated: true,
        })
      : failCheck("M9 paper trading soak 완료에는 daily report 연결 evidence가 필요하다.", {
          generated: false,
          hint: "--daily-report-generated",
        }),
    runtimeExceptions: runtimeExceptionCheck(),
    interrupted: state.interrupted
      ? failCheck("runner가 signal로 중단되어 3일 운영 완료 증거로 사용할 수 없다.", { interrupted: true })
      : okCheck("runner 중단 signal이 관측되지 않았다.", { interrupted: false }),
  };
}

function readOrderbookFreshness({ state, finishedAt }) {
  const checkedAt = parseDateOrFallback(state.lastOrderbookUsedForCycleAt, finishedAt);
  return {
    checkedAt: checkedAt.toISOString(),
    orderbookStalenessMs: calculateOrderbookStalenessMs(state.lastOrderbookUsedAt ?? state.lastOrderbookAt, checkedAt),
  };
}

function parseDateOrFallback(value, fallback) {
  const parsed = parseTimestampMs(value);
  return parsed === null ? fallback : new Date(parsed);
}

function calculateOrderbookStalenessMs(lastOrderbookAt, finishedAt) {
  if (typeof lastOrderbookAt !== "string") {
    return Number.POSITIVE_INFINITY;
  }
  const lastOrderbookMs = Date.parse(lastOrderbookAt);
  if (!Number.isFinite(lastOrderbookMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, finishedAt.getTime() - lastOrderbookMs);
}

function countCheck(count, okMessage, failMessage) {
  return count === 0 ? okCheck(okMessage, { count }) : failCheck(failMessage, { count });
}

function runtimeExceptionCheck() {
  const crashCount = runtimeCounters.uncaughtExceptions;
  const unhandledRejectionCount = runtimeCounters.unhandledRejections;
  if (crashCount > 0 || unhandledRejectionCount > 0) {
    return failCheck("runner 실행 중 처리되지 않은 예외가 관측됐다.", {
      crashCount,
      unhandledRejectionCount,
    });
  }

  return okCheck("crash와 unhandled rejection이 관측되지 않았다.", {
    crashCount: 0,
    unhandledRejectionCount: 0,
  });
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

function deriveStatus(checks) {
  return Object.values(checks).some((check) => check.status === "fail") ? "failed" : "passed";
}

function createArtifactPaths({ artifactDir, startedAt, runId, options }) {
  const timestamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const prefix = `m9-paper-trading-soak-${timestamp}-${runId.slice(0, 8)}`;
  const dailySummaryPaths = [];
  const dailyReportPaths = [];
  for (let index = 0; index < options.days; index += 1) {
    dailySummaryPaths.push(path.join(artifactDir, `${prefix}-day-${index + 1}-summary.json`));
    dailyReportPaths.push(path.join(artifactDir, `${prefix}-day-${index + 1}-report.md`));
  }

  return {
    rawLogPath: options.rawLogPath ?? path.join(artifactDir, `${prefix}-events.jsonl`),
    summaryPath: options.summaryPath ?? path.join(artifactDir, `${prefix}-summary.json`),
    reportPath: options.reportPath ?? path.join(artifactDir, `${prefix}-report.md`),
    dailySummaryPaths,
    dailyReportPaths,
  };
}

function createJsonlWriter(filePath) {
  let stream;
  let openPromise;
  let writeChain = Promise.resolve();

  const openStream = async () => {
    if (stream !== undefined) {
      return stream;
    }
    openPromise ??= (async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      stream = createWriteStream(filePath, { encoding: "utf8" });
      return stream;
    })();
    return openPromise;
  };

  return {
    async write(record) {
      writeChain = writeChain.then(async () => {
        const target = await openStream();
        if (!target.write(`${JSON.stringify(record)}\n`)) {
          await waitForDrainOrError(target);
        }
      });
      return writeChain;
    },
    async close() {
      await writeChain;
      if (stream === undefined) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "", "utf8");
        return;
      }
      stream.end();
      await finished(stream);
    },
  };
}

function waitForDrainOrError(stream) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };

    // raw log 기록 실패는 운영 evidence 오염을 막기 위해 summary 성공보다 먼저 실패로 전파한다.
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function writeDailyArtifacts(dailySummaries, artifacts) {
  for (const [index, summary] of dailySummaries.entries()) {
    await writeSummaryAndReport(summary, artifacts.dailySummaryPaths[index], artifacts.dailyReportPaths[index]);
  }
}

async function writeSummaryAndReport(summary, summaryPath, reportPath) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(reportPath, renderMarkdownReport(summary), "utf8");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function writeFailureArtifacts({ summary, artifacts, error }) {
  await mkdir(path.dirname(artifacts.rawLogPath), { recursive: true });
  await writeFile(
    artifacts.rawLogPath,
    `${JSON.stringify({
      kind: "RUNNER_FATAL",
      status: "ERROR",
      occurredAt: summary.finishedAt,
      message: toErrorMessage(error),
    })}\n`,
    "utf8",
  );
  await writeSummaryAndReport(summary, artifacts.summaryPath, artifacts.reportPath);
}

function renderMarkdownReport(summary) {
  const metricRows = [
    ["paperTradingCycles", summary.metrics.paperTradingCycles ?? 0],
    ["strategyEvaluationCount", summary.metrics.strategyEvaluationCount],
    ["orderCandidateCount", summary.metrics.orderCandidateCount],
    ["orderIntentCount", summary.metrics.orderIntentCount],
    ["costRejectedCount", summary.metrics.costRejectedCount],
    ["riskRejectedCount", summary.metrics.riskRejectedCount],
    ["paperOrderSubmittedCount", summary.metrics.paperOrderSubmittedCount],
    ["paperFillCount", summary.metrics.paperFillCount],
    ["fillRate", summary.metrics.fillRate],
    ["liveOrderApiCalls", summary.metrics.liveOrderApiCalls],
  ]
    .map(([name, value]) => `| ${name} | ${escapeMarkdownTable(value)} |`)
    .join("\n");
  const checkRows = Object.entries(summary.checks)
    .map(([name, check]) => `| ${name} | ${check.status} | ${escapeMarkdownTable(check.message)} |`)
    .join("\n");

  return `# M9 Paper Trading Soak 결과

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

## 핵심 metric

| 항목 | 값 |
| --- | --- |
${metricRows}

## 차단/대기 사유

- holdReasonCounts: ${JSON.stringify(summary.metrics.holdReasonCounts)}
- discardReasonCounts: ${JSON.stringify(summary.metrics.discardReasonCounts)}
- blockingReasonCounts: ${JSON.stringify(summary.metrics.blockingReasonCounts)}

## 비용과 슬리피지

- costSummary: ${JSON.stringify(summary.metrics.costSummary)}
- slippageSummary: ${JSON.stringify(summary.metrics.slippageSummary)}

## 체크 결과

| 항목 | 결과 | 요약 |
| --- | --- | --- |
${checkRows}
`;
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`M9 Paper Trading Soak 결과: ${summary.status}\n`);
  process.stdout.write(`- 요약 JSON: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`- 리포트: ${summary.artifacts.reportPath}\n`);
  process.stdout.write(`- paper trading cycle: ${summary.metrics.paperTradingCycles ?? 0}\n`);
  process.stdout.write(`- paper 주문 제출: ${summary.metrics.paperOrderSubmittedCount}\n`);
  process.stdout.write(`- paper 체결: ${summary.metrics.paperFillCount}\n`);
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`사용법: node scripts/run-m9-paper-trading-soak.mjs [options]

옵션:
  --fixture-smoke                  네트워크 없이 deterministic paper trading loop smoke를 실행한다.
  --fixture <path>                 decision fixture 경로. 기본값은 tests/fixtures/m9/paper-decision-runner.json.
  --config <path>                  paper runtime config 경로. 기본값은 config/paper.json.
  --duration-ms <ms>               전체 실행 시간. 기본값은 --days * --day-ms.
  --days <count>                   daily summary 개수. 기본값은 3.
  --day-ms <ms>                    day 구간 길이. 기본값은 86400000.
  --cycle-interval-ms <ms>         paper decision cycle 간격. 기본값은 60000.
  --max-orderbook-staleness-ms <ms> public orderbook 최신성 허용값. 기본값은 cycle 간격의 2배 또는 5000 중 큰 값.
  --cycles-per-day <count>         테스트용 day split 기준 cycle 수.
  --max-cycles <count>             최대 paper decision cycle 수.
  --max-frames <count>             cycle마다 처리할 decision frame 수.
  --markets <KRW-BTC,KRW-ETH>      public WebSocket market. 기본값은 config/paper.json universe.
  --websocket-url <url>            public WebSocket URL. 기본값은 Upbit quotation endpoint.
  --artifact-dir <path>            artifact 디렉터리. 기본값은 SEEMIRAI_M9_ARTIFACT_DIR 또는 ~/vaults/99_운영/seemirai-m9-paper/trading-soak.
  --summary-path <path>            aggregate summary JSON 출력 경로.
  --raw-log-path <path>            JSONL event log 출력 경로.
  --report-path <path>             aggregate Markdown report 출력 경로.
  --daily-report-generated         이 summary가 daily report artifact와 연결됐음을 표시한다.
  --db-write-failures <count>      관측된 DB write failure 수. 기본값은 0.
  --notification-failures <count>  관측된 notification failure 수. 기본값은 0.
  --json                           JSON summary를 stdout으로 출력한다.
  --help, -h                       도움말을 출력한다.

실제 3일 실행은 SEEMIRAI_RUN_M9_PAPER_TRADING_SOAK=1 이 필요하다.
`);
}
