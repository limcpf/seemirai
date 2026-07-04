import { createHash } from "node:crypto";
import type {
  LiveDecisionHistoryDedupePolicy,
  LiveDecisionHistoryTick,
  LiveDecisionHistoryTickInput,
} from "./types.js";

export const LIVE_DECISION_HISTORY_HOLD_BUCKET_MILLISECONDS = 60_000;

/**
 * live decision tick 입력에 dedupe policy와 stable key를 붙인다.
 *
 * HOLD는 장시간 daemon에서 초당 반복될 수 있으므로 같은 reason의 1분 bucket으로 접고, BUY/SELL/BLOCK은 주문·차단 분석에
 * 필요한 개별 사건성이 높아 source tick 기준 재실행만 접는다. 이 함수는 순수 계산만 수행하며 DB write side effect가 없다.
 *
 * @param input live decision tick 생성 입력
 * @returns dedupe key와 bucket이 포함된 decision tick
 */
export function createLiveDecisionHistoryTick(
  input: LiveDecisionHistoryTickInput,
): LiveDecisionHistoryTick {
  assertLiveDecisionHistoryTickInput(input);

  const dedupePolicy = resolveDedupePolicy(input);
  const dedupeBucketStartedAt = resolveDedupeBucketStartedAt(input, dedupePolicy);
  const dedupeKey = createDedupeKey(input, dedupePolicy, dedupeBucketStartedAt);

  return {
    ...input,
    correlationId: input.correlationId ?? null,
    trace: input.trace ?? {},
    dedupePolicy,
    dedupeBucketStartedAt,
    dedupeKey,
  };
}

function resolveDedupePolicy(
  input: LiveDecisionHistoryTickInput,
): LiveDecisionHistoryDedupePolicy {
  return input.decisionKind === "HOLD" ? "HOLD_REASON_1M_BUCKET" : "SOURCE_TICK";
}

function resolveDedupeBucketStartedAt(
  input: LiveDecisionHistoryTickInput,
  policy: LiveDecisionHistoryDedupePolicy,
): Date {
  if (policy === "HOLD_REASON_1M_BUCKET") {
    return new Date(
      Math.floor(input.observedAt.getTime() / LIVE_DECISION_HISTORY_HOLD_BUCKET_MILLISECONDS) *
      LIVE_DECISION_HISTORY_HOLD_BUCKET_MILLISECONDS,
    );
  }

  return new Date(input.observedAt.getTime());
}

function createDedupeKey(
  input: LiveDecisionHistoryTickInput,
  policy: LiveDecisionHistoryDedupePolicy,
  bucketStartedAt: Date,
): string {
  const keyParts = policy === "HOLD_REASON_1M_BUCKET"
    ? [
        "live-decision-history",
        "v1",
        policy,
        input.exchange,
        input.market,
        input.strategyId,
        input.reasonCode,
        bucketStartedAt.toISOString(),
      ]
    : [
        "live-decision-history",
        "v1",
        policy,
        input.exchange,
        input.market,
        input.strategyId,
        input.decisionKind,
        input.reasonCode,
        input.sourceTickId,
      ];

  const digest = createHash("sha256").update(JSON.stringify(keyParts)).digest("hex");
  return `live-decision:${digest}`;
}

function assertLiveDecisionHistoryTickInput(input: LiveDecisionHistoryTickInput): void {
  assertNonEmptyString("exchange", input.exchange);
  assertNonEmptyString("market", input.market);
  assertNonEmptyString("strategyId", input.strategyId);
  assertNonEmptyString("reasonCode", input.reasonCode);
  assertNonEmptyString("sourceTickId", input.sourceTickId);

  if (!["HOLD", "BUY", "SELL", "BLOCK"].includes(input.decisionKind)) {
    throw new Error("live decision history decisionKind가 허용 범위를 벗어났습니다.");
  }

  if (!Number.isSafeInteger(input.orderIntentCount) || input.orderIntentCount < 0) {
    throw new Error("live decision history orderIntentCount는 0 이상의 안전한 정수여야 합니다.");
  }

  assertValidDate("observedAt", input.observedAt);
  assertValidDate("decisionAt", input.decisionAt);
}

function assertNonEmptyString(path: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`live decision history ${path}는 빈 문자열일 수 없습니다.`);
  }
}

function assertValidDate(path: string, value: unknown): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`live decision history ${path}는 유효한 Date여야 합니다.`);
  }
}
