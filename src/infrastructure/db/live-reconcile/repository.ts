import { sql } from "kysely";
import type { Database } from "../database.js";
import type {
  LiveReconcileBalanceSnapshotRecord,
  LiveReconcileExchangeOrderSnapshotRecord,
  LiveReconcileFillRecoveryKeyRecord,
  LiveReconcileMismatchEvidenceRecord,
  LiveReconcilePositionSnapshotRecord,
  LiveReconcileRunRecord,
  LiveReconcileSummary,
} from "./types.js";
import type {
  BeginLiveReconcileRunInput,
  CompleteLiveReconcileRunInput,
} from "./types.js";
import {
  toLiveReconcileBalanceSnapshotRowInput,
  toLiveReconcileExchangeOrderSnapshotRowInput,
  toLiveReconcileFillRecoveryKeyRowInput,
  toLiveReconcileMismatchEvidenceRowInput,
  toLiveReconcilePositionSnapshotRowInput,
  toLiveReconcileRunRowInput,
} from "./row-mapper.js";

/**
 * 완료된 reconcile run에 서로 다른 최종 상태를 다시 기록하려 할 때 발생하는 오류다.
 *
 * repository boundary에서 RUNNING->final 단방향 전이를 보존하기 위한 차단 신호이며, DB row를 수정하지 않는다.
 */
export class LiveReconcileRunAlreadyFinalizedError extends Error {
  public constructor(
    public readonly runId: string,
    public readonly currentStatus: LiveReconcileRunRecord["status"],
    public readonly requestedStatus: CompleteLiveReconcileRunInput["status"],
  ) {
    super(
      `Live reconcile run ${runId} is already finalized as ${currentStatus}; requested ${requestedStatus}`,
    );
    this.name = "LiveReconcileRunAlreadyFinalizedError";
  }
}

/**
 * M16 실계좌 상태 Reconcile 전용 append-only table repository.
 *
 * 모든 write는 transaction 단위로 묶여야 하며, 같은 idempotency key 재실행은 중복 row를 만들지 않는다.
 * run 실패 시에도 이미 저장된 snapshot/evidence는 append-only로 남아야 한다.
 */
export class PostgresLiveReconcileRepository {
  public constructor(private readonly database: Database) {}

  /**
   * 새로운 reconcile run을 시작하거나 같은 idempotency key로 기존 run을 재사용한다.
   *
   * idempotency: 같은 `idempotencyKey`가 이미 존재하면 기존 run row를 반환하고 새 row를 만들지 않는다.
   *
   * @param input run 시작 입력
   * @returns 생성됐으면 `created: true`와 run record, 기존 run이면 `created: false`와 기존 record
   */
  public async beginLiveReconcileRun(
    input: BeginLiveReconcileRunInput,
  ): Promise<{ created: boolean; run: LiveReconcileRunRecord }> {
    const row = toLiveReconcileRunRowInput(input);

    const inserted = await this.database
      .insertInto("live_reconcile_runs")
      .values(row)
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) {
      return { created: true, run: inserted };
    }

    // 같은 idempotency_key의 기존 run을 반환한다.
    const existing = await this.database
      .selectFrom("live_reconcile_runs")
      .selectAll()
      .where("idempotency_key", "=", input.idempotencyKey)
      .executeTakeFirstOrThrow();

    return { created: false, run: existing };
  }

  /**
   * balance snapshot을 batch insert한다. 같은 run/currency/captured_at/source 조합은 중복 insert되지 않는다.
   *
   * idempotency: partial unique index `live_reconcile_balance_snapshots_run_currency_time_uidx`로
   * 중복 row를 차단한다. `ON CONFLICT DO NOTHING`으로 중복은 무시하고 계속 진행한다.
   *
   * @param runId 소속 run ID
   * @param snapshots 저장할 balance snapshot 목록
   * @returns 실제 insert된 snapshot record 목록
   */
  public async appendLiveReconcileBalanceSnapshots(
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
    if (snapshots.length === 0) {
      return [];
    }

    const rows = snapshots.map((snapshot) =>
      toLiveReconcileBalanceSnapshotRowInput(runId, snapshot),
    );

    // ON CONFLICT DO NOTHING으로 모든 unique index 위반을 무시한다.
    const inserted = await this.database
      .insertInto("live_reconcile_balance_snapshots")
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .execute();

    return inserted;
  }

  /**
   * exchange order snapshot을 batch insert한다. 같은 run/exchange_order_id 조합은 중복 insert되지 않는다.
   *
   * idempotency: partial unique index로 중복 row를 차단한다.
   * `exchange_order_id`가 있는 row는 run_id+exchange_order_id partial unique index로,
   * `exchange_order_id`가 없고 identifier만 있는 row는 run_id+identifier partial unique index로 중복을 차단한다.
   * `ON CONFLICT DO NOTHING`으로 중복은 무시하고 계속 진행한다.
   *
   * @param runId 소속 run ID
   * @param snapshots 저장할 exchange order snapshot 목록
   * @returns 실제 insert된 snapshot record 목록
   */
  public async appendLiveReconcileExchangeOrderSnapshots(
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
    if (snapshots.length === 0) {
      return [];
    }

    const rows = snapshots.map((snapshot) =>
      toLiveReconcileExchangeOrderSnapshotRowInput(runId, snapshot),
    );

    // ON CONFLICT DO NOTHING으로 모든 unique index 위반을 무시한다.
    const inserted = await this.database
      .insertInto("live_reconcile_exchange_order_snapshots")
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .execute();

    return inserted;
  }

  /**
   * mismatch evidence를 batch insert한다. 같은 `evidence_fingerprint`는 중복 저장되지 않는다.
   *
   * idempotency: `evidence_fingerprint` UNIQUE constraint로 중복을 차단한다.
   * `ON CONFLICT DO NOTHING`으로 중복은 무시하고 계속 진행한다.
   *
   * @param runId 소속 run ID
   * @param evidenceList 저장할 mismatch evidence 목록
   * @returns 실제 insert된 evidence record 목록
   */
  public async appendLiveReconcileMismatchEvidence(
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
    if (evidenceList.length === 0) {
      return [];
    }

    const rows = evidenceList.map((evidence) =>
      toLiveReconcileMismatchEvidenceRowInput(runId, evidence),
    );

    // ON CONFLICT DO NOTHING으로 evidence_fingerprint UNIQUE 위반을 무시한다.
    const inserted = await this.database
      .insertInto("live_reconcile_mismatch_evidence")
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .execute();

    return inserted;
  }

  /**
   * position recovery snapshot을 batch insert한다.
   *
   * idempotency: 같은 run/exchange/market/strategy/captured_at/source 조합은 unique index로 중복 저장되지 않는다.
   * 평균단가 근거가 없는 후보는 snapshot/evidence만 남기고 domain `positions` 갱신은 호출자가 차단해야 한다.
   *
   * @param runId 소속 run ID
   * @param snapshots 저장할 position snapshot 목록
   * @returns 실제 insert된 position snapshot record 목록
   */
  public async appendLiveReconcilePositionSnapshots(
    runId: string,
    snapshots: Array<{
      exchange: string;
      market: string;
      strategyId: string;
      quantity: string;
      averageEntryPrice?: string;
      recoveryStatus: "RECOVERABLE" | "MANUAL_REVIEW_REQUIRED";
      source: "fills" | "balances" | "local" | "manual_review";
      capturedAt: Date | string;
      evidence?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<LiveReconcilePositionSnapshotRecord[]> {
    if (snapshots.length === 0) {
      return [];
    }

    const rows = snapshots.map((snapshot) =>
      toLiveReconcilePositionSnapshotRowInput(runId, snapshot),
    );

    // 복구 후보는 근거 감사가 우선이므로 중복 snapshot만 무시하고 기존 position row는 여기서 건드리지 않는다.
    const inserted = await this.database
      .insertInto("live_reconcile_position_snapshots")
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .execute();

    return inserted;
  }

  /**
   * fill recovery key를 batch insert한다.
   *
   * idempotency: 거래소 체결 ID 또는 정규화 fill fingerprint 중 하나라도 이미 선점됐으면 insert하지 않는다.
   * 이 선점이 성공한 fill만 후속 domain `fills` transaction의 입력으로 사용할 수 있다.
   *
   * @param runId 소속 run ID
   * @param keys 선점할 fill recovery key 목록
   * @returns 실제 insert된 recovery key record 목록
   */
  public async appendLiveReconcileFillRecoveryKeys(
    runId: string,
    keys: Array<{
      exchange: string;
      market: string;
      orderId?: string;
      exchangeOrderId?: string;
      exchangeFillId?: string;
      fillFingerprint: string;
      side: "BUY" | "SELL";
      price: string;
      quantity: string;
      filledAt: Date | string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<LiveReconcileFillRecoveryKeyRecord[]> {
    if (keys.length === 0) {
      return [];
    }

    const rows = keys.map((key) => toLiveReconcileFillRecoveryKeyRowInput(runId, key));

    // 체결 복구는 unique key 선점이 성공한 항목만 진행해야 중복 fills insert를 피할 수 있다.
    const inserted = await this.database
      .insertInto("live_reconcile_fill_recovery_keys")
      .values(rows)
      .onConflict((conflict) => conflict.doNothing())
      .returningAll()
      .execute();

    return inserted;
  }

  /**
   * reconcile run을 완료 상태로 갱신한다.
   *
   * `RUNNING` 상태에서만 `finished_at`을 현재 시각으로 설정하고 최종 상태로 전이한다.
   * 이미 같은 최종 상태라면 기존 row를 그대로 반환하고, 다른 최종 상태로의 재완료는 차단한다.
   *
   * @param input 완료 입력
   * @returns 갱신된 run record
   * @throws {LiveReconcileRunAlreadyFinalizedError} 이미 다른 최종 상태로 완료된 run을 다시 완료하려 할 때
   */
  public async completeLiveReconcileRun(
    input: CompleteLiveReconcileRunInput,
  ): Promise<LiveReconcileRunRecord> {
    const updated = await this.database
      .updateTable("live_reconcile_runs")
      .set({
        status: input.status,
        finished_at: sql`now()`,
      })
      .where("id", "=", input.runId)
      .where("status", "=", "RUNNING")
      .returningAll()
      .executeTakeFirst();

    if (updated !== undefined) {
      return updated;
    }

    const existing = await this.database
      .selectFrom("live_reconcile_runs")
      .selectAll()
      .where("id", "=", input.runId)
      .executeTakeFirstOrThrow();

    if (existing.status === input.status) {
      return existing;
    }

    // 최종 상태를 뒤집으면 evidence와 run 결과의 불변성이 깨지므로 DB write 없이 호출자를 실패시킨다.
    throw new LiveReconcileRunAlreadyFinalizedError(
      input.runId,
      existing.status,
      input.status,
    );
  }

  /**
   * 가장 최근 reconcile run의 요약 정보를 조회한다.
   *
   * 최근 run record와 각 append-only table의 row count를 함께 반환한다.
   * 읽기 전용 조회라 외부 side effect는 없다.
   *
   * @returns 최근 reconcile run 요약. run이 없으면 `run: null`과 count 0
   */
  public async getLatestLiveReconcileSummary(): Promise<LiveReconcileSummary> {
    const run = await this.database
      .selectFrom("live_reconcile_runs")
      .selectAll()
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();

    if (run === undefined) {
      return {
        run: null,
        balanceSnapshotCount: 0,
        exchangeOrderSnapshotCount: 0,
        mismatchEvidenceCount: 0,
        positionSnapshotCount: 0,
        fillRecoveryKeyCount: 0,
      };
    }

    const [
      balanceCount,
      exchangeOrderCount,
      mismatchCount,
      positionCount,
      fillRecoveryKeyCount,
    ] = await Promise.all([
      this.database
        .selectFrom("live_reconcile_balance_snapshots")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("live_reconcile_exchange_order_snapshots")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("live_reconcile_mismatch_evidence")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("live_reconcile_position_snapshots")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("live_reconcile_fill_recovery_keys")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
    ]);

    return {
      run,
      balanceSnapshotCount: Number(balanceCount.count),
      exchangeOrderSnapshotCount: Number(exchangeOrderCount.count),
      mismatchEvidenceCount: Number(mismatchCount.count),
      positionSnapshotCount: Number(positionCount.count),
      fillRecoveryKeyCount: Number(fillRecoveryKeyCount.count),
    };
  }
}
