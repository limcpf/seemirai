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

  it("skips duplicate exchange order snapshots with the same identifier after uuid is observed", async () => {
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

    expect(identifierOnly).toHaveLength(1);
    expect(withUuid).toHaveLength(0);
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
        mismatchType: "BALANCE_LOCK_MISMATCH",
        severity: "ERROR",
        currency: "KRW",
        message: "KRW lock 잔고 불일치",
        action: "수동 검토",
        evidenceFingerprint: "all-types-005",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "CLOSED_ORDER_WINDOW_EXCEEDED",
        severity: "WARN",
        orderIdentity: "uuid-4",
        message: "종료 주문 조회 기간 초과",
        action: "수동 확인 필요",
        evidenceFingerprint: "all-types-006",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
      {
        mismatchType: "WEBSOCKET_GAP_MANUAL_REVIEW",
        severity: "WARN",
        message: "WebSocket 데이터 갭 발생",
        action: "REST 재조회 후 확인",
        evidenceFingerprint: "all-types-007",
        occurredAt: new Date("2026-06-03T00:00:00Z"),
      },
    ]);

    expect(evidence).toHaveLength(7);
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
