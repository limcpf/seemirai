import type { AppendLiveDecisionHistoryTickInput, AppendLiveDecisionHistoryTickResult } from "../../../application/live-decision-history.js";
import type { Database } from "../database.js";
import { toLiveDecisionHistoryTickRowInput } from "./row-mapper.js";
import type {
  ApplyLiveDecisionHistoryRetentionInput,
  ApplyLiveDecisionHistoryRetentionResult,
  LiveDecisionHistoryTickRecord,
} from "./types.js";

/**
 * live decision history time-series repository다.
 *
 * 책임:
 * - `live_decision_ticks`에 HOLD/BUY/SELL/BLOCK tick을 secret-free row로 저장한다.
 * - dedupe key unique constraint로 HOLD bucket 중복과 source tick 재실행을 멱등 처리한다.
 * - 명시 retention cutoff 이전 row만 삭제해 장기 daemon 실행의 저장소 폭주를 제한한다.
 *
 * side effect:
 * - `appendDecisionTick`과 `applyRetention`은 DB write/delete side effect를 만든다.
 * - broker 주문, Telegram 전송, 외부 API 호출은 수행하지 않는다.
 */
export class PostgresLiveDecisionHistoryRepository {
  public constructor(private readonly database: Database) {}

  /**
   * live decision tick 하나를 저장한다.
   *
   * 같은 dedupe key가 이미 있으면 기존 row를 반환하고 새 row를 만들지 않는다. 이 동작은 HOLD bucket과 runtime 재실행을
   * 모두 안전하게 접기 위한 idempotency 경계다.
   *
   * @param input 저장할 live decision tick
   * @returns 새 row insert 여부
   */
  public async appendDecisionTick(
    input: AppendLiveDecisionHistoryTickInput,
  ): Promise<AppendLiveDecisionHistoryTickResult & { readonly record: LiveDecisionHistoryTickRecord }> {
    const row = toLiveDecisionHistoryTickRowInput(input.tick);

    const inserted = await this.database
      .insertInto("live_decision_ticks")
      .values(row)
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted !== undefined) {
      return { inserted: true, record: inserted };
    }

    const existing = await this.database
      .selectFrom("live_decision_ticks")
      .selectAll()
      .where("dedupe_key", "=", input.tick.dedupeKey)
      .executeTakeFirstOrThrow();

    return { inserted: false, record: existing };
  }

  /**
   * dedupe key로 저장된 decision tick을 조회한다.
   *
   * 테스트와 운영 점검이 특정 tick 저장 여부를 확인하기 위한 read-only 경계이며 외부 side effect는 없다.
   *
   * @param dedupeKey 조회할 dedupe key
   * @returns 저장된 row 또는 undefined
   */
  public async findDecisionTickByDedupeKey(
    dedupeKey: string,
  ): Promise<LiveDecisionHistoryTickRecord | undefined> {
    return this.database
      .selectFrom("live_decision_ticks")
      .selectAll()
      .where("dedupe_key", "=", dedupeKey)
      .executeTakeFirst();
  }

  /**
   * retention cutoff 이전 decision tick을 삭제한다.
   *
   * live decision history는 calibration용 time-series evidence이므로 무한 보존하지 않는다. cutoff는 caller가 명시해야 하며,
   * 이 repository는 최신 row를 덮어쓰거나 임의 기간을 추정하지 않는다.
   *
   * @param input 삭제 cutoff
   * @returns 삭제된 row 수
   */
  public async applyRetention(
    input: ApplyLiveDecisionHistoryRetentionInput,
  ): Promise<ApplyLiveDecisionHistoryRetentionResult> {
    const deletedRows = await this.database
      .deleteFrom("live_decision_ticks")
      .where("observed_at", "<", input.olderThan)
      .returning("id")
      .execute();

    return { deleted: deletedRows.length };
  }
}
