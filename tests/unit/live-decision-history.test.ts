import { describe, expect, it } from "vitest";
import {
  createLiveDecisionHistoryTick,
} from "../../src/application/live-decision-history.js";
import {
  LiveDecisionHistoryPersistenceValidationError,
  toLiveDecisionHistoryTickRowInput,
} from "../../src/infrastructure/db/index.js";

describe("live decision history contract", () => {
  it("HOLD tick은 같은 reason의 1분 bucket 안에서 같은 dedupe key를 사용한다", () => {
    const first = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "HOLD",
      reasonCode: "autonomous_24x7_entry_signal_weak",
      featureSnapshot: { featureStatus: "ok", trend_strength_bps: "0" },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-1",
      trace: { source: "unit-test" },
    });
    const second = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "HOLD",
      reasonCode: "autonomous_24x7_entry_signal_weak",
      featureSnapshot: { featureStatus: "ok", trend_strength_bps: "1" },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:55.000Z"),
      decisionAt: new Date("2026-06-30T00:00:55.100Z"),
      sourceTickId: "tick-2",
      trace: { source: "unit-test" },
    });

    expect(first.dedupePolicy).toBe("HOLD_REASON_1M_BUCKET");
    expect(second.dedupePolicy).toBe("HOLD_REASON_1M_BUCKET");
    expect(first.dedupeBucketStartedAt.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(second.dedupeBucketStartedAt.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(second.dedupeKey).toBe(first.dedupeKey);
  });

  it("BUY/SELL/BLOCK tick은 source tick 기준으로 재실행만 dedupe한다", () => {
    const buy = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "BUY",
      reasonCode: "autonomous_24x7_entry_signal_ready",
      featureSnapshot: { featureStatus: "ok" },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 1,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-buy-1",
      trace: { source: "unit-test" },
    });
    const sell = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "SELL",
      reasonCode: "autonomous_24x7_take_profit",
      featureSnapshot: { featureStatus: "ok" },
      thresholds: { take_profit_bps: "30" },
      orderIntentCount: 1,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-sell-1",
      trace: { source: "unit-test" },
    });

    expect(buy.dedupePolicy).toBe("SOURCE_TICK");
    expect(sell.dedupePolicy).toBe("SOURCE_TICK");
    expect(buy.dedupeKey).not.toBe(sell.dedupeKey);
  });

  it("row mapper는 feature snapshot과 threshold를 secret-free JSONB로 저장한다", () => {
    const tick = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "BLOCK",
      reasonCode: "feature_stale",
      featureSnapshot: { featureStatus: "stale", sample_count: 3 },
      thresholds: { min_sample_count: 10 },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-block-1",
      trace: { source: "unit-test" },
    });

    const row = toLiveDecisionHistoryTickRowInput(tick);

    expect(row).toMatchObject({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategy_id: "live_ops_autonomous_24x7_core",
      decision_kind: "BLOCK",
      reason_code: "feature_stale",
      order_intent_count: 0,
      dedupe_policy: "SOURCE_TICK",
      dedupe_key: tick.dedupeKey,
    });
    expect(row.feature_snapshot_json).toEqual({ featureStatus: "stale", sample_count: 3 });
    expect(row.threshold_json).toEqual({ min_sample_count: 10 });
    expect(JSON.stringify(row)).not.toContain("Authorization");
  });

  it("secret/raw provider 후보 key와 문자열은 DB row 변환 전에 거부한다", () => {
    const tick = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "HOLD",
      reasonCode: "autonomous_24x7_entry_signal_weak",
      featureSnapshot: { rawProviderPayload: { Authorization: "Bearer raw.jwt.token" } },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-secret",
      trace: { source: "unit-test" },
    });

    expect(() => toLiveDecisionHistoryTickRowInput(tick)).toThrow(
      LiveDecisionHistoryPersistenceValidationError,
    );
  });

  it("DB URL key와 credential URL 문자열은 DB row 변환 전에 거부한다", () => {
    const tick = createLiveDecisionHistoryTick({
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "live_ops_autonomous_24x7_core",
      decisionKind: "HOLD",
      reasonCode: "autonomous_24x7_entry_signal_weak",
      featureSnapshot: {
        featureStatus: "ok",
        database_url: "postgres://user:secret@db/prod",
      },
      thresholds: { min_entry_margin_bps: "10" },
      orderIntentCount: 0,
      observedAt: new Date("2026-06-30T00:00:05.000Z"),
      decisionAt: new Date("2026-06-30T00:00:05.100Z"),
      sourceTickId: "tick-db-url",
      trace: { source: "unit-test" },
    });

    expect(() => toLiveDecisionHistoryTickRowInput(tick)).toThrow(
      LiveDecisionHistoryPersistenceValidationError,
    );
  });
});
