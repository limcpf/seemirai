import {
  buildWebSocketOrderSnapshots,
  runReconcileEngine,
} from "../../application/index.js";
import type {
  BrokerBalance,
  ReconcileEngineInput,
  ReconcileEngineOutput,
  ReconcileExchangeOrderSnapshot,
  ReconcileMismatchType,
  ReconcileMismatchEvidence,
  TimestampInput,
} from "../../domain/index.js";
import type { KillSwitchControlTargetState } from "../../application/index.js";
import { UnsafeLiveReconcileRuntimeError } from "./types.js";
import type {
  CreateGuardedLiveReconcileRuntimeInput,
  CreateLiveReconcileRuntimeSafeSummaryInput,
  CreateLiveReconcileRuntimeWorkerInput,
  GuardedLiveReconcileRuntime,
  LiveReconcileRuntimeRepository,
  LiveReconcileRuntimeRunResult,
  LiveReconcileRuntimeSafeSummary,
  LiveReconcileRuntimeWorker,
  ReconcileStatusProvider,
  ReconcileStatusSummary,
  RunLiveReconcileOnceOptions,
} from "./types.js";
import {
  createLiveReconcileRuntimeSafeSummary,
  createReconcileStatusSummary,
} from "./status-summary.js";

/**
 * 명시 guard를 모두 통과한 경우에만 M16 read-only reconcile runtime summary를 생성한다.
 *
 * 기본 `PAPER_NO_KEY` runtime은 이 factory를 호출하지 않는다. 이 함수는 guard 상태를 검증한 뒤
 * read-only snapshot worker를 함께 반환한다. private client 생성은 호출자가 주입한 snapshotProvider 경계에서만 수행한다.
 *
 * @param input reconcile runtime guard 입력
 * @returns guarded reconcile runtime
 */
export function createGuardedLiveReconcileRuntime(
  input: CreateGuardedLiveReconcileRuntimeInput,
): GuardedLiveReconcileRuntime {
  if (!input.liveReconcileEnabled || !input.reconcileConfig.enabled) {
    // reconcile guard가 완성되지 않으면 private client 객체조차 만들지 않아 기본 runtime 경계를 보존한다.
    throw new UnsafeLiveReconcileRuntimeError(
      !input.liveReconcileEnabled
        ? ["SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1 guard가 필요합니다"]
        : ["Live reconcile runtime config가 활성화되지 않았습니다"],
    );
  }

  return {
    summary: createLiveReconcileRuntimeSafeSummary(input),
    worker: input.worker,
  };
}

/**
 * M16 read-only reconcile worker를 생성한다.
 *
 * worker는 주문 생성/취소 API를 직접 알지 못하고, 주입된 snapshotProvider에서 이미 정규화된 snapshot만 받아 engine을 실행한다.
 * mismatch가 있으면 kill switch control port로 fail-closed 전이를 먼저 확정한 뒤 append-only evidence를 저장한다.
 *
 * @param input snapshot/repository/control provider와 clock
 * @returns 단일 reconcile 실행 worker
 */
export function createLiveReconcileRuntimeWorker(
  input: CreateLiveReconcileRuntimeWorkerInput,
): LiveReconcileRuntimeWorker {
  const clock = input.clock ?? (() => new Date());
  const actor = input.actor ?? "live-reconcile-runtime";

  return {
    async runOnce(options: RunLiveReconcileOnceOptions = {}): Promise<LiveReconcileRuntimeRunResult> {
      const observedAt = options.observedAt ?? clock();
      const correlationId = options.correlationId ?? createReconcileCorrelationId(observedAt);
      const snapshot = await loadSnapshotOrRecordFailure({
        repository: input.repository,
        observedAt,
        correlationId,
        actor,
        provider: input.killSwitchControlProvider,
        loadSnapshot: () =>
          input.snapshotProvider.loadSnapshot({
            observedAt,
            correlationId,
          }),
      });
      const engineInput = withObservedAt(snapshot.engineInput, observedAt);
      const idempotencyKey =
        snapshot.idempotencyKey ?? createReconcileIdempotencyKey(observedAt, correlationId);

      const begun = await input.repository.beginLiveReconcileRun({
        idempotencyKey,
        guardProfile: "LIVE_READ_ONLY_RECONCILE",
        sourceSummary: snapshot.sourceSummary ?? "read-only reconcile snapshot",
        correlationId,
        metadata: {
          ...(snapshot.metadata ?? {}),
          websocket_event_count: engineInput.websocketContext.events.length,
        },
      });

      if (!begun.created) {
        // 같은 idempotency key의 기존 run에 새 snapshot side effect가 섞이면 append-only evidence와 차단 상태가 갈라진다.
        throw new UnsafeLiveReconcileRuntimeError([
          `live reconcile idempotency key가 이미 사용됐습니다: ${begun.run.id}`,
        ]);
      }

      try {
        const engineOutput = runReconcileEngine(engineInput);

        const stateAdvancementRequiresManualReview =
          hasStateAdvancementCandidatesWithoutRuntimeWrite(engineOutput);
        const killSwitchResult = await applyFailClosedIfNeeded({
          engineOutput,
          correlationId,
          observedAt,
          actor,
          provider: input.killSwitchControlProvider,
          runId: begun.run.id,
          stateAdvancementRequiresManualReview,
        });

        await persistReconcileEngineEvidence({
          repository: input.repository,
          runId: begun.run.id,
          engineInput,
          engineOutput,
        });
        const finalStatus = engineOutput.failClosed || stateAdvancementRequiresManualReview
          ? "MANUAL_REVIEW_REQUIRED"
          : "COMPLETED";
        const completedRun = await input.repository.completeLiveReconcileRun({
          runId: begun.run.id,
          status: finalStatus,
          metadata: createLiveReconcileCompletionMetadata({
            engineOutput,
            stateAdvancementRequiresManualReview,
          }),
        });
        const statusSummary = createStatusSummaryFromEngine({
          engineOutput,
          runId: completedRun.id,
          correlationId,
          observedAt,
          websocketStatus: resolveRuntimeWebSocketStatus(engineInput, engineOutput),
          stateAdvancementRequiresManualReview,
        });

        const result: LiveReconcileRuntimeRunResult = {
          run: completedRun,
          engineOutput,
          statusSummary,
        };
        if (killSwitchResult !== undefined) {
          return {
            ...result,
            killSwitchResult,
          };
        }
        return result;
      } catch (error) {
        const failedRun = await input.repository.completeLiveReconcileRun({
          runId: begun.run.id,
          status: "FAILED",
        });
        throw new UnsafeLiveReconcileRuntimeError([
          `live reconcile run failed: ${failedRun.id}`,
          toSafeErrorMessage(error),
        ]);
      }
    },
  };
}

async function loadSnapshotOrRecordFailure(input: {
  repository: LiveReconcileRuntimeRepository;
  observedAt: TimestampInput;
  correlationId: string;
  actor: string;
  provider: CreateLiveReconcileRuntimeWorkerInput["killSwitchControlProvider"];
  loadSnapshot: () => ReturnType<CreateLiveReconcileRuntimeWorkerInput["snapshotProvider"]["loadSnapshot"]>;
}): ReturnType<CreateLiveReconcileRuntimeWorkerInput["snapshotProvider"]["loadSnapshot"]> {
  try {
    return await input.loadSnapshot();
  } catch (error) {
    const failedRun = await recordSnapshotLoadFailureRun(input);
    await applySnapshotFailureFailClosed({
      provider: input.provider,
      runId: failedRun.id,
      correlationId: input.correlationId,
      observedAt: input.observedAt,
      actor: input.actor,
    });
    throw new UnsafeLiveReconcileRuntimeError([
      `live reconcile snapshot load failed: ${failedRun.id}`,
      toSafeErrorMessage(error),
    ]);
  }
}

async function recordSnapshotLoadFailureRun(input: {
  repository: LiveReconcileRuntimeRepository;
  observedAt: TimestampInput;
  correlationId: string;
}): Promise<Awaited<ReturnType<LiveReconcileRuntimeRepository["beginLiveReconcileRun"]>>["run"]> {
  const begun = await input.repository.beginLiveReconcileRun({
    idempotencyKey: createReconcileIdempotencyKey(input.observedAt, input.correlationId),
    guardProfile: "LIVE_READ_ONLY_RECONCILE",
    sourceSummary: "snapshot provider failed before reconcile engine input was available",
    correlationId: input.correlationId,
    metadata: {
      failure_phase: "snapshot_provider",
    },
  });

  if (!begun.created) {
    if (begun.run.status === "RUNNING") {
      // snapshot provider 실패 기록 중 중단된 재시도 run은 계속 실행 중으로 남기지 않고 같은 key에서 FAILED로 닫는다.
      return input.repository.completeLiveReconcileRun({
        runId: begun.run.id,
        status: "FAILED",
        metadata: {
          failure_phase: "snapshot_provider",
          idempotent_failure_recovery: true,
        },
      });
    }
    return begun.run;
  }

  // snapshot 조회 실패도 이전 final summary 뒤에 숨지 않도록 FAILED run으로 남긴다.
  return input.repository.completeLiveReconcileRun({
    runId: begun.run.id,
    status: "FAILED",
  });
}

function createLiveReconcileCompletionMetadata(input: {
  engineOutput: ReconcileEngineOutput;
  stateAdvancementRequiresManualReview: boolean;
}): Record<string, unknown> {
  const { engineOutput } = input;
  return {
    live_reconcile_engine_summary: {
      result: engineOutput.summary.result,
      mismatch_count: engineOutput.summary.mismatchCount,
      open_order_count: {
        exchange: engineOutput.summary.openOrderCount.exchange,
        local: engineOutput.summary.openOrderCount.local,
      },
      balance_status: engineOutput.summary.balanceStatus,
      untracked_exchange_orders: engineOutput.summary.untrackedExchangeOrders,
      missing_local_orders: engineOutput.summary.missingLocalOrders,
      cancel_failures: engineOutput.summary.cancelFailures,
      window_exceeded_orders: engineOutput.summary.windowExceededOrders,
    },
    state_advancement_requires_manual_review: input.stateAdvancementRequiresManualReview,
    live_reconcile_state_advancements: engineOutput.stateAdvancements.map((candidate) => ({
      local_order_id: candidate.localOrderId,
      exchange_order_identity: candidate.exchangeOrderIdentity,
      exchange_status: candidate.exchangeStatus,
      current_local_status: candidate.currentLocalStatus,
      ...(candidate.targetLocalStatus === undefined
        ? {}
        : { target_local_status: candidate.targetLocalStatus }),
      advancement_type: candidate.advancementType,
      reason_code: candidate.reasonCode,
      user_message: candidate.userMessage,
      trace: candidate.trace,
    })),
  };
}

/**
 * 최신 append-only reconcile run을 `/status`용 provider로 연결한다.
 *
 * DB summary에는 engine의 상세 balance status가 없으므로, 최근 run의 최종 상태와 evidence count를 기준으로 보수적인
 * 사용자-facing summary를 만든다. 상세 mismatch trace는 `/status`에 노출하지 않는다.
 */
export function createLiveReconcileStatusProvider(
  repository: LiveReconcileRuntimeRepository,
): ReconcileStatusProvider {
  return {
    async getReconcileStatus(): Promise<ReconcileStatusSummary> {
      const latest = await repository.getLatestLiveReconcileSummary();
      if (latest.run === null) {
        return createReconcileStatusSummary({
          lastReconcileAt: null,
          reconcileResult: null,
          mismatchCount: null,
          openOrderCount: null,
          balanceStatus: null,
          websocketStatus: "DISCONNECTED",
        });
      }

      if (latest.run.status === "FAILED") {
        return {
          lastReconcileAt: toNullableIsoString(latest.run.finished_at ?? latest.run.started_at),
          result: "FAILED",
          mismatchCount: latest.mismatchEvidenceCount,
          openOrderCount: latest.exchangeOrderSnapshotCount,
          balanceStatus: latest.balanceSnapshotCount > 0 ? "OK" : "UNAVAILABLE",
          websocketStatus: "DEGRADED",
          actionRequired: "reconcile 실행이 실패했습니다. 저장된 evidence와 worker 로그를 확인한 뒤 재실행하세요.",
          message: "실계좌 상태 대조를 완료하지 못했습니다. 신규 주문은 안전 확인 전까지 열지 마세요.",
          trace: {
            source: "live_reconcile_status",
            reason: "reconcile_failed",
            runId: latest.run.id,
            ...(latest.run.correlation_id === null ? {} : { correlationId: latest.run.correlation_id }),
          },
        };
      }

      if (latest.run.status === "RUNNING") {
        return {
          lastReconcileAt: toNullableIsoString(latest.run.started_at),
          result: "UNAVAILABLE",
          mismatchCount: null,
          openOrderCount: null,
          balanceStatus: "UNAVAILABLE",
          websocketStatus: "DEGRADED",
          actionRequired: "reconcile 실행 중",
          message: "실계좌 상태 대조가 아직 완료되지 않았습니다. 완료된 run이 기록된 뒤 상태를 다시 확인하세요.",
          trace: {
            source: "live_reconcile_status",
            reason: "reconcile_running",
            runId: latest.run.id,
            ...(latest.run.correlation_id === null ? {} : { correlationId: latest.run.correlation_id }),
          },
        };
      }

      if (latest.run.status === "MANUAL_REVIEW_REQUIRED") {
        // 수동 검토로 닫힌 run은 mismatch evidence가 0건이어도 상태 전진 후보가 미반영된 운영 차단 상태일 수 있다.
        return createManualReviewRequiredStatusSummary(latest, latest.run);
      }

      const reconcileResult =
        latest.mismatchEvidenceCount > 0 ? "MISMATCH_DETECTED" : "CLEAN";

      return createReconcileStatusSummary({
        lastReconcileAt: toNullableIsoString(latest.run.finished_at ?? latest.run.started_at),
        reconcileResult,
        mismatchCount: latest.mismatchEvidenceCount,
        openOrderCount: latest.openExchangeOrderSnapshotCount,
        balanceStatus: resolveLatestBalanceStatus(latest),
        websocketStatus: resolveLatestWebSocketStatus(latest),
        runId: latest.run.id,
        ...(latest.run.correlation_id === null ? {} : { correlationId: latest.run.correlation_id }),
      });
    },
  };
}

/**
 * 최신 reconcile run이 수동 검토 상태로 닫힌 경우의 `/status` summary를 만든다.
 *
 * append-only mismatch evidence가 없어도 state advancement 후보가 로컬 DB write 없이 보류됐을 수 있으므로,
 * `CLEAN`/`SUCCESS`로 낮추지 않고 운영자가 직접 확인해야 하는 상태를 사용자 행동 언어로 반환한다.
 *
 * @param latest repository가 반환한 최신 reconcile summary
 * @param run null이 아님을 호출 경계에서 확인한 최신 reconcile run
 * @returns 운영자 표면에 노출 가능한 수동 검토 summary
 */
function createManualReviewRequiredStatusSummary(
  latest: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>,
  run: NonNullable<
    Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>["run"]
  >,
): ReconcileStatusSummary {
  const hasMismatchEvidence = latest.mismatchEvidenceCount > 0;

  return {
    lastReconcileAt: toNullableIsoString(run.finished_at ?? run.started_at),
    result: "MISMATCH_DETECTED",
    mismatchCount: latest.mismatchEvidenceCount,
    openOrderCount: latest.openExchangeOrderSnapshotCount,
    balanceStatus: toStatusSummaryBalanceStatus(resolveLatestBalanceStatus(latest)),
    websocketStatus: resolveLatestWebSocketStatus(latest),
    actionRequired: hasMismatchEvidence
      ? "수동 검토 필요: 저장된 reconcile evidence를 확인하고 모든 불일치를 해소한 뒤 kill switch를 NORMAL로 복구하세요."
      : "수동 검토 필요: 거래소에서 확인된 주문 상태 전진 후보를 로컬 상태에 반영하거나 기각한 뒤 reconcile을 재실행하세요.",
    message: hasMismatchEvidence
      ? "실계좌 상태 대조에서 수동 확인이 필요한 불일치가 발견되었습니다. 신규 주문은 안전 확인 전까지 열지 마세요."
      : "실계좌 상태 대조가 수동 검토로 닫혔습니다. 로컬 주문 상태가 최신 거래소 관측을 아직 반영하지 않았을 수 있습니다.",
    trace: {
      source: "live_reconcile_status",
      reason: hasMismatchEvidence
        ? "reconcile_manual_review_required"
        : "reconcile_state_advancement_manual_review_required",
      runId: run.id,
      ...(run.correlation_id === null ? {} : { correlationId: run.correlation_id }),
    },
  };
}

/**
 * reconcile runtime guard 상태를 secret-safe 요약으로 변환한다.
 *
 * credential 원문은 boolean으로만 낮추며, 운영자에게는 profile/scope/evidence와 필요한 다음 조치만 보여준다.
 * 이 함수는 순수 변환 함수이며 private client나 worker를 만들지 않는다.
 */
export function createLiveReconcileRuntimeSafeSummaryFromGuard(
  input: CreateLiveReconcileRuntimeSafeSummaryInput,
): LiveReconcileRuntimeSafeSummary {
  return createLiveReconcileRuntimeSafeSummary(input);
}

function withObservedAt(
  input: ReconcileEngineInput,
  observedAt: TimestampInput,
): ReconcileEngineInput {
  return {
    ...input,
    observedAt,
  };
}

async function persistReconcileEngineEvidence(input: {
  repository: LiveReconcileRuntimeRepository;
  runId: string;
  engineInput: ReconcileEngineInput;
  engineOutput: ReconcileEngineOutput;
}): Promise<void> {
  await input.repository.appendLiveReconcileBalanceSnapshots(
    input.runId,
    input.engineInput.exchangeBalances === undefined
      ? []
      : input.engineInput.exchangeBalances.map(toBalanceSnapshotRow),
  );
  await input.repository.appendLiveReconcileExchangeOrderSnapshots(
    input.runId,
    [
      ...input.engineInput.exchangeOpenOrders,
      ...input.engineInput.exchangeClosedOrders,
      ...input.engineInput.orderLookups,
      ...buildWebSocketOrderSnapshots(input.engineInput.websocketContext),
    ].map(toExchangeOrderSnapshotRow),
  );
  // kill switch 전이가 끝난 뒤 append-only evidence를 남겨 차단 상태와 감사 근거가 서로 갈라지지 않게 한다.
  await input.repository.appendLiveReconcileMismatchEvidence(
    input.runId,
    input.engineOutput.mismatches.map(toMismatchEvidenceRow),
  );
}

function toBalanceSnapshotRow(balance: BrokerBalance): {
  currency: string;
  available: string;
  locked: string;
  total: string;
  capturedAt: Date | string;
  source: "REST";
  metadata?: Record<string, unknown>;
} {
  const metadata = sanitizeReconcileEvidenceMetadata(balance.metadata);
  return {
    currency: balance.currency,
    available: balance.available,
    locked: balance.locked,
    total: balance.total,
    capturedAt: balance.updatedAt,
    source: "REST",
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function toExchangeOrderSnapshotRow(order: ReconcileExchangeOrderSnapshot): {
  exchangeOrderId?: string;
  identifier?: string;
  market: string;
  side: "BUY" | "SELL";
  status: string;
  requestedQuantity: string;
  remainingQuantity?: string;
  requestedPrice?: string;
  source: "open" | "closed" | "lookup" | "ws";
  capturedAt: Date | string;
} {
  return {
    ...(order.exchangeOrderId === undefined ? {} : { exchangeOrderId: order.exchangeOrderId }),
    ...(order.identifier === undefined ? {} : { identifier: order.identifier }),
    market: order.market,
    side: order.side,
    status: order.exchangeStatus,
    requestedQuantity: order.requestedQuantity,
    ...(order.remainingQuantity === undefined ? {} : { remainingQuantity: order.remainingQuantity }),
    ...(order.requestedPrice === undefined ? {} : { requestedPrice: order.requestedPrice }),
    source: order.source,
    capturedAt: order.capturedAt,
  };
}

function toMismatchEvidenceRow(evidence: ReconcileMismatchEvidence): {
  mismatchType: string;
  severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  market?: string;
  orderIdentity?: string;
  currency?: string;
  message: string;
  action: string;
  evidenceFingerprint: string;
  trace?: Record<string, unknown>;
  occurredAt: Date | string;
} {
  return {
    mismatchType: evidence.mismatchType,
    severity: evidence.severity,
    ...(evidence.market === undefined ? {} : { market: evidence.market }),
    ...(evidence.orderIdentity === undefined ? {} : { orderIdentity: evidence.orderIdentity }),
    ...(evidence.currency === undefined ? {} : { currency: evidence.currency }),
    message: evidence.userMessage,
    action: evidence.requiredAction,
    evidenceFingerprint: evidence.evidenceFingerprint,
    trace: evidence.trace,
    occurredAt: evidence.occurredAt,
  };
}

async function applyFailClosedIfNeeded(input: {
  engineOutput: ReconcileEngineOutput;
  correlationId: string;
  observedAt: TimestampInput;
  actor: string;
  provider: CreateLiveReconcileRuntimeWorkerInput["killSwitchControlProvider"];
  runId: string;
  stateAdvancementRequiresManualReview: boolean;
}) {
  const shouldApplyKillSwitch =
    input.engineOutput.failClosed || input.stateAdvancementRequiresManualReview;
  if (!shouldApplyKillSwitch || input.provider === undefined) {
    if (shouldApplyKillSwitch) {
      throw new UnsafeLiveReconcileRuntimeError([
        input.stateAdvancementRequiresManualReview
          ? "live reconcile 상태 전진 후보를 차단할 kill switch provider가 없습니다"
          : "live reconcile mismatch를 차단할 kill switch provider가 없습니다",
      ]);
    }
    return undefined;
  }

  const targetState = input.stateAdvancementRequiresManualReview
    ? "MANUAL_REVIEW_REQUIRED"
    : toKillSwitchControlTarget(input.engineOutput);
  if (targetState === undefined) {
    return undefined;
  }

  // mismatch는 신규 주문 허용 신호가 아니므로 append-only evidence보다 먼저 durable kill switch를 닫아 fail-open 창을 없앤다.
  return input.provider.apply({
    targetState,
    reasonCode: input.stateAdvancementRequiresManualReview
      ? "live_reconcile_state_advancement_pending"
      : toKillSwitchReasonCode(input.engineOutput),
    correlationId: input.correlationId,
    actor: input.actor,
    message: input.stateAdvancementRequiresManualReview
      ? "Live reconcile 상태 전진 후보가 확인되어 수동 검토 전까지 신규 주문을 차단합니다."
      : "Live reconcile mismatch가 감지되어 신규 주문을 차단합니다.",
    metadata: {
      live_reconcile_run_id: input.runId,
      mismatch_count: input.engineOutput.summary.mismatchCount,
      state_advancement_count: input.engineOutput.stateAdvancements.length,
    },
    occurredAt: input.observedAt,
  });
}

/**
 * snapshot provider 실패를 durable manual review 전이로 닫는다.
 *
 * 이 함수는 REST/WebSocket read path가 실패해 로컬/거래소 상태를 증명할 수 없을 때 호출된다. 입력의 run id와
 * correlation id를 kill switch evidence에 연결하고, provider가 없거나 실패하면 secret-free 오류로 중단한다.
 * 외부 side effect는 kill switch control port 호출 1회뿐이다.
 */
async function applySnapshotFailureFailClosed(input: {
  provider: CreateLiveReconcileRuntimeWorkerInput["killSwitchControlProvider"];
  runId: string;
  correlationId: string;
  observedAt: TimestampInput;
  actor: string;
}) {
  if (input.provider === undefined) {
    throw new UnsafeLiveReconcileRuntimeError([
      "live reconcile snapshot 실패를 차단할 kill switch provider가 없습니다",
    ]);
  }

  try {
    // read-only snapshot 자체가 없으면 로컬/거래소 상태를 증명할 수 없어 주문 허용을 보수적으로 닫는다.
    return await input.provider.apply({
      targetState: "MANUAL_REVIEW_REQUIRED",
      reasonCode: "live_reconcile_snapshot_provider_failed",
      correlationId: input.correlationId,
      actor: input.actor,
      message: "Live reconcile snapshot 조회가 실패해 수동 검토 전까지 신규 주문을 차단합니다.",
      metadata: {
        live_reconcile_run_id: input.runId,
        failure_phase: "snapshot_provider",
      },
      occurredAt: input.observedAt,
    });
  } catch (error) {
    throw new UnsafeLiveReconcileRuntimeError([
      "live reconcile snapshot 실패 kill switch 전이를 완료하지 못했습니다",
      toSafeErrorMessage(error),
    ]);
  }
}

/**
 * runtime worker가 직접 반영하지 못한 주문 상태 전진 후보가 있는지 판정한다.
 *
 * state advancement 후보는 identity가 일치한 관측이지만 이 worker에는 orders/fills/positions write port가 없다.
 * 따라서 후보가 하나라도 있으면 성공 summary로 숨기지 않고 manual review kill switch 전이로 수렴해야 한다.
 */
function hasStateAdvancementCandidatesWithoutRuntimeWrite(
  engineOutput: ReconcileEngineOutput,
): boolean {
  return engineOutput.stateAdvancements.length > 0;
}

function resolveRuntimeWebSocketStatus(
  engineInput: ReconcileEngineInput,
  engineOutput: ReconcileEngineOutput,
): "CONNECTED" | "DEGRADED" {
  if (
    hasWebSocketLivenessGapEvidence(engineInput.websocketContext.disconnectEvidence) ||
    hasEngineMismatch(engineOutput, "WEBSOCKET_GAP_MANUAL_REVIEW")
  ) {
    return "DEGRADED";
  }
  return "CONNECTED";
}

function resolveLatestBalanceStatus(
  latest: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>,
): "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE" {
  if (latest.balanceSnapshotCount === 0 || latest.mismatchTypes.includes("BALANCE_SNAPSHOT_UNAVAILABLE")) {
    return "NOT_AVAILABLE";
  }
  if (latest.mismatchTypes.includes("BALANCE_LOCK_MISMATCH")) {
    return "LOCK_MISMATCH";
  }
  return "OK";
}

/**
 * repository summary의 balance 판정값을 `/status` public contract로 낮춘다.
 *
 * 내부 engine 용어(`LOCK_MISMATCH`, `NOT_AVAILABLE`)는 사용자-facing summary type에 직접 노출하지 않고,
 * 운영자가 상태를 해석할 수 있는 canonical 값으로 변환한다. 외부 side effect는 없다.
 *
 * @param balanceStatus latest summary에서 계산한 engine balance 상태
 * @returns `/status`에 노출 가능한 balance 상태
 */
function toStatusSummaryBalanceStatus(
  balanceStatus: "OK" | "LOCK_MISMATCH" | "NOT_AVAILABLE",
): ReconcileStatusSummary["balanceStatus"] {
  switch (balanceStatus) {
    case "OK":
      return "OK";
    case "LOCK_MISMATCH":
      return "STALE";
    case "NOT_AVAILABLE":
      return "UNAVAILABLE";
  }
}

function resolveLatestWebSocketStatus(
  latest: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>,
): "CONNECTED" | "DEGRADED" {
  if (latest.mismatchTypes.includes("WEBSOCKET_GAP_MANUAL_REVIEW")) {
    return "DEGRADED";
  }
  return "CONNECTED";
}

function hasEngineMismatch(
  output: ReconcileEngineOutput,
  mismatchType: ReconcileMismatchType,
): boolean {
  return output.mismatches.some((mismatch) => mismatch.mismatchType === mismatchType);
}

function hasWebSocketLivenessGapEvidence(
  evidence: ReconcileEngineInput["websocketContext"]["disconnectEvidence"],
): boolean {
  if (evidence === undefined) {
    return false;
  }
  return (
    evidence.disconnectedAt !== undefined ||
    evidence.reconnectedAt !== undefined ||
    (evidence.gapDurationMs ?? 0) > 0 ||
    (evidence.reconnectCount ?? 0) > 0
  );
}

function toKillSwitchReasonCode(output: ReconcileEngineOutput): string {
  if (hasEngineMismatch(output, "ORDER_IDENTITY_CONFLICT")) {
    return "live_reconcile_identity_conflict";
  }
  if (hasEngineMismatch(output, "BALANCE_LOCK_MISMATCH")) {
    return "live_reconcile_balance_lock_mismatch";
  }
  if (hasEngineMismatch(output, "BALANCE_SNAPSHOT_UNAVAILABLE")) {
    return "live_reconcile_balance_snapshot_unavailable";
  }
  if (hasEngineMismatch(output, "WEBSOCKET_GAP_MANUAL_REVIEW")) {
    return "live_reconcile_websocket_gap";
  }
  if (hasEngineMismatch(output, "ORDER_STATE_ADVANCEMENT_BLOCKED")) {
    return "live_reconcile_order_state_advancement_blocked";
  }
  if (hasEngineMismatch(output, "EXCHANGE_CANCEL_STATE_MISMATCH")) {
    return "live_reconcile_exchange_cancel_state_mismatch";
  }
  if (hasEngineMismatch(output, "CANCEL_FAILURE_RETRY_NEEDED")) {
    return "live_reconcile_cancel_retry_needed";
  }
  return "live_reconcile_mismatch";
}

function toKillSwitchControlTarget(
  output: ReconcileEngineOutput,
): KillSwitchControlTargetState | undefined {
  const targetState = output.targetKillSwitchState ?? "NEW_ORDERS_BLOCKED";
  if (targetState === "NEW_ORDERS_BLOCKED" || targetState === "MANUAL_REVIEW_REQUIRED") {
    return targetState;
  }
  return undefined;
}

function createStatusSummaryFromEngine(input: {
  engineOutput: ReconcileEngineOutput;
  runId: string;
  correlationId: string;
  observedAt: TimestampInput;
  websocketStatus: "CONNECTED" | "DEGRADED";
  stateAdvancementRequiresManualReview: boolean;
}): ReconcileStatusSummary {
  return createReconcileStatusSummary({
    lastReconcileAt: toIsoString(input.observedAt),
    reconcileResult: input.stateAdvancementRequiresManualReview
      ? "MISMATCH_DETECTED"
      : input.engineOutput.summary.result,
    mismatchCount: input.engineOutput.summary.mismatchCount,
    openOrderCount: input.engineOutput.summary.openOrderCount.exchange,
    balanceStatus: input.engineOutput.summary.balanceStatus,
    websocketStatus: input.websocketStatus,
    runId: input.runId,
    correlationId: input.correlationId,
  });
}

function createReconcileCorrelationId(observedAt: TimestampInput): string {
  return `live-reconcile-${toIsoString(observedAt)}`;
}

function createReconcileIdempotencyKey(
  observedAt: TimestampInput,
  correlationId: string,
): string {
  return `live-reconcile:${toIsoString(observedAt)}:${correlationId}`;
}

function toIsoString(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}

// raw provider payload와 credential 후보 key는 append-only reconcile evidence에 보존하지 않는다.
const rawProviderMetadataKeys = new Set([
  "raw",
  "raw_payload",
  "rawPayload",
  "provider_payload",
  "providerPayload",
  "authorization",
  "Authorization",
  "jwt",
  "JWT",
  "accessKey",
  "secretKey",
  "upbitAccessKey",
  "upbitSecretKey",
]);

/**
 * append-only reconcile evidence에 저장할 metadata를 secret-safe 형태로 줄인다.
 *
 * provider raw payload, Authorization/JWT, credential 후보 key를 재귀적으로 제거한다. 안전 필드는 유지하고,
 * 제거 후 빈 객체만 남으면 metadata 자체를 생략한다. 외부 side effect는 없다.
 */
function sanitizeReconcileEvidenceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const sanitized = sanitizeReconcileEvidenceValue(metadata);
  if (!isRecord(sanitized) || Object.keys(sanitized).length === 0) {
    return undefined;
  }
  return sanitized;
}

/**
 * metadata 내부 값을 재귀적으로 redaction한다.
 *
 * 배열은 순서를 유지하고 객체는 raw/credential 후보 key만 제거한다. DB에 쓰기 직전 호출되는 순수 변환 경계다.
 */
function sanitizeReconcileEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeReconcileEvidenceValue);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (rawProviderMetadataKeys.has(key)) {
      continue;
    }
    const sanitizedValue = sanitizeReconcileEvidenceValue(nestedValue);
    if (isRecord(sanitizedValue) && Object.keys(sanitizedValue).length === 0) {
      continue;
    }
    sanitized[key] = sanitizedValue;
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
