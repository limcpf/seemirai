import { sql, type Transaction } from "kysely";
import type { Database } from "../database.js";
import type { DatabaseSchema } from "../schema.js";
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

    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.lockLiveReconcileRunForAppend(transaction, runId))) {
        return [];
      }

      // ON CONFLICT DO NOTHING으로 모든 unique index 위반을 무시한다.
      return transaction
        .insertInto("live_reconcile_balance_snapshots")
        .values(rows)
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .execute();
    });
  }

  /**
   * exchange order snapshot을 batch insert한다. 같은 run/exchange_order_id 조합은 중복 insert되지 않는다.
   *
   * idempotency: partial unique index로 중복 row를 차단한다.
   * `exchange_order_id`가 있는 row는 run_id+exchange_order_id partial unique index로,
   * identifier가 있는 row는 uuid 관측 여부와 무관하게 run_id+identifier partial unique index로 중복을 차단한다.
   * uuid/identifier가 모두 없는 fingerprint-only row는 실제 중복 주문 가능성이 있어 unique dedupe하지 않고 append-only로 보존한다.
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

    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.lockLiveReconcileRunForAppend(transaction, runId))) {
        return [];
      }

      const records: LiveReconcileExchangeOrderSnapshotRecord[] = [];

      for (const snapshot of snapshots) {
        const row = toLiveReconcileExchangeOrderSnapshotRowInput(runId, snapshot);

        // bridge snapshot은 기존 partial evidence를 삭제하지 않고 canonical summary에서만 연결한다.
        const insertedRow = await transaction
          .insertInto("live_reconcile_exchange_order_snapshots")
          .values(row)
          .onConflict((conflict) => conflict.doNothing())
          .returningAll()
          .executeTakeFirst();

        if (insertedRow !== undefined) {
          records.push(insertedRow);
        }
      }

      return records;
    });
  }

  /**
   * mismatch evidence를 batch insert한다. 같은 run 안의 `evidence_fingerprint`는 중복 저장되지 않는다.
   *
   * idempotency: `run_id + evidence_fingerprint` UNIQUE constraint로 같은 run의 재시도 중복만 차단한다.
   * 다음 run에서 반복 관측된 mismatch는 최신 summary와 fail-closed 근거로 다시 남아야 한다.
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

    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.lockLiveReconcileRunForAppend(transaction, runId))) {
        return [];
      }

      // 반복 mismatch를 최신 run에도 남기기 위해 전역 fingerprint가 아니라 run 범위 중복만 무시한다.
      return transaction
        .insertInto("live_reconcile_mismatch_evidence")
        .values(rows)
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .execute();
    });
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

    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.lockLiveReconcileRunForAppend(transaction, runId))) {
        return [];
      }

      // 복구 후보는 근거 감사가 우선이므로 중복 snapshot만 무시하고 기존 position row는 여기서 건드리지 않는다.
      return transaction
        .insertInto("live_reconcile_position_snapshots")
        .values(rows)
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .execute();
    });
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

    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.lockLiveReconcileRunForAppend(transaction, runId))) {
        return [];
      }

      // 체결 복구는 unique key 선점이 성공한 항목만 진행해야 중복 fills insert를 피할 수 있다.
      return transaction
        .insertInto("live_reconcile_fill_recovery_keys")
        .values(rows)
        .onConflict((conflict) => conflict.doNothing())
        .returningAll()
        .execute();
    });
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
    const [finalRun, latestRun] = await Promise.all([
      this.database
        .selectFrom("live_reconcile_runs")
        .selectAll()
        .where("status", "!=", "RUNNING")
        .orderBy("finished_at", "desc")
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst(),
      this.database
        .selectFrom("live_reconcile_runs")
        .selectAll()
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);
    const run = selectLatestVisibleReconcileRun(finalRun, latestRun);

    if (run === undefined) {
      return {
        run: null,
        balanceSnapshotCount: 0,
        exchangeOrderSnapshotCount: 0,
        openExchangeOrderSnapshotCount: 0,
        mismatchEvidenceCount: 0,
        mismatchTypes: [],
        positionSnapshotCount: 0,
        fillRecoveryKeyCount: 0,
      };
    }

    const [
      balanceCount,
      exchangeOrderRows,
      openExchangeOrderRows,
      mismatchCount,
      mismatchTypeRows,
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
        .select(["id", "exchange_order_id", "identifier"])
        .where("run_id", "=", run.id)
        .execute(),
      this.database
        .selectFrom("live_reconcile_exchange_order_snapshots")
        .select(["id", "exchange_order_id", "identifier"])
        .where("run_id", "=", run.id)
        .where("status", "in", OPEN_EXCHANGE_ORDER_STATUSES)
        .execute(),
      this.database
        .selectFrom("live_reconcile_mismatch_evidence")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
      this.database
        .selectFrom("live_reconcile_mismatch_evidence")
        .select("mismatch_type")
        .distinct()
        .where("run_id", "=", run.id)
        .execute(),
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
      exchangeOrderSnapshotCount:
        countCanonicalExchangeOrderSnapshots(exchangeOrderRows),
      openExchangeOrderSnapshotCount:
        countCanonicalExchangeOrderSnapshots(openExchangeOrderRows),
      mismatchEvidenceCount: Number(mismatchCount.count),
      mismatchTypes: mismatchTypeRows.map((row) => row.mismatch_type),
      positionSnapshotCount: Number(positionCount.count),
      fillRecoveryKeyCount: Number(fillRecoveryKeyCount.count),
    };
  }

  /**
   * append-only 하위 row를 final run에 뒤늦게 섞지 않기 위해 run row를 transaction 안에서 잠근다.
   *
   * 존재하지 않는 run은 호출 경계 오류이므로 기존 FK 실패처럼 throw하고, final run은 재시도 side effect를 막기 위해 false를 반환한다.
   * 같은 transaction의 row lock으로 완료 전이와 snapshot append가 서로 끼어들지 못하게 한다.
   *
   * @param transaction append insert를 수행할 transaction
   * @param runId 확인할 reconcile run ID
   * @returns 하위 snapshot/evidence/key append가 허용되는 RUNNING run이면 true
   */
  private async lockLiveReconcileRunForAppend(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
  ): Promise<boolean> {
    const run = await transaction
      .selectFrom("live_reconcile_runs")
      .select(["status"])
      .where("id", "=", runId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    return run.status === "RUNNING";
  }
}

function selectLatestVisibleReconcileRun<T extends { status: string; started_at: Date | string }>(
  finalRun: T | undefined,
  latestRun: T | undefined,
): T | undefined {
  if (latestRun?.status === "RUNNING") {
    if (finalRun === undefined || toTimeMs(latestRun.started_at) > toTimeMs(finalRun.started_at)) {
      // 더 최근 RUNNING run은 이전 final 결과를 stale한 최신 상태로 보이지 않게 우선 노출한다.
      return latestRun;
    }
  }
  return finalRun ?? latestRun;
}

function toTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

const OPEN_EXCHANGE_ORDER_STATUSES = ["wait", "watch", "open", "OPEN"] as const;

/**
 * exchange order snapshot row를 append-only로 보존하면서 summary에는 canonical 주문 수를 계산한다.
 *
 * uuid-only와 identifier-only로 따로 관측된 row는 두 식별자가 모두 있는 bridge snapshot이 들어온 뒤 하나의
 * 주문 identity로 연결된다. 이 함수는 DB row를 수정하지 않는 읽기 전용 계산이며 외부 side effect가 없다.
 */
function countCanonicalExchangeOrderSnapshots(
  rows: Array<{ id: string; exchange_order_id: string | null; identifier: string | null }>,
): number {
  const parent = new Map<string, string>();
  let fingerprintOnlyRowCount = 0;

  const find = (key: string): string => {
    const existing = parent.get(key);
    if (existing === undefined) {
      parent.set(key, key);
      return key;
    }

    if (existing === key) {
      return key;
    }

    const root = find(existing);
    parent.set(key, root);
    return root;
  };

  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };

  for (const row of rows) {
    const exchangeOrderKey =
      row.exchange_order_id === null ? undefined : `exchange:${row.exchange_order_id}`;
    const identifierKey =
      row.identifier === null ? undefined : `identifier:${row.identifier}`;

    if (exchangeOrderKey === undefined && identifierKey === undefined) {
      // fingerprint-only row는 동일 fingerprint 충돌 가능성이 있으므로 summary에서도 개별 snapshot으로 보존한다.
      fingerprintOnlyRowCount += 1;
      continue;
    }

    if (exchangeOrderKey !== undefined) {
      find(exchangeOrderKey);
    }

    if (identifierKey !== undefined) {
      find(identifierKey);
    }

    if (exchangeOrderKey !== undefined && identifierKey !== undefined) {
      // bridge row는 partial row를 삭제하지 않고 두 관측 식별자만 같은 canonical 주문으로 연결한다.
      union(exchangeOrderKey, identifierKey);
    }
  }

  return new Set(Array.from(parent.keys(), (key) => find(key))).size + fingerprintOnlyRowCount;
}
