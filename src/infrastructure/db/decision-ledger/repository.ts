import type { Database } from "../database.js";
import type {
  AppendDecisionLedgerFrameInput,
  AppendDecisionLedgerFrameResult,
  AppendDecisionLedgerEvidenceInput,
  AppendDecisionLedgerEvidenceResult,
  DecisionLedgerFrameRecord,
  DecisionLedgerEvidenceRecord,
} from "./types.js";
import {
  toDecisionLedgerFrameRowInput,
  toDecisionLedgerEvidenceRowInput,
} from "./row-mapper.js";

/**
 * evidence fingerprint가 요청 frame이 아닌 다른 frame에 이미 연결되어 있을 때 발생하는 오류다.
 *
 * fingerprint는 중복 append 방지 key이면서 frame의 근거 연결성을 보존하는 audit key다. 다른 frame의 record를 현재
 * frame 결과처럼 반환하면 `/status.why`가 잘못된 판단 근거를 연결하므로 repository 경계에서 즉시 차단한다.
 */
export class DecisionLedgerEvidenceFrameConflictError extends Error {
  public constructor(
    public readonly expectedFrameId: string,
    public readonly conflictingFrameIds: readonly string[],
  ) {
    super(
      `Decision ledger evidence fingerprint already belongs to another frame: expected=${expectedFrameId}`,
    );
    this.name = "DecisionLedgerEvidenceFrameConflictError";
  }
}

/**
 * M18 판단 이유 ledger 전용 append-only table repository.
 *
 * 모든 write는 append-only로 수행하며, 같은 dedupe_key 또는 evidence_fingerprint 재삽입은
 * 중복 row를 만들지 않는다. update나 delete는 허용하지 않는다.
 *
 * ## idempotency
 *
 * - frame: `dedupe_key` unique constraint + `ON CONFLICT DO NOTHING`으로 중복 insert를 차단.
 *   중복이면 기존 row를 조회해 반환한다.
 * - evidence: `evidence_fingerprint` unique constraint + `ON CONFLICT DO NOTHING`으로 중복 insert를 차단.
 *   중복이면 skip하고 다음 evidence로 진행한다.
 */
export class PostgresDecisionLedgerRepository {
  public constructor(private readonly database: Database) {}

  /**
   * frame 하나를 append-only로 insert한다.
   *
   * idempotency: 같은 `dedupeKey`가 이미 존재하면 기존 record를 반환하고 새 row를 만들지 않는다.
   *
   * @param input append할 frame 입력
   * @returns insert 결과와 durable frame record
   */
  public async appendFrame(
    input: AppendDecisionLedgerFrameInput,
  ): Promise<AppendDecisionLedgerFrameResult> {
    const row = toDecisionLedgerFrameRowInput(input.frame);

    const inserted = await this.database
      .insertInto("decision_ledger_frames")
      .values(row)
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) {
      return { inserted: true, record: inserted };
    }

    // 같은 dedupe_key의 기존 frame을 반환한다.
    const existing = await this.database
      .selectFrom("decision_ledger_frames")
      .selectAll()
      .where("dedupe_key", "=", input.frame.dedupeKey)
      .executeTakeFirstOrThrow();

    return { inserted: false, record: existing };
  }

  /**
   * evidence item 여러 개를 batch append-only로 insert한다.
   *
   * idempotency: 각 evidence의 `evidenceFingerprint` unique constraint로 중복 insert를 차단한다.
   * 중복이면 해당 evidence만 skip하고 나머지는 계속 진행한다.
   *
   * @param frameId 상위 frame의 DB id
   * @param items append할 evidence item 목록
   * @returns insert 결과 (전체 insert 시도 중 새로 들어간 개수, skip된 개수, 최종 record 목록)
   */
  public async appendEvidenceItems(
    frameId: string,
    items: readonly AppendDecisionLedgerEvidenceInput[],
  ): Promise<AppendDecisionLedgerEvidenceResult> {
    if (items.length === 0) {
      return { inserted: 0, skipped: 0, records: [] };
    }

    const rows = items.map((input) =>
      toDecisionLedgerEvidenceRowInput(frameId, input.item),
    );

    const fingerprints = items.map((input) => input.item.evidenceFingerprint);
    return this.database.transaction().execute(async (transaction) => {
      const existingRecords = await transaction
        .selectFrom("decision_ledger_evidence")
        .selectAll()
        .where("evidence_fingerprint", "in", fingerprints)
        .execute();
      const existingConflictingFrameIds = collectConflictingFrameIds(existingRecords, frameId);
      if (existingConflictingFrameIds.length > 0) {
        // 다른 frame fingerprint가 섞인 batch는 append-only row 일부가 남기 전에 전체 write를 중단한다.
        throw new DecisionLedgerEvidenceFrameConflictError(frameId, existingConflictingFrameIds);
      }

      const inserted = await transaction
        .insertInto("decision_ledger_evidence")
        .values(rows)
        .onConflict((conflict) => conflict.column("evidence_fingerprint").doNothing())
        .returningAll()
        .execute();

      // concurrent insert가 끼어들어도 충돌 감지 시 transaction rollback으로 신규 row 잔류를 막는다.
      const allRecords = await transaction
        .selectFrom("decision_ledger_evidence")
        .selectAll()
        .where("evidence_fingerprint", "in", fingerprints)
        .orderBy("occurred_at", "asc")
        .orderBy("id", "asc")
        .execute();
      const conflictingFrameIds = collectConflictingFrameIds(allRecords, frameId);
      if (conflictingFrameIds.length > 0) {
        throw new DecisionLedgerEvidenceFrameConflictError(frameId, conflictingFrameIds);
      }

      return {
        inserted: inserted.length,
        skipped: items.length - inserted.length,
        records: allRecords,
      };
    });
  }

  /**
   * dedupe key로 frame을 조회한다.
   *
   * 중복 append 방지가 정상 동작하는지 검증하거나, producer가 같은 frame의 기존 기록을 확인할 때 사용한다.
   *
   * @param dedupeKey 조회할 dedupe key
   * @returns frame record 또는 undefined
   */
  public async findFrameByDedupeKey(
    dedupeKey: string,
  ): Promise<DecisionLedgerFrameRecord | undefined> {
    return this.database
      .selectFrom("decision_ledger_frames")
      .selectAll()
      .where("dedupe_key", "=", dedupeKey)
      .executeTakeFirst();
  }

  /**
   * frame id로 evidence 목록을 조회한다.
   *
   * 모든 evidence record를 occurred_at 오름차순으로 반환한다.
   *
   * @param frameId 상위 frame의 DB id
   * @returns evidence record 목록
   */
  public async findEvidenceByFrameId(
    frameId: string,
  ): Promise<readonly DecisionLedgerEvidenceRecord[]> {
    return this.database
      .selectFrom("decision_ledger_evidence")
      .selectAll()
      .where("frame_id", "=", frameId)
      .orderBy("occurred_at", "asc")
      .execute();
  }

  /**
   * 여러 frame id로 evidence를 batch 조회한다.
   *
   * @param frameIds 조회할 frame id 목록
   * @returns evidence record 목록
   */
  public async findEvidenceByFrameIds(
    frameIds: readonly string[],
  ): Promise<readonly DecisionLedgerEvidenceRecord[]> {
    if (frameIds.length === 0) {
      return [];
    }

    return this.database
      .selectFrom("decision_ledger_evidence")
      .selectAll()
      .where("frame_id", "in", frameIds)
      .orderBy("occurred_at", "asc")
      .execute();
  }
}

/**
 * 요청 frame이 아닌 곳에 이미 연결된 evidence frame id를 dedupe해서 반환한다.
 *
 * 같은 fingerprint가 다른 frame에 속하면 현재 append 결과를 신뢰할 수 없으므로, transaction 경계에서 이 목록을
 * conflict error로 승격해 batch 전체를 rollback한다.
 */
function collectConflictingFrameIds(
  records: readonly DecisionLedgerEvidenceRecord[],
  expectedFrameId: string,
): readonly string[] {
  return [
    ...new Set(records.filter((record) => record.frame_id !== expectedFrameId).map((record) => record.frame_id)),
  ];
}
