import type { LiveDecisionHistoryTick } from "../../../application/live-decision-history.js";
import type { LiveDecisionHistoryTickRowInput } from "./types.js";
import { assertValidLiveDecisionHistoryTick } from "./validation.js";

/**
 * application live decision tick을 `live_decision_ticks` insert row로 변환한다.
 *
 * invariant:
 * - feature/threshold/trace JSON은 secret-free JSONB object여야 한다.
 * - HOLD bucket dedupe key와 policy는 application contract에서 이미 계산되어 있어야 한다.
 * - raw provider payload, credential, Telegram token, DB URL은 row 변환 전에 거부한다.
 *
 * @param tick 저장할 live decision tick
 * @returns PostgreSQL insert row
 */
export function toLiveDecisionHistoryTickRowInput(
  tick: LiveDecisionHistoryTick,
): LiveDecisionHistoryTickRowInput {
  assertValidLiveDecisionHistoryTick(tick);

  return {
    exchange: tick.exchange,
    market: tick.market,
    strategy_id: tick.strategyId,
    decision_kind: tick.decisionKind,
    reason_code: tick.reasonCode,
    source_tick_id: tick.sourceTickId,
    feature_snapshot_json: tick.featureSnapshot,
    threshold_json: tick.thresholds,
    order_intent_count: tick.orderIntentCount,
    dedupe_policy: tick.dedupePolicy,
    dedupe_bucket_started_at: tick.dedupeBucketStartedAt,
    dedupe_key: tick.dedupeKey,
    observed_at: tick.observedAt,
    decision_at: tick.decisionAt,
    correlation_id: tick.correlationId ?? null,
    trace_json: tick.trace ?? {},
  };
}
