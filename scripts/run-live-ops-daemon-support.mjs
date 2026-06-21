import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadLiveOpsCliInputs,
  parseArgs as parseLiveOpsArgs,
  printHelp as printLiveOpsHelp,
  renderLiveOpsSummary,
  renderLiveOpsTuiDashboard,
} from "./run-live-ops-support.mjs";

const defaultDaemonTickIntervalMs = 1_000;
const defaultDaemonBackoffMs = {
  success: 1_000,
  hold: 1_000,
  block: 5_000,
  manualReview: 30_000,
  transientFailure: 5_000,
};

export function parseLiveOpsDaemonArgs(argv) {
  const forwarded = [];
  const options = {
    statusFilePath: undefined,
    tickIntervalMs: undefined,
    maxTicks: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--status-file":
        options.statusFilePath = readDaemonArgValue(argv, index, arg);
        index += 1;
        break;
      case "--tick-interval-ms":
        options.tickIntervalMs = Number(readDaemonArgValue(argv, index, arg));
        index += 1;
        break;
      case "--max-ticks":
        options.maxTicks = Number(readDaemonArgValue(argv, index, arg));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        forwarded.push(arg);
        break;
    }
  }

  const liveOpsOptions = parseLiveOpsArgs(forwarded);
  return {
    ...liveOpsOptions,
    ...options,
  };
}

export async function runLiveOpsDaemon(options, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const clock = io.clock ?? (() => new Date().toISOString());
  const sleep = io.sleep ?? sleepLiveOpsDaemon;
  const loadInputs = io.loadInputs ?? loadLiveOpsCliInputs;
  const renderSummary = io.renderSummary ?? renderLiveOpsSummary;
  const startedAt = clock();
  const startedMs = Date.parse(startedAt);
  const durationMs = Number.isFinite(options.durationMs) && options.durationMs > 0 ? Number(options.durationMs) : undefined;
  const maxTicks = Number.isSafeInteger(options.maxTicks) && options.maxTicks > 0 ? options.maxTicks : undefined;
  const tickIntervalMs = Number.isFinite(options.tickIntervalMs) && options.tickIntervalMs >= 0
    ? options.tickIntervalMs
    : defaultDaemonTickIntervalMs;
  const counters = createDaemonCounters();
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(safeDaemonErrorName(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  let latestSummary = null;
  let latestError = null;
  let statusFilePath = options.statusFilePath === undefined ? undefined : path.resolve(options.statusFilePath);
  let startupAlertConsumed = false;

  try {
    while (shouldContinueDaemon({ startedMs, durationMs, tickCount: counters.tickCount, maxTicks })) {
      const tickStartedAt = clock();
      try {
        const tickOptions = startupAlertConsumed ? withStartupAlertSuppressed(options) : options;
        const inputs = await loadInputs(tickOptions);
        const summary = renderSummary({
          ...tickOptions,
          ...inputs,
          tui: tickOptions.tui,
        });
        latestSummary = summary;
        latestError = null;
        counters.tickCount += 1;
        accumulateDaemonCounters(counters, summary);
        if (!startupAlertConsumed && shouldConsumeLiveOpsDaemonStartupAlert(summary)) {
          // startup 알림 실패 tick에서는 다음 tick에서 owner chat 연결 복구를 재시도해야 하므로 ready 확인 뒤에만 소비한다.
          startupAlertConsumed = true;
        }

        if (options.tui) {
          writeDaemonText(stdout, renderLiveOpsTuiDashboard(summary));
          writeDaemonText(stdout, "\n--- live:ops daemon tick 완료 ---\n");
        }

        statusFilePath = statusFilePath ?? resolveDefaultDaemonStatusFile(options, summary);
        await writeDaemonStatusIfConfigured(statusFilePath, createDaemonStatusPayload({
          options,
          startedAt,
          tickStartedAt,
          counters,
          latestSummary,
          latestError,
          unhandledRejections,
          statusFilePath,
        }));
      } catch (error) {
        counters.tickCount += 1;
        counters.transientFailureCount += 1;
        latestError = {
          name: safeDaemonErrorName(error),
          message: error instanceof Error ? error.message : String(error),
        };
        if (options.tui) {
          writeDaemonText(stdout, `live:ops daemon tick 실패: ${latestError.message}\n`);
        }
        // 실패 tick도 외부 monitor가 직전 정상 JSON만 보지 않도록 같은 status file에 즉시 반영한다.
        await writeDaemonStatusIfConfigured(statusFilePath, createDaemonStatusPayload({
          options,
          startedAt,
          tickStartedAt,
          counters,
          latestSummary,
          latestError,
          unhandledRejections,
          statusFilePath,
        }));
      }

      const delayMs = resolveNextDaemonDelayMs({
        options,
        latestSummary,
        latestError,
        tickIntervalMs,
      });
      if (!shouldContinueDaemon({ startedMs, durationMs, tickCount: counters.tickCount, maxTicks })) {
        break;
      }
      await sleep(delayMs);
    }
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  counters.unhandledRejectionCount = unhandledRejections.length;
  const finishedAt = clock();
  const result = createDaemonStatusPayload({
    options,
    startedAt,
    finishedAt,
    counters,
    latestSummary,
    latestError,
    unhandledRejections,
    statusFilePath,
  });
  if (options.tui) {
    writeDaemonText(stdout, renderLiveOpsDaemonSummary(result));
  } else {
    writeDaemonJson(stdout, result);
  }
  return result;
}

function withStartupAlertSuppressed(options) {
  return {
    ...options,
    suppressStartupTelegramAlert: true,
  };
}

/**
 * daemon startup Telegram 알림을 이번 프로세스에서 소비 처리할지 판정한다.
 *
 * 책임:
 * - owner chat 전송 실패나 partial failure tick을 소비 처리하지 않아 다음 tick 재시도 기회를 보존한다.
 * - 이미 alert summary가 ready로 닫힌 tick은 이후 반복 tick에서 startup 알림을 중복 생성하지 않게 한다.
 *
 * side effect:
 * - 없음. latest summary의 Telegram readiness만 읽는다.
 */
function shouldConsumeLiveOpsDaemonStartupAlert(summary) {
  return summary?.telegramAlert?.ready === true;
}

export function printLiveOpsDaemonHelp() {
  printLiveOpsHelp("live:ops:daemon");
  process.stdout.write(`
  --status-file <path>      daemon latest summary JSON을 자동 기록할 경로
  --tick-interval-ms <ms>   HOLD/success 기본 tick sleep. 기본값 1000
  --max-ticks <n>           테스트와 smoke용 최대 tick 수
  --json                    TUI 없이 최종 daemon summary JSON 출력

live:ops:daemon은 config/env만 받아 반복 실행합니다. 수동 fixture manifest, hand-written evidence, JSONL 후보 파일은 요구하지 않습니다.
`);
}

function createDaemonCounters() {
  return {
    tickCount: 0,
    successCount: 0,
    holdCount: 0,
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
  };
}

function accumulateDaemonCounters(counters, summary) {
  const liveExecution = summary.liveExecution ?? {};
  const reconcile = summary.reconcilePnlStatus ?? {};
  if (summary.status === "ready") counters.successCount += 1;
  if (liveExecution.status === "idle") counters.holdCount += 1;
  if (summary.status === "blocked" || liveExecution.status === "blocked") counters.blockCount += 1;
  if (liveExecution.status === "manual_review_required" || reconcile.manualReviewRequired === true) counters.manualReviewCount += 1;
  counters.submittedOrderCount += Number(liveExecution.submittedOrderCount ?? 0);
  if (liveExecution.status === "exit_requote_ready") counters.exitRequoteCount += 1;
  counters.reconcileMismatchCount += Number.isFinite(Number(reconcile.mismatchCount)) ? Number(reconcile.mismatchCount) : 0;
  if (JSON.stringify(summary).includes("duplicate_identifier")) counters.duplicateOrderCount += 1;
  if (JSON.stringify(summary).includes("untracked_fill")) counters.untrackedFillCount += 1;
  if (liveExecution.cleanupStatus === "manual_review_required") counters.liveOrderCleanupFailureCount += 1;
}

function resolveNextDaemonDelayMs({ options, latestSummary, latestError, tickIntervalMs }) {
  if (options.fixtureSmoke) {
    return Math.min(tickIntervalMs, 100);
  }
  if (latestError !== null) {
    return defaultDaemonBackoffMs.transientFailure;
  }
  const liveExecution = latestSummary?.liveExecution ?? {};
  if (liveExecution.status === "manual_review_required") {
    return defaultDaemonBackoffMs.manualReview;
  }
  if (latestSummary?.status === "blocked" || liveExecution.status === "blocked") {
    return defaultDaemonBackoffMs.block;
  }
  if (liveExecution.status === "idle") {
    return tickIntervalMs;
  }
  return defaultDaemonBackoffMs.success;
}

function shouldContinueDaemon({ startedMs, durationMs, tickCount, maxTicks }) {
  if (maxTicks !== undefined && tickCount >= maxTicks) {
    return false;
  }
  if (durationMs === undefined) {
    // maxTicks는 위 분기에서만 종료시켜 duration 없는 smoke 반복이 첫 tick 뒤 조기 종료되지 않게 한다.
    return true;
  }
  if (!Number.isFinite(startedMs)) {
    return tickCount === 0;
  }
  return Date.now() - startedMs < durationMs || tickCount === 0;
}

function createDaemonStatusPayload({
  options,
  startedAt,
  finishedAt,
  tickStartedAt,
  counters,
  latestSummary,
  latestError,
  unhandledRejections,
  statusFilePath,
}) {
  return {
    kind: "live_ops_daemon_summary",
    status: latestError === null ? (finishedAt === undefined ? "running" : "completed") : "transient_failure",
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(tickStartedAt === undefined ? {} : { latestTickStartedAt: tickStartedAt }),
    fixtureSmoke: options.fixtureSmoke === true,
    durationMs: Number.isFinite(options.durationMs) ? Number(options.durationMs) : null,
    statusFilePath: statusFilePath ?? null,
    counters,
    sleepPolicy: {
      successMs: defaultDaemonBackoffMs.success,
      holdMs: Number.isFinite(options.tickIntervalMs) ? Number(options.tickIntervalMs) : defaultDaemonTickIntervalMs,
      blockMs: defaultDaemonBackoffMs.block,
      manualReviewMs: defaultDaemonBackoffMs.manualReview,
      transientFailureMs: defaultDaemonBackoffMs.transientFailure,
    },
    latestSummary,
    latestError,
    unhandledRejections,
    message: "live:ops daemon이 config/env만으로 자동 매수, 보유, 매도 tick을 반복 평가했습니다.",
    action: latestError === null
      ? "TUI/status에서 보유 대기, 차단, 수동 확인, 주문 제출, 매도 재호가 횟수를 확인하세요."
      : "latestError를 확인하고 다음 tick 재시도 전에 provider/DB 상태를 점검하세요.",
  };
}

function resolveDefaultDaemonStatusFile(options, summary) {
  if (options.fixtureSmoke === true || !summary?.configPath) {
    return undefined;
  }
  return path.join(path.dirname(summary.configPath), "artifacts", "live-ops-daemon-status.json");
}

async function writeDaemonStatusIfConfigured(statusFilePath, payload) {
  if (statusFilePath === undefined) {
    return;
  }
  const dir = path.dirname(statusFilePath);
  await mkdir(dir, { recursive: true });
  await realpath(dir);
  await writeFile(statusFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function renderLiveOpsDaemonSummary(result) {
  const counters = result.counters;
  return [
    "Seemirai Live Ops",
    "24/7 daemon summary",
    "",
    `상태: ${formatDaemonStatus(result.status)}`,
    `반복 횟수: ${counters.tickCount}`,
    `보유/대기: ${counters.holdCount}`,
    `차단: ${counters.blockCount}`,
    `수동 확인: ${counters.manualReviewCount}`,
    `주문 제출: ${counters.submittedOrderCount}`,
    `매도 재호가: ${counters.exitRequoteCount}`,
    `프로세스 충돌: ${counters.crashCount}`,
    `처리되지 않은 비동기 오류: ${counters.unhandledRejectionCount}`,
    `중복 주문: ${counters.duplicateOrderCount}`,
    `계좌 대사 불일치: ${counters.reconcileMismatchCount}`,
    `추적되지 않은 체결: ${counters.untrackedFillCount}`,
    `실주문 정리 실패: ${counters.liveOrderCleanupFailureCount}`,
    `필요 조치: ${result.action}`,
    `추적 정보: statusFile=${result.statusFilePath ?? "없음"}`,
    "",
  ].join("\n");
}

function formatDaemonStatus(status) {
  if (status === "completed") return "완료";
  if (status === "running") return "실행 중";
  if (status === "transient_failure") return "일시 실패";
  return status;
}

function readDaemonArgValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}

function safeDaemonErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

function sleepLiveOpsDaemon(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function writeDaemonJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeDaemonText(stdout, value) {
  stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}
