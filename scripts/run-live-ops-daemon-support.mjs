import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyLiveOpsCliDecisionHistoryRetention,
  LiveOpsRuntimeProvenanceMismatchError,
  loadLiveOpsCliInputs,
  loadLiveOpsCliStartupReadiness,
  parseArgs as parseLiveOpsArgs,
  printHelp as printLiveOpsHelp,
  renderLiveOpsSummary,
  renderLiveOpsTuiDashboard,
} from "./run-live-ops-support.mjs";

const execFileAsync = promisify(execFile);
const gitCommitShaPattern = /^[a-f0-9]{40}$/u;
const configFingerprintPattern = /^sha256:[a-f0-9]{64}$/u;
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
    sourceCommitSha: undefined,
    startupArtifactFilePath: undefined,
    tickIntervalMs: undefined,
    maxTicks: undefined,
    decisionHistoryRetentionHours: undefined,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--status-file":
        options.statusFilePath = readDaemonArgValue(argv, index, arg);
        index += 1;
        break;
      case "--source-commit-sha":
        options.sourceCommitSha = readDaemonArgValue(argv, index, arg).toLowerCase();
        index += 1;
        break;
      case "--startup-artifact-file":
        options.startupArtifactFilePath = readDaemonArgValue(argv, index, arg);
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
      case "--decision-history-retention-hours":
        options.decisionHistoryRetentionHours = Number(readDaemonArgValue(argv, index, arg));
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
  const parsed = {
    ...liveOpsOptions,
    ...options,
  };
  assertLiveOpsDaemonProvenanceOptions(parsed);
  return parsed;
}

export async function runLiveOpsDaemon(options, io = {}) {
  assertLiveOpsDaemonProvenanceOptions(options);
  const stdout = io.stdout ?? process.stdout;
  const clock = io.clock ?? (() => new Date().toISOString());
  const sleep = io.sleep ?? sleepLiveOpsDaemon;
  const loadInputs = io.loadInputs ?? loadLiveOpsCliInputs;
  const loadStartupReadiness = io.loadStartupReadiness ?? loadLiveOpsCliStartupReadiness;
  const prepareRuntimeProvenance = io.prepareRuntimeProvenance ?? prepareLiveOpsDaemonRuntimeProvenance;
  const persistStartupArtifact = io.persistStartupArtifact ?? writeLiveOpsDaemonStartupArtifact;
  const renderSummary = io.renderSummary ?? renderLiveOpsSummary;
  const applyDecisionHistoryRetention = io.applyDecisionHistoryRetention ?? applyLiveOpsCliDecisionHistoryRetention;
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
  let latestSummary = null;
  let latestError = null;
  let latestDecisionHistoryRetention = null;
  let statusFilePath = resolveInitialDaemonStatusFile(options);
  let startupAlertConsumed = false;
  let runtimeProvenance = null;
  let provenanceFailure = null;

  if (options.fixtureSmoke !== true) {
    try {
      runtimeProvenance = await prepareRuntimeProvenance(options, {
        loadStartupReadiness,
        inspectSourceTree: io.inspectSourceTree,
      });
      await persistStartupArtifact({
        filePath: options.startupArtifactFilePath,
        startedAt,
        runtimeProvenance,
        repositoryRoot: runtimeProvenance.repositoryRoot,
      });
      runtimeProvenance = withoutRepositoryRoot(runtimeProvenance);
    } catch (error) {
      latestError = {
        name: safeDaemonErrorName(error),
        message: error instanceof Error ? error.message : String(error),
      };
      provenanceFailure = error;
      const failureResult = createDaemonStatusPayload({
        options,
        startedAt,
        finishedAt: clock(),
        counters,
        latestSummary,
        latestError,
        latestDecisionHistoryRetention,
        unhandledRejections,
        statusFilePath,
        runtimeProvenance,
        provenanceFailure: true,
      });
      // source/config/migration provenance가 닫히지 않으면 broker loop를 시작하지 않고 실패 상태만 남긴다.
      await writeDaemonStatusIfConfigured(statusFilePath, failureResult);
      throw error;
    }
  }

  process.on("unhandledRejection", onUnhandledRejection);

  try {
    while (shouldContinueDaemon({ startedMs, durationMs, tickCount: counters.tickCount, maxTicks })) {
      const tickStartedAt = clock();
      try {
        const provenanceOptions = runtimeProvenance === null ? options : { ...options, runtimeProvenance };
        const tickOptions = startupAlertConsumed ? withStartupAlertSuppressed(provenanceOptions) : provenanceOptions;
        const inputs = await loadInputs(tickOptions);
        let summary = renderSummary({
          ...tickOptions,
          ...inputs,
          tui: tickOptions.tui,
        });
        if (runtimeProvenance !== null) {
          summary = {
            ...summary,
            runtimeProvenance,
          };
        }
        const decisionHistoryRetention = await applyLiveOpsDaemonDecisionHistoryRetention({
          options,
          inputs,
          clock,
          applyDecisionHistoryRetention,
        });
        if (decisionHistoryRetention !== undefined) {
          summary = {
            ...summary,
            decisionHistoryRetention,
          };
          latestDecisionHistoryRetention = decisionHistoryRetention;
        }
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
          latestDecisionHistoryRetention,
          unhandledRejections,
          statusFilePath,
          runtimeProvenance,
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
          latestDecisionHistoryRetention,
          unhandledRejections,
          statusFilePath,
          runtimeProvenance,
          provenanceFailure: error instanceof LiveOpsRuntimeProvenanceMismatchError,
        }));
        if (error instanceof LiveOpsRuntimeProvenanceMismatchError) {
          provenanceFailure = error;
          break;
        }
      }

      const delayMs = resolveNextDaemonDelayMs({
        options,
        latestSummary,
        latestError,
        latestDecisionHistoryRetention,
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
    latestDecisionHistoryRetention,
    unhandledRejections,
    statusFilePath,
    runtimeProvenance,
    provenanceFailure: provenanceFailure !== null,
  });
  // 제한 실행이 끝난 뒤에도 monitor/attach가 stale running tick을 읽지 않도록 terminal payload를 같은 파일에 커밋한다.
  await writeDaemonStatusIfConfigured(statusFilePath, result);
  if (provenanceFailure !== null) {
    throw provenanceFailure;
  }
  if (options.tui) {
    writeDaemonText(stdout, renderLiveOpsDaemonSummary(result));
  } else {
    writeDaemonJson(stdout, result);
  }
  return result;
}

export async function prepareLiveOpsDaemonRuntimeProvenance(options, dependencies = {}) {
  assertLiveOpsDaemonProvenanceOptions(options);
  const inspectSourceTree = dependencies.inspectSourceTree ?? inspectLiveOpsDaemonSourceTree;
  const source = await inspectSourceTree(options.sourceCommitSha);
  if (source.headCommitSha !== options.sourceCommitSha) {
    // 명시 rollout SHA와 실제 worktree HEAD가 다르면 어떤 source가 주문을 만들었는지 증명할 수 없어 시작하지 않는다.
    throw new Error("명시한 source commit SHA가 현재 daemon worktree HEAD와 다릅니다. 배포 source를 다시 확인하세요.");
  }
  if (source.clean !== true) {
    // dirty checkout은 같은 HEAD SHA로 서로 다른 코드를 실행할 수 있어 commit provenance를 주장할 수 없다.
    throw new Error("production daemon worktree에 commit되지 않은 변경이 있습니다. clean checkout에서 다시 시작하세요.");
  }

  const startup = await dependencies.loadStartupReadiness(options);
  const migration = startup?.dbReadiness?.migration ?? {};
  const expectedMigrationVersion = Number(migration.expectedLatestVersion);
  const appliedMigrationVersion = Number(migration.appliedLatestVersion);
  const pendingVersions = Array.isArray(migration.pendingVersions) ? migration.pendingVersions : [];
  if (
    startup?.dbReadiness?.ready !== true
    || !Number.isSafeInteger(expectedMigrationVersion)
    || expectedMigrationVersion <= 0
    || appliedMigrationVersion !== expectedMigrationVersion
    || pendingVersions.length > 0
  ) {
    // expected/applied version이 같고 pending이 0이어야 startup artifact가 실제 DB schema를 재현할 수 있다.
    throw new Error("DB migration provenance가 준비되지 않았습니다. expected/applied version과 pending migration을 확인하세요.");
  }
  if (!configFingerprintPattern.test(String(startup.configFingerprint ?? ""))) {
    throw new Error("운영 config fingerprint를 생성하지 못했습니다. config 파일을 확인하세요.");
  }

  return {
    sourceCommitSha: options.sourceCommitSha,
    configFingerprint: startup.configFingerprint,
    expectedMigrationVersion,
    appliedMigrationVersion,
    repositoryRoot: source.repositoryRoot,
  };
}

export async function writeLiveOpsDaemonStartupArtifact({
  filePath,
  startedAt,
  runtimeProvenance,
  repositoryRoot,
}) {
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [realDirectory, realRepositoryRoot] = await Promise.all([
    realpath(directory),
    realpath(repositoryRoot),
  ]);
  if (isPathInside(realRepositoryRoot, realDirectory)) {
    // startup evidence는 git checkout과 함께 수정되거나 커밋되지 않도록 repository 밖에만 쓴다.
    throw new Error("daemon startup artifact는 repository 밖의 운영 경로에 저장해야 합니다.");
  }

  const payload = {
    kind: "live_ops_daemon_startup",
    status: "ready",
    startedAt,
    runtimeProvenance: withoutRepositoryRoot(runtimeProvenance),
  };
  try {
    // 같은 경로를 덮어쓰면 과거 startup provenance를 새 실행으로 위장할 수 있으므로 create-only로 기록한다.
    await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("daemon startup artifact가 이미 존재합니다. 새 실행에는 새 경로를 사용하세요.");
    }
    throw error;
  }
}

function assertLiveOpsDaemonProvenanceOptions(options) {
  if (options.help === true || options.fixtureSmoke === true) {
    return;
  }
  if (!gitCommitShaPattern.test(String(options.sourceCommitSha ?? ""))) {
    throw new Error("production live:ops:daemon은 --source-commit-sha 40자리 Git SHA가 필요합니다.");
  }
  if (typeof options.startupArtifactFilePath !== "string" || options.startupArtifactFilePath.trim() === "") {
    throw new Error("production live:ops:daemon은 --startup-artifact-file 경로가 필요합니다.");
  }
}

async function inspectLiveOpsDaemonSourceTree() {
  const repositoryRootResult = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const repositoryRoot = repositoryRootResult.stdout.trim();
  const headResult = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const statusResult = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return {
    repositoryRoot,
    headCommitSha: headResult.stdout.trim().toLowerCase(),
    clean: statusResult.stdout.trim() === "",
  };
}

function withoutRepositoryRoot(runtimeProvenance) {
  if (runtimeProvenance === null || runtimeProvenance === undefined) {
    return runtimeProvenance;
  }
  const { repositoryRoot: _repositoryRoot, ...safeProvenance } = runtimeProvenance;
  return safeProvenance;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
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
  --source-commit-sha <sha> production worktree HEAD와 비교할 40자리 Git commit SHA
  --startup-artifact-file <path>
                            source/config/migration startup provenance를 create-only로 기록할 repository 밖 경로
  --tick-interval-ms <ms>   HOLD/success 기본 tick sleep. 기본값 1000
  --max-ticks <n>           테스트와 smoke용 최대 tick 수
  --decision-history-retention-hours <hours>
                            decision history retention cutoff. 명시한 경우 cutoff 이전 live_decision_ticks 삭제 결과를 status evidence로 남김
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
    manualReviewSources: [],
  };
}

function accumulateDaemonCounters(counters, summary) {
  const liveExecution = summary.liveExecution ?? {};
  const reconcile = summary.reconcilePnlStatus ?? {};
  const alertRetry = createDaemonAlertRetryEvidence(summary.telegramAlert);
  const manualReviewSources = collectDaemonManualReviewSources({
    latestSummary: summary,
    alertRetry,
    latestDecisionHistoryRetention: summary.decisionHistoryRetention,
  });
  if (summary.status === "ready") counters.successCount += 1;
  if (liveExecution.status === "idle") counters.holdCount += 1;
  if (summary.status === "blocked" || liveExecution.status === "blocked") counters.blockCount += 1;
  if (manualReviewSources.length > 0 || liveExecution.status === "manual_review_required" || reconcile.manualReviewRequired === true) counters.manualReviewCount += 1;
  addUniqueDaemonManualReviewSources(counters, manualReviewSources);
  counters.submittedOrderCount += Number(liveExecution.submittedOrderCount ?? 0);
  if (liveExecution.status === "exit_requote_ready") counters.exitRequoteCount += 1;
  counters.reconcileMismatchCount += Number.isFinite(Number(reconcile.mismatchCount)) ? Number(reconcile.mismatchCount) : 0;
  if (JSON.stringify(summary).includes("duplicate_identifier")) counters.duplicateOrderCount += 1;
  if (JSON.stringify(summary).includes("untracked_fill")) counters.untrackedFillCount += 1;
  if (liveExecution.cleanupStatus === "manual_review_required") counters.liveOrderCleanupFailureCount += 1;
}

function resolveNextDaemonDelayMs({ options, latestSummary, latestError, latestDecisionHistoryRetention, tickIntervalMs }) {
  if (options.fixtureSmoke) {
    return Math.min(tickIntervalMs, 100);
  }
  if (latestError !== null) {
    return defaultDaemonBackoffMs.transientFailure;
  }
  if (latestDecisionHistoryRetention?.status === "manual_review_required") {
    // retention 실패는 다음 tick에서 DB 권한/lock을 재확인해야 하므로 일반 idle 주기로 즉시 재시도하지 않는다.
    return defaultDaemonBackoffMs.manualReview;
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
  latestDecisionHistoryRetention,
  unhandledRejections,
  statusFilePath,
  runtimeProvenance,
  provenanceFailure = false,
}) {
  return {
    kind: "live_ops_daemon_summary",
    status: provenanceFailure
      ? "provenance_failed"
      : latestError === null
        ? (finishedAt === undefined ? "running" : "completed")
        : "transient_failure",
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(tickStartedAt === undefined ? {} : { latestTickStartedAt: tickStartedAt }),
    fixtureSmoke: options.fixtureSmoke === true,
    durationMs: Number.isFinite(options.durationMs) ? Number(options.durationMs) : null,
    statusFilePath: statusFilePath ?? null,
    startupArtifactFilePath: options.startupArtifactFilePath === undefined
      ? null
      : path.resolve(options.startupArtifactFilePath),
    runtimeProvenance: runtimeProvenance ?? null,
    counters,
    sleepPolicy: {
      successMs: defaultDaemonBackoffMs.success,
      holdMs: Number.isFinite(options.tickIntervalMs) ? Number(options.tickIntervalMs) : defaultDaemonTickIntervalMs,
      blockMs: defaultDaemonBackoffMs.block,
      manualReviewMs: defaultDaemonBackoffMs.manualReview,
      transientFailureMs: defaultDaemonBackoffMs.transientFailure,
    },
    closeoutEvidence: createDaemonCloseoutEvidence({
      counters,
      latestSummary,
      latestError,
      latestDecisionHistoryRetention,
    }),
    latestSummary,
    latestError,
    unhandledRejections,
    message: provenanceFailure
      ? "source/config/migration provenance가 일치하지 않아 live:ops daemon 시작을 차단했습니다."
      : "live:ops daemon이 config/env만으로 자동 매수, 보유, 매도 tick을 반복 평가했습니다.",
    action: provenanceFailure
      ? "명시 source SHA, config fingerprint, DB migration version, startup artifact 경로를 확인한 뒤 새 실행으로 재시작하세요."
      : latestError === null
        ? "TUI/status에서 보유 대기, 차단, 수동 확인, 주문 제출, 매도 재호가 횟수를 확인하세요."
        : "latestError를 확인하고 다음 tick 재시도 전에 provider/DB 상태를 점검하세요.",
  };
}

async function applyLiveOpsDaemonDecisionHistoryRetention({
  options,
  inputs,
  clock,
  applyDecisionHistoryRetention,
}) {
  const retentionHours = Number(options.decisionHistoryRetentionHours);
  if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
    return undefined;
  }
  if (options.fixtureSmoke === true) {
    return {
      status: "skipped",
      retentionHours,
      deleted: 0,
      olderThan: null,
      message: "fixture smoke에서는 decision history retention DB delete를 실행하지 않습니다.",
      action: "production daemon에서만 retention 옵션을 사용하세요.",
    };
  }
  const databaseUrl = inputs?.env?.SEEMIRAI_DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    return {
      status: "manual_review_required",
      retentionHours,
      deleted: null,
      olderThan: null,
      message: "decision history retention을 실행할 DB URL을 확인하지 못했습니다.",
      action: "env file의 SEEMIRAI_DATABASE_URL과 DB readiness 상태를 확인하세요.",
      trace: {
        reason: "live_decision_history_retention_database_url_missing",
      },
    };
  }

  const observedAt = new Date(clock());
  if (!Number.isFinite(observedAt.getTime())) {
    return {
      status: "manual_review_required",
      retentionHours,
      deleted: null,
      olderThan: null,
      message: "decision history retention 기준 시각을 계산하지 못했습니다.",
      action: "daemon clock과 시스템 시간을 확인한 뒤 retention을 다시 실행하세요.",
      trace: {
        reason: "live_decision_history_retention_clock_invalid",
      },
    };
  }
  const olderThan = new Date(observedAt.getTime() - retentionHours * 60 * 60 * 1000);

  try {
    // retention delete는 주문 lifecycle과 독립된 운영 정리 작업이므로 실패해도 tick 결과를 되돌리지 않고 evidence로 격리한다.
    const result = await applyDecisionHistoryRetention({ databaseUrl, olderThan });
    const deleted = Number.isFinite(Number(result?.deleted)) ? Number(result.deleted) : 0;
    return {
      status: "applied",
      retentionHours,
      deleted,
      olderThan: olderThan.toISOString(),
      message: "decision history retention cutoff 이전 row를 정리했습니다.",
      action: "삭제 수와 calibration 조회 window가 운영 기대와 맞는지 확인하세요.",
    };
  } catch (error) {
    return {
      status: "manual_review_required",
      retentionHours,
      deleted: null,
      olderThan: olderThan.toISOString(),
      message: "decision history retention 실행에 실패해 수동 점검 evidence로 남겼습니다.",
      action: "DB 권한, lock, retention cutoff를 확인하되 주문 후보나 broker 결과는 되돌리지 마세요.",
      trace: {
        reason: "live_decision_history_retention_failed",
        errorName: safeDaemonErrorName(error),
      },
    };
  }
}

function createDaemonCloseoutEvidence({
  counters,
  latestSummary,
  latestError,
  latestDecisionHistoryRetention,
}) {
  const statusFreshness = createDaemonStatusFreshnessEvidence({ latestSummary, latestError });
  const alertRetry = createDaemonAlertRetryEvidence(latestSummary?.telegramAlert);
  const manualReview = createDaemonManualReviewEvidence({
    counters,
    latestSummary,
    alertRetry,
    latestDecisionHistoryRetention,
  });
  return {
    statusFreshness,
    alertRetry,
    manualReview,
    decisionHistoryRetention: latestDecisionHistoryRetention ?? {
      status: "not_configured",
      message: "decision history retention option이 없어 이번 daemon run에서는 DB delete를 실행하지 않았습니다.",
      action: "운영 보존 기간을 정한 뒤 --decision-history-retention-hours를 명시하세요.",
    },
  };
}

function createDaemonStatusFreshnessEvidence({ latestSummary, latestError }) {
  if (latestError !== null && latestSummary !== null) {
    return {
      status: "stale_after_failure",
      latestSummaryStatus: latestSummary.status ?? "unknown",
      latestErrorName: readDaemonErrorName(latestError),
      message: "최신 tick 실패로 직전 summary는 stale 상태이며 실주문 가능 근거로 쓰지 않습니다.",
      action: "status file의 latestError와 최근 daemon 로그를 먼저 확인하세요.",
    };
  }
  if (latestError !== null) {
    return {
      status: "missing_after_failure",
      latestSummaryStatus: null,
      latestErrorName: readDaemonErrorName(latestError),
      message: "성공 summary 없이 daemon tick이 실패했습니다.",
      action: "provider/DB boot 실패를 복구한 뒤 다음 tick summary를 확인하세요.",
    };
  }
  return {
    status: latestSummary === null ? "missing_summary" : "fresh",
    latestSummaryStatus: latestSummary?.status ?? null,
    latestErrorName: null,
    message: latestSummary === null
      ? "아직 성공 summary가 없습니다."
      : "latestSummary가 최신 daemon 결과입니다.",
    action: latestSummary === null
      ? "첫 tick 완료 여부를 확인하세요."
      : "summary의 차단/수동 확인 항목을 계속 추적하세요.",
  };
}

function createDaemonAlertRetryEvidence(telegramAlert) {
  const scheduledBriefing = telegramAlert?.scheduledBriefing;
  const retryPlannedCount = readDaemonCount(telegramAlert?.retryPlannedCount) + readDaemonCount(scheduledBriefing?.retryPlannedCount);
  const failureCount = readDaemonCount(telegramAlert?.failureCount) + readDaemonCount(scheduledBriefing?.failureCount);
  const blocked = telegramAlert?.status === "blocked" || scheduledBriefing?.status === "blocked";
  const notReady = telegramAlert !== undefined && telegramAlert.ready !== true;
  const manualReviewRequired = telegramAlert?.status === "manual_review_required" || scheduledBriefing?.status === "manual_review_required" || blocked;
  return {
    status: telegramAlert === undefined
      ? "not_observed"
      : manualReviewRequired
        ? "manual_review_required"
        : failureCount > 0 || retryPlannedCount > 0
          ? "retry_pending"
          : notReady
            ? "not_ready"
          : "ok",
    retryPlannedCount,
    failureCount,
    manualReviewRequired,
    message: telegramAlert === undefined
      ? "Telegram alert summary가 아직 없습니다."
      : "Telegram retry/manual review 상태를 closeout evidence로 집계했습니다.",
    action: failureCount > 0 || retryPlannedCount > 0 || manualReviewRequired
      ? "notification retry와 owner chat 수신 상태를 확인하세요."
      : "추가 조치 없음",
  };
}

function createDaemonManualReviewEvidence({
  counters,
  latestSummary,
  alertRetry,
  latestDecisionHistoryRetention,
}) {
  const sources = uniqueDaemonManualReviewSources([
    ...(Array.isArray(counters.manualReviewSources) ? counters.manualReviewSources : []),
    ...collectDaemonManualReviewSources({
      latestSummary,
      alertRetry,
      latestDecisionHistoryRetention,
    }),
  ]);
  return {
    required: sources.length > 0 || counters.manualReviewCount > 0,
    count: counters.manualReviewCount,
    sources,
    message: sources.length > 0
      ? "daemon closeout에서 수동 점검 source를 확인했습니다."
      : "수동 점검 source가 없습니다.",
    action: sources.length > 0
      ? "source별 status/action을 확인하고 신규 entry를 재개하지 마세요."
      : "추가 조치 없음",
  };
}

function collectDaemonManualReviewSources({
  latestSummary,
  alertRetry,
  latestDecisionHistoryRetention,
}) {
  const sources = [];
  if (latestSummary?.liveExecution?.status === "manual_review_required") sources.push("live_execution");
  if (latestSummary?.reconcilePnlStatus?.manualReviewRequired === true) sources.push("reconcile_pnl_status");
  if (alertRetry.manualReviewRequired) sources.push("telegram_alert");
  if (latestDecisionHistoryRetention?.status === "manual_review_required") sources.push("decision_history_retention");
  return uniqueDaemonManualReviewSources(sources);
}

function addUniqueDaemonManualReviewSources(counters, sources) {
  counters.manualReviewSources = uniqueDaemonManualReviewSources([
    ...(Array.isArray(counters.manualReviewSources) ? counters.manualReviewSources : []),
    ...sources,
  ]);
}

function uniqueDaemonManualReviewSources(sources) {
  return [...new Set(sources.filter((source) => typeof source === "string" && source.length > 0))].sort();
}

function readDaemonCount(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readDaemonErrorName(errorLike) {
  if (typeof errorLike?.name === "string" && errorLike.name.length > 0) {
    return errorLike.name;
  }
  return safeDaemonErrorName(errorLike);
}

/**
 * daemon status 파일의 초기 기록 위치를 계산한다.
 *
 * 책임:
 * - 명시 `--status-file`은 절대 경로로 고정한다.
 * - non-fixture 운영 실행은 첫 tick이 config/env/DB 단계에서 실패해 summary를 만들지 못해도
 *   config 옆 `artifacts/live-ops-daemon-status.json`에 실패 payload를 남길 수 있게 한다.
 *
 * invariant:
 * - fixture smoke는 사용자가 명시하지 않는 한 repo/config 옆에 운영 status 파일을 만들지 않는다.
 *
 * side effect:
 * - 없음. 경로 문자열만 계산한다.
 */
function resolveInitialDaemonStatusFile(options) {
  if (options.statusFilePath !== undefined) {
    return path.resolve(options.statusFilePath);
  }
  return resolveDefaultDaemonStatusFileFromConfigPath(options);
}

function resolveDefaultDaemonStatusFile(options, summary) {
  if (options.fixtureSmoke === true || !summary?.configPath) {
    return undefined;
  }
  return path.join(path.dirname(summary.configPath), "artifacts", "live-ops-daemon-status.json");
}

/**
 * summary가 없는 실패 tick에서도 사용할 수 있는 기본 daemon status 경로를 만든다.
 *
 * 책임:
 * - live ops config 파일 위치만으로 운영자가 예상하는 status JSON 경로를 산출한다.
 * - 아직 provider/DB/readiness가 열리기 전 실패도 관측 가능하게 만드는 경계다.
 *
 * side effect:
 * - 없음.
 */
function resolveDefaultDaemonStatusFileFromConfigPath(options) {
  if (options.fixtureSmoke === true || options.configPath === undefined) {
    return undefined;
  }
  const configPath = path.resolve(options.configPath);
  return path.join(path.dirname(configPath), "artifacts", "live-ops-daemon-status.json");
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
  if (status === "provenance_failed") return "실행 근거 불일치로 차단";
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
