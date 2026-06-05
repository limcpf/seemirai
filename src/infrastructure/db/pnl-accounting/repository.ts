import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../database.js";
import type { PnLAccountingOutput } from "../../../application/pnl-accounting.js";
import {
  toPnlSnapshotRowInputs,
  toReconcilePositionSnapshotRecord,
} from "./row-mapper.js";
import type {
  LoadReconcileFactsInput,
  LoadReconcileFactsResult,
  PersistPnlSnapshotInput,
  PersistPnlSnapshotResult,
  PnlSnapshotRecord,
  ReconcilePositionSnapshotRecord,
} from "./types.js";

const pnlSnapshotAdvisoryLockNamespace = "seemirai:pnl_snapshots";

/**
 * PnL/포지션 회계 snapshot persistence repository다.
 *
 * ## 책임
 *
 * 1. calculator output을 `pnl_snapshots` 테이블에 저장하며 `captured_at` + strategy/market + source fingerprint
 *    기반 중복 insert를 차단한다.
 * 2. `live_reconcile_position_snapshots` 테이블에서 RECOVERABLE과 MANUAL_REVIEW_REQUIRED snapshot을 함께
 *    읽어 calculator의 `PnLReconcileFact` 입력과 수동 검토 evidence로 제공한다 (reconcile source).
 *
 * ## Idempotency 전략
 *
 * `pnl_snapshots`는 TimescaleDB hypertable로 PRIMARY KEY나 UNIQUE constraint가 없으므로,
 * 같은 snapshot scope/fingerprint의 transaction advisory lock을 잡고 기존 snapshot 존재 여부를 확인한 뒤 INSERT한다.
 * 같은 `captured_at` + `strategy_id` + `market` + source fingerprint 조합이 이미 존재하면 skip하고
 * 기존 record를 반환한다.
 *
 * ## 보안 경계
 *
 * - trace payload에 secret, access key, JWT, raw provider payload를 저장하지 않는다.
 * - `payload_json`에는 calculator trace 항목(runId, correlationId, sourceTables, lastSourceTimestamp)만
 *   포함한다.
 */
export class PostgresPnlAccountingRepository {
  public constructor(private readonly database: Database) {}

  /**
   * PnL accounting output을 `pnl_snapshots` 테이블에 저장한다.
   *
   * ## Idempotency
   *
   * `sourceFingerprint`는 호출자가 계산한 fingerprint hash이며, DB 수준에서는
   * `captured_at` + `strategy_id` + COALESCE(`market`, '') + payload의 `sourceFingerprint` 조합으로
   * 중복을 확인한다.
   * TimescaleDB hypertable은 ON CONFLICT의 UNIQUE index를 지원하지 않으므로,
   * advisory transaction lock을 잡은 뒤 SELECT → INSERT 순서로 중복을 차단한다.
   *
   * @param input persist 입력
   * @returns insert 결과
   */
  public async persistPnlSnapshot(
    input: PersistPnlSnapshotInput,
  ): Promise<PersistPnlSnapshotResult> {
    const rows = toPnlSnapshotRowInputs(
      input.output,
      input.capturedAt,
      {
        sourceFingerprint: input.sourceFingerprint,
        drawdownBps: input.drawdownBps,
      },
    );

    if (rows.length === 0) {
      return { inserted: false, snapshots: [] };
    }

    return this.database.transaction().execute(async (transaction) => {
      const persisted: PnlSnapshotRecord[] = [];
      let insertedAny = false;

      for (const row of rows) {
        const marketParam = row.market ?? null;

        await lockPnlSnapshotScope(transaction, {
          capturedAt: row.captured_at as Date | string,
          strategyId: row.strategy_id!,
          market: marketParam,
          sourceFingerprint: input.sourceFingerprint,
        });

        // 같은 source fingerprint의 재시도만 멱등 처리해 다른 입력을 같은 시각 snapshot으로 덮어쓰지 않는다.
        const existing = await transaction
          .selectFrom("pnl_snapshots")
          .selectAll()
          .where("strategy_id", "=", row.strategy_id!)
          .where("captured_at", "=", row.captured_at as Date)
          .where((eb) =>
            marketParam === null
              ? eb("market", "is", null)
              : eb("market", "=", marketParam),
          )
          .where(sql<string>`payload_json ->> 'sourceFingerprint'`, "=", input.sourceFingerprint)
          .executeTakeFirst();

        if (existing !== undefined) {
          persisted.push(existing);
          continue;
        }

        const inserted = await transaction
          .insertInto("pnl_snapshots")
          .values(row)
          .returningAll()
          .executeTakeFirstOrThrow();

        insertedAny = true;
        persisted.push(inserted);
      }

      return {
        inserted: insertedAny,
        snapshots: persisted,
      };
    });
  }

  /**
   * `live_reconcile_position_snapshots` 테이블에서 reconcile position snapshot을 로딩한다.
   *
   * ## 선택 기준
   *
   * - RECOVERABLE snapshot은 계산 가능한 평균단가 source 후보가 된다.
   * - MANUAL_REVIEW_REQUIRED snapshot은 PnL 계산 불가 원인과 수동 검토 evidence로 남긴다.
   * - RUNNING/FAILED run의 중간 snapshot은 손익 source로 승격하지 않는다.
   * - 선택적 `strategyId`, `market`, `since` 필터를 적용한다.
   *
   * ## 반환
   *
   * - `records`: 원본 DB record 목록 (감사/추적용)
   * - `reconcileFacts`: calculator `PnLReconcileFact` 입력 계약으로 정규화된 목록
   *
   * 읽기 전용 조회라 외부 side effect는 없다.
   *
   * @param input 조회 조건
   * @returns reconcile facts 결과
   */
  public async loadReconcileFacts(
    input: LoadReconcileFactsInput = {},
  ): Promise<LoadReconcileFactsResult> {
    let query = this.database
      .selectFrom("live_reconcile_position_snapshots")
      .innerJoin(
        "live_reconcile_runs",
        "live_reconcile_runs.id",
        "live_reconcile_position_snapshots.run_id",
      )
      .selectAll("live_reconcile_position_snapshots")
      .select([
        "live_reconcile_runs.started_at as run_started_at",
        "live_reconcile_runs.finished_at as run_finished_at",
      ])
      .where("live_reconcile_runs.status", "in", ["COMPLETED", "MANUAL_REVIEW_REQUIRED"]);

    if (input.strategyId !== undefined) {
      query = query.where("live_reconcile_position_snapshots.strategy_id", "=", input.strategyId);
    }

    if (input.market !== undefined) {
      query = query.where("live_reconcile_position_snapshots.market", "=", input.market);
    }

    if (input.since !== undefined) {
      const sinceValue = typeof input.since === "string" ? input.since : input.since;
      query = query.where("live_reconcile_position_snapshots.captured_at", ">=", sinceValue as Date);
    }

    const rows = await query
      .orderBy("live_reconcile_position_snapshots.captured_at", "desc")
      .execute();

    const records: ReconcilePositionSnapshotRecord[] = rows.map((row) => ({
      ...toReconcilePositionSnapshotRecord(row),
      runStartedAt: row.run_started_at,
      runFinishedAt: row.run_finished_at,
    }));

    // 같은 scope의 과거 run이 최신 recovery 상태를 오염시키지 않도록 strategy/market 기준 최신 snapshot만 채택한다.
    const deduped = deduplicateReconcileRecords(records);

    const reconcileFacts = deduped.map((record) => {
      const manualReviewEvidenceId = record.evidence.manualReviewEvidenceId;
      return {
        strategyId: record.strategyId,
        market: record.market,
        quantity: record.quantity,
        recoveryStatus: record.recoveryStatus,
        averageEntryPrice: record.averageEntryPrice,
        reconciledAt: record.capturedAt,
        averageEntrySource: record.source,
        ...(typeof manualReviewEvidenceId === "string"
          ? { manualReviewEvidenceId }
          : {}),
      };
    });

    return { records, reconcileFacts };
  }
}

/**
 * reconcile position snapshot record 목록에서 strategy/market 기준 중복을 제거하고
 * 가장 최근 captured_at 기준 record 하나만 남긴다.
 *
 * 여러 reconcile run에서 같은 scope가 반복 관측되면 최신 evidence가 과거 record를 덮지 않고
 * calculator에 최신 snapshot만 선택적으로 전달한다.
 *
 * @param records reconcile position snapshot record 목록
 * @returns 중복 제거된 목록
 */
function deduplicateReconcileRecords(
  records: readonly ReconcilePositionSnapshotRecord[],
): ReconcilePositionSnapshotRecord[] {
  const latest = new Map<string, ReconcilePositionSnapshotRecord>();

  for (const record of records) {
    const key = `${record.strategyId}::${record.market}`;
    const existing = latest.get(key);
    if (
      existing === undefined ||
      compareReconcileRecordFreshness(record, existing) > 0
    ) {
      latest.set(key, record);
    }
  }

  return [...latest.values()];
}

function compareReconcileRecordFreshness(
  left: ReconcilePositionSnapshotRecord,
  right: ReconcilePositionSnapshotRecord,
): number {
  const timeDiff = toTimeMs(left.capturedAt) - toTimeMs(right.capturedAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  const runTimeDiff = toRunTieBreakMs(left) - toRunTieBreakMs(right);
  if (runTimeDiff !== 0) {
    return runTimeDiff;
  }

  // 동일 source/run timestamp에서는 run/id 순서를 최후 tie-break로 써 결과를 deterministic하게 유지한다.
  return `${left.runId}:${left.id}`.localeCompare(`${right.runId}:${right.id}`);
}

function toRunTieBreakMs(record: ReconcilePositionSnapshotRecord): number {
  const value = record.runFinishedAt ?? record.runStartedAt;
  return value === undefined || value === null ? 0 : toTimeMs(value);
}

function toTimeMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * `pnl_snapshots` scope/fingerprint 단위의 transaction advisory lock을 선점한다.
 *
 * TimescaleDB hypertable에 현재 unique key가 없어서 SELECT 후 INSERT만으로는 concurrent retry 중복을 막을 수 없다.
 * 이 lock은 같은 captured_at/strategy/market/fingerprint 조합만 직렬화하고, 다른 snapshot scope는 병렬성을 유지한다.
 *
 * @param database transaction database handle
 * @param scope snapshot 멱등 scope
 */
async function lockPnlSnapshotScope(
  database: Database,
  scope: {
    capturedAt: Date | string;
    strategyId: string;
    market: string | null;
    sourceFingerprint: string;
  },
): Promise<void> {
  const lockKey = computeAdvisoryLockKey([
    pnlSnapshotAdvisoryLockNamespace,
    normalizeCapturedAt(scope.capturedAt),
    scope.strategyId,
    scope.market ?? "*",
    scope.sourceFingerprint,
  ]);

  // unique constraint가 없는 hypertable이라 같은 idempotency scope만 DB transaction 안에서 직렬화한다.
  await sql`select pg_advisory_xact_lock(${lockKey}::bigint)`.execute(database);
}

function normalizeCapturedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function computeAdvisoryLockKey(parts: readonly string[]): string {
  const hash = createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
  const unsigned = BigInt(`0x${hash.slice(0, 16)}`);
  const signed = unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
  return signed.toString();
}

/**
 * PnL snapshot persistence를 위한 source fingerprint를 계산한다.
 *
 * 호출자는 captured_at + scope strategy/market 조합 + status + 주요 출력값을 기반으로
 * 이 hash를 만들어 repository에 전달한다. repository는 이 값을 payload에 보존하고
 * captured_at + strategy_id + market + fingerprint 기준으로 중복을 확인한다.
 *
 * 이 함수는 순수 계산이며 side effect는 없다.
 *
 * @param output calculator 출력
 * @param capturedAt snapshot 캡처 시각
 * @returns sha256 hex fingerprint
 */
export function computePnlSnapshotSourceFingerprint(
  output: PnLAccountingOutput,
  capturedAt: Date | string,
  drawdownBps: string,
): string {
  const captured = normalizeCapturedAt(capturedAt);
  const scopeEntries = output.scopes
    .map((scope) => `${scope.strategyId}|${scope.market ?? "*"}|${scope.status}|${scope.source}`)
    .sort()
    .join(";");

  const payload = [
    captured,
    scopeEntries,
    output.status,
    output.realizedPnlKrw ?? "null",
    output.unrealizedPnlKrw ?? "null",
    output.totalPnlKrw ?? "null",
    output.equityKrw ?? "null",
    output.cashKrw ?? "null",
    output.positionMarketValueKrw ?? "null",
    drawdownBps,
  ].join("|");

  return createHash("sha256").update(payload, "utf8").digest("hex");
}
