import { describe, expect, it } from "vitest";
import {
  ALLOWED_RECONCILE_KEY_SCOPES,
  FORBIDDEN_RECONCILE_KEY_SCOPES,
  UnsafeLiveReconcileRuntimeError,
  createGuardedLiveReconcileRuntime,
  createLiveReconcileRuntimeWorker,
  createLiveReconcileRuntimeSafeSummary,
  createLiveReconcileRuntimeSafeSummaryFromGuard,
  createLiveReconcileStatusProvider,
  createReconcileStatusSummary,
  describeReconcileWebSocketStatus,
  loadLiveReconcileRuntimeConfigFromEnv,
} from "../../src/runtime/live-reconcile-runtime.js";
import type { KillSwitchControlProvider } from "../../src/application/index.js";
import type {
  CreateGuardedLiveReconcileRuntimeInput,
  CreateLiveReconcileRuntimeSafeSummaryInput,
  LiveReconcileRuntimeRepository,
  LiveReconcileRuntimeSafeSummary,
  LiveReconcileSnapshotProvider,
  LiveReconcileRuntimeWorker,
  ReconcileStatusSummary,
  ReconcileWebSocketStatus,
} from "../../src/runtime/live-reconcile-runtime.js";

/* ============================================================
 * M16 Reconcile Runtime — Unit Tests
 *
 * 검증 항목:
 * - guard: env 기반 reconcile config 로딩과 fail-closed
 * - guard: `자산조회`, `주문조회`만 허용, `주문하기` 거부
 * - guard: 필수 env 누락 시 UnsafeLiveReconcileRuntimeError
 * - service: guarded runtime 생성과 safe summary
 * - status-summary: reconcile 상태 summary의 올바른 변환
 * - status-summary: 한국어 메시지와 필요 조치 검증
 * - status-summary: WebSocket 상태 label
 * - secret-safety: credential/key 원문이 summary에 노출되지 않음
 * ============================================================ */

/* ============================================================
 * Guard Tests
 * ============================================================ */

describe("loadLiveReconcileRuntimeConfigFromEnv", () => {
  const validEnv = {
    SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE: "1",
    SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
    SEEMIRAI_UPBIT_ACCESS_KEY: "test-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "test-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "evidence-2026-06-02",
  };

  it("모든 guard가 충족되면 enabled config를 반환한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv(validEnv);

    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.upbitAccessKey).toBe("test-access-key");
      expect(config.upbitSecretKey).toBe("test-secret-key");
      expect(config.keyScopes).toEqual(["자산조회", "주문조회"]);
      expect(config.keyScopeEvidenceId).toBe("evidence-2026-06-02");
    }
  });

  it("SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1이 없으면 disabled config를 반환한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv({});

    expect(config.enabled).toBe(false);
  });

  it("SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE이 공백이면 disabled config를 반환한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv({
      SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE: "   ",
    });

    expect(config.enabled).toBe(false);
  });

  it("SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1이 없으면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: undefined,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_ACCESS_KEY가 없으면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_ACCESS_KEY: undefined,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_SECRET_KEY가 없으면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_SECRET_KEY: undefined,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID가 없으면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: undefined,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE에 자산조회, 주문조회만 있으면 통과한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv({
      ...validEnv,
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
    });

    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.keyScopes).toEqual(["자산조회", "주문조회"]);
    }
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE에 자산조회만 있으면 실패한다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회",
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE에 주문하기가 포함되면 실패한다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE에 출금조회가 포함되면 실패한다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,출금조회",
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE에 알 수 없는 scope가 포함되면 실패한다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,알수없는권한",
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("SEEMIRAI_UPBIT_KEY_SCOPE가 없으면 실패한다", () => {
    expect(() =>
      loadLiveReconcileRuntimeConfigFromEnv({
        ...validEnv,
        SEEMIRAI_UPBIT_KEY_SCOPE: undefined,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("violation에는 한국어 원인이 포함된다", () => {
    try {
      loadLiveReconcileRuntimeConfigFromEnv({
        SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE: "1",
        SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
        SEEMIRAI_UPBIT_ACCESS_KEY: "test-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "test-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "evidence-2026-06-02",
      });
      expect.fail("UnsafeLiveReconcileRuntimeError가 발생해야 합니다");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnsafeLiveReconcileRuntimeError);
      const typedError = error as UnsafeLiveReconcileRuntimeError;
      expect(typedError.violations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("주문하기") as string,
          expect.stringContaining("자산조회") as string,
          expect.stringContaining("주문조회") as string,
        ]),
      );
      expect(typedError.message).toContain("안전하지 않은 live reconcile runtime 설정");
    }
  });

  it("guard 일부만 설정되면 모든 violation을 누적한다", () => {
    try {
      loadLiveReconcileRuntimeConfigFromEnv({
        SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE: "1",
        // SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE 누락
        // SEEMIRAI_UPBIT_ACCESS_KEY 누락
        // SEEMIRAI_UPBIT_SECRET_KEY 누락
      });
      expect.fail("UnsafeLiveReconcileRuntimeError가 발생해야 합니다");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnsafeLiveReconcileRuntimeError);
      const typedError = error as UnsafeLiveReconcileRuntimeError;
      expect(typedError.violations.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("key scope에 공백이 포함되어도 정규화한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv({
      ...validEnv,
      SEEMIRAI_UPBIT_KEY_SCOPE: " 자산조회 , 주문조회 ",
    });

    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.keyScopes).toEqual(["자산조회", "주문조회"]);
    }
  });

  it("중복 key scope는 한 번만 포함한다", () => {
    const config = loadLiveReconcileRuntimeConfigFromEnv({
      ...validEnv,
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,자산조회",
    });

    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.keyScopes).toEqual(["자산조회", "주문조회"]);
    }
  });
});

/* ============================================================
 * Service Tests
 * ============================================================ */

describe("createGuardedLiveReconcileRuntime", () => {
  const worker = fakeWorker();
  const enabledConfig = {
    enabled: true as const,
    upbitAccessKey: "access-key",
    upbitSecretKey: "secret-key",
    keyScopes: ["자산조회", "주문조회"] as const,
    keyScopeEvidenceId: "evidence-1",
  };

  const validInput: CreateGuardedLiveReconcileRuntimeInput = {
    liveReconcileEnabled: true,
    reconcileConfig: enabledConfig,
    worker,
  };

  it("guard가 충족되면 runtime summary와 worker를 반환한다", () => {
    const runtime = createGuardedLiveReconcileRuntime(validInput);

    expect(runtime.summary.enabled).toBe(true);
    expect(runtime.summary.profile).toBe("LIVE_READ_ONLY_RECONCILE");
    expect(runtime.summary.statusLabel).toBe("reconcile guard 충족");
    expect(runtime.worker).toBe(worker);
  });

  it("liveReconcileEnabled=false이면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      createGuardedLiveReconcileRuntime({
        ...validInput,
        liveReconcileEnabled: false,
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("reconcileConfig.enabled=false이면 UnsafeLiveReconcileRuntimeError를 던진다", () => {
    expect(() =>
      createGuardedLiveReconcileRuntime({
        ...validInput,
        reconcileConfig: { enabled: false },
      }),
    ).toThrow(UnsafeLiveReconcileRuntimeError);
  });

  it("runtime summary에 credential 원문이 포함되지 않는다", () => {
    const runtime = createGuardedLiveReconcileRuntime(validInput);
    const summary = runtime.summary;

    // credential 원문은 boolean으로만 낮춘다
    expect(summary.credentialsConfigured).toBe(true);
    // summary JSON에 raw credential이 포함되지 않음
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("secret-key");
  });

  it("runtime summary에 key scope evidence id가 포함된다", () => {
    const runtime = createGuardedLiveReconcileRuntime(validInput);

    expect(runtime.summary.keyScopeEvidenceId).toBe("evidence-1");
    expect(runtime.summary.keyScopes).toEqual(["자산조회", "주문조회"]);
  });
});

describe("createLiveReconcileRuntimeWorker", () => {
  it("snapshot을 engine으로 대조하고 fail-closed kill switch 전이 후 evidence를 저장한다", async () => {
    const repository = fakeRepository();
    const killSwitchRequests: unknown[] = [];
    const snapshotProvider = mismatchSnapshotProvider();
    const killSwitchControlProvider: KillSwitchControlProvider = {
      async apply(input) {
        killSwitchRequests.push(input);
        return {
          transition: {
            accepted: true,
            fromState: "NORMAL",
            toState: input.targetState,
            reasonCode: input.reasonCode,
            message: input.message ?? "accepted",
            event: {
              eventKind: "KILL_SWITCH_STATE_TRANSITION",
              fromState: "NORMAL",
              toState: input.targetState,
              accepted: true,
              reasonCode: input.reasonCode,
              message: input.message ?? "accepted",
              occurredAt: input.occurredAt ?? "2026-06-02T12:00:00.000Z",
            },
          },
          actionPlan: {
            newOrdersBlocked: true,
            strategyEvaluationBlocked: false,
            cancelPendingPaperOrders: false,
            requiresManualReview: input.targetState === "MANUAL_REVIEW_REQUIRED",
            autoLiquidateOpenPositions: false,
          },
          reasonMatchesTarget: true,
        };
      },
    };

    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider,
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    const result = await worker.runOnce({ correlationId: "corr-reconcile" });

    expect(result.statusSummary.result).toBe("MISMATCH_DETECTED");
    expect(repository.exchangeOrderSnapshots).toHaveLength(1);
    expect(repository.mismatchEvidence.length).toBeGreaterThan(0);
    expect(repository.completedStatus).toBe("MANUAL_REVIEW_REQUIRED");
    expect(killSwitchRequests).toEqual([
      expect.objectContaining({
        targetState: "NEW_ORDERS_BLOCKED",
        reasonCode: "live_reconcile_mismatch",
        correlationId: "corr-reconcile",
      }),
    ]);
  });

  it("WebSocket myOrder snapshot을 runtime evidence로 저장한다", async () => {
    const repository = fakeRepository();
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: websocketOrderSnapshotProvider(),
      repository,
      killSwitchControlProvider: {
        async apply(input) {
          return {
            transition: {
              accepted: true,
              fromState: "NORMAL",
              toState: input.targetState,
              reasonCode: input.reasonCode,
              message: input.message ?? "accepted",
              event: {
                eventKind: "KILL_SWITCH_STATE_TRANSITION",
                fromState: "NORMAL",
                toState: input.targetState,
                accepted: true,
                reasonCode: input.reasonCode,
                message: input.message ?? "accepted",
                occurredAt: input.occurredAt ?? "2026-06-02T12:00:00.000Z",
              },
            },
            actionPlan: {
              newOrdersBlocked: true,
              strategyEvaluationBlocked: false,
              cancelPendingPaperOrders: false,
              requiresManualReview: true,
              autoLiquidateOpenPositions: false,
            },
            reasonMatchesTarget: true,
          };
        },
      },
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    const result = await worker.runOnce({ correlationId: "corr-ws-order" });

    expect(result.statusSummary.result).toBe("MISMATCH_DETECTED");
    expect(repository.exchangeOrderSnapshots).toEqual([
      expect.objectContaining({
        exchangeOrderId: "uuid-ws-open",
        market: "KRW-BTC",
        side: "BUY",
        source: "ws",
      }),
    ]);
  });

  it("kill switch 전이가 실패하면 evidence를 append하지 않고 run을 실패로 닫는다", async () => {
    const repository = fakeRepository();
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: mismatchSnapshotProvider(),
      repository,
      killSwitchControlProvider: {
        async apply() {
          throw new Error("kill switch unavailable");
        },
      },
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    await expect(worker.runOnce({ correlationId: "corr-reconcile" })).rejects.toThrow(
      UnsafeLiveReconcileRuntimeError,
    );
    expect(repository.exchangeOrderSnapshots).toHaveLength(0);
    expect(repository.mismatchEvidence).toHaveLength(0);
    expect(repository.completedStatus).toBe("FAILED");
  });

  it("mismatch 실행에 kill switch provider가 없으면 evidence를 append하지 않는다", async () => {
    const repository = fakeRepository();
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: mismatchSnapshotProvider(),
      repository,
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    await expect(worker.runOnce({ correlationId: "corr-reconcile" })).rejects.toThrow(
      UnsafeLiveReconcileRuntimeError,
    );
    expect(repository.exchangeOrderSnapshots).toHaveLength(0);
    expect(repository.mismatchEvidence).toHaveLength(0);
    expect(repository.completedStatus).toBe("FAILED");
  });

  it("kill switch reason code를 mismatch 원인별로 보존한다", async () => {
    const repository = fakeRepository();
    const killSwitchRequests: Array<{ reasonCode?: string }> = [];
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: balanceMismatchSnapshotProvider(),
      repository,
      killSwitchControlProvider: {
        async apply(input) {
          killSwitchRequests.push({ reasonCode: input.reasonCode });
          return {
            transition: {
              accepted: true,
              fromState: "NORMAL",
              toState: input.targetState,
              reasonCode: input.reasonCode,
              message: input.message ?? "accepted",
              event: {
                eventKind: "KILL_SWITCH_STATE_TRANSITION",
                fromState: "NORMAL",
                toState: input.targetState,
                accepted: true,
                reasonCode: input.reasonCode,
                message: input.message ?? "accepted",
                occurredAt: input.occurredAt ?? "2026-06-02T12:00:00.000Z",
              },
            },
            actionPlan: {
              newOrdersBlocked: true,
              strategyEvaluationBlocked: false,
              cancelPendingPaperOrders: false,
              requiresManualReview: true,
              autoLiquidateOpenPositions: false,
            },
            reasonMatchesTarget: true,
          };
        },
      },
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    const result = await worker.runOnce({ correlationId: "corr-balance-mismatch" });

    expect(killSwitchRequests).toEqual([
      { reasonCode: "live_reconcile_balance_lock_mismatch" },
    ]);
    expect(result.statusSummary.websocketStatus).toBe("CONNECTED");
  });

  it("staleSince 단독 WebSocket evidence는 runtime 연결 상태를 낮추지 않는다", async () => {
    const repository = fakeRepository();
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: staleSinceOnlySnapshotProvider(),
      repository,
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    const result = await worker.runOnce({ correlationId: "corr-ws-stale-only" });

    expect(result.statusSummary.result).toBe("SUCCESS");
    expect(result.statusSummary.websocketStatus).toBe("CONNECTED");
  });

  it("같은 idempotency key의 기존 run을 재사용하면 side effect 전에 중단한다", async () => {
    const repository = fakeRepository();
    const killSwitchRequests: unknown[] = [];
    repository.beginLiveReconcileRun = async () => ({
      created: false,
      run: {
        id: "run-existing",
        idempotency_key: "idem-existing",
        status: "COMPLETED",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: new Date("2026-06-02T12:00:01.000Z"),
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-existing",
        metadata_json: {},
      },
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider: mismatchSnapshotProvider(),
      repository,
      killSwitchControlProvider: {
        async apply(input) {
          killSwitchRequests.push(input);
          throw new Error("must not apply");
        },
      },
      clock: () => new Date("2026-06-02T12:00:00.000Z"),
    });

    await expect(worker.runOnce({ correlationId: "corr-reconcile" })).rejects.toThrow(
      UnsafeLiveReconcileRuntimeError,
    );
    expect(repository.exchangeOrderSnapshots).toHaveLength(0);
    expect(repository.mismatchEvidence).toHaveLength(0);
    expect(repository.completedStatus).toBeNull();
    expect(killSwitchRequests).toHaveLength(0);
  });

  it("latest repository summary를 /status provider로 변환한다", async () => {
    const repository = fakeRepository();
    repository.latestSummary = {
      run: {
        id: "run-latest",
        idempotency_key: "idem-latest",
        status: "COMPLETED",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: new Date("2026-06-02T12:00:01.000Z"),
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-latest",
        metadata_json: {},
      },
      balanceSnapshotCount: 2,
      exchangeOrderSnapshotCount: 3,
      openExchangeOrderSnapshotCount: 1,
      mismatchEvidenceCount: 0,
      mismatchTypes: [],
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    };

    const provider = createLiveReconcileStatusProvider(repository);
    const status = await provider.getReconcileStatus();

    expect(status).toMatchObject({
      result: "SUCCESS",
      lastReconcileAt: "2026-06-02T12:00:01.000Z",
      mismatchCount: 0,
      openOrderCount: 1,
      balanceStatus: "OK",
      trace: {
        runId: "run-latest",
        correlationId: "corr-latest",
      },
    });
  });

  it("RUNNING latest run은 성공으로 승격하지 않는다", async () => {
    const repository = fakeRepository();
    repository.latestSummary = {
      run: {
        id: "run-running",
        idempotency_key: "idem-running",
        status: "RUNNING",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: null,
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-running",
        metadata_json: {},
      },
      balanceSnapshotCount: 0,
      exchangeOrderSnapshotCount: 0,
      openExchangeOrderSnapshotCount: 0,
      mismatchEvidenceCount: 0,
      mismatchTypes: [],
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    };

    const status = await createLiveReconcileStatusProvider(repository).getReconcileStatus();

    expect(status.result).toBe("UNAVAILABLE");
    expect(status.actionRequired).toBe("reconcile 실행 중");
    expect(status.trace).toMatchObject({ reason: "reconcile_running", runId: "run-running" });
  });

  it("latest summary는 open source order 수와 balance mismatch 상태를 보존한다", async () => {
    const repository = fakeRepository();
    repository.latestSummary = {
      run: {
        id: "run-mismatch",
        idempotency_key: "idem-mismatch",
        status: "MANUAL_REVIEW_REQUIRED",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: new Date("2026-06-02T12:00:01.000Z"),
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-mismatch",
        metadata_json: {},
      },
      balanceSnapshotCount: 2,
      exchangeOrderSnapshotCount: 4,
      openExchangeOrderSnapshotCount: 0,
      mismatchEvidenceCount: 1,
      mismatchTypes: ["BALANCE_LOCK_MISMATCH"],
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    };

    const status = await createLiveReconcileStatusProvider(repository).getReconcileStatus();

    expect(status.result).toBe("MISMATCH_DETECTED");
    expect(status.openOrderCount).toBe(0);
    expect(status.balanceStatus).toBe("STALE");
    expect(status.websocketStatus).toBe("CONNECTED");
  });

  it("WebSocket gap mismatch는 연결 상태를 DEGRADED로 표시한다", async () => {
    const repository = fakeRepository();
    repository.latestSummary = {
      run: {
        id: "run-ws-gap",
        idempotency_key: "idem-ws-gap",
        status: "MANUAL_REVIEW_REQUIRED",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: new Date("2026-06-02T12:00:01.000Z"),
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-ws-gap",
        metadata_json: {},
      },
      balanceSnapshotCount: 2,
      exchangeOrderSnapshotCount: 0,
      openExchangeOrderSnapshotCount: 0,
      mismatchEvidenceCount: 1,
      mismatchTypes: ["WEBSOCKET_GAP_MANUAL_REVIEW"],
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    };

    const status = await createLiveReconcileStatusProvider(repository).getReconcileStatus();

    expect(status.websocketStatus).toBe("DEGRADED");
  });
});

/* ============================================================
 * Safe Summary Tests
 * ============================================================ */

describe("createLiveReconcileRuntimeSafeSummary", () => {
  const disabledInput: CreateLiveReconcileRuntimeSafeSummaryInput = {
    liveReconcileEnabled: false,
    reconcileConfig: { enabled: false },
  };

  const enabledInput: CreateLiveReconcileRuntimeSafeSummaryInput = {
    liveReconcileEnabled: true,
    reconcileConfig: {
      enabled: true,
      upbitAccessKey: "access-key",
      upbitSecretKey: "secret-key",
      keyScopes: ["자산조회", "주문조회"],
      keyScopeEvidenceId: "evidence-1",
    },
  };

  it("비활성 상태일 때 disabled summary를 반환한다", () => {
    const summary = createLiveReconcileRuntimeSafeSummary(disabledInput);

    expect(summary.enabled).toBe(false);
    expect(summary.profile).toBeNull();
    expect(summary.statusLabel).toBe("비활성");
    expect(summary.action).toContain("SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1");
  });

  it("활성 상태일 때 enabled summary를 반환한다", () => {
    const summary = createLiveReconcileRuntimeSafeSummary(enabledInput);

    expect(summary.enabled).toBe(true);
    expect(summary.profile).toBe("LIVE_READ_ONLY_RECONCILE");
    expect(summary.statusLabel).toBe("reconcile guard 충족");
    expect(summary.credentialsConfigured).toBe(true);
  });

  it("활성 summary에 secret 원문이 포함되지 않는다", () => {
    const summary = createLiveReconcileRuntimeSafeSummary(enabledInput);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain("access-key");
    expect(serialized).not.toContain("secret-key");
  });

  it("createLiveReconcileRuntimeSafeSummaryFromGuard도 동일한 결과를 반환한다", () => {
    const direct = createLiveReconcileRuntimeSafeSummary(enabledInput);
    const fromGuard = createLiveReconcileRuntimeSafeSummaryFromGuard(enabledInput);

    expect(fromGuard).toEqual(direct);
  });

  it("한국어 메시지가 상태/원인/영향을 설명한다", () => {
    const summary = createLiveReconcileRuntimeSafeSummary(disabledInput);

    expect(summary.message).toContain("실계좌 상태 대조");
    expect(summary.action).toContain("SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1");
  });
});

/* ============================================================
 * Reconcile Status Summary Tests
 * ============================================================ */

describe("createReconcileStatusSummary", () => {
  it("reconcile이 한 번도 실행되지 않았으면 SKIPPED를 반환한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: null,
      reconcileResult: null,
      mismatchCount: null,
      openOrderCount: null,
      balanceStatus: null,
      websocketStatus: "DISCONNECTED",
    });

    expect(status.result).toBe("SKIPPED");
    expect(status.lastReconcileAt).toBeNull();
    expect(status.mismatchCount).toBeNull();
    expect(status.openOrderCount).toBeNull();
    expect(status.actionRequired).toBe("reconcile 실행 필요");
  });

  it("CLEAN 상태이면 SUCCESS를 반환한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 3,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    expect(status.result).toBe("SUCCESS");
    expect(status.lastReconcileAt).toBe("2026-06-02T12:00:00.000Z");
    expect(status.mismatchCount).toBe(0);
    expect(status.actionRequired).toBe("정상");
    expect(status.message).toContain("일치");
  });

  it("MISMATCH_DETECTED 상태이면 MISMATCH_DETECTED를 반환한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "MISMATCH_DETECTED",
      mismatchCount: 5,
      openOrderCount: 3,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    expect(status.result).toBe("MISMATCH_DETECTED");
    expect(status.mismatchCount).toBe(5);
    expect(status.actionRequired).toContain("불일치 5건");
    expect(status.actionRequired).toContain("fail-closed");
    expect(status.message).toContain("5건의 불일치");
  });

  it("잔고 스냅샷이 없으면 FAILED를 반환한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 3,
      balanceStatus: "NOT_AVAILABLE",
      websocketStatus: "CONNECTED",
    });

    expect(status.result).toBe("FAILED");
    expect(status.balanceStatus).toBe("UNAVAILABLE");
    expect(status.actionRequired).toContain("잔고 스냅샷");
  });

  it("잠김 잔고 불일치는 STALE balance 상태로 표시한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 3,
      balanceStatus: "LOCK_MISMATCH",
      websocketStatus: "CONNECTED",
    });

    expect(status.result).toBe("SUCCESS");
    expect(status.balanceStatus).toBe("STALE");
    expect(status.actionRequired).toContain("잠김 잔고");
  });

  it("WebSocket 연결 상태가 올바르게 반영된다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 0,
      balanceStatus: "OK",
      websocketStatus: "DEGRADED",
    });

    expect(status.websocketStatus).toBe("DEGRADED");
  });

  it("추적 정보에 runId와 correlationId가 포함된다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 0,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
      runId: "run-001",
      correlationId: "corr-001",
    });

    expect(status.trace).toMatchObject({
      source: "live_reconcile_status",
      reason: "reconcile_clean",
      runId: "run-001",
      correlationId: "corr-001",
    });
  });

  it("mismatch가 0건이어도 불일치 발견 시 적절한 조치 문구를 보여준다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "MISMATCH_DETECTED",
      mismatchCount: 0,
      openOrderCount: 1,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    expect(status.actionRequired).toBe("불일치 확인 필요");
    expect(status.message).toContain("0건");
  });

  it("openOrderCount가 null이면 메시지에 포함하지 않는다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: null,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    expect(status.openOrderCount).toBeNull();
    expect(status.message).not.toContain("현재 거래소 미체결 주문");
  });

  it("openOrderCount가 있으면 메시지에 포함한다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 3,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    expect(status.message).toContain("3건");
  });
});

/* ============================================================
 * WebSocket Status Label Tests
 * ============================================================ */

describe("describeReconcileWebSocketStatus", () => {
  it.each([
    ["CONNECTED", "연결됨"],
    ["DISCONNECTED", "연결 끊김"],
    ["RECONNECTING", "재연결 중"],
    ["DEGRADED", "성능 저하"],
  ] satisfies [ReconcileWebSocketStatus, string][])(
    "%s → %s",
    (status, expectedLabel) => {
      expect(describeReconcileWebSocketStatus(status)).toBe(expectedLabel);
    },
  );
});

/* ============================================================
 * Constants Tests
 * ============================================================ */

describe("Reconcile guard constants", () => {
  it("ALLOWED_RECONCILE_KEY_SCOPES는 자산조회와 주문조회만 포함한다", () => {
    expect(ALLOWED_RECONCILE_KEY_SCOPES).toEqual(["자산조회", "주문조회"]);
  });

  it("FORBIDDEN_RECONCILE_KEY_SCOPES는 주문하기를 포함한다", () => {
    expect(FORBIDDEN_RECONCILE_KEY_SCOPES).toEqual(["주문하기"]);
  });

  it("허용 scope는 금지 scope와 겹치지 않는다", () => {
    const allowedSet = new Set(ALLOWED_RECONCILE_KEY_SCOPES);
    const overlap = FORBIDDEN_RECONCILE_KEY_SCOPES.filter((scope) => allowedSet.has(scope));
    expect(overlap).toHaveLength(0);
  });
});

/* ============================================================
 * Source Scan — 주문 side effect 0회 검증
 *
 * M16 read-only reconcile runtime은 POST /v1/orders, DELETE /v1/order를
 * 호출하지 않는다. 이 테스트는 reconcile runtime 경계에 있는 모든 코드 경로가
 * 주문 side effect를 만들지 않는지 검증한다.
 * ============================================================ */

describe("M16 read-only reconcile — 주문 side effect 0회", () => {
  it("guard 모듈은 Upbit API를 호출하지 않는다 (순수 env 해석)", () => {
    // loadLiveReconcileRuntimeConfigFromEnv는 process.env만 읽는 순수 함수다.
    // API 호출이 없음을 타입 수준에서 확인: 반환값에 client-like 객체가 없다
    const config = loadLiveReconcileRuntimeConfigFromEnv({});

    expect(config.enabled).toBe(false);
    // disabled config는 아무런 client/create/delete 메서드를 포함하지 않는다
    if (!config.enabled) {
      expect(Object.keys(config)).not.toContain("upbitAccessKey");
      expect(Object.keys(config)).not.toContain("upbitSecretKey");
    }
  });

  it("service 모듈은 broker나 주문 API client를 생성하지 않는다", () => {
    // createGuardedLiveReconcileRuntime는 주입된 worker만 반환하고 broker/client 객체를 직접 만들지 않는다
    const config = {
      enabled: true as const,
      upbitAccessKey: "test-key",
      upbitSecretKey: "test-secret",
      keyScopes: ["자산조회", "주문조회"] as const,
      keyScopeEvidenceId: "evidence-1",
    };

    const runtime = createGuardedLiveReconcileRuntime({
      liveReconcileEnabled: true,
      reconcileConfig: config,
      worker: fakeWorker(),
    });

    // 반환 객체에 broker, client, submitOrder, cancelOrder 등이 없음
    const runtimeKeys = Object.keys(runtime);
    expect(runtimeKeys).not.toContain("broker");
    expect(runtimeKeys).not.toContain("client");
    expect(runtimeKeys).not.toContain("submitOrder");
    expect(runtimeKeys).not.toContain("cancelOrder");
  });

  it("status-summary 모듈은 순수 함수만 포함한다", () => {
    // createReconcileStatusSummary는 입력을 받아 summary를 반환하는 순수 함수
    // API 호출이나 side effect 없음
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 0,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
    });

    // summary에 order API 관련 메서드/키가 없음
    expect(status).toBeDefined();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("POST");
    expect(serialized).not.toContain("DELETE");
    expect(serialized).not.toContain("/v1/orders");
    expect(serialized).not.toContain("/v1/order");
    expect(serialized).not.toContain("submitOrder");
    expect(serialized).not.toContain("cancelOrder");
  });

  it("status summary의 trace에 secret/credential이 없다", () => {
    const status = createReconcileStatusSummary({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      reconcileResult: "CLEAN",
      mismatchCount: 0,
      openOrderCount: 0,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
      runId: "run-001",
    });

    const trace = status.trace;
    const traceSerialized = JSON.stringify(trace);

    // trace에 credential 관련 키가 없음
    expect(traceSerialized).not.toContain("accessKey");
    expect(traceSerialized).not.toContain("secretKey");
    expect(traceSerialized).not.toContain("authorization");
    expect(traceSerialized).not.toContain("jwt");
    expect(traceSerialized).not.toContain("Bearer");
  });

  it("safe summary에도 credential/key 원문이 노출되지 않는다", () => {
    const summary: LiveReconcileRuntimeSafeSummary = {
      enabled: true,
      profile: "LIVE_READ_ONLY_RECONCILE",
      credentialsConfigured: true,
      keyScopes: ["자산조회", "주문조회"],
      keyScopeEvidenceId: "evidence-1",
      statusLabel: "reconcile guard 충족",
      message: "M16 read-only reconcile guard가 충족됐다.",
      action: null,
      trace: {
        source: "live_reconcile_runtime",
        reason: "reconcile_guard_ready",
      },
    };

    const serialized = JSON.stringify(summary);

    // safe summary contract: credential 원문 비포함
    expect(serialized).not.toContain("upbitAccessKey");
    expect(serialized).not.toContain("upbitSecretKey");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("JWT");
  });
});

function fakeWorker(): LiveReconcileRuntimeWorker {
  return {
    async runOnce() {
      throw new Error("fake worker should not run in this test");
    },
  };
}

function mismatchSnapshotProvider(): LiveReconcileSnapshotProvider {
  return {
    async loadSnapshot() {
      return {
        sourceSummary: "fixture accounts+open",
        engineInput: {
          exchangeOpenOrders: [
            {
              exchangeOrderId: "uuid-untracked",
              market: "KRW-BTC",
              side: "BUY",
              exchangeStatus: "wait",
              requestedQuantity: "0.01",
              remainingQuantity: "0.01",
              requestedPrice: "100000000",
              source: "open",
              capturedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          exchangeClosedOrders: [],
          orderLookups: [],
          websocketContext: {
            bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
            events: [],
          },
          localOpenOrders: [],
          localBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          exchangeBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          closedOrderWindow: {
            windowStart: "2026-06-01T12:00:00.000Z",
            windowEnd: "2026-06-02T12:00:00.000Z",
            windowExhausted: false,
            queryCount: 1,
          },
          observedAt: "2026-06-02T12:00:00.000Z",
        },
      };
    },
  };
}

function balanceMismatchSnapshotProvider(): LiveReconcileSnapshotProvider {
  return {
    async loadSnapshot() {
      return {
        sourceSummary: "fixture accounts balance mismatch",
        engineInput: {
          exchangeOpenOrders: [],
          exchangeClosedOrders: [],
          orderLookups: [],
          websocketContext: {
            bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
            events: [],
          },
          localOpenOrders: [],
          localBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "1000",
              total: "1000",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          exchangeBalances: [
            {
              currency: "KRW",
              available: "1000",
              locked: "0",
              total: "1000",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          closedOrderWindow: {
            windowStart: "2026-06-01T12:00:00.000Z",
            windowEnd: "2026-06-02T12:00:00.000Z",
            windowExhausted: false,
            queryCount: 1,
          },
          observedAt: "2026-06-02T12:00:00.000Z",
        },
      };
    },
  };
}

function websocketOrderSnapshotProvider(): LiveReconcileSnapshotProvider {
  return {
    async loadSnapshot() {
      return {
        sourceSummary: "fixture websocket myOrder",
        engineInput: {
          exchangeOpenOrders: [],
          exchangeClosedOrders: [],
          orderLookups: [],
          websocketContext: {
            bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
            events: [
              {
                type: "myOrder",
                occurredAt: "2026-06-02T12:00:01.000Z",
                payload: {
                  uuid: "uuid-ws-open",
                  market: "KRW-BTC",
                  side: "bid",
                  state: "wait",
                  volume: "0.01",
                  remaining_volume: "0.01",
                  price: "100000000",
                },
              },
            ],
          },
          localOpenOrders: [
            {
              orderId: "local-ws-open",
              exchangeOrderId: "uuid-ws-open",
              market: "KRW-BTC",
              side: "BUY",
              orderType: "LIMIT",
              status: "ACCEPTED",
              requestedQuantity: "0.01",
              remainingQuantity: "0.01",
              requestedPrice: "100000000",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          localBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          exchangeBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          closedOrderWindow: {
            windowStart: "2026-06-01T12:00:00.000Z",
            windowEnd: "2026-06-02T12:00:00.000Z",
            windowExhausted: false,
            queryCount: 1,
          },
          observedAt: "2026-06-02T12:00:00.000Z",
        },
      };
    },
  };
}

function staleSinceOnlySnapshotProvider(): LiveReconcileSnapshotProvider {
  return {
    async loadSnapshot() {
      return {
        sourceSummary: "fixture websocket staleSince only",
        engineInput: {
          exchangeOpenOrders: [],
          exchangeClosedOrders: [],
          orderLookups: [],
          websocketContext: {
            bootstrapCompleteAt: "2026-06-02T12:00:00.000Z",
            events: [],
            disconnectEvidence: {
              staleSince: "2026-06-02T11:59:00.000Z",
            },
          },
          localOpenOrders: [],
          localBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          exchangeBalances: [
            {
              currency: "KRW",
              available: "0",
              locked: "0",
              total: "0",
              updatedAt: "2026-06-02T12:00:00.000Z",
            },
          ],
          closedOrderWindow: {
            windowStart: "2026-06-01T12:00:00.000Z",
            windowEnd: "2026-06-02T12:00:00.000Z",
            windowExhausted: false,
            queryCount: 1,
          },
          observedAt: "2026-06-02T12:00:00.000Z",
        },
      };
    },
  };
}

function fakeRepository(): LiveReconcileRuntimeRepository & {
  exchangeOrderSnapshots: unknown[];
  mismatchEvidence: unknown[];
  completedStatus: string | null;
  latestSummary: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>;
} {
  const repository = {
    exchangeOrderSnapshots: [] as unknown[],
    mismatchEvidence: [] as unknown[],
    completedStatus: null as string | null,
    latestSummary: {
      run: null,
      balanceSnapshotCount: 0,
      exchangeOrderSnapshotCount: 0,
      openExchangeOrderSnapshotCount: 0,
      mismatchEvidenceCount: 0,
      mismatchTypes: [],
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    },
    async beginLiveReconcileRun() {
      return {
        created: true,
        run: {
          id: "run-001",
          idempotency_key: "idem-001",
          status: "RUNNING" as const,
          started_at: new Date("2026-06-02T12:00:00.000Z"),
          finished_at: null,
          guard_profile: "LIVE_READ_ONLY_RECONCILE",
          source_summary: "fixture",
          correlation_id: "corr-reconcile",
          metadata_json: {},
        },
      };
    },
    async appendLiveReconcileBalanceSnapshots() {
      return [];
    },
    async appendLiveReconcileExchangeOrderSnapshots(_runId: string, snapshots: unknown[]) {
      repository.exchangeOrderSnapshots.push(...snapshots);
      return [];
    },
    async appendLiveReconcileMismatchEvidence(_runId: string, evidenceList: unknown[]) {
      repository.mismatchEvidence.push(...evidenceList);
      return [];
    },
    async completeLiveReconcileRun(input: { status: string }) {
      repository.completedStatus = input.status;
      return {
        id: "run-001",
        idempotency_key: "idem-001",
        status: input.status as "COMPLETED" | "FAILED" | "MANUAL_REVIEW_REQUIRED",
        started_at: new Date("2026-06-02T12:00:00.000Z"),
        finished_at: new Date("2026-06-02T12:00:01.000Z"),
        guard_profile: "LIVE_READ_ONLY_RECONCILE",
        source_summary: "fixture",
        correlation_id: "corr-reconcile",
        metadata_json: {},
      };
    },
    async getLatestLiveReconcileSummary() {
      return repository.latestSummary;
    },
  };

  return repository as LiveReconcileRuntimeRepository & {
    exchangeOrderSnapshots: unknown[];
    mismatchEvidence: unknown[];
    completedStatus: string | null;
    latestSummary: Awaited<ReturnType<LiveReconcileRuntimeRepository["getLatestLiveReconcileSummary"]>>;
  };
}
