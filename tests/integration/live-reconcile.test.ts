import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
  LiveReconcileRunAlreadyFinalizedError,
  PostgresLiveReconcileRepository,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("live reconcile persistence integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;
  let repository: PostgresLiveReconcileRepository | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await clearLiveReconcileTables(db);
    repository = new PostgresLiveReconcileRepository(db);
  });

  afterAll(async () => {
    if (database !== undefined) {
      await destroyDatabase(database);
      database = undefined;
      pool = undefined;
      return;
    }

    await pool?.end();
    pool = undefined;
  });

  // ── beginLiveReconcileRun ──

  it("creates a new reconcile run with RUNNING status", async () => {
    const { created, run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-1",
      guardProfile: "test-profile",
      sourceSummary: "REST: accounts",
      correlationId: "corr-1",
    });

    expect(created).toBe(true);
    expect(run.status).toBe("RUNNING");
    expect(run.idempotency_key).toBe("run-integration-1");
    expect(run.guard_profile).toBe("test-profile");
    expect(run.source_summary).toBe("REST: accounts");
    expect(run.correlation_id).toBe("corr-1");
    expect(run.started_at).toBeInstanceOf(Date);
    expect(run.finished_at).toBeNull();
  });

  it("reuses existing run for the same idempotency key", async () => {
    const first = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-dup",
    });
    const second = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-dup",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it("allows multiple runs with different idempotency keys", async () => {
    const run1 = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-multi-1",
    });
    const run2 = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-multi-2",
    });

    expect(run1.created).toBe(true);
    expect(run2.created).toBe(true);
    expect(run1.run.id).not.toBe(run2.run.id);
  });

  // ── completeLiveReconcileRun ──

  it("completes a running reconcile run", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-complete",
    });

    const completed = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "COMPLETED",
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.finished_at).toBeInstanceOf(Date);
    expect(completed.finished_at).not.toBeNull();
  });

  it("completes a run with FAILED status", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-failed",
    });

    const completed = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "FAILED",
    });

    expect(completed.status).toBe("FAILED");
  });

  it("completes a run with MANUAL_REVIEW_REQUIRED status", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-manual-review",
    });

    const completed = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "MANUAL_REVIEW_REQUIRED",
    });

    expect(completed.status).toBe("MANUAL_REVIEW_REQUIRED");
  });

  it("returns the existing row when the same final status is completed again", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-complete-idempotent",
    });

    const completed = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "COMPLETED",
    });
    const completedAgain = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "COMPLETED",
    });

    expect(completedAgain.id).toBe(completed.id);
    expect(completedAgain.status).toBe("COMPLETED");
    expect(completedAgain.finished_at?.getTime()).toBe(completed.finished_at?.getTime());
  });

  it("does not overwrite a finalized reconcile run with a different final status", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-complete-conflict",
    });

    const completed = await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "COMPLETED",
    });

    await expect(
      repository!.completeLiveReconcileRun({
        runId: run.id,
        status: "FAILED",
      }),
    ).rejects.toBeInstanceOf(LiveReconcileRunAlreadyFinalizedError);

    const summary = await repository!.getLatestLiveReconcileSummary();
    expect(summary.run?.status).toBe("COMPLETED");
    expect(summary.run?.finished_at?.getTime()).toBe(completed.finished_at?.getTime());
  });

  // ── appendLiveReconcileBalanceSnapshots ──

  it("appends balance snapshots to a run", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-balance",
    });

    const snapshots = await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "50000",
        total: "1050000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
      {
        currency: "BTC",
        available: "0.5",
        locked: "0.1",
        total: "0.6",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.currency).toBe("KRW");
    expect(snapshots[0]?.available).toBe("1000000.00000000");
    expect(snapshots[0]?.locked).toBe("50000.00000000");
    expect(snapshots[0]?.total).toBe("1050000.00000000");
    expect(snapshots[1]?.currency).toBe("BTC");
  });

  it("skips duplicate balance snapshots in the same run", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-balance-dup",
    });

    const first = await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "50000",
        total: "1050000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);
    const second = await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "50000",
        total: "1050000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  // ── appendLiveReconcileExchangeOrderSnapshots ──

  it("appends exchange order snapshots to a run", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders",
    });

    const snapshots = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-1",
        identifier: "id-1",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        remainingQuantity: "0.001",
        requestedPrice: "10000000",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        exchangeOrderId: "uuid-2",
        market: "KRW-ETH",
        side: "SELL",
        status: "FILLED",
        requestedQuantity: "0.01",
        remainingQuantity: "0",
        source: "closed",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.exchange_order_id).toBe("uuid-1");
    expect(snapshots[0]?.market).toBe("KRW-BTC");
    expect(snapshots[1]?.exchange_order_id).toBe("uuid-2");
  });

  it("skips duplicate exchange order snapshots with the same exchange_order_id", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-dup",
    });

    const first = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-dup",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const second = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-dup",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("handles identifier-only exchange order snapshots without exchange_order_id", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-ident",
    });

    const snapshots = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        identifier: "ident-only-1",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "ws",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.exchange_order_id).toBeNull();
    expect(snapshots[0]?.identifier).toBe("ident-only-1");
  });

  it("stores fingerprint-only exchange order snapshots append-only without uuid or identifier", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-fingerprint-only",
    });

    const snapshotInput = {
      market: "KRW-BTC" as const,
      side: "BUY" as const,
      status: "OPEN",
      requestedQuantity: "0.00100000",
      requestedPrice: "10000000.0000",
      source: "open" as const,
      capturedAt: new Date("2026-06-03T00:00:00Z"),
    };

    const snapshots = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      snapshotInput,
    ]);
    const duplicate = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        ...snapshotInput,
      },
    ]);
    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(snapshots).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    expect(snapshots[0]?.exchange_order_id).toBeNull();
    expect(snapshots[0]?.identifier).toBeNull();
    expect(snapshots[0]?.identity_fingerprint).toBe("KRW-BTC|BUY|0.001|10000000");
    expect(duplicate[0]?.identity_fingerprint).toBe("KRW-BTC|BUY|0.001|10000000");
    expect(summary.exchangeOrderSnapshotCount).toBe(2);
  });

  it("normalizes an identifier-only exchange order snapshot after uuid is observed", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-ident-dup",
    });

    const identifierOnly = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        identifier: "ident-dup-after-uuid",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "ws",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const withUuid = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-observed-later",
        identifier: "ident-dup-after-uuid",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "lookup",
        capturedAt: new Date("2026-06-03T00:00:01Z"),
      },
    ]);
    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(identifierOnly).toHaveLength(1);
    expect(withUuid).toHaveLength(1);
    expect(withUuid[0]?.id).not.toBe(identifierOnly[0]?.id);
    expect(withUuid[0]?.exchange_order_id).toBe("uuid-observed-later");
    expect(withUuid[0]?.identifier).toBe("ident-dup-after-uuid");
    expect(summary.exchangeOrderSnapshotCount).toBe(1);
  });

  it("counts lookup and websocket open exchange order snapshots in latest summary", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-open-count-lookup-ws",
    });

    await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-lookup-open-count",
        market: "KRW-BTC",
        side: "BUY",
        status: "wait",
        requestedQuantity: "0.001",
        source: "lookup",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        identifier: "ident-ws-open-count",
        market: "KRW-ETH",
        side: "SELL",
        status: "watch",
        requestedQuantity: "0.02",
        source: "ws",
        capturedAt: new Date("2026-06-03T00:00:01Z"),
      },
      {
        exchangeOrderId: "uuid-closed-not-open-count",
        market: "KRW-XRP",
        side: "BUY",
        status: "done",
        requestedQuantity: "10",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:02Z"),
      },
    ]);

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.exchangeOrderSnapshotCount).toBe(3);
    expect(summary.openExchangeOrderSnapshotCount).toBe(2);
  });

  it("suppresses open count when a terminal snapshot exists for the same exchange identity", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-open-count-terminal-suppression",
    });

    await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-terminal-suppressed",
        market: "KRW-BTC",
        side: "BUY",
        status: "wait",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        exchangeOrderId: "uuid-terminal-suppressed",
        market: "KRW-BTC",
        side: "BUY",
        status: "done",
        requestedQuantity: "0.001",
        source: "lookup",
        capturedAt: new Date("2026-06-03T00:00:01Z"),
      },
    ]);

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.exchangeOrderSnapshotCount).toBe(1);
    expect(summary.openExchangeOrderSnapshotCount).toBe(0);
  });

  it("uses the latest captured exchange status when metadata summary is unavailable", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-open-count-latest-status",
    });

    await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-latest-open",
        market: "KRW-BTC",
        side: "BUY",
        status: "done",
        requestedQuantity: "0.001",
        source: "lookup",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        exchangeOrderId: "uuid-latest-open",
        market: "KRW-BTC",
        side: "BUY",
        status: "wait",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:01Z"),
      },
    ]);

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.openExchangeOrderSnapshotCount).toBe(1);
  });

  it("prefers durable engine summary open count over reconstructed snapshot count", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-open-count-engine-summary",
    });

    await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-open-but-engine-suppressed",
        market: "KRW-BTC",
        side: "BUY",
        status: "wait",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({
      runId: run.id,
      status: "COMPLETED",
      metadata: {
        live_reconcile_engine_summary: {
          open_order_count: { exchange: 0, local: 1 },
        },
      },
    });

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.openExchangeOrderSnapshotCount).toBe(0);
  });

  it("normalizes split exchange order identities when a bridge snapshot is observed", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-bridge",
    });

    const uuidOnly = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-bridge",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const identifierOnly = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        identifier: "ident-bridge",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "ws",
        capturedAt: new Date("2026-06-03T00:00:01Z"),
      },
    ]);
    const bridge = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-bridge",
        identifier: "ident-bridge",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "lookup",
        capturedAt: new Date("2026-06-03T00:00:02Z"),
      },
    ]);
    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(uuidOnly).toHaveLength(1);
    expect(identifierOnly).toHaveLength(1);
    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.exchange_order_id).toBe("uuid-bridge");
    expect(bridge[0]?.identifier).toBe("ident-bridge");
    expect(summary.exchangeOrderSnapshotCount).toBe(1);
  });

  it("rejects blank exchange order identifiers", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-blank-identities",
    });

    await expect(
      repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
        {
          exchangeOrderId: "",
          market: "KRW-BTC",
          side: "BUY",
          status: "OPEN",
          requestedQuantity: "0.001",
          source: "open",
          capturedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();
    await expect(
      repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
        {
          identifier: " ",
          market: "KRW-BTC",
          side: "BUY",
          status: "OPEN",
          requestedQuantity: "0.001",
          source: "ws",
          capturedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();
  });

  it("rejects exchange order snapshots whose remaining quantity exceeds requested quantity", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-orders-invalid-remaining",
    });

    await expect(
      repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
        {
          exchangeOrderId: "uuid-invalid-remaining",
          market: "KRW-BTC",
          side: "BUY",
          status: "OPEN",
          requestedQuantity: "0.001",
          remainingQuantity: "0.002",
          source: "open",
          capturedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();
  });

  // ── appendLiveReconcileMismatchEvidence ──

  it("appends mismatch evidence to a run", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-evidence",
    });

    const evidence = await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW 잔고 lock 불일치: 로컬 50000, 거래소 75000",
        action: "수동 검토가 필요합니다. 거래소 잔고와 로컬 잔고를 확인하세요.",
        evidenceFingerprint: "balance-lock-krw-20260603-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
        trace: {
          reasonCode: "balance_lock_mismatch",
          localLocked: "50000",
          exchangeLocked: "75000",
        },
      },
      {
        mismatchType: "UNTRACKED_EXCHANGE_OPEN_ORDER",
        severity: "WARN",
        market: "KRW-BTC",
        orderIdentity: "uuid-untracked",
        message: "거래소에만 존재하는 미체결 주문이 발견되었습니다.",
        action: "로컬 상태 갱신이 필요합니다. 주문 정보를 확인하세요.",
        evidenceFingerprint: "untracked-order-krw-btc-20260603-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.mismatch_type).toBe("BALANCE_LOCK_MISMATCH");
    expect(evidence[0]?.message).toContain("KRW");
    expect(evidence[0]?.action).toContain("수동 검토");
    expect(evidence[1]?.mismatch_type).toBe("UNTRACKED_EXCHANGE_OPEN_ORDER");
  });

  it("skips duplicate mismatch evidence with the same fingerprint", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-evidence-dup",
    });

    const first = await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW 잔고 lock 불일치",
        action: "수동 검토가 필요합니다.",
        evidenceFingerprint: "dup-fingerprint-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const second = await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW 잔고 lock 불일치",
        action: "수동 검토가 필요합니다.",
        evidenceFingerprint: "dup-fingerprint-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("records the same mismatch fingerprint again in a later reconcile run", async () => {
    const { run: firstRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-evidence-repeat-1",
    });
    const first = await repository!.appendLiveReconcileMismatchEvidence(firstRun.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW 잔고 lock 불일치",
        action: "수동 검토가 필요합니다.",
        evidenceFingerprint: "repeat-fingerprint-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: firstRun.id, status: "FAILED" });

    const { run: secondRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-evidence-repeat-2",
    });
    const second = await repository!.appendLiveReconcileMismatchEvidence(secondRun.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW 잔고 lock 불일치",
        action: "수동 검토가 필요합니다.",
        evidenceFingerprint: "repeat-fingerprint-001",
        occurredAt: new Date("2026-06-03T00:01:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: secondRun.id, status: "FAILED" });

    const summary = await repository!.getLatestLiveReconcileSummary();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(summary.run?.id).toBe(secondRun.id);
    expect(summary.mismatchEvidenceCount).toBe(1);
  });

  // ── appendLiveReconcilePositionSnapshots ──

  it("appends position snapshots and preserves average price evidence", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-position",
    });

    const snapshots = await repository!.appendLiveReconcilePositionSnapshots(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "trend-following",
        quantity: "0.02",
        averageEntryPrice: "10000000",
        recoveryStatus: "RECOVERABLE",
        source: "fills",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        evidence: { fillCount: 2 },
      },
      {
        exchange: "UPBIT",
        market: "KRW-ETH",
        strategyId: "trend-following",
        quantity: "0.5",
        recoveryStatus: "MANUAL_REVIEW_REQUIRED",
        source: "manual_review",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        evidence: { reasonCode: "average_entry_price_unavailable" },
      },
    ]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.recovery_status).toBe("RECOVERABLE");
    expect(snapshots[0]?.average_entry_price).toBe("10000000.000000000000000000");
    expect(snapshots[1]?.recovery_status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(snapshots[1]?.average_entry_price).toBeNull();
  });

  it("skips duplicate position snapshots for the same run identity and captured time", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-position-dup",
    });
    const snapshot = {
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "trend-following",
      quantity: "0.02",
      averageEntryPrice: "10000000",
      recoveryStatus: "RECOVERABLE" as const,
      source: "fills" as const,
      capturedAt: new Date("2026-06-03T00:00:00Z"),
    };

    const first = await repository!.appendLiveReconcilePositionSnapshots(run.id, [snapshot]);
    const second = await repository!.appendLiveReconcilePositionSnapshots(run.id, [snapshot]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("rejects recoverable positive position snapshots with zero average entry price", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-position-zero-average",
    });

    await expect(
      repository!.appendLiveReconcilePositionSnapshots(run.id, [
        {
          exchange: "UPBIT",
          market: "KRW-BTC",
          strategyId: "trend-following",
          quantity: "0.02",
          averageEntryPrice: "0",
          recoveryStatus: "RECOVERABLE",
          source: "fills",
          capturedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();
  });

  it("rejects recoverable position snapshots from non-fill sources", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-position-recoverable-non-fill",
    });

    await expect(
      repository!.appendLiveReconcilePositionSnapshots(run.id, [
        {
          exchange: "UPBIT",
          market: "KRW-BTC",
          strategyId: "trend-following",
          quantity: "0.02",
          averageEntryPrice: "10000000",
          recoveryStatus: "RECOVERABLE",
          source: "balances",
          capturedAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();
  });

  // ── appendLiveReconcileFillRecoveryKeys ──

  it("reserves fill recovery keys before fill restoration", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-fill-key",
    });

    const keys = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeOrderId: "uuid-fill-order-1",
        exchangeFillId: "fill-1",
        fillFingerprint: "upbit:krw-btc:uuid-fill-order-1:fill-1",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(keys).toHaveLength(1);
    expect(keys[0]?.exchange_fill_id).toBe("fill-1");
    expect(keys[0]?.fill_fingerprint).toBe("upbit:krw-btc:uuid-fill-order-1:fill-1");
  });

  it("skips duplicate fill recovery keys by exchange fill id or fingerprint", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-fill-key-dup",
    });

    const first = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeOrderId: "uuid-fill-order-dup",
        exchangeFillId: "fill-dup",
        fillFingerprint: "upbit:fill-dup:fingerprint",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const duplicateExchangeFill = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeFillId: "fill-dup",
        fillFingerprint: "upbit:fill-dup:fingerprint-2",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:01Z"),
      },
    ]);
    const duplicateFingerprint = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeFillId: "fill-dup-2",
        fillFingerprint: "upbit:fill-dup:fingerprint",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:02Z"),
      },
    ]);

    expect(first).toHaveLength(1);
    expect(duplicateExchangeFill).toHaveLength(0);
    expect(duplicateFingerprint).toHaveLength(0);
  });

  it("rejects fill recovery key reservation when order_id does not exist", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-fill-key-order-fk",
    });

    await expect(
      repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
        {
          exchange: "UPBIT",
          market: "KRW-BTC",
          orderId: "00000000-0000-4000-8000-000000000001",
          exchangeFillId: "fill-invalid-order",
          fillFingerprint: "fill-invalid-order-fingerprint",
          side: "BUY",
          price: "10000000",
          quantity: "0.001",
          filledAt: new Date("2026-06-03T00:00:00Z"),
        },
      ]),
    ).rejects.toThrow();

    const retryWithoutInvalidOrder = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeFillId: "fill-invalid-order",
        fillFingerprint: "fill-invalid-order-fingerprint",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(retryWithoutInvalidOrder).toHaveLength(1);
  });

  // ── getLatestLiveReconcileSummary ──

  it("returns null run when no reconcile has been performed", async () => {
    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.run).toBeNull();
    expect(summary.balanceSnapshotCount).toBe(0);
    expect(summary.exchangeOrderSnapshotCount).toBe(0);
    expect(summary.mismatchEvidenceCount).toBe(0);
    expect(summary.positionSnapshotCount).toBe(0);
    expect(summary.fillRecoveryKeyCount).toBe(0);
  });

  it("returns latest run with snapshot counts", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary",
    });
    await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);
    await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-summary-1",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "summary-fp-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.appendLiveReconcilePositionSnapshots(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "trend-following",
        quantity: "0.001",
        averageEntryPrice: "10000000",
        recoveryStatus: "RECOVERABLE",
        source: "fills",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeFillId: "summary-fill-1",
        fillFingerprint: "summary-fill-fp-001",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: run.id, status: "COMPLETED" });

    // 두 번째 run 생성 (latest가 되어야 함)
    const { run: run2 } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary-2",
    });
    await repository!.appendLiveReconcileBalanceSnapshots(run2.id, [
      {
        currency: "BTC",
        available: "1.0",
        locked: "0",
        total: "1.0",
        capturedAt: new Date("2026-06-03T01:00:00Z"),
        source: "REST",
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: run2.id, status: "COMPLETED" });

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.run).not.toBeNull();
    expect(summary.run!.id).toBe(run2.id);
    expect(summary.balanceSnapshotCount).toBe(1);
    expect(summary.exchangeOrderSnapshotCount).toBe(0);
    expect(summary.mismatchEvidenceCount).toBe(0);
    expect(summary.positionSnapshotCount).toBe(0);
    expect(summary.fillRecoveryKeyCount).toBe(0);
  });

  it("exposes a newer running run instead of hiding it behind the latest final summary", async () => {
    const { run: failedRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary-final-first",
    });
    await repository!.appendLiveReconcileMismatchEvidence(failedRun.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "summary-final-first-fp",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: failedRun.id, status: "FAILED" });
    const { run: runningRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary-running-after-final",
    });

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.run?.id).toBe(runningRun.id);
    expect(summary.run?.status).toBe("RUNNING");
    expect(summary.mismatchEvidenceCount).toBe(0);
  });

  it("uses finished_at to select the latest final run in summary", async () => {
    const { run: firstRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary-finished-at-first",
    });
    const { run: secondRun } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-summary-finished-at-second",
    });

    await repository!.completeLiveReconcileRun({
      runId: secondRun.id,
      status: "COMPLETED",
    });
    await repository!.appendLiveReconcileMismatchEvidence(firstRun.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "summary-finished-at-first-fp",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({
      runId: firstRun.id,
      status: "FAILED",
    });

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.run?.id).toBe(firstRun.id);
    expect(summary.run?.status).toBe("FAILED");
    expect(summary.mismatchEvidenceCount).toBe(1);
  });

  // ── append-only invariant (run 실패 시 snapshot/evidence 유지) ──

  it("keeps snapshots and evidence even when run completes with FAILED status", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-failed-invariant",
    });

    await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);
    await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "CANCEL_FAILURE_RETRY_NEEDED",
        severity: "ERROR",
        message: "취소 실패로 재시도가 필요합니다.",
        action: "재시도 후 수동 확인이 필요합니다.",
        evidenceFingerprint: "failed-run-fp-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    await repository!.completeLiveReconcileRun({ runId: run.id, status: "FAILED" });

    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(summary.run).not.toBeNull();
    expect(summary.run!.status).toBe("FAILED");
    expect(summary.balanceSnapshotCount).toBe(1);
    expect(summary.mismatchEvidenceCount).toBe(1);
  });

  it("does not append snapshots or evidence after a run reaches a final status", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-final-append-guard",
    });
    await repository!.completeLiveReconcileRun({ runId: run.id, status: "COMPLETED" });

    const balance = await repository!.appendLiveReconcileBalanceSnapshots(run.id, [
      {
        currency: "KRW",
        available: "1000000",
        locked: "0",
        total: "1000000",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
        source: "REST",
      },
    ]);
    const orders = await repository!.appendLiveReconcileExchangeOrderSnapshots(run.id, [
      {
        exchangeOrderId: "uuid-final-append",
        market: "KRW-BTC",
        side: "BUY",
        status: "OPEN",
        requestedQuantity: "0.001",
        source: "open",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const evidence = await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "final-append-guard-fp",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const positions = await repository!.appendLiveReconcilePositionSnapshots(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "trend-following",
        quantity: "0.001",
        averageEntryPrice: "10000000",
        recoveryStatus: "RECOVERABLE",
        source: "fills",
        capturedAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const fillKeys = await repository!.appendLiveReconcileFillRecoveryKeys(run.id, [
      {
        exchange: "UPBIT",
        market: "KRW-BTC",
        exchangeFillId: "fill-final-append",
        fillFingerprint: "fill-final-append-fp",
        side: "BUY",
        price: "10000000",
        quantity: "0.001",
        filledAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);
    const summary = await repository!.getLatestLiveReconcileSummary();

    expect(balance).toHaveLength(0);
    expect(orders).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    expect(positions).toHaveLength(0);
    expect(fillKeys).toHaveLength(0);
    expect(summary.balanceSnapshotCount).toBe(0);
    expect(summary.exchangeOrderSnapshotCount).toBe(0);
    expect(summary.mismatchEvidenceCount).toBe(0);
    expect(summary.positionSnapshotCount).toBe(0);
    expect(summary.fillRecoveryKeyCount).toBe(0);
  });

  // ── 모든 mismatch type 저장 확인 ──

  it("stores all mismatch types", async () => {
    const { run } = await repository!.beginLiveReconcileRun({
      idempotencyKey: "run-integration-all-types",
    });

    const evidence = await repository!.appendLiveReconcileMismatchEvidence(run.id, [
      {
        mismatchType: "UNTRACKED_EXCHANGE_OPEN_ORDER",
        severity: "WARN",
        market: "KRW-BTC",
        orderIdentity: "uuid-1",
        message: "거래소에만 존재하는 미체결 주문",
        action: "로컬 상태 갱신",
        evidenceFingerprint: "all-types-001",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE",
        severity: "WARN",
        orderIdentity: "local-order-1",
        message: "로컬 미체결 주문이 거래소에 없음",
        action: "로컬 주문 취소 처리",
        evidenceFingerprint: "all-types-002",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "PARTIAL_FILL_MISMATCH",
        severity: "ERROR",
        market: "KRW-BTC",
        orderIdentity: "uuid-2",
        message: "부분 체결 수량 불일치",
        action: "체결 이력 확인",
        evidenceFingerprint: "all-types-003",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "CANCEL_FAILURE_RETRY_NEEDED",
        severity: "ERROR",
        orderIdentity: "uuid-3",
        message: "취소 실패로 재시도 필요",
        action: "재시도 후 확인",
        evidenceFingerprint: "all-types-004",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "EXCHANGE_CANCEL_STATE_MISMATCH",
        severity: "ERROR",
        orderIdentity: "uuid-4",
        message: "거래소 취소 상태 불일치",
        action: "수동 검토",
        evidenceFingerprint: "all-types-005",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "ORDER_STATE_ADVANCEMENT_BLOCKED",
        severity: "ERROR",
        orderIdentity: "uuid-5",
        message: "주문 상태 전진 불가",
        action: "수동 검토",
        evidenceFingerprint: "all-types-006",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "ORDER_IDENTITY_CONFLICT",
        severity: "ERROR",
        orderIdentity: "uuid-6",
        message: "주문 식별자 충돌",
        action: "수동 검토",
        evidenceFingerprint: "all-types-007",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW lock 잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "all-types-008",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "BALANCE_SNAPSHOT_UNAVAILABLE",
        severity: "ERROR",
        currency: "KRW",
        message: "잔고 snapshot 판정 불가",
        action: "수동 검토",
        evidenceFingerprint: "all-types-009",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "CLOSED_ORDER_WINDOW_EXCEEDED",
        severity: "WARN",
        orderIdentity: "uuid-7",
        message: "종료 주문 조회 기간 초과",
        action: "수동 확인 필요",
        evidenceFingerprint: "all-types-010",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
        severity: "WARN",
        message: "WebSocket 데이터 갭 발생",
        action: "REST 재조회 후 확인",
        evidenceFingerprint: "all-types-011",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(evidence).toHaveLength(11);
  });

  async function getDatabase(): Promise<Database> {
    if (database !== undefined) {
      return database;
    }

    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);
    await applyMigrations(pool);
    database = createDatabase(pool);
    return database;
  }

  async function clearLiveReconcileTables(db: Database): Promise<void> {
    // run 삭제가 하위 append-only evidence/snapshot/key를 cascade로 지워 테스트 간 durable 상태 충돌을 막는다.
    await db.deleteFrom("live_reconcile_runs").execute();
  }
});

/* ============================================================
 * Fake Integration Tests
 *
 * 실제 DB와 Upbit API 호출 없이 in-memory fake provider로
 * reconcile worker의 전체 흐름을 검증한다.
 * ============================================================ */

import {
  createLiveReconcileRuntimeWorker,
} from "../../src/runtime/index.js";
import type {
  BeginLiveReconcileRunInput,
  CompleteLiveReconcileRunInput,
  LiveReconcileBalanceSnapshotRecord,
  LiveReconcileExchangeOrderSnapshotRecord,
  LiveReconcileMismatchEvidenceRecord,
  LiveReconcileRunRecord,
  LiveReconcileSummary,
} from "../../src/infrastructure/db/index.js";
import type {
  LiveReconcileRuntimeRepository,
  LiveReconcileSnapshotProvider,
  LiveReconcileRuntimeSnapshot,
} from "../../src/runtime/index.js";
import type {
  BrokerBalance,
  ReconcileEngineInput,
  ReconcileLocalOrderSnapshot,
} from "../../src/domain/index.js";
import type { KillSwitchControlProvider, KillSwitchControlResult } from "../../src/application/index.js";

/**
 * in-memory fake reconcile repository다.
 *
 * DB 없이 reconcile worker의 append-only evidence 저장과 run lifecycle을 검증하기 위한
 * 테스트 전용 구현이며, 실제 PostgreSQL 연결을 만들지 않는다.
 */
class FakeLiveReconcileRepository implements LiveReconcileRuntimeRepository {
  public runs: Map<string, LiveReconcileRunRecord> = new Map();
  public runIdByIdempotencyKey: Map<string, string> = new Map();
  public balanceSnapshots: LiveReconcileBalanceSnapshotRecord[] = [];
  public exchangeOrderSnapshots: LiveReconcileExchangeOrderSnapshotRecord[] = [];
  public mismatchEvidence: LiveReconcileMismatchEvidenceRecord[] = [];
  private runAutoIncrement = 1;
  private balanceAutoIncrement = 1;
  private orderAutoIncrement = 1;
  private evidenceAutoIncrement = 1;

  async beginLiveReconcileRun(input: BeginLiveReconcileRunInput): Promise<{ created: boolean; run: LiveReconcileRunRecord }> {
    const existingRunId = this.runIdByIdempotencyKey.get(input.idempotencyKey);
    if (existingRunId !== undefined) {
      const existingRun = this.runs.get(existingRunId)!;
      return { created: false, run: existingRun };
    }

    const id = `fake-run-${this.runAutoIncrement++}`;
    const run: LiveReconcileRunRecord = {
      id,
      idempotency_key: input.idempotencyKey,
      status: "RUNNING",
      started_at: new Date(),
      finished_at: null,
      guard_profile: input.guardProfile ?? null,
      source_summary: input.sourceSummary ?? null,
      correlation_id: input.correlationId ?? null,
      metadata_json: input.metadata ?? {},
    };
    this.runs.set(id, run);
    this.runIdByIdempotencyKey.set(input.idempotencyKey, id);
    return { created: true, run };
  }

  async appendLiveReconcileBalanceSnapshots(
    runId: string,
    snapshots: Array<{
      currency: string;
      available: string;
      locked: string;
      total: string;
      capturedAt: Date | string;
      source: "REST" | "WS";
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<LiveReconcileBalanceSnapshotRecord[]> {
    const records: LiveReconcileBalanceSnapshotRecord[] = snapshots.map((snapshot) => {
      const capturedAt = snapshot.capturedAt instanceof Date ? snapshot.capturedAt : new Date(snapshot.capturedAt);
      const record: LiveReconcileBalanceSnapshotRecord = {
        id: `fake-balance-${this.balanceAutoIncrement++}`,
        run_id: runId,
        currency: snapshot.currency,
        available: snapshot.available,
        locked: snapshot.locked,
        total: snapshot.total,
        captured_at: capturedAt,
        source: snapshot.source,
        metadata_json: snapshot.metadata ?? {},
      };
      this.balanceSnapshots.push(record);
      return record;
    });
    return records;
  }

  async appendLiveReconcileExchangeOrderSnapshots(
    runId: string,
    snapshots: Array<{
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
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<LiveReconcileExchangeOrderSnapshotRecord[]> {
    const records: LiveReconcileExchangeOrderSnapshotRecord[] = snapshots.map((snapshot) => {
      const capturedAt = snapshot.capturedAt instanceof Date ? snapshot.capturedAt : new Date(snapshot.capturedAt);
      const record: LiveReconcileExchangeOrderSnapshotRecord = {
        id: `fake-order-${this.orderAutoIncrement++}`,
        run_id: runId,
        exchange_order_id: snapshot.exchangeOrderId ?? null,
        identifier: snapshot.identifier ?? null,
        identity_fingerprint: snapshot.exchangeOrderId ?? snapshot.identifier ?? null,
        market: snapshot.market,
        side: snapshot.side,
        status: snapshot.status,
        requested_quantity: snapshot.requestedQuantity,
        remaining_quantity: snapshot.remainingQuantity ?? null,
        requested_price: snapshot.requestedPrice ?? null,
        source: snapshot.source,
        captured_at: capturedAt,
        metadata_json: snapshot.metadata ?? {},
      };
      this.exchangeOrderSnapshots.push(record);
      return record;
    });
    return records;
  }

  async appendLiveReconcileMismatchEvidence(
    runId: string,
    evidenceList: Array<{
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
    }>,
  ): Promise<LiveReconcileMismatchEvidenceRecord[]> {
    const existingFingerprints = new Set(
      this.mismatchEvidence
        .filter((evidence) => evidence.run_id === runId)
        .map((evidence) => evidence.evidence_fingerprint),
    );

    const records: LiveReconcileMismatchEvidenceRecord[] = [];
    for (const evidence of evidenceList) {
      if (existingFingerprints.has(evidence.evidenceFingerprint)) {
        continue;
      }
      const occurredAt = evidence.occurredAt instanceof Date ? evidence.occurredAt : new Date(evidence.occurredAt);
      const record: LiveReconcileMismatchEvidenceRecord = {
        id: `fake-evidence-${this.evidenceAutoIncrement++}`,
        run_id: runId,
        mismatch_type: evidence.mismatchType as LiveReconcileMismatchEvidenceRecord["mismatch_type"],
        severity: evidence.severity,
        market: evidence.market ?? null,
        order_identity: evidence.orderIdentity ?? null,
        currency: evidence.currency ?? null,
        message: evidence.message,
        action: evidence.action,
        evidence_fingerprint: evidence.evidenceFingerprint,
        trace_json: evidence.trace ?? {},
        occurred_at: occurredAt,
      };
      this.mismatchEvidence.push(record);
      existingFingerprints.add(evidence.evidenceFingerprint);
      records.push(record);
    }
    return records;
  }

  async completeLiveReconcileRun(input: CompleteLiveReconcileRunInput): Promise<LiveReconcileRunRecord> {
    const run = this.runs.get(input.runId);
    if (run === undefined) {
      throw new Error(`run not found: ${input.runId}`);
    }

    // 최종 상태가 이미 설정된 중복 완료 요청은 같은 row를 반환한다.
    if (run.status !== "RUNNING" && run.status === input.status) {
      return run;
    }

    const updatedRun: LiveReconcileRunRecord = {
      ...run,
      status: input.status,
      finished_at: new Date(),
      metadata_json: input.metadata !== undefined
        ? { ...run.metadata_json, ...input.metadata }
        : run.metadata_json,
    };
    this.runs.set(input.runId, updatedRun);
    return updatedRun;
  }

  async getLatestLiveReconcileSummary(): Promise<LiveReconcileSummary> {
    const runs = [...this.runs.values()].sort(
      (left, right) => right.started_at.getTime() - left.started_at.getTime(),
    );
    const latestRun = runs[0] ?? null;
    const runId = latestRun?.id;

    const balanceSnapshotCount = runId === undefined
      ? 0
      : this.balanceSnapshots.filter((snapshot) => snapshot.run_id === runId).length;
    const exchangeOrderSnapshotCount = runId === undefined
      ? 0
      : this.exchangeOrderSnapshots.filter((snapshot) => snapshot.run_id === runId).length;
    const mismatchEvidenceCount = runId === undefined
      ? 0
      : this.mismatchEvidence.filter((evidence) => evidence.run_id === runId).length;
    const mismatchTypes = runId === undefined
      ? []
      : [...new Set(
          this.mismatchEvidence
            .filter((evidence) => evidence.run_id === runId)
            .map((evidence) => evidence.mismatch_type),
        )];

    return {
      run: latestRun,
      balanceSnapshotCount,
      exchangeOrderSnapshotCount,
      openExchangeOrderSnapshotCount: exchangeOrderSnapshotCount,
      mismatchEvidenceCount,
      mismatchTypes,
      positionSnapshotCount: 0,
      fillRecoveryKeyCount: 0,
    };
  }
}

/**
 * fake snapshot provider로, 미리 설정한 reconcile engine 입력을 반환한다.
 *
 * 실제 Upbit API 호출 없이 fake balances, orders, websocket context를 주입해
 * engine의 모든 분기를 검증한다.
 */
class FakeReconcileSnapshotProvider implements LiveReconcileSnapshotProvider {
  private snapshot: LiveReconcileRuntimeSnapshot;

  constructor(snapshot: LiveReconcileRuntimeSnapshot) {
    this.snapshot = snapshot;
  }

  async loadSnapshot(): Promise<LiveReconcileRuntimeSnapshot> {
    return this.snapshot;
  }
}

/**
 * fake kill switch control provider로, 요청을 기록하고 성공으로 응답한다.
 *
 * 실제 durable kill switch DB를 건드리지 않고 worker가 provider를 호출했는지만 검증한다.
 */
class FakeKillSwitchControlProvider implements KillSwitchControlProvider {
  public appliedRequests: Array<{
    targetState: string;
    reasonCode: string;
    correlationId: string;
  }> = [];

  async apply(input: {
    targetState: string;
    reasonCode: string;
    correlationId: string;
    actor?: string;
    message?: string;
    metadata?: Record<string, unknown>;
    occurredAt?: Date | string;
  }): Promise<KillSwitchControlResult> {
    this.appliedRequests.push({
      targetState: input.targetState,
      reasonCode: input.reasonCode,
      correlationId: input.correlationId,
    });

    return {
      transition: {
        accepted: true,
        fromState: "NORMAL",
        toState: input.targetState as "NEW_ORDERS_BLOCKED" | "MANUAL_REVIEW_REQUIRED",
        reasonCode: input.reasonCode,
        message: input.message ?? "fake kill switch applied",
        event: {
          eventKind: "KILL_SWITCH_STATE_TRANSITION",
          fromState: "NORMAL",
          toState: input.targetState as "NEW_ORDERS_BLOCKED" | "MANUAL_REVIEW_REQUIRED",
          accepted: true,
          reasonCode: input.reasonCode,
          message: input.message ?? "fake kill switch applied",
          occurredAt: input.occurredAt instanceof Date ? input.occurredAt : new Date(),
          metadata: input.metadata ?? {},
        },
      },
      actionPlan: {
        newOrdersBlocked: true,
        strategyEvaluationBlocked: false,
        cancelPendingPaperOrders: false,
        autoLiquidateOpenPositions: false,
        requiresManualReview: input.targetState === "MANUAL_REVIEW_REQUIRED",
      },
      reasonMatchesTarget: true,
    };
  }
}

function createFakeBrokerBalance(overrides: Partial<BrokerBalance> = {}): BrokerBalance {
  return {
    currency: "KRW",
    available: "1000000",
    locked: "100000",
    total: "1100000",
    updatedAt: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

function createFakeExchangeOpenOrder(overrides: Partial<ReconcileEngineInput["exchangeOpenOrders"][number]> = {}): ReconcileEngineInput["exchangeOpenOrders"][number] {
  return {
    exchangeOrderId: "uuid-open-001",
    identifier: "ident-open-001",
    market: "KRW-BTC",
    side: "BUY",
    exchangeStatus: "wait",
    requestedQuantity: "0.001",
    remainingQuantity: "0.001",
    requestedPrice: "100000000",
    source: "open",
    capturedAt: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

function createFakeLocalOpenOrder(overrides: Partial<ReconcileLocalOrderSnapshot> = {}): ReconcileLocalOrderSnapshot {
  return {
    orderId: "local-order-001",
    exchangeOrderId: "uuid-open-001",
    identifier: "ident-open-001",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    status: "ACCEPTED",
    requestedQuantity: "0.001",
    remainingQuantity: "0.001",
    requestedPrice: "100000000",
    updatedAt: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

function createFakeEngineInput(overrides: Partial<ReconcileEngineInput> = {}): ReconcileEngineInput {
  return {
    exchangeOpenOrders: [],
    exchangeClosedOrders: [],
    orderLookups: [],
    websocketContext: {
      bootstrapCompleteAt: "2026-06-03T00:00:00Z",
      events: [],
    },
    localOpenOrders: [],
    localBalances: [],
    exchangeBalances: [],
    closedOrderWindow: {
      windowStart: "2026-05-27T00:00:00Z",
      windowEnd: "2026-06-03T00:00:00Z",
      windowExhausted: false,
      queryCount: 1,
    },
    observedAt: "2026-06-03T00:00:00Z",
    ...overrides,
  };
}

describe("live reconcile fake integration", () => {
  it("정상 reconcile은 CLEAN summary와 zero mismatch를 반환한다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [createFakeExchangeOpenOrder()],
      localOpenOrders: [createFakeLocalOpenOrder()],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    expect(result.engineOutput.summary.result).toBe("CLEAN");
    expect(result.engineOutput.summary.mismatchCount).toBe(0);
    expect(result.engineOutput.failClosed).toBe(false);
    expect(result.statusSummary.result).toBe("SUCCESS");
    expect(result.run.status).toBe("COMPLETED");
    expect(repository.balanceSnapshots).toHaveLength(1);
    expect(repository.exchangeOrderSnapshots).toHaveLength(1);
    expect(repository.mismatchEvidence).toHaveLength(0);
  });

  it("거래소 미체결 주문과 로컬 미체결 주문이 다르면 fail-closed evidence를 남긴다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const killSwitchProvider = new FakeKillSwitchControlProvider();
    // 거래소에는 있지만 로컬에는 없는 미체결 주문 상황
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [
        createFakeExchangeOpenOrder({ exchangeOrderId: "uuid-exchange-only", identifier: "ident-exchange-only" }),
      ],
      localOpenOrders: [],
      exchangeBalances: [createFakeBrokerBalance({ locked: "0", total: "1000000" })],
      localBalances: [createFakeBrokerBalance({ locked: "0", total: "1000000" })],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider: killSwitchProvider,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    expect(result.engineOutput.summary.result).toBe("MISMATCH_DETECTED");
    expect(result.engineOutput.summary.mismatchCount).toBeGreaterThan(0);
    expect(result.engineOutput.failClosed).toBe(true);
    expect(result.statusSummary.result).toBe("MISMATCH_DETECTED");
    expect(result.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(repository.mismatchEvidence.length).toBeGreaterThan(0);
    // kill switch provider가 호출되어 신규 주문을 차단해야 한다
    expect(killSwitchProvider.appliedRequests.length).toBeGreaterThan(0);
    expect(killSwitchProvider.appliedRequests[0]!.targetState).toBe("NEW_ORDERS_BLOCKED");
  });

  it("주문 identity conflict는 MANUAL_REVIEW_REQUIRED kill switch로 승격된다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const killSwitchProvider = new FakeKillSwitchControlProvider();
    // uuid는 일치하지만 identifier가 다른 identity conflict 상황
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [
        createFakeExchangeOpenOrder({
          exchangeOrderId: "uuid-conflict",
          identifier: "ident-exchange",
        }),
      ],
      localOpenOrders: [
        createFakeLocalOpenOrder({
          orderId: "local-conflict",
          exchangeOrderId: "uuid-conflict",
          identifier: "ident-local",
        }),
      ],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider: killSwitchProvider,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    // ORDER_IDENTITY_CONFLICT는 MANUAL_REVIEW_REQUIRED로 승격되어야 한다
    const hasIdentityConflict = result.engineOutput.mismatches.some(
      (mismatch) => mismatch.mismatchType === "ORDER_IDENTITY_CONFLICT",
    );
    expect(hasIdentityConflict).toBe(true);
    expect(result.engineOutput.failClosed).toBe(true);
    expect(result.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(killSwitchProvider.appliedRequests.length).toBeGreaterThan(0);
    expect(killSwitchProvider.appliedRequests[0]!.targetState).toBe("MANUAL_REVIEW_REQUIRED");
    expect(killSwitchProvider.appliedRequests[0]!.reasonCode).toBe("live_reconcile_identity_conflict");
  });

  it("잔고 lock 불일치는 mismatch evidence와 fail-closed를 만든다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const killSwitchProvider = new FakeKillSwitchControlProvider();
    // 거래소 잔고와 로컬 잔고의 locked 값이 다른 상황
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [
        createFakeExchangeOpenOrder({
          exchangeOrderId: "uuid-balance-lock",
          identifier: "ident-balance-lock",
        }),
      ],
      localOpenOrders: [
        createFakeLocalOpenOrder({
          orderId: "local-balance-lock",
          exchangeOrderId: "uuid-balance-lock",
          identifier: "ident-balance-lock",
          remainingQuantity: "0.001",
        }),
      ],
      exchangeBalances: [createFakeBrokerBalance({ locked: "5000" })],
      localBalances: [createFakeBrokerBalance({ locked: "10000" })],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider: killSwitchProvider,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    const hasBalanceMismatch = result.engineOutput.mismatches.some(
      (mismatch) => mismatch.mismatchType === "BALANCE_LOCK_MISMATCH",
    );
    expect(hasBalanceMismatch).toBe(true);
    expect(result.engineOutput.failClosed).toBe(true);
    expect(result.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(repository.mismatchEvidence.length).toBeGreaterThan(0);
  });

  it("kill switch provider 없는 mismatch는 오류로 실패한다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [
        createFakeExchangeOpenOrder({ exchangeOrderId: "uuid-no-kill", identifier: "ident-no-kill" }),
      ],
      localOpenOrders: [],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      // killSwitchControlProvider 없이 mismatch가 발생하면 worker는 evidence 저장 전에 실패해야 한다
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    await expect(worker.runOnce()).rejects.toThrow();

    // kill switch provider 없이 mismatch가 발생하면 evidence를 저장하지 않고 run도 FAILED로 닫힌다
    expect(repository.mismatchEvidence).toHaveLength(0);
    const runs = [...repository.runs.values()];
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("FAILED");
  });

  it("거래소 closed order 조회 window 밖 로컬 주문은 mismatch evidence를 남긴다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const killSwitchProvider = new FakeKillSwitchControlProvider();
    // 로컬에는 있지만 거래소 closed order window에 포함되지 않은 주문
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [],
      exchangeClosedOrders: [],
      orderLookups: [],
      localOpenOrders: [
        createFakeLocalOpenOrder({
          orderId: "local-old-order",
          identifier: "ident-old",
          createdAt: "2026-05-01T00:00:00Z",
        }),
      ],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
      closedOrderWindow: {
        windowStart: "2026-05-27T00:00:00Z",
        windowEnd: "2026-06-03T00:00:00Z",
        windowExhausted: false,
        queryCount: 1,
      },
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open+closed",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider: killSwitchProvider,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    const hasWindowExceeded = result.engineOutput.mismatches.some(
      (mismatch) => mismatch.mismatchType === "CLOSED_ORDER_WINDOW_EXCEEDED",
    );
    expect(hasWindowExceeded).toBe(true);
    expect(result.engineOutput.failClosed).toBe(true);
    expect(repository.mismatchEvidence.length).toBeGreaterThan(0);
  });

  it("WebSocket gap이 감지되면 mismatch evidence를 남기고 DEGRADED 상태가 된다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const killSwitchProvider = new FakeKillSwitchControlProvider();
    // WebSocket disconnect evidence가 있는 상황
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [createFakeExchangeOpenOrder()],
      localOpenOrders: [createFakeLocalOpenOrder()],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
      websocketContext: {
        bootstrapCompleteAt: "2026-06-03T00:00:00Z",
        events: [],
        disconnectEvidence: {
          disconnectedAt: "2026-06-03T00:00:01Z",
          reconnectedAt: "2026-06-03T00:00:31Z",
          gapDurationMs: 30000,
          reconnectCount: 1,
        },
      },
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open, WS: myOrder+myAsset",
    });
    const worker = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      killSwitchControlProvider: killSwitchProvider,
      clock: () => new Date("2026-06-03T00:00:00Z"),
    });

    const result = await worker.runOnce();

    const hasWsGap = result.engineOutput.mismatches.some(
      (mismatch) => mismatch.mismatchType === "WEBSOCKET_GAP_MANUAL_REVIEW",
    );
    expect(hasWsGap).toBe(true);
    expect(result.statusSummary.websocketStatus).toBe("DEGRADED");
    expect(result.engineOutput.failClosed).toBe(true);
  });

  it("idempotency key가 같은 재실행은 같은 run을 재사용한다", async () => {
    const repository = new FakeLiveReconcileRepository();
    const engineInput = createFakeEngineInput({
      exchangeOpenOrders: [createFakeExchangeOpenOrder()],
      localOpenOrders: [createFakeLocalOpenOrder()],
      exchangeBalances: [createFakeBrokerBalance()],
      localBalances: [createFakeBrokerBalance()],
    });
    const snapshotProvider = new FakeReconcileSnapshotProvider({
      engineInput,
      sourceSummary: "REST: accounts+open",
    });
    const fixedClock = () => new Date("2026-06-03T00:00:00Z");
    const worker1 = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      clock: fixedClock,
    });

    // 첫 번째 실행: 성공
    const result1 = await worker1.runOnce({ correlationId: "same-correlation-id" });
    expect(result1.engineOutput.summary.result).toBe("CLEAN");

    // 같은 correlationId + clock이면 같은 idempotency key로 두 번째 runOnce 시도 시 중복 차단
    const worker2 = createLiveReconcileRuntimeWorker({
      snapshotProvider,
      repository,
      clock: fixedClock,
    });

    await expect(worker2.runOnce({ correlationId: "same-correlation-id" })).rejects.toThrow();

    // run은 하나만 생성됐는지 확인
    expect(repository.runs.size).toBe(1);
  });
});
