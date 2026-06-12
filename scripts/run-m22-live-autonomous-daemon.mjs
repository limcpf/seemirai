#!/usr/bin/env node
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Decimal } from "decimal.js";

const defaultHomeDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m22-live-autonomous");
const defaultConfigPath = path.join(defaultHomeDir, "m22-live-autonomous.config.json");
const defaultCandidateFile = path.join(defaultHomeDir, "candidates", "m22-candidates.jsonl");
const defaultHeartbeatMs = 60_000;
const defaultCandidatePollMs = 1_000;
const defaultCancelConfirmationAttempts = 5;
const defaultCancelConfirmationMs = 1_000;
const upbitApiBaseUrl = process.env.SEEMIRAI_UPBIT_API_BASE_URL ?? "https://api.upbit.com";
const requiredEvidenceEnv = [
  "SEEMIRAI_M22_OPERATOR_ARM_EVIDENCE_ID",
  "SEEMIRAI_M22_BUDGET_EVIDENCE_ID",
  "SEEMIRAI_M22_M21_WEEK_GATE_EVIDENCE_ID",
  "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID",
];
const requiredReadinessEnv = [
  "SEEMIRAI_M22_TELEGRAM_INBOUND_READY",
  "SEEMIRAI_M22_RECONCILE_FRESH",
  "SEEMIRAI_M22_PNL_STATUS_READY",
  "SEEMIRAI_M22_DECISION_LEDGER_READY",
  "SEEMIRAI_M22_EXIT_ENGINE_READY",
];
const allowedKeyScopes = ["자산조회", "주문조회", "주문하기"];
const forbiddenKeyScopes = ["출금조회", "출금하기", "입금조회", "입금하기", "선물", "레버리지", "마진"];

try {
  await main();
} catch (error) {
  process.stderr.write(`M22 live autonomous daemon 실패: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const eventLogPath = options.eventLogPath ?? process.env.SEEMIRAI_M22_PILOT_EVENT_LOG;
  if (eventLogPath === undefined || eventLogPath.trim().length === 0) {
    throw new Error("SEEMIRAI_M22_PILOT_EVENT_LOG 또는 --event-log-path가 필요하다.");
  }

  const context = {
    options,
    eventLogPath: path.resolve(expandHome(eventLogPath)),
    config: await readJsonFile(options.configPath),
    startedAt: new Date().toISOString(),
    stopRequested: false,
    wake: undefined,
    orderBlocked: false,
    candidateOffset: 0,
    candidateOffsetInitialized: false,
    dailySubmittedNotional: parseNonNegativeEnvDecimal("SEEMIRAI_M22_INITIAL_DAILY_AUTONOMOUS_NOTIONAL_USED_KRW", "0"),
    openPositionNotional: parseNonNegativeEnvDecimal("SEEMIRAI_M22_INITIAL_OPEN_POSITION_NOTIONAL_KRW", "0"),
    processedCandidateIds: new Set(),
    submittedIdentifiers: new Set(),
  };
  context.configSafety = createConfigSafety(context.config);
  assertPreflight(context);

  await mkdir(path.dirname(context.eventLogPath), { recursive: true });
  if (options.resetEventLog) {
    await writeFile(context.eventLogPath, "", "utf8");
  }

  const stop = (signal) => {
    if (!context.stopRequested) {
      context.stopRequested = true;
      context.stopSignal = signal;
      if (context.wake !== undefined) {
        context.wake();
      }
    }
  };
  const maxRuntimeTimer =
    options.maxRuntimeMs === undefined
      ? undefined
      : setTimeout(() => {
          stop("max-runtime-ms");
        }, options.maxRuntimeMs);
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  await appendEvent(context.eventLogPath, {
    type: "m22_pilot_heartbeat",
    observedAt: context.startedAt,
    runtimeReady: true,
    market: "KRW-BTC",
    daemon: "scripts/run-m22-live-autonomous-daemon.mjs",
    candidateFile: options.candidateFilePath,
    dryRun: options.dryRun,
  });

  let lastHeartbeatMs = Date.now();
  while (!context.stopRequested) {
    await processCandidateFile(context);

    const now = Date.now();
    if (now - lastHeartbeatMs >= options.heartbeatMs) {
      lastHeartbeatMs = now;
      await appendEvent(context.eventLogPath, {
        type: "m22_pilot_heartbeat",
        observedAt: new Date().toISOString(),
        runtimeReady: true,
        market: "KRW-BTC",
        orderBlocked: context.orderBlocked,
        dailySubmittedNotionalKrw: context.dailySubmittedNotional.toFixed(),
        openPositionNotionalKrw: context.openPositionNotional.toFixed(),
      });
    }

    await sleepUntilWake(context, Math.min(options.candidatePollMs, options.heartbeatMs));
  }

  if (maxRuntimeTimer !== undefined) {
    clearTimeout(maxRuntimeTimer);
  }
  await appendEvent(context.eventLogPath, {
    type: "daily_report_generated",
    observedAt: new Date().toISOString(),
    reportDate: toKstDate(new Date()),
    stopSignal: context.stopSignal ?? "requested",
    dryRun: options.dryRun,
    dailySubmittedNotionalKrw: context.dailySubmittedNotional.toFixed(),
    openPositionNotionalKrw: context.openPositionNotional.toFixed(),
  });
}

function assertPreflight(context) {
  const violations = [];
  if (process.env.SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON !== "1" && process.env.SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT !== "1") {
    violations.push("SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON=1 또는 SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT=1 이 필요합니다");
  }
  violations.push(...context.configSafety.violations);
  violations.push(...missingEnvViolations(requiredEvidenceEnv));
  violations.push(...readinessViolations(requiredReadinessEnv));

  if (context.options.requireCandidateSource && context.options.candidateFilePath === undefined) {
    violations.push("--require-candidate-source를 쓰려면 --candidate-file이 필요합니다");
  }

  if (!context.options.dryRun) {
    violations.push(...upbitCredentialViolations());
  }

  if (violations.length > 0) {
    throw new Error(`M22 daemon preflight 실패: ${violations.join("; ")}`);
  }
}

function createConfigSafety(config) {
  const liveAutonomous = config?.live_autonomous;
  const violations = [];
  if (!isRecord(liveAutonomous)) {
    violations.push("runtime config에 live_autonomous 설정이 필요합니다");
    return { violations };
  }
  if (liveAutonomous.enabled !== true) {
    violations.push("live_autonomous.enabled must be true");
  }
  if (!arrayEquals(liveAutonomous.allowed_markets, ["KRW-BTC"])) {
    violations.push("allowed_markets must be exactly KRW-BTC");
  }
  for (const [key, expected] of [
    ["max_order_krw", "10000"],
    ["daily_autonomous_notional_limit_krw", "30000"],
    ["max_open_position_notional_krw", "30000"],
    ["max_daily_loss_krw", "10000"],
    ["max_weekly_loss_krw", "30000"],
    ["max_price_deviation_bps", "30"],
  ]) {
    if (liveAutonomous[key] !== expected) {
      violations.push(`${key} must be ${expected}`);
    }
  }
  if (liveAutonomous.identifier_prefix !== "m22a-") {
    violations.push("identifier_prefix must be m22a-");
  }
  if (liveAutonomous.identifier_max_length !== 32) {
    violations.push("identifier_max_length must be 32");
  }
  for (const key of [
    "require_m21_week_gate_evidence",
    "require_m20_inbound_readiness",
    "require_reconcile_freshness",
    "require_pnl_status_ready",
    "require_decision_ledger_ready",
    "require_exit_engine_ready",
    "require_operator_arm_evidence_id",
    "require_budget_evidence_id",
    "require_key_scope_evidence_id",
  ]) {
    if (liveAutonomous[key] !== true) {
      violations.push(`${key} must remain true`);
    }
  }
  if (config.withdrawal_enabled === true) {
    violations.push("withdrawal_enabled must remain false");
  }
  if (config.futures_enabled === true || config.leverage_enabled === true) {
    violations.push("futures/leverage must remain false");
  }
  if (config.market_order_enabled === true || config.entry_market_order_enabled === true) {
    violations.push("market order toggles must remain false");
  }
  return { violations };
}

async function processCandidateFile(context) {
  const candidateFilePath = context.options.candidateFilePath;
  if (candidateFilePath === undefined || context.orderBlocked) {
    return;
  }

  let candidateStat;
  try {
    candidateStat = await stat(candidateFilePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (context.options.requireCandidateSource) {
        throw new Error(`candidate file이 없다: ${candidateFilePath}`);
      }
      return;
    }
    throw error;
  }
  if (!context.candidateOffsetInitialized) {
    context.candidateOffset = context.options.candidateStart === "end" ? candidateStat.size : 0;
    context.candidateOffsetInitialized = true;
  }
  if (candidateStat.size < context.candidateOffset) {
    context.candidateOffset = 0;
  }
  if (candidateStat.size === context.candidateOffset) {
    return;
  }

  const raw = await readFile(candidateFilePath, "utf8");
  const chunk = raw.slice(context.candidateOffset);
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) {
    return;
  }
  const completeChunk = chunk.slice(0, lastNewline);
  context.candidateOffset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf8");

  for (const line of completeChunk.split(/\r?\n/u)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    await processCandidateLine(context, line);
  }
}

async function processCandidateLine(context, line) {
  let candidate;
  try {
    candidate = JSON.parse(line);
  } catch (error) {
    await appendManualReview(context, "candidate_json_parse_failed", "candidate JSONL line을 파싱할 수 없습니다.", {
      error: toErrorMessage(error),
    });
    context.orderBlocked = true;
    return;
  }

  const candidateId = readString(candidate.candidateId) ?? readString(candidate.id) ?? `offset:${context.candidateOffset}`;
  if (context.processedCandidateIds.has(candidateId)) {
    return;
  }
  context.processedCandidateIds.add(candidateId);

  const normalized = normalizeCandidate(context, candidate);
  if (normalized.violations.length > 0) {
    await appendManualReview(context, "candidate_blocked", "M22 후보가 안전 조건을 통과하지 못해 주문하지 않았습니다.", {
      candidateId,
      violations: normalized.violations,
    });
    return;
  }

  const order = normalized.order;
  if (context.submittedIdentifiers.has(order.identifier)) {
    await appendManualReview(context, "duplicate_identifier_in_daemon", "같은 daemon 실행 안에서 identifier가 중복되어 주문하지 않았습니다.", {
      candidateId,
      identifier: order.identifier,
    });
    context.orderBlocked = true;
    return;
  }

  context.submittedIdentifiers.add(order.identifier);
  context.dailySubmittedNotional = context.dailySubmittedNotional.plus(order.notional);
  context.openPositionNotional = context.openPositionNotional.plus(order.notional);

  await appendEvent(context.eventLogPath, {
    type: "broker_submission",
    observedAt: new Date().toISOString(),
    market: order.market,
    side: "BUY",
    idempotencyKey: order.identifier,
    requestedNotionalKrw: order.notional.toFixed(),
    dryRun: context.options.dryRun,
    candidateId,
  });

  if (context.options.dryRun) {
    await appendEvent(context.eventLogPath, {
      type: "order_submitted",
      observedAt: new Date().toISOString(),
      market: order.market,
      status: "DRY_RUN_SUBMITTED",
      identifier: order.identifier,
      candidateId,
    });
    return;
  }

  try {
    const payload = await submitUpbitLimitOrder(order);
    const submittedOrder = safeUpbitOrderPayload(payload);
    await appendEvent(context.eventLogPath, {
      type: "order_submitted",
      observedAt: new Date().toISOString(),
      market: order.market,
      status: "SUBMITTED",
      identifier: order.identifier,
      candidateId,
      provider: submittedOrder,
    });
    if (context.options.cancelAfterSubmit) {
      await cancelSubmittedOrder(context, {
        candidateId,
        order,
        submittedOrder,
      });
    }
  } catch (error) {
    await appendManualReview(context, "broker_submission_uncertain", "Upbit 주문 제출 결과를 확정할 수 없어 신규 후보 처리를 중지합니다.", {
      candidateId,
      identifier: order.identifier,
      error: toErrorMessage(error),
    });
    context.orderBlocked = true;
  }
}

async function cancelSubmittedOrder(context, input) {
  const identifier = readString(input.submittedOrder.identifier) ?? input.order.identifier;
  const uuid = readString(input.submittedOrder.uuid);
  const cancelInput = uuid === undefined ? { identifier } : { uuid };

  await appendEvent(context.eventLogPath, {
    type: "order_cancel_requested",
    observedAt: new Date().toISOString(),
    market: input.order.market,
    candidateId: input.candidateId,
    identifier,
    ...(uuid === undefined ? {} : { uuid }),
  });

  let cancelPayload;
  try {
    cancelPayload = await cancelUpbitOrder(cancelInput);
  } catch (error) {
    await appendEvent(context.eventLogPath, {
      type: "order_cancel_failed",
      observedAt: new Date().toISOString(),
      market: input.order.market,
      candidateId: input.candidateId,
      identifier,
      ...(uuid === undefined ? {} : { uuid }),
      error: toErrorMessage(error),
    });
    await appendManualReview(
      context,
      "cancel_after_submit_failed",
      "M22 live canary 주문 제출 후 취소 요청이 실패해 신규 후보 처리를 중지합니다.",
      {
        candidateId: input.candidateId,
        identifier,
        ...(uuid === undefined ? {} : { uuid }),
        error: toErrorMessage(error),
      },
    );
    context.orderBlocked = true;
    return;
  }

  const canceledOrder = safeUpbitOrderPayload(cancelPayload);
  await appendEvent(context.eventLogPath, {
    type: "order_cancel_submitted",
    observedAt: new Date().toISOString(),
    market: input.order.market,
    candidateId: input.candidateId,
    identifier,
    provider: canceledOrder,
  });

  const confirmedOrder = await waitForCancelConfirmation(context, {
    candidateId: input.candidateId,
    market: input.order.market,
    identifier,
    uuid: readString(canceledOrder.uuid) ?? uuid,
  });
  if (confirmedOrder !== undefined) {
    const releasedNotional = releaseCanceledOpenPositionNotional(context, input.order, confirmedOrder);
    await appendEvent(context.eventLogPath, {
      type: "order_cancel_confirmed",
      observedAt: new Date().toISOString(),
      market: input.order.market,
      candidateId: input.candidateId,
      identifier,
      provider: confirmedOrder,
      releasedOpenPositionNotionalKrw: releasedNotional.toFixed(),
      openPositionNotionalKrw: context.openPositionNotional.toFixed(),
    });
    return;
  }

  await appendEvent(context.eventLogPath, {
    type: "order_cancel_unconfirmed",
    observedAt: new Date().toISOString(),
    market: input.order.market,
    candidateId: input.candidateId,
    identifier,
  });
  await appendManualReview(
    context,
    "cancel_after_submit_unconfirmed",
    "M22 live canary 주문 취소 terminal 상태를 확인하지 못해 신규 후보 처리를 중지합니다.",
    {
      candidateId: input.candidateId,
      identifier,
    },
  );
  context.orderBlocked = true;
}

async function waitForCancelConfirmation(context, input) {
  const lookupInput = input.uuid === undefined ? { identifier: input.identifier } : { uuid: input.uuid };
  for (let attempt = 1; attempt <= context.options.cancelConfirmationAttempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(context.options.cancelConfirmationMs);
    }
    let payload;
    try {
      payload = await getUpbitOrder(lookupInput);
    } catch (error) {
      await appendEvent(context.eventLogPath, {
        type: "order_cancel_confirmation_check",
        observedAt: new Date().toISOString(),
        market: input.market,
        candidateId: input.candidateId,
        identifier: input.identifier,
        attempt,
        status: "LOOKUP_FAILED",
        error: toErrorMessage(error),
      });
      continue;
    }
    const order = safeUpbitOrderPayload(payload);
    await appendEvent(context.eventLogPath, {
      type: "order_cancel_confirmation_check",
      observedAt: new Date().toISOString(),
      market: input.market,
      candidateId: input.candidateId,
      identifier: input.identifier,
      attempt,
      status: order.state ?? "UNKNOWN",
    });
    if (isCanceledState(order.state)) {
      return order;
    }
  }
  return undefined;
}

function releaseCanceledOpenPositionNotional(context, order, confirmedOrder) {
  const releasedNotional = new Decimal(order.notional);
  context.openPositionNotional = context.openPositionNotional.minus(releasedNotional);
  if (context.openPositionNotional.lt(0)) {
    context.openPositionNotional = new Decimal(0);
  }
  return releasedNotional;
}

function normalizeCandidate(context, candidate) {
  const config = context.config.live_autonomous;
  const violations = [];
  const market = readString(candidate.market);
  const side = readString(candidate.side) ?? "BUY";
  const orderType = readString(candidate.orderType) ?? "LIMIT";
  const postOnly = candidate.postOnly ?? true;
  const requestedPrice = readString(candidate.requestedPrice ?? candidate.price);
  const requestedQuantity = readString(candidate.requestedQuantity ?? candidate.quantity);
  const requestedNotional = readString(candidate.requestedNotional ?? candidate.notional);
  const referencePrice = readString(candidate.referencePrice ?? requestedPrice);
  const identifier = readString(candidate.idempotencyKey ?? candidate.identifier) ?? createM22Identifier(config);

  if (market !== "KRW-BTC") {
    violations.push("market은 KRW-BTC만 허용합니다");
  }
  if (!config.allowed_markets.includes(market)) {
    violations.push("config 허용 market에 없는 후보입니다");
  }
  if (side !== "BUY") {
    violations.push("M22 daemon entry는 BUY만 허용합니다");
  }
  if (orderType !== "LIMIT" || postOnly !== true) {
    violations.push("M22 daemon entry는 LIMIT + post_only만 허용합니다");
  }
  if (identifier.length === 0 || identifier.length > config.identifier_max_length || !identifier.startsWith(config.identifier_prefix)) {
    violations.push(`identifier는 ${config.identifier_prefix} prefix와 ${config.identifier_max_length}자 이하 조건을 만족해야 합니다`);
  }

  const price = parsePositiveDecimal(requestedPrice, "requestedPrice", violations);
  const quantity = parsePositiveDecimal(requestedQuantity, "requestedQuantity", violations);
  const notional = parsePositiveDecimal(requestedNotional, "requestedNotional", violations);
  const reference = parsePositiveDecimal(referencePrice, "referencePrice", violations);
  if (price === undefined || quantity === undefined || notional === undefined || reference === undefined) {
    return { violations };
  }

  const actualNotional = price.mul(quantity);
  if (!actualNotional.equals(notional)) {
    violations.push("requestedNotional은 requestedPrice * requestedQuantity와 같아야 합니다");
  }
  if (actualNotional.lt(5_000)) {
    violations.push("Upbit KRW 최소 주문금액 5000 KRW 미만 후보는 제출하지 않습니다");
  }
  if (actualNotional.gt(new Decimal(config.max_order_krw))) {
    violations.push("M22 단일 주문 예산 10000 KRW를 초과했습니다");
  }
  if (context.dailySubmittedNotional.plus(actualNotional).gt(new Decimal(config.daily_autonomous_notional_limit_krw))) {
    violations.push("M22 일일 자동 주문 notional 30000 KRW를 초과합니다");
  }
  if (context.openPositionNotional.plus(actualNotional).gt(new Decimal(config.max_open_position_notional_krw))) {
    violations.push("M22 open position notional 30000 KRW를 초과합니다");
  }

  const deviationBps = price.minus(reference).abs().div(reference).mul(10_000);
  if (deviationBps.gt(new Decimal(config.max_price_deviation_bps))) {
    violations.push("referencePrice 대비 가격 이탈이 M22 30 bps 한도를 초과했습니다");
  }

  const dailyLoss = parseNonNegativeEnvDecimal("SEEMIRAI_M22_DAILY_REALIZED_LOSS_KRW", "0");
  const weeklyLoss = parseNonNegativeEnvDecimal("SEEMIRAI_M22_WEEKLY_REALIZED_LOSS_KRW", "0");
  if (dailyLoss.gt(new Decimal(config.max_daily_loss_krw))) {
    violations.push("M22 일간 손실 한도를 초과한 상태입니다");
  }
  if (weeklyLoss.gt(new Decimal(config.max_weekly_loss_krw))) {
    violations.push("M22 주간 손실 한도를 초과한 상태입니다");
  }

  return {
    violations,
    order: {
      market,
      price: price.toFixed(),
      volume: quantity.toFixed(),
      identifier,
      notional: actualNotional,
    },
  };
}

async function submitUpbitLimitOrder(order) {
  const bodyParams = [
    { key: "market", value: order.market },
    { key: "side", value: "bid" },
    { key: "volume", value: order.volume },
    { key: "price", value: order.price },
    { key: "ord_type", value: "limit" },
    { key: "identifier", value: order.identifier },
    { key: "time_in_force", value: "post_only" },
  ];
  const body = Object.fromEntries(bodyParams.map((param) => [param.key, param.value]));
  const response = await fetch(new URL("/v1/orders", upbitApiBaseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: buildUpbitAuthorizationHeader({
        accessKey: process.env.SEEMIRAI_UPBIT_ACCESS_KEY,
        secretKey: process.env.SEEMIRAI_UPBIT_SECRET_KEY,
        nonce: randomUUID(),
        queryString: buildQueryString(bodyParams, false),
      }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await createProviderErrorMessage(response));
  }
  return await response.json();
}

async function cancelUpbitOrder(input) {
  return await requestUpbitPrivateJson({
    method: "DELETE",
    pathname: "/v1/order",
    queryParams: toSingleOrderIdentifierParams(input, "주문 취소"),
  });
}

async function getUpbitOrder(input) {
  return await requestUpbitPrivateJson({
    method: "GET",
    pathname: "/v1/order",
    queryParams: toSingleOrderIdentifierParams(input, "주문 조회"),
  });
}

async function requestUpbitPrivateJson(input) {
  const queryParams = input.queryParams ?? [];
  const url = new URL(input.pathname, upbitApiBaseUrl);
  const urlQueryString = buildQueryString(queryParams, true);
  if (urlQueryString.length > 0) {
    url.search = urlQueryString;
  }
  const response = await fetch(url, {
    method: input.method,
    headers: {
      accept: "application/json",
      authorization: buildUpbitAuthorizationHeader({
        accessKey: process.env.SEEMIRAI_UPBIT_ACCESS_KEY,
        secretKey: process.env.SEEMIRAI_UPBIT_SECRET_KEY,
        nonce: randomUUID(),
        queryString: buildQueryString(queryParams, false),
      }),
    },
  });
  if (!response.ok) {
    throw new Error(await createProviderErrorMessage(response));
  }
  return await response.json();
}

function toSingleOrderIdentifierParams(input, label) {
  const uuid = readString(input.uuid);
  const identifier = readString(input.identifier);
  if ((uuid === undefined && identifier === undefined) || (uuid !== undefined && identifier !== undefined)) {
    throw new Error(`${label}에는 uuid 또는 identifier 중 정확히 하나가 필요합니다`);
  }
  return uuid === undefined ? [{ key: "identifier", value: identifier }] : [{ key: "uuid", value: uuid }];
}

async function createProviderErrorMessage(response) {
  try {
    const payload = await response.json();
    const name = payload?.error?.name;
    const message = payload?.error?.message;
    return `Upbit private API 실패: status=${response.status}, name=${String(name ?? "unknown")}, message=${String(message ?? "redacted")}`;
  } catch {
    return `Upbit private API 실패: status=${response.status}`;
  }
}

function safeUpbitOrderPayload(payload) {
  return {
    uuid: readString(payload?.uuid) ?? null,
    identifier: readString(payload?.identifier) ?? null,
    market: readString(payload?.market) ?? null,
    side: readString(payload?.side) ?? null,
    ordType: readString(payload?.ord_type) ?? null,
    state: readString(payload?.state) ?? null,
    price: readString(payload?.price) ?? null,
    volume: readString(payload?.volume) ?? null,
    remainingVolume: readString(payload?.remaining_volume) ?? null,
    createdAt: readString(payload?.created_at) ?? null,
  };
}

function isCanceledState(state) {
  const normalized = readString(state)?.toLowerCase();
  return normalized === "cancel" || normalized === "canceled" || normalized === "cancelled";
}

async function appendManualReview(context, reasonCode, message, metadata) {
  await appendEvent(context.eventLogPath, {
    type: "manual_review_required",
    observedAt: new Date().toISOString(),
    reasonCode,
    message,
    metadata,
  });
}

async function appendEvent(filePath, event) {
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

function missingEnvViolations(names) {
  return names.filter((name) => !hasEnvValue(name)).map((name) => `${name} 값이 필요합니다`);
}

function readinessViolations(names) {
  return names.filter((name) => process.env[name] !== "1").map((name) => `${name}=1 이 필요합니다`);
}

function upbitCredentialViolations() {
  const violations = [];
  if (!hasEnvValue("SEEMIRAI_UPBIT_ACCESS_KEY")) {
    violations.push("SEEMIRAI_UPBIT_ACCESS_KEY 값이 필요합니다");
  }
  if (!hasEnvValue("SEEMIRAI_UPBIT_SECRET_KEY")) {
    violations.push("SEEMIRAI_UPBIT_SECRET_KEY 값이 필요합니다");
  }

  const scopes = parseKeyScopes(process.env.SEEMIRAI_UPBIT_KEY_SCOPE);
  for (const scope of ["자산조회", "주문조회", "주문하기"]) {
    if (!scopes.includes(scope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 ${scope} 권한이 필요합니다`);
    }
  }
  for (const scope of scopes) {
    if (forbiddenKeyScopes.includes(scope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 금지 권한이 포함되어 있습니다: ${scope}`);
    } else if (!allowedKeyScopes.includes(scope)) {
      violations.push(`SEEMIRAI_UPBIT_KEY_SCOPE에 알 수 없는 권한이 포함되어 있습니다: ${scope}`);
    }
  }
  return violations;
}

function parseKeyScopes(raw) {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return [...new Set(raw.split(/[,\s]+/u).map((scope) => scope.trim()).filter((scope) => scope.length > 0))];
}

function hasEnvValue(name) {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0;
}

function createM22Identifier(config) {
  return `${config.identifier_prefix}${randomBytes(13).toString("hex")}`;
}

function parsePositiveDecimal(value, label, violations) {
  if (typeof value !== "string" || value.trim().length === 0) {
    violations.push(`${label} 값이 필요합니다`);
    return undefined;
  }
  try {
    const decimal = new Decimal(value);
    if (decimal.gt(0)) {
      return decimal;
    }
  } catch {
    // 아래 공통 violation으로 수렴한다.
  }
  violations.push(`${label}은 0보다 큰 decimal 문자열이어야 합니다`);
  return undefined;
}

function parseNonNegativeEnvDecimal(name, fallback) {
  const value = process.env[name] ?? fallback;
  try {
    const decimal = new Decimal(value);
    if (decimal.gte(0)) {
      return decimal;
    }
  } catch {
    // 아래 오류로 수렴한다.
  }
  throw new Error(`${name}은 0 이상의 decimal 문자열이어야 합니다`);
}

function buildUpbitAuthorizationHeader(input) {
  return `Bearer ${createUpbitJwtToken(input)}`;
}

function createUpbitJwtToken(input) {
  const payload = {
    access_key: input.accessKey,
    nonce: input.nonce,
  };
  if (input.queryString !== undefined && input.queryString.length > 0) {
    payload.query_hash = createHash("sha512").update(input.queryString, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const signingInput = `${toBase64UrlJson({ alg: "HS512", typ: "JWT" })}.${toBase64UrlJson(payload)}`;
  const signature = createHmac("sha512", input.secretKey).update(signingInput, "utf8").digest("base64url");
  return `${signingInput}.${signature}`;
}

function toBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function buildQueryString(params, encode) {
  return params
    .flatMap((param) => {
      const values = Array.isArray(param.value) ? param.value : [param.value];
      return values.map((value) => `${encodeQueryPart(param.key, encode)}=${encodeQueryPart(String(value), encode)}`);
    })
    .join("&");
}

function encodeQueryPart(value, encode) {
  if (!encode) {
    return value;
  }
  return encodeURIComponent(value).replace(/%5B/gu, "[").replace(/%5D/gu, "]");
}

async function readJsonFile(filePath) {
  const raw = await readFile(path.resolve(expandHome(filePath)), "utf8");
  return JSON.parse(raw);
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayEquals(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function sleepUntilWake(context, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      context.wake = undefined;
      resolve();
    }, ms);
    context.wake = () => {
      clearTimeout(timer);
      context.wake = undefined;
      resolve();
    };
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const options = {
    configPath: defaultConfigPath,
    candidateFilePath: defaultCandidateFile,
    candidateStart: "end",
    candidatePollMs: defaultCandidatePollMs,
    heartbeatMs: defaultHeartbeatMs,
    eventLogPath: undefined,
    maxRuntimeMs: undefined,
    requireCandidateSource: false,
    resetEventLog: false,
    dryRun: false,
    cancelAfterSubmit: false,
    cancelConfirmationAttempts: defaultCancelConfirmationAttempts,
    cancelConfirmationMs: defaultCancelConfirmationMs,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = readRequiredArg(argv, (index += 1), arg);
        break;
      case "--candidate-file":
        options.candidateFilePath = path.resolve(expandHome(readRequiredArg(argv, (index += 1), arg)));
        break;
      case "--no-candidate-file":
        options.candidateFilePath = undefined;
        break;
      case "--candidate-start":
        options.candidateStart = readRequiredArg(argv, (index += 1), arg);
        if (!["beginning", "end"].includes(options.candidateStart)) {
          throw new Error("--candidate-start는 beginning 또는 end만 허용한다.");
        }
        break;
      case "--candidate-poll-ms":
        options.candidatePollMs = readPositiveInteger(argv, (index += 1), arg);
        break;
      case "--heartbeat-ms":
        options.heartbeatMs = readPositiveInteger(argv, (index += 1), arg);
        break;
      case "--event-log-path":
        options.eventLogPath = readRequiredArg(argv, (index += 1), arg);
        break;
      case "--max-runtime-ms":
        options.maxRuntimeMs = readPositiveInteger(argv, (index += 1), arg);
        break;
      case "--require-candidate-source":
        options.requireCandidateSource = true;
        break;
      case "--reset-event-log":
        options.resetEventLog = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--cancel-after-submit":
        options.cancelAfterSubmit = true;
        break;
      case "--cancel-confirmation-attempts":
        options.cancelConfirmationAttempts = readPositiveInteger(argv, (index += 1), arg);
        break;
      case "--cancel-confirmation-ms":
        options.cancelConfirmationMs = readPositiveInteger(argv, (index += 1), arg);
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }

  return options;
}

function readRequiredArg(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} 값이 필요하다.`);
  }
  return value;
}

function readPositiveInteger(argv, index, option) {
  const value = Number(readRequiredArg(argv, index, option));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${option} 값은 양의 정수여야 한다.`);
  }
  return value;
}

function expandHome(input) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function toKstDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/run-m22-live-autonomous-daemon.mjs [options]

M22 제한적 완전 자동매매 daemon이다. runner가 주입한 SEEMIRAI_M22_PILOT_EVENT_LOG에 heartbeat와 주문 evidence를 JSONL로 남긴다.
주문은 --candidate-file JSONL에 들어온 명시 후보만 처리하며, daemon이 임의 전략 신호를 만들지 않는다.

Options:
  --config <path>                 저장소 밖 M22 config. 기본값은 ~/vaults/99_운영/seemirai-m22-live-autonomous/m22-live-autonomous.config.json.
  --candidate-file <path>         주문 후보 JSONL 파일. 기본값은 ~/vaults/99_운영/seemirai-m22-live-autonomous/candidates/m22-candidates.jsonl.
  --no-candidate-file             주문 후보 없이 heartbeat daemon만 실행한다.
  --candidate-start <mode>        beginning 또는 end. 기본값은 end.
  --candidate-poll-ms <ms>        후보 파일 poll 주기. 기본값은 1000.
  --heartbeat-ms <ms>             heartbeat 주기. 기본값은 60000.
  --event-log-path <path>         runner env 대신 직접 event log path를 지정한다.
  --max-runtime-ms <ms>           테스트용 최대 실행 시간.
  --require-candidate-source      후보 파일이 없으면 시작 실패.
  --reset-event-log               event log를 비우고 시작.
  --dry-run                       Upbit 주문 API를 호출하지 않고 event만 검증한다.
  --cancel-after-submit           live canary 주문 제출 후 같은 uuid/identifier로 즉시 취소하고 terminal 상태를 확인한다.
  --cancel-confirmation-attempts <n> 취소 terminal 확인 조회 횟수. 기본값은 ${defaultCancelConfirmationAttempts}.
  --cancel-confirmation-ms <ms>   취소 terminal 확인 조회 간격. 기본값은 ${defaultCancelConfirmationMs}.
  --help                          도움말 출력.

Candidate JSONL example:
{"candidateId":"m22-test-001","market":"KRW-BTC","side":"BUY","orderType":"LIMIT","postOnly":true,"requestedPrice":"100000000","requestedQuantity":"0.0001","requestedNotional":"10000","referencePrice":"100000000","reason":"operator-approved-test"}
`);
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
