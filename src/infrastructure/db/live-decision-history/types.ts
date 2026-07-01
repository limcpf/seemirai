import type { Insertable, Selectable } from "kysely";
import type { LiveDecisionTicksTable } from "../schema.js";

/**
 * `live_decision_ticks`에서 읽은 durable decision tick row다.
 *
 * repository append 또는 조회 결과로만 노출되며, raw provider payload나 credential은 포함하지 않는 것이 DB invariant다.
 */
export type LiveDecisionHistoryTickRecord = Selectable<LiveDecisionTicksTable>;

/**
 * `live_decision_ticks` insert 입력 타입이다.
 *
 * `id`, JSON 기본값, `created_at`은 DB가 채울 수 있지만 row mapper는 분석에 필요한 JSON 필드를 명시적으로 넣는다.
 */
export type LiveDecisionHistoryTickRowInput = Insertable<LiveDecisionTicksTable>;

/**
 * live decision history retention 실행 입력이다.
 *
 * time-series table은 무한 append-only가 아니라 운영자가 정한 cutoff 이전 row를 명시적으로 삭제할 수 있다. 이 입력은
 * 삭제 기준만 담고, 어떤 주문/broker side effect도 만들지 않는다.
 */
export interface ApplyLiveDecisionHistoryRetentionInput {
  readonly olderThan: Date;
}

/**
 * live decision history retention 실행 결과다.
 *
 * 삭제된 row 수만 반환해 운영자가 retention이 실제로 동작했는지 확인할 수 있게 한다.
 */
export interface ApplyLiveDecisionHistoryRetentionResult {
  readonly deleted: number;
}
