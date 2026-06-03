import { runReconcileEngine } from "../../application/index.js";
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
      const snapshot = await input.snapshotProvider.loadSnapshot({
        observedAt,
        correlationId,
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

        const killSwitchResult = await applyFailClosedIfNeeded({
          engineOutput,
          correlationId,
          observedAt,
          actor,
          provider: input.killSwitchControlProvider,
          runId: begun.run.id,
        });

        await persistReconcileEngineEvidence({
          repository: input.repository,
          runId: begun.run.id,
          engineInput,
          engineOutput,
        });
        const finalStatus = engineOutput.failClosed
          ? "MANUAL_REVIEW_REQUIRED"
          : "COMPLETED";
        const completedRun = await input.repository.completeLiveReconcileRun({
          runId: begun.run.id,
          status: finalStatus,
        });
        const statusSummary = createStatusSummaryFromEngine({
          engineOutput,
          runId: completedRun.id,
          correlationId,
          observedAt,
          websocketStatus: resolveRuntimeWebSocketStatus(engineInput, engineOutput),
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
    ].map(toExchangeOrderSnapshotRow),
  );
  // mismatch evidence는 kill switch 전이보다 먼저 durable하게 남겨 재시작 후에도 차단 근거를 추적할 수 있게 한다.
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
  return {
    currency: balance.currency,
    available: balance.available,
    locked: balance.locked,
    total: balance.total,
    capturedAt: balance.updatedAt,
    source: "REST",
    ...(balance.metadata === undefined ? {} : { metadata: balance.metadata }),
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
}) {
  if (!input.engineOutput.failClosed || input.provider === undefined) {
    if (input.engineOutput.failClosed) {
      throw new UnsafeLiveReconcileRuntimeError([
        "live reconcile mismatch를 차단할 kill switch provider가 없습니다",
      ]);
    }
    return undefined;
  }

  const targetState = toKillSwitchControlTarget(input.engineOutput);
  if (targetState === undefined) {
    return undefined;
  }

  // mismatch는 신규 주문 허용 신호가 아니므로 append-only evidence보다 먼저 durable kill switch를 닫아 fail-open 창을 없앤다.
  return input.provider.apply({
    targetState,
    reasonCode: targetState === "MANUAL_REVIEW_REQUIRED"
      ? "live_reconcile_identity_conflict"
      : "live_reconcile_mismatch",
    correlationId: input.correlationId,
    actor: input.actor,
    message: "Live reconcile mismatch가 감지되어 신규 주문을 차단합니다.",
    metadata: {
      live_reconcile_run_id: input.runId,
      mismatch_count: input.engineOutput.summary.mismatchCount,
    },
    occurredAt: input.observedAt,
  });
}

function resolveRuntimeWebSocketStatus(
  engineInput: ReconcileEngineInput,
  engineOutput: ReconcileEngineOutput,
): "CONNECTED" | "DEGRADED" {
  if (
    engineInput.websocketContext.disconnectEvidence !== undefined ||
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

function resolveLatestWebSocketStatus(
  latest: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>,
): "CONNECTED" | "DEGRADED" {
  if (
    latest.run?.status === "MANUAL_REVIEW_REQUIRED" ||
    latest.mismatchTypes.includes("WEBSOCKET_GAP_MANUAL_REVIEW")
  ) {
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
}): ReconcileStatusSummary {
  return createReconcileStatusSummary({
    lastReconcileAt: toIsoString(input.observedAt),
    reconcileResult: input.engineOutput.summary.result,
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
